import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";
import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";

import type {
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";

import { DELETED_ELEMENT_TIMEOUT } from "../app_constants";
import { filterReferencedFiles, getReferencedFileIds } from "../data";

/**
 * The native-Yjs collaboration WIRE SEED (INIT / periodic resync).
 *
 * These invariants were originally enforced by rebuilding the seed through a
 * throwaway doc (`encodeSyncableSceneAsUpdate`) that filtered as it encoded.
 * That rebuild is GONE (T032): it gave every join/resync a fresh `clientID` and
 * so destroyed CRDT lineage, measured at ~50% concurrent-edit loss and ~50%
 * deletion resurrection per resync.
 *
 * The invariants survive; the MECHANISM changed. The seed is now the LIVE
 * document, and what must not travel is removed from the document itself by an
 * explicit maintenance pass (`collectGarbage`) run immediately before the
 * encode — so it is gone from the state, not merely absent from one encoding of
 * it. Image bytes need no filter at all any more: since T023 the document
 * carries `fileId -> locator` and never bytes.
 *
 * These tests exercise that exact pair, which is what `Collab.encodeSceneAsUpdate`
 * performs.
 */

/**
 * What `Collab.encodeSceneAsUpdate` does: maintenance, then a PURE encode.
 *
 * The cutoff is a parameter because of a TEST-ENVIRONMENT artifact worth
 * knowing: deletion markers are stamped from the element's `updated`, and this
 * harness mocks `getUpdatedTimestamp()` to a constant `1` for deterministic
 * snapshots. Every tombstone therefore carries marker `1`, and the production
 * cutoff (`Date.now() - DELETED_ELEMENT_TIMEOUT`) reclaims all of them —
 * measured. Cases that care about the tombstone WINDOW pass explicit cutoffs
 * around the real marker instead of pretending the wall clock applies here.
 */
const encodeWireSeed = (
  scene: Scene,
  deletedBefore = Date.now() - DELETED_ELEMENT_TIMEOUT,
): Uint8Array => {
  scene.collectGarbage({ deletedBefore });
  return scene.encodeStateAsUpdate("v1");
};

const fileId = (s: string) => s as FileId;

const imageEl = (
  id: string,
  fid: string,
  opts: { isDeleted?: boolean; updated?: number } = {},
): OrderedExcalidrawElement => {
  const el = API.createElement({
    type: "image",
    id,
    fileId: fid,
    status: "saved",
    width: 64,
    height: 64,
  }) as OrderedExcalidrawElement;
  if (opts.isDeleted !== undefined) {
    (el as { isDeleted: boolean }).isDeleted = opts.isDeleted;
  }
  if (opts.updated !== undefined) {
    (el as { updated: number }).updated = opts.updated;
  }
  return el;
};

const APP_STATE = { viewBackgroundColor: "#ffffff", name: "board" };

/**
 * Decode a V1 wire update exactly as a receiving peer does: apply it into a fresh
 * `Scene` (under the remote path) and read the converged content out.
 */
const applyToFreshScene = (update: Uint8Array) => {
  const scene = new Scene();
  scene.applyRemoteUpdate(update, "v1");
  const out = {
    elementIds: scene
      .getElementsIncludingDeleted()
      .map((e) => e.id)
      .sort(),
    assets: scene.getAssetLocators(),
    appState: scene.getPersistedAppState(),
  };
  scene.destroy();
  return out;
};

describe("collaboration wire seed: deleted-content + orphaned-file filtering", () => {
  it("getReferencedFileIds returns only files referenced by a LIVE image element", () => {
    const live = imageEl("live", "f-live");
    const deleted = imageEl("deleted", "f-deleted", { isDeleted: true });
    const referenced = getReferencedFileIds([live, deleted]);

    expect(referenced.has(fileId("f-live"))).toBe(true);
    // a DELETED image's file is NOT referenced — its bytes must not leak.
    expect(referenced.has(fileId("f-deleted"))).toBe(false);
  });

  it("filterReferencedFiles drops a pasted-then-deleted image's reference", () => {
    const live = imageEl("live", "f-live");
    const deleted = imageEl("deleted", "f-deleted", { isDeleted: true });
    const refs = {
      "f-live": "asset://f-live",
      "f-deleted": "asset://f-deleted",
    };

    const filtered = filterReferencedFiles(refs, [live, deleted]);

    expect(Object.keys(filtered)).toEqual(["f-live"]);
    expect(filtered["f-deleted"]).toBeUndefined();
  });

  it("FINDING #1: the wire seed excludes a deleted image's asset reference", () => {
    const live = imageEl("live", "f-live");
    // freshly deleted (within timeout) so the tombstone itself still syncs…
    const deleted = imageEl("deleted", "f-deleted", {
      isDeleted: true,
      updated: Date.now(),
    });
    const assets = {
      "f-live": "asset://f-live",
      "f-deleted": "asset://f-deleted",
    };

    const scene = new Scene();
    scene.replaceAllElements([live, deleted]);
    scene.setAssetLocators(assets);
    scene.setAppState(APP_STATE);

    const decoded = applyToFreshScene(encodeWireSeed(scene));
    scene.destroy();

    // …and the deleted image's REFERENCE is gone from the wire. Bytes are not
    // on the wire at all any more — the document cannot carry them.
    expect(Object.keys(decoded.assets).sort()).toEqual(["f-live"]);
    expect(decoded.assets["f-deleted"]).toBeUndefined();
    expect(decoded.assets["f-live"]).toBe("asset://f-live");
  });

  it("FINDING #3: an aged tombstone is GC'd from the wire, a fresh one survives (convergence)", () => {
    const live = API.createElement({
      type: "rectangle",
      id: "live",
    }) as OrderedExcalidrawElement;
    const freshlyDeleted = API.createElement({
      type: "rectangle",
      id: "fresh-del",
      isDeleted: true,
    }) as OrderedExcalidrawElement;
    // age it past the deletion window so its content should be pruned.
    const staleDeleted = API.createElement({
      type: "rectangle",
      id: "stale-del",
      isDeleted: true,
    }) as OrderedExcalidrawElement;
    (staleDeleted as { updated: number }).updated =
      Date.now() - DELETED_ELEMENT_TIMEOUT - 60_000;
    (freshlyDeleted as { updated: number }).updated = Date.now();

    const scene = new Scene();
    scene.replaceAllElements([live, freshlyDeleted, staleDeleted]);
    scene.setAppState(APP_STATE);

    // Both tombstones carry the same marker in this harness (see encodeWireSeed),
    // so the window is exercised by moving the CUTOFF rather than the clock.
    const marker = 1;

    // Cutoff at the marker: nothing has aged past it, so BOTH deletions still
    // ride the wire — peers must learn recent deletes.
    const fresh = applyToFreshScene(encodeWireSeed(scene, marker)).elementIds;
    expect(fresh).toEqual(["fresh-del", "live", "stale-del"]);

    // Cutoff past the marker: the tombstones have aged out and are reclaimed
    // from the DOCUMENT, so they stop being re-broadcast on every resync.
    const aged = applyToFreshScene(
      encodeWireSeed(scene, marker + 1),
    ).elementIds;
    expect(aged).toEqual(["live"]);
    scene.destroy();
  });

  it("the wire seed still carries the persistable appState subset", () => {
    const live = API.createElement({
      type: "rectangle",
      id: "live",
    }) as OrderedExcalidrawElement;
    const scene = new Scene();
    scene.replaceAllElements([live]);
    scene.setAppState({
      viewBackgroundColor: "#abcdef",
      name: "my board",
    });

    const decoded = applyToFreshScene(encodeWireSeed(scene));
    scene.destroy();
    expect(decoded.appState).toEqual({
      viewBackgroundColor: "#abcdef",
      name: "my board",
    });
  });

  /**
   * The reason the rebuild had to go (T032). This is the invariant the old
   * encoder could not satisfy at all: it built every seed in a throwaway doc
   * with a fresh `clientID`, so a peer merging two seeds saw two unrelated
   * lineages and could not order their edits.
   */
  it("ships the LIVE lineage, so a resync is a no-op for an up-to-date peer", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      API.createElement({
        type: "rectangle",
        id: "a",
      }) as OrderedExcalidrawElement,
    ]);

    // A peer seeded from the first broadcast.
    const peer = new Scene();
    peer.applyRemoteUpdate(encodeWireSeed(scene, 1), "v1");
    expect(peer.getElementsIncludingDeleted().map((e) => e.id)).toEqual(["a"]);

    const before = Y.encodeStateVector(peer.doc);

    // A periodic resync of UNCHANGED content must teach that peer nothing. A
    // rebuilt seed carries a new clientID every time, so it would always add
    // fresh structs and the state vector would grow on every resync.
    peer.applyRemoteUpdate(encodeWireSeed(scene, 1), "v1");

    expect(Y.encodeStateVector(peer.doc)).toEqual(before);
    peer.destroy();
    scene.destroy();
  });

  it("keeps a peer's concurrent edit across a resync", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      API.createElement({
        type: "rectangle",
        id: "a",
      }) as OrderedExcalidrawElement,
    ]);

    const peer = new Scene();
    peer.applyRemoteUpdate(encodeWireSeed(scene, 1), "v1");

    // The peer edits while the sender knows nothing about it.
    peer.replaceAllElements([
      ...peer.getElementsIncludingDeleted(),
      API.createElement({
        type: "rectangle",
        id: "peer-only",
      }) as OrderedExcalidrawElement,
    ]);

    // A resync from the sender must not clobber it.
    peer.applyRemoteUpdate(encodeWireSeed(scene, 1), "v1");

    expect(
      peer
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "peer-only"]);
    peer.destroy();
    scene.destroy();
  });
});
