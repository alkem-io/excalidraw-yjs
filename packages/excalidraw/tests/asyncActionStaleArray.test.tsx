import * as Y from "yjs";
import { vi } from "vitest";

import { CaptureUpdateAction, Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

// The clipboard write is the awaited call in actionCopyElementLink; make it
// reject so the catch path runs, and land a remote change while it is pending.
let onClipboardWrite: (() => void) | null = null;
vi.mock("../clipboard", async () => {
  const actual: any = await vi.importActual("../clipboard");
  return {
    ...actual,
    copyTextToSystemClipboard: async () => {
      onClipboardWrite?.();
      throw new Error("clipboard unavailable");
    },
  };
});

/**
 * T016d — an async action that returns its INVOCATION-time element array can
 * revert work that landed while it was awaiting.
 *
 * `actionCopyElementLink.perform` is async and awaits the clipboard write. Its
 * catch path then returns `elements` — the array captured at invocation — so
 * anything that reached the doc during the await is overwritten when
 * `syncActionResult` applies that array.
 */
describe("async actions must not return their invocation-time array", () => {
  it("a remote change landing during the await survives the catch path", async () => {
    const { actionCopyElementLink } = await import(
      "../actions/actionElementLink"
    );
    await render(<Excalidraw />);

    act(() => {
      h.app.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "a", x: 0 })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });
    API.setSelectedElements([h.elements[0]]);

    // A peer's edit, delivered while the clipboard promise is in flight.
    onClipboardWrite = () => {
      const peer = new Scene(undefined, { doc: new Y.Doc() });
      peer.applyRemoteUpdate(h.app.encodeSceneAsUpdate());
      const target = peer.getElement("a");
      if (target) {
        peer.mutateElement(target, { y: 777 });
      }
      h.app.applyRemoteSceneUpdate(peer.encodeStateAsUpdate());
      peer.destroy();
    };

    await act(async () => {
      await h.app.actionManager.executeAction(actionCopyElementLink as never);
    });
    onClipboardWrite = null;

    // GUARD: the remote change really was applied mid-action.
    expect(h.elements.find((e) => e.id === "a")).toBeDefined();

    // The peer's edit must survive the action's result application.
    expect(h.elements.find((e) => e.id === "a")!.y).toBe(777);
  });
});
