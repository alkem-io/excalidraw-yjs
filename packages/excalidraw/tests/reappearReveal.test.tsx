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
 * INV-REVEAL lives in the STORE case below, not in the Scene or peer cases. The
 * Scene and a peer converge regardless of the reseeded version, so asserting on
 * them cannot detect a version-seeding defect at all — only the Store applies the
 * `prevElement.version < nextElement.version` gate that the reseed has to clear.
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

  it("the STORE re-detects the reappearing element, not just the Scene", async () => {
    // The Store is the observation surface that matters here. On a destructive
    // removal it synthesizes an `isDeleted:true` tombstone at `version + 1` and
    // RETAINS it in `store.elements` (store.ts:924). On reappearance it accepts
    // the element only when `prevElement.version < nextElement.version`
    // (store.ts:937) — so an equal version leaves the Store holding the
    // tombstone while the Scene and any peer look perfectly correct.
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
    act(() => {
      h.app.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "keep" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    // GUARD: the Store really is holding a tombstone for it, or the assertion
    // below proves nothing.
    expect(h.store.snapshot.elements.get("dropped")?.isDeleted).toBe(true);

    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.undo as never,
      );
    });

    // The Store must agree the element is live again.
    expect(h.store.snapshot.elements.get("dropped")?.isDeleted).toBe(false);
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
