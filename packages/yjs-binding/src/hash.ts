import { exportSceneJSON } from "./migrate";

import type * as Y from "yjs";

/**
 * `hashDocState(ydoc) → string` (US4) — a stable, content-addressed digest of a
 * `Y.Doc`'s whiteboard state. It is the Yjs-native dirty-check that replaces the
 * client's legacy JSON deep-compare (`isWhiteboardContentEqual`): persist iff the
 * hash moved since the last save, and compare a freshly-loaded doc against the
 * stored snapshot's hash to detect divergence.
 *
 * Properties (and why):
 *
 *  - **Content-addressed, not order-addressed.** It hashes the *projection* of
 *    the doc via `exportSceneJSON` — elements ordered by fractional `index`
 *    (ties by id), the `appState` allow-list, and `files` — so the digest is
 *    invariant to `Y.Map` insertion order. Two replicas that converged to the
 *    same content always agree.
 *  - **Boundary-correct.** `exportSceneJSON` never emits the per-peer
 *    reconciliation metadata (`version`/`versionNonce`/`updated`) — those live
 *    only in the materialized scene, never in the doc (`RECONCILE_META_KEYS`) —
 *    so two docs with identical content but different local version counters
 *    hash identically. Dirty-check must track content, not render churn.
 *  - **Canonical encoding.** Objects are stringified with their keys sorted
 *    recursively, so the digest does not depend on JSON key order (which Yjs /
 *    Excalidraw do not guarantee). Arrays keep their order (it is semantic — e.g.
 *    arrow `points`).
 *
 * The digest is a 128-bit value rendered as a 32-char lowercase hex string,
 * assembled from four independent 32-bit FNV-1a passes over the canonical string
 * (each seeded differently) to make accidental collisions between distinct scenes
 * negligible for a dirty-check. It is intentionally NOT a cryptographic hash —
 * the use is change-detection, not integrity against an adversary.
 */
export const hashDocState = (ydoc: Y.Doc): string => {
  const scene = exportSceneJSON(ydoc);
  // Only the three content channels — exportSceneJSON already strips reconcile
  // metadata and orders elements deterministically.
  const canonical = canonicalize({
    elements: scene.elements,
    files: scene.files,
    appState: scene.appState,
  });
  return fnv128Hex(canonical);
};

/**
 * Produce a canonical JSON string with object keys sorted recursively (arrays
 * keep their order). Deterministic for any JSON-able value, independent of the
 * key order the source object happens to enumerate in. `undefined` properties are
 * dropped (they are not part of content — they mirror `JSON.stringify`).
 */
const canonicalize = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  const t = typeof value;
  if (t === "number") {
    // Normalize -0 to 0 and reject non-finite (shouldn't appear in scene data).
    return Number.isFinite(value as number)
      ? JSON.stringify(value === 0 ? 0 : value)
      : "null";
  }
  if (t === "string" || t === "boolean") {
    return JSON.stringify(value);
  }
  if (t !== "object") {
    // function/symbol/bigint/undefined — not valid scene content; treat as null.
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
};

/**
 * Four independent 32-bit FNV-1a passes (distinct offset bases) concatenated into
 * a 128-bit, 32-hex-char digest. FNV-1a is the same byte-mixing primitive the
 * binding already uses for its deterministic version nonce (`deriveNonce`); here
 * it is widened to 128 bits purely to shrink collision probability for the
 * dirty-check across the (potentially large) scene string.
 */
const FNV_OFFSETS: readonly number[] = [
  0x811c9dc5, 0x01000193, 0x9dc5811c, 0xc59d1c81,
];
const FNV_PRIME = 0x01000193;

const fnv128Hex = (input: string): string => {
  const h: number[] = [...FNV_OFFSETS];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    for (let lane = 0; lane < 4; lane++) {
      h[lane] ^= c + lane; // per-lane salt so lanes diverge on identical bytes
      h[lane] = Math.imul(h[lane], FNV_PRIME);
    }
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
};
