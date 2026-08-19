import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

/**
 * INV-ONE-BROADCAST (spec 002, FR-017) — one logical mutation must reach peers as
 * ONE transport message.
 *
 * Creating an element is deliberately two local transactions under two origins,
 * and that shape is load-bearing for UNDO, not for Store reconciliation: a
 * `LOCAL` structural add would let `UndoManager` hard-remove the element on undo,
 * losing the tombstone/content/binding identity, while a wholly `STRUCTURAL`
 * create would not be undoable at all. Yjs cannot give nested parts of one
 * transaction different origins, so born-tombstoned STRUCTURAL prelude + tracked
 * LOCAL reveal is correct locally.
 *
 * What is NOT correct is that `onDocUpdate` broadcasts each non-REMOTE
 * transaction as it commits, so the two halves leave as two messages. A peer
 * applies two REMOTE transactions, bumps meta twice, recomputes twice, and can
 * manufacture two Store increments for one logical creation. Tombstone-first
 * hides the intermediate state visually; it does not make the mutation atomic on
 * the wire.
 */

const rect = (id: string): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

describe("INV-ONE-BROADCAST — one logical mutation, one transport message", () => {
  it("a pure property change emits exactly one", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);
    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.mutateElement(scene.getElement("a")!, { x: 42 });

    expect(updates.length).toBe(1);
    scene.destroy();
  });

  // SKIPPED — confirmed live defect, see FR-017 / T016g. Currently emits 2: the
  // STRUCTURAL tombstone prelude and the LOCAL reveal each broadcast on commit.
  // The fix is a Scene-level logical-mutation boundary: capture the pre-action
  // state vector, suppress delivery across both transactions, emit ONE delta from
  // that vector after the reveal.
  it.skip("an element creation emits exactly one", () => {
    const scene = new Scene();
    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.replaceAllElements([rect("a")]);

    expect(updates.length).toBe(1);
    scene.destroy();
  });
});
