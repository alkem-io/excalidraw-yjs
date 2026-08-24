import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { decodeSnapshot, encodeSnapshot } from "../yjs/schema";

import type { ExcalidrawElement } from "../types";

/**
 * INV-DELETION-MARKER, through `Scene.mutateElement`.
 *
 * Every write path that can set `isDeleted` must also maintain the
 * `elementDeletions` sidecar in the SAME transaction — `commitPlan` and
 * `replaceAllElements` both call `syncDeletionMarker`, and `Scene.mutateElement`
 * did not. A tombstone written without its marker is not merely untidy:
 *
 *   - `decodeSnapshot` throws `deleted element "X" has no deletion timestamp`,
 *     which is on the COLD-LOAD path and on the post-save re-decode — so one such
 *     element makes the board unloadable and every save throw; and
 *   - `collectGarbage` iterates the sidecar, so the tombstone is immortal.
 *
 * The producer is not hypothetical. `server`'s MCP whiteboard writer tombstones
 * exactly this way (`whiteboard-scene.writer.ts`, the `remove` op):
 *
 *     scene.mutateElement(target, { isDeleted: true });
 *     scene.mutateElement(child,  { isDeleted: true });   // its bound text
 *
 * with no `replaceAllElements` / `applyElementChanges` anywhere in that file.
 */

const mk = (id: string): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

/** Seed live, then re-read: elements read back carry the valid index the scene
 * assigned, so a later `mutateElement` is a real edit rather than a re-index. */
const seed = (scene: Scene, ids: string[]): ExcalidrawElement[] => {
  scene.replaceAllElements(ids.map(mk));
  return ids.map((id) => scene.getElement(id) as ExcalidrawElement);
};

describe("INV-DELETION-MARKER — Scene.mutateElement maintains the sidecar", () => {
  it("a soft delete through mutateElement is markered like every other path", () => {
    const scene = new Scene();
    const [a] = seed(scene, ["a"]);

    expect(scene.yElementDeletions.has("a")).toBe(false);

    scene.mutateElement(a, { isDeleted: true });

    const after = scene.getElement("a") as ExcalidrawElement;
    expect(after.isDeleted).toBe(true);
    expect(scene.yElementDeletions.has("a")).toBe(true);
    // The marker is the element's own `updated` — no second clock.
    expect(scene.yElementDeletions.get("a")).toBe(after.updated);

    scene.destroy();
  });

  it("un-deleting through mutateElement clears the marker", () => {
    const scene = new Scene();
    const [a] = seed(scene, ["a"]);

    scene.mutateElement(a, { isDeleted: true });
    expect(scene.yElementDeletions.has("a")).toBe(true);

    scene.mutateElement(scene.getElement("a") as ExcalidrawElement, {
      isDeleted: false,
    });
    expect(scene.yElementDeletions.has("a")).toBe(false);

    scene.destroy();
  });

  it("does NOT re-stamp an already-deleted element on a later write", () => {
    const scene = new Scene();
    const [a] = seed(scene, ["a"]);

    scene.mutateElement(a, { isDeleted: true });
    const stamped = scene.yElementDeletions.get("a");

    // Any subsequent property write must leave the deletion time alone, or the
    // grace window would be pushed forward on every touch and aged tombstones
    // would never expire.
    scene.mutateElement(scene.getElement("a") as ExcalidrawElement, { x: 99 });
    expect(scene.yElementDeletions.get("a")).toBe(stamped);

    scene.destroy();
  });

  it("the resulting doc still encodes and decodes — the cold-load path", () => {
    const scene = new Scene();
    const [a] = seed(scene, ["a", "b"]);

    scene.mutateElement(a, { isDeleted: true });

    // This is what `decryptScene`/`saveToFirebase` do; without the marker it
    // throws `deleted element "a" has no deletion timestamp`.
    const bytes = encodeSnapshot({
      elements: scene.getElementsIncludingDeleted() as never,
      assets: scene.getAssetLocators(),
      appState: {},
    });
    expect(() => decodeSnapshot(bytes)).not.toThrow();

    scene.destroy();
  });

  it("the tombstone is reclaimable — GC is not starved", () => {
    const scene = new Scene();
    const [a] = seed(scene, ["a", "b"]);

    scene.mutateElement(a, { isDeleted: true });
    const deletedAt = scene.yElementDeletions.get("a") as number;

    const removed = scene.collectGarbage({ deletedBefore: deletedAt + 1 });

    expect(removed.elements).toBe(1);
    expect(scene.yElements.has("a")).toBe(false);
    expect(scene.yElementDeletions.has("a")).toBe(false);
    expect(scene.yElements.has("b")).toBe(true);

    scene.destroy();
  });

  it("a doc-level soft delete is markered even with an external Y.Doc", () => {
    // The server MCP writer's exact shape: adopt the room's doc, then tombstone.
    const doc = new Y.Doc();
    const scene = new Scene(undefined, { doc });
    const [a] = seed(scene, ["a"]);

    scene.mutateElement(a, { isDeleted: true });

    expect(scene.yElementDeletions.has("a")).toBe(true);

    scene.destroy();
  });
});
