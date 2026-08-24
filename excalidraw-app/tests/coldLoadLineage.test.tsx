import * as Y from "yjs";
import { Scene } from "@excalidraw-yjs/element";
import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";
import { vi } from "vitest";

import type { OrderedExcalidrawElement } from "@excalidraw-yjs/element/types";

import type { SceneContentToken } from "@excalidraw-yjs/element";

import { DELETED_ELEMENT_TIMEOUT } from "../app_constants";

import type Portal from "../collab/Portal";

/**
 * INV-COLD-LOAD-LINEAGE (T004).
 *
 * The editor has TWO ways into a room, and they must produce compatible
 * lineage:
 *   - COLD LOAD — adopt the persisted document (T020);
 *   - INIT SEED — receive a peer's full-scene broadcast (T032).
 *
 * Before those landed, each path minted a fresh `clientID`: persistence rebuilt
 * the stored doc on every save and the wire rebuilt the seed on every join, so
 * two replicas that entered by different doors shared no history and their
 * concurrent edits could only resolve by whole-element last-writer-wins. This
 * pins the property that both doors now buy: two replicas, one from each,
 * per-property merge.
 *
 * SCOPE, stated because it is not obvious: the COLD-LOAD side goes through the
 * real `saveToFirebase` / `loadFromFirebase`, so a sabotage of persistence fails
 * these. The INIT side MIRRORS `Collab.encodeSceneAsUpdate` (maintenance, then a
 * pure encode) rather than calling it, because driving the collab layer needs a
 * mounted app; that producer is pinned directly in `collab.test.tsx`. So these
 * cases prove the two doors interoperate given a faithful seed — they do not
 * re-prove that the seed itself is built correctly.
 */

const store = new Map<string, unknown>();

vi.mock("@excalidraw-yjs/excalidraw/data/encryption", () => ({
  encryptData: async (_key: string, data: Uint8Array) => ({
    encryptedBuffer: data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ),
    iv: new Uint8Array(12),
  }),
  decryptData: async (_iv: Uint8Array, data: Uint8Array) =>
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  IV_LENGTH_BYTES: 12,
}));

class FakeBytes {
  constructor(private readonly bytes: Uint8Array) {}
  static fromUint8Array = (b: Uint8Array) => new FakeBytes(b);
  toUint8Array = () => this.bytes;
}

vi.mock("firebase/app", () => ({ initializeApp: () => ({}) }));
vi.mock("firebase/storage", () => ({
  getStorage: () => ({}),
  ref: () => ({}),
  uploadBytes: async () => ({}),
  getBytes: async () => new Uint8Array(),
}));
vi.mock("firebase/firestore", () => {
  const doc = (_f: unknown, _c: string, id: string) => ({ id });
  const getDoc = async (ref: { id: string }) => {
    const data = store.get(ref.id);
    return { exists: () => data !== undefined, data: () => data };
  };
  const runTransaction = async (
    _f: unknown,
    fn: (t: unknown) => Promise<unknown>,
  ) => {
    const transaction = {
      get: async (ref: { id: string }) => {
        const data = store.get(ref.id);
        return { exists: () => data !== undefined, data: () => data };
      },
      set: (ref: { id: string }, v: unknown) => store.set(ref.id, v),
      update: (ref: { id: string }, v: unknown) => store.set(ref.id, v),
    };
    return fn(transaction);
  };
  return {
    getFirestore: () => ({}),
    doc,
    getDoc,
    runTransaction,
    Bytes: FakeBytes,
  };
});

const { saveToFirebase, loadFromFirebase } = await import("../data/firebase");

const KEY = "0123456789abcdefghijkl";
const portalFor = (room: string): Portal =>
  ({ roomId: room, roomKey: KEY, socket: {} as Portal["socket"] } as Portal);
const tok = () => Object.freeze({}) as SceneContentToken;

const rect = (id: string, over: Partial<OrderedExcalidrawElement> = {}) =>
  ({
    ...(API.createElement({
      type: "rectangle",
      id,
    }) as OrderedExcalidrawElement),
    ...over,
  } as OrderedExcalidrawElement);

/** What `Collab.encodeSceneAsUpdate` does: maintenance, then a pure encode. */
const wireSeed = (scene: Scene) => {
  scene.collectGarbage({ deletedBefore: Date.now() - DELETED_ELEMENT_TIMEOUT });
  return scene.encodeStateAsUpdate("v1");
};

const sceneFrom = (bytes: Uint8Array, format: "v1" | "v2") => {
  const doc = new Y.Doc();
  if (format === "v2") {
    Y.applyUpdateV2(doc, bytes);
  } else {
    Y.applyUpdate(doc, bytes);
  }
  return new Scene(null, { doc });
};

const setProp = (
  scene: Scene,
  id: string,
  patch: Partial<OrderedExcalidrawElement>,
) =>
  scene.replaceAllElements(
    scene
      .getElementsIncludingDeleted()
      .map((e) => (e.id === id ? { ...e, ...patch } : e)) as never,
  );

beforeEach(() => {
  store.clear();
});

describe("INV-COLD-LOAD-LINEAGE (T004)", () => {
  it("a COLD-LOADED replica per-property-merges with an INIT-SEEDED one", async () => {
    const room = "cold-vs-init";

    // The room's origin document, persisted once.
    const origin = new Scene();
    origin.replaceAllElements([
      rect("shared", { strokeColor: "#000000", backgroundColor: "#ffffff" }),
    ]);
    await saveToFirebase(
      portalFor(room),
      origin.encodeStateAsUpdate("v2"),
      tok(),
    );

    // Replica A enters by COLD LOAD — adopting the persisted document.
    const loaded = await loadFromFirebase(room, KEY, null);
    expect(loaded).not.toBeNull();
    const coldLoaded = sceneFrom(loaded!.docBytes, "v2");

    // Replica B enters by INIT SEED — a peer's full-scene broadcast.
    const initSeeded = sceneFrom(wireSeed(origin), "v1");

    // GUARD: both really entered, so a merge failure below is a merge failure.
    expect(coldLoaded.getElementsIncludingDeleted().map((e) => e.id)).toEqual([
      "shared",
    ]);
    expect(initSeeded.getElementsIncludingDeleted().map((e) => e.id)).toEqual([
      "shared",
    ]);

    // Each edits a DIFFERENT property of the same element, neither having seen
    // the other.
    setProp(coldLoaded, "shared", { strokeColor: "#ff0000" });
    setProp(initSeeded, "shared", { backgroundColor: "#0000ff" });

    // They exchange.
    initSeeded.applyRemoteUpdate(coldLoaded.encodeStateAsUpdate("v2"), "v2");
    coldLoaded.applyRemoteUpdate(initSeeded.encodeStateAsUpdate("v2"), "v2");

    for (const [name, scene] of [
      ["cold-loaded", coldLoaded],
      ["init-seeded", initSeeded],
    ] as const) {
      const el = scene
        .getElementsIncludingDeleted()
        .find((e) => e.id === "shared")!;
      expect(`${name}:${el.strokeColor}`).toBe(`${name}:#ff0000`);
      expect(`${name}:${el.backgroundColor}`).toBe(`${name}:#0000ff`);
    }

    coldLoaded.destroy();
    initSeeded.destroy();
    origin.destroy();
  });

  it("the two doors produce the SAME lineage, not merely the same values", async () => {
    const room = "same-lineage";
    const origin = new Scene();
    origin.replaceAllElements([rect("a")]);
    await saveToFirebase(
      portalFor(room),
      origin.encodeStateAsUpdate("v2"),
      tok(),
    );

    const loaded = await loadFromFirebase(room, KEY, null);
    const coldLoaded = sceneFrom(loaded!.docBytes, "v2");
    const initSeeded = sceneFrom(wireSeed(origin), "v1");

    // Seeding one replica from the other must teach it NOTHING: same history,
    // not merely the same decoded content. Two rebuilt docs would each carry a
    // distinct clientID and so always add structs here.
    const before = Y.encodeStateVector(initSeeded.doc);
    initSeeded.applyRemoteUpdate(coldLoaded.encodeStateAsUpdate("v2"), "v2");
    expect(Y.encodeStateVector(initSeeded.doc)).toEqual(before);

    coldLoaded.destroy();
    initSeeded.destroy();
    origin.destroy();
  });

  it("a deletion made on one door is not resurrected by the other", async () => {
    const room = "cross-door-delete";
    const origin = new Scene();
    origin.replaceAllElements([rect("doomed"), rect("kept")]);
    await saveToFirebase(
      portalFor(room),
      origin.encodeStateAsUpdate("v2"),
      tok(),
    );

    const loaded = await loadFromFirebase(room, KEY, null);
    const coldLoaded = sceneFrom(loaded!.docBytes, "v2");
    const initSeeded = sceneFrom(wireSeed(origin), "v1");

    // The cold-loaded replica deletes; the init-seeded one edits something else
    // entirely and never touches the deleted flag.
    setProp(coldLoaded, "doomed", { isDeleted: true });
    setProp(initSeeded, "kept", { strokeColor: "#00ff00" });

    initSeeded.applyRemoteUpdate(coldLoaded.encodeStateAsUpdate("v2"), "v2");

    const doomed = initSeeded
      .getElementsIncludingDeleted()
      .find((e) => e.id === "doomed")!;
    expect(doomed.isDeleted).toBe(true);
    expect(
      initSeeded.getElementsIncludingDeleted().find((e) => e.id === "kept")!
        .strokeColor,
    ).toBe("#00ff00");

    coldLoaded.destroy();
    initSeeded.destroy();
    origin.destroy();
  });
});
