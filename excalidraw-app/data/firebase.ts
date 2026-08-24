import { MIME_TYPES } from "@excalidraw-yjs/common";
import { decompressData } from "@excalidraw-yjs/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw-yjs/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw-yjs/excalidraw/data/restore";
import { getSceneVersion, decodeSnapshot } from "@excalidraw-yjs/element";
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

import { Scene } from "@excalidraw-yjs/element";

import type {
  SceneContentToken,
  APPSTATE_ALLOW_LIST,
} from "@excalidraw-yjs/element";

import type { ExcalidrawElement, FileId } from "@excalidraw-yjs/element/types";
import type {
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw-yjs/excalidraw/types";

import {
  DELETED_ELEMENT_TIMEOUT,
  FILE_CACHE_MAX_AGE_SEC,
} from "../app_constants";

import { getSyncableElements } from ".";

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

/**
 * Encrypt a whiteboard scene as Yjs **V2** doc bytes (native-Yjs core, M4).
 *
 * The stored document is the scene's own document — elements + asset references
 * + persistable appState in one doc — so what is persisted is byte-compatible
 * with what the editor and the collaboration wire speak.
 *
 * **Concurrent-save merge (T021).** When `priorDocBytes` is passed (the doc
 * already stored under this scene, read inside the same transaction) it is
 * FOLDED with the live update via `applyUpdateV2` into one scratch document, and
 * that is what gets encoded.
 *
 * This used to be a decoded VALUE merge, for a reason that was true then and is
 * false now. The stored doc used to be REBUILT from flat elements on every save,
 * so it carried a fresh `clientID` and shared no lineage with the live doc; a
 * Yjs fold across disjoint lineages is whole-element LWW by `clientID`, which
 * silently drops a concurrent edit and can resurrect a deletion. Since the wire
 * ships the live document (T032) and a cold load adopts the stored one (T020),
 * the two share lineage — so the fold is now the CORRECT merge and the value
 * merge is the lossy one: it could only do whole-element LWW, losing a
 * concurrent writer's edit to a different property of the same element.
 *
 * **Deletions, stated precisely** — the easy claim here would be wrong.
 * Excalidraw deletes SOFTLY: `isDeleted` is an ordinary element property, not a
 * Yjs delete, so Yjs's delete-set union does NOT protect it. What protects it is
 * that a deletion is normally an UNCONTESTED write to that property — the other
 * replica edits geometry or colour and never touches `isDeleted` — and an
 * uncontested per-property write always survives the fold. The old
 * `mergeStoredElements` deletion-union rule was compensating for whole-element
 * LWW, where any concurrent edit dragged the whole stale element along with it.
 *
 * The residual case is two replicas that genuinely BOTH write `isDeleted`
 * (one deleting while the other undoes a deletion). That is a real conflict and
 * the CRDT resolves it by `clientID`, not by save order — the same resolution
 * the live socket would give those two writes, which is the point: persistence
 * no longer has merge semantics of its own to disagree with.
 *
 * **Privacy / bounded growth** are likewise handled on the DOCUMENT rather than
 * by filtering one encoding of it: the fold can reintroduce tombstones the live
 * scene had already swept, so maintenance runs on the merged result — reclaiming
 * aged tombstones and asset references no live element points at. Asset bytes
 * cannot leak here at all: since T023 the document carries `fileId -> locator`
 * and never bytes, and every encode revalidates that.
 */
const encryptScene = async (
  key: string,
  /** The LIVE scene document as V2 bytes — lineage-bearing, not a rebuild. */
  docUpdate: Uint8Array,
  priorDocBytes?: Uint8Array,
): Promise<{
  ciphertext: ArrayBuffer;
  iv: Uint8Array;
  elements: readonly ExcalidrawElement[];
}> => {
  const doc = new Y.Doc();
  if (priorDocBytes && priorDocBytes.byteLength > 0) {
    Y.applyUpdateV2(doc, priorDocBytes);
  }
  Y.applyUpdateV2(doc, docUpdate);

  const merged = new Scene(null, { doc });
  merged.collectGarbage({
    deletedBefore: Date.now() - DELETED_ELEMENT_TIMEOUT,
  });
  const bytes = merged.encodeStateAsUpdate("v2") as Uint8Array<ArrayBuffer>;
  const elements =
    merged.getElementsIncludingDeleted() as unknown as readonly ExcalidrawElement[];
  merged.destroy();

  const { encryptedBuffer, iv } = await encryptData(key, bytes);

  return { ciphertext: encryptedBuffer, iv, elements };
};

/** A decrypted stored scene: the raw V2 doc bytes (so a save can MERGE against
 * them inside its transaction — see {@link encryptScene}) plus the decoded
 * elements + files + persistable appState. */
type DecryptedScene = {
  /** The decrypted plaintext = the stored doc as Yjs V2 bytes. */
  docBytes: Uint8Array;
  elements: readonly ExcalidrawElement[];
  assets: Record<string, string>;
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
  const { elements, assets, appState } = decodeSnapshot(docBytes);
  return {
    docBytes,
    elements: elements as unknown as readonly ExcalidrawElement[],
    assets,
    appState,
  };
};

/**
 * The scene `contentToken` (see `Scene.contentToken`) captured at the last
 * successful save, per socket.
 *
 * This replaces a cache of summed element `version`s, which T007 measured broken
 * in BOTH directions:
 *  - the sum was taken over elements returned through `restoreElements`, which
 *    RENORMALISES versions, so the cached and live sums never matched and every
 *    save was redundant (measured: live sum 10 stored as sum 4);
 *  - and a sum COLLIDES whenever one element's version rises as much as
 *    another's falls — which does happen here — so a genuinely dirty scene could
 *    report clean and be dropped with nothing to retry it.
 */
class FirebaseSavedRevisionCache {
  private static cache = new WeakMap<Socket, SceneContentToken>();
  static get = (socket: Socket) => {
    return FirebaseSavedRevisionCache.cache.get(socket);
  };
  static set = (socket: Socket, contentToken: SceneContentToken) => {
    FirebaseSavedRevisionCache.cache.set(socket, contentToken);
  };
}

/**
 * Whether the scene at `contentToken` has already been persisted.
 *
 * The caller passes the CURRENT token; identity equality means no
 * document-changing transaction has happened since the last successful save.
 * This cache is keyed by SOCKET and so outlives a Scene: a token from a
 * replaced generation can never compare equal to one from the old generation,
 * which a numeric counter could not guarantee.
 */
export const isSavedToFirebase = (
  portal: Portal,
  contentToken: SceneContentToken,
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    return FirebaseSavedRevisionCache.get(portal.socket) === contentToken;
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
  docUpdate: Uint8Array,
  roomKey: string,
  /** The already-stored doc's V2 bytes (read inside the save transaction); they
   * are `applyUpdateV2`-FOLDED with the live update over shared lineage, so a
   * concurrent writer's edit is not lost and no deletion is resurrected (T021). */
  priorDocBytes?: Uint8Array,
) => {
  const { ciphertext, iv, elements } = await encryptScene(
    roomKey,
    docUpdate,
    priorDocBytes,
  );
  return {
    // Still written as a field of the stored document (part of its schema), but
    // no longer the save-skip AUTHORITY — that is the scene's `contentToken`
    // (T026). A sum cannot decide "has anything changed": it collides, and the
    // values compared had been renormalised by `restoreElements`. Taken from the
    // MERGED result, so it describes what was actually stored.
    sceneVersion: getSceneVersion(elements),
    ciphertext: Bytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: Bytes.fromUint8Array(iv),
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  /**
   * The LIVE scene document as V2 bytes (T021).
   *
   * The whole document, not a decoded snapshot: elements, asset references and
   * the persistable appState all live on it, so nothing else needs passing, and
   * critically it carries LINEAGE — which is what lets the concurrent-save merge
   * be a real per-property CRDT fold instead of whole-element last-writer-wins.
   */
  docUpdate: Uint8Array,
  /**
   * The scene's `contentToken` AT THE MOMENT `docUpdate` was captured — see
   * `Scene.contentToken`.
   *
   * It is recorded as saved only on success, and only as this value: anything
   * that changed the document while the save was in flight — including a
   * generation swap — replaced the live token, so the scene correctly stays
   * dirty and the next pass persists it. Reading the token after the await
   * instead would mark that concurrent change saved when it never was.
   */
  contentToken: SceneContentToken,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, contentToken)
  ) {
    return null;
  }

  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);

  // Native-Yjs core (M4 — persistence cutover): the stored scene document is the
  // scene's document encoded to Yjs V2 bytes (elements + asset references +
  // persistable appState, `getMap("elements"/"files"/"appState")`), NOT an
  // element-JSON snapshot.
  //
  // The live socket converges PEERS, but the FIREBASE store is a separate
  // replica: two clients can each commit a save built from a view that had not
  // yet seen the other's committed write. So we MERGE inside the transaction —
  // read the stored doc bytes and `applyUpdateV2`-FOLD them with the live update
  // (T021).
  //
  // This was a decoded VALUE merge, for a reason that was true then and is false
  // now: the stored doc used to be REBUILT from flat elements on every save, so
  // it shared no lineage with the live doc, and a fold across disjoint lineages
  // is whole-element LWW by `clientID`. Since the wire ships the live document
  // (T032) and a cold load adopts the stored one (T020), the two share lineage —
  // so the fold is the correct merge and the value merge is now the lossy one,
  // able only to take one side's whole element when the two edited different
  // properties of it. How SOFT deletion behaves under the fold is set out on
  // `encryptScene` — it is not delete-set union, and the difference matters.
  const storedScene = await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(docRef);

    let priorDocBytes: Uint8Array | undefined;
    if (snapshot.exists()) {
      // Decrypt the already-stored doc to its raw V2 bytes so the live update can
      // be folded against it (not blindly overwritten).
      const prior = await decryptScene(
        snapshot.data() as FirebaseStoredScene,
        roomKey,
      );
      priorDocBytes = prior.docBytes;
    }

    const storedScene = await createFirebaseSceneDocument(
      docUpdate,
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

  FirebaseSavedRevisionCache.set(socket, contentToken);

  return storedElements;
};

/** What a cold load yields: the converged elements PLUS the persisted files and
 * the persistable appState subset (`viewBackgroundColor` / `name`). The appState
 * was previously dropped on load, so a solo cold-load reopened with default
 * background/name; carrying it through restores the saved scene faithfully. */
export type LoadedFirebaseScene = {
  /** The stored document's raw V2 bytes.
   *
   * This is what a cold load should ADOPT (T020): applying it into the live
   * Scene doc keeps the persisted CRDT lineage, where rebuilding a scene from
   * the decoded `elements` below starts a fresh lineage and loses it. Adopting
   * it also carries the asset references in as a side effect, which is what
   * makes a persisted image resolvable after a reload.
   *
   * `elements` / `assets` / `appState` remain for callers that genuinely want
   * the decoded snapshot (the version cache, tests, non-adopting consumers). */
  docBytes: Uint8Array;
  elements: readonly SyncableExcalidrawElement[];
  assets: Record<string, string>;
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

  // Deliberately NOT marking the room saved here. Since T020 a cold load ADOPTS
  // the stored document into the live scene, and that adoption is itself a
  // document-changing transaction that happens AFTER this function returns — so
  // no token known here corresponds to the post-adoption scene. Guessing one
  // would risk the dangerous direction (a false-skip: a dirty scene reported
  // clean, dropped with nothing to retry it). The cost of omitting it is one
  // redundant save after a cold load, which is the harmless direction.

  return {
    docBytes: decrypted.docBytes,
    elements,
    assets: decrypted.assets,
    appState: decrypted.appState,
  };
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
