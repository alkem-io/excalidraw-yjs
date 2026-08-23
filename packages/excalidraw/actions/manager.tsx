import React from "react";

import { isPromiseLike } from "@excalidraw-yjs/common";
import { captureElementBase } from "@excalidraw-yjs/element";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";

import { trackEvent } from "../analytics";

import type { AppClassProperties, AppState } from "../types";
import type {
  Action,
  UpdaterFn,
  ActionName,
  ActionResult,
  PanelComponentProps,
  ActionSource,
} from "./types";

const trackAction = (
  action: Action,
  source: ActionSource,
  appState: Readonly<AppState>,
  elements: readonly ExcalidrawElement[],
  app: AppClassProperties,
  value: any,
) => {
  if (action.trackEvent) {
    try {
      if (typeof action.trackEvent === "object") {
        const shouldTrack = action.trackEvent.predicate
          ? action.trackEvent.predicate(appState, elements, value)
          : true;
        if (shouldTrack) {
          trackEvent(
            action.trackEvent.category,
            action.trackEvent.action || action.name,
            `${source} (${
              app.editorInterface.formFactor === "phone" ? "mobile" : "desktop"
            })`,
          );
        }
      }
    } catch (error) {
      console.error("error while logging action:", error);
    }
  }
};

export class ActionManager {
  actions = {} as Record<ActionName, Action>;

  updater: (
    actionResult: ActionResult | Promise<ActionResult>,
    invocationBase?: readonly OrderedExcalidrawElement[],
  ) => void;

  getAppState: () => Readonly<AppState>;
  getElementsIncludingDeleted: () => readonly OrderedExcalidrawElement[];
  app: AppClassProperties;

  constructor(
    updater: UpdaterFn,
    getAppState: () => AppState,
    getElementsIncludingDeleted: () => readonly OrderedExcalidrawElement[],
    app: AppClassProperties,
  ) {
    this.updater = (actionResult, invocationBase) => {
      // FR-016/T016a: the invocation snapshot must survive the await. `ActionFn`
      // may be async, so by the time the result resolves the scene can have moved
      // on (a peer's update, a side-effect helper's own write). Carrying the base
      // through the promise is what lets the result later be applied as intent
      // against the CURRENT doc instead of overwriting it.
      if (isPromiseLike(actionResult)) {
        actionResult
          .then((resolved) => {
            // FAIL CLOSED (spec 002 / T016b). By the time an async result
            // resolves, this action's logical-mutation boundary AND its mutation
            // journal are already closed, so neither `invocationBase` nor the
            // journal describes the document the result would land on: the derived
            // path would apply a stale diff against an EMPTY journal, silently.
            // No async `perform` returns `elements` today (audited: zero), so this
            // rejects rather than guessing — and rejects BEFORE any store
            // scheduling or Scene mutation.
            if (resolved !== false && resolved.elements) {
              throw new Error(
                "ActionManager: an async action returned `elements`. The " +
                  "synchronous derived-intent path cannot apply it — the action's " +
                  "mutation journal and transport boundary are already closed. " +
                  "Such an action must declare its own intent/ownership.",
              );
            }
            // An appState-only async result is unaffected: it never reaches the
            // element write path.
            return updater(resolved, undefined);
          })
          // Surfaced, not swallowed and not left as an UNHANDLED rejection: this
          // continuation is fire-and-forget, so a bare throw would escape the
          // promise chain entirely — loud in a console nobody reads, and it
          // would wedge the test runner rather than reach the author.
          .catch((error) => {
            console.error(error);
          });
      } else {
        return updater(actionResult, invocationBase);
      }
    };
    this.getAppState = getAppState;
    this.getElementsIncludingDeleted = getElementsIncludingDeleted;
    this.app = app;
  }

  registerAction(action: Action) {
    this.actions[action.name] = action;
  }

  registerAll(actions: readonly Action[]) {
    actions.forEach((action) => this.registerAction(action));
  }

  handleKeyDown(event: React.KeyboardEvent | KeyboardEvent) {
    const canvasActions = this.app.props.UIOptions.canvasActions;
    const data = Object.values(this.actions)
      .sort((a, b) => (b.keyPriority || 0) - (a.keyPriority || 0))
      .filter(
        (action) =>
          (action.name in canvasActions
            ? canvasActions[action.name as keyof typeof canvasActions]
            : true) &&
          action.keyTest &&
          action.keyTest(
            event,
            this.getAppState(),
            this.getElementsIncludingDeleted(),
            this.app,
          ),
      );

    if (data.length !== 1) {
      if (data.length > 1) {
        console.warn("Canceling as multiple actions match this shortcut", data);
      }
      return false;
    }

    const action = data[0];

    if (this.getAppState().viewModeEnabled && action.viewMode !== true) {
      return false;
    }

    const elements = this.getElementsIncludingDeleted();
    const appState = this.getAppState();
    const value = null;

    trackAction(action, "keyboard", appState, elements, this.app, null);

    event.preventDefault();
    event.stopPropagation();
    // Capture BEFORE `perform` runs. JavaScript evaluates arguments left to
    // right, so passing `captureElementBase(elements)` as a later argument would
    // snapshot AFTER the action has already mutated the scratch objects in place
    // — `Scene.mutateElement` mutates its argument — and the "invocation base"
    // would equal the result, making the derived intent diff empty.
    const invocationBase = captureElementBase(elements);
    this.runWithinActionBoundary(invocationBase, () =>
      data[0].perform(elements, appState, value, this.app),
    );
    return true;
  }

  executeAction<T extends Action>(
    action: T,
    source: ActionSource = "api",
    value: Parameters<T["perform"]>[2] = null,
  ) {
    const elements = this.getElementsIncludingDeleted();
    const appState = this.getAppState();

    trackAction(action, source, appState, elements, this.app, value);

    // Capture BEFORE `perform` runs. JavaScript evaluates arguments left to
    // right, so passing `captureElementBase(elements)` as a later argument would
    // snapshot AFTER the action has already mutated the scratch objects in place
    // — `Scene.mutateElement` mutates its argument — and the "invocation base"
    // would equal the result, making the derived intent diff empty.
    const invocationBase = captureElementBase(elements);
    this.runWithinActionBoundary(invocationBase, () =>
      action.perform(elements, appState, value, this.app),
    );
  }

  /**
   * Run one action's `perform` AND the application of its result as a single
   * logical mutation. Every entry point must go through here.
   *
   * ONE transport message per action. `perform` and the application of its
   * result are several Scene writes — a side-effect helper's mutation, the
   * structural prelude for a created element, the result application — and a
   * peer that sees them separately observes intermediate states, including
   * elements referencing a container that does not exist yet.
   *
   * Only the SYNCHRONOUS span is wrapped. For an async action the updater
   * registers a promise continuation and returns, so the `finally` closes the
   * boundary before the result lands — the buffer is never held across an
   * `await`. The `finally` also guarantees that a throw mid-action still
   * publishes whatever Yjs already committed.
   *
   * Extracted so `handleKeyDown` shares it with `executeAction`. Both previously
   * captured `invocationBase` but `handleKeyDown` opened NEITHER scope, so on
   * that path a peer saw one message per internal write (FR-017 violated,
   * measured: a keyboard flip emitted 2), and — worse, because it fails open —
   * `applyElementChanges` skipped its entire ambiguity block, which is guarded
   * on `alreadyAppliedIntent?.size`. An unopened journal is size 0, so every
   * `overlapPolicy` an action declared was silently discarded and a key that
   * throws "unresolved ownership" via the context menu was written via the
   * shortcut.
   *
   * `renderAction`'s `updateData` is deliberately NOT routed through here yet:
   * the same wrap regresses 10 `textWysiwyg` tests, so that entry point needs
   * its own remedy rather than this one applied blind.
   */
  private runWithinActionBoundary(
    invocationBase: readonly OrderedExcalidrawElement[] | undefined,
    perform: () => ReturnType<Action["perform"]>,
  ) {
    this.app.scene.beginLogicalMutation();
    // Separate, orthogonal scope: records which keys each `mutateElement` call
    // DECLARES during this action, so the result application can tell an
    // already-applied helper write from a stale action-derived one.
    this.app.scene.beginActionMutationJournal();
    try {
      this.updater(perform(), invocationBase);
    } finally {
      // NESTED, not sequential: `endActionMutationJournal` throws on imbalance,
      // and a sequential pair would leave the transport boundary open forever —
      // every later action would then buffer into a scope nothing closes.
      try {
        this.app.scene.endActionMutationJournal();
      } finally {
        this.app.scene.endLogicalMutation();
      }
    }
  }

  /**
   * @param data additional data sent to the PanelComponent
   */
  renderAction = (name: ActionName, data?: PanelComponentProps["data"]) => {
    const canvasActions = this.app.props.UIOptions.canvasActions;

    if (
      this.actions[name] &&
      "PanelComponent" in this.actions[name] &&
      (name in canvasActions
        ? canvasActions[name as keyof typeof canvasActions]
        : true)
    ) {
      const action = this.actions[name];
      const PanelComponent = action.PanelComponent!;
      PanelComponent.displayName = "PanelComponent";
      const elements = this.getElementsIncludingDeleted();
      const appState = this.getAppState();
      const updateData = (formState?: any) => {
        trackAction(action, "ui", appState, elements, this.app, formState);

        const invocationElements = this.getElementsIncludingDeleted();
        // Capture BEFORE `perform` runs. JavaScript evaluates arguments left to
        // right, so passing `captureElementBase(elements)` as a later argument would
        // snapshot AFTER the action has already mutated the scratch objects in place
        // — `Scene.mutateElement` mutates its argument — and the "invocation base"
        // would equal the result, making the derived intent diff empty.
        const invocationBase = captureElementBase(invocationElements);
        // NOT routed through `runWithinActionBoundary` — see its docblock. Wrapping
        // this path regresses 10 `textWysiwyg` tests (9 snapshots): a panel
        // `updateData` can fire while a wysiwyg editor is open, and buffering the
        // doc writes across it changes what that flow observes. The FR-017 gap on
        // this entry point is real but its remedy is not a straight wrap, so it is
        // left measured rather than "fixed" with a regression attached.
        this.updater(
          action.perform(
            invocationElements,
            this.getAppState(),
            formState,
            this.app,
          ),
          invocationBase,
        );
      };

      return (
        <PanelComponent
          elements={this.getElementsIncludingDeleted()}
          appState={this.getAppState()}
          updateData={updateData}
          appProps={this.app.props}
          app={this.app}
          data={data}
          renderAction={this.renderAction}
        />
      );
    }

    return null;
  };

  isActionEnabled = (action: Action) => {
    const elements = this.getElementsIncludingDeleted();
    const appState = this.getAppState();

    return (
      !action.predicate ||
      action.predicate(elements, appState, this.app.props, this.app)
    );
  };
}
