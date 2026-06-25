/**
 * Native-Yjs core — the element store's CRDT representation.
 *
 * `Scene` owns a `Y.Doc` whose `yElements: Y.Map<id, Y.Map<prop, value>>` is the
 * single source of truth (native-Yjs core, M1). This barrel exposes the
 * per-property element↔`Y.Map` schema and the transaction-origin sentinel that
 * the doc write paths share.
 */
export * from "./origin";
export * from "./schema";
