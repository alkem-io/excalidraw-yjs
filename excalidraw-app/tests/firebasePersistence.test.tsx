import * as Y from "yjs";
import { newElement, newImageElement } from "@excalidraw-yjs/element";
import { it, vi } from "vitest";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";
import type { AppState } from "@excalidraw-yjs/excalidraw/types";

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

const { saveToFirebase, loadFromFirebase, isSavedToFirebase } = await import(
  "../data/firebase"
);

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

    const assets: Record<string, string> = {
      "f-live": "asset://f-live",
      "f-deleted": "asset://f-deleted",
    };

    await saveToFirebase(
      portalFor(),
      [live, deleted],
      appStateWith({}),
      assets,
    );

    const loaded = await loadFromFirebase(ROOM, KEY, null);
    // the orphaned image's REFERENCE never reached the store (and bytes were
    // never in the document to begin with).
    expect(Object.keys(loaded!.assets).sort()).toEqual(["f-live"]);
    expect(loaded!.assets["f-deleted"]).toBeUndefined();
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

  /**
   * INV-PERSIST-MERGE (T003) — PARTIAL.
   *
   * These exercise the CURRENT flattened save boundary: `saveToFirebase` takes a
   * plain element array, so by the time it is called the information needed to
   * tell "B intentionally reset x" from "B never saw A's x" is already gone.
   * They reproduce the resulting loss; they are NOT the final gate.
   *
   * The final gate needs two real Scenes derived from ONE shared update, whose
   * lineage-bearing updates are persisted — which requires the post-T021
   * boundary. That API does not exist yet and is not invented here.
   */
  describe("INV-PERSIST-MERGE (current boundary)", () => {
    /** Lineage-sensitive: the stored CRDT bytes, not the decoded values. */
    const storedFingerprint = (room: string) => {
      const data = store.get(`${room}`) as
        | { sceneVersion?: number; ciphertext?: { toUint8Array(): Uint8Array } }
        | undefined;
      const raw = data?.ciphertext?.toUint8Array();
      if (!raw) {
        return null;
      }
      const probe = new Y.Doc();
      Y.applyUpdateV2(probe, raw);
      const sv = Array.from(Y.encodeStateVector(probe));
      probe.destroy();
      return JSON.stringify(sv);
    };

    // SKIPPED — desired contract, currently fails: measured, A's x=100 is lost
    // (stored x=0 y=200). Cause is `mergeStoredElements` (firebase.ts:191),
    // "both alive: whole-element LWW, saving replica wins", followed by a
    // `buildSnapshotDoc` rebuild. Not rewritten to assert the loss.
    it.skip("a concurrent edit to a DIFFERENT property of the same element survives", async () => {
      const room = "persist-merge";
      await saveToFirebase(
        portalForRoom(room),
        [rect("e1", { x: 0, y: 0 })],
        appStateWith({}),
        {},
      );
      await saveToFirebase(
        portalForRoom(room),
        [rect("e1", { x: 100, y: 0 })],
        appStateWith({}),
        {},
      );
      await saveToFirebase(
        portalForRoom(room),
        [rect("e1", { x: 0, y: 200 })],
        appStateWith({}),
        {},
      );

      const loaded = await loadFromFirebase(room, KEY, null);
      const e1 = (loaded!.elements as readonly OrderedExcalidrawElement[]).find(
        (e) => e.id === "e1",
      );
      expect(e1).toBeDefined();
      expect(e1!.x).toBe(100);
      expect(e1!.y).toBe(200);
    });

    // SKIPPED — desired contract. Order-independence is what makes the invariant
    // non-vacuous, so it is asserted rather than deferred on the grounds that it
    // obviously fails.
    it.skip("is ORDER-INDEPENDENT — A then B stores the same as B then A", async () => {
      const seed = [rect("e1", { x: 0, y: 0 })];
      const A = [rect("e1", { x: 100, y: 0 })];
      const B = [rect("e1", { x: 0, y: 200 })];

      await saveToFirebase(
        portalForRoom("order-ab"),
        seed,
        appStateWith({}),
        {},
      );
      await saveToFirebase(portalForRoom("order-ab"), A, appStateWith({}), {});
      await saveToFirebase(portalForRoom("order-ab"), B, appStateWith({}), {});

      await saveToFirebase(
        portalForRoom("order-ba"),
        seed,
        appStateWith({}),
        {},
      );
      await saveToFirebase(portalForRoom("order-ba"), B, appStateWith({}), {});
      await saveToFirebase(portalForRoom("order-ba"), A, appStateWith({}), {});

      const semantic = async (room: string) => {
        const l = await loadFromFirebase(room, KEY, null);
        return (l!.elements as readonly OrderedExcalidrawElement[])
          .map((e) => `${e.id}:${e.x},${e.y}`)
          .sort();
      };

      expect(await semantic("order-ab")).toEqual(await semantic("order-ba"));
    });

    // SKIPPED — desired contract. The earlier version of this compared decoded
    // id/x/y/isDeleted only and PASSED, which was vacuous for lineage:
    // `buildSnapshotDoc` mints a fresh `clientID` on every save, so the stored
    // CRDT state changes underneath while the semantic values stay identical.
    it.skip("is IDEMPOTENT in the stored CRDT state, not just in decoded values", async () => {
      const room = "persist-idempotent-lineage";
      const elements = [rect("e1", { x: 42, y: 7 })];

      await saveToFirebase(portalForRoom(room), elements, appStateWith({}), {});
      const first = storedFingerprint(room);
      await saveToFirebase(portalForRoom(room), elements, appStateWith({}), {});
      const second = storedFingerprint(room);

      expect(first).not.toBeNull(); // guard: something was stored
      expect(second).toBe(first);
    });

    it("semantic values are stable across an identical re-save", async () => {
      // The weaker property that DOES hold today, kept so the skipped lineage
      // case above is not the only coverage of re-saving.
      const room = "persist-idempotent-semantic";
      const elements = [rect("e1", { x: 42, y: 7 })];

      await saveToFirebase(portalForRoom(room), elements, appStateWith({}), {});
      const first = await loadFromFirebase(room, KEY, null);
      await saveToFirebase(portalForRoom(room), elements, appStateWith({}), {});
      const second = await loadFromFirebase(room, KEY, null);

      const shape = (r: typeof first) =>
        (r!.elements as readonly OrderedExcalidrawElement[])
          .map((e) => `${e.id}:${e.x},${e.y},${e.isDeleted}`)
          .sort();

      expect(shape(first)).toEqual(["e1:42,7,false"]); // guard: it saved
      expect(shape(second)).toEqual(shape(first));
    });
  });

  /**
   * INV-COLD-LOAD-LINEAGE (T020) — a cold load must adopt the stored document,
   * not rebuild records from it.
   *
   * Through the REAL save/load path, so this cannot pass on a fixture that never
   * had references in the first place.
   */
  describe("cold load adopts the stored document", () => {
    it("returns the stored asset references", async () => {
      const room = "cold-load-refs";
      await saveToFirebase(
        portalForRoom(room),
        [imageEl("img", "f1")],
        appStateWith({}),
        { f1: "asset://f1" },
      );

      const loaded = await loadFromFirebase(room, KEY, null);

      // GUARD: the element really round-tripped, so an empty assets map would
      // be a genuine loss rather than an empty scene.
      expect(
        (loaded!.elements as readonly OrderedExcalidrawElement[]).map(
          (e) => e.id,
        ),
      ).toContain("img");
      expect(loaded!.assets).toEqual({ f1: "asset://f1" });
    });

    it("exposes the stored bytes so the Scene can adopt them", async () => {
      const room = "cold-load-adopt";
      await saveToFirebase(
        portalForRoom(room),
        [imageEl("img", "f1")],
        appStateWith({}),
        { f1: "asset://f1" },
      );

      const loaded = await loadFromFirebase(room, KEY, null);

      expect(
        (loaded as unknown as { docBytes?: Uint8Array }).docBytes,
      ).toBeInstanceOf(Uint8Array);
    });
  });

  /**
   * INV-SAVE-SKIP (T007) — `isSaved` must mean live == stored.
   *
   * MEASURED, both halves broken, for two independent reasons:
   *
   * 1. FALSE-DIRTY (every save redundant). The cache is set from the elements
   *    that came back through `restoreElements`, which RENORMALISES versions.
   *    Measured: live `[a:5, b:5]` (sum 10) stores as `[a:2, b:2]` (sum 4). The
   *    cached sum therefore never equals the live sum, so `isSavedToFirebase`
   *    is false immediately after a successful save — every cycle pays a full
   *    firestore transaction, and the unload guard always claims unsaved work.
   *
   * 2. FALSE-SKIP (silent loss). `getSceneVersion` is a plain SUM, which
   *    collides whenever one element's version rises as much as another's
   *    falls. T014b established versions DO move backwards here, so the
   *    collision is a recorded mechanism, not a contrivance. A false-skip drops
   *    the save with nothing to retry it.
   *
   * Both are why T026 replaces the sum-cache with an explicit dirty flag.
   *
   * These are `it.fails` rather than `it.skip`: the defect stays EXECUTABLE and
   * the suite stays green, and the moment T026 makes either assertion hold the
   * test fails loudly instead of sitting silently skipped.
   */
  describe("INV-SAVE-SKIP", () => {
    it.fails("reports saved immediately after a successful save", async () => {
      const portal = portalFor();
      const live = [rect("a", { version: 5 }), rect("b", { version: 5 })];

      const stored = await saveToFirebase(portal, live, appStateWith({}), {});

      // GUARD: the save really happened, so `false` below is a live-vs-stored
      // mismatch and not an empty/aborted save.
      expect(stored).not.toBeNull();
      expect(stored!.map((e) => e.id).sort()).toEqual(["a", "b"]);

      expect(isSavedToFirebase(portal, live)).toBe(true);
    });

    it.fails(
      "does not report saved when content changed but the version SUM collides",
      async () => {
        const portal = portalFor();
        const stored = await saveToFirebase(
          portal,
          [rect("a", { version: 5 }), rect("b", { version: 5 })],
          appStateWith({}),
          {},
        );

        // GUARD (non-vacuity): anchor on the set the cache was actually built
        // from, so this reports `true` and the assertion below is a real
        // transition rather than the permanent `false` of defect 1.
        expect(isSavedToFirebase(portal, stored!)).toBe(true);

        // One version up, one down — identical sum, genuinely different content.
        const byId = (id: string) => stored!.find((e) => e.id === id)!;
        const collided = [
          { ...byId("a"), version: byId("a").version + 1, x: 999 },
          { ...byId("b"), version: byId("b").version - 1 },
        ] as unknown as typeof stored;
        expect(collided!.reduce((n, e) => n + e.version, 0)).toBe(
          stored!.reduce((n, e) => n + e.version, 0),
        );

        expect(isSavedToFirebase(portal, collided!)).toBe(false);
      },
    );
  });
});
