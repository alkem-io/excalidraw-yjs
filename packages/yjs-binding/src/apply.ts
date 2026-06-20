import type {
  AppState,
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  BINDING_ORIGIN,
  APPSTATE_ALLOW_LIST,
  BOUND_ELEMENTS_KEY,
  yMapToElement,
  deepEqual,
  extraBoundTextIds,
} from "./schema";
import { orderByIndex, repairIndices } from "./order";
import { readFiles } from "./files";

import type * as Y from "yjs";
import type { ElementRecord } from "./schema";

/**
 * Inlined `CaptureUpdateAction` enum (self-containment).
 *
 * The binding consumes exactly one runtime value from this enum —
 * `CaptureUpdateAction.NEVER`, passed to `updateScene` so a remote apply is never
 * recorded on the local undo/redo stack. The enum lives in the editor's internal
 * `@excalidraw/element` workspace package, which is NOT published standalone, so
 * importing it at runtime forced every consumer into a local shim + a
 * `pnpm.override`. Instead we inline the constant here: it is a stable part of
 * Excalidraw's public `updateScene({ captureUpdate })` API contract — the editor
 * compares the *string values*, not the object identity, so an inlined copy is
 * behaviourally identical to the editor's own enum.
 *
 * This is not an untyped magic string: the sole consumption site below
 * (`api.updateScene({ captureUpdate: CaptureUpdateAction.NEVER })`) is typed by
 * `ExcalidrawImperativeAPI` (from the already-resolvable `@excalidraw/excalidraw`
 * peer surface) as `captureUpdate?: CaptureUpdateActionType`, so any drift in the
 * literal's value would fail the binding's own typecheck.
 */
const CaptureUpdateAction = {
  IMMEDIATELY: "IMMEDIATELY",
  NEVER: "NEVER",
  EVENTUALLY: "EVENTUALLY",
} as const;

/**
 * The Yjs observe → scene apply path (data-model §8 Apply). Reads the changed
 * portion of the doc, rebuilds only the affected elements, repairs ordering,
 * filters tombstones for render, and calls `updateScene` without disturbing
 * local selection/zoom/scroll.
 */

export type ApplyRoots = {
  ydoc: Y.Doc;
  elementsMap: Y.Map<Y.Map<unknown>>;
  filesMap: Y.Map<BinaryFileData>;
  appStateMap: Y.Map<unknown>;
};

/** Hook telling apply which element id (if any) the local user is mid-editing. */
export type EditingGuard = () => string | null;

/**
 * Deterministic `versionNonce` derived from `(id, version)` — a stable 31-bit
 * FNV-1a hash. Replaces the old `Math.random()` nonce (OPEN-3): because
 * `version`/`versionNonce`/`updated` are NOT synced (RECONCILE_META_KEYS),
 * minting a random nonce on every remote apply made apply non-idempotent and
 * (before the metadata was excluded) round-tripped into the doc, driving the
 * cross-replica echo loop. A deterministic nonce makes a re-apply of identical
 * doc state idempotent, while a real change (which bumps `version`) still yields
 * a different nonce so Excalidraw's reconciliation/change-detection stays
 * meaningful.
 */
const deriveNonce = (id: string, version: number): number => {
  let hash = 0x811c9dc5;
  const input = `${id}:${version}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // fold to a non-negative 31-bit integer (matches Excalidraw's nonce range)
  return (hash >>> 0) % 2 ** 31;
};

/**
 * The set of element ids a doc change touched, or `"full"` when the change can't
 * be scoped (initial seed, or a structural/array-level event) — in which case
 * apply rebuilds every element. Threaded from the `observeDeep` event paths so a
 * remote per-property edit only decodes + re-derives the affected elements
 * (NFR-B-001 / T012, O(changed)).
 */
export type ApplyScope = ReadonlySet<string> | "full";

/**
 * Build the full element list from the doc's element maps, ordered by `index`
 * with collision repair (T012–T014). Tombstones are retained in the returned
 * list (the caller filters them for render); `repaired` carries the ids whose
 * `index` was changed so the caller can persist the repair under
 * `BINDING_ORIGIN`.
 *
 * `prevById` supplies the previous local element objects so that
 * `version`/`versionNonce` can be bumped locally on a real per-property change
 * (OPEN-3) rather than carried verbatim from the remote.
 *
 * `scope` (FIX 2 / NFR-B-001) bounds the work to O(changed): when it is a set of
 * changed ids, every UNCHANGED id (present in `prevById`, absent from `scope`) is
 * re-used by reference — its previous object identity is preserved so React /
 * Excalidraw can skip re-rendering it, and its `Y.Map` is never decoded. Only the
 * changed (and brand-new) ids are decoded + `bumpVersion`-ed. When `scope` is
 * `"full"` (or unset) every element is decoded — the original behaviour.
 *
 * Correctness guard: if index-collision repair would touch an UNCHANGED element
 * (a concurrent same-gap insert can shift a neighbour), the scoped build returns
 * `fellBack: true` so the caller redoes a full rebuild rather than emitting a
 * neighbour with stale identity. The reused objects are shallow-cloned before
 * `repairIndices` (which mutates `index` in place), so a discarded scoped attempt
 * never corrupts the shared `prevById` objects.
 */
export const buildElements = (
  elementsMap: Y.Map<Y.Map<unknown>>,
  prevById: Map<string, ElementRecord>,
  scope: ApplyScope = "full",
): { elements: ElementRecord[]; repaired: Set<string>; fellBack: boolean } => {
  if (scope === "full") {
    const elements: ElementRecord[] = [];
    for (const [id, ymap] of elementsMap.entries()) {
      const next = yMapToElement(ymap);
      next.id = id;
      bumpVersion(next, prevById.get(id));
      elements.push(next);
    }
    const { ordered, repaired } = repairIndices(elements);
    return { elements: ordered, repaired, fellBack: false };
  }

  // Scoped build: decode only changed/new ids; re-use prev objects for the rest.
  // `reused` maps id → the ORIGINAL prev reference so identity can be restored
  // after repair (which works on shallow clones to avoid mutating shared state).
  const reused = new Map<string, ElementRecord>();
  const working: ElementRecord[] = [];
  for (const [id, ymap] of elementsMap.entries()) {
    const prev = prevById.get(id);
    if (!scope.has(id) && prev) {
      // unchanged + previously known → re-use by reference (clone for repair).
      reused.set(id, prev);
      working.push({ ...prev });
    } else {
      const next = yMapToElement(ymap);
      next.id = id;
      bumpVersion(next, prev);
      working.push(next);
    }
  }

  const { ordered, repaired } = repairIndices(working);

  // If repair touched an UNCHANGED element, bail to a full rebuild (the scoped
  // result would carry a neighbour with a changed index but the old identity).
  for (const id of repaired) {
    if (reused.has(id)) {
      return buildElements(elementsMap, prevById, "full");
    }
  }

  // Restore the original object identity for every untouched, unrepaired element
  // (repair never touched them, so the shallow clone is byte-identical to prev).
  const elements = ordered.map((el) => {
    const id = el.id as string;
    const original = reused.get(id);
    return original ?? el;
  });
  return { elements, repaired, fellBack: false };
};

/**
 * Recompute `version`/`versionNonce` locally when the materialized element
 * differs from the previous local one (OPEN-3) — keeps Excalidraw's version
 * monotonic and `hashElementsVersion()` change-detection meaningful. When the
 * element is unchanged, the previous version/nonce are preserved (no churn).
 */
const bumpVersion = (
  next: ElementRecord,
  prev: ElementRecord | undefined,
): void => {
  const id = next.id as string;
  if (!prev) {
    // First time we see this element locally. The doc never carries
    // version/versionNonce/updated (RECONCILE_META_KEYS), so seed them
    // deterministically from doc-derived state.
    const version =
      typeof next.version === "number" && next.version > 0 ? next.version : 1;
    next.version = version;
    next.versionNonce = deriveNonce(id, version);
    if (typeof next.updated !== "number") {
      next.updated = version;
    }
    return;
  }
  // compare every key except the reconciliation metadata itself
  let changed = false;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "version" || key === "versionNonce" || key === "updated") {
      continue;
    }
    if (!deepEqual(prev[key], next[key])) {
      changed = true;
      break;
    }
  }
  if (changed) {
    const version = ((prev.version as number) ?? 0) + 1;
    next.version = version;
    // Deterministic, NOT Math.random() — keeps a re-apply of identical doc state
    // idempotent (no spurious onChange diff → no echo).
    next.versionNonce = deriveNonce(id, version);
    next.updated = version;
  } else {
    next.version = prev.version;
    next.versionNonce = prev.versionNonce;
    next.updated = prev.updated;
  }
};

/** Read the synced `APPSTATE` allow-list from the doc (OPEN-2). */
export const readAppState = (
  appStateMap: Y.Map<unknown>,
): Partial<Pick<AppState, "viewBackgroundColor"> & { name: string }> => {
  const result: Record<string, unknown> = {};
  for (const key of APPSTATE_ALLOW_LIST) {
    if (appStateMap.has(key)) {
      result[key] = appStateMap.get(key);
    }
  }
  return result;
};

export type ApplyDeps = {
  roots: ApplyRoots;
  api: Pick<
    ExcalidrawImperativeAPI,
    "updateScene" | "addFiles" | "getFiles" | "getSceneElementsIncludingDeleted"
  >;
  /** returns the previous full element list applied (for version-bump compare) */
  getPrevElements: () => readonly ElementRecord[];
  /** id of the element the local user is mid-editing, or null */
  editingGuard?: EditingGuard;
  /**
   * The element ids the triggering doc change touched, or `"full"` for a
   * whole-scene rebuild (initial seed / structural event). Defaults to `"full"`.
   * A scoped set makes apply O(changed): only those ids are decoded + re-derived,
   * every other element keeps its existing object identity (FIX 2 / NFR-B-001).
   */
  scope?: ApplyScope;
};

/**
 * Apply the current doc state to the scene (T011–T016). Caller has already
 * confirmed the triggering transaction is NOT ours (echo guard lives in the
 * observer wiring in index.ts, but we re-assert it where a transaction is
 * available). Returns the element list applied.
 */
export const applyToScene = (deps: ApplyDeps): ElementRecord[] => {
  const { roots, api, getPrevElements, editingGuard, scope = "full" } = deps;
  const { ydoc, elementsMap, filesMap, appStateMap } = roots;

  const prevElements = getPrevElements();
  const prevById = new Map<string, ElementRecord>(
    prevElements.map((el) => [el.id as string, el]),
  );

  const { elements, repaired } = buildElements(elementsMap, prevById, scope);

  // Persist index-collision repairs back into the doc under our origin so they
  // are treated as a local change (not echoed) and converge across replicas.
  if (repaired.size > 0) {
    ydoc.transact(() => {
      for (const el of elements) {
        if (repaired.has(el.id as string)) {
          const ymap = elementsMap.get(el.id as string);
          if (ymap && ymap.get("index") !== el.index) {
            ymap.set("index", el.index);
          }
        }
      }
    }, BINDING_ORIGIN);
  }

  // Reconcile the "at most one bound text" invariant INTO the doc (Fix #6).
  // `yMapToBoundElements` already drops extra text bindings on read, but if the
  // doc keeps them, the very next onChange diffs the (one-text) scene against the
  // (two-text) doc and deletes the extra text — flapping with the peer that
  // holds it. Deleting the extra ids here (deterministically: keep lowest id)
  // makes doc and scene agree, and because every replica resolves identically it
  // converges instead of flapping. Written under BINDING_ORIGIN (not echoed).
  reconcileBoundTextInvariant(ydoc, elementsMap);

  // Editing guard (FR-B-013): keep the LIVE local copy of an element the user is
  // mid-editing (read from the editor's scene, which holds the in-progress edit)
  // instead of replacing it from the remote.
  const editingId = editingGuard ? editingGuard() : null;
  let applied = elements;
  if (editingId) {
    const liveLocal = api
      .getSceneElementsIncludingDeleted()
      .find((el) => (el as ElementRecord).id === editingId) as
      | ElementRecord
      | undefined;
    const localEditing = liveLocal ?? prevById.get(editingId);
    if (localEditing) {
      applied = elements.map((el) => (el.id === editingId ? localEditing : el));
    }
  }

  // Files: add any binary the editor lacks OR whose bytes changed in the doc
  // (e.g. a remote image replacement reuses the same fileId with a new dataURL).
  // The old `!existingFiles[id]` filter only ADDED new ids, silently dropping
  // updates to an existing id (Fix #2).
  const docFiles = readFiles(filesMap);
  const existingFiles = api.getFiles() as Record<
    string,
    BinaryFileData | undefined
  >;
  const newFiles: BinaryFileData[] = [];
  for (const id of Object.keys(docFiles)) {
    const existing = existingFiles[id];
    if (!existing || !deepEqual(existing, docFiles[id])) {
      newFiles.push(docFiles[id]);
    }
  }
  if (newFiles.length > 0) {
    api.addFiles(newFiles);
  }

  // Hand the full set (incl. tombstones) to updateScene so the soft-delete
  // state is preserved in the scene; the host filters non-deleted elements for
  // render. `orderByIndex` only sorts — it does not drop tombstones.
  const renderElements = orderByIndex(applied);

  api.updateScene({
    elements: renderElements as never,
    appState: readAppState(appStateMap) as never,
    captureUpdate: CaptureUpdateAction.NEVER,
  });

  return applied;
};

/**
 * Delete extra `type:"text"` bound-element entries (every text except the lowest
 * id) from every element's nested `boundElements` `Y.Map`, so the doc satisfies
 * the "at most one bound text" invariant that `yMapToBoundElements` enforces on
 * read (Fix #6). Idempotent and deterministic across replicas → converges. Only
 * opens a transaction if there is something to delete (no empty BINDING_ORIGIN
 * transaction on the common case).
 */
const reconcileBoundTextInvariant = (
  ydoc: Y.Doc,
  elementsMap: Y.Map<Y.Map<unknown>>,
): void => {
  const toDrop: Array<{ nested: Y.Map<unknown>; ids: string[] }> = [];
  for (const [, ymap] of elementsMap.entries()) {
    const nested = ymap.get(BOUND_ELEMENTS_KEY);
    if (!isYMap(nested)) {
      continue;
    }
    const extra = extraBoundTextIds(nested as Y.Map<"arrow" | "text">);
    if (extra.length > 0) {
      toDrop.push({ nested, ids: extra });
    }
  }
  if (toDrop.length === 0) {
    return;
  }
  ydoc.transact(() => {
    for (const { nested, ids } of toDrop) {
      for (const id of ids) {
        nested.delete(id);
      }
    }
  }, BINDING_ORIGIN);
};

/** Narrow an unknown nested value to a `Y.Map` without importing the class. */
const isYMap = (value: unknown): value is Y.Map<unknown> =>
  value != null &&
  typeof value === "object" &&
  typeof (value as { delete?: unknown }).delete === "function" &&
  typeof (value as { entries?: unknown }).entries === "function";

/** Filter tombstones for callers that need the rendered (non-deleted) set. */
export const nonDeleted = (
  elements: readonly ElementRecord[],
): ElementRecord[] => elements.filter((el) => el.isDeleted !== true);
