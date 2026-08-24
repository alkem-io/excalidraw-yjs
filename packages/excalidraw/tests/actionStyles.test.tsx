import React from "react";

import { CODES } from "@excalidraw-yjs/common";

import { copiedStyles } from "../actions/actionStyles";
import { Excalidraw } from "../index";
import { API } from "../tests/helpers/api";
import { Keyboard, Pointer, UI } from "../tests/helpers/ui";
import {
  act,
  fireEvent,
  render,
  screen,
  togglePopover,
} from "../tests/test-utils";

const { h } = window;

const mouse = new Pointer("mouse");

describe("actionStyles", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  afterEach(async () => {
    // https://github.com/floating-ui/floating-ui/issues/1908#issuecomment-1301553793
    // affects node v16+
    await act(async () => {});
  });

  it("should copy & paste styles via keyboard", async () => {
    UI.clickTool("rectangle");
    mouse.down(10, 10);
    mouse.up(20, 20);

    UI.clickTool("rectangle");
    mouse.down(10, 10);
    mouse.up(20, 20);

    // Change some styles of second rectangle
    togglePopover("Stroke");
    UI.clickOnTestId("color-red");
    togglePopover("Background");
    UI.clickOnTestId("color-blue");
    // Fill style
    fireEvent.click(screen.getByTitle("Cross-hatch"));
    // Stroke width
    fireEvent.click(screen.getByTitle("Bold"));
    // Stroke style
    fireEvent.click(screen.getByTitle("Dotted"));
    // Roughness
    fireEvent.click(screen.getByTitle("Cartoonist"));
    // Opacity
    fireEvent.change(screen.getByTestId("opacity"), {
      target: { value: "60" },
    });

    mouse.reset();

    API.setSelectedElements([h.elements[1]]);

    Keyboard.withModifierKeys({ ctrl: true, alt: true }, () => {
      Keyboard.codeDown(CODES.C);
    });
    const secondRect = JSON.parse(copiedStyles)[0];
    expect(secondRect.id).toBe(h.elements[1].id);

    mouse.reset();
    // Paste styles to first rectangle
    API.setSelectedElements([h.elements[0]]);
    Keyboard.withModifierKeys({ ctrl: true, alt: true }, () => {
      Keyboard.codeDown(CODES.V);
    });

    const firstRect = API.getSelectedElement();
    expect(firstRect.id).toBe(h.elements[0].id);
    expect(firstRect.strokeColor).toBe("#e03131");
    expect(firstRect.backgroundColor).toBe("#a5d8ff");
    expect(firstRect.fillStyle).toBe("cross-hatch");
    expect(firstRect.strokeWidth).toBe(2); // Bold: 2
    expect(firstRect.strokeStyle).toBe("dotted");
    expect(firstRect.roughness).toBe(2); // Cartoonist: 2
    expect(firstRect.opacity).toBe(60);
  });

  // Regression: pasting styles onto a bound-text container must apply BOTH the
  // pasted style (background/stroke/...) AND the bound-text redraw geometry.
  // redrawTextBoundingBox resizes the container through the doc as a side
  // effect; the post-mutation fresh re-read must MERGE only the redraw geometry
  // (width/height) onto the styled copy, not replace the styled copy wholesale
  // (which would revert the container's freshly-pasted style).
  it("should paste styles onto a bound-text container without reverting its style", async () => {
    const SOURCE_BG = "#ffc9c9";
    const SOURCE_STROKE = "#1971c2";

    // --- SOURCE: a container with bound text, carrying the distinctive style on
    // the container, and a large font on its bound text so that pasting forces a
    // redraw (and thus a container resize) on the target.
    const sourceContainer = API.createElement({
      type: "rectangle",
      id: "source-container",
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      backgroundColor: SOURCE_BG,
      strokeColor: SOURCE_STROKE,
    });
    const sourceText = API.createElement({
      type: "text",
      id: "source-text",
      containerId: sourceContainer.id,
      fontSize: 36,
      text: "src",
      width: 30,
      height: 36,
    });
    h.app.scene.mutateElement(sourceContainer, {
      boundElements: [{ id: sourceText.id, type: "text" }],
    });

    // --- TARGET: a container with bound text, default style and a small height
    // but long multi-line text, so applying the source font triggers a
    // container height grow via redrawTextBoundingBox.
    const targetContainer = API.createElement({
      type: "rectangle",
      id: "target-container",
      x: 300,
      y: 0,
      width: 100,
      height: 50,
      backgroundColor: "transparent",
      strokeColor: "#1e1e1e",
    });
    const targetText = API.createElement({
      type: "text",
      id: "target-text",
      containerId: targetContainer.id,
      fontSize: 16,
      text: "the quick brown fox jumps over the lazy dog again and again",
      width: 80,
      height: 25,
    });
    h.app.scene.mutateElement(targetContainer, {
      boundElements: [{ id: targetText.id, type: "text" }],
    });

    API.setElements([sourceContainer, sourceText, targetContainer, targetText]);

    const targetHeightBefore = h.elements.find(
      (el) => el.id === targetContainer.id,
    )!.height;

    // Copy styles from the source container (carries its bound text too).
    API.setSelectedElements([sourceContainer]);
    Keyboard.withModifierKeys({ ctrl: true, alt: true }, () => {
      Keyboard.codeDown(CODES.C);
    });
    // Sanity: the copied payload includes the source container + its bound text.
    const copied = JSON.parse(copiedStyles);
    expect(copied[0].id).toBe(sourceContainer.id);
    expect(copied[1]?.containerId).toBe(sourceContainer.id);

    // Paste styles onto the target container AND its bound text (both must be
    // selected so redrawTextBoundingBox can resize the container).
    API.setSelectedElements([targetContainer, targetText]);
    Keyboard.withModifierKeys({ ctrl: true, alt: true }, () => {
      Keyboard.codeDown(CODES.V);
    });

    const pastedContainer = h.elements.find(
      (el) => el.id === targetContainer.id,
    )!;

    // (a) KEY assertion — the container received the PASTED STYLE. Reverting the
    // actionStyles fix makes this fail, because the old code replaces the styled
    // copy with the doc version (new geometry, OLD style).
    expect(pastedContainer.backgroundColor).toBe(SOURCE_BG);
    expect(pastedContainer.strokeColor).toBe(SOURCE_STROKE);

    // (b) The container geometry reflects the bound-text redraw — its height
    // grew to fit the restyled text (the fresh doc value, not the stale copy's).
    expect(pastedContainer.height).toBeGreaterThan(targetHeightBefore);
    expect(pastedContainer.height).toBe(
      h.app.scene.getNonDeletedElementsMap().get(targetContainer.id)!.height,
    );
  });
});
