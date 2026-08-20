import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw-yjs/element/types";

import type { CaptureUpdateActionType } from "@excalidraw-yjs/element";

import type {
  AppClassProperties,
  AppState,
  ExcalidrawProps,
  BinaryFiles,
  UIAppState,
} from "../types";
import type React from "react";

export type ActionSource =
  | "ui"
  | "keyboard"
  | "contextMenu"
  | "api"
  | "commandPalette";

/** if false, the action should be prevented */
export type ActionResult =
  | {
      elements?: readonly ExcalidrawElement[] | null;
      appState?: Partial<AppState> | null;
      files?: BinaryFiles | null;
      captureUpdate: CaptureUpdateActionType;
      replaceFiles?: boolean;
      /** A per-KEY conflict policy — see `Scene.applyElementChanges`. */
      overlapPolicy?: ReadonlyMap<string, "result" | "applied">;
      //
      // ASYNC RULE (spec 002 / T016b). The derived-diff + journal path applies
      // only to a SYNCHRONOUS action: `ActionManager` closes both the transport
      // boundary and the mutation-journal scope before an async result resolves,
      // so neither the invocation base nor the journal describes the document
      // the result would land on. No async `perform` currently returns
      // `elements` (audited: zero). If one is ever added it must supply explicit
      // intent/ownership rather than rely on the synchronous fallback.
    }
  | false;

type ActionFn<TData = any> = (
  elements: readonly OrderedExcalidrawElement[],
  appState: Readonly<AppState>,
  formData: TData | undefined,
  app: AppClassProperties,
) => ActionResult | Promise<ActionResult>;

export type UpdaterFn = (
  res: ActionResult,
  /**
   * The elements as they were when the action was INVOKED (spec 002, FR-016 /
   * T016a) — a deep copy, so it stays a stable "before" image even though
   * `Scene.mutateElement` mutates scratch objects in place.
   *
   * `ActionFn` may be async, so the result can arrive after the scene has moved
   * on; this is what lets the result be applied as the action's INTENT against
   * the current doc rather than as an authoritative overwrite. Optional while
   * T016c wires the consumer.
   */
  invocationBase?: readonly OrderedExcalidrawElement[],
) => void;
export type ActionFilterFn = (action: Action) => void;

export type ActionName =
  | "copy"
  | "cut"
  | "paste"
  | "copyAsPng"
  | "copyAsSvg"
  | "copyText"
  | "sendBackward"
  | "bringForward"
  | "sendToBack"
  | "bringToFront"
  | "copyStyles"
  | "selectAll"
  | "pasteStyles"
  | "gridMode"
  | "zenMode"
  | "objectsSnapMode"
  | "arrowBinding"
  | "midpointSnapping"
  | "stats"
  | "changeStrokeColor"
  | "changeBackgroundColor"
  | "changeFillStyle"
  | "changeStrokeWidth"
  | "changeStrokeShape"
  | "changeSloppiness"
  | "changeStrokeStyle"
  | "changeArrowhead"
  | "changeArrowType"
  | "changeArrowProperties"
  | "changeOpacity"
  | "changeFontSize"
  | "undo"
  | "redo"
  | "finalize"
  | "changeProjectName"
  | "changeExportBackground"
  | "changeExportEmbedScene"
  | "changeExportScale"
  | "saveToActiveFile"
  | "saveFileToDisk"
  | "loadScene"
  | "duplicateSelection"
  | "deleteSelectedElements"
  | "changeViewBackgroundColor"
  | "clearCanvas"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "zoomToFit"
  | "zoomToFitSelection"
  | "zoomToFitSelectionInViewport"
  | "changeFontFamily"
  | "changeTextAlign"
  | "changeVerticalAlign"
  | "toggleFullScreen"
  | "toggleShortcuts"
  | "group"
  | "ungroup"
  | "goToCollaborator"
  | "addToLibrary"
  | "changeRoundness"
  | "alignTop"
  | "alignBottom"
  | "alignLeft"
  | "alignRight"
  | "alignVerticallyCentered"
  | "alignHorizontallyCentered"
  | "distributeHorizontally"
  | "distributeVertically"
  | "flipHorizontal"
  | "flipVertical"
  | "deselect"
  | "viewMode"
  | "exportWithDarkMode"
  | "toggleTheme"
  | "increaseFontSize"
  | "decreaseFontSize"
  | "unbindText"
  | "hyperlink"
  | "bindText"
  | "unlockAllElements"
  | "toggleElementLock"
  | "toggleLinearEditor"
  | "toggleEraserTool"
  | "toggleHandTool"
  | "selectAllElementsInFrame"
  | "removeAllElementsFromFrame"
  | "updateFrameRendering"
  | "setFrameAsActiveTool"
  | "setEmbeddableAsActiveTool"
  | "createContainerFromText"
  | "wrapTextInContainer"
  | "commandPalette"
  | "autoResize"
  | "elementStats"
  | "searchMenu"
  | "copyElementLink"
  | "linkToElement"
  | "cropEditor"
  | "wrapSelectionInFrame"
  | "toggleLassoTool"
  | "toggleShapeSwitch"
  | "togglePolygon";

export type PanelComponentProps = {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  updateData: <T = any>(formData?: T) => void;
  appProps: ExcalidrawProps;
  data?: Record<string, any>;
  app: AppClassProperties;
  renderAction: (
    name: ActionName,
    data?: PanelComponentProps["data"],
  ) => React.JSX.Element | null;
};

export interface Action<TData = any> {
  name: ActionName;
  label:
    | string
    | ((
        elements: readonly ExcalidrawElement[],
        appState: Readonly<AppState>,
        app: AppClassProperties,
      ) => string);
  keywords?: string[];
  icon?:
    | React.ReactNode
    | ((
        appState: UIAppState,
        elements: readonly ExcalidrawElement[],
      ) => React.ReactNode);
  PanelComponent?: React.FC<PanelComponentProps>;
  perform: ActionFn<TData>;
  keyPriority?: number;
  keyTest?: (
    event: React.KeyboardEvent | KeyboardEvent,
    appState: AppState,
    elements: readonly ExcalidrawElement[],
    app: AppClassProperties,
  ) => boolean;
  predicate?: (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    appProps: ExcalidrawProps,
    app: AppClassProperties,
  ) => boolean;
  checked?: (appState: Readonly<AppState>) => boolean;
  trackEvent:
    | false
    | {
        category:
          | "toolbar"
          | "element"
          | "canvas"
          | "export"
          | "history"
          | "menu"
          | "collab"
          | "hyperlink"
          | "search_menu"
          | "shape_switch";
        action?: string;
        predicate?: (
          appState: Readonly<AppState>,
          elements: readonly ExcalidrawElement[],
          value: any,
        ) => boolean;
      };
  /** if set to `true`, allow action to be performed in viewMode.
   *  Defaults to `false` */
  viewMode?: boolean;
}
