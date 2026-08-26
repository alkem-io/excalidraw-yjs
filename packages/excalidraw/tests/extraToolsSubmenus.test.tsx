import React from "react";

import { Excalidraw } from "../index";

import { fireEvent, render, screen, waitFor } from "./test-utils";

const openExtraTools = () => {
  fireEvent.click(screen.getByTitle("More tools"));
};

const expectExtraToolsClosed = () => {
  expect(screen.getByTitle("More tools")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
};

const openSubmenu = (name: string) => {
  const trigger = screen.getByText(name).closest("[role='menuitem']");
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger!);
};

const openSubmenuWithKeyboard = (name: string) => {
  const trigger = screen.getByText(name).closest("[role='menuitem']");
  expect(trigger).not.toBeNull();
  fireEvent.focus(trigger!);
  fireEvent.keyDown(trigger!, { key: "ArrowRight" });
};

describe("extra tools submenus", () => {
  it("inserts an emoji through the Radix submenu", async () => {
    await render(<Excalidraw />);

    openExtraTools();
    openSubmenuWithKeyboard("Insert Emoji");
    fireEvent.click(screen.getByRole("button", { name: "Thumbs Up" }));

    await waitFor(() => {
      expect(window.h.elements).toHaveLength(1);
      expect(window.h.elements[0]).toMatchObject({
        type: "text",
        text: "👍",
      });
      expectExtraToolsClosed();
    });
  });

  it("selects an emoji reaction through the Radix submenu", async () => {
    await render(<Excalidraw />);

    openExtraTools();
    openSubmenu("Emoji reactions");
    fireEvent.click(screen.getByRole("button", { name: "👏" }));

    await waitFor(() => {
      expect(window.h.state.activeTool.type).toBe("emojiReaction");
      expectExtraToolsClosed();
    });
  });

  it("starts a countdown through the Radix submenu", async () => {
    const onRequestBroadcastCountdownTimer = vi.fn();
    await render(
      <Excalidraw
        onRequestBroadcastCountdownTimer={onRequestBroadcastCountdownTimer}
      />,
    );

    openExtraTools();
    openSubmenu("Countdown timer");
    fireEvent.click(screen.getByText("Start"));

    await waitFor(() => {
      expect(onRequestBroadcastCountdownTimer).toHaveBeenCalledWith(
        300,
        expect.any(String),
        true,
      );
      expectExtraToolsClosed();
    });
  });
});
