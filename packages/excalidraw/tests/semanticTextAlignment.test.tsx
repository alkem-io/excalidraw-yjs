import * as Y from "yjs";

import {
  newTextElement,
  Scene,
  setCustomTextMetricsProvider,
} from "@excalidraw-yjs/element";

import type { ExcalidrawTextElement } from "@excalidraw-yjs/element/types";

import { prepareSemanticBatch } from "../../element/src/semanticBatch";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { UI } from "./helpers/ui";
import { render } from "./test-utils";

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
});
