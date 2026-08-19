import { vi } from "vitest";
import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { CaptureUpdateAction } from "@excalidraw-yjs/element";

import { actionLoadScene } from "../actions/actionExport";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";

import { act, render } from "./test-utils";

const { h } = window;

// `actionLoadScene` opens a file dialog; stub the read so the action itself —
// including its `addElementsFromPasteOrLibrary` + returned-`elements` shape —
// runs for real.
vi.mock("../data", async () => {
  const actual: any = await vi.importActual("../data");
  return { ...actual, loadFromJSON: vi.fn() };
});

/**
 * The load-scene contract.
 *
 * `actionLoadScene` commits the whole load through
 * `app.addElementsFromPasteOrLibrary`, which owns the scene write, files,
 * selection/appState, fit-to-content and the history capture. It returns no
 * `ActionResult` on success, so the load is applied exactly once.
 */
describe("actionLoadScene", () => {
  it("reaches a peer as exactly ONE update", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
    API.setElements([API.createElement({ type: "rectangle", id: "pre" })]);

    const { loadFromJSON } = await import("../data");
    (loadFromJSON as any).mockResolvedValue({
      elements: [
        API.createElement({ type: "rectangle", id: "L1", x: 0, y: 0 }),
        API.createElement({ type: "rectangle", id: "L2", x: 50, y: 0 }),
      ],
      files: {},
      appState: {},
    });

    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());

    const senderUpdates: Uint8Array[] = [];
    const peerStates: number[] = [];
    const detachSender = h.scene.onDocUpdate((u) => {
      senderUpdates.push(u);
      peer.applyRemoteUpdate(u);
    });
    const detachPeer = peer.onUpdate(() => {
      peerStates.push(peer.getElementsIncludingDeleted().length);
    });

    await act(async () => {
      await h.app.actionManager.executeAction(actionLoadScene);
    });

    // Guard: the load must actually have happened, or the count below proves
    // nothing. Ids are NOT asserted — the paste path deliberately regenerates
    // them — so this pins the observable effect: the pre-existing element
    // survives and exactly two elements were added.
    const ids = h.scene.getElementsIncludingDeleted().map((e) => e.id);
    expect(ids).toContain("pre");
    expect(ids).toHaveLength(3);

    // ONE logical load is ONE update on the wire.
    expect(senderUpdates.length).toBe(1);

    detachSender();
    detachPeer();
    peer.destroy();
  });

  it("costs exactly ONE undo", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);

    // Seed through a history-RECORDING path. `API.setElements` writes the scene
    // without a history entry, so an undo would rewind PAST it to the empty
    // initial state — which would make this test pass for the wrong reason,
    // unable to tell "the load took one undo" from "the seed was never undoable".
    act(() => {
      API.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "pre" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    const { loadFromJSON } = await import("../data");
    (loadFromJSON as any).mockResolvedValue({
      elements: [
        API.createElement({ type: "rectangle", id: "L1", x: 0, y: 0 }),
        API.createElement({ type: "rectangle", id: "L2", x: 50, y: 0 }),
      ],
      files: {},
      appState: {},
    });

    await act(async () => {
      await h.app.actionManager.executeAction(actionLoadScene);
    });
    expect(h.scene.getElementsIncludingDeleted()).toHaveLength(3); // guard

    // Undo ONCE. If the load were recorded as more than one history entry, one
    // undo would leave part of it behind.
    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.undo as never,
      );
    });

    const afterUndo = h.scene
      .getElementsIncludingDeleted()
      .filter((e) => !e.isDeleted)
      .map((e) => e.id);

    // ONE load is ONE undo — back to just the pre-existing element.
    expect(afterUndo).toEqual(["pre"]);
  });
});
