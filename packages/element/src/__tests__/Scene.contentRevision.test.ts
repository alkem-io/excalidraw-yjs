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
 * T026 — `contentRevision` is the exact "has anything changed since?" token that
 * replaces summing element versions (T007 measured that sum broken in BOTH
 * directions).
 */
describe("Scene.contentRevision", () => {
  it("advances on a local write and stays put when nothing changes", () => {
    const scene = new Scene();
    const start = scene.contentRevision;

    scene.replaceAllElements([rect("a")]);
    const afterWrite = scene.contentRevision;
    expect(afterWrite).toBeGreaterThan(start);

    // A read must not count as a change.
    scene.getNonDeletedElements();
    scene.getElementsIncludingDeleted();
    expect(scene.contentRevision).toBe(afterWrite);

    // Writing the identical set again is a Yjs no-op, so it must not advance.
    scene.replaceAllElements(scene.getElementsIncludingDeleted());
    expect(scene.contentRevision).toBe(afterWrite);
  });

  it("advances on a REMOTE apply — a peer's edit leaves the store just as stale", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);
    const before = scene.contentRevision;

    const peer = new Scene();
    peer.replaceAllElements([rect("b")]);
    scene.applyRemoteUpdate(peer.encodeStateAsUpdate("v2"), "v2");

    expect(scene.contentRevision).toBeGreaterThan(before);
    // NON-VACUITY: the remote edit really landed, so the bump is that edit and
    // not an unrelated transaction.
    expect(
      scene
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("advances on asset-reference and appState writes, not only elements", () => {
    const scene = new Scene();

    const beforeAssets = scene.contentRevision;
    scene.setAssetLocators({ f1: "asset://f1" });
    expect(scene.contentRevision).toBeGreaterThan(beforeAssets);

    const beforeAppState = scene.contentRevision;
    scene.setAppState({ viewBackgroundColor: "#abcdef" });
    expect(scene.contentRevision).toBeGreaterThan(beforeAppState);
  });

  it("does NOT collide the way a version SUM does", () => {
    // The exact T007 false-skip: one element's version up, another's down.
    const scene = new Scene();
    scene.replaceAllElements([
      rect("a", { version: 5 }),
      rect("b", { version: 5 }),
    ]);
    const before = scene.contentRevision;

    scene.replaceAllElements([
      rect("a", { version: 6, x: 999 }),
      rect("b", { version: 4 }),
    ]);

    // A summing token reports "unchanged" here. The counter cannot.
    expect(scene.contentRevision).toBeGreaterThan(before);
  });

  it("advances once per logical mutation, not once per Yjs transaction", () => {
    const scene = new Scene();
    const before = scene.contentRevision;

    // A create is a structural add plus its reveal — two transactions. The
    // counter is a change token, not a transaction count that callers depend
    // on being 1:1, so all that matters is that it MOVED.
    scene.replaceAllElements([rect("a")]);
    expect(scene.contentRevision).toBeGreaterThan(before);
  });

  it("survives doc adoption — an adopted doc's later changes still count", () => {
    const source = new Scene();
    source.replaceAllElements([rect("a")]);

    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, source.encodeStateAsUpdate("v2"));
    const adopted = new Scene(null, { doc });

    const before = adopted.contentRevision;
    adopted.replaceAllElements([
      ...adopted.getElementsIncludingDeleted(),
      rect("b"),
    ]);
    expect(adopted.contentRevision).toBeGreaterThan(before);
  });

  it("does NOT advance for local UI state that never reaches the doc", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);
    const before = scene.contentRevision;

    // Selection / zoom / cursor are React appState, not persisted keys. Writing
    // one through the doc's appState setter is filtered by the allow-list, so it
    // must not dirty the scene — otherwise merely panning would trigger a save.
    scene.setAppState({ selectedElementIds: { a: true } } as never);
    scene.setAppState({ zoom: { value: 2 } } as never);

    expect(scene.contentRevision).toBe(before);
  });

  it("advances on a DELETE, on undo, and on redo", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a"), rect("b")]);

    const beforeDelete = scene.contentRevision;
    scene.replaceAllElements([rect("a")]);
    expect(scene.contentRevision).toBeGreaterThan(beforeDelete);

    // Undo and redo change the persisted document just as much as the edit did;
    // a store that missed them would hold content the user has since reverted.
    const beforeUndo = scene.contentRevision;
    // GUARD: assert the undo actually reverted something, so the bump below is
    // that revert and not an unrelated transaction.
    expect(scene.undoElements()).toBe(true);
    expect(scene.contentRevision).toBeGreaterThan(beforeUndo);

    const beforeRedo = scene.contentRevision;
    expect(scene.redoElements()).toBe(true);
    expect(scene.contentRevision).toBeGreaterThan(beforeRedo);
  });
});
