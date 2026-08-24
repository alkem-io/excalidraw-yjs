import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { getDefaultAppState } from "../appState";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

const liveIds = (scene: Scene) =>
  scene
    .getElementsIncludingDeleted()
    .filter((e) => !e.isDeleted)
    .map((e) => e.id)
    .sort();

/**
 * A local reset replaces the Scene GENERATION; it never clears the shared doc.
 *
 * Clearing in place cannot work: the clear's structs and delete-set stay in the
 * doc, so the next full-state encode (INIT seed, periodic resync, persistence)
 * republishes it and deletes every peer's elements and image binaries. A fresh
 * doc has no such history to leak.
 */
describe("resetScene replaces the Scene generation", () => {
  it("emits NO shared update, and the discarded doc can never emit again", async () => {
    await render(<Excalidraw />);
    API.setElements([API.createElement({ type: "rectangle", id: "a" })]);

    const oldScene = h.scene;
    const oldDoc = oldScene.doc;

    const delivered: Uint8Array[] = [];
    const detachOld = oldScene.onDocUpdate((u) => delivered.push(u));

    act(() => {
      // eslint-disable-next-line dot-notation
      h.app["resetScene"]();
    });

    // A reset publishes nothing at all.
    expect(delivered).toHaveLength(0);
    // ...and the generation really was replaced.
    expect(h.scene).not.toBe(oldScene);
    expect(h.scene.doc).not.toBe(oldDoc);
    expect(liveIds(h.scene)).toEqual([]);

    // The discarded generation is inert: with the subscription STILL ATTACHED,
    // writing to the old doc must produce nothing. (Asserting only that reset
    // itself was silent would prove nothing about the doc that was dropped.)
    oldDoc.transact(() => {
      oldDoc.getMap("elements").set("ghost", new Y.Map());
    });
    expect(delivered).toHaveLength(0);

    detachOld();
  });

  it("a transport subscription taken BEFORE the reset still sees later edits", async () => {
    // The load-bearing case. The fallback `initializeRoom` path can reset AFTER a
    // transport has subscribed; if the subscription stayed bound to the discarded
    // doc, collaboration would be permanently deaf with no error anywhere.
    await render(<Excalidraw />);

    const received: Uint8Array[] = [];
    const unsubscribe = h.app.onLocalSceneUpdate((u) => received.push(u));

    act(() => {
      // eslint-disable-next-line dot-notation
      h.app["resetScene"]();
    });
    expect(received).toHaveLength(0); // the reset itself is silent

    // An ordinary edit on the NEW generation must reach the same subscriber.
    act(() => {
      API.setElements([API.createElement({ type: "rectangle", id: "after" })]);
    });

    expect(received.length).toBeGreaterThan(0);
    unsubscribe();
  });

  it("unmount detaches transport subscribers — no callback afterwards", async () => {
    const { unmount } = await render(<Excalidraw />);

    const received: Uint8Array[] = [];
    h.app.onLocalSceneUpdate((u) => received.push(u));

    const app = h.app;
    unmount();

    // Unmount leaves the component's fields valid for a possible remount.
    // Nothing may still be listening to the Scene it leaves behind.
    received.length = 0;
    act(() => {
      app.scene.replaceAllElements([
        API.createElement({ type: "rectangle", id: "afterUnmount" }),
      ]);
    });
    expect(received).toHaveLength(0);
  });

  it("every callable member of a retained API is dead after unmount", async () => {
    const { unmount } = await render(<Excalidraw />);
    // The reference a consumer holds is the one that must become unusable.
    const retained = h.app.api;
    expect(typeof retained.getSceneElements).toBe("function"); // guard: live
    expect(retained.isDestroyed).toBe(false); // guard
    unmount();

    expect(retained.isDestroyed).toBe(true);

    // Invalidation covers the transport as well as the get* methods.
    const destroyed = retained as unknown as Record<string, () => void>;
    // Representative of each kind of member, because invalidation is generic
    // rather than a list of names: read, mutation, transport, and a callable
    // nested one level down.
    for (const name of [
      "getSceneElements",
      "updateScene",
      "mutateElement",
      "resetScene",
      "addFiles",
      "onLocalSceneUpdate",
      "applyRemoteSceneUpdate",
      "encodeSceneAsUpdate",
    ]) {
      expect(() => destroyed[name]()).toThrow(/no longer usable/);
    }
    expect(() =>
      (
        retained as unknown as { history: { clear: () => void } }
      ).history.clear(),
    ).toThrow(/no longer usable/);

    // `isDestroyed` stays DATA so a consumer can check before calling.
    expect(retained.isDestroyed).toBe(true);
  });

  it("a remote update applies to the NEW generation", async () => {
    await render(<Excalidraw />);
    act(() => {
      // eslint-disable-next-line dot-notation
      h.app["resetScene"]();
    });

    // A peer's state, built independently, must integrate into the new doc.
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.replaceAllElements([
      API.createElement({ type: "rectangle", id: "fromPeer" }),
    ]);

    act(() => {
      h.app.applyRemoteSceneUpdate(peer.encodeStateAsUpdate());
    });

    expect(liveIds(h.scene)).toEqual(["fromPeer"]);
    peer.destroy();
  });

  it("still resets files, appState and history", async () => {
    await render(<Excalidraw />);
    API.setElements([API.createElement({ type: "rectangle", id: "a" })]);
    act(() => {
      h.app.addFiles([
        {
          id: "f1",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AAAA",
          created: 1,
        },
      ] as never);
    });
    expect(Object.keys(h.app.files)).toEqual(["f1"]); // guard: it was added

    act(() => {
      // eslint-disable-next-line dot-notation
      h.app["resetScene"]();
    });

    expect(liveIds(h.scene)).toEqual([]);
    expect(Object.keys(h.app.files)).toEqual([]);
    expect(h.scene.getAssetLocators()).toEqual({});
    // appState returns to its defaults, on the doc and in the editor
    expect(h.scene.getPersistedAppState()).toEqual({});
    expect(h.state.viewBackgroundColor).toBe(
      getDefaultAppState().viewBackgroundColor,
    );
    // history has nothing to undo after a reset
    // eslint-disable-next-line dot-notation
    expect(h.app["history"].isUndoStackEmpty).toBe(true);
  });
});
