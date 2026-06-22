/**
 * The core's Yjs transaction-origin sentinel.
 *
 * Native-Yjs core (M1): `Scene` owns the `Y.Doc` and every write it performs —
 * `replaceAllElements`, `scene.mutateElement` — is wrapped in
 * `doc.transact(fn, LOCAL_ORIGIN)`. The `observeDeep` handler that recomputes the
 * derived caches uses the origin to recognise its *own* in-flight writes so it can
 * recompute exactly once per transaction (and so a future network provider can
 * tell a local edit from a remote apply).
 *
 * It is a unique, opaque object — identity is the only thing that matters, so it
 * is compared by reference. One module-level singleton is shared by every write
 * path so a write made in the schema's diff helpers is recognised as "ours".
 *
 * Historically this lived in `packages/yjs-binding` as `BINDING_ORIGIN`; it is now
 * a core element concern (the doc is the element store). The yjs-binding package
 * continues to re-export it under the old name so it still builds until it is
 * deleted at M3.
 */
export const LOCAL_ORIGIN: { readonly name: "alkemio-yjs-core" } = {
  name: "alkemio-yjs-core",
};

export type LocalOrigin = typeof LOCAL_ORIGIN;

/**
 * Origin for the *structural* materialization of an element entry into
 * `yElements` (native-Yjs core, M2 — element history).
 *
 * Excalidraw models element creation as an add and element *deletion* as an
 * `isDeleted: true` tombstone (the entry stays). `Y.UndoManager`, however,
 * reverses a structural add with a structural *delete* — so a naive
 * "create under `LOCAL_ORIGIN`" would make undo-of-create hard-remove the entry,
 * losing the element's content + the tombstone that bindings, references, and M3
 * collaboration rely on.
 *
 * To match upstream semantics, the Scene splits creation into "born-revealed":
 *  1. structurally add the entry under `STRUCTURAL_ORIGIN` with `isDeleted: true`
 *     — **untracked** by the UndoManager, so it is never reversed (the entry +
 *     content persist as a tombstone), and
 *  2. "reveal" it (`isDeleted → false`) under `LOCAL_ORIGIN` — **tracked**, so
 *     undo flips it back to a tombstone (content intact), and redo re-reveals it.
 *
 * Thus every undoable element lifecycle change is an `isDeleted`/property toggle,
 * never a structural add/remove — exactly Excalidraw's model.
 */
export const STRUCTURAL_ORIGIN: { readonly name: "alkemio-yjs-structural" } = {
  name: "alkemio-yjs-structural",
};

export type StructuralOrigin = typeof STRUCTURAL_ORIGIN;

/**
 * Origin for a *local but non-undoable* element write (native-Yjs core, M2 —
 * element history).
 *
 * The `Y.UndoManager` tracks `LOCAL_ORIGIN` and so captures every edit made
 * under it. But Excalidraw issues writes that must NEVER enter the undo stack —
 * `CaptureUpdateAction.NEVER`: scene initialization / load, programmatic
 * non-capturing `updateScene`s, the re-application of an undo/redo result, and
 * (M3) remote applies. Those go through the Scene under `EPHEMERAL_ORIGIN`
 * instead, which the UndoManager does NOT track — so the change still lands in
 * the doc (the source of truth) and re-renders, but produces no undo step.
 *
 * (Mid-drag `informMutation:false` writes stay on `LOCAL_ORIGIN`: they ARE part
 * of the in-progress gesture and correctly merge into its single undo step, which
 * the durable pointer-up commit then seals.)
 */
export const EPHEMERAL_ORIGIN: { readonly name: "alkemio-yjs-ephemeral" } = {
  name: "alkemio-yjs-ephemeral",
};

export type EphemeralOrigin = typeof EPHEMERAL_ORIGIN;

/**
 * Origin for a *remote* update applied to `Scene.doc` by the collaboration
 * provider (native-Yjs core, M3 — collaboration).
 *
 * A remote peer's Yjs update is integrated via `Scene.applyRemoteUpdate`, which
 * wraps `Y.applyUpdate(doc, bytes, REMOTE_ORIGIN)` so the transaction carries
 * this sentinel. It is deliberately a DISTINCT object from {@link LOCAL_ORIGIN}
 * /{@link STRUCTURAL_ORIGIN}/{@link EPHEMERAL_ORIGIN}, which gives M3 its two core
 * guarantees for free:
 *
 *  1. **Undo isolation.** The `Y.UndoManager` tracks ONLY `LOCAL_ORIGIN`
 *     (`trackedOrigins`), so a remote apply is never captured as a local undo
 *     step — a local `undo()` can never revert a peer's edit (the M2 guarantee,
 *     now under real concurrency).
 *  2. **Change propagation.** The Scene's `observeDeep` handler bumps the local
 *     reconciliation `meta` (`version`/`versionNonce`/`updated`) for every id a
 *     non-local transaction touched. A remote apply is non-local, so its changed
 *     elements re-derive with a strictly-greater `version` and the editor's
 *     Store change-detection (which keys off `version`) picks the remote edit up.
 *
 * No bespoke remote-apply *handling* is needed beyond using this origin: the
 * existing `observeDeep` → `recomputeFromDoc` derivation already produces correct,
 * non-stale derived objects (every recompute fully re-reads the committed doc),
 * so held element references stay valid across remote applies.
 */
export const REMOTE_ORIGIN: { readonly name: "alkemio-yjs-remote" } = {
  name: "alkemio-yjs-remote",
};

export type RemoteOrigin = typeof REMOTE_ORIGIN;
