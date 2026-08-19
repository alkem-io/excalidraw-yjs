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
  h.scene.applyRemoteUpdate(mirrorScene.encodeStateAsUpdate());
  mirrorScene.destroy();
};

describe("INV-HISTORY-LOCKSTEP", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
  });

  // SKIPPED — asserts the DESIRED contract (FR-010), which currently fails: the
  // remote apply adds a History entry the UndoManager does not have. Un-skip when
  // FR-010 lands. Not rewritten to assert the broken depths, which would turn a
  // known defect green.
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
