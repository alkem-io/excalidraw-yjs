import { newElement, newImageElement } from "@excalidraw-yjs/element";
import { vi } from "vitest";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";
import type { AppState, BinaryFiles } from "@excalidraw-yjs/excalidraw/types";

import type { SyncableExcalidrawElement } from "../data";
import type Portal from "../collab/Portal";

/**
 * Persistence/wire boundary (findings #1, #2, #4) at the FIREBASE save/load seam.
 *
 * The store is a SEPARATE replica from the live socket, so these are tested with a
 * faithful in-memory firestore + storage mock:
 *   - #2 lost-update: `saveToFirebase` reads the stored doc INSIDE the transaction
 *     and VALUE-merges it with the live element/file/appState set before writing
 *     (a decoded whole-element LWW with a deletion-union — NOT a Yjs `applyUpdateV2`
 *     fold, which would be whole-element LWW by `clientID` across the docs' disjoint
 *     lineages and could drop a concurrent edit or resurrect a deletion). A
 *     concurrent writer's element survives and no deletion is resurrected.
 *   - #1 leak: a deleted image's binary is NOT persisted (file-prune to referenced).
 *   - #4 cold-load: the persisted `viewBackgroundColor` / `name` survive a load
 *     (previously dropped by `decryptScene`, so a solo reopen fell back to defaults).
 *
 * Encryption is mocked to identity so the doc bytes round-trip verbatim (the seam
 * under test is the merge/filter/appState carry, not WebCrypto).
 */

// Identity "encryption" so the stored ciphertext IS the plaintext doc bytes.
vi.mock("@excalidraw-yjs/excalidraw/data/encryption", () => ({
  encryptData: async (_key: string, data: Uint8Array) => ({
    encryptedBuffer: data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ),
    iv: new Uint8Array(12),
  }),
  decryptData: async (_iv: Uint8Array, ciphertext: ArrayBuffer) => ciphertext,
}));

// Minimal Bytes shim + an in-memory firestore "scenes" collection and a no-op
// storage, matching exactly the firebase API surface firebase.ts touches.
const store = new Map<string, unknown>();

class FakeBytes {
  private constructor(private readonly u8: Uint8Array) {}
  static fromUint8Array(u8: Uint8Array) {
    return new FakeBytes(new Uint8Array(u8));
  }
  toUint8Array() {
    return this.u8;
  }
}

vi.mock("firebase/app", () => ({ initializeApp: () => ({}) }));

vi.mock("firebase/storage", () => ({
  getStorage: () => ({}),
  ref: () => ({}),
  uploadBytes: async () => ({}),
}));

vi.mock("firebase/firestore", () => {
  const doc = (_firestore: unknown, _coll: string, id: string) => ({ id });
  const getDoc = async (ref: { id: string }) => {
    const data = store.get(ref.id);
    return {
      exists: () => data !== undefined,
      data: () => data,
    };
  };
  const runTransaction = async (
    _firestore: unknown,
    fn: (t: unknown) => Promise<unknown>,
  ) => {
    const transaction = {
      get: async (ref: { id: string }) => {
        const data = store.get(ref.id);
        return { exists: () => data !== undefined, data: () => data };
      },
      set: (ref: { id: string }, value: unknown) => store.set(ref.id, value),
      update: (ref: { id: string }, value: unknown) => store.set(ref.id, value),
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

const ROOM = "room-1";
const KEY = "0123456789abcdefghijkl"; // 22 chars, shape of a room key

const portalForRoom = (room: string): Portal =>
  ({
    roomId: room,
    roomKey: KEY,
    // a fresh socket per call so the version cache never short-circuits the save
    socket: {} as Portal["socket"],
  } as Portal);

const portalFor = (): Portal => portalForRoom(ROOM);

const rect = (id: string, overrides: Partial<ExcalidrawElement> = {}) =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...overrides,
  } as Parameters<typeof newElement>[0]) as unknown as SyncableExcalidrawElement;

const imageEl = (id: string, fileId: string) =>
  newImageElement({
    type: "image",
    id,
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    fileId: fileId as ExcalidrawElement["id"] as never,
    status: "saved",
  } as Parameters<typeof newImageElement>[0]) as unknown as SyncableExcalidrawElement;

const fileRecord = (id: string, dataURL: string) =>
  ({
    mimeType: "image/png",
    id,
    dataURL,
    created: 1_700_000_000_000,
    lastRetrieved: 1_700_000_000_500,
    version: 1,
  } as unknown as BinaryFiles[string]);

const appStateWith = (over: Partial<AppState>): AppState =>
  ({ viewBackgroundColor: "#ffffff", name: "untitled", ...over } as AppState);

beforeEach(() => {
  store.clear();
});

describe("firebase persistence boundary", () => {
  // FINDING #2 — concurrent-save merge. The store is a SEPARATE replica built by a
  // fresh `buildSnapshotDoc` per save (its own random `clientID`), and a save hands
  // `saveToFirebase` a plain element ARRAY, not the live `scene.doc`. So the merge
  // canNOT be a Yjs `applyUpdateV2` fold (whole-element LWW by `clientID` across
  // disjoint lineages — drops concurrent edits, resurrects deletions). It is a
  // decoded VALUE merge: deletions union (either side, both directions), disjoint
  // ids union, and a same-element concurrent edit resolves last-writer-wins by the
  // saving replica. Each case below is RED if the merge is reverted to the
  // fresh-doc `applyUpdateV2` (or to a wholesale replace).
  //
  // Each sub-case models the race by: writer B's save lands first (so the store
  // holds B's state), then writer A — on a fresh socket so the scene-version cache
  // never short-circuits — saves from a view that never saw B's change. A's save
  // must fold B's committed state in via the in-transaction read+merge.

  it("FINDING #2 (disjoint adds): a concurrent writer's new element is NOT lost", async () => {
    // B committed {a, b}; A saves from a stale view {a, c} that never saw b.
    await saveToFirebase(
      portalFor(),
      [rect("a"), rect("b")],
      appStateWith({}),
      {},
    );
    await saveToFirebase(
      portalFor(),
      [rect("a"), rect("c")],
      appStateWith({}),
      {},
    );

    const loaded = await loadFromFirebase(ROOM, KEY, null);
    const ids = (loaded!.elements as readonly OrderedExcalidrawElement[])
      .map((e) => e.id)
      .sort();

    // b (the concurrent writer's element) survived alongside a and c. A wholesale
    // replace would have dropped b.
    expect(ids).toEqual(["a", "b", "c"]);
  });

  // The broken fresh-doc `applyUpdateV2` merge resolves a shared element id by a
  // RANDOM `clientID` tiebreak (a new `clientID` per save), so on any single race
  // it may coincidentally land the correct element ~half the time. To make these
  // discriminating cases DETERMINISTICALLY red under the broken merge, each runs
  // the race RACE_ITERATIONS times on independent rooms and asserts the invariant
  // EVERY time: the broken merge violates it on at least one iteration with
  // probability 1 − 2^−RACE_ITERATIONS (≈ 0.9998 at 12). The value merge is
  // deterministic, so it passes all iterations.
  const RACE_ITERATIONS = 12;

  it("FINDING #2 (same-element concurrent edit): the saving replica's edit wins, element not dropped", async () => {
    for (let i = 0; i < RACE_ITERATIONS; i++) {
      const room = `same-edit-${i}`;
      // B committed e1 with a red stroke.
      await saveToFirebase(
        portalForRoom(room),
        [rect("e1", { strokeColor: "#ff0000" })],
        appStateWith({}),
        {},
      );
      // A concurrently re-colours e1 blue (A's view; A never saw B's red). A is the
      // live save — last-writer-wins by whole element: blue wins and e1 is not
      // dropped. The fresh-doc `applyUpdateV2` merge keeps ONE element-map by
      // `clientID` tiebreak, so it drops A's whole blue map (red survives) whenever
      // the stored doc wins the tiebreak.
      await saveToFirebase(
        portalForRoom(room),
        [rect("e1", { strokeColor: "#0000ff" })],
        appStateWith({}),
        {},
      );

      const loaded = await loadFromFirebase(room, KEY, null);
      const e1 = (loaded!.elements as readonly OrderedExcalidrawElement[]).find(
        (e) => e.id === "e1",
      );
      expect(e1).toBeDefined();
      expect(e1!.strokeColor).toBe("#0000ff");
    }
  });

  it("FINDING #2 (delete-union, live delete): a live deletion is not resurrected by a stale stored alive", async () => {
    for (let i = 0; i < RACE_ITERATIONS; i++) {
      const room = `del-live-${i}`;
      // B committed e1 alive.
      await saveToFirebase(
        portalForRoom(room),
        [rect("e1", { strokeColor: "#ff0000" })],
        appStateWith({}),
        {},
      );
      // A deletes e1 (recent tombstone) — A's view never saw a concurrent re-add.
      const deleted = rect("e1");
      (deleted as unknown as { isDeleted: boolean }).isDeleted = true;
      (deleted as unknown as { updated: number }).updated = Date.now();
      await saveToFirebase(
        portalForRoom(room),
        [deleted],
        appStateWith({}),
        {},
      );

      const loaded = await loadFromFirebase(room, KEY, null);
      // The deletion-union keeps e1 tombstoned (load drops it, or returns it with
      // isDeleted:true) — never alive. The fresh-doc `applyUpdateV2` merge lets the
      // stored `isDeleted:false` win the tiebreak and RESURRECT e1 (alive on load).
      expect(
        (loaded!.elements as readonly OrderedExcalidrawElement[]).some(
          (e) => e.id === "e1" && !e.isDeleted,
        ),
      ).toBe(false);
    }
  });

  it("FINDING #2 (delete-union, stored delete): a stored deletion the live view never saw is not revived", async () => {
    for (let i = 0; i < RACE_ITERATIONS; i++) {
      const room = `del-stored-${i}`;
      // B committed e1 as a DELETED tombstone (recent).
      const bDeleted = rect("e1");
      (bDeleted as unknown as { isDeleted: boolean }).isDeleted = true;
      (bDeleted as unknown as { updated: number }).updated = Date.now();
      await saveToFirebase(
        portalForRoom(room),
        [bDeleted],
        appStateWith({}),
        {},
      );

      // A saves e1 ALIVE — A's view never saw B's deletion. The deletion must still
      // win (union), so A's stale alive does not revive the element.
      await saveToFirebase(
        portalForRoom(room),
        [rect("e1", { strokeColor: "#00ff00" })],
        appStateWith({}),
        {},
      );

      const loaded = await loadFromFirebase(room, KEY, null);
      expect(
        (loaded!.elements as readonly OrderedExcalidrawElement[]).some(
          (e) => e.id === "e1" && !e.isDeleted,
        ),
      ).toBe(false);
    }
  });

  it("FINDING #1: a deleted image's binary is NOT persisted", async () => {
    const live = imageEl("live", "f-live");
    const deleted = imageEl("deleted", "f-deleted");
    (deleted as unknown as { isDeleted: boolean }).isDeleted = true;
    (deleted as unknown as { updated: number }).updated = Date.now();

    const files: BinaryFiles = {
      "f-live": fileRecord("f-live", "data:,LIVE"),
      "f-deleted": fileRecord("f-deleted", "data:,SECRET-BYTES"),
    };

    await saveToFirebase(portalFor(), [live, deleted], appStateWith({}), files);

    const loaded = await loadFromFirebase(ROOM, KEY, null);
    // the orphaned (deleted-image) binary never reached the store.
    expect(Object.keys(loaded!.files).sort()).toEqual(["f-live"]);
    expect(loaded!.files["f-deleted"]).toBeUndefined();
  });

  it("FINDING #4: persisted viewBackgroundColor + name survive a cold load", async () => {
    await saveToFirebase(
      portalFor(),
      [rect("a")],
      appStateWith({ viewBackgroundColor: "#123456", name: "Persisted Board" }),
      {},
    );

    const loaded = await loadFromFirebase(ROOM, KEY, null);

    // decryptScene/loadFromFirebase now return the persistable appState subset,
    // so a solo reopen restores the saved background + name (not defaults).
    expect(loaded!.appState.viewBackgroundColor).toBe("#123456");
    expect(loaded!.appState.name).toBe("Persisted Board");
  });
});
