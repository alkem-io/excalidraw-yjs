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

  it("a RECORDING creation is exactly ONE update and a complete live peer element", () => {
    // The other half of the guarantee: suppressing a non-recording create must not
    // also suppress a real one, and the two transactions must arrive as one.
    const a = new Scene();
    const b = new Scene();
    const updates: Uint8Array[] = [];
    a.onDocUpdate((u) => {
      updates.push(u);
      b.applyRemoteUpdate(u);
    });

    a.replaceAllElements([rect("shared")]);

    expect(updates).toHaveLength(1);
    const onPeer = b.getElement("shared");
    expect(onPeer).toBeTruthy();
    expect(onPeer!.isDeleted).toBe(false); // revealed, not a leaked tombstone
    expect(onPeer!.width).toBe(10); // and complete
    a.destroy();
    b.destroy();
  });

  it("a remote apply is never echoed back", () => {
    const a = new Scene();
    const b = new Scene();
    b.replaceAllElements([rect("fromB")]);

    const echoed: Uint8Array[] = [];
    a.onDocUpdate((u) => echoed.push(u));
    a.applyRemoteUpdate(b.encodeStateAsUpdate());

    expect(a.getElement("fromB")).toBeTruthy(); // it applied
    expect(echoed).toHaveLength(0); // ...and did not bounce back
    a.destroy();
    b.destroy();
  });
});

describe("Scene.onDocUpdate — a NON-RECORDING creation must be fully invisible", () => {
  /** Two Scenes wired through the public transport surface. */
  const link = (a: Scene, b: Scene) => {
    const detach = [
      a.onDocUpdate((u) => b.applyRemoteUpdate(u)),
      b.onDocUpdate((u) => a.applyRemoteUpdate(u)),
    ];
    return () => detach.forEach((d) => d());
  };

  it("leaks no content-bearing tombstone to a peer", () => {
    // A creation is a STRUCTURAL prelude (born-tombstoned, CONTENT-BEARING) plus a
    // reveal. Filtering by transaction origin alone broadcasts the structural half
    // of a non-recording create and filters the reveal — so the peer receives a
    // tombstone carrying the element's real properties and never learns it should
    // become live. That is worse than either broadcasting or suppressing the whole
    // mutation: it is permanent divergence plus a content leak.
    const a = new Scene();
    const b = new Scene();

    const updates: Uint8Array[] = [];
    const detachCount = a.onDocUpdate((u) => updates.push(u));
    const unlink = link(a, b);

    a.replaceAllElements([rect("secret")], { recordHistory: false });

    // GUARD: the write really happened locally, or the assertions below are vacuous.
    expect(a.getElement("secret")).toBeTruthy();
    expect(a.getElement("secret")!.isDeleted).toBe(false);

    expect(updates).toHaveLength(0);
    // ZERO entries, not merely zero LIVE elements — a tombstone is an entry.
    expect([...b.yElements.keys()]).toEqual([]);

    detachCount();
    unlink();
    a.destroy();
    b.destroy();
  });
});
