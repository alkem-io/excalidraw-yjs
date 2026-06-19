import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { ELEMENTS, FILES, APPSTATE, BINDING_ORIGIN } from "./schema";
import { areElementsSame, writeDiff } from "./diff";
import { applyToScene } from "./apply";
import { AwarenessRouter } from "./awareness";
import { populateYDoc } from "./migrate";

import type * as Y from "yjs";

import type { ElementRecord } from "./schema";
import type { ApplyScope, EditingGuard } from "./apply";
import type { EphemeralChannel } from "./awareness";
import type { Awareness } from "y-protocols/awareness";
import type { SceneJSON } from "./migrate";

/**
 * The minimal Excalidraw imperative API surface the binding drives. Declared as
 * a `Pick` so tests can supply a lightweight stub and so the package does not
 * couple to the full editor.
 */
export type BindingExcalidrawAPI = Pick<
  ExcalidrawImperativeAPI,
  | "updateScene"
  | "getSceneElementsIncludingDeleted"
  | "getFiles"
  | "addFiles"
  | "getAppState"
  | "onChange"
> &
  Partial<
    Pick<
      ExcalidrawImperativeAPI,
      "dispatchIncomingEmojiReaction" | "dispatchIncomingCountdownTimer"
    >
  >;

export type WhiteboardBindingOptions = {
  /** Optional y-protocols awareness for cursor/selection/idle routing. */
  awareness?: Awareness;
  /** Optional ephemeral channel for emoji/countdown/bounds (WS-D wires it). */
  ephemeral?: EphemeralChannel;
  /** Initial scene to seed an empty doc (initial load / migration). */
  initialScene?: SceneJSON;
  /** Returns the id of the element the local user is mid-editing, or null. */
  editingGuard?: EditingGuard;
};

/**
 * Derive the set of changed element ids from an `observeDeep` event batch on the
 * `elements` `Y.Map` (FIX 2). Each event's `path` is the route from the observed
 * root to the mutated type:
 *
 *  - `path.length === 0` → the mutation is on the top-level `elements` map itself
 *    (an element entry added/removed) — the changed ids are the event's keys.
 *  - `path.length >= 1` → a per-element mutation (a property change, or a nested
 *    `boundElements` change at `[id, "boundElements"]`); the first path segment
 *    is the element id.
 *
 * Returns `"full"` (forcing a whole-scene rebuild) if any event can't be mapped
 * to a concrete id — correctness over micro-optimisation (per FIX 2: fall back
 * rather than risk dropping a change).
 */
const changedElementIds = (
  events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
): ApplyScope => {
  const ids = new Set<string>();
  for (const event of events) {
    const path = event.path;
    if (path.length === 0) {
      // top-level add/remove of element entries → ids are the changed keys
      for (const key of event.keys.keys()) {
        ids.add(key);
      }
      continue;
    }
    const head = path[0];
    if (typeof head === "string") {
      ids.add(head);
    } else {
      // Can't resolve a concrete element id → be safe, rebuild everything.
      return "full";
    }
  }
  return ids;
};

/**
 * `WhiteboardBinding` owns the scene ↔ `Y.Doc` loop (data-model §9). It is
 * transport-agnostic: constructed from a `Y.Doc`, an `ExcalidrawImperativeAPI`,
 * and optional awareness — it opens no sockets and knows no server (FR-B-011).
 * One instance per mounted editor; disposable via `destroy()` (FR-B-012).
 */
export class WhiteboardBinding {
  readonly ydoc: Y.Doc;
  readonly elementsMap: Y.Map<Y.Map<unknown>>;
  readonly filesMap: Y.Map<BinaryFileData>;
  readonly appStateMap: Y.Map<unknown>;
  readonly awarenessRouter?: AwarenessRouter;

  private readonly api: BindingExcalidrawAPI;
  private readonly editingGuard?: EditingGuard;
  private lastKnownElements: ElementRecord[] = [];
  /**
   * Re-entrancy guard (FR-B-004). Real Excalidraw fires `onChange` synchronously
   * from inside `updateScene` (App.componentDidUpdate → onChangeEmitter). Our
   * own `applyToScene` → `updateScene` would therefore provoke an `onChange` that
   * re-enters `onSceneChange` and writes the just-applied state straight back
   * into the doc. We set this flag around `applyToScene` and short-circuit any
   * `onChange` raised while it is set — independent of writeDiff being a perfect
   * no-op.
   */
  private applying = false;
  private unsubscribeOnChange?: () => void;
  private readonly observeDeepHandler: (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
  ) => void;
  private readonly filesObserveHandler: (
    event: Y.YMapEvent<BinaryFileData>,
    transaction: Y.Transaction,
  ) => void;
  private readonly appStateObserveHandler: (
    event: Y.YMapEvent<unknown>,
    transaction: Y.Transaction,
  ) => void;
  private destroyed = false;

  constructor(
    ydoc: Y.Doc,
    api: BindingExcalidrawAPI,
    options: WhiteboardBindingOptions = {},
  ) {
    this.ydoc = ydoc;
    this.api = api;
    this.editingGuard = options.editingGuard;

    this.elementsMap = ydoc.getMap<Y.Map<unknown>>(ELEMENTS);
    this.filesMap = ydoc.getMap<BinaryFileData>(FILES);
    this.appStateMap = ydoc.getMap<unknown>(APPSTATE);

    // Seed an empty doc from the initial scene (initial load / migration).
    if (this.elementsMap.size === 0 && options.initialScene) {
      populateYDoc(options.initialScene, ydoc);
    }

    if (options.awareness) {
      this.awarenessRouter = new AwarenessRouter({
        awareness: options.awareness,
        api: {
          updateScene: api.updateScene,
          dispatchIncomingEmojiReaction:
            api.dispatchIncomingEmojiReaction ?? (() => {}),
          dispatchIncomingCountdownTimer:
            api.dispatchIncomingCountdownTimer ?? (() => {}),
        },
        ephemeral: options.ephemeral,
      });
    }

    // Apply the current doc state to the scene, seeding lastKnownElements.
    this.lastKnownElements = this.applyGuarded();

    // observe → apply (echo-guarded). The elements observer derives the set of
    // changed element ids from the deep-event paths so apply stays O(changed)
    // (FIX 2 / NFR-B-001); files/appState changes touch no element, so they apply
    // with an EMPTY element scope (every element keeps its object identity).
    this.observeDeepHandler = (events, transaction) =>
      this.onDocChange(transaction, changedElementIds(events));
    this.filesObserveHandler = (_event, transaction) =>
      this.onDocChange(transaction, new Set());
    this.appStateObserveHandler = (_event, transaction) =>
      this.onDocChange(transaction, new Set());
    this.elementsMap.observeDeep(this.observeDeepHandler);
    this.filesMap.observe(this.filesObserveHandler);
    this.appStateMap.observe(this.appStateObserveHandler);

    // onChange → diff
    this.unsubscribeOnChange = api.onChange((elements, appState, files) =>
      this.onSceneChange(
        elements as unknown as ElementRecord[],
        appState as unknown as Record<string, unknown>,
        files,
      ),
    );
  }

  private roots() {
    return {
      ydoc: this.ydoc,
      elementsMap: this.elementsMap,
      filesMap: this.filesMap,
      appStateMap: this.appStateMap,
    };
  }

  /**
   * Run `applyToScene` with the re-entrancy guard set, so any `onChange` the
   * editor fires synchronously from inside `updateScene` is ignored (no echo).
   * `scope` bounds apply to the changed element ids (O(changed)); `"full"`
   * rebuilds the whole scene (initial seed / unscopable structural change).
   */
  private applyGuarded(scope: ApplyScope = "full"): ElementRecord[] {
    this.applying = true;
    try {
      return applyToScene({
        roots: this.roots(),
        api: this.api,
        getPrevElements: () => this.lastKnownElements,
        editingGuard: this.editingGuard,
        scope,
      });
    } finally {
      this.applying = false;
    }
  }

  /** onChange → per-property Yjs write path (FR-B-002). */
  private onSceneChange(
    elements: ElementRecord[],
    appState: Record<string, unknown>,
    files: Parameters<Parameters<BindingExcalidrawAPI["onChange"]>[0]>[2],
  ): void {
    if (this.destroyed) {
      return;
    }
    // Re-entrancy guard: this onChange was provoked by our own applyToScene →
    // updateScene (real Excalidraw re-fires onChange synchronously). Ignore it —
    // applying remote state must NOT be echoed back into the doc (FR-B-004).
    if (this.applying) {
      return;
    }
    // Fast path: if no element changed by (id, version), only appState/files can
    // differ — still route through writeDiff (which self-guards no-op writes).
    const elementsUnchanged = areElementsSame(this.lastKnownElements, elements);
    writeDiff(
      this.roots(),
      this.lastKnownElements,
      elements,
      appState as never,
      files as never,
    );
    if (!elementsUnchanged) {
      this.lastKnownElements = elements.map((el) => ({ ...el }));
    }
  }

  /** Yjs observe → scene apply path, echo-guarded (FR-B-004). */
  private onDocChange(transaction: Y.Transaction, scope: ApplyScope): void {
    if (this.destroyed) {
      return;
    }
    // Echo guard: ignore our own writes.
    if (transaction.origin === BINDING_ORIGIN) {
      return;
    }
    this.lastKnownElements = this.applyGuarded(scope);
  }

  /** Detach every observer + subscription; no leaks on remount (FR-B-012). */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.elementsMap.unobserveDeep(this.observeDeepHandler);
    this.filesMap.unobserve(this.filesObserveHandler);
    this.appStateMap.unobserve(this.appStateObserveHandler);
    this.unsubscribeOnChange?.();
    this.unsubscribeOnChange = undefined;
    this.awarenessRouter?.destroy();
    this.lastKnownElements = [];
  }
}

export { populateYDoc, exportSceneJSON } from "./migrate";
export { areElementsSame, writeDiff, writeAppState } from "./diff";
export { applyToScene, buildElements, readAppState, nonDeleted } from "./apply";
export { AwarenessRouter } from "./awareness";
export {
  ELEMENTS,
  FILES,
  APPSTATE,
  APPSTATE_ALLOW_LIST,
  BINDING_ORIGIN,
  elementToYMap,
  yMapToElement,
  boundElementsToYMap,
  yMapToBoundElements,
  extraBoundTextIds,
  writeChangedKeys,
  diffBoundElements,
  deepEqual,
} from "./schema";
export { orderByIndex, keyBetween, keysBetween, repairIndices } from "./order";
export { diffFiles, readFiles, referencedFileIds } from "./files";

export type { ElementRecord, AppStateAllowKey } from "./schema";
export type {
  EphemeralChannel,
  EphemeralEvent,
  PointerPayload,
  EmojiReactionPayload,
  CountdownTimerPayload,
  VisibleSceneBoundsPayload,
} from "./awareness";
export type { SceneJSON } from "./migrate";
export type { ApplyScope, EditingGuard } from "./apply";
