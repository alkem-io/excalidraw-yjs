import * as Y from "yjs";

import { CaptureUpdateAction, Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

const liveIds = () =>
  h.elements
    .filter((e) => !e.isDeleted)
    .map((e) => e.id)
    .sort();

/**
 * Reappearance after a destructive replace converges — locally and at a peer.
 *
 * NOTE ON SCOPE: these do NOT cover INV-REVEAL. That invariant is about the
 * version the Scene reseeds for an element whose `meta` was lost, needing to
 * land strictly above the `isDeleted:true` tombstone the editor Store synthesized
 * at `version + 1`. Sabotage proves this path does not exercise it: pinning the
 * reseed to a constant, or to a value equal to the tombstone, leaves both cases
 * green. The element returns by a route that does not depend on the high-water
 * mark, so a reproduction for INV-REVEAL still has to be found.
 */
describe("reappearance after a destructive replace converges", () => {
  it("undoing a destructive replace makes the element visible again", async () => {
    await render(<Excalidraw />);

    act(() => {
      h.app.updateScene({
        elements: [
          API.createElement({ type: "rectangle", id: "keep" }),
          API.createElement({ type: "rectangle", id: "dropped" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });
    expect(liveIds()).toEqual(["dropped", "keep"]); // guard

    // A destructive replace: "dropped" is removed from the set entirely, so its
    // Scene `meta` goes with it and the Store synthesizes a tombstone.
    act(() => {
      h.app.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "keep" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });
    expect(liveIds()).toEqual(["keep"]); // guard: it really went

    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.undo as never,
      );
    });

    // The element must be BACK — observable state, not a version counter.
    expect(liveIds()).toEqual(["dropped", "keep"]);
  });

  it("a peer converges on the restored element", async () => {
    await render(<Excalidraw />);
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.app.encodeSceneAsUpdate());
    let delivered = 0;
    const detach = h.app.onLocalSceneUpdate((u) => {
      delivered++;
      peer.applyRemoteUpdate(u);
    });

    try {
      act(() => {
        h.app.updateScene({
          elements: [
            API.createElement({ type: "rectangle", id: "keep" }),
            API.createElement({ type: "rectangle", id: "dropped" }),
          ],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });
      act(() => {
        h.app.updateScene({
          elements: [API.createElement({ type: "rectangle", id: "keep" })],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });
      act(() => {
        h.app.actionManager.executeAction(
          h.app.actionManager.actions.undo as never,
        );
      });

      expect(delivered).toBeGreaterThan(0); // non-vacuity: the link is real
      const peerLive = peer
        .getElementsIncludingDeleted()
        .filter((e) => !e.isDeleted)
        .map((e) => e.id)
        .sort();
      expect(peerLive).toEqual(liveIds());
      expect(peerLive).toContain("dropped");
    } finally {
      detach();
      peer.destroy();
    }
  });
});
