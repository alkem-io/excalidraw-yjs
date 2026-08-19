import throttle from "lodash.throttle";
import * as Y from "yjs";

import { validateOrderKey } from "@excalidraw-yjs/fractional-indexing";

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
  REMOTE_ORIGIN,
  elementToYMap,
  ELEMENT_DELETIONS,
  yMapToElement,
  writeChangedKeys,
  computeElementIntent,
  assertIntentAgainstResult,
  writeAssetLocators,
  readAssetLocators,
  writeAppState,
  readAppState,
  type ElementRecord,
  type DeclaredElementIntent,
  type AssetLocator,
  type AppStateAllowKey,
} from "./yjs";

import type { AppState } from "../../excalidraw/types";

/**
 * FORMAT-only index validity for the planner's scoped gate (spec 002 / T016j):
 * present, and parses as a fractional index.
 *
 * Deliberately NOT neighbour-relative — relational position is the caller's
 * business, and a relational tie is classified there rather than repaired or
 * rejected here.
 *
 * Module-private on purpose. An earlier cut exported this from
 * `fractionalIndex.ts`, which the package and headless entrypoints re-export,
 * turning one private planner check into public library API. The published
 * surface does not grow for an internal gate.
 */
const isWellFormedIndex = (
  index: ExcalidrawElement["index"] | undefined,
): boolean => {
  if (!index) {
    return false;
  }
  try {
    validateOrderKey(index);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build Scene's six derived views from materialized records.
 *
 * PURE: no `this`, no metadata, no notification — which is what makes it safe to
 * run against records that are not the committed doc (spec 002, T016k).
 *
 * Two requirements callers depend on: `orderByFractionalIndex` sorts the passed
 * array IN PLACE, and the views hold the SAME instances as `records` — the render
 * caches are identity-keyed WeakMaps, so a copy would silently miss all of them.
 */
const materializeViews = (
  records: OrderedExcalidrawElement[],
): {
  elements: readonly OrderedExcalidrawElement[];
  elementsMap: SceneElementsMap;
  nonDeletedElements: readonly Ordered<NonDeletedExcalidrawElement>[];
  nonDeletedElementsMap: NonDeletedSceneElementsMap;
  frames: readonly ExcalidrawFrameLikeElement[];
  nonDeletedFramesLikes: readonly NonDeleted<ExcalidrawFrameLikeElement>[];
} => {
  orderByFractionalIndex(records);

  const frames: ExcalidrawFrameLikeElement[] = [];
  const elementsMap = toBrandedType<SceneElementsMap>(new Map());
  for (const element of records) {
    if (isFrameLikeElement(element)) {
      frames.push(element);
    }
    elementsMap.set(element.id, element);
  }

  const nonDeleted = getNonDeletedElements(records);

  return {
    elements: records,
    elementsMap,
    nonDeletedElements: nonDeleted.elements,
    nonDeletedElementsMap: nonDeleted.elementsMap,
    frames,
    nonDeletedFramesLikes: getNonDeletedElements(frames).elements,
  };
};

type ElementPlan = {
  readonly add: readonly { record: ElementRecord; keys: ReadonlySet<string> }[];
  readonly remove: readonly string[];
  readonly write: ReadonlyMap<
    string,
    { record: ElementRecord; keys: ReadonlySet<string> }
  >;
  readonly recordHistory: boolean;
};

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
 * changed.
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
    // `globalThis.window?.`, not `window?.` — optional chaining guards a NULL
    // value, not an UNDECLARED identifier, so the bare form throws
    // `ReferenceError: window is not defined` in Node. That made every element
    // write fail for a headless consumer, over a debug flag.
    if (
      isDevEnv() ||
      isTestEnv() ||
      globalThis.window?.DEBUG_FRACTIONAL_INDICES
    ) {
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
   * is a complete, portable whiteboard snapshot over `getMap("elements")` +
   * `getMap("files")` + `getMap("appState")` — the format any persistence layer or
   * collaboration server stores. Persistence is therefore native: create/load/save
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
  public readonly yAssets: Y.Map<unknown>;

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
   * Deletion timestamps for soft-deleted elements, keyed by id
   * ({@link ELEMENT_DELETIONS}). Lifecycle metadata that rides the doc so ANY
   * replica can judge age for GC — including one that joined after the deletion,
   * which the per-peer `updated` field cannot serve. Never exposed as an element
   * property; {@link collectGarbage} is its only consumer.
   */
  public readonly yElementDeletions: Y.Map<number>;

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
   * Subscribers to {@link onDocUpdate}, dispatched by ONE internal doc handler
   * per format rather than each subscriber attaching its own — so a logical
   * mutation can withhold delivery and emit a single aggregate delta instead of
   * one per Yjs transaction (spec 002 FR-017).
   */
  private docUpdateSubs: Array<{
    format: "v1" | "v2";
    cb: (update: Uint8Array) => void;
  }> = [];

  /**
   * The exact update bytes Yjs emitted while a logical mutation was open, merged
   * and dispatched once when it closes. Non-null exactly while one is open, so
   * per-transaction delivery is withheld for that span.
   *
   * Buffering the real bytes — rather than recomputing a delta from a saved state
   * vector — is what makes deletions converge. A Yjs state vector tracks inserted
   * struct clocks, NOT delete-set advancement, so `encodeStateVector` is byte-
   * identical before and after a deletion. Any "did the doc change?" test built on
   * state-vector equality therefore drops deletion-only mutations silently and the
   * peer diverges forever. Merging what was actually emitted also carries no
   * historical delete-set baggage, and yields nothing at all for a true no-op.
   */
  /** Depth of open logical mutations; only the outermost close publishes. */
  private logicalDepth = 0;

  private logicalBuffer: { v1: Uint8Array[]; v2: Uint8Array[] } | null = null;

  private internalDocHandlers: Array<[string, (...a: never[]) => void]> = [];

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
    this.yAssets = this.doc.getMap<unknown>(FILES);
    this.yAppState = this.doc.getMap<unknown>(APPSTATE);
    this.yElementDeletions = this.doc.getMap<number>(ELEMENT_DELETIONS);

    // Native element history (M2): track only LOCAL_ORIGIN, so undo/redo revert
    // exclusively this replica's edits — a remote / system-origin transaction is
    // never captured nor reverted (the origin-scope M3 collaboration depends on).
    // Boundaries between undo steps are set explicitly via `stopElementCapture`
    // (see field doc), so `captureTimeout` is effectively disabled by being huge.
    // Scope covers the deletion sidecar as well as the elements: both are written
    // in the SAME transaction, so one undo reverts the `isDeleted` flip and its
    // marker together. Leaving the sidecar unscoped would let an undo restore a
    // live element while its deletion marker persisted — and GC would then
    // reclaim a live element once the cutoff passed.
    this.undoManager = new Y.UndoManager(
      [this.yElements, this.yElementDeletions],
      {
        trackedOrigins: new Set([LOCAL_ORIGIN]),
        captureTimeout: Number.MAX_SAFE_INTEGER,
      },
    );

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
      //    A non-undoable local write (a load, an import) also lands under
      //    STRUCTURAL, and its meta is set directly by the write path too.
      if (
        transaction.origin !== LOCAL_ORIGIN &&
        transaction.origin !== STRUCTURAL_ORIGIN
      ) {
        this.bumpMetaVersionsFor(changedElementIds(events));
      }
      this.recomputeFromDoc();
    };
    this.yElements.observeDeep(observer);

    // Files live on the SAME doc (M4), so a change to `yFiles` — a local
    // `setFiles`, OR a remote files apply (REMOTE_ORIGIN, M3), OR a load
    // (a non-recording write, `STRUCTURAL_ORIGIN`) — must notify the same `callbacks` as an element
    // change, so the editor refreshes its in-memory files cache and re-renders.
    // `.observe` (not `observeDeep`): each value is an opaque locator string
    // stored as a JSON-leaf — files are added/removed, never sub-merged (see the
    // {@link yFiles} doc), so a shallow observe captures every file mutation.
    // Read-only on the App side (refresh from `getFiles()`), so this can never
    // echo: the observer does not write back, it only fires `triggerUpdate`.
    const assetsObserver = () => {
      // Honor the same `informMutation:false` suppression window as the element
      // recompute, so a files write coinciding with a suppressed element write
      // (e.g. mid-gesture) does not force a React re-render early.
      if (!this.suppressTrigger) {
        this.triggerUpdate();
      }
    };
    this.yAssets.observe(assetsObserver);

    // The persistable appState subset (background + name) lives on the SAME doc
    // (M4), so a change to `yAppState` — a local `setAppState`, a remote appState
    // apply (REMOTE_ORIGIN, M3), or a load (`STRUCTURAL_ORIGIN`) — must notify the
    // same `callbacks` as an element/files change so the App refreshes its React
    // appState from the doc and re-renders (background/name are React state, not
    // read from the doc by the renderer). `.observe` (shallow) is enough: each
    // allow-listed key is a plain LWW scalar. Read-only on the App side (refresh
    // from `getPersistedAppState()`), so this can never echo — the observer only
    // fires `triggerUpdate`, it never writes back.
    const appStateObserver = () => {
      if (!this.suppressTrigger) {
        this.triggerUpdate();
      }
    };
    this.yAppState.observe(appStateObserver);

    this.detachObserver = () => {
      this.yElements.unobserveDeep(observer);
      this.yAssets.unobserve(assetsObserver);
      this.yAppState.unobserve(appStateObserver);
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
    const id = record.id as string;
    const ymap = elementToYMap(record);
    // Born as a tombstone regardless of the element's real `isDeleted`; the
    // reveal pass flips it to the actual value under LOCAL_ORIGIN.
    ymap.set("isDeleted", true);
    this.yElements.set(id, ymap);
    // The born tombstone gets a deletion marker HERE, in the structural prelude,
    // because it is a real (if momentary) tombstone. Two paths depend on it:
    //  - a successful reveal deletes the marker under LOCAL, so undoing the
    //    creation restores BOTH `isDeleted:true` and the marker as one step —
    //    without this the undone creation is an IMMORTAL tombstone, invisible to
    //    the user yet never reclaimable, because there is no marker operation in
    //    the undo item to restore;
    //  - a prelude that fails before its reveal deliberately leaves the born
    //    tombstone published, and it must still be able to age out.
    const updated = (record as Record<string, unknown>).updated;
    if (typeof updated !== "number") {
      throw new Error(
        `Scene: cannot materialize "${id}" — 'updated' is ${typeof updated}, expected a number.`,
      );
    }
    this.yElementDeletions.set(id, updated);
    return ymap;
  }

  /**
   * Bring the deletion marker for one element in line with its CURRENT state in
   * the doc. MUST be called inside the write transaction, so the marker and the
   * `isDeleted` value it describes commit together.
   *
   * The timestamp is the element's own `updated` — the same value Excalidraw
   * already treats as "when this last changed", and the same one the forward
   * converter seeds from. This deliberately introduces no second clock.
   */
  private syncDeletionMarker(record: ElementRecord): void {
    const id = record.id as string;
    const ymap = this.yElements.get(id);
    if (!ymap) {
      this.yElementDeletions.delete(id);
      return;
    }
    if (ymap.get("isDeleted") === true) {
      // Set only on the transition: re-stamping on every later write to an
      // already-deleted element would keep pushing its expiry into the future.
      if (!this.yElementDeletions.has(id)) {
        const updated = (record as Record<string, unknown>).updated;
        if (typeof updated !== "number") {
          // FAIL LOUD. `updated` is required on ExcalidrawElement and is what
          // dates the deletion. Defaulting it (to 0, say) would mark the record
          // deleted at the epoch — instantly expired — so the next sweep would
          // reclaim content that should have had its full grace window, and
          // malformed input would surface as data loss rather than as an error.
          throw new Error(
            `Scene: cannot record a deletion for "${id}" — 'updated' is ${typeof updated}, expected a number.`,
          );
        }
        this.yElementDeletions.set(id, updated);
      }
    } else if (this.yElementDeletions.has(id)) {
      this.yElementDeletions.delete(id);
    }
  }

  /**
   * Apply an action's INTENT to the doc as it is NOW (spec 002, FR-016).
   *
   * `result` is what the action produced from `base` — the scene as it was when
   * the action was invoked. Applying `result` wholesale would revert anything
   * that changed in between (a peer's edit, a side-effect helper's own write),
   * which is the stale-overwrite class this exists to remove. So only what the
   * action actually MEANT is applied.
   *
   * `declaredIntent` selects what changed; every VALUE is read from `result`.
   * Omit it and the intent is derived by diffing `base` against `result` — valid
   * only for audited SYNCHRONOUS callers, because a derived diff cannot see an
   * explicit assignment of the value a key already had, and cannot represent an
   * async action whose base is arbitrarily stale.
   */
  applyElementChanges(
    base: readonly ElementRecord[],
    result: readonly ElementRecord[],
    options: {
      declaredIntent?: DeclaredElementIntent;
      recordHistory?: boolean;
    } = {},
  ): { changedIds: ReadonlySet<string> } {
    const resultById = new Map<string, ElementRecord>();
    for (const r of result) {
      resultById.set(r.id as string, r);
    }

    const declared =
      options.declaredIntent ?? computeElementIntent(base, result);
    assertIntentAgainstResult(declared, resultById);

    // T016j — validate ONLY the records this mutation affects: creations, and
    // existing ids whose declared keys include `index`. A property edit that does
    // not declare `index` triggers no validation and no repair, and an element
    // absent from `result` is never inspected — its index is not this mutation's
    // business, and a concurrent element must survive untouched.
    //
    // Format only: present and parseable. NOT neighbour-relative — a relational
    // tie is classified at the caller that knows the intended array order, not
    // repaired or rejected here. (Whether the two measured tied action results
    // are correct as-is is NOT established: today `replaceAllElements`
    // canonicalizes them via `syncInvalidIndices` before persistence, so
    // accept-as-is has never been observed.)
    //
    // Nothing is repaired. A malformed affected record is a caller bug, and the
    // caller is the only place that knows the insertion/reorder intent.
    const affected = new Set<string>([
      ...declared.addedIds,
      ...[...declared.keysById]
        .filter(([, keys]) => keys.has("index"))
        .map(([id]) => id),
    ]);
    for (const id of affected) {
      const record = resultById.get(id)!;
      if (!isWellFormedIndex(record.index as ExcalidrawElement["index"])) {
        throw new Error(
          `applyElementChanges: element ${id} has a missing or malformed fractional index (${String(
            record.index,
          )})`,
        );
      }
    }

    const add: Array<{ record: ElementRecord; keys: ReadonlySet<string> }> = [];
    for (const id of declared.addedIds) {
      const record = resultById.get(id)!;
      // A creation establishes every persisted own key.
      add.push({ record, keys: new Set(Object.keys(record)) });
    }

    const write = new Map<
      string,
      { record: ElementRecord; keys: ReadonlySet<string> }
    >();
    for (const [id, keys] of declared.keysById) {
      write.set(id, { record: resultById.get(id)!, keys });
    }

    return this.commitPlan({
      add,
      remove: [...declared.removedIds],
      write,
      recordHistory: options.recordHistory !== false,
    });
  }

  /**
   * A fully-normalized, validated description of one logical mutation
   * (spec 002 FR-016). Encodes only what is already required: membership
   * add/remove, per-id declared key writes, and the existing history choice.
   * Planners produce it; {@link commitPlan} is the only thing that executes it.
   */
  private static assertDisjoint(plan: ElementPlan): void {
    const seen = new Set<string>();
    const claim = (id: string, where: string) => {
      if (seen.has(id)) {
        throw new Error(`commitPlan: id ${id} appears twice (${where})`);
      }
      seen.add(id);
    };
    for (const a of plan.add) {
      claim(a.record.id as string, "add");
    }
    for (const id of plan.remove) {
      claim(id, "remove");
    }
    for (const id of plan.write.keys()) {
      claim(id, "write");
    }
  }

  private writePlanMeta(id: string, record: ElementRecord): void {
    this.meta.set(id, {
      version: record.version as number,
      versionNonce: record.versionNonce as number,
      updated: record.updated as number,
      symbols: captureOwnSymbols(record),
      boundElementsEmpty: isEmptyBoundElements(record),
    });
    if ((record.version as number) > this.versionHighWater) {
      this.versionHighWater = record.version as number;
    }
  }

  /**
   * PRIVATE shared machinery — NOT a third supported write API. The two semantic
   * planners are the supported surface; both funnel here so the transaction,
   * origin, broadcast and metadata rules exist once and cannot drift.
   *
   * Guarantees (spec 002 §T016b contract):
   * - G1 at most one untracked STRUCTURAL prelude, for genuinely absent adds only
   * - G2 exactly one action transaction (remove, write, reveal-last), tracked iff LOCAL
   * - G3 metadata written inside it; returns the ids that ACTUALLY changed the doc
   * - G4 at most one notification — none when nothing changed
   * - G5 at most one transport delta, from the pre-plan state vector
   * - G6 validated before the prelude; on a post-prelude throw the finally still
   *      publishes the committed state, then rethrows (no rollback machinery —
   *      Yjs already committed what preceded the throw, and publishing preserves
   *      convergence)
   * - G7 a collided add is a scoped write, never a structural replacement
   */
  private commitPlan(plan: ElementPlan): { changedIds: ReadonlySet<string> } {
    Scene.assertDisjoint(plan);

    const absent: Array<{ record: ElementRecord; keys: ReadonlySet<string> }> =
      [];
    const collided: Array<{
      record: ElementRecord;
      keys: ReadonlySet<string>;
    }> = [];
    for (const a of plan.add) {
      (this.yElements.has(a.record.id as string) ? collided : absent).push(a);
    }

    const changedIds = new Set<string>();
    // A non-recording write is UNTRACKED BY UNDO, not invisible to peers: it
    // mutates the shared doc, so the next full-state encode carries it whatever
    // the incremental policy says . STRUCTURAL is exactly that pair.
    const writeOrigin = plan.recordHistory ? LOCAL_ORIGIN : STRUCTURAL_ORIGIN;

    const scopedWrite = (
      entry: { record: ElementRecord; keys: ReadonlySet<string> },
      countAsChange = true,
    ) => {
      const id = entry.record.id as string;
      const ymap = this.yElements.get(id);
      if (!ymap) {
        return;
      }
      const writes = writeChangedKeys(ymap, entry.record, entry.keys);
      if (writes > 0 || countAsChange) {
        this.writePlanMeta(id, entry.record);
      }
      if (writes > 0) {
        changedIds.add(id);
      }
    };

    const prevSuppress = this.suppressTrigger;
    this.openLogicalMutation();
    this.suppressTrigger = true;
    try {
      // G1 — structural prelude, absent adds only, born-tombstoned.
      if (absent.length > 0) {
        this.doc.transact(() => {
          for (const a of absent) {
            this.materializeNewEntry(a.record);
          }
        }, STRUCTURAL_ORIGIN);
      }

      // G2 — one action transaction.
      this.doc.transact(() => {
        for (const id of plan.remove) {
          if (this.yElements.has(id)) {
            this.yElements.delete(id);
            this.meta.delete(id);
            changedIds.add(id);
          }
        }
        for (const [, entry] of plan.write) {
          scopedWrite(entry, false);
        }
        // G7 — an add that already exists is a scoped write, not a replacement.
        for (const a of collided) {
          scopedWrite(a, false);
        }
        // Reveal LAST: an element is never live before its record is complete.
        for (const a of absent) {
          scopedWrite(a);
          changedIds.add(a.record.id as string);
        }
        // Deletion markers, in this SAME transaction so a marker and its
        // `isDeleted` are one atomic step for undo/redo and for peers.
        for (const id of plan.remove) {
          this.yElementDeletions.delete(id);
        }
        for (const entry of [...plan.write.values(), ...collided, ...absent]) {
          this.syncDeletionMarker(entry.record);
        }
      }, writeOrigin);
    } finally {
      this.suppressTrigger = prevSuppress;
      this.closeLogicalMutation();
    }

    // G4 — one notification, and only if the doc actually changed.
    if (changedIds.size > 0) {
      this.triggerUpdate();
    }
    return { changedIds };
  }

  /**
   * Open a logical mutation: everything Yjs emits until the matching close is
   * buffered, then dispatched as ONE transport message by merging exactly those
   * emitted bytes (G5). Nothing buffered — a true no-op — dispatches nothing.
   * The close runs from a `finally`, so a throw after the structural prelude
   * still publishes what Yjs actually committed.
   *
   * The emitted bytes are buffered rather than a delta recomputed from a
   * pre-mutation state vector: a state vector tracks inserted struct clocks and
   * not delete-set advancement, so a recomputed delta silently drops deletions.
   */
  private openLogicalMutation(): void {
    // Boundaries JOIN. An inner open appends to the buffer the outer one already
    // holds, so only the OUTERMOST close publishes. That is what lets a caller
    // that spans several Scene writes — an editor action running `perform` and
    // then applying its result — reach a peer as ONE message, without the Scene
    // knowing anything about actions.
    this.logicalDepth++;
    if (this.logicalBuffer === null) {
      this.logicalBuffer = { v1: [], v2: [] };
    }
  }

  private closeLogicalMutation(): void {
    if (this.logicalDepth === 0) {
      throw new Error("Scene: no logical mutation is open.");
    }
    this.logicalDepth--;
    if (this.logicalDepth > 0) {
      return;
    }
    const buffered = this.logicalBuffer;
    this.logicalBuffer = null;
    this.publishBuffered(buffered);
  }

  /**
   * Open a logical mutation spanning several Scene writes, so they reach a peer
   * as ONE message. Every call MUST be balanced by {@link endLogicalMutation} in
   * a `finally`: on a throw, whatever Yjs already committed is published rather
   * than dropped, because those writes are in the document and withholding them
   * would diverge the peer permanently.
   *
   * Deliberately narrow — the editor's action layer is the only caller. This is
   * not a general mode; see {@link openLogicalMutation} for the join rule.
   */
  beginLogicalMutation(): void {
    this.openLogicalMutation();
  }

  endLogicalMutation(): void {
    this.closeLogicalMutation();
  }

  private publishBuffered(
    buffered: { v1: Uint8Array[]; v2: Uint8Array[] } | null,
  ): void {
    if (!buffered) {
      return;
    }
    for (const format of ["v1", "v2"] as const) {
      const parts = buffered[format];
      if (parts.length === 0) {
        continue;
      }
      const merged =
        format === "v2" ? Y.mergeUpdatesV2(parts) : Y.mergeUpdates(parts);
      this.dispatchDocUpdate(format, merged);
    }
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
       * {@link STRUCTURAL_ORIGIN} — untracked by undo, but still published.
       */
      recordHistory?: boolean;
    },
  ) {
    const revealOrigin =
      options?.recordHistory === false ? STRUCTURAL_ORIGIN : LOCAL_ORIGIN;
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

    // ONE logical mutation across BOTH passes, so the pair reaches a peer as a
    // single message. A creation's STRUCTURAL prelude is content-bearing, and
    // delivering it separately from its reveal would leave the peer holding a
    // tombstone that carries the element's real properties and never becomes
    // live. Buffering both and emitting once makes that unrepresentable.
    this.openLogicalMutation();
    try {
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
          // The element is gone; its deletion marker must go with it, in this
          // same transaction (see {@link syncDeletionMarker}).
          this.yElementDeletions.delete(id);
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
          // KNOWN DEFECT (confirmed, not fixed here) — spec 002 FR-011, task T014b.
          // `bumpMetaVersionsFor` (undo/redo, remote apply) can raise the local meta
          // above the version a caller's array carries. A stale action result then
          // changes a property while carrying a low version, this records it
          // verbatim, and the editor Store — which detects a change only when
          // `prev.version < next.version` — silently drops a real edit from the
          // change set and the history delta.
          //
          // Not patched here on purpose. Both a blanket `max(record.version,
          // prev + 1)` and a narrowed regression-only bump change version values
          // that the Store, the history deltas and ~64 existing tests depend on
          // (transform/contextmenu/history snapshots encode exact versions). The
          // fix has to reconcile meta versioning with Store change-detection as a
          // whole, which is its own piece of work. See the skipped
          // INV-VERSION-MONOTONIC case in `Scene.native-yjs-write-intent.test.ts`.
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
          // Deletion marker, in this SAME transaction so it and the `isDeleted`
          // it describes are one atomic step for undo/redo and for peers.
          this.syncDeletionMarker(record);
        }
      }, revealOrigin);

      // Yjs fires the observer (→ recompute → triggerUpdate) iff a transaction
      // changed the doc. For a true no-op (e.g. re-asserting identical elements) it
      // does not, so recompute once here to keep the derived caches coherent and to
      // preserve the historical side effect of always firing on replaceAllElements.
      if (!this.observerFired) {
        this.recomputeFromDoc();
      }
    } finally {
      this.closeLogicalMutation();
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
    const views = materializeViews(next);
    this.elements = views.elements;
    this.elementsMap = views.elementsMap;
    this.nonDeletedElements = views.nonDeletedElements;
    this.nonDeletedElementsMap = views.nonDeletedElementsMap;
    this.frames = views.frames;
    this.nonDeletedFramesLikes = views.nonDeletedFramesLikes;

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
    // Deliberately UNGUARDED — it throws on a malformed update, and the caller
    // must handle that. A `try/catch` here that logged and continued would be
    // actively harmful, because Yjs apply is NOT atomic on a decode failure:
    // measured over every truncation offset of a real delta, 10 of 1056 both
    // threw AND left the doc mutated, all of them near the tail — precisely what
    // a dropped connection produces. One such case integrated four new elements
    // while the file, the deletion marker and the property edit from the SAME
    // logical update never arrived. Swallowing that would continue on a doc that
    // is partially applied and internally inconsistent, which is worse than
    // failing loudly. Recovery means discarding this Scene generation and
    // resyncing, and that belongs to the transport that owns the session — not
    // to a catch block in the element layer. See T027.
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
    this.ensureInternalDocHandler(format);
    const entry = { format, cb };
    this.docUpdateSubs.push(entry);
    return () => {
      const i = this.docUpdateSubs.indexOf(entry);
      if (i !== -1) {
        this.docUpdateSubs.splice(i, 1);
      }
    };
  }

  /**
   * One internal `doc.on(...)` per format, dispatching to {@link docUpdateSubs}.
   * Withholds delivery while a logical mutation is open — {@link commitPlan} emits
   * the aggregate delta instead, so one logical mutation is one transport message
   * even though a creation needs two Yjs transactions under two origins.
   */
  private ensureInternalDocHandler(format: "v1" | "v2"): void {
    const event = format === "v2" ? "updateV2" : "update";
    if (this.internalDocHandlers.some(([e]) => e === event)) {
      return;
    }
    const handler = (update: Uint8Array, origin: unknown) => {
      // The ONE origin policy for the transport boundary, and it withholds
      // exactly one thing:
      //
      //  - REMOTE_ORIGIN: a peer's edit we just applied. Re-broadcasting it is the
      //    echo loop.
      //
      // Everything else that touches this document is delivered, including writes
      // that produce no undo step (a load, a non-capturing programmatic update).
      // Such a write is untracked by history, not invisible: its structs live in
      // the doc, so the next full-state encode carries it whatever this callback
      // does. Work that must NOT reach peers cannot happen on this document —
      // the editor replaces the Scene generation for that.
      //
      // STRUCTURAL_ORIGIN is deliberately NOT suppressed: a born-revealed create
      // is a structural add plus its reveal, and dropping the structural half
      // would leave peers without the element. It is NOT enough that the reveal
      // carries every property — in Yjs the reveal encodes only VALUE writes onto
      // a map whose parent-creating struct lives in the structural update, so a
      // peer receiving the reveal alone queues them as pending on a missing
      // parent and shows nothing until the next full resync. The logical-mutation
      // boundary below is what makes the pair arrive as one message.
      //
      // Undo/redo is likewise NOT suppressed: its origin is the UndoManager,
      // which is none of the sentinels, so it broadcasts — a peer must see an
      // undo as an ordinary forward change.
      if (origin === REMOTE_ORIGIN) {
        return;
      }
      if (this.logicalBuffer !== null) {
        this.logicalBuffer?.[format].push(update);
        return;
      }
      this.dispatchDocUpdate(format, update);
    };
    this.doc.on(event, handler as never);
    this.internalDocHandlers.push([event, handler as never]);
  }

  private dispatchDocUpdate(format: "v1" | "v2", update: Uint8Array): void {
    for (const sub of [...this.docUpdateSubs]) {
      if (sub.format === format) {
        sub.cb(update);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // files + persistable appState on the doc (native-Yjs core, M4 — persistence)
  //
  // Image binaries and the persistable appState subset live in THIS doc, so
  // `encodeStateAsUpdate` over it yields the whole whiteboard. These thin
  // accessors are how the editor reads/writes them; the renderer keeps consuming
  // a plain files object and the plain appState — the doc is just where the
  // durable copy lives and collaborates.
  //
  // Origins here mean what they mean everywhere: an ordinary local write is
  // `LOCAL_ORIGIN` and is published, maintenance is `STRUCTURAL_ORIGIN` and is
  // also published, and a peer's change arrives through `applyRemoteUpdate` under
  // `REMOTE_ORIGIN` and is never echoed. Undo ownership is NOT decided by origin
  // alone but by which map is in scope: the `UndoManager` covers `yElements` and
  // `yElementDeletions` only, so writes to `yFiles`/`yAppState` produce no Yjs
  // undo step whatever origin they carry.
  // ---------------------------------------------------------------------------

  /**
   * Merge `fileId -> locator` references into the document.
   *
   * Bytes never pass through here. The caller stores them with the host asset
   * adapter first and writes back only the opaque locator it returns, so a
   * full-state encode can never carry image data. `writeAssetLocators` throws on
   * a non-string value, which makes that structural rather than a convention.
   *
   * Written under `LOCAL_ORIGIN`, so the change is published to peers. That does
   * NOT make it undoable: the `UndoManager` is scoped to `yElements` and
   * {@link yElementDeletions}, so a reference write produces no undo step.
   */
  setAssetLocators(locators: Readonly<Record<string, AssetLocator>>): void {
    this.doc.transact(() => {
      writeAssetLocators(this.yAssets, locators);
    }, LOCAL_ORIGIN);
  }

  /** The document's `fileId -> locator` references. Never bytes. */
  getAssetLocators(): Record<string, AssetLocator> {
    return readAssetLocators(this.yAssets);
  }

  /**
   * Reclaim deleted elements and the binaries only they still referenced
   * (FR-006, INV-BOUNDED). Without this the doc grows monotonically under
   * paste/delete churn, and a full-state encode ships every pasted-then-deleted
   * element — and its image — to each new joiner.
   *
   * The caller supplies POLICY only (`deletedBefore`, normally
   * `Date.now() - DELETED_ELEMENT_TIMEOUT`); the doc is the single authority on
   * which ids are old enough. Age comes from {@link yElementDeletions}, written
   * atomically with the `isDeleted` flip, so it survives the encode and a replica
   * that joined after the deletion can still judge it. Each candidate is
   * re-checked against the element's CURRENT state, so an element that was
   * un-deleted is never reclaimed on the strength of a stale marker.
   *
   * **Files**: a binary is dropped only when NO remaining element references it —
   * counting live elements AND retained tombstones. A soft-deleted image inside
   * the grace window is still undoable, so dropping its binary because no *live*
   * element points at it would restore the element without its image. Files are
   * therefore reclaimed against what SURVIVES the element sweep.
   *
   * **Origin** is {@link STRUCTURAL_ORIGIN}, in ONE transaction:
   *  - not `LOCAL_ORIGIN` — the `UndoManager` tracks that, so a sweep would enter
   *    the undo stack and Ctrl+Z would resurrect reclaimed content;
   *    (There is no "local-only" origin to reach for: a
   *    shared-doc write cannot be hidden from peers, because the next full-state
   *    encode carries it regardless.)
   *  Structural is untracked by undo AND published, which is what maintenance
   *  needs. Every writable replica may sweep: `Y.Map` deletes commute, so a
   *  replica that receives another's sweep simply has nothing left to delete —
   *  no leader election, lease or consensus.
   *
   * Nothing to reclaim means NO transaction, hence no wire traffic at all.
   */
  collectGarbage(options: { deletedBefore: number }): {
    elements: number;
    files: number;
  } {
    const expired: string[] = [];
    for (const [id, deletedAt] of this.yElementDeletions.entries()) {
      if (typeof deletedAt !== "number" || deletedAt >= options.deletedBefore) {
        continue;
      }
      const ymap = this.yElements.get(id);
      // Re-check the CURRENT state: a marker left by a since-undone deletion
      // must never reclaim a live element.
      if (ymap instanceof Y.Map && ymap.get("isDeleted") === true) {
        expired.push(id);
      }
    }

    const expiredSet = new Set(expired);
    const referenced = new Set<string>();
    for (const [id, record] of this.yElements.entries()) {
      if (expiredSet.has(id) || !(record instanceof Y.Map)) {
        continue;
      }
      const fileId = record.get("fileId");
      if (typeof fileId === "string") {
        referenced.add(fileId);
      }
    }
    const orphans = [...this.yAssets.keys()].filter(
      (id) => !referenced.has(id),
    );

    if (expired.length === 0 && orphans.length === 0) {
      return { elements: 0, files: 0 };
    }

    this.doc.transact(() => {
      for (const id of expired) {
        this.yElements.delete(id);
        this.yElementDeletions.delete(id);
        this.meta.delete(id);
      }
      for (const id of orphans) {
        this.yAssets.delete(id);
      }
    }, STRUCTURAL_ORIGIN);

    return { elements: expired.length, files: orphans.length };
  }

  /**
   * Write the persistable appState subset (the `APPSTATE_ALLOW_LIST` keys —
   * background + name) into the doc's `yAppState`. Only those keys are
   * considered; every other appState field is local-only and ignored here (it
   * must not persist or collaborate).
   *
   * Written under `LOCAL_ORIGIN`, so the change is published to peers. Like
   * {@link setFiles} this is outside the `UndoManager`'s scope, so it produces no
   * Yjs undo step; reverting the persisted appState on undo is the editor
   * history's responsibility, not this doc's.
   */
  setAppState(
    appState: Readonly<Partial<Record<AppStateAllowKey, unknown>>>,
  ): void {
    this.doc.transact(() => {
      writeAppState(this.yAppState, appState);
    }, LOCAL_ORIGIN);
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
    } = {
      informMutation: true,
      isDragging: false,
    },
  ): TElement {
    const elementsMap = this.getNonDeletedElementsMap();

    const { version: prevVersion } = element;
    // FR-009: the exact keys the mutation assigns — collected inside
    // `mutateElement` so in-flight augmentations (elbow-arrow points/angle, the
    // width/height derived from `points`) are included, which a set built from
    // `updates` here would miss.
    const intentKeys = new Set<string>();
    const { version: nextVersion } = mutateElement(
      element,
      elementsMap,
      updates,
      options,
      intentKeys,
    );

    const inScene = this.elementsMap.has(element.id);
    // A scratch-version bump means the CALLER'S OBJECT changed. It is not the
    // same question as "does the doc need writing": a declared write whose value
    // already matches the (stale) scratch bumps nothing, yet still differs from
    // the doc. Proceed whenever the caller declared any key — `writeChangedKeys`
    // compares against the doc and no-ops if there is genuinely nothing to do.
    const changed = prevVersion !== nextVersion || intentKeys.size > 0;

    if (inScene && changed) {
      // `informMutation: false` ⇒ write the change but don't notify the component
      // (mid-drag), so we suppress the `triggerUpdate()` the observer would fire.
      // The observer still runs and re-derives the snapshot, so the returned
      // element reflects the doc even mid-drag.
      const prevSuppress = this.suppressTrigger;
      this.suppressTrigger = prevSuppress || !options.informMutation;
      try {
        // `mutateElement` is exclusively a MUTATION path: it requires `element`
        // to be ALREADY inserted in the scene. The `inScene` guard above
        // (`this.elementsMap.has(element.id)`) is true iff the id is in
        // `yElements` (every doc entry derives into `elementsMap`), so the element
        // is guaranteed to exist in the doc here — there is no born-revealed
        // structural-add branch to take. The CREATE path is `insertNewElement`
        // (→ `replaceAllElements`), which does the born-revealed tombstone+reveal.
        // A "create via mutate" call falls through the `inScene` guard as a no-op
        // and the element must be inserted via `insertNewElement` (see App.tsx,
        // where `insertNewElement` follows the seeding `scene.mutateElement`).
        this.doc.transact(() => {
          const ymap = this.yElements.get(element.id);
          const writes = ymap
            ? writeChangedKeys(
                ymap,
                element as unknown as ElementRecord,
                intentKeys,
              )
            : 0;
          // No doc change ⇒ no metadata change. `mutateElement` may have bumped
          // the SCRATCH object's version while the doc already held the
          // requested value; recording that bump would advance the element's
          // version with no corresponding change, and the editor Store would
          // report a phantom modification on the next recompute.
          if (writes === 0) {
            return;
          }
          // Refresh the locally-maintained reconciliation metadata + own-Symbol
          // props from the just-normalized scratch object (the doc does not store
          // them); the recompute re-attaches them to the fresh snapshot.
          // FR-011: `meta.version` must never REGRESS. `bumpMetaVersionsFor`
          // (undo/redo, every `applyRemoteUpdate`) raises the doc's meta version
          // without touching the caller's scratch object, so a mutation through a
          // held reference arrives with a version BEHIND the doc's. Storing it
          // verbatim moved the version backwards, and the editor Store's
          // `prev.version < next.version` gate then silently discarded a write
          // that genuinely changed the doc. Take the strictly-greater of the two
          // so a real change is always observable. (The adjacent
          // `versionHighWater` write was already guarded; this one was not.)
          const prevMetaVersion = this.meta.get(element.id)?.version ?? 0;
          const nextMetaVersion = Math.max(
            element.version,
            prevMetaVersion + 1,
          );
          this.meta.set(element.id, {
            version: nextMetaVersion,
            versionNonce: element.versionNonce,
            updated: element.updated,
            symbols: captureOwnSymbols(element),
            boundElementsEmpty: isEmptyBoundElements(
              element as unknown as ElementRecord,
            ),
          });
          if (nextMetaVersion > this.versionHighWater) {
            this.versionHighWater = nextMetaVersion;
          }
        }, LOCAL_ORIGIN);
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
