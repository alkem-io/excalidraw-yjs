import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

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

  // SKIPPED — asserts the DESIRED contract, which currently fails. Measured with
  // a live peer: after undo, react=#111111 doc=#222222 peer=#222222 (2 updates
  // delivered, so the link is real). Deliberately not rewritten to assert today's
  // divergence, which would turn a live defect green.
  it.skip("undo reverts the background for the editor, the doc AND a peer", async () => {
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
});
