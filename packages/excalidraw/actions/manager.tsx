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
        actionResult.then((actionResult) => {
          return updater(actionResult, invocationBase);
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
    this.updater(
      data[0].perform(elements, appState, value, this.app),
      invocationBase,
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
    // ONE transport message per action. `perform` and the application of its
    // result are several Scene writes — a side-effect helper's mutation, the
    // structural prelude for a created element, the result application — and a
    // peer that sees them separately observes intermediate states, including
    // elements referencing a container that does not exist yet.
    //
    // Only the SYNCHRONOUS span is wrapped. For an async action the updater
    // registers a promise continuation and returns, so this `finally` closes the
    // boundary before the result lands — the buffer is never held across an
    // `await`. The `finally` also guarantees that a throw mid-action still
    // publishes whatever Yjs already committed.
    this.app.scene.beginLogicalMutation();
    // Separate, orthogonal scope: records which keys each `mutateElement` call
    // DECLARES during this action, so the result application can tell an
    // already-applied helper write from a stale action-derived one.
    this.app.scene.beginActionMutationJournal();
    try {
      this.updater(
        action.perform(elements, appState, value, this.app),
        invocationBase,
      );
    } finally {
      this.app.scene.endActionMutationJournal();
      this.app.scene.endLogicalMutation();
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
