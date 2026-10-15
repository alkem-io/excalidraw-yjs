import {
  KEYS,
  MOBILE_ACTION_BUTTON_BG,
  updateActiveTool,
} from "@excalidraw-yjs/common";

import { getNonDeletedElements } from "@excalidraw-yjs/element";
import {
  planElementDeletion,
  repairBindingsAfterDeletion,
} from "@excalidraw-yjs/element";
import { LinearElementEditor } from "@excalidraw-yjs/element";
import { newElementWith } from "@excalidraw-yjs/element";
import { isFrameLikeElement } from "@excalidraw-yjs/element";

import {
  getElementsInGroup,
  selectGroupsForSelectedElements,
} from "@excalidraw-yjs/element";

import { CaptureUpdateAction } from "@excalidraw-yjs/element";

import type { ExcalidrawElement } from "@excalidraw-yjs/element/types";

import { t } from "../i18n";
import { getSelectedElements, isSomeElementSelected } from "../scene";
import { TrashIcon } from "../components/icons";
import { ToolButton } from "../components/ToolButton";

import { useStylesPanelMode } from "../components/App";

import { register } from "./register";

import type { AppClassProperties, AppState } from "../types";

const deleteSelectedElements = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  app: AppClassProperties,
) => {
  const framesToBeDeleted = new Set(
    getSelectedElements(
      elements.filter((el) => isFrameLikeElement(el)),
      appState,
    ).map((el) => el.id),
  );

  const {
    elements: nextElements,
    selectedElementIds,
    shouldSelectEditingGroup,
  } = planElementDeletion(
    elements,
    appState.selectedElementIds,
    framesToBeDeleted,
    app.scene,
  );

  let nextEditingGroupId = appState.editingGroupId;

  // select next eligible element in currently editing group or supergroup
  if (shouldSelectEditingGroup && appState.editingGroupId) {
    const elems = getElementsInGroup(
      nextElements,
      appState.editingGroupId,
    ).filter((el) => !el.isDeleted);
    if (elems.length > 1) {
      if (elems[0]) {
        selectedElementIds[elems[0].id] = true;
      }
    } else {
      nextEditingGroupId = null;
      if (elems[0]) {
        selectedElementIds[elems[0].id] = true;
      }

      const lastElementInGroup = elems[0];
      if (lastElementInGroup) {
        const editingGroupIdx = lastElementInGroup.groupIds.findIndex(
          (groupId) => {
            return groupId === appState.editingGroupId;
          },
        );
        const superGroupId = lastElementInGroup.groupIds[editingGroupIdx + 1];
        if (superGroupId) {
          const elems = getElementsInGroup(nextElements, superGroupId).filter(
            (el) => !el.isDeleted,
          );
          if (elems.length > 1) {
            nextEditingGroupId = superGroupId;

            elems.forEach((el) => {
              selectedElementIds[el.id] = true;
            });
          }
        }
      }
    }
  }

  return {
    elements: nextElements,
    appState: {
      ...appState,
      ...selectGroupsForSelectedElements(
        {
          selectedElementIds,
          editingGroupId: nextEditingGroupId,
        },
        nextElements,
        appState,
        null,
      ),
    },
  };
};

const handleGroupEditingState = (
  appState: AppState,
  elements: readonly ExcalidrawElement[],
): AppState => {
  if (appState.editingGroupId) {
    const siblingElements = getElementsInGroup(
      getNonDeletedElements(elements),
      appState.editingGroupId!,
    );
    if (siblingElements.length) {
      return {
        ...appState,
        selectedElementIds: { [siblingElements[0].id]: true },
      };
    }
  }
  return appState;
};

export const actionDeleteSelected = register({
  name: "deleteSelectedElements",
  label: "labels.delete",
  icon: TrashIcon,
  trackEvent: { category: "element", action: "delete" },
  perform: (elements, appState, formData, app) => {
    if (appState.selectedLinearElement?.isEditing) {
      const { elementId, selectedPointsIndices } =
        appState.selectedLinearElement;
      const elementsMap = app.scene.getNonDeletedElementsMap();
      const linearElement = LinearElementEditor.getElement(
        elementId,
        elementsMap,
      );
      if (!linearElement) {
        return false;
      }
      // case: no point selected → do nothing, as deleting the whole element
      // is most likely a mistake, where you wanted to delete a specific point
      // but failed to select it (or you thought it's selected, while it was
      // only in a hover state)
      if (selectedPointsIndices == null) {
        return false;
      }

      // case: deleting all points
      if (selectedPointsIndices.length >= linearElement.points.length) {
        const nextElements = elements.map((el) => {
          if (el.id === linearElement.id) {
            return newElementWith(el, { isDeleted: true });
          }
          return el;
        });
        const nextAppState = handleGroupEditingState(appState, nextElements);

        return {
          elements: nextElements,
          appState: {
            ...nextAppState,
            selectedLinearElement: null,
          },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        };
      }

      LinearElementEditor.deletePoints(
        linearElement,
        app,
        selectedPointsIndices,
      );

      return {
        elements,
        appState: {
          ...appState,
          selectedLinearElement: {
            ...appState.selectedLinearElement,
            selectedPointsIndices:
              selectedPointsIndices?.[0] > 0
                ? [selectedPointsIndices[0] - 1]
                : [0],
          },
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      };
    }

    let { elements: nextElements, appState: nextAppState } =
      deleteSelectedElements(elements, appState, app);

    repairBindingsAfterDeletion(nextElements);

    nextAppState = handleGroupEditingState(nextAppState, nextElements);

    return {
      elements: nextElements,
      appState: {
        ...nextAppState,
        activeTool: updateActiveTool(appState, {
          type: app.state.preferredSelectionTool.type,
        }),
        multiElement: null,
        newElement: null,
        activeEmbeddable: null,
        selectedLinearElement: null,
      },
      captureUpdate: isSomeElementSelected(
        getNonDeletedElements(elements),
        appState,
      )
        ? CaptureUpdateAction.IMMEDIATELY
        : CaptureUpdateAction.EVENTUALLY,
    };
  },
  keyTest: (event, appState, elements) =>
    (event.key === KEYS.BACKSPACE || event.key === KEYS.DELETE) &&
    (!event[KEYS.CTRL_OR_CMD] ||
      isSomeElementSelected(getNonDeletedElements(elements), appState)),
  PanelComponent: ({ elements, appState, updateData, app }) => {
    const isMobile = useStylesPanelMode() === "mobile";

    return (
      <ToolButton
        type="button"
        icon={TrashIcon}
        title={t("labels.delete")}
        aria-label={t("labels.delete")}
        onClick={() => updateData(null)}
        disabled={
          !isSomeElementSelected(getNonDeletedElements(elements), appState)
        }
        style={{
          ...(isMobile && appState.openPopup !== "compactOtherProperties"
            ? MOBILE_ACTION_BUTTON_BG
            : {}),
        }}
      />
    );
  },
});
