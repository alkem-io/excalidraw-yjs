import {
  CaptureUpdateAction,
  zoomToFitBounds,
} from "@excalidraw-yjs/excalidraw";
import { ErrorDialog } from "@excalidraw-yjs/excalidraw/components/ErrorDialog";
import { APP_NAME, cloneJSON, EVENT, randomId } from "@excalidraw-yjs/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  assertNever,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw-yjs/common";
import { decryptData } from "@excalidraw-yjs/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw-yjs/element";
import { newElementWith } from "@excalidraw-yjs/element";
import {
  isImageElement,
  isInitializedImageElement,
} from "@excalidraw-yjs/element";
import { AbortError } from "@excalidraw-yjs/excalidraw/errors";
import { t } from "@excalidraw-yjs/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw-yjs/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import type { ImportedDataState } from "@excalidraw-yjs/excalidraw/data/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";
import type {
  BinaryFileData,
  ExcalidrawNativeInitialDataState,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
} from "@excalidraw-yjs/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw-yjs/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  DELETED_ELEMENT_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
  WS_EVENTS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../data";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { FileStatusStore } from "../data/fileStatusStore";
import { LocalData } from "../data/LocalData";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import { resetBrowserStateVersions } from "../data/tabSync";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";

import type {
  SocketUpdateData,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
  broadcastEmojiReaction: CollabInstance["broadcastEmojiReaction"];
  broadcastCountdownTimer: CollabInstance["broadcastCountdownTimer"];
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;
  /**
   * Interval that drives the periodic full-scene resync safety net (native-Yjs
   * core, M3). The resync re-broadcasts the FULL doc state so a peer that dropped
   * an incremental update still converges; it must fire on a TIME interval,
   * independent of edit activity, NOT once per local edit (that turned every
   * edit-burst into an O(scene) re-send). Set in `startCollaboration`, cleared +
   * nulled wherever the socket/broadcast is torn down.
   */
  private sceneResyncIntervalId: number | null = null;

  private socketInitializationTimer?: number;
  /**
   * Detaches the `doc.on("update")` subscription that broadcasts this replica's
   * local Yjs updates (native-Yjs core, M3). Set in `startCollaboration`, called
   * + nulled wherever the socket is torn down so a left/remounted room never
   * double-broadcasts.
   */
  private detachDocBroadcast: (() => void) | null = null;
  private collaborators = new Map<SocketId, Collaborator>();

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
    };
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  private onUmmount: (() => void) | null = null;

  // Broadcast an ephemeral floating emoji reaction to other clients
  broadcastEmojiReaction = async (emoji: string, x: number, y: number) => {
    try {
      const data = {
        type: WS_SUBTYPES.EMOJI_REACTION,
        payload: {
          emoji,
          x,
          y,
          id: `${this.portal.roomId}_${randomId()}_${Date.now()}`,
        },
      } as SocketUpdateData;
      // use volatile channel so reactions don't get queued behind more important updates like scene updates or cursor movements
      await this.portal._broadcastSocketData(data, true);
    } catch (e) {
      console.error(e);
    }
  };

  // Broadcast countdown timer state to other clients
  broadcastCountdownTimer = async (
    remainingSeconds: number,
    startedBy: string,
    active: boolean,
  ) => {
    try {
      const data = {
        type: WS_SUBTYPES.COUNTDOWN_TIMER,
        payload: {
          remainingSeconds,
          startedBy,
          active,
        },
      } as SocketUpdateData;
      await this.portal._broadcastSocketData(data, true);
    } catch (e) {
      console.error(e);
    }
  };

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.portal.socket && this.portal.broadcastUserFollowed(payload);
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
      broadcastEmojiReaction: this.broadcastEmojiReaction,
      broadcastCountdownTimer: this.broadcastCountdownTimer,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (isTestEnv() || isDevEnv()) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    // Safety net: detach the scene-doc broadcast subscription on unmount in case
    // the socket teardown path (which also detaches) didn't run (native-Yjs core, M3).
    this.detachDocBroadcast?.();
    this.detachDocBroadcast = null;
    // Safety net: stop the periodic full-scene resync interval on unmount in case
    // the socket teardown path (which also clears it) didn't run (native-Yjs core, M3).
    if (this.sceneResyncIntervalId !== null) {
      window.clearInterval(this.sceneResyncIntervalId);
      this.sceneResyncIntervalId = null;
    }
    this.onUmmount?.();
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !isSavedToFirebase(
          this.portal,
          this.excalidrawAPI.getSceneContentToken(),
        ))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    syncableElements = cloneJSON(syncableElements);
    // Captured BEFORE the await, alongside the state being saved: anything that
    // changes the doc while the save is in flight — a peer edit, or a whole
    // generation swap — replaces the live token, so the scene correctly stays
    // dirty (T026).
    const contentToken = this.excalidrawAPI.getSceneContentToken();
    try {
      // Persistence only — the scene `Y.Doc` is the source of truth and already
      // holds the merged state, so there is nothing to reconcile back in from
      // what Firebase stored. Native-Yjs core (M4): the stored scene document is
      // the doc encoded to Yjs V2 bytes (elements + ASSET REFERENCES + persistable
      // appState), not element JSON. What travels is `fileId -> locator` (T023);
      // the image bytes never enter the document and are stored by the host's
      // asset store instead.
      await saveToFirebase(
        this.portal,
        this.excalidrawAPI.encodeSceneStateAsUpdate("v2"),
        contentToken,
      );

      this.resetErrorIndicator();
    } catch (error: any) {
      const errorMessage = /is longer than.*?bytes/.test(error.message)
        ? t("errors.collabSaveFailed_sizeExceeded")
        : t("errors.collabSaveFailed");

      if (
        !this.state.dialogNotifiedErrors[errorMessage] ||
        !this.isCollaborating()
      ) {
        this.setErrorDialog(errorMessage);
        this.setState({
          dialogNotifiedErrors: {
            ...this.state.dialogNotifiedErrors,
            [errorMessage]: true,
          },
        });
      }

      if (this.isCollaborating()) {
        this.setErrorIndicator(errorMessage);
      }

      console.error(error);
    }
  };

  stopCollaboration = (keepRemoteState = true) => {
    this.queueBroadcastSceneResync.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    // Stop broadcasting this replica's local Yjs updates (native-Yjs core, M3) —
    // the socket is going away, so detach the scene-doc `update` subscription so a
    // left/remounted room never double-broadcasts.
    this.detachDocBroadcast?.();
    this.detachDocBroadcast = null;
    // Stop the periodic full-scene resync interval too — the socket is gone, so a
    // resync would be a no-op (guarded by `isOpen()`), but leaving the timer
    // running would leak across a left/remounted room (native-Yjs core, M3).
    if (this.sceneResyncIntervalId !== null) {
      window.clearInterval(this.sceneResyncIntervalId);
      this.sceneResyncIntervalId = null;
    }
    this.portal.close();
    this.fileManager.reset();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array<ArrayBuffer>,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ) => {
    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    if (this.portal.socket) {
      return null;
    }

    let roomId;
    let roomKey;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    // TODO: `ImportedDataState` type here seems abused
    //
    // T020: a cold load resolves the NATIVE form (an encoded document to adopt)
    // instead of a record snapshot, so this carries both alternatives — the same
    // mutually-exclusive pair the editor's `initialData` accepts.
    const scenePromise = resolvablePromise<
      | (ImportedDataState & {
          elements: readonly OrderedExcalidrawElement[];
          encodedScene?: never;
        })
      | ExcalidrawNativeInitialDataState
      | null
    >();

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const { default: socketIOClient } = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
    );

    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      this.portal.socket = this.portal.open(
        socketIOClient(import.meta.env.VITE_APP_WS_SERVER_URL, {
          transports: ["websocket", "polling"],
        }),
        roomId,
        roomKey,
      );

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error: any) {
      console.error(error);
      this.setErrorDialog(error.message);
      return null;
    }

    if (existingRoomLinkData) {
      // when joining existing room, don't merge it with current scene data
      this.excalidrawAPI.resetScene();
    } else {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      this.saveCollabRoomToFirebase(getSyncableElements(elements));
    }

    // Subscribe to local logical updates and broadcast them to the room.
    //
    // The origin policy lives in ONE place — the editor's transport boundary — so
    // there is deliberately no filtering here. `onLocalSceneUpdate` already
    // withholds a remote apply (no echo) and delivers a create's structural pass
    // and reveal as a single update rather than a leaked tombstone. A local reset
    // never arrives here at all, because it replaces the Scene generation instead
    // of writing to the shared doc. Re-implementing any of that here would be a
    // second copy of the policy, free to drift.
    this.detachDocBroadcast = this.excalidrawAPI.onLocalSceneUpdate(
      (update: Uint8Array) => {
        if (this.portal.isOpen()) {
          void this.portal.broadcastSceneUpdate(WS_SUBTYPES.UPDATE, update);
        }
      },
    );

    // Periodic full-scene resync safety net (native-Yjs core, M3). It re-broadcasts
    // the FULL doc state as a WS_SUBTYPES.UPDATE so a peer that dropped an
    // incremental update still converges. It is driven by a TIME interval here —
    // independent of edit activity — NOT scheduled from `onDocUpdate`: doing the
    // latter (via the leading-edge throttle) fired a full O(scene) re-send on the
    // first edit of every burst, on top of the incremental update. Guarded by
    // `isOpen()` so it is a no-op while the socket is down.
    if (this.sceneResyncIntervalId !== null) {
      window.clearInterval(this.sceneResyncIntervalId);
    }
    this.sceneResyncIntervalId = window.setInterval(() => {
      if (this.portal.isOpen()) {
        void this.portal.broadcastSceneResync();
      }
    }, SYNC_FULL_SCENE_INTERVAL_MS);

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
        if (!this.portal.roomKey) {
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            if (!this.portal.socketInitialized) {
              this.initializeRoom({ fetchScene: false });
              // INIT carries a full-scene seed as Yjs bytes, encoded from the
              // sender's LIVE doc (T032), so it carries real lineage: applying it
              // merges per-property with whatever we already hold, and nothing
              // concurrent is lost or resurrected.
              const update = new Uint8Array(decryptedData.payload.update);
              this.applyRemoteSceneUpdate(update);
              // The doc now holds the merged state — resolve with the current
              // scene elements. Noop if already resolved via init from firebase.
              scenePromise.resolve({
                elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
                scrollToContent: true,
              });
            }
            break;
          }
          case WS_SUBTYPES.UPDATE: {
            // Native-Yjs core (M3): UPDATE carries an incremental Yjs update a
            // peer originated. Apply its bytes to our doc.
            const update = new Uint8Array(decryptedData.payload.update);
            this.applyRemoteSceneUpdate(update);
            break;
          }
          case WS_SUBTYPES.MOUSE_LOCATION: {
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;

            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            this.updateCollaborator(socketId, {
              pointer,
              button,
              selectedElementIds,
              username,
            });

            break;
          }

          case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
            const { sceneBounds, socketId } = decryptedData.payload;

            const appState = this.excalidrawAPI.getAppState();

            // we're not following the user
            // (shouldn't happen, but could be late message or bug upstream)
            if (appState.userToFollow?.socketId !== socketId) {
              console.warn(
                `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
              );
              return;
            }

            // cross-follow case, ignore updates in this case
            if (
              appState.userToFollow &&
              appState.followedBy.has(appState.userToFollow.socketId)
            ) {
              return;
            }

            this.excalidrawAPI.updateScene({
              appState: zoomToFitBounds({
                appState,
                bounds: sceneBounds,
                fitToViewport: true,
                viewportZoomFactor: 1,
              }).appState,
            });

            break;
          }

          case WS_SUBTYPES.EMOJI_REACTION: {
            try {
              const { emoji, x, y, id } = decryptedData.payload;
              // forward to Excalidraw to display (optional subscriber)
              this.excalidrawAPI?.dispatchIncomingEmojiReaction?.({
                id: id || `${decryptedData.type}_${Date.now()}`,
                emoji,
                x,
                y,
              });
            } catch (e) {
              console.error(e);
            }
            break;
          }

          case WS_SUBTYPES.COUNTDOWN_TIMER: {
            try {
              const { remainingSeconds, startedBy, active } =
                decryptedData.payload;
              this.excalidrawAPI?.dispatchIncomingCountdownTimer?.({
                remainingSeconds,
                startedBy,
                active,
              });
            } catch (e) {
              console.error(e);
            }
            break;
          }

          case WS_SUBTYPES.IDLE_STATUS: {
            const { userState, socketId, username } = decryptedData.payload;
            this.updateCollaborator(socketId, {
              userState,
              username,
            });
            break;
          }

          default: {
            assertNever(decryptedData, null);
          }
        }
      },
    );

    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      const sceneData = await this.initializeRoom({
        fetchScene: true,
        roomLinkData: existingRoomLinkData,
      });
      scenePromise.resolve(sceneData);
    });

    this.portal.socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.excalidrawAPI.updateScene({
          appState: { followedBy: new Set(followedBy) },
        });

        this.relayVisibleSceneBounds({ force: true });
      },
    );

    this.initializeIdleDetector();

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket) {
      this.excalidrawAPI.resetScene();

      try {
        const loaded = await loadFromFirebase(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
        if (loaded) {
          // T020 — ADOPT the stored document rather than rebuilding a scene from
          // its decoded records. Rebuilding starts a fresh CRDT lineage and
          // loses the persisted history; adopting keeps it, and carries the
          // `fileId -> locator` asset references into the live scene as a side
          // effect, which is what makes a persisted image resolvable after a
          // reload.
          //
          // No `elements` / `files` here — they are the mutually exclusive
          // record form. Everything collaborative (elements, the persisted
          // appState subset, asset references) is derived from the adopted doc;
          // the bytes behind each reference resolve through the asset adapter.
          return {
            encodedScene: { update: loaded.docBytes, format: "v2" as const },
            scrollToContent: true,
          };
        }
      } catch (error: any) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      } finally {
        this.portal.socketInitialized = true;
      }
    } else {
      this.portal.socketInitialized = true;
    }
    return null;
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } =
      await this.fetchImageFilesFromFirebase({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  /**
   * Apply a remote peer's Yjs update to the scene's `Y.Doc` under
   * `REMOTE_ORIGIN` (native-Yjs core, M3). The apply integrates into the doc and
   * flows through the Scene's `observeDeep` → the editor re-renders — so there is
   * no `updateScene({ elements })` here. The `REMOTE_ORIGIN` origin keeps the
   * apply out of the local UndoManager and out of our own broadcast subscription
   * (no echo). Then refresh any image files referenced by the merged scene.
   */
  private applyRemoteSceneUpdate = (update: Uint8Array) => {
    this.excalidrawAPI.applyRemoteSceneUpdate(update);

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      collaborators.set(
        socketId,
        Object.assign({}, this.collaborators.get(socketId), {
          isCurrentUser: socketId === this.portal.socket?.id,
        }),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      {},
      collaborators.get(socketId),
      updates,
      {
        isCurrentUser: socketId === this.portal.socket?.id,
      },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    const appState = this.excalidrawAPI.getAppState();

    if (this.portal.socket && (appState.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(appState),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  /**
   * Called by the editor's onChange (App.tsx) on every local scene change. Under
   * the native-Yjs core (M3) the scene `Y.Doc` IS the wire: the local edit that
   * triggered this already mutated the doc (under a local origin) and fired
   * `doc.on("update")`, which broadcast it. So onChange no longer broadcasts the
   * scene — it only triggers the throttled Firebase persistence save.
   */
  syncElements = (_elements: readonly OrderedExcalidrawElement[]) => {
    this.queueSaveToFirebase();
  };

  /**
   * Encode the scene's current state as a full-scene Yjs update — the state used
   * to seed a new peer (`broadcastSceneInit`, on `new-user`) or to periodically
   * resync already-joined peers (`broadcastSceneResync`).
   *
   * T032/T025b: this now encodes the LIVE scene `Y.Doc`. It previously rebuilt
   * the scene through a throwaway doc (`encodeSyncableSceneAsUpdate`), which
   * gave every join/resync a fresh `clientID` and so destroyed CRDT lineage —
   * measured at ~50% concurrent-edit loss and ~50% deletion resurrection per
   * resync. A peer that merges such an update cannot tell a concurrent edit from
   * a stale one, because the identity that would order them is gone.
   *
   * The rebuild existed to keep two things off the wire, and both now have a
   * better answer:
   *  - aged deleted-element tombstones — reclaimed by the explicit maintenance
   *    call below, so they are gone from the DOCUMENT rather than filtered out
   *    of one encoding of it;
   *  - image binaries — since T023 the document carries `fileId -> locator` and
   *    never bytes, so there is nothing to strip.
   *
   * Maintenance runs immediately BEFORE the encode and is deliberately a
   * separate call: {@link ExcalidrawImperativeAPI.encodeSceneStateAsUpdate} is
   * pure. An encoder that pruned on encode would make reading the state a
   * destructive act, and the resync timer would then quietly drive deletion.
   */
  public encodeSceneAsUpdate = (): Uint8Array => {
    this.excalidrawAPI.collectSceneGarbage({
      deletedBefore: Date.now() - DELETED_ELEMENT_TIMEOUT,
    });
    return this.excalidrawAPI.encodeSceneStateAsUpdate("v1");
  };

  /**
   * Periodic full-scene resync safety net (native-Yjs core, M3). Throttled
   * re-broadcast of the FULL doc state as a {@link WS_SUBTYPES.UPDATE}
   * (`broadcastSceneResync`) so a peer that dropped an incremental update still
   * converges. It MUST go via UPDATE, not INIT: an already-initialized peer drops
   * INIT (honored only as its one-time first-in-room seed) but always applies
   * UPDATE, so an INIT-based resync is silently dropped by every joined peer. A
   * full-state update is an idempotent `REMOTE_ORIGIN` merge. Replaces the old
   * `queueBroadcastAllElements` full-scene JSON re-broadcast.
   */
  queueBroadcastSceneResync = throttle(() => {
    if (this.portal.isOpen()) {
      void this.portal.broadcastSceneResync();
    }
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);
  };

  getUsername = () => this.state.username;

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;
