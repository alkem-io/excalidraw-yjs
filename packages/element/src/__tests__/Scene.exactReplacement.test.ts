import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

const mk = (id: string, x = 0): ExcalidrawElement =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x,
      y: 0,
      width: 10,
      height: 10,
    } as Parameters<typeof newElement>[0]) as ExcalidrawElement),
    id,
    x,
  } as ExcalidrawElement);

const ids = (scene: Scene) =>
  scene
    .getElementsIncludingDeleted()
    .map((e) => e.id)
    .sort();

/** A live room with content on all three roots. */
const liveRoom = () => {
  const scene = new Scene();
  scene.replaceAllElements([mk("old1"), mk("old2")], { recordHistory: false });
  scene.setAssetLocators({ oldAsset: "asset://old", keep: "asset://keep" });
  scene.setAppState({
    viewBackgroundColor: "#000000",
    name: "old name",
  } as never);
  return scene;
};

/**
 * EXACT REPLACEMENT of an observed generation.
 *
 * A server-side collaborator syncs the live room into a `Y.Doc`, then replaces
 * what it observed with a desired snapshot — in ONE published mutation, over an
 * ordinary Yjs wire, with no facade primitive and no schema hand-editing.
 *
 * **This replaces the generation the replacer OBSERVED. It is not global
 * exclusion**, and the last test pins that rather than leaving it implied: a
 * genuinely concurrent peer add survives, and a concurrent property edit merges
 * per-property, because this is an ordinary Yjs mutation. A caller needing
 * exclusivity must arrange quiescence itself; deliberately no lock is offered.
 */
describe("exact replacement of the observed generation", () => {
  it("replaces all three roots exactly, in ONE update, with no undo step", () => {
    const scene = liveRoom();
    const updates: Uint8Array[] = [];
    const detach = scene.onDocUpdate((u) => updates.push(u));

    scene.beginLogicalMutation();
    try {
      scene.replaceAllElements([mk("new1", 42)], { recordHistory: false });
      scene.setAssetLocators({ newAsset: "asset://new" }, { prune: true });
      scene.setAppState({ viewBackgroundColor: "#ffffff" } as never, {
        prune: true,
      });
    } finally {
      scene.endLogicalMutation();
    }
    detach();

    // desired exact, and nothing the desired set omitted survived
    expect(ids(scene)).toEqual(["new1"]);
    expect(scene.getAssetLocators()).toEqual({ newAsset: "asset://new" });
    expect(scene.getPersistedAppState()).toEqual({
      viewBackgroundColor: "#ffffff",
    });

    // one logical mutation is one transport message
    expect(updates).toHaveLength(1);
    // and it is not undoable
    expect(scene.canUndoElements()).toBe(false);
    scene.destroy();
  });

  it("a remote replica converges on all three roots", () => {
    const scene = liveRoom();
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(scene.encodeStateAsUpdate("v1"));
    expect(ids(peer)).toEqual(["old1", "old2"]); // peer starts from the live room

    scene.beginLogicalMutation();
    try {
      scene.replaceAllElements([mk("new1", 42)], { recordHistory: false });
      scene.setAssetLocators({ newAsset: "asset://new" }, { prune: true });
      scene.setAppState({ name: "new name" } as never, { prune: true });
    } finally {
      scene.endLogicalMutation();
    }
    peer.applyRemoteUpdate(
      scene.encodeStateAsUpdate("v1", peer.encodeStateVector()),
    );

    expect(ids(peer)).toEqual(["new1"]);
    expect(peer.getAssetLocators()).toEqual({ newAsset: "asset://new" });
    expect(peer.getPersistedAppState()).toEqual({ name: "new name" });
    peer.destroy();
    scene.destroy();
  });

  it("defaults stay MERGE — prune is opt-in", () => {
    const scene = liveRoom();
    scene.setAssetLocators({ another: "asset://another" });
    scene.setAppState({ viewBackgroundColor: "#111111" } as never);

    // nothing was removed by an ordinary write
    expect(scene.getAssetLocators()).toEqual({
      oldAsset: "asset://old",
      keep: "asset://keep",
      another: "asset://another",
    });
    expect(scene.getPersistedAppState()).toEqual({
      viewBackgroundColor: "#111111",
      name: "old name", // untouched by a background-only change
    });
    scene.destroy();
  });

  it("an invalid locator is atomic: nothing is pruned and nothing is written", () => {
    const scene = liveRoom();
    const before = scene.getAssetLocators();

    expect(() =>
      scene.setAssetLocators(
        { good: "asset://good", bad: "data:image/png;base64,AAAA" },
        { prune: true },
      ),
    ).toThrow(/data URL/i);

    // the pre-existing root is untouched — no half-pruned state, and the valid
    // sibling in the same batch did not land either
    expect(scene.getAssetLocators()).toEqual(before);
    expect(scene.getAssetLocators().good).toBeUndefined();
    scene.destroy();
  });

  it("NON-EXCLUSIVE: a concurrent peer add survives, a concurrent edit merges", () => {
    const scene = liveRoom();
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(scene.encodeStateAsUpdate("v1"));

    // the peer edits WHILE the replacer works from what it observed
    peer.replaceAllElements(
      [
        ...peer
          .getElementsIncludingDeleted()
          .map((e) => (e.id === "old1" ? { ...e, x: 999 } : e)),
        mk("peerAdd", 7),
      ],
      { recordHistory: false },
    );

    scene.beginLogicalMutation();
    try {
      // the replacer never saw `peerAdd`; its desired set keeps old1 only
      scene.replaceAllElements([mk("old1", 5)], { recordHistory: false });
    } finally {
      scene.endLogicalMutation();
    }

    // exchange both ways
    peer.applyRemoteUpdate(
      scene.encodeStateAsUpdate("v1", peer.encodeStateVector()),
    );
    scene.applyRemoteUpdate(
      peer.encodeStateAsUpdate("v1", scene.encodeStateVector()),
    );

    // The concurrent ADD survives the replacement — replacement is of the
    // OBSERVED generation, not a global exclusion.
    expect(ids(scene)).toContain("peerAdd");
    expect(ids(peer)).toContain("peerAdd");
    // ...and both replicas agree.
    expect(ids(scene)).toEqual(ids(peer));
    // The concurrent property edit merged rather than being overridden by
    // virtue of the write being a "replacement".
    expect(scene.getElement("old1")?.x).toBe(peer.getElement("old1")?.x);
    peer.destroy();
    scene.destroy();
  });
});
