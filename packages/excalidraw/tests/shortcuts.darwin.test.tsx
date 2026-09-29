import React from "react";
import { vi } from "vitest";

import { KEYS } from "@excalidraw-yjs/common";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { fireEvent, render } from "./test-utils";

vi.mock("@excalidraw-yjs/common", async (importOriginal) => {
  const common = await importOriginal<
    typeof import("@excalidraw-yjs/common")
  >();

  return {
    ...common,
    isDarwin: true,
    KEYS: { ...common.KEYS, CTRL_OR_CMD: "metaKey" },
  };
});

describe("modified delete on Darwin", () => {
  it.each([KEYS.DELETE, KEYS.BACKSPACE])(
    "deletes the selection with Command+%s",
    async (key) => {
      await render(
        <Excalidraw
          initialData={{
            elements: [API.createElement({ type: "rectangle" })],
          }}
          handleKeyboardGlobally
        />,
      );

      API.setSelectedElements([window.h.elements[0]]);
      fireEvent.keyDown(document, { key, metaKey: true });

      expect(window.h.elements[0].isDeleted).toBe(true);
      expect(document.querySelector(".confirm-dialog")).toBeNull();
    },
  );

  it.each([KEYS.DELETE, KEYS.BACKSPACE])(
    "does nothing without a selection for Command+%s",
    async (key) => {
      await render(
        <Excalidraw
          initialData={{
            elements: [API.createElement({ type: "rectangle" })],
          }}
          handleKeyboardGlobally
        />,
      );

      API.setSelectedElements([]);
      fireEvent.keyDown(document, { key, metaKey: true });

      expect(window.h.elements[0].isDeleted).toBe(false);
      expect(document.querySelector(".confirm-dialog")).toBeNull();
    },
  );

  it.each([KEYS.DELETE, KEYS.BACKSPACE])(
    "leaves native input editing to the browser for Command+%s",
    async (key) => {
      await render(
        <Excalidraw
          initialData={{
            elements: [API.createElement({ type: "rectangle" })],
          }}
          handleKeyboardGlobally
        />,
      );

      const input = document.createElement("textarea");
      document.body.append(input);

      try {
        expect(fireEvent.keyDown(input, { key, metaKey: true })).toBe(true);
        expect(window.h.elements[0].isDeleted).toBe(false);
        expect(document.querySelector(".confirm-dialog")).toBeNull();
      } finally {
        input.remove();
      }
    },
  );
});
