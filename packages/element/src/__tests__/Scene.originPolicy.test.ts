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
 * Only ONE thing is withheld: a remote apply, which must never be echoed back.
 * A non-recording write (scene load/init, a non-capturing programmatic update) is
 * NOT withheld — a shared-doc write cannot be hidden from
 * peers at all, since the next full-state encode carries it regardless. Such a
 * write is untracked by undo, not invisible. Work that genuinely must not reach
 * peers cannot live on the shared doc; the editor replaces the Scene generation
 * instead.
 */
describe("Scene.onDocUpdate origin policy", () => {
  it("DOES broadcast a non-recording write — it is untracked, not invisible", () => {
    // A non-recording write changes the shared document, so its structs are in
    // the next full-state encode whatever the incremental policy does. The
    // contract is therefore: untracked by undo, published like any other shared
    // change.
    const scene = new Scene();
    // Seed non-recording too, so the undo assertion below isolates the write
    // under test rather than inheriting an undo step from the seed.
    scene.replaceAllElements([rect("a"), rect("b")], { recordHistory: false });
    expect(scene.canUndoElements()).toBe(false); // guard

    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.replaceAllElements([rect("a")], { recordHistory: false });

    expect(scene.getElementsIncludingDeleted()).toHaveLength(1); // it happened
    expect(updates.length).toBeGreaterThan(0); // ...and peers are told
    expect(scene.canUndoElements()).toBe(false); // ...with no undo step
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

/**
 * appState (background colour, scene name) rides the SAME doc as the elements, so
 * the origin policy must cover it identically. This matters because `Scene` keeps
 * an observer on `yAppState` to push remote changes into the editor — an observer
 * that writes back would turn one peer's background change into an endless
 * round-trip between the two clients.
 */
describe("Scene.onDocUpdate origin policy — appState rides the same doc", () => {
  it("broadcasts a LOCAL appState change but never echoes a remote one", () => {
    const a = new Scene();
    const b = new Scene();

    const updates: Uint8Array[] = [];
    a.onDocUpdate((u) => updates.push(u));

    // A local appState change is real user intent — it must reach the wire.
    a.setAppState({ name: "Local A" });
    const afterLocal = updates.length;
    expect(afterLocal).toBeGreaterThan(0);

    // A peer's appState change is applied under the remote origin. Use a DIFFERENT
    // key so this asserts echo behaviour rather than last-writer-wins on one key.
    b.setAppState({ viewBackgroundColor: "#abcdef" });
    a.applyRemoteUpdate(b.encodeStateAsUpdate());

    expect(a.getPersistedAppState().viewBackgroundColor).toBe("#abcdef"); // applied
    expect(a.getPersistedAppState().name).toBe("Local A"); // local key intact
    expect(updates).toHaveLength(afterLocal); // ...and NOT echoed back out

    a.destroy();
    b.destroy();
  });
});

describe("Scene.onDocUpdate — a non-recording creation is atomic on the wire", () => {
  /** Two Scenes wired through the public transport surface. */
  const link = (a: Scene, b: Scene) => {
    const detach = [
      a.onDocUpdate((u) => b.applyRemoteUpdate(u)),
      b.onDocUpdate((u) => a.applyRemoteUpdate(u)),
    ];
    return () => detach.forEach((d) => d());
  };

  it("reaches the peer as a complete LIVE element, never a bare tombstone", () => {
    // A creation is a STRUCTURAL prelude (born-tombstoned, CONTENT-BEARING) plus a
    // reveal. Filtering by transaction origin alone, which
    // broadcast the structural half and dropped the reveal, leaving the peer with a
    // tombstone carrying the element's real properties that never became live —
    // permanent divergence plus a content leak.
    //
    // Non-recording creations are now published , so the invariant that
    // matters is atomicity: the prelude and its reveal arrive as ONE update, and
    // the peer never observes the intermediate tombstone.
    const a = new Scene();
    const b = new Scene();

    const updates: Uint8Array[] = [];
    const detachCount = a.onDocUpdate((u) => updates.push(u));
    const unlink = link(a, b);

    a.replaceAllElements([rect("secret")], { recordHistory: false });

    // GUARD: the write really happened locally, or the assertions are vacuous.
    expect(a.getElement("secret")).toBeTruthy();
    expect(a.getElement("secret")!.isDeleted).toBe(false);

    // ONE message, not a tombstone-add followed by a reveal.
    expect(updates).toHaveLength(1);
    // ...and the peer holds a complete, LIVE element.
    expect([...b.yElements.keys()]).toEqual(["secret"]);
    expect(b.getElement("secret")).toBeTruthy();
    expect(b.getElement("secret")!.isDeleted).toBe(false);

    detachCount();
    unlink();
    a.destroy();
    b.destroy();
  });
});
