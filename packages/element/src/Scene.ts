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

  /** Carries `version`/`versionNonce`/`updated` forward across recomputes (these
   * are intentionally NOT stored in the doc — see {@link ElementMeta}). */
  private meta: Map<string, ElementMeta> = new Map();

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

    // Recompute the derived caches whenever the doc's elements change — our own
    // writes (LOCAL_ORIGIN) and, in later milestones, remote applies both flow
    // through here, so reads are always a faithful view of the doc.
    const observer = () => {
      this.observerFired = true;
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
   * Bulk-replace the scene's elements by diffing `nextElements` into `yElements`
   * inside a single `doc.transact`. There is no `this.elements = …` source
   * assignment any more — the doc is the source, and the derived caches are
   * rebuilt by the `observeDeep` handler the transaction triggers.
   *
   * Per element:
   * - **new** → a fresh per-property `Y.Map` (`elementToYMap`).
   * - **existing** → only the changed properties are written (`writeChangedKeys`),
   *   so a concurrent edit to a different property of the same element survives.
   * - **removed** (present in the doc, absent from `nextElements`) → the element
   *   entry is deleted from `yElements`. (Excalidraw's own "delete" is a
   *   `isDeleted: true` tombstone that arrives as an *update*, not a removal; a
   *   true removal here means the element is no longer part of the scene at all.)
   */
  replaceAllElements(
    nextElements: ElementsMapOrArray,
    options?: {
      skipValidation?: true;
    },
  ) {
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

    this.observerFired = false;
    this.doc.transact(() => {
      // upserts
      for (const element of ordered) {
        const record = element as unknown as ElementRecord;
        let ymap = this.yElements.get(element.id);
        if (!ymap) {
          ymap = elementToYMap(record);
          this.yElements.set(element.id, ymap);
        } else {
          writeChangedKeys(ymap, record);
        }
        // Capture the element's (locally maintained) reconciliation metadata +
        // any own-Symbol props (e.g. ORIG_ID) — not stored in the doc, but the
        // derived element must expose them.
        this.meta.set(element.id, {
          version: element.version,
          versionNonce: element.versionNonce,
          updated: element.updated,
          symbols: captureOwnSymbols(element),
          boundElementsEmpty: isEmptyBoundElements(record),
        });
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

      // removals: ids in the doc but not in the next set
      for (const id of [...this.yElements.keys()]) {
        if (!nextIds.has(id)) {
          this.yElements.delete(id);
          this.meta.delete(id);
          this.derivedById.delete(id);
        }
      }
    }, LOCAL_ORIGIN);

    // Yjs fires the observer (→ recompute → triggerUpdate) iff the transaction
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
        // An element present in the doc with no local metadata — e.g. a doc
        // decoded from `applyUpdateV2` on a fresh Scene. Seed deterministic
        // initial metadata (the editor only needs these to be present + to
        // change on edit; cross-replica they are re-derived, per OPEN-3).
        meta = {
          version: 1,
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

  destroy() {
    this.detachObserver();
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
    } = {
      informMutation: true,
      isDragging: false,
    },
  ): TElement {
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
        this.doc.transact(() => {
          let ymap = this.yElements.get(element.id);
          if (!ymap) {
            ymap = elementToYMap(element as unknown as ElementRecord);
            this.yElements.set(element.id, ymap);
          } else {
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
          // Adopt the just-mutated object as this id's stable derived object, so
          // the caller's reference stays the live one and tracks future recomputes
          // (its fields are overwritten *from* the doc by the recompute — the doc
          // stays the source of truth).
          this.derivedById.set(
            element.id,
            element as unknown as Mutable<OrderedExcalidrawElement>,
          );
        }, LOCAL_ORIGIN);
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
