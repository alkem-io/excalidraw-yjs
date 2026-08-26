import React from "react";

import { Excalidraw } from "../index";

import { act, fireEvent, render, screen, waitFor, within } from "./test-utils";

const openExtraToolsWithKeyboard = () => {
  const trigger = screen.getByTitle("More tools");
  fireEvent.focus(trigger);
  fireEvent.keyDown(trigger, { key: "Enter" });
};

const expectExtraToolsClosed = () => {
  expect(screen.getByTitle("More tools")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
};

const openSubmenuWithKeyboard = (name: string) => {
  const trigger = screen.getByText(name).closest("[role='menuitem']");
  expect(trigger).not.toBeNull();
  fireEvent.focus(trigger!);
  fireEvent.keyDown(trigger!, { key: "ArrowRight" });
};

const focusFirstSubmenuItem = () => {
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
};

const renderPhone = async (props: React.ComponentProps<typeof Excalidraw>) =>
  render(
    <Excalidraw
      {...props}
      UIOptions={{
        ...props.UIOptions,
        getFormFactor: () => "phone",
      }}
    />,
  );

describe("extra tools submenus", () => {
  it("inserts an emoji through the Radix submenu", async () => {
    await render(<Excalidraw />);

    openExtraToolsWithKeyboard();
    openSubmenuWithKeyboard("Insert Emoji");
    focusFirstSubmenuItem();
    expect(document.activeElement).toHaveAccessibleName("Thumbs Up");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });

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

    openExtraToolsWithKeyboard();
    openSubmenuWithKeyboard("Emoji reactions");
    focusFirstSubmenuItem();
    expect(document.activeElement).toHaveAccessibleName("👍");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });

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

    openExtraToolsWithKeyboard();
    openSubmenuWithKeyboard("Countdown timer");

    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    const minutes = screen.getByRole("spinbutton", { name: "Min" });
    expect(document.activeElement).toBe(minutes);
    fireEvent.keyDown(minutes, { key: "ArrowUp" });
    expect(minutes).toHaveValue(6);

    fireEvent.keyDown(minutes, { key: "Tab" });
    const seconds = screen.getByRole("spinbutton", { name: "Sec" });
    expect(document.activeElement).toBe(seconds);
    fireEvent.keyDown(seconds, { key: "ArrowUp" });
    expect(seconds).toHaveValue(1);

    fireEvent.keyDown(seconds, { key: "Tab" });
    expect(document.activeElement).toHaveAccessibleName("Start");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });

    await waitFor(() => {
      expect(onRequestBroadcastCountdownTimer).toHaveBeenCalledWith(
        361,
        expect.any(String),
        true,
      );
      expectExtraToolsClosed();
    });
  });

  it("keeps the phone reaction submenu clickable, closable, and dismissible", async () => {
    const onRequestBroadcastEmojiReaction = vi.fn();
    const { container } = await renderPhone({
      isCollaborating: true,
      onRequestBroadcastEmojiReaction,
    });

    fireEvent.click(screen.getByTitle("More tools"));
    fireEvent.click(screen.getByText("Emoji reactions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "👏" }));

    await waitFor(() => {
      expect(window.h.state.activeTool.type).toBe("emojiReaction");
      expectExtraToolsClosed();
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });
    act(() => {
      fireEvent.pointerDown(container.querySelector(".reaction-overlay")!, {
        button: 0,
        clientX: 100,
        clientY: 120,
        pointerId: 1,
      });
    });
    expect(onRequestBroadcastEmojiReaction).toHaveBeenCalledWith(
      "👏",
      expect.any(Number),
      expect.any(Number),
    );

    fireEvent.click(screen.getByTitle("More tools"));
    expect(screen.getByRole("menu", { name: "More tools" })).toBeVisible();
    fireEvent.pointerDown(container.querySelector("canvas.interactive")!);
    await waitFor(expectExtraToolsClosed);
  });

  it("keeps the phone countdown submenu clickable and closes after start", async () => {
    const onRequestBroadcastCountdownTimer = vi.fn();
    const { container } = await renderPhone({
      onRequestBroadcastCountdownTimer,
    });

    fireEvent.click(screen.getByTitle("More tools"));
    fireEvent.click(screen.getByText("Countdown timer"));
    fireEvent.click(screen.getByText("Start"));

    await waitFor(() => {
      expect(onRequestBroadcastCountdownTimer).toHaveBeenCalledWith(
        300,
        expect.any(String),
        true,
      );
      expectExtraToolsClosed();
    });

    fireEvent.click(screen.getByTitle("More tools"));
    expect(
      within(screen.getByRole("menu", { name: "More tools" })).getByText(
        "Countdown timer",
      ),
    ).toBeVisible();
    fireEvent.pointerDown(container.querySelector("canvas.interactive")!);
    await waitFor(expectExtraToolsClosed);
  });
});
