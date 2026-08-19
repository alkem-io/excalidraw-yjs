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
 * T016n — `actionLoadScene` applies the same membership TWICE.
 *
 * `perform` calls `app.addElementsFromPasteOrLibrary(...)`, which commits the
 * loaded elements to the doc, and THEN returns `elements:
 * app.scene.getNonDeletedElements()`, so `syncActionResult` plans and applies
 * that same membership a second time.
 *
 * MEASURED: the second application has NO observable consequence today —
 * `senderUpdates=1` (the FR-017 logical boundary collapses it) and one load
 * costs exactly one undo. So this is a redundant pass and a LATENT hazard, not
 * a live defect: it is a no-op only because the returned array is a FRESH read
 * of the doc. The day that read becomes a captured/stale array, this is exactly
 * the revert class. These two tests are the regression pins for that.
 */
describe("T016n — actionLoadScene double application", () => {
  it("MEASUREMENT: how many transport updates one load emits", async () => {
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

    // Guard: the load must actually have happened, or the counts below prove
    // nothing about a double application. Ids are NOT asserted — the paste path
    // deliberately regenerates them — so this pins the observable effect instead:
    // the pre-existing element survives and exactly two elements were added.
    const ids = h.scene.getElementsIncludingDeleted().map((e) => e.id);
    expect(ids).toContain("pre");
    expect(ids).toHaveLength(3);

    // The contract: ONE logical load is ONE update on the wire.
    expect(senderUpdates.length).toBe(1);

    detachSender();
    detachPeer();
    peer.destroy();
  });

  it("MEASUREMENT: does one load cost more than one undo?", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);

    // Seed through a history-RECORDING path. `API.setElements` writes the scene
    // without a history entry, so an undo would rewind PAST it to the empty
    // initial state and the measurement below could not tell "the load took two
    // undos" apart from "the seed was never undoable".
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

    // Undo ONCE. If the load applied its membership twice as two recorded
    // history entries, one undo leaves some of the load behind.
    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.undo as never,
      );
    });

    const afterUndo = h.scene
      .getElementsIncludingDeleted()
      .filter((e) => !e.isDeleted)
      .map((e) => e.id);

    // The contract: ONE load is ONE undo — back to just the pre-existing element.
    expect(afterUndo).toEqual(["pre"]);
  });
});
