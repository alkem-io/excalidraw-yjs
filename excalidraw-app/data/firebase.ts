import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import {
  getSceneVersion,
  encodeSnapshot,
  decodeSnapshot,
  APPSTATE_ALLOW_LIST,
} from "@excalidraw/element";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  runTransaction,
  Bytes,
} from "firebase/firestore";
import { getStorage, ref, uploadBytes } from "firebase/storage";

import type { FileRecord } from "@excalidraw/element";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";

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

/**
 * Encrypt a whiteboard scene as Yjs **V2** doc bytes (native-Yjs core, M4).
 *
 * The stored scene document is the WHOLE doc — elements + files + persistable
 * appState in the one doc, `getMap("elements"/"files"/"appState")` — encoded via
 * `encodeStateAsUpdateV2`, NOT a `JSON.stringify(elements)` element snapshot. This
 * is byte-identical to the format the Alkemio server / collab-service stores, so
 * a doc the editor persists is exactly what the backend stores. The encryption
 * envelope is unchanged; only the plaintext is now Yjs bytes instead of JSON.
 */
const encryptScene = async (
  key: string,
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  appState: AppState,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const bytes = encodeSnapshot({
    elements: elements as unknown as readonly Record<string, unknown>[],
    files: files as unknown as Record<string, FileRecord>,
    appState: pickPersistableAppState(appState),
  }) as Uint8Array<ArrayBuffer>;
  const { encryptedBuffer, iv } = await encryptData(key, bytes);

  return { ciphertext: encryptedBuffer, iv };
};

/**
 * Decrypt a stored scene document back into its elements (native-Yjs core, M4).
 *
 * The plaintext is Yjs **V2** doc bytes (see {@link encryptScene}); decode it via
 * `applyUpdateV2` and read the elements out of `getMap("elements")` — there is no
 * `JSON.parse(elements)` any more. Files/appState are also in the decoded doc;
 * the elements are what the existing scene-load path consumes, so that is what we
 * return (the app refreshes files via its separate image-load throttle).
 */
const decryptScene = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext.toUint8Array() as Uint8Array<ArrayBuffer>;
  const iv = data.iv.toUint8Array() as Uint8Array<ArrayBuffer>;

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const { elements } = decodeSnapshot(new Uint8Array(decrypted));
  return elements as unknown as readonly ExcalidrawElement[];
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
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptScene(
    roomKey,
    elements,
    files,
    appState,
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
  // scene's `Y.Doc` encoded to Yjs V2 bytes (elements + files + persistable
  // appState in the one doc, `getMap("elements"/"files"/"appState")`), NOT an
  // element-JSON snapshot. Collaboration already converged the doc (M3 — Yjs CRDT
  // merge), so by save time `elements` reflects the merged scene; there is no
  // `reconcileElements` merge. We still run the write in a transaction for
  // atomicity, but it is a plain set/update of the current doc bytes.
  const storedScene = await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(docRef);

    const storedScene = await createFirebaseSceneDocument(
      elements,
      files,
      appState,
      roomKey,
    );

    if (!snapshot.exists()) {
      transaction.set(docRef, storedScene);
    } else {
      transaction.update(docRef, storedScene);
    }

    return storedScene;
  });

  const storedElements = getSyncableElements(
    restoreElements(await decryptScene(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return null;
  }
  const storedScene = docSnap.data() as FirebaseStoredScene;
  const elements = getSyncableElements(
    restoreElements(await decryptScene(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
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
