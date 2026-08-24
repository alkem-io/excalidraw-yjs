import {
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_ALIGN,
  CODES,
  KEYS,
  getLineHeight,
} from "@excalidraw-yjs/common";

import { newElementWith } from "@excalidraw-yjs/element";

import {
  hasBoundTextElement,
  canApplyRoundnessTypeToElement,
  getDefaultRoundnessTypeForElement,
  isFrameLikeElement,
  isArrowElement,
  isExcalidrawElement,
  isTextElement,
} from "@excalidraw-yjs/element";

import {
  getBoundTextElement,
  redrawTextBoundingBox,
} from "@excalidraw-yjs/element";

import { CaptureUpdateAction } from "@excalidraw-yjs/element";

import type { ExcalidrawTextElement } from "@excalidraw-yjs/element/types";

import { paintIcon } from "../components/icons";

import { t } from "../i18n";
import { getSelectedElements } from "../scene";

import { register } from "./register";

// `copiedStyles` is exported only for tests.
export let copiedStyles: string = "{}";

export const actionCopyStyles = register({
  name: "copyStyles",
  label: "labels.copyStyles",
  icon: paintIcon,
  trackEvent: { category: "element" },
  perform: (elements, appState, formData, app) => {
    const elementsCopied = [];
    const element = elements.find((el) => appState.selectedElementIds[el.id]);
    elementsCopied.push(element);
    if (element && hasBoundTextElement(element)) {
      const boundTextElement = getBoundTextElement(
        element,
        app.scene.getNonDeletedElementsMap(),
      );
      elementsCopied.push(boundTextElement);
    }
    if (element) {
      copiedStyles = JSON.stringify(elementsCopied);
    }
    return {
      appState: {
        ...appState,
        toast: { message: t("toast.copyStyles") },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  keyTest: (event) =>
    event[KEYS.CTRL_OR_CMD] && event.altKey && event.code === CODES.C,
});

export const actionPasteStyles = register({
  name: "pasteStyles",
  label: "labels.pasteStyles",
  icon: paintIcon,
  trackEvent: { category: "element" },
  perform: (elements, appState, formData, app) => {
    const elementsCopied = JSON.parse(copiedStyles);
    const pastedElement = elementsCopied[0];
    const boundTextElement = elementsCopied[1];
    if (!isExcalidrawElement(pastedElement)) {
      return { elements, captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }

    const selectedElements = getSelectedElements(elements, appState, {
      includeBoundTextElement: true,
    });
    const selectedElementIds = selectedElements.map((element) => element.id);
    // containers whose dimensions redrawTextBoundingBox wrote to the doc — only
    // these need a post-mutation fresh re-read (the styled elements themselves
    // carry their new values in the returned copy, NOT in the doc)
    const redrawnContainerIds = new Set<string>();
    const nextElements = elements.map((element) => {
      if (selectedElementIds.includes(element.id)) {
        let elementStylesToCopyFrom = pastedElement;
        if (isTextElement(element) && element.containerId) {
          elementStylesToCopyFrom = boundTextElement;
        }
        if (!elementStylesToCopyFrom) {
          return element;
        }
        let newElement = newElementWith(element, {
          backgroundColor: elementStylesToCopyFrom?.backgroundColor,
          strokeWidth: elementStylesToCopyFrom?.strokeWidth,
          strokeColor: elementStylesToCopyFrom?.strokeColor,
          strokeStyle: elementStylesToCopyFrom?.strokeStyle,
          fillStyle: elementStylesToCopyFrom?.fillStyle,
          opacity: elementStylesToCopyFrom?.opacity,
          roughness: elementStylesToCopyFrom?.roughness,
          roundness: elementStylesToCopyFrom.roundness
            ? canApplyRoundnessTypeToElement(
                elementStylesToCopyFrom.roundness.type,
                element,
              )
              ? elementStylesToCopyFrom.roundness
              : getDefaultRoundnessTypeForElement(element)
            : null,
        });

        if (isTextElement(newElement)) {
          const fontSize =
            (elementStylesToCopyFrom as ExcalidrawTextElement).fontSize ||
            DEFAULT_FONT_SIZE;
          const fontFamily =
            (elementStylesToCopyFrom as ExcalidrawTextElement).fontFamily ||
            DEFAULT_FONT_FAMILY;
          newElement = newElementWith(newElement, {
            fontSize,
            fontFamily,
            textAlign:
              (elementStylesToCopyFrom as ExcalidrawTextElement).textAlign ||
              DEFAULT_TEXT_ALIGN,
            lineHeight:
              (elementStylesToCopyFrom as ExcalidrawTextElement).lineHeight ||
              getLineHeight(fontFamily),
          });
          let container = null;
          if (newElement.containerId) {
            container =
              selectedElements.find(
                (element) =>
                  isTextElement(newElement) &&
                  element.id === newElement.containerId,
              ) || null;
          }

          redrawTextBoundingBox(newElement, container, app.scene);
          if (container) {
            redrawnContainerIds.add(container.id);
          }
        }

        if (
          newElement.type === "arrow" &&
          isArrowElement(elementStylesToCopyFrom)
        ) {
          newElement = newElementWith(newElement, {
            startArrowhead: elementStylesToCopyFrom.startArrowhead,
            endArrowhead: elementStylesToCopyFrom.endArrowhead,
          });
        }

        if (isFrameLikeElement(element)) {
          newElement = newElementWith(newElement, {
            roundness: null,
            backgroundColor: "transparent",
          });
        }

        return newElement;
      }
      return element;
    });

    // fresh-snapshot: re-read post-mutation. redrawTextBoundingBox resized the
    // bound-text CONTAINER through the doc, but `nextElements` carries a separate,
    // pre-redraw copy of that container. If the container was ALSO in the
    // selection, that copy is a `newElementWith` carrying the PASTED STYLE which
    // was never written to the doc — so we must NOT replace it wholesale with the
    // doc version (that would revert the style). Merge ONLY the redraw-affected
    // geometry keys from the fresh doc read onto the (possibly styled) copy.
    // redrawTextBoundingBox mutates exactly `width` and `height` on the container
    // (textElement.ts: `scene.mutateElement(container, { height })` /
    // `{ width }`); it never writes the container's x/y. For a redrawn container
    // that was NOT styled, `element` is the original unchanged element, so this
    // merge yields the fresh geometry just the same.
    const freshMap = app.scene.getNonDeletedElementsMap();

    return {
      elements: nextElements.map((element) => {
        if (!redrawnContainerIds.has(element.id)) {
          return element;
        }
        const freshContainer = freshMap.get(element.id);
        if (!freshContainer) {
          return element;
        }
        return newElementWith(element, {
          width: freshContainer.width,
          height: freshContainer.height,
        });
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  keyTest: (event) =>
    event[KEYS.CTRL_OR_CMD] && event.altKey && event.code === CODES.V,
});
