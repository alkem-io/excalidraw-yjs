import * as Y from "yjs";

import {
  bindBindingElement,
  newArrowElement,
  newTextElement,
  redrawTextBoundingBox,
  Scene,
  setCustomTextMetricsProvider,
  updateBoundElements,
} from "@excalidraw-yjs/element";

import { pointFrom } from "@excalidraw-yjs/math";

import type { ExcalidrawTextElement } from "@excalidraw-yjs/element/types";

import { prepareSemanticBatch } from "../../element/src/semanticBatch";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { UI } from "./helpers/ui";
import { act, render } from "./test-utils";

const metrics = { getLineWidth: (text: string) => text.length * 10 };

describe("standalone semantic text alignment matches App text editing", () => {
  it.each(["left", "center", "right"] as const)(
    "preserves the browser edit geometry for %s-aligned text",
    async (textAlign) => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);
      setCustomTextMetricsProvider(metrics);
      const text = newTextElement({
        x: 100,
        y: 100,
        text: "Hi",
        textAlign,
        verticalAlign: "middle",
      });
      API.setElements([text]);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, window.h.app.encodeSceneAsUpdate());
      const before = Y.encodeStateAsUpdate(doc);
      const replacement = "Hello longer world";
      const prepared = prepareSemanticBatch(
        doc,
        [{ op: "setText", elementId: text.id, text: replacement }],
        { textMetricsProvider: metrics },
      );
      expect(prepared.ok).toBe(true);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      if (!prepared.ok) {
        throw new Error("semantic preparation failed");
      }
      Y.applyUpdate(doc, prepared.update);
      const replica = new Scene(null, { doc });

      // Exercise App's actual WYSIWYG input callback, not a geometry oracle.
      await UI.editText(text, replacement);
      const browser = API.getElement(text);
      const actual = replica.getElement(text.id)! as ExcalidrawTextElement;
      expect(actual).toMatchObject({
        x: browser.x,
        y: browser.y,
        width: browser.width,
        height: browser.height,
        text: browser.text,
        originalText: browser.originalText,
        textAlign: browser.textAlign,
        verticalAlign: browser.verticalAlign,
      });
      replica.destroy();
    },
  );

  it.each([
    ...(["left", "center", "right"] as const).flatMap((textAlign) =>
      (["start", "end"] as const).map((endpoint) => ({
        textAlign,
        endpoint,
        fixedWidth: false,
      })),
    ),
    {
      textAlign: "left" as const,
      endpoint: "start" as const,
      fixedWidth: true,
    },
  ])(
    "updates a labelled arrow at the $endpoint endpoint ($textAlign, fixedWidth=$fixedWidth)",
    async ({ textAlign, endpoint, fixedWidth }) => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);
      setCustomTextMetricsProvider(metrics);
      const initialText = newTextElement({
        x: 100,
        y: 100,
        text: "Hi",
        textAlign,
        verticalAlign: "middle",
        autoResize: !fixedWidth,
      });
      const text = fixedWidth ? { ...initialText, width: 80 } : initialText;
      const rectangle = API.createElement({
        type: "rectangle",
        x: 500,
        y: 300,
        width: 100,
        height: 100,
      });
      const from = endpoint === "start" ? text : rectangle;
      const to = endpoint === "end" ? text : rectangle;
      const x = from.x + from.width / 2;
      const y = from.y + from.height / 2;
      const dx = to.x + to.width / 2 - x;
      const dy = to.y + to.height / 2 - y;
      const arrow = newArrowElement({
        type: "arrow",
        x,
        y,
        width: Math.abs(dx),
        height: Math.abs(dy),
        points: [pointFrom(0, 0), pointFrom(dx, dy)],
        endArrowhead: "arrow",
      });
      const label = newTextElement({
        text: "link",
        x,
        y,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: arrow.id,
      });
      API.setElements([text, rectangle, arrow, label]);
      const browserScene = window.h.app.scene;
      act(() => {
        bindBindingElement(arrow, from, "orbit", "start", browserScene);
        bindBindingElement(
          browserScene.getElement(arrow.id)! as typeof arrow,
          to,
          "orbit",
          "end",
          browserScene,
        );
        browserScene.mutateElement(browserScene.getElement(arrow.id)!, {
          boundElements: [{ id: label.id, type: "text" }],
        });
        redrawTextBoundingBox(
          label,
          browserScene.getElement(arrow.id),
          browserScene,
        );
        updateBoundElements(
          browserScene.getElement(text.id)! as typeof text,
          browserScene,
        );
      });
      const doc = new Y.Doc();
      Y.applyUpdate(doc, window.h.app.encodeSceneAsUpdate());
      const before = Y.encodeStateAsUpdate(doc);
      const updates = vi.fn();
      doc.on("update", updates);
      const replacement = fixedWidth
        ? "Hello longer\nworld with height"
        : "Hello longer world";
      const prepared = prepareSemanticBatch(
        doc,
        [{ op: "setText", elementId: text.id, text: replacement }],
        { textMetricsProvider: metrics },
      );
      expect(prepared.ok).toBe(true);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(updates).not.toHaveBeenCalled();
      if (!prepared.ok) {
        throw new Error("semantic preparation failed");
      }
      Y.applyUpdate(doc, prepared.update);
      const replica = new Scene(null, { doc });
      await UI.editText(text, replacement);
      const coldDoc = new Y.Doc();
      Y.applyUpdate(coldDoc, Y.encodeStateAsUpdate(doc));
      const cold = new Scene(null, { doc: coldDoc });
      for (const element of [text, arrow, label]) {
        const expected = API.getElement(element);
        for (const preparedScene of [replica, cold]) {
          const actual = preparedScene.getElement(element.id)!;
          for (const key of [
            "x",
            "y",
            "width",
            "height",
            "points",
            "startBinding",
            "endBinding",
            "boundElements",
            "containerId",
            "text",
            "originalText",
          ] as const) {
            expect(
              (actual as unknown as Record<string, unknown>)[key],
              `${element.type}.${key}`,
            ).toEqual((expected as unknown as Record<string, unknown>)[key]);
          }
        }
      }
      const once = Y.encodeStateAsUpdate(coldDoc);
      Y.applyUpdate(coldDoc, prepared.update);
      expect(Y.encodeStateAsUpdate(coldDoc)).toEqual(once);
      if (fixedWidth) {
        expect(replica.getElement(text.id)!.height).toBeGreaterThan(
          text.height,
        );
      }
      replica.destroy();
      cold.destroy();
    },
  );
});
