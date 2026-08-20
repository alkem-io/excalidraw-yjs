import { Excalidraw } from "@excalidraw-yjs/excalidraw";
import { actionBindText } from "@excalidraw-yjs/excalidraw/actions/actionBoundText";
import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";
import {
  act,
  render,
  unmountComponent,
} from "@excalidraw-yjs/excalidraw/tests/test-utils";

import type { ExcalidrawElement } from "@excalidraw-yjs/element/types";

const { h } = window;

/**
 * T016f coverage — `actionBindText`'s post-helper re-read.
 *
 * `scene.mutateElement` + `redrawTextBoundingBox` write the CONTAINER's
 * `boundElements` and resized dimensions to the doc, while
 * `pushTextAboveContainer` keeps the stale input-array container entry. The
 * census recorded 25 reached invocations of which 10 differ semantically on
 * `boundElements`.
 *
 * MEASURED — the difference is real but NOT observable, so the site is KEPT:
 *  - instrumented across the whole suite, the container's `boundElements` differs
 *    between the stale entry and the live doc on EVERY reached invocation
 *    (`cont:boundElements`, `id0:boundElements`, …);
 *  - yet removing the re-read leaves the full suite green (1612 passed) and this
 *    scenario byte-identical.
 *
 * The reason is the same as `distribute:77`'s: under the patch route the derived
 * diff compares the result against the INVOCATION BASE, and the container's
 * stale entry equals that base — so no key is declared for it, nothing is
 * written, and the helper's doc value survives untouched.
 */
describe("bindText: the container's doc-written binding", () => {
  beforeEach(async () => {
    unmountComponent();
    await render(<Excalidraw handleKeyboardGlobally />);
  });

  it("keeps the container bound to its text", () => {
    const container = API.createElement({
      type: "rectangle",
      id: "cont",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    const text = API.createElement({
      type: "text",
      id: "txt",
      x: 10,
      y: 10,
      text: "hello",
    });
    API.setElements([container, text]);
    API.setSelectedElements([container, text]);

    const live = (id: string) =>
      h.elements.find((e) => e.id === id) as ExcalidrawElement;

    act(() => {
      h.app.actionManager.executeAction(actionBindText);
    });

    // The observable contract of the action, which holds on both branches.
    expect(
      (live("cont") as never as { boundElements?: { id: string }[] })
        .boundElements,
    ).toEqual([{ id: "txt", type: "text" }]);
    expect((live("txt") as never as { containerId?: string }).containerId).toBe(
      "cont",
    );
  });
});
