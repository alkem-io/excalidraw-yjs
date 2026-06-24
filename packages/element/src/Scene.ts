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
} from "@excalidraw-yjs/common";
import { isNonDeletedElement } from "@excalidraw-yjs/element";
import { isFrameLikeElement } from "@excalidraw-yjs/element";
import { getElementsInGroup } from "@excalidraw-yjs/element";

import {
  syncInvalidIndices,
  syncMovedIndices,
  validateFractionalIndices,
  orderByFractionalIndex,
} from "@excalidraw-yjs/element";

import { getSelectedElements } from "@excalidraw-yjs/element";

import { mutateElement, type ElementUpdate } from "@excalidraw-yjs/element";

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
} from "@excalidraw-yjs/element/types";

import type {
  Assert,
  Mutable,
  SameType,
} from "@excalidraw-yjs/common/utility-types";

import {
  ELEMENTS,
  FILES,
  APPSTATE,
  LOCAL_ORIGIN,
  STRUCTURAL_ORIGIN,
  EPHEMERAL_ORIGIN,
  REMOTE_ORIGIN,
  elementToYMap,
  yMapToElement,
  writeChangedKeys,
  writeFiles,
  readFiles,
  writeAppState,
  readAppState,
  type ElementRecord,
  type FileRecord,
  type AppStateAllowKey,
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
 * `Scene` still has to expose them on every derived (freshly minted) snapshot
 * because the editor's change-detection, history, and reconciliation read them. We
 * therefore maintain them in this side table, keyed by element id, and re-attach
 * them on every recompute. The write paths (`replaceAllElements`,
 * `scene.mutateElement`) refresh the entry from the just-normalized scratch
 * element / pre-write snapshot so the values match exactly what the editor
 * produced.
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
  //
  // DERIVED ELEMENTS ARE FRESH, IMMUTABLE SNAPSHOTS (native-Yjs core, bridge
  // elimination). The `Y.Doc` is the ONLY mutable state. `recomputeFromDoc` mints
  // a BRAND-NEW object per id every pass — there is no stable-identity reuse, no
  // per-id object cache; identity is deliberately NOT stable across recomputes.
  // A derived element is a read-only view of one coherent committed doc state:
  //
  //  - To CHANGE an element you MUST funnel through `scene.mutateElement(idOrEl,
  //    updates)` (or `replaceAllElements`), which writes to the doc inside
  //    `doc.transact`; the observer then re-derives fresh snapshots. Mutating a
  //    derived object in place is a no-op against the doc (nothing ever reads a
  //    derived object back into `yElements`) — so such a mutation is silently
  //    lost. Callers that need the post-mutation element must use the value
  //    `scene.mutateElement` RETURNS (`el = scene.mutateElement(el, {...})`), or
  //    re-read via `getElement(id)`; a reference held across a mutation is a stale
  //    snapshot and does NOT reflect the change.
  //  - A reference held across a REMOTE apply is likewise a stale snapshot — but
  //    that is correct: the editor's synchronous handlers always re-read the scene
  //    on the next turn, and a remote apply only runs *between* turns (JS is
  //    single-threaded, the Scene has no `await`). A snapshot can never be torn
  //    (each recompute reads one fully-merged, post-commit doc state) and can
  //    never be *stale within a turn* — so collaboration gets strictly MORE
  //    correct, not less, than the old reuse bridge (which mutated a shared object
  //    in place and could in principle be observed mid-rewrite by an aliasing
  //    holder). This is why the M3 convergence proof still holds.

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
   * Native-Yjs core (M4): files and the persistable appState subset are ALSO on
   * this doc ({@link yFiles} / {@link yAppState}), so `encodeStateAsUpdateV2(doc)`
   * is a complete, portable whiteboard snapshot — the exact format the Alkemio
   * server / collab-service stores (`getMap("elements")` + `getMap("files")` +
   * `getMap("appState")`). Persistence is therefore native: create/load/save
   * encode/decode THIS doc, not element JSON. (Local-only appState — selection /
   * zoom / scroll / active tool — is NEVER on the doc.)
   */
  public readonly doc: Y.Doc;

  public readonly yElements: Y.Map<Y.Map<unknown>>;

  /**
   * The scene's image binaries (native-Yjs core, M4): `Y.Map<fileId,
   * BinaryFileData>` (`doc.getMap(FILES)`), in the SAME doc as the elements so a
   * saved doc carries the whole whiteboard. Each value is the flat
   * `BinaryFileData` record stored whole (JSON-leaf) — files are only ever
   * added/removed, never sub-merged. Written via {@link setFiles} / read via
   * {@link getFiles}. The renderer keeps consuming a plain files object; the doc
   * is just where they now live and persist.
   */
  public readonly yFiles: Y.Map<unknown>;

  /**
   * The persistable / collaborative appState subset (native-Yjs core, M4):
   * `Y.Map<key, value>` (`doc.getMap(APPSTATE)`) holding ONLY the
   * `APPSTATE_ALLOW_LIST` keys (scene background + name). Everything else in
   * Excalidraw's appState is local-only and is NEVER written here (it must not
   * persist and must not collaborate). Written via {@link setAppState} / read via
   * {@link getPersistedAppState}.
   */
  public readonly yAppState: Y.Map<unknown>;

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
    // Files + the persistable appState subset live in the SAME doc (M4), so an
    // encoded doc is a complete whiteboard snapshot. `getMap` is idempotent —
    // when a pre-decoded doc is adopted these resolve to its existing maps.
    this.yFiles = this.doc.getMap<unknown>(FILES);
    this.yAppState = this.doc.getMap<unknown>(APPSTATE);

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

    // Files live on the SAME doc (M4), so a change to `yFiles` — a local
    // `setFiles`, OR a remote files apply (REMOTE_ORIGIN, M3), OR a load
    // (`EPHEMERAL_ORIGIN`) — must notify the same `callbacks` as an element
    // change, so the editor refreshes its in-memory files cache and re-renders.
    // `.observe` (not `observeDeep`): each `yFiles` value is a whole FileRecord
    // stored as a JSON-leaf — files are added/removed, never sub-merged (see the
    // {@link yFiles} doc), so a shallow observe captures every file mutation.
    // Read-only on the App side (refresh from `getFiles()`), so this can never
    // echo: the observer does not write back, it only fires `triggerUpdate`.
    const filesObserver = () => {
      // Honor the same `informMutation:false` suppression window as the element
      // recompute, so a files write coinciding with a suppressed element write
      // (e.g. mid-gesture) does not force a React re-render early.
      if (!this.suppressTrigger) {
        this.triggerUpdate();
      }
    };
    this.yFiles.observe(filesObserver);

    this.detachObserver = () => {
      this.yElements.unobserveDeep(observer);
      this.yFiles.unobserve(filesObserver);
    };

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
    // write, and write Pass 2 from these snapshots rather than the live objects.
    // Two reasons:
    //  1. Pass 1 (the structural add of new ids) commits a transaction whose
    //     observer synchronously runs `recomputeFromDoc`. Under the old reuse
    //     bridge that recompute mutated the caller's derived objects in place,
    //     which could clobber a freshly-assigned `index`. Fresh-snapshot derivation
    //     no longer touches caller objects at all, so that clobber is gone — but
    //     writing from an immutable pre-write snapshot keeps Pass 2 independent of
    //     ANY aliasing the caller might have (e.g. a caller that mutates `ordered`
    //     between passes), so a reorder coinciding with an add still survives.
    //  2. The snapshot is also where the per-element values feeding `meta` come
    //     from, so the metadata we record matches exactly what we persist.
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
    // reconciliation metadata per id. The doc is the only state written; the
    // derived snapshots are minted fresh from it by the recompute that follows.
    this.doc.transact(() => {
      for (const id of removedIds) {
        this.yElements.delete(id);
        this.meta.delete(id);
      }
      for (const element of ordered) {
        // Write from the pre-write snapshot, not the live object — see the
        // snapshot rationale above (keeps the persisted values independent of any
        // caller aliasing of `ordered`).
        const record = snapshots.get(element.id)!;
        const ymap = this.yElements.get(element.id);
        if (ymap) {
          writeChangedKeys(ymap, record);
        }
        // Capture the element's (locally maintained) reconciliation metadata +
        // any own-Symbol props (e.g. ORIG_ID) — not stored in the doc, but the
        // derived snapshot must expose them. Version/etc. come from the snapshot,
        // so the meta matches exactly what we just persisted. Own-Symbols are read
        // from the live `element`: they are non-enumerable (ORIG_ID) so a spread
        // snapshot omits them, and the recompute re-stamps them onto the fresh
        // snapshot, so the live object is the canonical carrier.
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
   * Stamp the carried own-`Symbol` props (e.g. ORIG_ID — a non-enumerable
   * test-only marker the doc cannot store; see {@link ElementMeta}) onto a freshly
   * materialized derived snapshot. No-op when there are none (the common case).
   */
  private applySymbols(obj: object, meta: ElementMeta): void {
    if (meta.symbols) {
      for (const [sym, desc] of meta.symbols) {
        Object.defineProperty(obj, sym, desc);
      }
    }
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
   * This is the single read-derivation point. For each element it mints a
   * **brand-new, immutable snapshot object** from its `Y.Map` via `yMapToElement`
   * (the locally-maintained reconciliation metadata + own-Symbol props are
   * re-attached), orders the array by fractional `index`, and rebuilds the
   * frames/non-deleted views.
   *
   * Identity is deliberately NOT stable: a recompute does not reuse the previous
   * pass's objects (there is no per-id object cache). A reference a caller held
   * before this recompute keeps pointing at the OLD snapshot — it does not observe
   * the new doc state. That is the fresh-snapshot contract: the doc is the only
   * mutable state, derived elements are read-only views of one coherent committed
   * doc state, and every mutation must funnel through `scene.mutateElement` /
   * `replaceAllElements` (which write the doc, then this recompute mints the next
   * snapshot). See the class header for why this is correct under collaboration.
   */
  private recomputeFromDoc() {
    const next: OrderedExcalidrawElement[] = [];
    const seen = new Set<string>();

    for (const [id, ymap] of this.yElements.entries()) {
      seen.add(id);
      // Fresh object every pass — `yMapToElement` deep-clones JSON-leaf values, so
      // the snapshot never aliases doc-internal data.
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

      // Re-stamp any carried own-Symbol props (e.g. ORIG_ID) onto the fresh
      // snapshot, then push it. No object reuse — identity is fresh per pass.
      this.applySymbols(record, meta);
      next.push(record as unknown as OrderedExcalidrawElement);
    }

    // Drop metadata for elements that no longer exist in the doc.
    if (this.meta.size > seen.size) {
      for (const id of [...this.meta.keys()]) {
        if (!seen.has(id)) {
          this.meta.delete(id);
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
  // files + persistable appState on the doc (native-Yjs core, M4 — persistence)
  //
  // Image binaries and the persistable appState subset live in THIS doc, so an
  // encoded doc is the whole whiteboard (see {@link encodeSnapshot}). These thin
  // accessors are how the editor reads/writes them; the renderer keeps consuming
  // a plain files object and the plain appState — the doc is just where the
  // durable copy lives and collaborates. Writes go under a chosen origin so a
  // load (`EPHEMERAL_ORIGIN`) is non-undoable while a normal edit (`LOCAL_ORIGIN`,
  // the default) is broadcast to peers and recorded; a remote files/appState
  // change arrives via the same `applyRemoteUpdate` path the elements do.
  // ---------------------------------------------------------------------------

  /**
   * Merge `files` into the doc's `yFiles` (`doc.getMap(FILES)`). Append-mostly:
   * an existing file is left in place unless its bytes changed (Excalidraw never
   * removes an image's binary on element delete), so this never drops a file a
   * peer just added. Pass `recordHistory: false` for a load / programmatic write
   * (non-undoable). No-op (no transaction) when nothing changed.
   */
  setFiles(
    files: Readonly<Record<string, FileRecord>>,
    options?: { recordHistory?: boolean },
  ): void {
    const origin =
      options?.recordHistory === false ? EPHEMERAL_ORIGIN : LOCAL_ORIGIN;
    let wrote = 0;
    this.doc.transact(() => {
      wrote = writeFiles(this.yFiles, files, { prune: false });
    }, origin);
    void wrote;
  }

  /** The scene's files as a plain `Record<fileId, BinaryFileData>`, read out of
   * the doc (deep-cloned, never aliasing doc-internal data). */
  getFiles(): Record<string, FileRecord> {
    return readFiles(this.yFiles);
  }

  /**
   * Write the persistable appState subset (the `APPSTATE_ALLOW_LIST` keys —
   * background + name) into the doc's `yAppState`. Only those keys are
   * considered; every other appState field is local-only and ignored here (it
   * must not persist or collaborate). Pass `recordHistory: false` for a load.
   */
  setAppState(
    appState: Readonly<Partial<Record<AppStateAllowKey, unknown>>>,
    options?: { recordHistory?: boolean },
  ): void {
    const origin =
      options?.recordHistory === false ? EPHEMERAL_ORIGIN : LOCAL_ORIGIN;
    this.doc.transact(() => {
      writeAppState(this.yAppState, appState);
    }, origin);
  }

  /** The persisted appState subset (the allow-list keys present) from the doc. */
  getPersistedAppState(): Partial<Record<AppStateAllowKey, unknown>> {
    return readAppState(this.yAppState);
  }

  // ---------------------------------------------------------------------------
  // persistence (native-Yjs core, M4) — the doc IS the persistence unit.
  //
  // Save = encode THIS doc (elements + files + appState) to Yjs V2 bytes; load =
  // decode bytes into a doc the `Scene` constructor adopts. There is no element
  // JSON: the bytes a `Scene` produces are exactly what the server / collab-
  // service stores (a base64 V2 snapshot over `getMap("elements"/"files"/
  // "appState")`), so editor↔backend persistence is one format end to end.
  // ---------------------------------------------------------------------------

  /**
   * Encode the WHOLE scene doc (elements + files + persistable appState) to Yjs
   * **V2** bytes — the native persistence/storage form. This is what a save
   * writes; the server stores these bytes verbatim (base64). Equivalent to
   * `encodeStateAsUpdate("v2")`, named for the persistence intent.
   */
  encodeSnapshot(): Uint8Array {
    return Y.encodeStateAsUpdateV2(this.doc);
  }

  /**
   * Build a `Scene` by decoding stored Yjs **V2** snapshot bytes into a fresh
   * doc and adopting it — the load path. The decoded doc is the source of truth;
   * elements/files/appState all come straight from it. The inverse of
   * {@link encodeSnapshot} at the Scene boundary.
   */
  static fromSnapshot(bytes: Uint8Array): Scene {
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, bytes);
    return new Scene(null, { doc });
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
  // Native-Yjs core (write-to-doc → re-read). The `Y.Doc` is the only mutable
  // state; derived elements are fresh immutable snapshots (no stable-identity
  // reuse). This method is the WRITE path:
  //
  //  1. The passed `element` is used purely as a *scratch* object: the bare
  //     `mutateElement` mutates it in place to run the normalization (elbow-arrow /
  //     points / size) + skip-if-unchanged rules and bump
  //     `version`/`versionNonce`/`updated` (kept for the editor's reconciliation,
  //     NOT stored in the doc). It does NOT become scene state.
  //  2. The *changed* properties are diffed into that id's per-property `Y.Map`
  //     inside a `doc.transact` (the doc is the source of truth). `mutateElement`
  //     can normalize beyond the literal `updates` (elbow arrows rewrite
  //     points/x/y/width/…), so we diff the whole post-state element via
  //     `writeChangedKeys`, not `updates`.
  //  3. The observer re-derives a FRESH snapshot for the id, which this method
  //     RETURNS. The passed object is no longer the scene's element — a caller that
  //     needs the post-mutation element MUST use the returned value
  //     (`el = scene.mutateElement(el, {...})`) or re-read `getElement(id)`. A
  //     reference held across this call is a stale snapshot and will not reflect
  //     the change; mutating a derived element in place never reaches the doc.
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
      // `informMutation: false` ⇒ write the change but don't notify the component
      // (mid-drag), so we suppress the `triggerUpdate()` the observer would fire.
      // The observer still runs and re-derives the snapshot, so the returned
      // element reflects the doc even mid-drag.
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
          // Refresh the locally-maintained reconciliation metadata + own-Symbol
          // props from the just-normalized scratch object (the doc does not store
          // them); the recompute re-attaches them to the fresh snapshot.
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
        }, writeOrigin);
      } finally {
        this.suppressTrigger = prevSuppress;
      }

      // The observer minted a fresh snapshot for this id from the merged doc;
      // return THAT, not the scratch object. Fall back to the scratch object only
      // in the (theoretical) event the id is somehow absent post-write.
      return (
        (this.elementsMap.get(element.id) as TElement | undefined) ?? element
      );
    }

    // No-op (or out-of-scene) mutation: nothing was written, so no fresh snapshot
    // was minted. Return the scene's current snapshot for an in-scene id (strictly
    // fresher than a possibly-stale passed reference); otherwise the passed object.
    return (
      (this.elementsMap.get(element.id) as TElement | undefined) ?? element
    );
  }
}
