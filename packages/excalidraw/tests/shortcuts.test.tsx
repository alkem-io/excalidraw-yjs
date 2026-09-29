import React from "react";

import { KEYS } from "@excalidraw-yjs/common";

import { Excalidraw, MainMenu } from "../index";

import { API } from "./helpers/api";
import { fireEvent, render, toggleMenu, waitFor } from "./test-utils";

describe("shortcuts", () => {
  const pressModifiedDelete = (key: string, target: HTMLElement | Document) =>
    fireEvent.keyDown(target, {
      key,
      [KEYS.CTRL_OR_CMD]: true,
    });

  it.each([KEYS.DELETE, KEYS.BACKSPACE])(
    "deletes only the selected canvas element with the platform modifier and %s",
    async (key) => {
      await render(
        <Excalidraw
          initialData={{
            elements: [
              API.createElement({ type: "rectangle" }),
              API.createElement({ type: "ellipse" }),
            ],
          }}
          handleKeyboardGlobally
        />,
      );

      const [selected, untouched] = window.h.elements;
      API.setSelectedElements([selected]);

      pressModifiedDelete(key, document);

      expect(window.h.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: selected.id, isDeleted: true }),
          expect.objectContaining({ id: untouched.id, isDeleted: false }),
        ]),
      );
      expect(document.querySelector(".confirm-dialog")).toBeNull();
    },
  );

  it.each([KEYS.DELETE, KEYS.BACKSPACE])(
    "does nothing without a canvas selection for the platform modifier and %s",
    async (key) => {
      await render(
        <Excalidraw
          initialData={{ elements: [API.createElement({ type: "rectangle" })] }}
          handleKeyboardGlobally
        />,
      );

      API.setSelectedElements([]);
      pressModifiedDelete(key, document);

      expect(window.h.elements[0].isDeleted).toBe(false);
      expect(document.querySelector(".confirm-dialog")).toBeNull();
    },
  );

  it("leaves native input editing to the browser", async () => {
    await render(
      <Excalidraw
        initialData={{ elements: [API.createElement({ type: "rectangle" })] }}
        handleKeyboardGlobally
      />,
    );

    const input = document.createElement("textarea");
    document.body.append(input);

    try {
      expect(pressModifiedDelete(KEYS.DELETE, input)).toBe(true);
      expect(window.h.elements[0].isDeleted).toBe(false);
      expect(document.querySelector(".confirm-dialog")).toBeNull();
    } finally {
      input.remove();
    }
  });

  it("clears the canvas only through the explicit menu action", async () => {
    const { container } = await render(
      <Excalidraw
        initialData={{ elements: [API.createElement({ type: "rectangle" })] }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
      </Excalidraw>,
    );

    expect(window.h.elements.length).toBe(1);

    toggleMenu(container);
    fireEvent.click(
      container.querySelector('[data-testid="clear-canvas-button"]')!,
    );

    const confirmDialog = document.querySelector(".confirm-dialog")!;
    expect(confirmDialog).not.toBe(null);

    fireEvent.click(confirmDialog.querySelector('[aria-label="Confirm"]')!);

    await waitFor(() => {
      expect(window.h.elements[0].isDeleted).toBe(true);
    });
  });
});
