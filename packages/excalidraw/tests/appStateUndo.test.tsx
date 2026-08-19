import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { CaptureUpdateAction } from "@excalidraw-yjs/element";

import { actionChangeProjectName } from "../actions/actionExport";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

/**
 * INV-APPSTATE-UNDO — an appState undo/redo writes through to `yAppState`, so the
 * document and React state agree after any subsequent scene update.
 *
 * `viewBackgroundColor` and `name` are the collaborative appState subset: they
 * live in the doc and sync to peers. History restores them into React state, but
 * if that restore never reaches the doc, the doc keeps the pre-undo value — and
 * the next scene update pulls it back through the appState mirror, silently
 * undoing the undo. Peers never see the revert at all.
 */
describe("INV-APPSTATE-UNDO", () => {
  /** Link a peer Scene through the real transport boundary. */
  const linkPeer = () => {
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.app.encodeSceneAsUpdate());
    let delivered = 0;
    const detach = h.app.onLocalSceneUpdate((u) => {
      delivered++;
      peer.applyRemoteUpdate(u);
    });
    return { peer, detach, count: () => delivered };
  };

  const setBackground = (color: string) =>
    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.changeViewBackgroundColor as never,
        "ui",
        { viewBackgroundColor: color } as never,
      );
    });

  it("undo reverts the background for the editor, the doc AND a peer", async () => {
    await render(<Excalidraw />);
    API.setElements([API.createElement({ type: "rectangle", id: "a" })]);

    const { peer, detach, count } = linkPeer();
    try {
      setBackground("#111111");
      setBackground("#222222");

      // The peer must actually be receiving, or every assertion below is vacuous.
      expect(count()).toBeGreaterThan(0);
      expect(h.scene.getPersistedAppState().viewBackgroundColor).toBe(
        "#222222",
      );
      expect(peer.getPersistedAppState().viewBackgroundColor).toBe("#222222");

      act(() => {
        h.app.actionManager.executeAction(
          h.app.actionManager.actions.undo as never,
        );
      });

      // All three must agree on the reverted value.
      expect(h.state.viewBackgroundColor).toBe("#111111");
      expect(h.scene.getPersistedAppState().viewBackgroundColor).toBe(
        "#111111",
      );
      expect(peer.getPersistedAppState().viewBackgroundColor).toBe("#111111");

      // ...and they must still agree after an ordinary element update, which
      // pushes the doc's value back through the appState mirror.
      act(() => {
        API.setElements([
          API.createElement({ type: "rectangle", id: "a" }),
          API.createElement({ type: "rectangle", id: "b" }),
        ]);
      });

      expect(h.state.viewBackgroundColor).toBe("#111111");
      expect(h.scene.getPersistedAppState().viewBackgroundColor).toBe(
        "#111111",
      );
      expect(peer.getPersistedAppState().viewBackgroundColor).toBe("#111111");

      // eslint-disable-next-line no-console
      console.log(
        `[T028] react=${h.state.viewBackgroundColor} doc=${
          h.scene.getPersistedAppState().viewBackgroundColor
        } peer=${
          peer.getPersistedAppState().viewBackgroundColor
        } delivered=${count()}`,
      );
    } finally {
      detach();
      peer.destroy();
    }
  });

  it("REDO re-applies the background for the editor, the doc AND a peer", async () => {
    await render(<Excalidraw />);
    API.setElements([API.createElement({ type: "rectangle", id: "a" })]);
    const { peer, detach, count } = linkPeer();
    try {
      setBackground("#111111");
      setBackground("#222222");
      expect(count()).toBeGreaterThan(0); // non-vacuity

      act(() => {
        h.app.actionManager.executeAction(
          h.app.actionManager.actions.undo as never,
        );
      });
      expect(h.scene.getPersistedAppState().viewBackgroundColor).toBe(
        "#111111",
      );

      act(() => {
        h.app.actionManager.executeAction(
          h.app.actionManager.actions.redo as never,
        );
      });

      expect(h.state.viewBackgroundColor).toBe("#222222");
      expect(h.scene.getPersistedAppState().viewBackgroundColor).toBe(
        "#222222",
      );
      expect(peer.getPersistedAppState().viewBackgroundColor).toBe("#222222");
    } finally {
      detach();
      peer.destroy();
    }
  });

  it("`name` is not independently undoable, so nothing writes through for it", () => {
    // Evidence for narrowing the claim rather than covering it: the
    // `changeProjectName` action returns `CaptureUpdateAction.EVENTUALLY`, so a
    // name change never becomes its own history entry and there is no name undo
    // to propagate. The write-through is keyed off the delta, so it handles
    // `name` if an entry ever carries it — but no action produces one today.
    const result = actionChangeProjectName.perform(
      [] as never,
      { name: "x" } as never,
      "y" as never,
      { scene: { setAppState: () => {} }, getName: () => "y" } as never,
    ) as { captureUpdate: unknown };
    expect(result.captureUpdate).toBe(CaptureUpdateAction.EVENTUALLY);
  });

  it("an element-only undo emits NO appState change", async () => {
    // The write-through must be scoped to what the history entry actually
    // reverted. Writing the whole subset would publish the background on every
    // element undo, and would introduce appState into a doc that never had any.
    await render(<Excalidraw />);
    API.setElements([API.createElement({ type: "rectangle", id: "a" })]);
    setBackground("#111111");

    // A history-RECORDING element change. `API.setElements` assigns `h.elements`
    // directly and records nothing, so an undo after it would pop the BACKGROUND
    // entry and this test would measure the wrong thing.
    act(() => {
      h.app.updateScene({
        elements: [
          API.createElement({ type: "rectangle", id: "a" }),
          API.createElement({ type: "rectangle", id: "b" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    const before = JSON.stringify(h.scene.getPersistedAppState());
    expect(before).toContain("#111111"); // guard: the background IS set
    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.undo as never,
      );
    });

    // The element undo happened...
    expect(h.scene.getElementsIncludingDeleted().length).toBeGreaterThan(0);
    // ...and the collaborative appState is byte-identical, so nothing about it
    // went on the wire.
    expect(JSON.stringify(h.scene.getPersistedAppState())).toBe(before);
  });
});
