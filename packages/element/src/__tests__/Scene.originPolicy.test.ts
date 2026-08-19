import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

const rect = (id: string): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

/**
 * `Scene.onDocUpdate` is the transport boundary a generic consumer subscribes to.
 * Its origin policy must be the SAME one the bundled collaboration client applies
 * — there is one correct policy, and it lives here.
 *
 * EPHEMERAL writes are local, non-undoable maintenance: scene load/init, reset,
 * file pruning, non-capturing programmatic updates. Broadcasting them pushes
 * destructive whole-scene deletes to peers. The bundled client suppresses them
 * explicitly; a consumer following the advertised Scene API must not have to
 * rediscover that.
 */
describe("Scene.onDocUpdate origin policy", () => {
  it("does NOT broadcast an EPHEMERAL write", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a"), rect("b")]);

    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    // exactly what a scene reset does: a non-undoable local clear
    scene.replaceAllElements([], { recordHistory: false });

    expect(scene.getElementsIncludingDeleted()).toHaveLength(0); // it happened
    expect(updates).toHaveLength(0); // ...and it was not broadcast
    scene.destroy();
  });

  it("still broadcasts an ordinary LOCAL edit", () => {
    // Guard: the fix must not silence real edits.
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));
    scene.mutateElement(scene.getElement("a")!, { x: 42 });

    expect(updates.length).toBeGreaterThan(0);
    scene.destroy();
  });

  it("still broadcasts a creation (STRUCTURAL prelude is not suppressed)", () => {
    // Guard: STRUCTURAL must stay on the wire — a born-revealed create is a
    // structural add plus its reveal, and suppressing it would lose the element.
    const scene = new Scene();
    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.replaceAllElements([rect("new")]);

    expect(updates.length).toBeGreaterThan(0);
    scene.destroy();
  });
});
