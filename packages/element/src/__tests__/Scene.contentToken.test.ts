import * as Y from "yjs";

import { Scene } from "../Scene";
import { newElement } from "../newElement";

import type { ExcalidrawElement } from "../types";

const rect = (id: string, over: Partial<ExcalidrawElement> = {}) =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...over,
  } as Parameters<typeof newElement>[0]);

/**
 * T026 — `contentToken` is the exact "has anything changed since?" token that
 * replaces summing element versions (T007 measured that sum broken in BOTH
 * directions).
 */
describe("Scene.contentToken", () => {
  it("changes on a local write and stays put when nothing changes", () => {
    const scene = new Scene();
    const start = scene.contentToken;

    scene.replaceAllElements([rect("a")]);
    const afterWrite = scene.contentToken;
    expect(afterWrite).not.toBe(start);

    // A read must not count as a change.
    scene.getNonDeletedElements();
    scene.getElementsIncludingDeleted();
    expect(scene.contentToken).toBe(afterWrite);

    // Writing the identical set again is a Yjs no-op, so it must not advance.
    scene.replaceAllElements(scene.getElementsIncludingDeleted());
    expect(scene.contentToken).toBe(afterWrite);
  });

  it("changes on a REMOTE apply — a peer's edit leaves the store just as stale", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);
    const before = scene.contentToken;

    const peer = new Scene();
    peer.replaceAllElements([rect("b")]);
    scene.applyRemoteUpdate(peer.encodeStateAsUpdate("v2"), "v2");

    expect(scene.contentToken).not.toBe(before);
    // NON-VACUITY: the remote edit really landed, so the bump is that edit and
    // not an unrelated transaction.
    expect(
      scene
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("changes on asset-reference and appState writes, not only elements", () => {
    const scene = new Scene();

    const beforeAssets = scene.contentToken;
    scene.setAssetLocators({ f1: "asset://f1" });
    expect(scene.contentToken).not.toBe(beforeAssets);

    const beforeAppState = scene.contentToken;
    scene.setAppState({ viewBackgroundColor: "#abcdef" });
    expect(scene.contentToken).not.toBe(beforeAppState);
  });

  it("does NOT collide the way a version SUM does", () => {
    // The exact T007 false-skip: one element's version up, another's down.
    const scene = new Scene();
    scene.replaceAllElements([
      rect("a", { version: 5 }),
      rect("b", { version: 5 }),
    ]);
    const before = scene.contentToken;

    scene.replaceAllElements([
      rect("a", { version: 6, x: 999 }),
      rect("b", { version: 4 }),
    ]);

    // A summing token reports "unchanged" here. The counter cannot.
    expect(scene.contentToken).not.toBe(before);
  });

  it("changes once per logical mutation, whatever the transaction count", () => {
    const scene = new Scene();
    const before = scene.contentToken;

    // A create is a structural add plus its reveal — two transactions. The
    // counter is a change token, not a transaction count that callers depend
    // on being 1:1, so all that matters is that it MOVED.
    scene.replaceAllElements([rect("a")]);
    expect(scene.contentToken).not.toBe(before);
  });

  it("survives doc adoption — an adopted doc's later changes still count", () => {
    const source = new Scene();
    source.replaceAllElements([rect("a")]);

    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, source.encodeStateAsUpdate("v2"));
    const adopted = new Scene(null, { doc });

    const before = adopted.contentToken;
    adopted.replaceAllElements([
      ...adopted.getElementsIncludingDeleted(),
      rect("b"),
    ]);
    expect(adopted.contentToken).not.toBe(before);
  });

  it("does NOT change for local UI state that never reaches the doc", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);
    const before = scene.contentToken;

    // Selection / zoom / cursor are React appState, not persisted keys. Writing
    // one through the doc's appState setter is filtered by the allow-list, so it
    // must not dirty the scene — otherwise merely panning would trigger a save.
    scene.setAppState({ selectedElementIds: { a: true } } as never);
    scene.setAppState({ zoom: { value: 2 } } as never);

    expect(scene.contentToken).toBe(before);
  });

  it("changes on a DELETE, on undo, and on redo", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a"), rect("b")]);

    const beforeDelete = scene.contentToken;
    scene.replaceAllElements([rect("a")]);
    expect(scene.contentToken).not.toBe(beforeDelete);

    // Undo and redo change the persisted document just as much as the edit did;
    // a store that missed them would hold content the user has since reverted.
    const beforeUndo = scene.contentToken;
    // GUARD: assert the undo actually reverted something, so the bump below is
    // that revert and not an unrelated transaction.
    expect(scene.undoElements()).toBe(true);
    expect(scene.contentToken).not.toBe(beforeUndo);

    const beforeRedo = scene.contentToken;
    expect(scene.redoElements()).toBe(true);
    expect(scene.contentToken).not.toBe(beforeRedo);
  });

  /**
   * The reason this is an OBJECT and not a counter (found in review).
   *
   * A counter is only monotonic within one Scene, but the persistence cache
   * outlives a Scene: it is keyed by socket, and a reset replaces the Scene
   * underneath it. Measured before the fix — two independent scenes both reached
   * revision 2, so a save of one would have marked the other clean.
   */
  it("never matches a DIFFERENT generation, even at the same edit count", () => {
    const a = new Scene();
    a.replaceAllElements([rect("x")]);

    const b = new Scene();
    b.replaceAllElements([rect("y")]);

    // Identical edit counts, unrelated content.
    expect(a.contentToken).not.toBe(b.contentToken);

    // ...and a brand-new scene that has done NOTHING is still distinct, so
    // "revision 0" cannot be mistaken for another scene's saved baseline.
    expect(new Scene().contentToken).not.toBe(new Scene().contentToken);
    expect(new Scene().contentToken).not.toBe(a.contentToken);
  });

  it("keeps a token stable across reads so a captured one stays comparable", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    const captured = scene.contentToken;
    scene.getNonDeletedElements();
    scene.encodeStateAsUpdate("v2");

    // A save holds this across an await; reads in between must not invalidate it.
    expect(scene.contentToken).toBe(captured);
  });
});
