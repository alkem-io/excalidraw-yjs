import React from "react";
import { vi } from "vitest";

import { KEYS } from "@excalidraw-yjs/common";

import { Excalidraw, MainMenu } from "../index";
import { t } from "../i18n";

import { API } from "./helpers/api";
import { fireEvent, render, toggleMenu, waitFor } from "./test-utils";

vi.mock("@excalidraw-yjs/common", async (importOriginal) => {
  const common = await importOriginal<
    typeof import("@excalidraw-yjs/common")
  >();

  return {
    ...common,
    isDarwin: false,
    KEYS: { ...common.KEYS, CTRL_OR_CMD: "ctrlKey" },
  };
});

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

  it("delegates modified delete to grouped selection and its undo history", async () => {
    await render(
      <Excalidraw
        initialData={{
          elements: [
            API.createElement({ type: "rectangle", groupIds: ["group"] }),
            API.createElement({ type: "ellipse", groupIds: ["group"] }),
            API.createElement({ type: "diamond" }),
          ],
        }}
        handleKeyboardGlobally
      />,
    );

    const [first, second, ungrouped] = window.h.elements;
    API.setSelectedElements([first, second]);

    pressModifiedDelete(KEYS.DELETE, document);

    expect(window.h.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, isDeleted: true }),
        expect.objectContaining({ id: second.id, isDeleted: true }),
        expect.objectContaining({ id: ungrouped.id, isDeleted: false }),
      ]),
    );

    fireEvent.keyDown(document, {
      key: KEYS.Z,
      [KEYS.CTRL_OR_CMD]: true,
    });

    expect(window.h.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, isDeleted: false }),
        expect.objectContaining({ id: second.id, isDeleted: false }),
        expect.objectContaining({ id: ungrouped.id, isDeleted: false }),
      ]),
    );
  });

  it("delegates modified delete to binding cleanup", async () => {
    const target = API.createElement({
      type: "rectangle",
      id: "target",
      boundElements: [{ id: "arrow", type: "arrow" }],
    });
    const arrow = API.createElement({
      type: "arrow",
      id: "arrow",
      startBinding: {
        elementId: target.id,
        fixedPoint: [0.5, 0.5],
        mode: "orbit",
      },
    });

    await render(
      <Excalidraw
        initialData={{ elements: [target, arrow] }}
        handleKeyboardGlobally
      />,
    );

    API.setSelectedElements([window.h.elements[0]]);
    pressModifiedDelete(KEYS.BACKSPACE, document);

    expect(window.h.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: target.id, isDeleted: true }),
        expect.objectContaining({
          id: arrow.id,
          isDeleted: false,
          startBinding: null,
        }),
      ]),
    );
  });

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

  it.each([KEYS.DELETE, KEYS.BACKSPACE])(
    "leaves native input editing to the browser for Control+%s",
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
      const input = document.createElement("textarea");
      document.body.append(input);
      input.focus();

      try {
        expect(pressModifiedDelete(key, input)).toBe(true);
        expect(window.h.elements[0].isDeleted).toBe(false);
        expect(document.querySelector(".confirm-dialog")).toBeNull();
      } finally {
        input.remove();
      }
    },
  );

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

  it("does not advertise modified delete as a clear-canvas shortcut", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);

    fireEvent.keyDown(document, { key: KEYS.QUESTION_MARK });

    await waitFor(() => {
      const helpDialog = document.querySelector(".HelpDialog");
      expect(helpDialog).not.toBeNull();
      expect(helpDialog).not.toHaveTextContent(t("buttons.clearReset"));
    });
  });
});
