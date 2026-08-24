import { pointFrom } from "@excalidraw-yjs/math";
import { bindBindingElement } from "@excalidraw-yjs/element";
import { Excalidraw } from "@excalidraw-yjs/excalidraw";
import { actionAlignTop } from "@excalidraw-yjs/excalidraw/actions/actionAlign";
import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";
import {
  act,
  render,
  unmountComponent,
} from "@excalidraw-yjs/excalidraw/tests/test-utils";

import type {
  ExcalidrawBindableElement,
  ExcalidrawArrowElement,
} from "@excalidraw-yjs/element/types";

const { h } = window;

/**
 * T016f coverage gap — `actionAlign`'s post-helper re-read.
 *
 * That fallback (`updatedElementsMap.get(id) ?? freshMap.get(id) ?? element`)
 * is reachable ONLY for elements absent from `updatedElements`, i.e. a bound
 * arrow that moved through the doc via `updateBoundElements` while not itself
 * being selected. No existing test had that shape, so the site was recorded as
 * NEVER REACHED — unknown, not clean. This reaches it.
 */
describe("align: a bound but UNSELECTED arrow", () => {
  beforeEach(async () => {
    unmountComponent();
    await render(<Excalidraw handleKeyboardGlobally />);
  });

  it("keeps the arrow's doc-written geometry when the bindables are aligned", () => {
    const rect1 = API.createElement({
      type: "rectangle",
      id: "r1",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }) as ExcalidrawBindableElement;
    const rect2 = API.createElement({
      type: "rectangle",
      id: "r2",
      x: 300,
      y: 200,
      width: 100,
      height: 100,
    }) as ExcalidrawBindableElement;
    const arrow = API.createElement({
      type: "arrow",
      id: "arr",
      x: 100,
      y: 50,
      width: 200,
      height: 200,
      points: [pointFrom(0, 0), pointFrom(200, 200)],
    }) as ExcalidrawArrowElement;

    API.setElements([rect1, rect2, arrow]);
    bindBindingElement(arrow, rect1, "orbit", "start", h.scene);
    bindBindingElement(arrow, rect2, "orbit", "end", h.scene);

    const live = () =>
      h.elements.find((e) => e.id === "arr") as ExcalidrawArrowElement;

    // GUARD: the arrow really is bound, and it is NOT part of the selection —
    // that is the only shape which reaches the re-read fallback.
    expect(live().startBinding?.elementId).toBe("r1");
    expect(live().endBinding?.elementId).toBe("r2");
    API.setSelectedElements([rect1, rect2]);
    expect(Object.keys(h.state.selectedElementIds).sort()).toEqual([
      "r1",
      "r2",
    ]);

    const before = { y: live().y, points: JSON.stringify(live().points) };

    act(() => {
      h.app.actionManager.executeAction(actionAlignTop);
    });

    // The align really happened.
    expect(h.elements.find((e) => e.id === "r2")!.y).toBe(
      h.elements.find((e) => e.id === "r1")!.y,
    );

    // The arrow followed its bindables through the doc. If the action's result
    // reverted it to the pre-align input entry, geometry would be unchanged.
    const after = { y: live().y, points: JSON.stringify(live().points) };
    expect(`${after.y}|${after.points}`).not.toBe(
      `${before.y}|${before.points}`,
    );

    // DISCRIMINATING: both bindables now sit at the same y, so the arrow that
    // connects them must have been re-routed FLAT by the helper. Taking the
    // action's own (pre-align) entry instead leaves it on its original diagonal
    // — measured: `applied` gives points [[0,0],[188,0]], `result` gives
    // [[0,0],[188,188]]. This is what makes the ownership choice observable
    // rather than merely "something changed".
    const pts = live().points;
    expect(Math.abs(pts[pts.length - 1][1] - pts[0][1])).toBeLessThan(1);

    // ...and it is still bound to both.
    expect(live().startBinding?.elementId).toBe("r1");
    expect(live().endBinding?.elementId).toBe("r2");
  });
});
