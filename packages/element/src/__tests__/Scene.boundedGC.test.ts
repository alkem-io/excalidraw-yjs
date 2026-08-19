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

/** An opaque host locator. Bytes never enter the document. */
const locator = (id: string) => `asset://${id}`;

const docKeys = (scene: Scene) => [...scene.yElements.keys()].sort();

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

  it("FAILS LOUD when a deleted record carries no usable `updated`", () => {
    const scene = new Scene();
    seed(scene, [mk("a"), mk("keep")]);

    // `updated` is required on ExcalidrawElement and is what dates the deletion.
    // Defaulting it would date the deletion to the epoch — instantly expired —
    // so the next sweep would reclaim content that should have had its full
    // grace window, turning malformed input into silent data loss.
    expect(() =>
      scene.replaceAllElements(
        scene.getElementsIncludingDeleted().map((e) =>
          e.id === "a"
            ? ({
                ...e,
                isDeleted: true,
                updated: undefined,
              } as unknown as ExcalidrawElement)
            : e,
        ),
      ),
    ).toThrow(/'updated' is undefined/);

    scene.destroy();
  });

  it("non-vacuity: the SAME write with a valid `updated` is accepted", () => {
    // Guards the case above against passing for an unrelated reason.
    const scene = new Scene();
    seed(scene, [mk("a"), mk("keep")]);
    expect(() => softDelete(scene, "a", AGED)).not.toThrow();
    expect(scene.yElementDeletions.get("a")).toBe(AGED);
    scene.destroy();
  });

  it("reclaims an expired deleted element and its now-orphaned binary", () => {
    const scene = new Scene();
    scene.setAssetLocators({ f1: locator("f1"), f2: locator("f2") });
    seed(scene, [mkImg("live", "f1"), mkImg("gone", "f2")]);
    softDelete(scene, "gone", AGED);

    const removed = scene.collectGarbage({ deletedBefore: CUTOFF });

    expect(docKeys(scene)).toEqual(["live"]);
    expect(Object.keys(scene.getAssetLocators()).sort()).toEqual(["f1"]);
    expect(removed).toEqual({ elements: 1, files: 1 });
    // the sidecar entry is reclaimed with it — no perpetually growing marker map
    expect(scene.yElementDeletions.has("gone")).toBe(false);
    scene.destroy();
  });

  it("does NOT reclaim a deletion still inside the window", () => {
    const scene = new Scene();
    scene.setAssetLocators({ f1: locator("f1") });
    seed(scene, [mkImg("recent", "f1"), mk("other")]);
    softDelete(scene, "recent", RECENT);

    expect(scene.collectGarbage({ deletedBefore: CUTOFF })).toEqual({
      elements: 0,
      files: 0,
    });
    expect(docKeys(scene)).toEqual(["other", "recent"]);
    // ...and its binary stays, so an undo restores a COMPLETE image.
    expect(Object.keys(scene.getAssetLocators())).toEqual(["f1"]);
    scene.destroy();
  });

  it("keeps a file that a RETAINED element or tombstone still references", () => {
    const scene = new Scene();
    scene.setAssetLocators({
      shared: locator("shared"),
      solo: locator("solo"),
    });
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
    expect(Object.keys(scene.getAssetLocators()).sort()).toEqual([
      "shared",
      "solo",
    ]);
    expect(removed.files).toBe(0);
    scene.destroy();
  });

  it("PRIVACY: a joiner receives no bytes at all, and no stale reference", () => {
    // Stronger than it used to be. The document cannot carry bytes, so the
    // question is no longer "were the bytes reclaimed" but "is a byte-shaped
    // value ever present" — plus, does an expired element's reference go with it.
    const host = new Scene();
    seed(host, [mk("live"), mkImg("pasted-then-deleted", "secret")]);
    host.setAssetLocators({ secret: locator("secret") });
    softDelete(host, "pasted-then-deleted", AGED);

    // GUARD: the reference really is in the document before the sweep.
    expect(host.getAssetLocators().secret).toBe(locator("secret"));

    host.collectGarbage({ deletedBefore: CUTOFF });

    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, host.encodeStateAsUpdate());

    expect([...joiner.getMap<Y.Map<unknown>>(ELEMENTS).keys()]).toEqual([
      "live",
    ]);
    // the reference is reclaimed with its element...
    expect([...joiner.getMap<unknown>(FILES).keys()]).toEqual([]);
    expect([...joiner.getMap<number>(ELEMENT_DELETIONS).keys()]).toEqual([]);

    // ...and nothing byte-shaped was ever encodable in the first place: every
    // value under the assets root is an opaque locator string.
    for (const value of host.yAssets.values()) {
      expect(typeof value).toBe("string");
      expect(String(value)).not.toContain("data:");
    }
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

  it("create -> undo leaves a tombstone that CAN still age out", () => {
    // A creation is born as an `isDeleted:true` tombstone under STRUCTURAL, then
    // revealed under LOCAL. Undoing the creation reverts the reveal, so the
    // element goes back to being a tombstone — and that tombstone needs a
    // deletion marker, or it is immortal: invisible to the user forever, and
    // never reclaimable by GC.
    const scene = new Scene();
    seed(scene, [mk("keep")]);

    scene.replaceAllElements([
      ...scene.getElementsIncludingDeleted(),
      { ...mk("born"), updated: AGED } as ExcalidrawElement,
    ]);
    expect(scene.yElements.get("born")?.get("isDeleted")).toBe(false); // guard: live

    expect(scene.undoElements()).toBe(true);
    expect(scene.yElements.get("born")?.get("isDeleted")).toBe(true); // back to tombstone

    // It must be reclaimable. Without a marker it never expires.
    expect(scene.collectGarbage({ deletedBefore: CUTOFF })).toEqual({
      elements: 1,
      files: 0,
    });
    expect(docKeys(scene)).toEqual(["keep"]);
    scene.destroy();
  });

  it("a NEW element that is already deleted is markered, not immortal", () => {
    // Importing a scene containing tombstones, and the post-prelude failure path,
    // both end with a born tombstone that is never revealed live. It must carry a
    // marker from the structural prelude or it can never be reclaimed.
    const scene = new Scene();
    seed(scene, [mk("keep")]);

    scene.replaceAllElements([
      ...scene.getElementsIncludingDeleted(),
      {
        ...mk("imported-tombstone"),
        isDeleted: true,
        updated: AGED,
      } as ExcalidrawElement,
    ]);

    expect(scene.yElements.get("imported-tombstone")?.get("isDeleted")).toBe(
      true,
    );
    // The exact value is NOT asserted: a brand-new element has no valid
    // fractional index, so `syncInvalidIndices` re-stamps its `updated` via
    // `mutateElement` (a constant under test). What matters is that a marker
    // exists at all — without one this tombstone could never be reclaimed.
    expect(typeof scene.yElementDeletions.get("imported-tombstone")).toBe(
      "number",
    );

    expect(scene.collectGarbage({ deletedBefore: CUTOFF })).toEqual({
      elements: 1,
      files: 0,
    });
    expect(docKeys(scene)).toEqual(["keep"]);
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

  it("storage growth under churn stays bounded and byte-free", () => {
    // Payload-independence used to be the interesting property, because bytes
    // were in the document and had to be shown not to accumulate. They cannot be
    // now, so what is left to check is that churn does not accumulate references
    // and that nothing byte-shaped appears.
    const scene = new Scene();
    const sizes: number[] = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      const fid = `f${cycle}`;
      scene.setAssetLocators({ [fid]: locator(fid) });
      seed(scene, [mk("live"), mkImg(`img${cycle}`, fid)]);
      softDelete(scene, `img${cycle}`, AGED);
      scene.collectGarbage({ deletedBefore: CUTOFF });
      sizes.push(scene.encodeStateAsUpdate().byteLength);
    }

    expect(sizes[0]).toBeGreaterThan(0); // non-vacuity: churn really ran
    // References are reclaimed each cycle, so nothing accumulates.
    expect(Object.keys(scene.getAssetLocators())).toEqual([]);
    expect(sizes[4] - sizes[0]).toBeLessThan(4096);
    scene.destroy();
  });
});
