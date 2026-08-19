import * as Y from "yjs";

import { CaptureUpdateAction, Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

/**
 * INV-HISTORY-LOCKSTEP (spec 002, FR-010 / US9).
 *
 * A peer's change is not this user's action, so it must never become something
 * this user can undo.
 *
 * Stated behaviourally rather than as stack depths. `History` and the
 * `UndoManager` legitimately hold different numbers of entries — an
 * appState-only step creates a `History` entry with `hasElementChange: false`
 * and no `UndoManager` item at all — so equal depths is not the contract and
 * asserting it would fail for a correct editor.
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

describe("a remote apply is not locally undoable", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
  });

  it("adds no undoable step, and a later local undo leaves it intact", async () => {
    const rect = API.createElement({ type: "rectangle", id: "r1", x: 0, y: 0 });
    API.setElements([rect]);
    API.setSelectedElements([rect]);

    // A local edit, so there IS something undoable — otherwise "undo does not
    // touch the remote change" could pass with nothing to undo at all.
    act(() => {
      h.app.updateScene({
        elements: [
          ...h.elements,
          API.createElement({ type: "rectangle", id: "local-1" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });
    const before = depths();
    expect(before.undoManager).toBeGreaterThan(0); // guard

    // The peer's edit, through the boundary a provider actually uses.
    applyRemoteEdit("r1", 123);
    const after = depths();

    // GUARD: the remote change really landed.
    expect(h.scene.getElement("r1")!.x).toBe(123);
    // ...and it created nothing to undo, on either stack.
    expect(after.undoManager).toBe(before.undoManager);
    expect(after.history).toBe(before.history);

    // One undo removes the LOCAL element and leaves the peer's change standing.
    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.undo as never,
      );
    });

    expect(
      h.elements.filter((e) => !e.isDeleted).map((e) => e.id),
    ).not.toContain("local-1");
    expect(h.scene.getElement("r1")!.x).toBe(123);
  });
});
