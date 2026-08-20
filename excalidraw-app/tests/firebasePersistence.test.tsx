import * as Y from "yjs";
import { newElement, newImageElement, Scene } from "@excalidraw-yjs/element";
import { it, vi } from "vitest";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";
import type { AppState } from "@excalidraw-yjs/excalidraw/types";

import type { SceneContentToken } from "@excalidraw-yjs/element";

import { DELETED_ELEMENT_TIMEOUT } from "../app_constants";

import type { SyncableExcalidrawElement } from "../data";

import type Portal from "../collab/Portal";

/**
 * Persistence boundary at the FIREBASE save/load seam.
 *
 * The store is a SEPARATE replica from the live socket, so these run against a
 * faithful in-memory firestore + storage mock:
 *   - **lost update**: `saveToFirebase` reads the stored doc INSIDE the
 *     transaction and `applyUpdateV2`-FOLDS it with the live update (T021).
 *     Both sides carry lineage — the wire ships the live document (T032) and a
 *     cold load adopts the stored one (T020) — so this is a real per-property
 *     CRDT merge: concurrent edits to different properties of one element both
 *     survive, where the old decoded value merge could keep only one side whole.
 *   - **soft deletion**: `isDeleted` is an ordinary property, NOT a Yjs delete,
 *     so delete-set union is not what protects it. See that describe block.
 *   - **cold load**: the persisted `viewBackgroundColor` / `name` and the asset
 *     references survive a load.
 *
 * Encryption is mocked to identity so the doc bytes round-trip verbatim (the seam
 * under test is the merge and the carry-through, not WebCrypto).
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
/** Injects a transaction failure, so a FAILED save can be tested for real
 * rather than asserted against a save that quietly succeeded. */
const faults = { failTransaction: false };

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
    if (faults.failTransaction) {
      throw new Error("firestore unavailable");
    }
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

/**
 * `saveToFirebase` takes the scene `contentToken` its input was captured at
 * (T026). Most cases here only need "some token that differs from whatever was
 * last saved", so the helper mints a fresh one; the INV-SAVE-SKIP cases pass
 * explicit tokens because the token IS what they are testing.
 */
/** A fresh content token, standing in for one a live Scene would produce. */
const tok = () => Object.freeze({}) as SceneContentToken;

/**
 * Build a real lineage-bearing scene document from the pieces a case describes,
 * then save THAT — mirroring what Collab does (T021). Cases keep expressing
 * themselves in elements/assets/appState; only the boundary changed.
 *
 * Returns the merged elements the store ended up holding, which is what these
 * cases assert on.
 */
const saveScene = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
  assets: Readonly<Record<string, string>> = {},
  contentToken: SceneContentToken = tok(),
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const scene = new Scene();
  scene.replaceAllElements(elements as never);
  if (Object.keys(assets).length) {
    scene.setAssetLocators(assets);
  }
  scene.setAppState(pickPersistable(appState));
  const update = scene.encodeStateAsUpdate("v2");
  scene.destroy();
  return saveToFirebase(portal, update, contentToken);
};

/**
 * Two replicas derived from ONE shared update — the model T021's fold requires
 * and T003 called for.
 *
 * Under the POST-CUTOVER protocol, two independently-created documents do not
 * race: the stored doc descends from a live doc (via a save), and every peer's
 * doc descends from the room's INIT/resync seed (T032) or from adopting the
 * stored one (T020). A test that builds each side with `new Scene()` models
 * DISJOINT lineages, and a CRDT fold across those really is whole-element LWW —
 * so such a test measures a situation this protocol does not produce.
 *
 * That premise is SCOPED, not absolute: it holds once the external WS protocol
 * gate rejects pre-cutover clients and pre-cutover stored shapes. Until that gate
 * exists an old client could still present a foreign document, so the gate is
 * what makes this reasoning sound in production — see the T023 rollout
 * obligation.
 */
const sharedBase = (elements: readonly SyncableExcalidrawElement[]) => {
  const base = new Scene();
  base.replaceAllElements(elements as never);
  const bytes = base.encodeStateAsUpdate("v2");
  base.destroy();
  return bytes;
};

/** A replica that descends from `baseBytes`, edited by `edit`. */
const replicaFrom = (
  baseBytes: Uint8Array,
  edit: (scene: Scene) => void,
): Uint8Array => {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, baseBytes);
  const scene = new Scene(null, { doc });
  edit(scene);
  const bytes = scene.encodeStateAsUpdate("v2");
  scene.destroy();
  return bytes;
};

const saveDoc = (
  portal: Portal,
  update: Uint8Array,
  contentToken: SceneContentToken = tok(),
) => saveToFirebase(portal, update, contentToken);

/** The doc only carries the allow-listed appState keys. */
const pickPersistable = (appState: AppState) => ({
  viewBackgroundColor: appState.viewBackgroundColor,
  name: appState.name,
});

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
  /**
   * Concurrent-save merge.
   *
   * The store is a SEPARATE replica from the live socket: two clients can each
   * commit a save built from a view that had not yet seen the other's committed
   * write. `saveToFirebase` takes the scene's own DOCUMENT (T021) and folds the
   * stored one into it with `applyUpdateV2`, so both sides carry lineage and the
   * merge is a real per-property CRDT merge.
   *
   * Every case builds its replicas from ONE shared base. That is not a
   * convenience: under the post-cutover protocol two independently-created
   * documents cannot race (the stored doc descends from a live doc, and every
   * peer's descends from the room seed or from adopting the stored one), so a
   * fixture with disjoint lineages would be measuring a situation the protocol
   * does not produce.
   *
   * Each case is deterministic — dropping the prior fold loses the other
   * replica's contribution outright, with no tiebreak involved — so none of them
   * needs repetition to be reliably red.
   */

  it("disjoint adds: a concurrent writer's new element is NOT lost", async () => {
    const base = sharedBase([rect("a")]);
    const addB = replicaFrom(base, (scene) =>
      scene.replaceAllElements([
        ...scene.getElementsIncludingDeleted(),
        rect("b"),
      ] as never),
    );
    const addC = replicaFrom(base, (scene) =>
      scene.replaceAllElements([
        ...scene.getElementsIncludingDeleted(),
        rect("c"),
      ] as never),
    );

    // B commits first; A saves from a view that never saw b.
    await saveDoc(portalFor(), addB);
    await saveDoc(portalFor(), addC);

    const loaded = await loadFromFirebase(ROOM, KEY, null);
    const ids = (loaded!.elements as readonly OrderedExcalidrawElement[])
      .map((e) => e.id)
      .sort();

    // b survived alongside a and c. A wholesale replace would have dropped it.
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("same element, DIFFERENT properties: both concurrent edits survive", async () => {
    const room = "same-el-props";
    const base = sharedBase([
      rect("e1", { strokeColor: "#000000", backgroundColor: "#ffffff" }),
    ]);
    const patch = (over: Partial<ExcalidrawElement>) => (scene: Scene) =>
      scene.replaceAllElements(
        scene
          .getElementsIncludingDeleted()
          .map((e) => ({ ...e, ...over })) as never,
      );

    await saveDoc(
      portalForRoom(room),
      replicaFrom(base, patch({ strokeColor: "#ff0000" })),
    );
    await saveDoc(
      portalForRoom(room),
      replicaFrom(base, patch({ backgroundColor: "#0000ff" })),
    );

    const loaded = await loadFromFirebase(room, KEY, null);
    const e1 = (loaded!.elements as readonly OrderedExcalidrawElement[]).find(
      (e) => e.id === "e1",
    );

    // What the lineage fold buys: whole-element LWW had to discard one side.
    expect(e1).toBeDefined();
    expect(e1!.strokeColor).toBe("#ff0000");
    expect(e1!.backgroundColor).toBe("#0000ff");
  });

  it("same element, SAME property: one edit wins and the store CONVERGES", async () => {
    const room = "same-el-same-prop";
    const base = sharedBase([rect("e1", { strokeColor: "#000000" })]);
    const colour = (c: string) => (scene: Scene) =>
      scene.replaceAllElements(
        scene
          .getElementsIncludingDeleted()
          .map((e) => ({ ...e, strokeColor: c })) as never,
      );

    await saveDoc(portalForRoom(room), replicaFrom(base, colour("#ff0000")));
    await saveDoc(portalForRoom(room), replicaFrom(base, colour("#0000ff")));

    const first = await loadFromFirebase(room, KEY, null);
    const e1 = (first!.elements as readonly OrderedExcalidrawElement[]).find(
      (e) => e.id === "e1",
    );

    // A genuine same-property conflict is resolved by the CRDT, not by "whoever
    // saved last" — so the assertion is that ONE of them won and the element was
    // not dropped, NOT which. Claiming the saving replica wins would be asserting
    // the old value merge's behaviour.
    expect(e1).toBeDefined();
    expect(["#ff0000", "#0000ff"]).toContain(e1!.strokeColor);

    // ...and re-saving an unchanged replica must not flip it: the store has
    // converged.
    const settled = e1!.strokeColor;
    await saveDoc(portalForRoom(room), replicaFrom(base, colour(settled)));
    const again = await loadFromFirebase(room, KEY, null);
    expect(
      (again!.elements as readonly OrderedExcalidrawElement[]).find(
        (e) => e.id === "e1",
      )!.strokeColor,
    ).toBe(settled);
  });

  /**
   * Soft deletion across a concurrent save.
   *
   * These MUST run with a controlled clock. Deletion markers are stamped from
   * the element's `updated`, and the harness mocks `getUpdatedTimestamp()` to a
   * constant `1`; `encryptScene` sweeps with the production cutoff
   * (`Date.now() - DELETED_ELEMENT_TIMEOUT`), which reclaims a marker of 1
   * outright. Measured: without this, the stored scene came back EMPTY and the
   * old assertion ("no live copy of e1") passed because the element was gone
   * entirely, not because the deletion persisted. Pinning the clock keeps the
   * tombstone in-window so the assertion is about the merge.
   */
  describe("soft deletion across a concurrent save", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // Cutoff becomes 0, so the marker of 1 is comfortably in-window.
      vi.setSystemTime(new Date(DELETED_ELEMENT_TIMEOUT));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const del = (scene: Scene) =>
      scene.replaceAllElements(
        scene
          .getElementsIncludingDeleted()
          .map((e) => ({ ...e, isDeleted: true })) as never,
      );
    const recolour = (c: string) => (scene: Scene) =>
      scene.replaceAllElements(
        scene
          .getElementsIncludingDeleted()
          .map((e) => ({ ...e, strokeColor: c })) as never,
      );

    /** The stored element, which must still EXIST — tombstoned, not reclaimed. */
    const storedE1 = async (room: string) => {
      const loaded = await loadFromFirebase(room, KEY, null);
      return (loaded!.elements as readonly OrderedExcalidrawElement[]).find(
        (e) => e.id === "e1",
      );
    };

    it.each([
      ["delete saved SECOND", false],
      ["delete saved FIRST", true],
    ])(
      "keeps the deletion when the other replica touched a different property (%s)",
      async (_label, deleteFirst) => {
        const room = `soft-del-${deleteFirst}`;
        const base = sharedBase([rect("e1", { strokeColor: "#000000" })]);
        const deletion = replicaFrom(base, del);
        const edit = replicaFrom(base, recolour("#ff0000"));

        for (const update of deleteFirst
          ? [deletion, edit]
          : [edit, deletion]) {
          await saveDoc(portalForRoom(room), update);
        }

        const e1 = await storedE1(room);
        // EXISTS and is tombstoned — not merely "no live copy", which a reclaimed
        // element would also satisfy.
        expect(e1).toBeDefined();
        expect(e1!.isDeleted).toBe(true);
        // ...and the concurrent edit to the other property survived alongside it.
        expect(e1!.strokeColor).toBe("#ff0000");
      },
    );

    /**
     * The residual GENUINE conflict: both branches write `isDeleted` (one
     * deletes; the other deletes and then undoes). The contract is NOT a
     * particular boolean — it is that persistence yields exactly what the live
     * socket would, so the two replicas cannot disagree with the store.
     */
    it.each([
      ["A then B", false],
      ["B then A", true],
    ])(
      "resolves an explicit isDeleted conflict exactly as the socket does (%s)",
      async (_label, reverse) => {
        const room = `soft-del-conflict-${reverse}`;
        const base = sharedBase([rect("e1", { strokeColor: "#000000" })]);

        const aDeletes = replicaFrom(base, del);
        const bRevives = replicaFrom(base, (scene) => {
          del(scene);
          scene.replaceAllElements(
            scene
              .getElementsIncludingDeleted()
              .map((e) => ({ ...e, isDeleted: false })) as never,
          );
        });

        // What the LIVE socket would produce from the same two updates.
        const expectedDoc = new Y.Doc();
        Y.applyUpdateV2(expectedDoc, base);
        for (const u of reverse ? [bRevives, aDeletes] : [aDeletes, bRevives]) {
          Y.applyUpdateV2(expectedDoc, u);
        }
        const expectedScene = new Scene(null, { doc: expectedDoc });
        const expected = expectedScene
          .getElementsIncludingDeleted()
          .find((e) => e.id === "e1")!.isDeleted;
        expectedScene.destroy();

        for (const u of reverse ? [bRevives, aDeletes] : [aDeletes, bRevives]) {
          await saveDoc(portalForRoom(room), u);
        }

        const e1 = await storedE1(room);
        expect(e1).toBeDefined();
        expect(e1!.isDeleted ?? false).toBe(expected ?? false);
      },
    );
  });

  it("a deleted image's asset REFERENCE is not persisted", async () => {
    const live = imageEl("live", "f-live");
    const deleted = imageEl("deleted", "f-deleted");
    (deleted as unknown as { isDeleted: boolean }).isDeleted = true;
    (deleted as unknown as { updated: number }).updated = Date.now();

    const assets: Record<string, string> = {
      "f-live": "asset://f-live",
      "f-deleted": "asset://f-deleted",
    };

    await saveScene(portalFor(), [live, deleted], appStateWith({}), assets);

    const loaded = await loadFromFirebase(ROOM, KEY, null);
    // the orphaned image's REFERENCE never reached the store (and bytes were
    // never in the document to begin with).
    expect(Object.keys(loaded!.assets).sort()).toEqual(["f-live"]);
    expect(loaded!.assets["f-deleted"]).toBeUndefined();
  });

  it("FINDING #4: persisted viewBackgroundColor + name survive a cold load", async () => {
    await saveScene(
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
   * INV-PERSIST-MERGE (T003) — the LIVE gate.
   *
   * The save boundary takes the scene's own document (T021), so both sides of a
   * concurrent save carry lineage and the merge is a real CRDT fold. These are
   * the properties that fold must have; the "different properties both survive"
   * case lives with the FINDING #2 group above.
   */
  describe("INV-PERSIST-MERGE", () => {
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

    const storedElements = async (room: string) =>
      (
        (await loadFromFirebase(room, KEY, null))!
          .elements as readonly OrderedExcalidrawElement[]
      )
        .map((e) => `${e.id}:${e.x}:${e.y}:${e.isDeleted ?? false}`)
        .sort();

    it("is ORDER-INDEPENDENT — A then B stores the same as B then A", async () => {
      const base = sharedBase([rect("e1", { x: 0, y: 0 })]);
      // The SAME two updates, replayed in both orders. Reusing the identical
      // bytes is the point: a difference in the result would then be the merge's
      // doing and nothing else.
      const a = replicaFrom(base, (scene) =>
        scene.replaceAllElements(
          scene
            .getElementsIncludingDeleted()
            .map((e) => ({ ...e, x: 100 })) as never,
        ),
      );
      const b = replicaFrom(base, (scene) =>
        scene.replaceAllElements(
          scene
            .getElementsIncludingDeleted()
            .map((e) => ({ ...e, y: 200 })) as never,
        ),
      );

      await saveDoc(portalForRoom("order-ab"), a);
      await saveDoc(portalForRoom("order-ab"), b);

      await saveDoc(portalForRoom("order-ba"), b);
      await saveDoc(portalForRoom("order-ba"), a);

      // Semantic result AND stored CRDT state must match: converging on the same
      // decoded values while holding different histories would diverge later.
      expect(await storedElements("order-ab")).toEqual(
        await storedElements("order-ba"),
      );
      expect(storedFingerprint("order-ab")).toBe(storedFingerprint("order-ba"));

      // GUARD (non-vacuity): both edits are actually present, so this is not two
      // empty stores agreeing.
      expect(await storedElements("order-ab")).toEqual(["e1:100:200:false"]);
    });

    it("is IDEMPOTENT in the stored CRDT state, not just in decoded values", async () => {
      const base = sharedBase([rect("e1", { x: 0, y: 0 })]);
      const update = replicaFrom(base, (scene) =>
        scene.replaceAllElements(
          scene
            .getElementsIncludingDeleted()
            .map((e) => ({ ...e, x: 42 })) as never,
        ),
      );

      // Distinct portals so the save-skip token cache cannot be what makes the
      // second save a no-op — the CRDT has to be.
      await saveDoc(portalForRoom("idem"), update);
      const first = storedFingerprint("idem");
      expect(first).not.toBeNull();

      await saveDoc(portalForRoom("idem"), update);

      expect(storedFingerprint("idem")).toBe(first);
      expect(await storedElements("idem")).toEqual(["e1:42:0:false"]);
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
      await saveScene(
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
      await saveScene(
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
   * INV-SAVE-SKIP (T007 RED → T026 GREEN) — `isSaved` must mean "everything in
   * the live document has reached the store".
   *
   * T007 measured the old summed-version cache broken in BOTH directions: it
   * compared live sums against sums of `restoreElements`-renormalised elements
   * (so every save was redundant), and a sum collides whenever one element's
   * version rises as much as another's falls (so a dirty scene could report
   * clean and be dropped with nothing to retry it). Both are gone now that the
   * token is the scene's monotonic `contentRevision`.
   */
  describe("INV-SAVE-SKIP", () => {
    it("reports saved immediately after a successful save", async () => {
      const portal = portalFor();
      const token = tok();
      const stored = await saveScene(
        portal,
        [rect("a"), rect("b")],
        appStateWith({}),
        {},
        token,
      );

      // GUARD: the save really happened, so a mismatch below is a live-vs-stored
      // failure and not an empty save.
      expect(stored).not.toBeNull();
      expect(stored!.map((e) => e.id).sort()).toEqual(["a", "b"]);

      expect(isSavedToFirebase(portal, token)).toBe(true);
    });

    it("skips the redundant save at the same token", async () => {
      const portal = portalFor();
      const token = tok();
      await saveScene(portal, [rect("a")], appStateWith({}), {}, token);

      // A second save at an unchanged token must not touch the store.
      expect(
        await saveScene(portal, [rect("a")], appStateWith({}), {}, token),
      ).toBe(null);
    });

    it("stays dirty when the document changed while the save was in flight", async () => {
      const portal = portalFor();
      // The save captured one token; by the time it completed the scene had
      // moved on. Recording the later one would mark a change never persisted.
      await saveScene(portal, [rect("a")], appStateWith({}), {}, tok());

      expect(isSavedToFirebase(portal, tok())).toBe(false);
    });

    it("stays dirty when the save FAILED", async () => {
      const portal = portalFor();
      const token = tok();

      faults.failTransaction = true;
      let failed = false;
      try {
        await saveScene(portal, [rect("a")], appStateWith({}), {}, token);
      } catch {
        failed = true;
      }
      faults.failTransaction = false;

      // GUARD (non-vacuity): the write really has to have failed, or this case
      // would be asserting against a save that quietly succeeded.
      expect(failed).toBe(true);

      // A failed save must never record its token as saved — doing so would drop
      // the content permanently, since nothing retries a "saved" scene.
      expect(isSavedToFirebase(portal, token)).toBe(false);

      // ...and the very next attempt at that same token must go through.
      expect(
        await saveScene(portal, [rect("a")], appStateWith({}), {}, token),
      ).not.toBeNull();
      expect(isSavedToFirebase(portal, token)).toBe(true);
    });

    it("treats an unknown socket as dirty, never as saved", async () => {
      // A room that was never saved must not report clean, or its first save
      // would be skipped and its content never persisted.
      expect(isSavedToFirebase(portalForRoom("never-saved"), tok())).toBe(
        false,
      );
    });

    /**
     * The cache is keyed by SOCKET, so it outlives the Scene: a reset replaces
     * the generation underneath it. A numeric revision is only monotonic within
     * one Scene — measured, two independent scenes both reached revision 2 — so
     * a save of the old generation would have marked the new one clean.
     */
    describe("across a generation swap", () => {
      it("does not report a REPLACED generation saved", async () => {
        const portal = portalFor();
        const generationA = new Scene();
        generationA.replaceAllElements([rect("a")]);
        await saveScene(
          portal,
          [rect("a")],
          appStateWith({}),
          {},
          generationA.contentToken,
        );
        expect(isSavedToFirebase(portal, generationA.contentToken)).toBe(true);

        // The scene is replaced and driven to the SAME number of edits.
        const generationB = new Scene();
        generationB.replaceAllElements([rect("b")]);

        expect(isSavedToFirebase(portal, generationB.contentToken)).toBe(false);
      });

      it("does not let an OLD generation's late save clean the new one", async () => {
        const portal = portalFor();
        const generationA = new Scene();
        generationA.replaceAllElements([rect("a")]);
        const capturedByA = generationA.contentToken;

        // The scene is replaced and edited while A's save is still in flight.
        const generationB = new Scene();
        generationB.replaceAllElements([rect("b")]);

        // A's save only now completes, caching the token IT captured.
        await saveScene(portal, [rect("a")], appStateWith({}), {}, capturedByA);

        // B's content was never persisted, so B must still be dirty.
        expect(isSavedToFirebase(portal, generationB.contentToken)).toBe(false);
      });
    });
  });
});
