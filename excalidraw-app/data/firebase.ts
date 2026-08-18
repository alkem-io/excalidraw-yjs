import { MIME_TYPES } from "@excalidraw-yjs/common";
import { decompressData } from "@excalidraw-yjs/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw-yjs/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw-yjs/excalidraw/data/restore";
import {
  getSceneVersion,
  buildSnapshotDoc,
  decodeSnapshot,
  APPSTATE_ALLOW_LIST,
} from "@excalidraw-yjs/element";
import { initializeApp } from "firebase/app";
import * as Y from "yjs";
import {
  getFirestore,
  doc,
  getDoc,
  runTransaction,
  Bytes,
} from "firebase/firestore";
import { getStorage, ref, uploadBytes } from "firebase/storage";

import type { FileRecord } from "@excalidraw-yjs/element";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
  DataURL,
} from "@excalidraw-yjs/excalidraw/types";

import {
  DELETED_ELEMENT_TIMEOUT,
  FILE_CACHE_MAX_AGE_SEC,
} from "../app_constants";

import { filterReferencedFiles, getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// private
// -----------------------------------------------------------------------------

let FIREBASE_CONFIG: Record<string, any>;
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

let firebaseApp: ReturnType<typeof initializeApp> | null = null;
let firestore: ReturnType<typeof getFirestore> | null = null;
let firebaseStorage: ReturnType<typeof getStorage> | null = null;

const _initializeFirebase = () => {
  if (!firebaseApp) {
    firebaseApp = initializeApp(FIREBASE_CONFIG);
  }
  return firebaseApp;
};

const _getFirestore = () => {
  if (!firestore) {
    firestore = getFirestore(_initializeFirebase());
  }
  return firestore;
};

const _getStorage = () => {
  if (!firebaseStorage) {
    firebaseStorage = getStorage(_initializeFirebase());
  }
  return firebaseStorage;
};

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  return _getStorage();
};

type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Bytes;
  ciphertext: Bytes;
};

/** The persistable appState subset (`APPSTATE_ALLOW_LIST` — background + name)
 * carried in the snapshot doc; everything else in appState is local-only and is
 * never persisted (native-Yjs core, M4). */
const pickPersistableAppState = (
  appState: AppState,
): Partial<Record<typeof APPSTATE_ALLOW_LIST[number], unknown>> => {
  const out: Partial<Record<typeof APPSTATE_ALLOW_LIST[number], unknown>> = {};
  for (const key of APPSTATE_ALLOW_LIST) {
    const value = (appState as unknown as Record<string, unknown>)[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

/** An element decoded from a stored doc (carries at least `id`/`isDeleted`). */
type MergeableElement = Record<string, unknown> & {
  id: string;
  isDeleted?: boolean;
  updated?: number;
};

const isDeletedElement = (el: MergeableElement): boolean =>
  el.isDeleted === true;

/**
 * Merge the live element set with the already-stored (prior) one for a concurrent
 * save (findings #2). This is **NOT** a Yjs `applyUpdateV2` merge and deliberately
 * so: the stored doc is a SEPARATE replica built by an earlier `buildSnapshotDoc`
 * (its own random `clientID`), and the live save hands us a plain element ARRAY,
 * not the live `scene.doc`. The fresh save doc, the prior stored doc, and the live
 * `scene.doc` therefore occupy three DISJOINT `clientID` spaces with no common
 * ancestor item for any shared element id. `applyUpdateV2(freshDoc, priorBytes)`
 * across disjoint lineages is whole-element-`Y.Map` LWW by `clientID` tiebreak —
 * for any id in both docs Yjs keeps one nested map and tombstones the other,
 * dropping the loser's whole element (verified against yjs 13.6.31). That silently
 * drops a concurrent edit AND can RESURRECT a deletion (a stored `isDeleted:false`
 * winning the tiebreak over a live `isDeleted:true`). A plain element array also
 * carries no per-property delta (it is the element's whole last-known state, never
 * "just the keys I changed"), so a true per-property CRDT merge is not recoverable
 * here — that fidelity exists only inside the live `Y.Doc` and is lost on
 * serialization to the syncable array the socket/save speak.
 *
 * So we merge at the decoded VALUE level with two guarantees:
 *  - **Deletion-union (no resurrection, both directions):** if an id is deleted on
 *    EITHER side, the result is deleted. A live delete is never resurrected by a
 *    stale stored alive, and a stored delete (one this replica never saw) is not
 *    revived by the live alive. Deletions are monotone, so the store converges
 *    regardless of which replica saved last.
 *  - **Disjoint union + whole-element LWW:** an id only one side has is kept (a
 *    racing writer's new element survives). For an id BOTH sides hold and neither
 *    deleted, the LIVE record wins as a whole — last-writer-wins by element, the
 *    saving replica's current view. (Per-property merge is the live `Y.Doc`'s job;
 *    once flattened to an array only whole-element LWW is sound.)
 *
 * A stored tombstone older than {@link DELETED_ELEMENT_TIMEOUT} is dropped (its
 * deletion has fully propagated; keeping it would re-broadcast stale content);
 * in-window tombstones are retained so the deletion still reaches peers.
 */
const mergeStoredElements = (
  live: readonly MergeableElement[],
  prior: readonly MergeableElement[],
): MergeableElement[] => {
  const now = Date.now();
  const isExpiredTombstone = (el: MergeableElement): boolean =>
    isDeletedElement(el) &&
    typeof el.updated === "number" &&
    el.updated <= now - DELETED_ELEMENT_TIMEOUT;

  const byId = new Map<string, MergeableElement>();
  for (const el of prior) {
    if (isExpiredTombstone(el)) {
      continue;
    }
    byId.set(el.id, el);
  }
  for (const el of live) {
    const priorEl = byId.get(el.id);
    if (!priorEl) {
      byId.set(el.id, el);
      continue;
    }
    if (isDeletedElement(el) || isDeletedElement(priorEl)) {
      // deletion-union: the deleted record wins so its tombstone (and the
      // `updated` that drives the timeout) survives. If both deleted, prefer live.
      byId.set(el.id, isDeletedElement(el) ? el : priorEl);
    } else {
      byId.set(el.id, el); // both alive: whole-element LWW, saving replica wins
    }
  }
  return [...byId.values()];
};

/**
 * Encrypt a whiteboard scene as Yjs **V2** doc bytes (native-Yjs core, M4).
 *
 * The stored scene document is the WHOLE doc — elements + files + persistable
 * appState in the one doc, `getMap("elements"/"files"/"appState")` — encoded via
 * `encodeStateAsUpdateV2`, NOT a `JSON.stringify(elements)` element snapshot. This
 * is byte-identical to the format the Alkemio server / collab-service stores, so
 * a doc the editor persists is exactly what the backend stores. The encryption
 * envelope is unchanged; only the plaintext is now Yjs bytes instead of JSON.
 *
 * Two boundary guarantees the raw-doc encode lacked:
 *  - **File prune (privacy):** only files referenced by a LIVE element are stored;
 *    a pasted-then-deleted image's binary is dropped (`filterReferencedFiles`),
 *    evaluated against the MERGED element set so a concurrent writer's still-live
 *    image keeps its binary while a deleted-image binary stays out.
 *  - **Concurrent-save merge (no lost update / no resurrection):** when
 *    `priorDocBytes` is passed (the doc already stored under this scene, read
 *    inside the same transaction), it is DECODED and value-merged with the live
 *    element/file/appState set via {@link mergeStoredElements} before a single
 *    clean doc is built and encoded — it is NOT `applyUpdateV2`-folded into the
 *    live doc (that is whole-element LWW by `clientID` across the docs' disjoint
 *    lineages, which silently drops a concurrent edit and can resurrect a
 *    deletion — see {@link mergeStoredElements}). The value merge guarantees
 *    deletions union (a delete on either side wins) and that a racing writer's
 *    disjoint element survives; concurrent edits to the SAME live element resolve
 *    last-writer-wins by whole element (the saving replica), not per-property. The
 *    merge is order-independent + idempotent on the union, so the store converges
 *    regardless of write order.
 */
const encryptScene = async (
  key: string,
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  appState: AppState,
  priorDocBytes?: Uint8Array,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  let mergedElements = elements as unknown as readonly MergeableElement[];
  let mergedFiles = files as unknown as Record<string, FileRecord>;
  let mergedAppState = pickPersistableAppState(appState);

  if (priorDocBytes && priorDocBytes.byteLength > 0) {
    const prior = decodeSnapshot(priorDocBytes);
    mergedElements = mergeStoredElements(
      mergedElements,
      prior.elements as readonly MergeableElement[],
    );
    // Union the file maps, then prune to those a LIVE merged element references
    // below (a prior-only image still pointed at by a surviving element keeps its
    // binary; a deleted-image binary is dropped). Live wins on a fileId collision.
    mergedFiles = { ...prior.files, ...mergedFiles };
    // appState: live values win for the keys it carries; fall back to the stored
    // value for any allow-listed key the live save omitted (never clobber a stored
    // background/name with a partial update). Mirrors finding #4's carry-through.
    mergedAppState = { ...prior.appState, ...mergedAppState };
  }

  const doc = buildSnapshotDoc({
    elements: mergedElements as unknown as readonly Record<string, unknown>[],
    files: filterReferencedFiles(
      mergedFiles,
      mergedElements as unknown as readonly OrderedExcalidrawElement[],
    ),
    appState: mergedAppState,
  });
  const bytes = Y.encodeStateAsUpdateV2(doc) as Uint8Array<ArrayBuffer>;
  doc.destroy();
  const { encryptedBuffer, iv } = await encryptData(key, bytes);

  return { ciphertext: encryptedBuffer, iv };
};

/** A decrypted stored scene: the raw V2 doc bytes (so a save can MERGE against
 * them inside its transaction — see {@link encryptScene}) plus the decoded
 * elements + files + persistable appState. */
type DecryptedScene = {
  /** The decrypted plaintext = the stored doc as Yjs V2 bytes. */
  docBytes: Uint8Array;
  elements: readonly ExcalidrawElement[];
  files: Record<string, FileRecord>;
  appState: Partial<Record<typeof APPSTATE_ALLOW_LIST[number], unknown>>;
};

/**
 * Decrypt a stored scene document (native-Yjs core, M4).
 *
 * The plaintext is Yjs **V2** doc bytes (see {@link encryptScene}); decode it via
 * `decodeSnapshot` and return the WHOLE whiteboard — elements AND files AND the
 * persistable appState subset (`viewBackgroundColor` / `name`), not just elements.
 * The raw `docBytes` are also returned so a concurrent save can merge against the
 * stored doc, and so the persisted background/name survive a solo cold load
 * (previously dropped here, so reopening fell back to defaults).
 */
const decryptScene = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<DecryptedScene> => {
  const ciphertext = data.ciphertext.toUint8Array() as Uint8Array<ArrayBuffer>;
  const iv = data.iv.toUint8Array() as Uint8Array<ArrayBuffer>;

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const docBytes = new Uint8Array(decrypted);
  const { elements, files, appState } = decodeSnapshot(docBytes);
  return {
    docBytes,
    elements: elements as unknown as readonly ExcalidrawElement[],
    files,
    appState,
  };
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const storage = await loadFirebaseStorage();

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const storageRef = ref(storage, `${prefix}/${id}`);
        await uploadBytes(storageRef, buffer, {
          cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
        });
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  files: BinaryFiles,
  appState: AppState,
  roomKey: string,
  /** The already-stored doc's V2 bytes (read inside the save transaction); they
   * are DECODED and value-merged with the live set (`mergeStoredElements`) so a
   * concurrent writer's element is not lost and no deletion is resurrected. */
  priorDocBytes?: Uint8Array,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptScene(
    roomKey,
    elements,
    files,
    appState,
    priorDocBytes,
  );
  return {
    sceneVersion,
    ciphertext: Bytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: Bytes.fromUint8Array(iv),
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles = {},
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);

  // Native-Yjs core (M4 — persistence cutover): the stored scene document is the
  // scene's content encoded to Yjs V2 bytes (elements + files + persistable
  // appState in the one doc, `getMap("elements"/"files"/"appState")`), NOT an
  // element-JSON snapshot. The local live socket (M3 — Yjs CRDT merge) converges
  // PEERS, but the FIREBASE store is a separate replica: two clients can each
  // commit a save built from a view that had not yet seen the other's committed
  // write. So we MERGE inside the transaction — read the stored doc bytes, DECODE
  // them, and value-merge with the live element/file/appState set before encoding
  // a single clean doc (`createFirebaseSceneDocument` → `encryptScene` →
  // `mergeStoredElements`). This is a decoded VALUE merge, not a Yjs
  // `applyUpdateV2` fold: the stored doc, the freshly-built save doc, and the live
  // `scene.doc` are three replicas in DISJOINT `clientID` spaces, so a Yjs merge
  // across them would be whole-element LWW by `clientID` — silently dropping a
  // concurrent edit and able to resurrect a deletion (see `mergeStoredElements`).
  // The value merge instead guarantees deletions union (no resurrection, either
  // direction) and that a racing writer's disjoint element survives; it is
  // order-independent + idempotent on the union, so the store converges.
  const storedScene = await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(docRef);

    let priorDocBytes: Uint8Array | undefined;
    if (snapshot.exists()) {
      // Decrypt the already-stored doc to its raw V2 bytes so the live set can be
      // value-merged against it (not blindly overwritten).
      const prior = await decryptScene(
        snapshot.data() as FirebaseStoredScene,
        roomKey,
      );
      priorDocBytes = prior.docBytes;
    }

    const storedScene = await createFirebaseSceneDocument(
      elements,
      files,
      appState,
      roomKey,
      priorDocBytes,
    );

    if (!snapshot.exists()) {
      transaction.set(docRef, storedScene);
    } else {
      transaction.update(docRef, storedScene);
    }

    return storedScene;
  });

  const storedElements = getSyncableElements(
    restoreElements((await decryptScene(storedScene, roomKey)).elements, null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

/** What a cold load yields: the converged elements PLUS the persisted files and
 * the persistable appState subset (`viewBackgroundColor` / `name`). The appState
 * was previously dropped on load, so a solo cold-load reopened with default
 * background/name; carrying it through restores the saved scene faithfully. */
export type LoadedFirebaseScene = {
  elements: readonly SyncableExcalidrawElement[];
  files: Record<string, FileRecord>;
  appState: Partial<Record<typeof APPSTATE_ALLOW_LIST[number], unknown>>;
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<LoadedFirebaseScene | null> => {
  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return null;
  }
  const storedScene = docSnap.data() as FirebaseStoredScene;
  const decrypted = await decryptScene(storedScene, roomKey);
  const elements = getSyncableElements(
    restoreElements(decrypted.elements, null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return { elements, files: decrypted.files, appState: decrypted.appState };
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `https://firebasestorage.googleapis.com/v0/b/${
          FIREBASE_CONFIG.storageBucket
        }/o/${encodeURIComponent(prefix.replace(/^\//, ""))}%2F${id}`;
        const response = await fetch(`${url}?alt=media`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
