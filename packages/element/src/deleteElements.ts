import { fixBindingsAfterDeletion } from "./binding";
import { getFrameChildren } from "./frame";
import { newElementWith } from "./mutateElement";
import { getContainerElement } from "./textElement";
import { isBoundToContainer, isElbowArrow } from "./typeChecks";

import type { Scene } from "./Scene";
import type { ExcalidrawElement } from "./types";

/** Document changes shared by whole-element deletion in editor and automation. */
export const planElementDeletion = (
  elements: readonly ExcalidrawElement[],
  selectedIds: Readonly<Record<string, boolean>>,
  framesToBeDeleted: ReadonlySet<string>,
  scene: Scene,
) => {
  const selectedElementIds: Record<string, true> = {};
  const elementsMap = scene.getNonDeletedElementsMap();
  const processedElements = new Set<string>();
  for (const frameId of framesToBeDeleted) {
    for (const el of getFrameChildren(elements, frameId)) {
      if (processedElements.has(el.id)) {
        continue;
      }
      if (isBoundToContainer(el)) {
        const container = getContainerElement(el, elementsMap);
        if (container) {
          selectedElementIds[container.id] = true;
        }
      } else {
        selectedElementIds[el.id] = true;
      }
      processedElements.add(el.id);
    }
  }
  let shouldSelectEditingGroup = true;
  const nextElements = elements.map((el) => {
    if (selectedIds[el.id]) {
      const boundElement = isBoundToContainer(el)
        ? getContainerElement(el, elementsMap)
        : null;
      if (el.frameId && framesToBeDeleted.has(el.frameId)) {
        shouldSelectEditingGroup = false;
        selectedElementIds[el.id] = true;
        return el;
      }
      if (
        boundElement?.frameId &&
        framesToBeDeleted.has(boundElement.frameId)
      ) {
        return el;
      }
      for (const candidate of el.boundElements || []) {
        const bound = scene.getNonDeletedElementsMap().get(candidate.id);
        if (bound && isElbowArrow(bound)) {
          scene.mutateElement(bound, {
            startBinding:
              el.id === bound.startBinding?.elementId
                ? null
                : bound.startBinding,
            endBinding:
              el.id === bound.endBinding?.elementId ? null : bound.endBinding,
          });
        }
      }
      return newElementWith(el, { isDeleted: true });
    }
    if (el.frameId && framesToBeDeleted.has(el.frameId)) {
      shouldSelectEditingGroup = false;
      if (!isBoundToContainer(el)) {
        selectedElementIds[el.id] = true;
      }
      return newElementWith(el, { frameId: null });
    }
    if (isBoundToContainer(el) && selectedIds[el.containerId]) {
      return newElementWith(el, { isDeleted: true });
    }
    return el;
  });
  return {
    elements: nextElements,
    selectedElementIds,
    shouldSelectEditingGroup,
  };
};

/** Binding repair is part of the same document operation, not a transport step. */
export const repairBindingsAfterDeletion = (
  elements: readonly ExcalidrawElement[],
) => {
  fixBindingsAfterDeletion(
    elements,
    elements.filter((el) => el.isDeleted),
  );
};
