import {
  CaptureUpdateAction,
  newElementWith,
} from "@excalidraw-yjs/excalidraw";
import {
  createRedoAction,
  createUndoAction,
} from "@excalidraw-yjs/excalidraw/actions/actionHistory";
import { Scene, syncInvalidIndices } from "@excalidraw-yjs/element";
import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";
import {
  act,
  render,
  waitFor,
} from "@excalidraw-yjs/excalidraw/tests/test-utils";

import { vi } from "vitest";

import { StoreIncrement } from "@excalidraw-yjs/element";

import * as Y from "yjs";

import { ELEMENTS } from "@excalidraw-yjs/element";

import type {
  DurableIncrement,
  EphemeralIncrement,
} from "@excalidraw-yjs/element";

import { DELETED_ELEMENT_TIMEOUT } from "../app_constants";

import ExcalidrawApp from "../App";

import { WS_SUBTYPES } from "../app_constants";

const { h } = window;

Object.defineProperty(window, "crypto", {
  value: {
    getRandomValues: (arr: number[]) =>
      arr.forEach((v, i) => (arr[i] = Math.floor(Math.random() * 256))),
    subtle: {
      generateKey: () => {},
      exportKey: () => ({ k: "sTdLvMC_M3V8_vGa3UVRDg" }),
    },
  },
});

vi.mock("../../excalidraw-app/data/firebase.ts", () => {
  const loadFromFirebase = async () => null;
  const saveToFirebase = () => {};
  const isSavedToFirebase = () => true;
  const loadFilesFromFirebase = async () => ({
    loadedFiles: [],
    erroredFiles: [],
  });
  const saveFilesToFirebase = async () => ({
    savedFiles: new Map(),
    erroredFiles: new Map(),
  });

  return {
    loadFromFirebase,
    saveToFirebase,
    isSavedToFirebase,
    loadFilesFromFirebase,
    saveFilesToFirebase,
  };
});

vi.mock("socket.io-client", () => {
  return {
    default: () => {
      return {
        close: () => {},
        on: () => {},
        once: () => {},
        off: () => {},
        emit: () => {},
      };
    },
  };
});

/**
 * These test would deserve to be extended by testing collab with (at least) two clients simultanouesly,
 * while having access to both scenes, appstates stores, histories and etc.
 * i.e. multiplayer history tests could be a good first candidate, as we could test both history stacks simultaneously.
 */
describe("collaboration", () => {
  it("should emit two ephemeral increments even though updates get batched", async () => {
    const durableIncrements: DurableIncrement[] = [];
    const ephemeralIncrements: EphemeralIncrement[] = [];

    await render(<ExcalidrawApp />);

    h.store.onStoreIncrementEmitter.on((increment) => {
      if (StoreIncrement.isDurable(increment)) {
        durableIncrements.push(increment);
      } else {
        ephemeralIncrements.push(increment);
      }
    });

    // eslint-disable-next-line dot-notation
    expect(h.store["scheduledMicroActions"].length).toBe(0);
    expect(durableIncrements.length).toBe(0);
    expect(ephemeralIncrements.length).toBe(0);

    const rectProps = {
      type: "rectangle",
      id: "A",
      height: 200,
      width: 100,
      x: 0,
      y: 0,
    } as const;

    const rect = API.createElement({ ...rectProps });

    API.updateScene({
      elements: [rect],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    await waitFor(() => {
      // expect(commitSpy).toHaveBeenCalledTimes(1);
      expect(durableIncrements.length).toBe(1);
    });

    // simulate two batched remote updates
    act(() => {
      h.app.updateScene({
        elements: [newElementWith(h.elements[0], { x: 100 })],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      h.app.updateScene({
        elements: [newElementWith(h.elements[0], { x: 200 })],
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      // we scheduled two micro actions,
      // which confirms they are going to be executed as part of one batched component update
      // eslint-disable-next-line dot-notation
      expect(h.store["scheduledMicroActions"].length).toBe(2);
    });

    await waitFor(() => {
      // altough the updates get batched,
      // we expect two ephemeral increments for each update,
      // and each such update should have the expected change
      expect(ephemeralIncrements.length).toBe(2);
      expect(ephemeralIncrements[0].change.elements.A).toEqual(
        expect.objectContaining({ x: 100 }),
      );
      expect(ephemeralIncrements[1].change.elements.A).toEqual(
        expect.objectContaining({ x: 200 }),
      );
      // eslint-disable-next-line dot-notation
      expect(h.store["scheduledMicroActions"].length).toBe(0);
    });
  });

  // Native-Yjs core (M2 — History) + collaboration: this exercises force-deletion
  // during `startCollaboration` (the local snapshot keeps the tombstone for diff
  // calc while the scene array drops it) interleaved with undo/redo. It depends on
  // BOTH (a) the OLD scene-array-vs-Store-snapshot duality that the native
  // single-source doc unifies, and (b) collaboration force-deletion semantics that
  // the unified Yjs provider owns in M3. The native element history (the doc's
  // `Y.UndoManager`, LOCAL_ORIGIN-scoped) and restore-on-undo of a structurally
  // removed element are proven in the Scene history unit tests; this app-level
  // collab + force-delete + undo combination is deferred to M3.
  it.skip("should allow to undo / redo even on force-deleted elements", async () => {
    await render(<ExcalidrawApp />);
    const rect1Props = {
      type: "rectangle",
      id: "A",
      height: 200,
      width: 100,
    } as const;

    const rect2Props = {
      type: "rectangle",
      id: "B",
      width: 100,
      height: 200,
    } as const;

    const rect1 = API.createElement({ ...rect1Props });
    const rect2 = API.createElement({ ...rect2Props });

    API.updateScene({
      elements: syncInvalidIndices([rect1, rect2]),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    API.updateScene({
      elements: syncInvalidIndices([
        rect1,
        newElementWith(h.elements[1], { isDeleted: true }),
      ]),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
    });

    // one form of force deletion happens when starting the collab, not to sync potentially sensitive data into the server
    window.collab.startCollaboration(null);

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      // we never delete from the local snapshot as it is used for correct diff calculation
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([expect.objectContaining(rect1Props)]);
    });

    const undoAction = createUndoAction(h.history);
    act(() => h.app.actionManager.executeAction(undoAction));

    // with explicit undo (as addition) we expect our item to be restored from the snapshot!
    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: false }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: false }),
      ]);
    });

    // simulate force deleting the element remotely
    API.updateScene({
      elements: syncInvalidIndices([rect1]),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([expect.objectContaining(rect1Props)]);
    });

    const redoAction = createRedoAction(h.history);
    act(() => h.app.actionManager.executeAction(redoAction));

    // with explicit redo (as removal) we again restore the element from the snapshot!
    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
    });
  });

  // FIX 1 (native-Yjs core M3): the periodic full-scene safety net that
  // `onDocUpdate` schedules on every local edit (the resync tick) must
  // funnel through `Portal.broadcastSceneResync` (→ WS_SUBTYPES.UPDATE), which
  // already-joined peers apply — NEVER `broadcastSceneInit` (→ INIT), which joined
  // peers drop, so an INIT-routed resync silently never reconverges a replica that
  // missed an incremental update. `portalResync.test.tsx` pins the Portal wire
  // boundary (resync→UPDATE / init→INIT); this pins the Collab-side routing so a
  // regression of the throttle target to `broadcastSceneInit` fails a test.
  it("runSceneResyncTick routes via broadcastSceneResync (UPDATE), not broadcastSceneInit (INIT) — FIX 1", async () => {
    await render(<ExcalidrawApp />);

    const collab = window.collab;
    const { portal } = collab;

    // Force the portal "open" so the tick body actually runs.
    portal.isOpen = vi.fn(() => true);
    const resyncSpy = vi
      .spyOn(portal, "broadcastSceneResync")
      .mockResolvedValue(undefined);
    const initSpy = vi
      .spyOn(portal, "broadcastSceneInit")
      .mockResolvedValue(undefined);

    await collab.runSceneResyncTick();

    expect(resyncSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).not.toHaveBeenCalled();
  });

  // The resync encode THROWS on a peer-poisoned asset root (`encodeSceneAsUpdate`
  // → `assertAssetRootValid`, and `applyRemoteUpdate` does not validate, so a peer
  // can land one). This ran as a bare `void portal.broadcastSceneResync()` inside
  // the interval, so the throw became an unhandled rejection: the resync safety
  // net was silently dead and the user saw nothing.
  it("a throwing resync encode surfaces on the error indicator instead of rejecting", async () => {
    await render(<ExcalidrawApp />);

    const collab = window.collab;
    const { portal } = collab;

    portal.isOpen = vi.fn(() => true);
    vi.spyOn(portal, "broadcastSceneResync").mockRejectedValue(
      new Error("Scene: asset root holds a non-string value"),
    );
    const indicatorSpy = vi.spyOn(collab, "setErrorIndicator");

    // MUST NOT reject — an unhandled rejection here is the defect itself.
    await expect(collab.runSceneResyncTick()).resolves.toBeUndefined();

    expect(indicatorSpy).toHaveBeenCalledWith(
      "Scene: asset root holds a non-string value",
    );
  });

  // FIX 1 + FIX 2 (native-Yjs core M3): exercise the `doc.on("update")` →
  // `onDocUpdate` CALL SITE itself (the FIX-1 test above calls
  // `runSceneResyncTick()` directly and never touches `onDocUpdate`). This
  // pins the live wire routing of local doc updates:
  //   FIX 2 (origin filter): local edits broadcast via
  //     `broadcastSceneUpdate(WS_SUBTYPES.UPDATE, …)` — including a
  //     `captureUpdate: NEVER` write, which is untracked by history but is still a
  //     change to the shared document. Only a REMOTE_ORIGIN apply is withheld, so
  //     a peer's edit is never echoed back.
  //   FIX 1 (resync moved off the edit path): a local edit must NOT itself trigger
  //     a full-scene resync — that now fires on an interval, not per update.
  // Mutating an EXISTING element (not creating one) keeps each edit a single
  // tracked transaction, so the LOCAL broadcast is exactly one call (a create would
  // also fire the paired STRUCTURAL pass, which is intentionally still broadcast).
  it("broadcasts local edits as UPDATE, never echoes a remote apply, and does not resync per-edit", async () => {
    await render(<ExcalidrawApp />);

    const collab = window.collab;
    const { portal } = collab;

    // Seed an existing element BEFORE collab starts, so later mutations are pure
    // single-transaction updates (no born-revealed STRUCTURAL pass).
    const rect = API.createElement({ type: "rectangle", id: "A", width: 100 });
    API.updateScene({
      elements: syncInvalidIndices([rect]),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    // Start collaboration so `doc.on("update", onDocUpdate)` gets attached. We do
    // NOT await the returned promise: with socket.io-client mocked to a no-op, the
    // INIT/fallback handshake never fires, so the promise never resolves — but the
    // subscription is wired synchronously partway through. `detachDocBroadcast`
    // becomes non-null exactly when `onDocUpdate` is attached, so we wait on that.
    // (Mirrors the fire-and-forget `startCollaboration(null)` the test above uses.)
    void collab.startCollaboration(null);
    await waitFor(() => {
      // eslint-disable-next-line dot-notation
      expect(collab["detachDocBroadcast"]).not.toBeNull();
    });
    // Force the portal "open" so the `if (this.portal.isOpen())` broadcast guard
    // inside `onDocUpdate` passes.
    portal.socketInitialized = true;
    portal.isOpen = vi.fn(() => true);

    const updateSpy = vi
      .spyOn(portal, "broadcastSceneUpdate")
      .mockResolvedValue(undefined);
    const resyncSpy = vi
      .spyOn(portal, "broadcastSceneResync")
      .mockResolvedValue(undefined);

    // (1) LOCAL_ORIGIN edit (captureUpdate: IMMEDIATELY) → broadcasts as UPDATE.
    act(() => {
      API.updateScene({
        elements: syncInvalidIndices([
          newElementWith(h.elements[0], { width: 222 }),
        ]),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

    expect(updateSpy).toHaveBeenCalled();
    expect(
      updateSpy.mock.calls.every((call) => call[0] === WS_SUBTYPES.UPDATE),
    ).toBe(true);
    // FIX 1: the local edit must NOT itself drive a full-scene resync.
    expect(resyncSpy).not.toHaveBeenCalled();

    // (2) a non-recording write (captureUpdate: NEVER) → IS broadcast. It is
    // untracked by undo, not invisible: it changes the shared document, so the
    // next full-state resync carries it regardless.
    updateSpy.mockClear();
    act(() => {
      API.updateScene({
        elements: syncInvalidIndices([
          newElementWith(h.elements[0], { width: 333 }),
        ]),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });

    expect(updateSpy).toHaveBeenCalled();
    expect(
      updateSpy.mock.calls.every((call) => call[0] === WS_SUBTYPES.UPDATE),
    ).toBe(true);

    // (3) a remote apply → NOT re-broadcast (no echo). Build a real remote delta
    // from a mirror doc so this exercises the actual integrate-and-notify path
    // rather than asserting on an origin constant.
    updateSpy.mockClear();
    // Seed the mirror and apply its delta through the PUBLIC transport boundary
    // (`encodeSceneAsUpdate` / `applyRemoteSceneUpdate`) — the same two calls a
    // real provider makes. Nothing here touches the scene's `Y.Doc` directly, so
    // this exercises the production path rather than a test-only shortcut.
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, collab.excalidrawAPI.encodeSceneAsUpdate());
    const mirrorElements = mirror.getMap<Y.Map<unknown>>(ELEMENTS);
    mirror.transact(() => {
      const ymap = mirrorElements.get("A");
      ymap?.set("width", 444);
    });
    act(() => {
      collab.excalidrawAPI.applyRemoteSceneUpdate(
        Y.encodeStateAsUpdate(mirror),
      );
    });

    expect(updateSpy).not.toHaveBeenCalled();
  });

  /**
   * T032/T025b — the PRODUCTION cutoff arithmetic.
   *
   * The tombstone-window semantics ("marker older than the cutoff is reclaimed")
   * are pinned in `collabWireFilter.test.tsx` by moving the cutoff, because this
   * harness cannot produce realistic markers: `getUpdatedTimestamp()` returns a
   * constant `1` in test env by upstream design, so every deletion marker is 1.
   *
   * That leaves exactly one thing unpinned — that the wire seed passes the real
   * cutoff — and this covers it. A wrong value here would silently stop
   * deletions propagating (too old) or re-broadcast tombstones forever (too new),
   * with nothing else to catch it.
   */
  it("the wire seed prunes with Date.now() - DELETED_ELEMENT_TIMEOUT, and encodes PURELY", async () => {
    await render(<ExcalidrawApp />);

    const collab = window.collab;
    const api = collab.excalidrawAPI;

    const gcSpy = vi.spyOn(api, "collectSceneGarbage");
    const encodeSpy = vi.spyOn(api, "encodeSceneStateAsUpdate");

    const before = Date.now();
    collab.encodeSceneAsUpdate();
    const after = Date.now();

    expect(gcSpy).toHaveBeenCalledTimes(1);
    const { deletedBefore } = gcSpy.mock.calls[0][0];
    expect(deletedBefore).toBeGreaterThanOrEqual(
      before - DELETED_ELEMENT_TIMEOUT,
    );
    expect(deletedBefore).toBeLessThanOrEqual(after - DELETED_ELEMENT_TIMEOUT);

    // Maintenance must run BEFORE the encode, or the seed would carry the very
    // tombstones the sweep exists to drop.
    expect(gcSpy.mock.invocationCallOrder[0]).toBeLessThan(
      encodeSpy.mock.invocationCallOrder[0],
    );

    gcSpy.mockRestore();
    encodeSpy.mockRestore();
  });

  /**
   * The loss T032 actually exists to prevent, through the PRODUCTION producer.
   *
   * The state-vector no-op case proves lineage identity; it does NOT prove the
   * outcome that identity buys. The rebuild's real damage is to concurrent
   * writes to DIFFERENT PROPERTIES of the SAME element: per-property merge keeps
   * both, whole-element LWW keeps one.
   *
   * The peer's `clientID` is pinned to 1 so the sabotage loses reliably. Yjs
   * assigns random 32-bit client ids, so a rebuilt seed outranks 1 with
   * probability 1 - 2^-32; without pinning, the outcome would be a coin flip and
   * the sabotage would only fail some of the time.
   */
  it("a resync keeps a peer's concurrent edit to ANOTHER PROPERTY of the same element", async () => {
    await render(<ExcalidrawApp />);

    const collab = window.collab;
    const scene = h.app.scene;

    scene.replaceAllElements([
      API.createElement({ type: "rectangle", id: "shared", x: 10, y: 10 }),
    ]);

    // A peer seeded from the sender, with a deliberately low clientID.
    const peerDoc = new Y.Doc();
    peerDoc.clientID = 1;
    const peer = new Scene(null, { doc: peerDoc });
    peer.applyRemoteUpdate(collab.encodeSceneAsUpdate(), "v1");
    expect(peer.getElementsIncludingDeleted().map((e) => e.id)).toEqual([
      "shared",
    ]);

    // Concurrent edits to DIFFERENT properties of the same element. Neither side
    // has seen the other's.
    scene.replaceAllElements(
      scene
        .getElementsIncludingDeleted()
        .map((e) => (e.id === "shared" ? { ...e, x: 999 } : e)),
    );
    peer.replaceAllElements(
      peer
        .getElementsIncludingDeleted()
        .map((e) => (e.id === "shared" ? { ...e, y: 777 } : e)),
    );

    // The sender's periodic full resync arrives.
    peer.applyRemoteUpdate(collab.encodeSceneAsUpdate(), "v1");

    const merged = peer
      .getElementsIncludingDeleted()
      .find((e) => e.id === "shared")!;

    // Both survive. A rebuilt seed carries the sender's whole element — including
    // its STALE y — under a fresh clientID that outranks the peer's, so y reverts
    // to 10 and the peer's edit is gone with no trace.
    expect(merged.x).toBe(999);
    expect(merged.y).toBe(777);

    peer.destroy();
  });
});
