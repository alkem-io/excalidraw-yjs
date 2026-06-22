import throttle from "lodash.throttle";
import * as Y from "yjs";

import {
  randomInteger,
  arrayToMap,
  toBrandedType,
  isDevEnv,
  isTestEnv,
  toArray,
  getUpdatedTimestamp,
} from "@excalidraw/common";
import { isNonDeletedElement } from "@excalidraw/element";
import { isFrameLikeElement } from "@excalidraw/element";
import { getElementsInGroup } from "@excalidraw/element";

import {
  syncInvalidIndices,
  syncMovedIndices,
  validateFractionalIndices,
  orderByFractionalIndex,
} from "@excalidraw/element";

import { getSelectedElements } from "@excalidraw/element";

import { mutateElement, type ElementUpdate } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
  NonDeleted,
  ExcalidrawFrameLikeElement,
  ElementsMapOrArray,
  SceneElementsMap,
  NonDeletedSceneElementsMap,
  OrderedExcalidrawElement,
  Ordered,
} from "@excalidraw/element/types";

import type {
  Assert,
  Mutable,
  SameType,
} from "@excalidraw/common/utility-types";

import {
  ELEMENTS,
  LOCAL_ORIGIN,
  STRUCTURAL_ORIGIN,
  EPHEMERAL_ORIGIN,
  REMOTE_ORIGIN,
  elementToYMap,
  yMapToElement,
  writeChangedKeys,
  deepEqual,
  type ElementRecord,
} from "./yjs";

import type { AppState } from "../../excalidraw/types";

type SceneStateCallback = () => void;
type SceneStateCallbackRemover = () => void;

type SelectionHash = string & { __brand: "selectionHash" };

/**
 * Per-peer reconciliation metadata (`version` / `versionNonce` / `updated`) plus
 * any local own-`Symbol` properties carried on the element.
 *
 * Native-Yjs core (M1): the `Y.Doc` is the element store, but it deliberately does
 * NOT persist `version`/`versionNonce`/`updated` (`RECONCILE_META_KEYS` in the
 * schema) — they are locally derived per replica (OPEN-3, echo-loop fix). The live
 * `Scene` still has to expose them on every derived element because the editor's
 * change-detection, history, and reconciliation read them. We therefore maintain
 * them in this side table, keyed by element id, and re-attach them on every
 * recompute. The write paths (`replaceAllElements`, `scene.mutateElement`) refresh
 * the entry from the (in-place mutated) element so the values match exactly what
 * the editor produced.
 *
 * `symbols` carries forward own-`Symbol` properties that the schema cannot store
 * (the doc round-trip goes through `Object.keys`, which omits symbols and
 * non-enumerable props). Today the only such property is `ORIG_ID`
 * (`Symbol.for("__test__originalId__")`), a non-enumerable test-only marker the
 * duplicate flow stamps on a clone and the test harness later reads. It is local,
 * ephemeral metadata that legitimately does not belong in the CRDT, so — like
 * `versionNonce` — the doc drops it and the Scene re-attaches it on the derived
 * element.
 */
type ElementMeta = {
  version: number;
  versionNonce: number;
  updated: number;
  /** Own-`Symbol` props (descriptor included) to re-stamp on the derived element. */
  symbols?: Array<[symbol, PropertyDescriptor]>;
  /**
   * `true` iff the source element's `boundElements` was an empty array `[]`
   * (as opposed to `null` or populated). The CRDT stores both `[]` and `null` as
   * an empty nested `Y.Map` (so the binding set merges with stable identity), so
   * the doc round-trips empty → `null`. Excalidraw distinguishes `[]` from `null`
   * (a freshly duplicated element carries `[]`), so the Scene preserves it here as
   * local view state and re-applies it on derive.
   */
  boundElementsEmpty?: boolean;
};

/** Whether `boundElements` on this element is an empty array (vs null/populated). */
const isEmptyBoundElements = (element: ElementRecord): boolean => {
  const be = element.boundElements;
  return Array.isArray(be) && be.length === 0;
};

/**
 * Extract own-`Symbol` property descriptors from an element so they can be carried
 * forward onto its (freshly derived) doc representation. Returns `undefined` when
 * there are none (the common case) to avoid per-element allocation.
 */
const captureOwnSymbols = (
  element: object,
): Array<[symbol, PropertyDescriptor]> | undefined => {
  const symbols = Object.getOwnPropertySymbols(element);
  if (symbols.length === 0) {
    return undefined;
  }
  const out: Array<[symbol, PropertyDescriptor]> = [];
  for (const sym of symbols) {
    const desc = Object.getOwnPropertyDescriptor(element, sym);
    if (desc) {
      out.push([sym, desc]);
    }
  }
  return out;
};

/**
 * Derive the set of element ids touched by an `observeDeep` event batch on
 * `yElements`. Each event's `path` is the route from the observed root to the
 * mutated type: `path.length === 0` is a top-level add/remove (ids = the event's
 * keys); `path[0]` (a string) is the element id for a per-element / nested
 * (`boundElements`) change. Returns `"full"` if any event can't be resolved to a
 * concrete id — the caller then conservatively treats *all* known ids as
 * changed. (Same derivation as the M1 `yjs-binding` apply path.)
 */
const changedElementIds = (
  events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
): Set<string> | "full" => {
  const ids = new Set<string>();
  for (const event of events) {
    const path = event.path;
    if (path.length === 0) {
      for (const key of event.keys.keys()) {
        ids.add(key);
      }
      continue;
    }
    const head = path[0];
    if (typeof head === "string") {
      ids.add(head);
    } else {
      return "full";
    }
  }
  return ids;
};

const getNonDeletedElements = <T extends ExcalidrawElement>(
  allElements: readonly T[],
) => {
  const elementsMap = new Map() as NonDeletedSceneElementsMap;
  const elements: T[] = [];
  for (const element of allElements) {
    if (!element.isDeleted) {
      elements.push(element as NonDeleted<T>);
      elementsMap.set(
        element.id,
        element as Ordered<NonDeletedExcalidrawElement>,
      );
    }
  }
  return { elementsMap, elements };
};

const validateIndicesThrottled = throttle(
  (elements: readonly ExcalidrawElement[]) => {
    if (isDevEnv() || isTestEnv() || window?.DEBUG_FRACTIONAL_INDICES) {
      validateFractionalIndices(elements, {
        // throw only in dev & test, to remain functional on `DEBUG_FRACTIONAL_INDICES`
        shouldThrow: isDevEnv() || isTestEnv(),
        includeBoundTextValidation: true,
      });
    }
  },
  1000 * 60,
  { leading: true, trailing: false },
);

const hashSelectionOpts = (
  opts: Parameters<InstanceType<typeof Scene>["getSelectedElements"]>[0],
) => {
  const keys = ["includeBoundTextElement", "includeElementsInFrames"] as const;

  type HashableKeys = Omit<typeof opts, "selectedElementIds" | "elements">;

  // just to ensure we're hashing all expected keys
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  type _ = Assert<
    SameType<
      Required<HashableKeys>,
      Pick<Required<HashableKeys>, typeof keys[number]>
    >
  >;

  let hash = "";
  for (const key of keys) {
    hash += `${key}:${opts[key] ? "1" : "0"}`;
  }
  return hash as SelectionHash;
};

// ideally this would be a branded type but it'd be insanely hard to work with
// in our codebase
export type ExcalidrawElementsIncludingDeleted = readonly ExcalidrawElement[];

export class Scene {
  // ---------------------------------------------------------------------------
  // native-Yjs core — the element store IS the doc
  // ---------------------------------------------------------------------------

  /**
   * The single source of truth for this scene's elements.
   *
   * `yElements: Y.Map<id, Y.Map<prop, value>>` (`doc.getMap(ELEMENTS)`) holds one
   * nested per-property `Y.Map` per element, so concurrent edits to *different*
   * properties of the same element both survive. Every write path
   * (`replaceAllElements`, `scene.mutateElement`) mutates `yElements` inside a
   * `doc.transact(fn, LOCAL_ORIGIN)`; the derived array/map caches below are
   * recomputed from it by `recomputeFromDoc` on `observeDeep` and then
   * `triggerUpdate()` fires.
   *
   * appState / files are NOT yet on the doc — they move in a later milestone
   * (M2–M4). For now they remain wherever the editor keeps them.
   */
  public readonly doc: Y.Doc;

  public readonly yElements: Y.Map<Y.Map<unknown>>;

  /**
   * Native element history (native-Yjs core, M2).
   *
   * `Y.UndoManager` over `yElements`, **scoped to `LOCAL_ORIGIN`** via
   * `trackedOrigins`, so it captures only this replica's own edits and an
   * `undo()`/`redo()` reverts ONLY local doc mutations — never a remote /
   * system-origin transaction (the origin-scope M3 collaboration relies on). It
   * replaces the snapshot-based element history: the doc is the single source of
   * truth for element history too, so undo/redo is a real inverse doc mutation
   * that flows back through `observeDeep` → {@link recomputeFromDoc} → the editor
   * re-renders.
   *
   * `captureTimeout` is set astronomically high and merge boundaries are defined
   * **purely** by explicit {@link stopElementCapture} calls (driven by the
   * editor's durable-commit cadence), NOT by wall-clock time — so however slowly
   * a user drags, the whole gesture collapses to a single undo step (Excalidraw's
   * coalescing UX), deterministically and independent of timing.
   *
   * The doc deliberately does not store `version`/`versionNonce`/`updated`
   * (`RECONCILE_META_KEYS`), so the UndoManager never touches them; the recompute
   * re-derives them, approaching each undo/redo as a fresh local edit — matching
   * the old history's "new version on undo" semantics.
   */
  public readonly undoManager: Y.UndoManager;

  /** Carries `version`/`versionNonce`/`updated` forward across recomputes (these
   * are intentionally NOT stored in the doc — see {@link ElementMeta}). */
  private meta: Map<string, ElementMeta> = new Map();

  /**
   * Monotonically-increasing high-water mark of every `version` this Scene has
   * assigned. When an element REAPPEARS after having been structurally removed —
   * e.g. undo re-adds an element a destructive replace dropped, so its `meta` was
   * gone — recompute must seed it with a version strictly greater than the one the
   * editor's Store last saw for that id (the Store synthesized an `isDeleted:true`
   * delta at its old version when it was dropped). Seeding from this counter
   * guarantees the Store's `version`-based change-detection re-picks-up the
   * restored element rather than treating the stale tombstone as still current.
   */
  private versionHighWater = 1;

  /**
   * Stable per-id derived element objects.
   *
   * The doc is the source of truth, but Excalidraw holds live element references
   * pervasively (drag/resize state, React props, test fixtures) and mutates/reads
   * them in place. To keep the editor working natively off the doc in M1 — rather
   * than rewriting every one of those ~200 reference holders (staged for M2–M4) —
   * the recompute REUSES the same object per id and updates its fields in place to
   * match the doc, instead of minting a fresh object each time. So a held
   * reference always reflects current doc state. This does not reintroduce an
   * array-as-source: there is no `this.elements = next` of caller-supplied
   * objects; every field of every derived object is (re)written *from* `yElements`
   * on each change. A brand-new `Scene` built from doc bytes derives its own fresh
   * objects, so the doc remains the portable, authoritative representation.
   *
   * CONCURRENCY CORRECTNESS (native-Yjs core, M3). M1 flagged this stable-identity
   * reuse as a potential "cross-replica hazard for held references under
   * concurrency": an object reused across recomputes *sounds* like it could be
   * observed half-updated while a remote apply rewrites it. It cannot, for three
   * combining reasons — which together make a held reference never torn, never
   * stale across a remote (REMOTE_ORIGIN) apply:
   *
   *  1. **Full re-derivation per recompute.** {@link recomputeFromDoc} re-reads the
   *     *entire* `yElements` map and rewrites every derived object from the doc on
   *     every change (it takes no "changed ids" set — `changedElementIds` scopes
   *     only the meta bump, never the read). So a derived object can only ever
   *     reflect ONE coherent committed doc state, never an incremental mix of pre-
   *     and post-apply values.
   *  2. **Synchronous, post-commit observer.** Yjs integrates a remote update
   *     inside a `doc.transact`; `observeDeep` fires from `cleanupTransactions`
   *     *after* the merge is committed and the post-apply state is readable. So
   *     when `recomputeFromDoc` runs, `yElements` already holds the fully-merged
   *     state — the recompute lands on a single consistent snapshot.
   *  3. **No async window in the Scene.** The whole apply→observe→recompute→
   *     `reconcileDerived` chain is synchronous (the Scene has no `await`), and so
   *     are the editor's drag/resize handlers (`mutateElement`). JS is
   *     single-threaded, so a remote apply runs *between* synchronous editor turns,
   *     never *inside* one — no editor turn holds a derived reference across a
   *     suspension point while a remote apply mutates the same object underneath.
   *
   * The only residual: an element *structurally removed* by a remote apply is
   * dropped from `derivedById`/`meta` and from `elements`/`elementsMap`; a
   * reference a caller still holds becomes a detached orphan frozen at its last
   * values (correct "this element no longer exists" semantics, identical to the
   * pre-rewrite array-source behaviour). The editor's Store catches the removal by
   * *absence*, not by a version bump, so the deletion is never lost.
   */
  private derivedById: Map<string, Mutable<OrderedExcalidrawElement>> =
    new Map();

  /**
   * When set, `recomputeFromDoc` rebuilds the derived caches but does NOT fire
   * `triggerUpdate()`. This preserves the `informMutation: false` contract
   * (write the change, but don't notify the component yet — e.g. mid-drag): the
   * doc and the derived reads stay consistent, while the React re-render is
   * skipped, exactly as the pre-rewrite in-place path did.
   */
  private suppressTrigger = false;

  /**
   * Set by the `observeDeep` handler each time it runs, so a write path can tell
   * whether its transaction actually changed the doc (Yjs fires the observer iff
   * something changed). A true no-op transaction does not fire it, in which case
   * the write path recomputes once itself — guaranteeing the derived caches are
   * rebuilt and `triggerUpdate()` fires exactly once per write.
   */
  private observerFired = false;

  /** Detaches the `observeDeep` handler on `destroy()`. */
  private readonly detachObserver: () => void;

  // ---------------------------------------------------------------------------
  // derived caches (recomputed from the doc)
  // ---------------------------------------------------------------------------

  private callbacks: Set<SceneStateCallback> = new Set();

  private nonDeletedElements: readonly Ordered<NonDeletedExcalidrawElement>[] =
    [];
  private nonDeletedElementsMap = toBrandedType<NonDeletedSceneElementsMap>(
    new Map(),
  );
  // ideally all elements within the scene should be wrapped around with `Ordered` type, but right now there is no real benefit doing so
  private elements: readonly OrderedExcalidrawElement[] = [];
  private nonDeletedFramesLikes: readonly NonDeleted<ExcalidrawFrameLikeElement>[] =
    [];
  private frames: readonly ExcalidrawFrameLikeElement[] = [];
  private elementsMap = toBrandedType<SceneElementsMap>(new Map());
  private selectedElementsCache: {
    selectedElementIds: AppState["selectedElementIds"] | null;
    elements: readonly NonDeletedExcalidrawElement[] | null;
    cache: Map<SelectionHash, NonDeletedExcalidrawElement[]>;
  } = {
    selectedElementIds: null,
    elements: null,
    cache: new Map(),
  };
  /**
   * Random integer regenerated each scene update.
   *
   * Does not relate to elements versions, it's only a renderer
   * cache-invalidation nonce at the moment.
   */
  private sceneNonce: number | undefined;

  getSceneNonce() {
    return this.sceneNonce;
  }

  getNonDeletedElementsMap() {
    return this.nonDeletedElementsMap;
  }

  getElementsIncludingDeleted() {
    return this.elements;
  }

  getElementsMapIncludingDeleted() {
    return this.elementsMap;
  }

  getNonDeletedElements() {
    return this.nonDeletedElements;
  }

  getFramesIncludingDeleted() {
    return this.frames;
  }

  constructor(
    elements: ElementsMapOrArray | null = null,
    options?: {
      skipValidation?: true;
      /**
       * Build the scene on top of a pre-existing `Y.Doc` (e.g. one decoded from
       * `applyUpdateV2`). When provided, the doc is adopted as the source of
       * truth and `elements` (if any) is ignored — the scene derives entirely
       * from the doc. The doc is the canonical, portable representation.
       */
      doc?: Y.Doc;
    },
  ) {
    this.doc = options?.doc ?? new Y.Doc();
    this.yElements = this.doc.getMap<Y.Map<unknown>>(ELEMENTS);

    // Native element history (M2): track only LOCAL_ORIGIN, so undo/redo revert
    // exclusively this replica's edits — a remote / system-origin transaction is
    // never captured nor reverted (the origin-scope M3 collaboration depends on).
    // Boundaries between undo steps are set explicitly via `stopElementCapture`
    // (see field doc), so `captureTimeout` is effectively disabled by being huge.
    this.undoManager = new Y.UndoManager(this.yElements, {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: Number.MAX_SAFE_INTEGER,
    });

    // Recompute the derived caches whenever the doc's elements change — our own
    // writes (LOCAL_ORIGIN), undo/redo, AND remote applies (REMOTE_ORIGIN, M3)
    // all flow through here, so reads are always a faithful view of the doc.
    //
    // A transaction whose origin is NOT `LOCAL_ORIGIN` mutated the doc *without*
    // going through `mutateElement` / `replaceAllElements` — i.e. an undo/redo
    // (origin = the UndoManager) or a remote apply (origin = REMOTE_ORIGIN, M3).
    // Those paths therefore did NOT refresh the local reconciliation `meta`
    // (`version`/`versionNonce`/`updated`, which the doc deliberately does not
    // store). We bump the meta for every element the transaction touched so the
    // derived element looks like a fresh change to the editor's downstream
    // change-detection (Store snapshot diffing keys off `version`, renderer cache)
    // — matching the old history's "undo produces a new version" contract, and
    // making the editor pick up a peer's edit. The initial doc adoption (no
    // transaction) is excluded.
    const observer = (
      events: Y.YEvent<Y.AbstractType<unknown>>[],
      transaction: Y.Transaction,
    ) => {
      this.observerFired = true;
      // Local origins (our own write paths) maintain `meta` themselves; only a
      // non-local transaction — an undo/redo (origin = the UndoManager) or, in
      // M3, a remote apply — needs the meta version bumped so the change is seen
      // downstream. The Scene's other local origins are excluded:
      //  - STRUCTURAL_ORIGIN: born-revealed add / prune; meta is (re)written by
      //    the paired reveal pass.
      //  - EPHEMERAL_ORIGIN: a local non-undoable write (scene load, etc.) whose
      //    meta the write path sets directly.
      if (
        transaction.origin !== LOCAL_ORIGIN &&
        transaction.origin !== STRUCTURAL_ORIGIN &&
        transaction.origin !== EPHEMERAL_ORIGIN
      ) {
        this.bumpMetaVersionsFor(changedElementIds(events));
      }
      this.recomputeFromDoc();
    };
    this.yElements.observeDeep(observer);
    this.detachObserver = () => this.yElements.unobserveDeep(observer);

    if (options?.doc) {
      // Adopt an existing doc: derive the caches from whatever it already holds.
      this.recomputeFromDoc();
    } else if (elements) {
      this.replaceAllElements(elements, options);
    }
  }

  getSelectedElements(opts: {
    // NOTE can be ommitted by making Scene constructor require App instance
    selectedElementIds: AppState["selectedElementIds"];
    /**
     * for specific cases where you need to use elements not from current
     * scene state. This in effect will likely result in cache-miss, and
     * the cache won't be updated in this case.
     */
    elements?: ElementsMapOrArray;
    // selection-related options
    includeBoundTextElement?: boolean;
    includeElementsInFrames?: boolean;
  }): NonDeleted<ExcalidrawElement>[] {
    const hash = hashSelectionOpts(opts);

    const elements = opts?.elements || this.nonDeletedElements;
    if (
      this.selectedElementsCache.elements === elements &&
      this.selectedElementsCache.selectedElementIds === opts.selectedElementIds
    ) {
      const cached = this.selectedElementsCache.cache.get(hash);
      if (cached) {
        return cached;
      }
    } else if (opts?.elements == null) {
      // if we're operating on latest scene elements and the cache is not
      //  storing the latest elements, clear the cache
      this.selectedElementsCache.cache.clear();
    }

    const selectedElements = getSelectedElements(
      elements,
      { selectedElementIds: opts.selectedElementIds },
      opts,
    );

    // cache only if we're not using custom elements
    if (opts?.elements == null) {
      this.selectedElementsCache.selectedElementIds = opts.selectedElementIds;
      this.selectedElementsCache.elements = this.nonDeletedElements;
      this.selectedElementsCache.cache.set(hash, selectedElements);
    }

    return selectedElements;
  }

  getNonDeletedFramesLikes(): readonly NonDeleted<ExcalidrawFrameLikeElement>[] {
    return this.nonDeletedFramesLikes;
  }

  getElement<T extends ExcalidrawElement>(id: T["id"]): T | null {
    return (this.elementsMap.get(id) as T | undefined) || null;
  }

  getNonDeletedElement(
    id: ExcalidrawElement["id"],
  ): NonDeleted<ExcalidrawElement> | null {
    const element = this.getElement(id);
    if (element && isNonDeletedElement(element)) {
      return element;
    }
    return null;
  }

  /**
   * A utility method to help with updating all scene elements, with the added
   * performance optimization of not renewing the array if no change is made.
   *
   * Maps all current excalidraw elements, invoking the callback for each
   * element. The callback should either return a new mapped element, or the
   * original element if no changes are made. If no changes are made to any
   * element, this results in a no-op. Otherwise, the newly mapped elements
   * are set as the next scene's elements.
   *
   * @returns whether a change was made
   */
  mapElements(
    iteratee: (element: ExcalidrawElement) => ExcalidrawElement,
  ): boolean {
    let didChange = false;
    const newElements = this.elements.map((element) => {
      const nextElement = iteratee(element);
      if (nextElement !== element) {
        didChange = true;
      }
      return nextElement;
    });
    if (didChange) {
      this.replaceAllElements(newElements);
    }
    return didChange;
  }

  /**
   * Structurally materialize a *new* element entry into `yElements` as a
   * **tombstone** (`isDeleted: true`) under `STRUCTURAL_ORIGIN`, so the
   * `Y.UndoManager` does NOT track the structural add (it would otherwise reverse
   * undo-of-create into a hard removal, losing the entry + tombstone). The real
   * `isDeleted` value is then applied by the subsequent `LOCAL_ORIGIN` "reveal"
   * pass — making creation undoable as an `isDeleted` toggle, not a structural
   * add/remove (Excalidraw's model). See {@link STRUCTURAL_ORIGIN}.
   *
   * MUST be called inside a `STRUCTURAL_ORIGIN` transaction.
   */
  private materializeNewEntry(record: ElementRecord): Y.Map<unknown> {
    const ymap = elementToYMap(record);
    // Born as a tombstone regardless of the element's real `isDeleted`; the
    // reveal pass flips it to the actual value under LOCAL_ORIGIN.
    ymap.set("isDeleted", true);
    this.yElements.set(record.id as string, ymap);
    return ymap;
  }

  /**
   * Bulk-replace the scene's elements by diffing `nextElements` into `yElements`.
   * There is no `this.elements = …` source assignment any more — the doc is the
   * source, and the derived caches are rebuilt by the `observeDeep` handler the
   * transactions trigger.
   *
   * Per element:
   * - **new** → "born-revealed": a fresh per-property `Y.Map` is structurally
   *   added as an `isDeleted: true` tombstone under `STRUCTURAL_ORIGIN`
   *   (untracked by history), then the `LOCAL_ORIGIN` pass writes its real
   *   properties — including flipping `isDeleted` to its actual value — so undo
   *   of the creation returns it to a tombstone rather than hard-removing it.
   * - **existing** → only the changed properties are written (`writeChangedKeys`)
   *   under `LOCAL_ORIGIN`, so a concurrent edit to a different property of the
   *   same element survives, and the change is an undoable history step.
   * - **removed** (present in the doc, absent from `nextElements`) → the entry is
   *   structurally deleted under `STRUCTURAL_ORIGIN` (untracked). This path is
   *   only used by non-undoable flows (reconciliation, save-time pruning of
   *   tombstones) — Excalidraw's user-facing "delete" is an `isDeleted: true`
   *   *update*, which travels through the existing-element branch above. Keeping
   *   it untracked means it never desynchronizes the element history.
   */
  replaceAllElements(
    nextElements: ElementsMapOrArray,
    options?: {
      skipValidation?: true;
      /**
       * Whether this replace is an undoable local edit (default `true`). Pass
       * `false` for `CaptureUpdateAction.NEVER` writes — scene load/init,
       * non-capturing programmatic updates, undo/redo re-application, remote
       * applies — so the change lands in the doc but produces NO undo step. See
       * {@link EPHEMERAL_ORIGIN}.
       */
      recordHistory?: boolean;
    },
  ) {
    const revealOrigin =
      options?.recordHistory === false ? EPHEMERAL_ORIGIN : LOCAL_ORIGIN;
    // we do trust the insertion order on the map, though maybe we shouldn't and should prefer order defined by fractional indices
    const _nextElements = toArray(nextElements);

    // Assign fractional indices to any element missing/owning an invalid one
    // (mutates `index` in place, exactly as before) so the doc stores a fully
    // ordered set. We validate the *synced* array (the one that actually lands in
    // the doc) — validating the pre-sync array would flag the null indices of
    // freshly created elements that `syncInvalidIndices` is about to assign.
    const ordered = syncInvalidIndices(_nextElements);

    if (!options?.skipValidation) {
      validateIndicesThrottled(ordered);
    }

    const nextIds = new Set<string>();
    for (const element of ordered) {
      nextIds.add(element.id);
    }

    // Which ids are brand-new (need the structural tombstone add) vs already in
    // the doc (plain update). Resolved before any write so the two passes agree.
    const newIds = new Set<string>();
    for (const element of ordered) {
      if (!this.yElements.has(element.id)) {
        newIds.add(element.id);
      }
    }
    const removedIds: string[] = [];
    for (const id of this.yElements.keys()) {
      if (!nextIds.has(id)) {
        removedIds.push(id);
      }
    }

    // Snapshot every element's intended own-enumerable properties BEFORE any doc
    // write. This is load-bearing: Pass 1 (the structural add of new ids) commits a
    // transaction whose observer synchronously runs `recomputeFromDoc`, which
    // reconciles the stable per-id derived objects *in place from the doc*. Many
    // callers pass those very derived objects back in (e.g. the duplicate /
    // wrap-in-container flows hand us `scene.getElementsIncludingDeleted()` with a
    // re-`index`ed subset). So that intermediate recompute would overwrite a
    // caller's freshly-assigned `index` (and any other not-yet-persisted field) back
    // to the *stale* doc value — and Pass 2 would then see "record == doc" and skip
    // the write, silently dropping the reorder. Writing Pass 2 from these immutable
    // snapshots makes the persisted values independent of the live objects, so a
    // reorder that coincides with an add (new clone + reordered originals) survives.
    const snapshots = new Map<string, ElementRecord>();
    for (const element of ordered) {
      snapshots.set(element.id, { ...(element as unknown as ElementRecord) });
    }

    this.observerFired = false;

    // Pass 1 (STRUCTURAL_ORIGIN, untracked by history): born-as-tombstone adds for
    // NEW ids only. Skipped when there are no new ids (the common edit case), so a
    // pure update is a single tracked transaction.
    //
    // Why only adds here, not removals: an element dropped from `nextElements` is
    // *structurally removed* in the tracked reveal pass below, so undo can RE-ADD
    // it (restore). New-element adds, by contrast, must be untracked here so that
    // undo-of-create reverses only the tracked "reveal" (→ tombstone) rather than
    // hard-removing the entry — see {@link STRUCTURAL_ORIGIN}.
    //
    // Its `triggerUpdate()` is suppressed: this pass produces an intermediate
    // state (new elements still tombstoned, pre-reveal), and a single
    // `replaceAllElements` must fire exactly one update — the reveal pass below
    // fires it once the elements hold their real values.
    if (newIds.size) {
      const prevSuppress = this.suppressTrigger;
      this.suppressTrigger = true;
      try {
        this.doc.transact(() => {
          for (const element of ordered) {
            if (newIds.has(element.id)) {
              this.materializeNewEntry(snapshots.get(element.id)!);
            }
          }
        }, STRUCTURAL_ORIGIN);
      } finally {
        this.suppressTrigger = prevSuppress;
      }
    }

    // Reset so `observerFired` reflects ONLY whether the (trigger-firing) reveal
    // pass below changed the doc.
    this.observerFired = false;

    // Pass 2 (reveal/update, tracked unless recordHistory:false): structurally
    // remove dropped ids (so the doc — and thus `getElementsIncludingDeleted()` —
    // matches the passed set exactly, as the pre-rewrite scene array did; a
    // recording removal is captured so undo RE-ADDS the entry, and the editor's
    // Store still synthesizes an `isDeleted:true` delta for reconciliation/history
    // by diffing the derived elements), write each element's real property values
    // (the "reveal" for new ids flips `isDeleted` to its actual value; for existing
    // ids this is the ordinary per-property diff), and refresh the local
    // reconciliation metadata + stable derived object per id.
    this.doc.transact(() => {
      for (const id of removedIds) {
        this.yElements.delete(id);
        this.meta.delete(id);
        this.derivedById.delete(id);
      }
      for (const element of ordered) {
        // Write from the pre-write snapshot (not the live object): the Pass-1
        // recompute may have reconciled `element` in place from the still-stale
        // doc, so its `index`/props can no longer reflect the caller's intent. The
        // snapshot does.
        const record = snapshots.get(element.id)!;
        const ymap = this.yElements.get(element.id);
        if (ymap) {
          writeChangedKeys(ymap, record);
        }
        // Capture the element's (locally maintained) reconciliation metadata +
        // any own-Symbol props (e.g. ORIG_ID) — not stored in the doc, but the
        // derived element must expose them. Version/etc. come from the snapshot so
        // a Pass-1 recompute that bumped the live object cannot make the meta
        // disagree with what we just persisted. Own-Symbols are read from the live
        // `element`: they are non-enumerable (ORIG_ID) so a spread snapshot omits
        // them, and the recompute re-stamps them, so the live object is canonical.
        this.meta.set(element.id, {
          version: record.version as number,
          versionNonce: record.versionNonce as number,
          updated: record.updated as number,
          symbols: captureOwnSymbols(element),
          boundElementsEmpty: isEmptyBoundElements(record),
        });
        if ((record.version as number) > this.versionHighWater) {
          this.versionHighWater = record.version as number;
        }
        // Adopt the caller-supplied object as this id's stable derived object, so
        // a reference the caller still holds tracks the doc (the recompute that
        // follows overwrites this object's fields *from* `yElements` — the doc
        // stays the source of truth). Matches the pre-rewrite behaviour, where
        // `replaceAllElements` kept the passed array's objects live.
        this.derivedById.set(
          element.id,
          element as unknown as Mutable<OrderedExcalidrawElement>,
        );
      }
    }, revealOrigin);

    // Yjs fires the observer (→ recompute → triggerUpdate) iff a transaction
    // changed the doc. For a true no-op (e.g. re-asserting identical elements) it
    // does not, so recompute once here to keep the derived caches coherent and to
    // preserve the historical side effect of always firing on replaceAllElements.
    if (!this.observerFired) {
      this.recomputeFromDoc();
    }
  }

  /**
   * Reconcile the stable per-id derived object with a freshly materialized
   * `record` (doc state + metadata). Reuses the existing object's identity,
   * overwriting changed enumerable keys and deleting keys the doc no longer has,
   * then re-stamps own-`Symbol` props (e.g. ORIG_ID). For a new id, the `record`
   * itself becomes the stable object. Returns the stable object.
   */
  private reconcileDerived(
    id: string,
    record: ElementRecord,
    meta: ElementMeta,
  ): OrderedExcalidrawElement {
    const existing = this.derivedById.get(id);

    const applySymbols = (obj: object) => {
      if (meta.symbols) {
        for (const [sym, desc] of meta.symbols) {
          Object.defineProperty(obj, sym, desc);
        }
      }
    };

    if (!existing) {
      applySymbols(record);
      const fresh = record as unknown as Mutable<OrderedExcalidrawElement>;
      this.derivedById.set(id, fresh);
      return fresh;
    }

    const target = existing as unknown as ElementRecord;
    // Remove keys the doc no longer has (excluding own symbols, handled below).
    for (const key of Object.keys(target)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        delete target[key];
      }
    }
    // Overwrite/insert the current keys — but only when the value actually
    // changed, so an unchanged object/array sub-value keeps its existing
    // reference (Excalidraw relies on sub-value identity stability, e.g. an
    // image's `crop` object staying `===` across operations that don't touch it,
    // and stable refs avoid spurious renderer cache invalidation).
    for (const key of Object.keys(record)) {
      const nextValue = record[key];
      const prevValue = target[key];
      if (prevValue === nextValue) {
        continue;
      }
      if (
        typeof nextValue === "object" &&
        nextValue !== null &&
        typeof prevValue === "object" &&
        prevValue !== null &&
        deepEqual(prevValue, nextValue)
      ) {
        continue; // value-equal object/array → keep the existing reference
      }
      target[key] = nextValue;
    }
    applySymbols(existing);
    return existing as OrderedExcalidrawElement;
  }

  /**
   * Bump the local reconciliation `meta` (`version`/`versionNonce`/`updated`) for
   * every element id changed by a non-local (undo/redo, or M3 remote) doc
   * transaction, so the next `recomputeFromDoc` re-derives the element with a
   * strictly-greater `version` — making the editor's change-detection treat it as
   * a fresh change (the old history bumped `version` on undo for the same reason).
   *
   * `"full"` (an unresolvable event path) bumps every currently-known id, erring
   * toward over-notifying rather than dropping a change.
   */
  private bumpMetaVersionsFor(changed: Set<string> | "full") {
    const ids =
      changed === "full" ? new Set<string>(this.meta.keys()) : changed;
    for (const id of ids) {
      const meta = this.meta.get(id);
      if (meta) {
        meta.version = meta.version + 1;
        if (meta.version > this.versionHighWater) {
          this.versionHighWater = meta.version;
        }
        meta.versionNonce = randomInteger();
        meta.updated = getUpdatedTimestamp();
      }
      // No local meta yet (e.g. an element re-created by redo, or a brand-new
      // remote element): `recomputeFromDoc` seeds fresh meta for it from the
      // version high-water mark, which is already a "new" version — nothing to
      // bump here.
    }
  }

  /**
   * Recompute every derived cache from `yElements` and fire `triggerUpdate()`.
   *
   * This is the single read-derivation point: each element's fields are
   * (re)written from its `Y.Map` via `yMapToElement`, the locally-maintained
   * reconciliation metadata is re-attached, the array is ordered by fractional
   * `index`, and the frames/non-deleted views are rebuilt. Derived objects have
   * stable identity per id (reused + updated in place — see {@link derivedById})
   * so the editor's pervasive held references keep reflecting the doc; the doc
   * remains the single source of truth (every field comes *from* `yElements`).
   */
  private recomputeFromDoc() {
    const next: OrderedExcalidrawElement[] = [];
    const seen = new Set<string>();

    for (const [id, ymap] of this.yElements.entries()) {
      seen.add(id);
      const record = yMapToElement(ymap);
      record.id = id;

      // Re-attach the per-peer reconciliation metadata the doc does not store.
      let meta = this.meta.get(id);
      if (!meta) {
        // An element present in the doc with no local metadata — either a doc
        // decoded from `applyUpdateV2` on a fresh Scene, or an element that
        // REAPPEARED after a structural removal (e.g. undo re-adding a dropped
        // element). Seed its version from the monotonic high-water mark so a
        // reappearance always out-versions whatever the editor's Store last saw
        // for this id (see {@link versionHighWater}); the values only need to be
        // present + to advance on change (cross-replica they are re-derived,
        // OPEN-3).
        meta = {
          version: ++this.versionHighWater,
          versionNonce: randomInteger(),
          updated: getUpdatedTimestamp(),
        };
        this.meta.set(id, meta);
      }
      record.version = meta.version;
      record.versionNonce = meta.versionNonce;
      record.updated = meta.updated;

      // Restore the `[]` vs `null` distinction the CRDT collapses: an empty bound
      // set decodes to `null`, but if this element's source was an empty array,
      // present it as `[]` (local view state — see ElementMeta.boundElementsEmpty).
      if (meta.boundElementsEmpty && record.boundElements == null) {
        record.boundElements = [];
      }

      // Reuse the stable per-id object (so held references stay valid), updating
      // its fields in place to match the doc. New ids get a fresh object.
      const target = this.reconcileDerived(id, record, meta);
      next.push(target);
    }

    // Drop metadata + stable objects for elements that no longer exist in the doc.
    if (this.meta.size > seen.size) {
      for (const id of [...this.meta.keys()]) {
        if (!seen.has(id)) {
          this.meta.delete(id);
        }
      }
    }
    if (this.derivedById.size > seen.size) {
      for (const id of [...this.derivedById.keys()]) {
        if (!seen.has(id)) {
          this.derivedById.delete(id);
        }
      }
    }

    // Order by fractional index (ties by id) — identical semantics to the
    // pre-rewrite `syncInvalidIndices`-ordered array. `orderByFractionalIndex`
    // sorts in place; `next` is our own fresh array so that is safe.
    orderByFractionalIndex(next);

    const nextFrameLikes: ExcalidrawFrameLikeElement[] = [];
    const elementsMap = toBrandedType<SceneElementsMap>(new Map());
    for (const element of next) {
      if (isFrameLikeElement(element)) {
        nextFrameLikes.push(element);
      }
      elementsMap.set(element.id, element);
    }

    this.elements = next;
    this.elementsMap = elementsMap;

    const nonDeletedElements = getNonDeletedElements(this.elements);
    this.nonDeletedElements = nonDeletedElements.elements;
    this.nonDeletedElementsMap = nonDeletedElements.elementsMap;

    this.frames = nextFrameLikes;
    this.nonDeletedFramesLikes = getNonDeletedElements(this.frames).elements;

    if (!this.suppressTrigger) {
      this.triggerUpdate();
    }
  }

  triggerUpdate() {
    this.sceneNonce = randomInteger();

    for (const callback of Array.from(this.callbacks)) {
      callback();
    }
  }

  onUpdate(cb: SceneStateCallback): SceneStateCallbackRemover {
    if (this.callbacks.has(cb)) {
      throw new Error();
    }

    this.callbacks.add(cb);

    return () => {
      if (!this.callbacks.has(cb)) {
        throw new Error();
      }
      this.callbacks.delete(cb);
    };
  }

  // ---------------------------------------------------------------------------
  // collaboration surface (native-Yjs core, M3) — the doc IS the wire.
  //
  // Collaboration is just exchanging Yjs updates on `this.doc`. There is no
  // scene-broadcast and no JSON reconciliation any more: a local edit (already a
  // `LOCAL_ORIGIN` doc transaction) emits an update via {@link onDocUpdate}; a
  // remote peer's update is integrated via {@link applyRemoteUpdate} under
  // `REMOTE_ORIGIN`, which flows through `observeDeep` → `recomputeFromDoc` so the
  // editor re-renders, while the UndoManager (tracking only `LOCAL_ORIGIN`)
  // ignores it. Yjs converges per-property natively, so concurrent edits merge
  // without a bespoke merge path. These thin methods are the provider's hook
  // points; the provider owns only the transport (sockets/awareness/files).
  // ---------------------------------------------------------------------------

  /**
   * Apply a remote peer's Yjs update to `this.doc` under {@link REMOTE_ORIGIN}.
   *
   * The update integrates inside a `doc.transact` whose origin is `REMOTE_ORIGIN`
   * (distinct from every local origin), which is the linchpin of M3:
   *  - the `Y.UndoManager` (tracks only `LOCAL_ORIGIN`) never captures it, so a
   *    local `undo()` can never revert a peer's edit;
   *  - the `observeDeep` handler sees a non-local origin and bumps the local
   *    reconciliation `meta` for every changed id, so the editor's Store
   *    change-detection (which keys off `version`) picks the remote edit up;
   *  - `recomputeFromDoc` then re-derives the affected elements from the merged
   *    doc and fires `triggerUpdate()` → the editor re-renders.
   *
   * Accepts both the v1 (`Y.applyUpdate`) and v2 (`Y.applyUpdateV2`) wire formats;
   * the provider/transport decides which it speaks. Idempotent: re-applying an
   * already-integrated update is a Yjs no-op (and fires no observer).
   */
  applyRemoteUpdate(update: Uint8Array, format: "v1" | "v2" = "v1"): void {
    if (format === "v2") {
      Y.applyUpdateV2(this.doc, update, REMOTE_ORIGIN);
    } else {
      Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
    }
  }

  /**
   * Encode the doc's current state as a Yjs update the provider can send to a
   * peer (e.g. the initial state for a newly-joined client, or a full resync).
   * `v2` is the more compact format; pass the encoded `targetStateVector` to send
   * only the delta a peer is missing.
   */
  encodeStateAsUpdate(
    format: "v1" | "v2" = "v1",
    targetStateVector?: Uint8Array,
  ): Uint8Array {
    return format === "v2"
      ? Y.encodeStateAsUpdateV2(this.doc, targetStateVector)
      : Y.encodeStateAsUpdate(this.doc, targetStateVector);
  }

  /** The doc's state vector — what this replica already has — so a peer can
   * compute the minimal delta to send back (`encodeStateAsUpdate(v, sv)`). The
   * state vector is wire-format-agnostic (a map of client→clock), so a single
   * encoding feeds both `encodeStateAsUpdate` and `encodeStateAsUpdateV2`. */
  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * Subscribe to Yjs updates the provider must broadcast — i.e. updates this
   * replica ORIGINATED (local edits + undo/redo), NOT echoes of remote applies.
   *
   * The handler is invoked with the encoded update bytes and only for
   * transactions whose origin is NOT `REMOTE_ORIGIN`: a remote apply must never
   * be re-broadcast (that is the echo loop the old binding fought with a
   * re-entrancy guard; here it falls out of the origin). Pass `format: "v2"` to
   * receive the v2 wire format. Returns an unsubscribe function.
   *
   * (Awareness/cursors/emoji/files are ephemeral or out-of-band and are NOT part
   * of this — they never touch `this.doc`; the provider routes them separately.)
   */
  onDocUpdate(
    cb: (update: Uint8Array) => void,
    format: "v1" | "v2" = "v1",
  ): () => void {
    const event = format === "v2" ? "updateV2" : "update";
    const handler = (
      update: Uint8Array,
      origin: unknown,
      _doc: Y.Doc,
      _tr: Y.Transaction,
    ) => {
      // Do not re-broadcast a remote apply — only updates this replica originated.
      if (origin === REMOTE_ORIGIN) {
        return;
      }
      cb(update);
    };
    this.doc.on(event, handler);
    return () => this.doc.off(event, handler);
  }

  // ---------------------------------------------------------------------------
  // native element history (native-Yjs core, M2) — thin pass-throughs over the
  // doc's `Y.UndoManager`. The excalidraw-layer `History` facade pairs these with
  // its appState-undo side stack and exposes the editor-facing API.
  // ---------------------------------------------------------------------------

  /** Whether an element-undo step is available on the doc's UndoManager. */
  canUndoElements(): boolean {
    return this.undoManager.canUndo();
  }

  /** Whether an element-redo step is available on the doc's UndoManager. */
  canRedoElements(): boolean {
    return this.undoManager.canRedo();
  }

  /**
   * Revert the most recent local element undo step on the doc.
   *
   * `undoManager.undo()` applies the inverse mutation to `yElements` in a
   * transaction whose origin is the UndoManager itself (NOT `LOCAL_ORIGIN`), so
   * it is not re-captured as a new step; the `observeDeep` handler fires and
   * `recomputeFromDoc` refreshes the derived reads + the React render. Returns
   * `true` iff a step was actually applied.
   */
  undoElements(): boolean {
    return this.undoManager.undo() !== null;
  }

  /** Re-apply the most recently undone local element step on the doc. */
  redoElements(): boolean {
    return this.undoManager.redo() !== null;
  }

  /**
   * Seal the current undo step. The next captured local edit starts a fresh
   * `StackItem` instead of merging into the current one — this is how discrete
   * user actions become discrete undo steps while rapid edits within one action
   * still coalesce. Called by the editor at each durable-commit boundary.
   */
  stopElementCapture(): void {
    this.undoManager.stopCapturing();
  }

  /** Clear both element undo + redo stacks (e.g. on scene reset / load). */
  clearElementHistory(): void {
    this.undoManager.clear();
  }

  /**
   * Subscribe to element undo/redo stack changes (item added / popped /
   * cleared). Used by the `History` facade to re-emit the editor's
   * "history changed" event so the toolbar undo/redo buttons enable/disable.
   * Returns an unsubscribe function.
   */
  onElementHistoryChange(cb: () => void): () => void {
    this.undoManager.on("stack-item-added", cb);
    this.undoManager.on("stack-item-popped", cb);
    this.undoManager.on("stack-cleared", cb);
    return () => {
      this.undoManager.off("stack-item-added", cb);
      this.undoManager.off("stack-item-popped", cb);
      this.undoManager.off("stack-cleared", cb);
    };
  }

  destroy() {
    this.detachObserver();
    this.undoManager.destroy();
    this.doc.destroy();

    this.elements = [];
    this.nonDeletedElements = [];
    this.nonDeletedFramesLikes = [];
    this.frames = [];
    this.elementsMap = toBrandedType<SceneElementsMap>(new Map());
    this.nonDeletedElementsMap = toBrandedType<NonDeletedSceneElementsMap>(
      new Map(),
    );
    this.meta.clear();
    this.derivedById.clear();
    this.selectedElementsCache.selectedElementIds = null;
    this.selectedElementsCache.elements = null;
    this.selectedElementsCache.cache.clear();

    // done not for memory leaks, but to guard against possible late fires
    // (I guess?)
    this.callbacks.clear();
  }

  /** low-level - generally use app.insertNewElements() */
  insertElementsAtIndex(
    elements: ExcalidrawElement[],
    /** null indicates end of the array */
    index: number | null,
  ) {
    if (!elements.length) {
      return;
    }

    if (index === null) {
      index = this.elements.length;
    }

    if (!Number.isFinite(index) || index < 0) {
      throw new Error(
        "insertElementAtIndex can only be called with index >= 0",
      );
    }

    const nextElements = [
      ...this.elements.slice(0, index),
      ...elements,
      ...this.elements.slice(index),
    ];

    syncMovedIndices(nextElements, arrayToMap(elements));

    this.replaceAllElements(nextElements);
  }

  /** low-level - generally use app.insertNewElement() */
  insertElement = (element: ExcalidrawElement) => {
    this.insertElementsAtIndex([element], null);
  };

  getElementIndex(elementId: string) {
    return this.elements.findIndex((element) => element.id === elementId);
  }

  getContainerElement = (
    element:
      | (ExcalidrawElement & {
          containerId: ExcalidrawElement["id"] | null;
        })
      | null,
  ) => {
    if (!element) {
      return null;
    }
    if (element.containerId) {
      return this.getElement(element.containerId) || null;
    }
    return null;
  };

  getElementsFromId = (id: string): ExcalidrawElement[] => {
    const elementsMap = this.getNonDeletedElementsMap();
    // first check if the id is an element
    const el = elementsMap.get(id);
    if (el) {
      return [el];
    }

    // then, check if the id is a group
    return getElementsInGroup(elementsMap, id);
  };

  // Mutate an element with passed updates and trigger the component to update. Make sure you
  // are calling it either from a React event handler or within unstable_batchedUpdates().
  //
  // Native-Yjs core (M1): the normalization (elbow-arrow/points/size) and the
  // skip-if-unchanged rules still run via the in-place `mutateElement` (which also
  // bumps `version`/`versionNonce`/`updated` on the passed object — these are kept
  // for the editor's reconciliation but NOT stored in the doc). The *changed*
  // properties are then written to that element's per-property `Y.Map` inside a
  // `doc.transact`, which makes the doc the source of truth. The element returned
  // reflects the doc (the fresh doc-derived object when one exists).
  mutateElement<TElement extends Mutable<ExcalidrawElement>>(
    element: TElement,
    updates: ElementUpdate<TElement>,
    options: {
      informMutation: boolean;
      isDragging: boolean;
      isBindingEnabled?: boolean;
      isMidpointSnappingEnabled?: boolean;
      /**
       * Whether this mutation is an undoable local edit (default `true`). Pass
       * `false` for `CaptureUpdateAction.NEVER` mutations so the doc changes but
       * no undo step is produced. See {@link EPHEMERAL_ORIGIN}.
       */
      recordHistory?: boolean;
    } = {
      informMutation: true,
      isDragging: false,
    },
  ): TElement {
    const writeOrigin =
      options.recordHistory === false ? EPHEMERAL_ORIGIN : LOCAL_ORIGIN;
    const elementsMap = this.getNonDeletedElementsMap();

    const { version: prevVersion } = element;
    const { version: nextVersion } = mutateElement(
      element,
      elementsMap,
      updates,
      options,
    );

    const inScene = this.elementsMap.has(element.id);
    const changed = prevVersion !== nextVersion;

    if (inScene && changed) {
      // Persist the per-property delta to the doc. `mutateElement` may normalize
      // beyond the literal `updates` (elbow arrows rewrite points/x/y/width/…),
      // so we diff the whole post-state element against the doc's current map via
      // `writeChangedKeys` (which writes only the keys that actually differ),
      // rather than trusting `updates`.
      //
      // `informMutation: false` ⇒ write the change but don't notify the component
      // (mid-drag), so we suppress the `triggerUpdate()` the observer would fire.
      const prevSuppress = this.suppressTrigger;
      this.suppressTrigger = prevSuppress || !options.informMutation;
      try {
        // Born-revealed: if this element is not yet in the doc, structurally add
        // it as a tombstone under STRUCTURAL_ORIGIN (untracked by history) first,
        // so the LOCAL_ORIGIN write below is a history-tracked reveal/update
        // rather than a structural add (which undo would hard-remove). Mirrors
        // `replaceAllElements`. (Normally `mutateElement` targets an existing
        // element; this is the rare create-via-mutate path.)
        if (!this.yElements.has(element.id)) {
          this.doc.transact(() => {
            this.materializeNewEntry(element as unknown as ElementRecord);
          }, STRUCTURAL_ORIGIN);
        }
        this.doc.transact(() => {
          const ymap = this.yElements.get(element.id);
          if (ymap) {
            writeChangedKeys(ymap, element as unknown as ElementRecord);
          }
          this.meta.set(element.id, {
            version: element.version,
            versionNonce: element.versionNonce,
            updated: element.updated,
            symbols: captureOwnSymbols(element),
            boundElementsEmpty: isEmptyBoundElements(
              element as unknown as ElementRecord,
            ),
          });
          if (element.version > this.versionHighWater) {
            this.versionHighWater = element.version;
          }
          // Adopt the just-mutated object as this id's stable derived object, so
          // the caller's reference stays the live one and tracks future recomputes
          // (its fields are overwritten *from* the doc by the recompute — the doc
          // stays the source of truth).
          this.derivedById.set(
            element.id,
            element as unknown as Mutable<OrderedExcalidrawElement>,
          );
        }, writeOrigin);
      } finally {
        this.suppressTrigger = prevSuppress;
      }

      // `element` was adopted as this id's stable derived object and the recompute
      // (re)wrote its fields from the doc, so it now reflects the doc — return it.
      return element;
    }

    return element;
  }
}
