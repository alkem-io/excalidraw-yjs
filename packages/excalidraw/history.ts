import { Emitter } from "@excalidraw-yjs/common";

import type { AppStateDelta } from "@excalidraw-yjs/element";

import type { Scene } from "@excalidraw-yjs/element";

import type { Store, StoreDelta } from "@excalidraw-yjs/element";

import type { SceneElementsMap } from "@excalidraw-yjs/element/types";

import type { AppState } from "./types";

/**
 * Native-Yjs core (M2) — history is split across two sources, by concern:
 *
 *  - **Elements** are owned by the doc's `Y.UndoManager` (`Scene.undoManager`,
 *    scoped to `LOCAL_ORIGIN`). An undo/redo step is a real inverse mutation of
 *    `yElements`, so the doc is the single source of truth for element history
 *    too — there is NO element delta stored here. (The old snapshot/`StoreDelta`
 *    element-history path is gone.)
 *  - **appState** is still off-doc in M1/M2 (selection, view bg, name, …). The
 *    editor's undo also restores the appState that paired with each element step
 *    (most importantly `selectedElementIds`), so each history entry carries the
 *    inverse appState delta and applies it alongside the element undo/redo.
 *
 * This `History` is therefore a thin facade that keeps the *authoritative* undo /
 * redo stacks (so depths, the redo-preservation rule, and the multi-step "skip
 * no-visible-change entries" walk all behave exactly as before) while delegating
 * the element mechanism to the UndoManager. Each entry records only whether it
 * had an element change (`hasElementChange`) plus its appState delta; the element
 * step itself lives on the UndoManager in lockstep (one element-bearing entry ↔
 * one `StackItem`, kept aligned by sealing each step via `stopElementCapture()`
 * at the same durable-commit boundary that pushes the entry here).
 *
 * Deferred to the appState-on-doc milestone: making appState itself a CRDT and
 * folding its history into the same doc/UndoManager. Until then appState history
 * stays this hybrid side-stack.
 */

/**
 * One undo/redo step. The element change (if any) is held by the doc's
 * `Y.UndoManager`; this entry holds the paired inverse appState delta and a flag
 * marking whether an element step exists for it on the UndoManager.
 */
export class HistoryEntry {
  constructor(
    public readonly appState: AppStateDelta,
    public readonly hasElementChange: boolean,
  ) {}

  /** Empty iff there is neither an element step nor an appState change. */
  public isEmpty(): boolean {
    return !this.hasElementChange && this.appState.isEmpty();
  }

  /** Inverse entry (for the opposite stack): appState delta inverted, element
   * flag unchanged (the UndoManager maintains the inverse element step itself). */
  public inverse(): HistoryEntry {
    return new HistoryEntry(this.appState.inverse(), this.hasElementChange);
  }
}

export class HistoryChangedEvent {
  constructor(
    public readonly isUndoStackEmpty: boolean = true,
    public readonly isRedoStackEmpty: boolean = true,
  ) {}
}

export class History {
  public readonly onHistoryChangedEmitter = new Emitter<
    [HistoryChangedEvent]
  >();

  public readonly undoStack: HistoryEntry[] = [];
  public readonly redoStack: HistoryEntry[] = [];

  /**
   * Guards against re-recording the element/appState changes that our own
   * undo/redo produces. Undo/redo flow back through the action pipeline as
   * `CaptureUpdateAction.NEVER` (ephemeral, never recorded), so in practice
   * `record` is not called for them — this is belt-and-braces.
   */
  private isApplyingHistory = false;

  public get isUndoStackEmpty() {
    return this.undoStack.length === 0;
  }

  public get isRedoStackEmpty() {
    return this.redoStack.length === 0;
  }

  /**
   * @param store the editor store (emits durable increments → {@link record})
   * @param getScene returns the *current* `Scene` (the editor may swap scenes;
   *   the element history lives on `scene.undoManager`, so we always resolve it
   *   live rather than capture a possibly-stale reference)
   */
  constructor(
    private readonly store: Store,
    private readonly getScene: () => Scene,
  ) {
    // Re-emit the editor's "history changed" event when the doc's element
    // undo/redo stacks change (e.g. a stack item was added/popped), so the
    // toolbar undo/redo buttons + shortcuts stay enabled/disabled correctly even
    // for element-only steps.
    this.getScene().onElementHistoryChange(() => {
      this.onHistoryChangedEmitter.trigger(
        new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
      );
    });
  }

  public clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.getScene().clearElementHistory();
    this.onHistoryChangedEmitter.trigger(
      new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
    );
  }

  /**
   * Record a durable local increment.
   *
   * The element change (if any) has ALREADY been captured by the doc's
   * `Y.UndoManager` synchronously when the scene was mutated this tick (under
   * `LOCAL_ORIGIN`). Here we (a) push the paired inverse appState delta + the
   * element-change flag onto the undo stack, (b) seal the UndoManager's current
   * step so the next gesture starts a fresh one (keeping the two stacks in
   * lockstep + giving the "rapid edits coalesce, discrete actions split" UX), and
   * (c) reset the redo stack — but only on an element change, so a standalone
   * appState change (e.g. a click that only changes selection) does not throw
   * away redoable steps.
   */
  public record(delta: StoreDelta) {
    if (this.isApplyingHistory || delta.isEmpty()) {
      return;
    }

    const hasElementChange = !delta.elements.isEmpty();
    const entry = new HistoryEntry(delta.appState.inverse(), hasElementChange);

    if (entry.isEmpty()) {
      return;
    }

    this.undoStack.push(entry);

    if (hasElementChange) {
      // Seal the element undo step the UndoManager captured for this gesture, so
      // the next local edit is a separate step (1 entry ↔ 1 StackItem).
      this.getScene().stopElementCapture();
      // A new durable element change invalidates the redo branch — both here and
      // on the UndoManager (it drops its redo stack when a fresh edit is tracked).
      this.redoStack.length = 0;
    }

    this.onHistoryChangedEmitter.trigger(
      new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
    );
  }

  public undo(elements: SceneElementsMap, appState: AppState) {
    return this.perform(
      elements,
      appState,
      () => History.pop(this.undoStack),
      (entry: HistoryEntry) => History.push(this.redoStack, entry),
      () => this.getScene().undoElements(),
    );
  }

  public redo(elements: SceneElementsMap, appState: AppState) {
    return this.perform(
      elements,
      appState,
      () => History.pop(this.redoStack),
      (entry: HistoryEntry) => History.push(this.undoStack, entry),
      () => this.getScene().redoElements(),
    );
  }

  /**
   * Apply undo/redo: walk entries (skipping ones that yield no visible change,
   * matching the old behaviour where e.g. selecting then deleting collapses), and
   * for each entry revert/replay its element step on the doc via the UndoManager
   * and apply its paired appState delta. Returns the post-apply elements map +
   * appState for the action pipeline to set on the editor.
   */
  private perform(
    elements: SceneElementsMap,
    appState: AppState,
    pop: () => HistoryEntry | null,
    push: (entry: HistoryEntry) => void,
    applyElementStep: () => boolean,
  ): [SceneElementsMap, AppState] | void {
    this.isApplyingHistory = true;
    try {
      let entry = pop();

      if (entry === null) {
        return;
      }

      const scene = this.getScene();
      let nextElements = elements;
      let nextAppState = appState;
      let containsVisibleChange = false;

      while (entry) {
        let elementsVisibleChange = false;
        try {
          if (entry.hasElementChange) {
            // Revert/replay the element step on the doc; the Scene's observeDeep
            // → recomputeFromDoc has already refreshed the derived reads (and
            // bumped local versions so downstream change-detection fires).
            elementsVisibleChange = applyElementStep();
            nextElements = scene.getElementsMapIncludingDeleted();
          }

          const [appliedAppState, appStateVisibleChange] =
            entry.appState.applyTo(nextAppState, nextElements);
          nextAppState = appliedAppState;

          containsVisibleChange =
            elementsVisibleChange || appStateVisibleChange;
        } finally {
          // The inverse goes onto the opposite stack (its element flag is the
          // same; the UndoManager moved the StackItem to its own opposite stack).
          push(entry);
        }

        if (containsVisibleChange) {
          break;
        }

        entry = pop();
      }

      return [nextElements, nextAppState];
    } finally {
      this.isApplyingHistory = false;
      this.onHistoryChangedEmitter.trigger(
        new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
      );
    }
  }

  private static pop(stack: HistoryEntry[]): HistoryEntry | null {
    if (!stack.length) {
      return null;
    }
    const entry = stack.pop();
    return entry !== undefined ? entry : null;
  }

  private static push(stack: HistoryEntry[], entry: HistoryEntry) {
    return stack.push(entry.inverse());
  }
}
