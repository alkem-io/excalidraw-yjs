import { pointFrom } from "@excalidraw-yjs/math";
import { bindBindingElement } from "@excalidraw-yjs/element";
import { Excalidraw } from "@excalidraw-yjs/excalidraw";
import { distributeHorizontally } from "@excalidraw-yjs/excalidraw/actions/actionDistribute";
import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";
import {
  act,
  render,
  unmountComponent,
} from "@excalidraw-yjs/excalidraw/tests/test-utils";

import type {
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
} from "@excalidraw-yjs/element/types";

const { h } = window;

/**
 * T016f coverage gap — `actionDistribute`'s post-helper re-read.
 *
 * Same reachable shape as `actionAlign`'s: the fallback fires only for an
 * element ABSENT from `updatedElements`, i.e. a bound arrow moved through the
 * doc by `updateBoundElements` while not itself selected. Distribution needs
 * three bindables, so no existing test had it.
 *
 * MEASURED, and the result differs from `actionAlign`'s: this site IS reached
 * (instrumented — the live arrow differs from the stale entry at that moment),
 * but it is NOT load-bearing under the patch route. With the re-read removed the
 * final arrow is byte-identical (`[[0,0],[188,0]]`, `x` 106.00000000000001), and
 * removing it fails nothing, because the action's entry for the unselected arrow
 * equals its INVOCATION BASE — so the derived diff declares no keys for it and
 * the helper's doc write is already protected.
 *
 * So this is coverage, not a retirement gate: the site is now KNOWN rather than
 * unknown, and it is deliberately NOT retired, since nothing fails when it
 * returns.
 */
describe("distribute: a bound but UNSELECTED arrow", () => {
  beforeEach(async () => {
    unmountComponent();
    await render(<Excalidraw handleKeyboardGlobally />);
  });

  it("keeps the arrow's doc-written geometry when the bindables are distributed", () => {
    const mk = (id: string, x: number) =>
      API.createElement({
        type: "rectangle",
        id,
        x,
        y: 0,
        width: 100,
        height: 100,
      }) as ExcalidrawBindableElement;

    // Deliberately uneven gaps, so distributing MOVES the middle one.
    const r1 = mk("r1", 0);
    const r2 = mk("r2", 120);
    const r3 = mk("r3", 600);
    const arrow = API.createElement({
      type: "arrow",
      id: "arr",
      x: 100,
      y: 50,
      width: 20,
      height: 0,
      points: [pointFrom(0, 0), pointFrom(20, 0)],
    }) as ExcalidrawArrowElement;

    API.setElements([r1, r2, r3, arrow]);
    bindBindingElement(arrow, r1, "orbit", "start", h.scene);
    bindBindingElement(arrow, r2, "orbit", "end", h.scene);

    const live = () =>
      h.elements.find((e) => e.id === "arr") as ExcalidrawArrowElement;
    const rx = (id: string) => h.elements.find((e) => e.id === id)!.x;

    // GUARD: bound, and NOT selected — the only shape reaching the fallback.
    expect(live().startBinding?.elementId).toBe("r1");
    expect(live().endBinding?.elementId).toBe("r2");
    API.setSelectedElements([r1, r2, r3]);
    expect(Object.keys(h.state.selectedElementIds).sort()).toEqual([
      "r1",
      "r2",
      "r3",
    ]);

    const beforeMidX = rx("r2");

    act(() => {
      h.app.actionManager.executeAction(distributeHorizontally);
    });

    // The distribute really happened: the middle rectangle moved.
    expect(rx("r2")).not.toBe(beforeMidX);

    // The arrow followed its bindables through the doc.
    const pts = live().points;
    expect(Math.abs(pts[pts.length - 1][0] - pts[0][0])).toBeGreaterThan(100);

    expect(live().startBinding?.elementId).toBe("r1");
    expect(live().endBinding?.elementId).toBe("r2");
  });
});
