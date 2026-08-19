import { newElement } from "@excalidraw-yjs/element";

import type { OrderedExcalidrawElement } from "@excalidraw-yjs/element/types";

import { ActionManager } from "../actions/manager";

import type { Action } from "../actions/types";
import type { AppClassProperties, AppState } from "../types";

/**
 * The invocation base must be a snapshot of the scene as it was BEFORE the action
 * ran (spec 002, FR-016 / T016a).
 *
 * JavaScript evaluates arguments left to right, so
 *
 *   this.updater(action.perform(elements, ...), captureElementBase(elements))
 *
 * runs `perform` FIRST. `Scene.mutateElement` mutates the object it is given, so
 * by the time the capture happens the "before" image already carries the action's
 * changes — and the derived intent diffs to nothing. The capture therefore has to
 * happen into a local, before `perform` is called.
 */
describe("ActionManager captures the invocation base BEFORE perform", () => {
  it("a sync perform mutating a nested field in place does not contaminate the base", () => {
    const element = newElement({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      groupIds: ["original"],
    } as Parameters<typeof newElement>[0]) as OrderedExcalidrawElement;

    const elements = [element];
    let capturedBase: readonly OrderedExcalidrawElement[] | undefined;

    const manager = new ActionManager(
      (_result, invocationBase) => {
        capturedBase = invocationBase;
      },
      () => ({} as AppState),
      () => elements,
      {} as AppClassProperties,
    );

    const mutatingAction = {
      name: "test-sync-mutator",
      label: "",
      trackEvent: false,
      perform: (els: readonly OrderedExcalidrawElement[]) => {
        // exactly what a real action does via Scene.mutateElement: mutate the
        // passed object, nested field included
        (els[0] as { x: number }).x = 999;
        (els[0].groupIds as string[]).push("added-during-perform");
        return { elements: els, captureUpdate: "IMMEDIATELY" };
      },
    } as unknown as Action;

    manager.executeAction(mutatingAction);

    expect(capturedBase).toBeDefined();
    // The live element really was mutated — otherwise this proves nothing.
    expect(elements[0].x).toBe(999);
    expect(elements[0].groupIds).toEqual(["original", "added-during-perform"]);

    // ...and the base must still show the PRE-action values.
    expect(capturedBase![0].x).toBe(0);
    expect(capturedBase![0].groupIds).toEqual(["original"]);
  });
});
