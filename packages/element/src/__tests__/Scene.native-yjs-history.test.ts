import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { LOCAL_ORIGIN } from "../yjs";

import type { ExcalidrawElement } from "../types";

/**
 * Native-Yjs core (M2) — proves element undo/redo IS the doc's `Y.UndoManager`:
 *
 *  - undo reverts the actual `yElements` mutation AND the derived reads update;
 *    redo restores it;
 *  - multi-step undo/redo walks the stack correctly;
 *  - rapid edits inside one "action" coalesce into a single undo step, and a
 *    `stopElementCapture()` boundary splits discrete actions;
 *  - **origin scope**: a non-`LOCAL_ORIGIN` (simulated remote / system) doc
 *    transaction is NOT captured and NOT reverted by the local UndoManager — the
 *    exact guarantee M3 collaboration is built on.
 */

const rect = (
  id: string,
  overrides: Partial<ExcalidrawElement> = {},
): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...overrides,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

describe("native-yjs Scene history: undo/redo IS the doc's UndoManager", () => {
  it("create → undo TOMBSTONES the element (Excalidraw semantics); redo reveals", () => {
    const scene = new Scene();
    // (no initial population to clear — the scene starts empty)

    // A discrete user action: add one element, then seal the step.
    scene.replaceAllElements([rect("a")]);
    scene.stopElementCapture();

    expect([...scene.yElements.keys()]).toEqual(["a"]);
    expect(scene.getNonDeletedElements().map((e) => e.id)).toEqual(["a"]);
    expect(scene.getElement("a")!.isDeleted).toBe(false);
    expect(scene.canUndoElements()).toBe(true);
    expect(scene.canRedoElements()).toBe(false);

    // undo → the element becomes a TOMBSTONE (isDeleted:true), NOT a hard removal:
    // the doc entry + content persist (so bindings/refs resolve and M3 collab can
    // reconcile), matching upstream Excalidraw's "undo of create → deleted".
    expect(scene.undoElements()).toBe(true);
    expect([...scene.yElements.keys()]).toEqual(["a"]); // entry still present…
    expect(scene.yElements.get("a")!.get("isDeleted")).toBe(true); // …as tombstone
    expect(scene.getElement("a")!.isDeleted).toBe(true);
    expect(scene.getNonDeletedElements()).toEqual([]); // …hidden from live views
    expect(scene.canUndoElements()).toBe(false);
    expect(scene.canRedoElements()).toBe(true);

    // redo → revealed again (isDeleted:false) in the doc + the derived read
    expect(scene.redoElements()).toBe(true);
    expect(scene.getElement("a")!.isDeleted).toBe(false);
    expect(scene.getNonDeletedElements().map((e) => e.id)).toEqual(["a"]);

    scene.destroy();
  });

  it("drop-from-replace → undo RE-ADDS the structurally-removed element; redo removes", () => {
    // An element dropped from `nextElements` (e.g. scene import / replace-all) is
    // structurally removed from the doc, but the removal is a tracked step — so
    // undo re-adds the entry (with its content) and redo removes it again. This is
    // what makes a destructive replace undoable while keeping the doc == the passed
    // set (no tombstone graveyard in `getElementsIncludingDeleted`).
    const scene = new Scene([rect("a", { x: 1 }), rect("b", { x: 2 })]);
    scene.clearElementHistory();

    // drop "b"
    scene.replaceAllElements([scene.getElement("a")!]);
    scene.stopElementCapture();
    expect([...scene.yElements.keys()]).toEqual(["a"]);
    expect(scene.getElement("b")).toBeNull();

    // undo → "b" is restored structurally, content intact
    expect(scene.undoElements()).toBe(true);
    expect([...scene.yElements.keys()].sort()).toEqual(["a", "b"]);
    expect(scene.getElement("b")!.x).toBe(2);
    expect(
      scene
        .getNonDeletedElements()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);

    // redo → "b" removed again
    expect(scene.redoElements()).toBe(true);
    expect([...scene.yElements.keys()]).toEqual(["a"]);
    expect(scene.getElement("b")).toBeNull();

    scene.destroy();
  });

  it("undo reverts a property mutation on the doc; the derived element updates", () => {
    const scene = new Scene([rect("a", { x: 0 })]);
    // Drop the initial scene-population step (the editor likewise loads with
    // CaptureUpdateAction.NEVER + history.clear()), so we test only our edits.
    scene.clearElementHistory();

    scene.mutateElement(scene.getElement("a")!, { x: 250 });
    scene.stopElementCapture();
    expect(scene.yElements.get("a")!.get("x")).toBe(250);
    expect(scene.getElement("a")!.x).toBe(250);

    expect(scene.undoElements()).toBe(true);
    // the doc reverted to x:0 AND the derived element reflects it
    expect(scene.yElements.get("a")!.get("x")).toBe(0);
    expect(scene.getElement("a")!.x).toBe(0);

    expect(scene.redoElements()).toBe(true);
    expect(scene.yElements.get("a")!.get("x")).toBe(250);
    expect(scene.getElement("a")!.x).toBe(250);

    scene.destroy();
  });

  it("undo bumps the local version so downstream change-detection sees a change", () => {
    const scene = new Scene([rect("a", { x: 0 })]);
    scene.clearElementHistory();

    scene.mutateElement(scene.getElement("a")!, { x: 250 });
    scene.stopElementCapture();
    const versionAfterEdit = scene.getElement("a")!.version;

    scene.undoElements();
    // value reverted, but version is strictly GREATER (undo is treated as a fresh
    // change for the editor's snapshot/renderer diffing — old-history contract).
    expect(scene.getElement("a")!.x).toBe(0);
    expect(scene.getElement("a")!.version).toBeGreaterThan(versionAfterEdit);

    scene.destroy();
  });

  it("multi-step: three discrete actions undo/redo in LIFO order", () => {
    const scene = new Scene();

    scene.replaceAllElements([rect("a")]);
    scene.stopElementCapture();
    scene.replaceAllElements([rect("a"), rect("b")]);
    scene.stopElementCapture();
    scene.replaceAllElements([rect("a"), rect("b"), rect("c")]);
    scene.stopElementCapture();

    // Undo of a creation tombstones the element (it stays in the doc as deleted),
    // so we track the LIVE (non-deleted) ids — the user-visible scene.
    const ids = () => scene.getNonDeletedElements().map((e) => e.id);
    expect(ids()).toEqual(["a", "b", "c"]);

    scene.undoElements();
    expect(ids()).toEqual(["a", "b"]);
    scene.undoElements();
    expect(ids()).toEqual(["a"]);
    scene.undoElements();
    expect(ids()).toEqual([]);
    expect(scene.canUndoElements()).toBe(false);

    scene.redoElements();
    expect(ids()).toEqual(["a"]);
    scene.redoElements();
    expect(ids()).toEqual(["a", "b"]);
    scene.redoElements();
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(scene.canRedoElements()).toBe(false);

    scene.destroy();
  });

  it("capture-grouping: rapid edits with NO boundary collapse to ONE undo step", () => {
    const scene = new Scene([rect("a", { x: 0 })]);
    scene.clearElementHistory();

    // Three rapid mutations, NO stopElementCapture between them → one step
    // (captureTimeout is effectively infinite, so only explicit boundaries split).
    scene.mutateElement(scene.getElement("a")!, { x: 10 });
    scene.mutateElement(scene.getElement("a")!, { x: 20 });
    scene.mutateElement(scene.getElement("a")!, { x: 30 });
    scene.stopElementCapture();

    expect(scene.getElement("a")!.x).toBe(30);

    // a SINGLE undo reverts all three back to the pre-action value
    expect(scene.undoElements()).toBe(true);
    expect(scene.getElement("a")!.x).toBe(0);
    // and there is nothing more to undo (they were one step)
    expect(scene.canUndoElements()).toBe(false);

    scene.destroy();
  });

  it("capture-boundary: a stopElementCapture() between edits splits them into TWO steps", () => {
    const scene = new Scene([rect("a", { x: 0 })]);
    scene.clearElementHistory();

    scene.mutateElement(scene.getElement("a")!, { x: 10 });
    scene.stopElementCapture(); // boundary
    scene.mutateElement(scene.getElement("a")!, { x: 20 });
    scene.stopElementCapture();

    expect(scene.getElement("a")!.x).toBe(20);

    scene.undoElements(); // undo the second edit only
    expect(scene.getElement("a")!.x).toBe(10);
    expect(scene.canUndoElements()).toBe(true);

    scene.undoElements(); // undo the first edit
    expect(scene.getElement("a")!.x).toBe(0);
    expect(scene.canUndoElements()).toBe(false);

    scene.destroy();
  });

  it("ORIGIN SCOPE: a non-LOCAL_ORIGIN (remote) transaction is NOT captured nor reverted", () => {
    const scene = new Scene([rect("a", { x: 0 })]);
    scene.stopElementCapture();

    // A local edit — captured by the UndoManager (origin LOCAL_ORIGIN).
    scene.mutateElement(scene.getElement("a")!, { x: 100 });
    scene.stopElementCapture();
    expect(scene.canUndoElements()).toBe(true);
    const undoDepthBefore = scene.undoManager.undoStack.length;

    // Simulate a REMOTE / system write: mutate the doc directly under a DIFFERENT
    // origin (NOT LOCAL_ORIGIN). This is exactly the shape of an M3 remote apply.
    const REMOTE_ORIGIN = { name: "simulated-remote" };
    scene.doc.transact(() => {
      scene.yElements.get("a")!.set("y", 777);
    }, REMOTE_ORIGIN);

    // The remote change is visible in the doc + derived reads…
    expect(scene.yElements.get("a")!.get("y")).toBe(777);
    expect(scene.getElement("a")!.y).toBe(777);
    // …but it did NOT add an undo step (origin not tracked).
    expect(scene.undoManager.undoStack.length).toBe(undoDepthBefore);

    // Undo reverts ONLY the local edit (x:100 → x:0) and leaves the remote
    // change (y:777) intact — never reverting a remote/system transaction.
    expect(scene.undoElements()).toBe(true);
    expect(scene.getElement("a")!.x).toBe(0);
    expect(scene.getElement("a")!.y).toBe(777);

    scene.destroy();
  });

  it("ORIGIN SCOPE: a concurrent remote edit during the undo session is preserved", () => {
    // Tighter proof that undo targets local-only history: interleave a remote
    // write between two local steps, then undo past both local steps.
    const scene = new Scene([rect("a", { x: 0, y: 0 })]);
    scene.clearElementHistory();

    scene.mutateElement(scene.getElement("a")!, { x: 1 }); // local step 1
    scene.stopElementCapture();
    scene.mutateElement(scene.getElement("a")!, { x: 2 }); // local step 2
    scene.stopElementCapture();

    // remote sets an INDEPENDENT property (origin not LOCAL_ORIGIN)
    scene.doc.transact(
      () => {
        scene.yElements.get("a")!.set("strokeColor", "#ff0000");
      },
      { name: "remote" },
    );

    scene.undoElements(); // x:2 → x:1
    scene.undoElements(); // x:1 → x:0
    expect(scene.canUndoElements()).toBe(false);

    // both local steps reverted; the remote strokeColor survived untouched.
    expect(scene.getElement("a")!.x).toBe(0);
    expect(scene.getElement("a")!.strokeColor).toBe("#ff0000");

    scene.destroy();
  });

  it("clearElementHistory wipes both stacks; LOCAL_ORIGIN is the tracked origin", () => {
    const scene = new Scene([rect("a")]);
    scene.stopElementCapture();
    scene.mutateElement(scene.getElement("a")!, { x: 5 });
    scene.stopElementCapture();

    expect(scene.canUndoElements()).toBe(true);

    // Document the origin-scope config explicitly: LOCAL_ORIGIN is tracked, and
    // no foreign/remote origin is. (Yjs additionally tracks the UndoManager
    // instance itself so it can capture its own redo-after-undo — that internal
    // entry is expected; what matters is that only LOCAL_ORIGIN among *our*
    // origins is tracked, so remote/system writes are never captured.)
    expect(scene.undoManager.trackedOrigins.has(LOCAL_ORIGIN)).toBe(true);
    expect(scene.undoManager.trackedOrigins.has(scene.undoManager)).toBe(true);
    expect(
      [...scene.undoManager.trackedOrigins].filter(
        (o) => o !== LOCAL_ORIGIN && o !== scene.undoManager,
      ),
    ).toEqual([]);

    scene.clearElementHistory();
    expect(scene.canUndoElements()).toBe(false);
    expect(scene.canRedoElements()).toBe(false);

    scene.destroy();
  });
});
