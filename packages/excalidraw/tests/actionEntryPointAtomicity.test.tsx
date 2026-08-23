import React from "react";

import { Scene } from "@excalidraw-yjs/element";
import * as Y from "yjs";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, fireEvent, render } from "./test-utils";

const { h } = window;

/**
 * FR-017 on the KEYBOARD entry point.
 *
 * Scope note, because the fix is deliberately partial: these tests cover
 * `handleKeyDown` only. `renderAction`'s `updateData` still lacks the boundary
 * and is NOT asserted here — wrapping it regresses 10 `textWysiwyg` tests, so
 * that gap is held open on purpose rather than closed with a regression
 * attached.
 *
 * `ActionManager` has three ways to run an action:
 *
 *   executeAction   — API / context menu.  Opens the logical-mutation boundary
 *                     AND the mutation journal.
 *   handleKeyDown   — keyboard shortcuts.  Opened neither; FIXED, tested below.
 *   renderAction    — panel `updateData`.  Opens neither. STILL OPEN.
 *
 * All three already captured `invocationBase`, so the derived-intent diff was
 * intact; what the latter two lacked was the transport boundary (so a peer saw
 * one message per internal Scene write instead of one per action) and the
 * journal (so `applyElementChanges` skipped its whole ambiguity block — it is
 * guarded on `alreadyAppliedIntent?.size`, and an unopened journal is size 0,
 * which silently discards every `overlapPolicy` an action declared).
 *
 * Flip is the probe: it is one of the few actions carrying a `keyTest`, it does
 * many Scene writes during `perform` (a multi-element resize plus the
 * re-centering pass), and it declares an `overlapPolicy`.
 *
 * NOTE `actionFlipHorizontal.keyTest` is `event.shiftKey && event.code === CODES.H`
 * and the shared `Keyboard` helper dispatches only `key`, never `code` — using it
 * here would fire nothing at all and every assertion below would pass vacuously.
 */

const flipHorizontallyByKeyboard = () => {
  act(() => {
    fireEvent.keyDown(document, { key: "H", code: "KeyH", shiftKey: true });
  });
};

describe("FR-017 holds on the keyboard entry point (panel path still open)", () => {
  it("a keyboard-dispatched action is ONE transport message", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);

    const rect = API.createElement({
      type: "rectangle",
      id: "r1",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const arrow = API.createElement({
      type: "arrow",
      id: "a1",
      x: 200,
      y: 0,
      width: 150,
      height: 80,
      points: [
        [0, 0],
        [150, 80],
      ],
    } as never);

    API.setElements([rect, arrow]);
    API.setSelectedElements([
      h.scene.getElement("r1")!,
      h.scene.getElement("a1")!,
    ]);

    // A peer synced to the pre-action state, linked BEFORE the action runs.
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());

    const senderUpdates: Uint8Array[] = [];
    let peerStates = 0;
    const detachSender = h.scene.onDocUpdate((u) => {
      senderUpdates.push(u);
      peer.applyRemoteUpdate(u);
    });
    const detachPeer = peer.onUpdate(() => {
      peerStates += 1;
    });

    flipHorizontallyByKeyboard();

    detachSender();
    detachPeer();

    // GUARD — without this a green result could mean "the shortcut never fired",
    // which is exactly how this test would go vacuous.
    expect(senderUpdates.length).toBeGreaterThan(0);

    // THE CONTRACT: one logical mutation reaches peers as ONE transport message,
    // regardless of which entry point dispatched the action.
    expect(senderUpdates.length).toBe(1);
    expect(peerStates).toBe(1);

    peer.destroy();
  });

  it("the peer converges on the sender's exact geometry", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);

    const rect = API.createElement({
      type: "rectangle",
      id: "r2",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const arrow = API.createElement({
      type: "arrow",
      id: "a2",
      x: 200,
      y: 0,
      width: 150,
      height: 80,
      points: [
        [0, 0],
        [150, 80],
      ],
    } as never);

    API.setElements([rect, arrow]);
    API.setSelectedElements([
      h.scene.getElement("r2")!,
      h.scene.getElement("a2")!,
    ]);

    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());
    const detach = h.scene.onDocUpdate((u) => peer.applyRemoteUpdate(u));

    flipHorizontallyByKeyboard();
    detach();

    for (const id of ["r2", "a2"]) {
      const mine = h.scene.getElement(id) as unknown as {
        x: number;
        y: number;
      };
      const theirs = peer.getElement(id) as unknown as {
        x: number;
        y: number;
      };
      expect(theirs.x).toBeCloseTo(mine.x, 5);
      expect(theirs.y).toBeCloseTo(mine.y, 5);
    }

    peer.destroy();
  });
});
