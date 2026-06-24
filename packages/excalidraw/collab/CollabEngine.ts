import * as Y from "yjs";

import type { Scene } from "@excalidraw-yjs/element";

/**
 * Native-Yjs collaboration engine (native-Yjs core, M3).
 *
 * Collaboration is exchanging Yjs updates on the scene's `Y.Doc` — the editor's
 * one source of truth. This engine is the unified provider's transport-agnostic
 * core: it wires a `Scene.doc` to a transport (`CollabTransport`) so that
 *
 *  - every update this replica ORIGINATES (a local edit / undo-redo, already a
 *    `LOCAL_ORIGIN` doc transaction) is handed to `transport.broadcast(bytes)` —
 *    NOT echoes of remote applies (those carry `REMOTE_ORIGIN` and are filtered
 *    out by `scene.onDocUpdate`), so there is no echo loop and no re-entrancy
 *    guard to maintain; and
 *  - every update received from a peer (`transport.onMessage`) is integrated via
 *    `scene.applyRemoteUpdate(bytes)` under `REMOTE_ORIGIN`, which flows through
 *    `observeDeep` → `recomputeFromDoc` (editor re-renders) while the
 *    `Y.UndoManager` (tracking only `LOCAL_ORIGIN`) ignores it.
 *
 * Yjs converges per-property natively, so there is NO scene-array broadcast and
 * NO JSON reconciliation (`reconcileElements`) any more — concurrent edits to
 * different elements, and to different properties of the same element, merge
 * without a bespoke merge path. The engine knows nothing about sockets, rooms,
 * encryption, awareness, or files — those stay in the app's transport, which is
 * the only place the network lives.
 *
 * This is the same abstraction whether the transport is an in-process pipe (the
 * two-replica convergence test) or the real socket relay: attach a `Scene.doc` to
 * a `CollabTransport` and the doc converges.
 */

/**
 * The minimal transport an engine drives. Implemented by the app's collab layer
 * over its real network (sockets / encryption / rooms), and by a trivial
 * in-process pipe in tests. Carries ONLY durable scene-doc Yjs updates; ephemeral
 * presence (cursors, emoji, idle) and binary files are out-of-band and never pass
 * through here (they never touch the doc).
 */
export interface CollabTransport {
  /** Send a Yjs update this replica originated to every peer. */
  broadcast: (update: Uint8Array) => void;
  /**
   * Subscribe to Yjs updates arriving from peers. The engine integrates each one
   * into the doc under `REMOTE_ORIGIN`. Returns an unsubscribe function.
   */
  onMessage: (handler: (update: Uint8Array) => void) => () => void;
}

export type CollabEngineOptions = {
  /**
   * Wire format for updates on this transport. The whole session must agree;
   * `"v1"` (the default) is the broadest-compatible `Y.applyUpdate` form. `"v2"`
   * is more compact. Initial-sync (`encodeInitialUpdate`) uses the same format.
   */
  format?: "v1" | "v2";
};

/**
 * Drives `scene.doc` ↔ a transport. One instance per collaborating editor;
 * `destroy()` detaches everything (no leaks on remount / room-leave).
 */
export class CollabEngine {
  private readonly scene: Scene;
  private readonly transport: CollabTransport;
  private readonly format: "v1" | "v2";

  private detachLocal?: () => void;
  private detachRemote?: () => void;
  private destroyed = false;

  constructor(
    scene: Scene,
    transport: CollabTransport,
    options: CollabEngineOptions = {},
  ) {
    this.scene = scene;
    this.transport = transport;
    this.format = options.format ?? "v1";

    // Local edits (+ undo/redo) → broadcast. `onDocUpdate` excludes REMOTE_ORIGIN,
    // so a remote apply is never re-broadcast (no echo).
    this.detachLocal = this.scene.onDocUpdate((update) => {
      if (this.destroyed) {
        return;
      }
      this.transport.broadcast(update);
    }, this.format);

    // Peer updates → apply under REMOTE_ORIGIN (UndoManager ignores; observeDeep
    // re-renders). Idempotent: a duplicate update is a Yjs no-op.
    this.detachRemote = this.transport.onMessage((update) => {
      if (this.destroyed) {
        return;
      }
      this.scene.applyRemoteUpdate(update, this.format);
    });
  }

  /**
   * Encode the doc's full current state for a newly-joined peer (the initial
   * sync). If `peerStateVector` is provided, only the delta the peer is missing
   * is encoded (a `Scene.encodeStateVector()` exchanged on join).
   */
  encodeInitialUpdate(peerStateVector?: Uint8Array): Uint8Array {
    return this.scene.encodeStateAsUpdate(this.format, peerStateVector);
  }

  /** This replica's state vector, to send a peer so it can compute the delta to
   * send back (used for a two-way initial sync). */
  encodeStateVector(): Uint8Array {
    return this.scene.encodeStateVector();
  }

  /**
   * Apply a peer's initial-sync update (or any out-of-band catch-up update)
   * directly. Same as an `onMessage` delivery — integrated under `REMOTE_ORIGIN`.
   */
  applyInitialUpdate(update: Uint8Array): void {
    if (this.destroyed) {
      return;
    }
    this.scene.applyRemoteUpdate(update, this.format);
  }

  /** Detach the local-broadcast + remote-apply wiring. Safe to call twice. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.detachLocal?.();
    this.detachLocal = undefined;
    this.detachRemote?.();
    this.detachRemote = undefined;
  }
}

export { Y };
