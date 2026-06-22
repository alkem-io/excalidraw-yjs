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
 * @deprecated Use {@link LOCAL_ORIGIN}. Kept as an alias so the legacy
 * `packages/yjs-binding` (deleted at M3) keeps compiling.
 */
export const BINDING_ORIGIN = LOCAL_ORIGIN;
export type BindingOrigin = LocalOrigin;
