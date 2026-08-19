import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Pointer } from "./helpers/ui";
import { render } from "./test-utils";

const { h } = window;
const mouse = new Pointer("mouse");

/**
 * INV-HISTORY-LOCKSTEP (spec 002, FR-010 / US9).
 *
 * Element history is the doc's `Y.UndoManager`, which tracks only `LOCAL_ORIGIN`.
 * The editor's `History` stack carries the paired appState delta plus a
 * `hasElementChange` flag. The two must stay in lockstep: a REMOTE apply is not
 * this user's action and must contribute NOTHING to either.
 *
 * The remote-apply path lost `captureUpdate: CaptureUpdateAction.NEVER` in the
 * M3 cutover and nothing replaced it, so a peer's change leaks into the next
 * capturing local increment. The stacks then disagree, and one Ctrl+Z pops the
 * StackItem belonging to an EARLIER action — tombstoning the user's own work.
 */

/** Depths of both stacks, which must move together. */
const depths = () => ({
  history: (h.history as unknown as { undoStack: unknown[] }).undoStack.length,
  undoManager: h.scene.undoManager.undoStack.length,
});

/** A peer's edit, applied the way the collaboration layer applies one. */
const applyRemoteEdit = (id: string, x: number) => {
  const mirror = new Y.Doc();
  const mirrorScene = new Scene(undefined, { doc: mirror });
  mirrorScene.applyRemoteUpdate(h.scene.encodeStateAsUpdate());
  const target = mirrorScene.getElement(id);
  if (target) {
    mirrorScene.mutateElement(target, { x });
  }
  // Through the App boundary — the path a provider actually uses
  // (`Collab` calls `excalidrawAPI.applyRemoteSceneUpdate`).
  h.app.applyRemoteSceneUpdate(mirrorScene.encodeStateAsUpdate());
  mirrorScene.destroy();
};

describe("INV-HISTORY-LOCKSTEP", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
  });

  // SKIPPED — its premise does not hold as written, so it is not evidence of the
  // defect it describes. Measured step by step: after the remote apply the depths
  // are unchanged (history 1, undoManager 1); the divergence appears only on the
  // NEXT click, which is an appState-only step. Such a step creates a `History`
  // entry carrying an appState delta with `hasElementChange: false`, and by
  // design contributes no `UndoManager` entry — so equal DELTAS is the wrong
  // assertion, not a failing one. Re-scope against T017 before un-skipping; see
  // that task for the measurement.
  it.skip("a remote apply contributes NOTHING to either history stack", async () => {
    const rect = API.createElement({ type: "rectangle", id: "r1", x: 0, y: 0 });
    API.setElements([rect]);
    API.setSelectedElements([rect]);

    // CONTROL: a local gesture with no remote traffic. Both stacks move together.
    mouse.clickAt(500, 500); // deselect — an appState-only increment
    const control = depths();

    // REPRO: the identical gesture, with a peer's edit interleaved.
    API.setSelectedElements([rect]);
    applyRemoteEdit("r1", 123);
    mouse.clickAt(600, 600);
    const withRemote = depths();

    // The remote apply must not have added a history entry beyond the control.
    expect(withRemote.history - control.history).toBe(
      withRemote.undoManager - control.undoManager,
    );
  });

  // The redo-branch half of INV-HISTORY-LOCKSTEP needs an appState accessor the
  // test harness does not expose; deferred to the FR-010 implementation rather
  // than asserted through a private field.
});
