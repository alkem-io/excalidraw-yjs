import * as Y from "yjs";

import { CaptureUpdateAction, Scene } from "@excalidraw-yjs/element";

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
 * The four transport operations a y-protocol provider needs, so it never
 * requires the raw `Y.Doc`: `encodeSceneStateVector`, `encodeSceneAsUpdate`
 * (optionally against a peer's vector), `applyRemoteSceneUpdate` and
 * `onLocalSceneUpdate`.
 */
describe("the scene sync port is complete without the raw doc", () => {
  it("performs a full sync-step-1 / step-2 exchange with a diverged peer", async () => {
    await render(<Excalidraw />);
    act(() => {
      h.app.updateScene({
        elements: [
          API.createElement({ type: "rectangle", id: "editor-1" }),
          API.createElement({ type: "rectangle", id: "editor-2" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    // A peer that already diverged: it holds the editor's original state plus
    // its own element the editor has never seen.
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.app.encodeSceneAsUpdate());
    peer.replaceAllElements([
      ...peer.getElementsIncludingDeleted(),
      API.createElement({ type: "rectangle", id: "peer-1" }),
    ]);
    act(() => {
      h.app.updateScene({
        elements: [
          ...h.elements,
          API.createElement({ type: "rectangle", id: "editor-3" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    // GUARD: they really have diverged, or the exchange proves nothing.
    expect(liveIds(peer)).not.toEqual(
      h.scene
        .getElementsIncludingDeleted()
        .filter((e) => !e.isDeleted)
        .map((e) => e.id)
        .sort(),
    );

    // --- sync step 1: each side offers its state vector ---
    const editorVector = h.app.encodeSceneStateVector();
    const peerVector = peer.encodeStateVector();

    // --- sync step 2: each replies with only the delta the other lacks ---
    const forPeer = h.app.encodeSceneAsUpdate("v1", peerVector);
    const forEditor = peer.encodeStateAsUpdate("v1", editorVector);

    // A delta must be smaller than the full state, or "diff" is a misnomer.
    expect(forPeer.byteLength).toBeLessThan(
      h.app.encodeSceneAsUpdate().byteLength,
    );

    peer.applyRemoteUpdate(forPeer);
    act(() => {
      h.app.applyRemoteSceneUpdate(forEditor);
    });

    const converged = ["editor-1", "editor-2", "editor-3", "peer-1"];
    expect(liveIds(peer)).toEqual(converged);
    expect(
      h.scene
        .getElementsIncludingDeleted()
        .filter((e) => !e.isDeleted)
        .map((e) => e.id)
        .sort(),
    ).toEqual(converged);

    peer.destroy();
  });

  it("a v2 delta round-trips too, so a provider may speak either format", async () => {
    await render(<Excalidraw />);
    act(() => {
      h.app.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "a" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.app.encodeSceneAsUpdate("v2"), "v2");
    expect(liveIds(peer)).toEqual(["a"]);

    act(() => {
      h.app.updateScene({
        elements: [
          ...h.elements,
          API.createElement({ type: "rectangle", id: "b" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    const delta = h.app.encodeSceneAsUpdate("v2", peer.encodeStateVector());
    peer.applyRemoteUpdate(delta, "v2");
    expect(liveIds(peer)).toEqual(["a", "b"]);

    peer.destroy();
  });
});
