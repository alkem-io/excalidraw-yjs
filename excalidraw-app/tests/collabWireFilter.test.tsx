import { Scene } from "@excalidraw-yjs/element";
import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";

import type {
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";
import type { BinaryFiles } from "@excalidraw-yjs/excalidraw/types";

import { DELETED_ELEMENT_TIMEOUT } from "../app_constants";
import {
  encodeSyncableSceneAsUpdate,
  filterReferencedFiles,
  getReferencedFileIds,
} from "../data";

/**
 * Boundary filter for the native-Yjs collaboration WIRE SEED (findings #1 + #3).
 *
 * The scene `Y.Doc` carries deleted-element tombstones (with full content) and
 * every file binary ever added (append-only `setFiles`). A RAW
 * `Y.encodeStateAsUpdate(doc)` wire seed (INIT / periodic resync) therefore
 * re-broadcasts (#1) a pasted-then-deleted image's BYTES and (#3) over-timeout
 * tombstone CONTENT on every join/resync. `encodeSyncableSceneAsUpdate` rebuilds
 * the seed from ONLY syncable elements (live + within-timeout tombstones) and the
 * files those LIVE elements reference — so deleted-image bytes and aged tombstones
 * are excluded, while recently-deleted elements still propagate (convergence).
 *
 * These tests decode the produced update and assert exactly that. They FAIL if the
 * seed reverts to a raw doc encode.
 */

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

const fileRecord = (id: string, dataURL: string) => ({
  mimeType: "image/png",
  id,
  dataURL,
  created: 1_700_000_000_000,
  lastRetrieved: 1_700_000_000_500,
  version: 1,
});

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
    files: scene.getFiles(),
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

  it("filterReferencedFiles drops a pasted-then-deleted image's binary", () => {
    const live = imageEl("live", "f-live");
    const deleted = imageEl("deleted", "f-deleted", { isDeleted: true });
    const files: BinaryFiles = {
      "f-live": fileRecord("f-live", "data:,LIVE") as never,
      "f-deleted": fileRecord("f-deleted", "data:,SECRET") as never,
    };

    const filtered = filterReferencedFiles(files, [live, deleted]);

    expect(Object.keys(filtered)).toEqual(["f-live"]);
    expect(filtered["f-deleted"]).toBeUndefined();
  });

  it("FINDING #1: the wire seed excludes a deleted image's file bytes", () => {
    const live = imageEl("live", "f-live");
    // freshly deleted (within timeout) so the tombstone itself still syncs…
    const deleted = imageEl("deleted", "f-deleted", {
      isDeleted: true,
      updated: Date.now(),
    });
    const files: BinaryFiles = {
      "f-live": fileRecord("f-live", "data:,LIVE") as never,
      "f-deleted": fileRecord("f-deleted", "data:,SECRET-BYTES") as never,
    };

    const update = encodeSyncableSceneAsUpdate(
      [live, deleted],
      files,
      APP_STATE,
    );
    const decoded = applyToFreshScene(update);

    // …but the deleted image's BINARY is gone from the wire.
    expect(Object.keys(decoded.files).sort()).toEqual(["f-live"]);
    expect(decoded.files["f-deleted"]).toBeUndefined();
    // the surviving file's bytes are intact.
    expect(decoded.files["f-live"].dataURL).toBe("data:,LIVE");
  });

  it("FINDING #3: an over-timeout tombstone is GC'd from the wire, a fresh one survives (convergence)", () => {
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

    const update = encodeSyncableSceneAsUpdate(
      [live, freshlyDeleted, staleDeleted],
      {},
      APP_STATE,
    );
    const ids = applyToFreshScene(update).elementIds;

    // live + the FRESH tombstone ride the wire (peers must learn recent deletes);
    // the STALE tombstone is dropped — no unbounded tombstone re-broadcast.
    expect(ids).toEqual(["fresh-del", "live"]);
    expect(ids).not.toContain("stale-del");
  });

  it("the wire seed still carries the persistable appState subset", () => {
    const live = API.createElement({
      type: "rectangle",
      id: "live",
    }) as OrderedExcalidrawElement;
    const update = encodeSyncableSceneAsUpdate(
      [live],
      {},
      {
        viewBackgroundColor: "#abcdef",
        name: "my board",
      },
    );
    const decoded = applyToFreshScene(update);
    expect(decoded.appState).toEqual({
      viewBackgroundColor: "#abcdef",
      name: "my board",
    });
  });
});
