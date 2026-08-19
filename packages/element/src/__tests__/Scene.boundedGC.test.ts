import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { ELEMENT_DELETIONS, ELEMENTS, FILES } from "../yjs/schema";

import type { ExcalidrawElement } from "../types";

const HOUR = 60 * 60 * 1000;
const TIMEOUT = 24 * HOUR;
const NOW = 1_000_000 * HOUR;
const CUTOFF = NOW - TIMEOUT; // `deletedBefore`

const AGED = NOW - TIMEOUT - HOUR; // deleted long enough ago to reclaim
const RECENT = NOW - HOUR; // still inside the grace window

/**
 * Element fixtures.
 *
 * NOTE on timestamps: `getUpdatedTimestamp()` returns a constant `1` under test,
 * and `syncInvalidIndices` re-stamps `updated` (via `mutateElement`) for any
 * element whose fractional index is invalid — which is every freshly-built one.
 * So an `updated` passed straight to `replaceAllElements` is discarded. Elements
 * read BACK from the scene already carry valid indices, so {@link softDelete}
 * seeds live elements first and then deletes them, which both preserves the
 * timestamp and exercises the real edit path rather than a shortcut.
 */
const mk = (
  id: string,
  extra: Record<string, unknown> = {},
): ExcalidrawElement =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as Parameters<typeof newElement>[0]) as ExcalidrawElement),
    id,
    ...extra,
  } as ExcalidrawElement);

const mkImg = (id: string, fileId: string) => mk(id, { type: "image", fileId });

/** Seed live elements and return them as the scene derived them (indexed). */
const seed = (scene: Scene, elements: ExcalidrawElement[]) => {
  scene.replaceAllElements(elements);
  scene.stopElementCapture();
};

/** Soft-delete `id` as of `at`, through the ordinary write path. */
const softDelete = (scene: Scene, id: string, at: number) => {
  scene.replaceAllElements(
    scene
      .getElementsIncludingDeleted()
      .map((e) =>
        e.id === id
          ? ({ ...e, isDeleted: true, updated: at } as ExcalidrawElement)
          : e,
      ),
  );
};

/** Bring `id` back to life through the ordinary write path. */
const revive = (scene: Scene, id: string, at: number) => {
  scene.replaceAllElements(
    scene
      .getElementsIncludingDeleted()
      .map((e) =>
        e.id === id
          ? ({ ...e, isDeleted: false, updated: at } as ExcalidrawElement)
          : e,
      ),
  );
};

const BINARY = "A".repeat(512);
const file = (id: string) => ({
  id,
  mimeType: "image/png" as const,
  dataURL: `data:image/png;base64,${BINARY}`,
  created: NOW,
});

const docKeys = (scene: Scene) => [...scene.yElements.keys()].sort();
const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/**
 * INV-BOUNDED (FR-006) — reclamation bounds storage under churn and keeps an
 * aged deleted element's binary off the wire to a new joiner.
 *
 * Age lives in the `elementDeletions` sidecar, written atomically with the
 * `isDeleted` flip, so it survives the encode and a replica that joined after
 * the deletion can still judge it. The caller supplies only `deletedBefore`.
 */
describe("INV-BOUNDED — bounded GC + privacy", () => {
  it("records a deletion marker on the transition, and clears it on revival", () => {
    const scene = new Scene();
    seed(scene, [mk("a")]);
    expect(scene.yElementDeletions.has("a")).toBe(false);

    softDelete(scene, "a", RECENT);
    expect(scene.yElementDeletions.get("a")).toBe(RECENT);

    // Revived -> the marker must go, or GC would later reclaim a live element.
    revive(scene, "a", NOW);
    expect(scene.yElementDeletions.has("a")).toBe(false);
    scene.destroy();
  });

  it("does not push expiry forward when an already-deleted element is written again", () => {
    const scene = new Scene();
    seed(scene, [mk("a"), mk("keep")]);
    softDelete(scene, "a", AGED);
    expect(scene.yElementDeletions.get("a")).toBe(AGED);

    // A later write touching the same tombstone must NOT re-stamp it; otherwise
    // a periodically-rewritten tombstone would never age out.
    scene.replaceAllElements(
      scene
        .getElementsIncludingDeleted()
        .map((e) =>
          e.id === "a" ? ({ ...e, x: 99, updated: NOW } as typeof e) : e,
        ),
    );
    expect(scene.yElementDeletions.get("a")).toBe(AGED);
    scene.destroy();
  });

  it("reclaims an expired deleted element and its now-orphaned binary", () => {
    const scene = new Scene();
    scene.setFiles({ f1: file("f1"), f2: file("f2") });
    seed(scene, [mkImg("live", "f1"), mkImg("gone", "f2")]);
    softDelete(scene, "gone", AGED);

    const removed = scene.collectGarbage({ deletedBefore: CUTOFF });

    expect(docKeys(scene)).toEqual(["live"]);
    expect(Object.keys(scene.getFiles()).sort()).toEqual(["f1"]);
    expect(removed).toEqual({ elements: 1, files: 1 });
    // the sidecar entry is reclaimed with it — no perpetually growing marker map
    expect(scene.yElementDeletions.has("gone")).toBe(false);
    scene.destroy();
  });

  it("does NOT reclaim a deletion still inside the window", () => {
    const scene = new Scene();
    scene.setFiles({ f1: file("f1") });
    seed(scene, [mkImg("recent", "f1"), mk("other")]);
    softDelete(scene, "recent", RECENT);

    expect(scene.collectGarbage({ deletedBefore: CUTOFF })).toEqual({
      elements: 0,
      files: 0,
    });
    expect(docKeys(scene)).toEqual(["other", "recent"]);
    // ...and its binary stays, so an undo restores a COMPLETE image.
    expect(Object.keys(scene.getFiles())).toEqual(["f1"]);
    scene.destroy();
  });

  it("keeps a file that a RETAINED element or tombstone still references", () => {
    const scene = new Scene();
    scene.setFiles({ shared: file("shared"), solo: file("solo") });
    seed(scene, [
      mkImg("liveImg", "shared"),
      mkImg("agedShared", "shared"),
      mkImg("recentSolo", "solo"),
    ]);
    softDelete(scene, "agedShared", AGED);
    softDelete(scene, "recentSolo", RECENT);

    const removed = scene.collectGarbage({ deletedBefore: CUTOFF });

    expect(docKeys(scene)).toEqual(["liveImg", "recentSolo"]);
    // `shared` held by a live element, `solo` by a RETAINED tombstone.
    expect(Object.keys(scene.getFiles()).sort()).toEqual(["shared", "solo"]);
    expect(removed.files).toBe(0);
    scene.destroy();
  });

  it("PRIVACY: an expired deleted image reaches a new joiner in no form", () => {
    const host = new Scene();
    host.setFiles({ secret: file("secret") });
    seed(host, [mk("live"), mkImg("pasted-then-deleted", "secret")]);
    softDelete(host, "pasted-then-deleted", AGED);

    // Non-vacuity: the binary IS on the wire before the sweep.
    expect(decode(host.encodeStateAsUpdate())).toContain(BINARY);

    host.collectGarbage({ deletedBefore: CUTOFF });

    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, host.encodeStateAsUpdate());

    // Absent from the decoded structures, not merely hidden behind a getter...
    expect([...joiner.getMap<Y.Map<unknown>>(ELEMENTS).keys()]).toEqual([
      "live",
    ]);
    expect([...joiner.getMap<unknown>(FILES).keys()]).toEqual([]);
    // ...including the deletion marker itself.
    expect([...joiner.getMap<number>(ELEMENT_DELETIONS).keys()]).toEqual([]);
    expect(decode(host.encodeStateAsUpdate())).not.toContain(BINARY);
    host.destroy();
  });

  it("UNDO: a reverted deletion is not reclaimed once the cutoff passes", () => {
    const scene = new Scene();
    seed(scene, [mk("a"), mk("keep")]);
    softDelete(scene, "a", AGED);
    expect(scene.yElementDeletions.get("a")).toBe(AGED); // guard: marker written

    expect(scene.canUndoElements()).toBe(true);
    expect(scene.undoElements()).toBe(true);

    // The marker must have been reverted in the SAME undo step. If it survived,
    // this sweep would reclaim an element the user just restored.
    expect(scene.yElementDeletions.has("a")).toBe(false);
    expect(scene.collectGarbage({ deletedBefore: CUTOFF })).toEqual({
      elements: 0,
      files: 0,
    });
    expect(docKeys(scene)).toEqual(["a", "keep"]);
    scene.destroy();
  });

  it("REDO: re-applying the deletion restores a marker and stays convergent", () => {
    const a = new Scene();
    seed(a, [mk("x"), mk("keep")]);
    softDelete(a, "x", AGED);
    a.undoElements();
    expect(a.yElementDeletions.has("x")).toBe(false); // guard

    expect(a.redoElements()).toBe(true);
    expect(a.yElementDeletions.get("x")).toBe(AGED);

    // A peer replaying the same updates converges on the same marker state.
    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(b.yElementDeletions.get("x")).toBe(AGED);
    expect(docKeys(b)).toEqual(docKeys(a));
    a.destroy();
    b.destroy();
  });

  it("a STALE marker on a live element never reclaims it", () => {
    // The marker and `isDeleted` are separate map entries with no causal link, so
    // a concurrent merge can land a deletion marker from one replica alongside a
    // surviving `isDeleted:false` from another. Yjs resolves the two keys
    // independently — which replica wins is a per-key LWW race — so the state is
    // reachable but not deterministically constructible. It is written directly
    // here to pin the defence: GC re-reads the element's CURRENT state and must
    // refuse to reclaim a live one, marker notwithstanding.
    const scene = new Scene();
    seed(scene, [mk("x"), mk("keep")]);
    expect(scene.yElements.get("x")?.get("isDeleted")).toBe(false); // guard

    scene.doc.transact(() => {
      scene.yElementDeletions.set("x", AGED);
    });
    expect(scene.yElementDeletions.get("x")).toBe(AGED); // guard: marker is stale

    expect(scene.collectGarbage({ deletedBefore: CUTOFF })).toEqual({
      elements: 0,
      files: 0,
    });
    expect(docKeys(scene)).toEqual(["keep", "x"]);
    scene.destroy();
  });

  it("the sweep is NOT undoable — Ctrl+Z cannot resurrect reclaimed content", () => {
    const scene = new Scene();
    seed(scene, [mk("live"), mk("gone")]);
    softDelete(scene, "gone", AGED);

    scene.collectGarbage({ deletedBefore: CUTOFF });
    expect(docKeys(scene)).toEqual(["live"]);

    // Maintenance, not user intent. Under LOCAL_ORIGIN the UndoManager would
    // track the sweep and this loop would bring the reclaimed element back.
    while (scene.canUndoElements()) {
      scene.undoElements();
    }
    expect(docKeys(scene)).not.toContain("gone");
    expect(scene.yElements.get("gone")).toBeUndefined();
    expect(scene.yElementDeletions.has("gone")).toBe(false);
    scene.destroy();
  });

  it("one sweep is ONE logical update; a no-op sweep emits ZERO", () => {
    const scene = new Scene();
    seed(scene, [mk("live"), mk("a"), mk("b")]);
    softDelete(scene, "a", AGED);
    softDelete(scene, "b", AGED);

    const updates: Uint8Array[] = [];
    const detach = scene.onDocUpdate((u) => updates.push(u));

    const first = scene.collectGarbage({ deletedBefore: CUTOFF });
    expect(first.elements).toBe(2); // non-vacuity: it really swept
    expect(updates).toHaveLength(1); // ...as ONE message, not one per element

    const second = scene.collectGarbage({ deletedBefore: CUTOFF });
    expect(second).toEqual({ elements: 0, files: 0 });
    expect(updates).toHaveLength(1); // no transaction at all

    detach();
    scene.destroy();
  });

  it("CONCURRENCY: two replicas sweeping the same ids converge, no echo loop", () => {
    const a = new Scene();
    seed(a, [mk("live"), mk("aged")]);
    softDelete(a, "aged", AGED);
    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(b.yElementDeletions.get("aged")).toBe(AGED); // marker crossed the wire

    const updates: Uint8Array[] = [];
    const detach = a.onDocUpdate((u) => updates.push(u));
    a.collectGarbage({ deletedBefore: CUTOFF });
    detach();

    // The sweep MUST reach peers, or B keeps the tombstone and re-seeds it to
    // the next joiner — the privacy hole reopens one hop away.
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      b.applyRemoteUpdate(u);
    }

    // B now sweeps the same ids independently: deletes commute, nothing is left.
    const bEcho: Uint8Array[] = [];
    const detachB = b.onDocUpdate((u) => bEcho.push(u));
    const bRemoved = b.collectGarbage({ deletedBefore: CUTOFF });
    detachB();

    expect(bRemoved).toEqual({ elements: 0, files: 0 });
    expect(bEcho).toHaveLength(0);
    expect(docKeys(b)).toEqual(docKeys(a));
    a.destroy();
    b.destroy();
  });

  it("storage growth under churn is INDEPENDENT of payload size", () => {
    // The real bounded-storage property. A byte threshold would pass or fail for
    // reasons unrelated to reclamation: measured, 5 cycles leave ~2KB of residue
    // REGARDLESS of payload size, which is Yjs delete-set/struct-id overhead and
    // is expected to be monotone. What must not scale is retained user payload.
    const churn = (payloadLen: number) => {
      const binary = "A".repeat(payloadLen);
      const scene = new Scene();
      const sizes: number[] = [];
      for (let cycle = 0; cycle < 5; cycle++) {
        const fid = `f${cycle}`;
        scene.setFiles({
          [fid]: {
            id: fid,
            mimeType: "image/png",
            dataURL: `data:image/png;base64,${binary}`,
            created: NOW,
          },
        } as Parameters<Scene["setFiles"]>[0]);
        seed(scene, [mk("live"), mkImg(`img${cycle}`, fid)]);
        softDelete(scene, `img${cycle}`, AGED);
        scene.collectGarbage({ deletedBefore: CUTOFF });
        sizes.push(scene.encodeStateAsUpdate().byteLength);
      }
      const encoded = decode(scene.encodeStateAsUpdate());
      scene.destroy();
      return {
        growth: sizes[4] - sizes[0],
        retainsPayload: encoded.includes(binary),
      };
    };

    const small = churn(512);
    const large = churn(4096);

    expect(small.retainsPayload).toBe(false);
    expect(large.retainsPayload).toBe(false);
    expect(small.growth).toBeGreaterThan(0); // non-vacuity: churn really ran
    expect(Math.abs(large.growth - small.growth)).toBeLessThan(256);
    expect(large.growth).toBeLessThan(4096);
  });
});
