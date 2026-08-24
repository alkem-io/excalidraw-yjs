import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

const mk = (id: string, x = 0): ExcalidrawElement =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x,
      y: 0,
      width: 10,
      height: 10,
    } as Parameters<typeof newElement>[0]) as ExcalidrawElement),
    id,
    x,
  } as ExcalidrawElement);

const xOf = (scene: Scene, id: string) =>
  scene.getElementsIncludingDeleted().find((e) => e.id === id)?.x;

const moveTo = (scene: Scene, id: string, x: number, record: boolean) =>
  scene.replaceAllElements(
    scene
      .getElementsIncludingDeleted()
      .map((e) => (e.id === id ? { ...e, x } : e)),
    record ? undefined : { recordHistory: false },
  );

/**
 * A NON-RECORDING write lands in the document but produces NO undo step.
 *
 * `replaceAllElements(..., { recordHistory: false })` is the path a scene load,
 * an import, an undo/redo re-application and every `CaptureUpdateAction.NEVER`
 * host update take. It writes under `STRUCTURAL_ORIGIN`, which the
 * `Y.UndoManager` does not track — so Ctrl+Z after a load reverts the user's
 * last real edit, never the load.
 *
 * FOUND BY MUTATION TESTING, not by inspection. Collapsing
 * `recordHistory ? LOCAL_ORIGIN : STRUCTURAL_ORIGIN` to a bare `LOCAL_ORIGIN`
 * SURVIVED the whole suite — 1635 tests — while the opposite collapse (always
 * `STRUCTURAL_ORIGIN`) died in 9s against an existing history test. One
 * direction of this contract was asserted everywhere and the other nowhere.
 *
 * There are TWO such selectors, and the first draft of this file tested the
 * wrong one. `replaceAllElements` picks its origin at `Scene.ts:1406`;
 * `commitPlan` — the `applyElementChanges` path — picks it independently at
 * `Scene.ts:1173`, and that is the one the surviving mutant hits. Both are
 * reachable in production from `syncActionResult`, which routes an action
 * result through `applyElementChanges` when it carries an invocation base and
 * through `replaceAllElements` otherwise, with `recordHistory` derived from
 * `captureUpdate !== NEVER` in both cases. So both are covered below.
 */
describe("non-recording writes produce no undo step", () => {
  it("the next undo reverts the RECORDED edit, leaving the non-recorded one alone", () => {
    const scene = new Scene();
    // a load: both elements arrive without becoming undo steps
    scene.replaceAllElements([mk("a"), mk("b")], { recordHistory: false });
    scene.stopElementCapture();

    moveTo(scene, "a", 50, true); // the user's edit
    scene.stopElementCapture();
    moveTo(scene, "b", 60, false); // a programmatic NEVER update
    scene.stopElementCapture();

    expect([xOf(scene, "a"), xOf(scene, "b")]).toEqual([50, 60]);

    expect(scene.undoElements()).toBe(true);

    // `a` reverted; `b` untouched. Under the surviving mutant the undo consumes
    // the programmatic write instead: `b` goes back to 0 and `a` stays at 50.
    expect([xOf(scene, "a"), xOf(scene, "b")]).toEqual([0, 60]);
    scene.destroy();
  });

  it("a scene built only from non-recording writes has nothing to undo", () => {
    const scene = new Scene();
    scene.replaceAllElements([mk("a")], { recordHistory: false });
    scene.stopElementCapture();
    moveTo(scene, "a", 25, false);
    scene.stopElementCapture();

    expect(xOf(scene, "a")).toBe(25);
    expect(scene.canUndoElements()).toBe(false);
    expect(scene.undoElements()).toBe(false);
    expect(xOf(scene, "a")).toBe(25);
    scene.destroy();
  });

  it("APPLYELEMENTCHANGES: a non-recording change is not what the next undo reverts", () => {
    // The other origin selector (`commitPlan`, Scene.ts:1173). Reached in
    // production when an action result carries an invocation base and
    // `captureUpdate: NEVER` — the action-mutation-journal path.
    const scene = new Scene();
    scene.replaceAllElements([mk("a"), mk("b")], { recordHistory: false });
    scene.stopElementCapture();

    const base1 = scene.getElementsIncludingDeleted();
    scene.applyElementChanges(
      base1,
      base1.map((e) => (e.id === "a" ? { ...e, x: 50 } : e)),
    );
    scene.stopElementCapture();

    const base2 = scene.getElementsIncludingDeleted();
    scene.applyElementChanges(
      base2,
      base2.map((e) => (e.id === "b" ? { ...e, x: 60 } : e)),
      { recordHistory: false },
    );
    scene.stopElementCapture();

    expect([xOf(scene, "a"), xOf(scene, "b")]).toEqual([50, 60]);
    expect(scene.undoElements()).toBe(true);
    expect([xOf(scene, "a"), xOf(scene, "b")]).toEqual([0, 60]);
    scene.destroy();
  });

  it("a non-recording write between two recorded edits is not a step of its own", () => {
    const scene = new Scene();
    scene.replaceAllElements([mk("a"), mk("b")], { recordHistory: false });
    scene.stopElementCapture();

    moveTo(scene, "a", 10, true);
    scene.stopElementCapture();
    moveTo(scene, "b", 99, false); // interposed, must not consume an undo
    scene.stopElementCapture();
    moveTo(scene, "a", 20, true);
    scene.stopElementCapture();

    expect(scene.undoElements()).toBe(true);
    expect([xOf(scene, "a"), xOf(scene, "b")]).toEqual([10, 99]);
    expect(scene.undoElements()).toBe(true);
    expect([xOf(scene, "a"), xOf(scene, "b")]).toEqual([0, 99]);
    scene.destroy();
  });
});
