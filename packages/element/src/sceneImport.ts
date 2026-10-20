import { FONT_FAMILY, randomId } from "@excalidraw-yjs/common";
import * as Y from "yjs";

import { duplicateElements } from "./duplicate";
import { validateFractionalIndices } from "./fractionalIndex";
import { isBindableElement } from "./typeChecks";
import {
  readAssetLocators,
  validateAssetLocator,
  yMapToElement,
} from "./yjs/schema";

import type { Scene } from "./Scene";
import type { ExcalidrawElement, FileId } from "./types";

export type SceneImportInput = {
  scene: {
    type: "excalidraw";
    version: 2;
    elements: readonly ExcalidrawElement[];
  };
  targetFileIDs: Readonly<Record<string, string>>;
};

export const validateImportDestination = (doc: Y.Doc) => {
  const elements = [...doc.getMap("elements").entries()].map(([id, value]) => {
    check(value instanceof Y.Map && value.get("id") === id);
    const bound = value.get("boundElements");
    check(bound === undefined || bound instanceof Y.Map);
    if (bound instanceof Y.Map) {
      check([...bound.values()].filter((type) => type === "text").length <= 1);
    }
    return { ...yMapToElement(value), version: 1, versionNonce: 0, updated: 0 };
  });
  // Fractional ordering uses code units, not locale collation.
  elements.sort((a: any, b: any) =>
    a.index < b.index ? -1 : a.index > b.index ? 1 : 0,
  );
  validateImportElements(elements);
  readAssetLocators(doc.getMap("files"));
};

const check: (value: unknown) => asserts value = (value) => {
  if (!value) {
    throw new Error("invalid current scene export");
  }
};

const jsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(jsonValue);
  }
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(jsonValue)
  );
};

const baseKeys =
  "id type x y width height angle strokeColor backgroundColor fillStyle strokeWidth strokeStyle roundness roughness opacity seed version versionNonce index isDeleted groupIds frameId boundElements updated link locked customData".split(
    " ",
  );
const typeKeys: Record<string, string[]> = {
  rectangle: [],
  ellipse: [],
  diamond: [],
  embeddable: [],
  iframe: [],
  frame: ["name"],
  magicframe: ["name"],
  text: "fontSize fontFamily text textAlign verticalAlign containerId originalText autoResize lineHeight".split(
    " ",
  ),
  image: ["fileId", "status", "scale", "crop"],
  line: "points startBinding endBinding startArrowhead endArrowhead lastCommittedPoint polygon".split(
    " ",
  ),
  arrow:
    "points startBinding endBinding startArrowhead endArrowhead lastCommittedPoint elbowed fixedSegments startIsSpecial endIsSpecial".split(
      " ",
    ),
  freedraw: ["points", "pressures", "simulatePressure", "lastCommittedPoint"],
};
const pair = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((v) => typeof v === "number" && Number.isFinite(v));
const nullableID = (value: unknown) =>
  value === null || (typeof value === "string" && value.length > 0);
const fields = (value: object, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** Strict current records only: validation never repairs, drops or measures text. */
export function validateImportElements(
  elements: unknown,
): asserts elements is ExcalidrawElement[] {
  check(Array.isArray(elements));
  const ids = new Map<string, any>();
  for (const element of elements) {
    check(element && jsonValue(element));
    const extra = typeKeys[element.type];
    check(
      extra &&
        Object.keys(element).every(
          (key) => baseKeys.includes(key) || extra.includes(key),
        ),
    );
    check(
      typeof element.id === "string" &&
        element.id.length > 0 &&
        !ids.has(element.id),
    );
    ids.set(element.id, element);
    check(
      [
        "x",
        "y",
        "width",
        "height",
        "angle",
        "strokeWidth",
        "roughness",
        "opacity",
        "seed",
        "version",
        "versionNonce",
        "updated",
      ].every(
        (key) =>
          typeof element[key] === "number" && Number.isFinite(element[key]),
      ),
    );
    check(
      element.width >= 0 &&
        element.height >= 0 &&
        element.strokeWidth >= 0 &&
        element.roughness >= 0 &&
        element.opacity >= 0 &&
        element.opacity <= 100 &&
        element.version >= 1,
    );
    check(
      ["strokeColor", "backgroundColor"].every(
        (key) => typeof element[key] === "string",
      ),
    );
    check(
      ["hachure", "cross-hatch", "solid", "zigzag"].includes(element.fillStyle),
    );
    check(["solid", "dashed", "dotted"].includes(element.strokeStyle));
    check(
      element.roundness === null ||
        (element.roundness &&
          fields(element.roundness, ["type", "value"]) &&
          [1, 2, 3].includes(element.roundness.type) &&
          (element.roundness.value === undefined ||
            typeof element.roundness.value === "number")),
    );
    check(
      typeof element.isDeleted === "boolean" &&
        typeof element.locked === "boolean",
    );
    check(
      Array.isArray(element.groupIds) &&
        element.groupIds.every(
          (id: unknown) => typeof id === "string" && id.length > 0,
        ) &&
        new Set(element.groupIds).size === element.groupIds.length,
    );
    check(
      nullableID(element.frameId) &&
        (element.link === null || typeof element.link === "string"),
    );
    check(typeof element.index === "string");
    check(
      element.boundElements === null ||
        (Array.isArray(element.boundElements) &&
          new Set(element.boundElements.map((edge: any) => edge.id)).size ===
            element.boundElements.length &&
          element.boundElements.every(
            (edge: any) =>
              edge &&
              fields(edge, ["id", "type"]) &&
              typeof edge.id === "string" &&
              ["text", "arrow"].includes(edge.type),
          ) &&
          element.boundElements.filter((edge: any) => edge.type === "text")
            .length <= 1),
    );
    if (
      element.type === "iframe" &&
      element.customData?.generationData !== undefined
    ) {
      const data = element.customData.generationData;
      check(data && typeof data === "object" && !Array.isArray(data));
      check(["pending", "done", "error"].includes(data.status));
      if (data.status === "done") {
        check(typeof data.html === "string");
      }
      if (data.status === "error") {
        check(typeof data.code === "string");
        check(data.message === undefined || typeof data.message === "string");
      }
    }
    if (element.type === "text") {
      check(
        typeof element.text === "string" &&
          typeof element.originalText === "string" &&
          typeof element.autoResize === "boolean" &&
          nullableID(element.containerId),
      );
      check(
        element.fontSize > 0 &&
          typeof element.fontSize === "number" &&
          element.lineHeight > 0 &&
          typeof element.lineHeight === "number" &&
          Object.values(FONT_FAMILY).includes(element.fontFamily),
      );
      check(
        ["left", "center", "right"].includes(element.textAlign) &&
          ["top", "middle", "bottom"].includes(element.verticalAlign),
      );
    }
    if (["arrow", "line", "freedraw"].includes(element.type)) {
      check(
        Array.isArray(element.points) &&
          element.points.length > 0 &&
          element.points.every(pair),
      );
      check(
        element.lastCommittedPoint === undefined ||
          element.lastCommittedPoint === null ||
          pair(element.lastCommittedPoint),
      );
    }
    if (["arrow", "line"].includes(element.type)) {
      for (const key of ["startBinding", "endBinding"]) {
        const binding = element[key];
        check(
          binding === null ||
            (binding &&
              fields(binding, ["elementId", "fixedPoint", "mode"]) &&
              typeof binding.elementId === "string" &&
              pair(binding.fixedPoint) &&
              ["inside", "orbit", "skip"].includes(binding.mode)),
        );
      }
      check(
        ["startArrowhead", "endArrowhead"].every(
          (key) =>
            element[key] === null ||
            [
              "arrow",
              "bar",
              "circle",
              "circle_outline",
              "triangle",
              "triangle_outline",
              "diamond",
              "diamond_outline",
              "cardinality_one",
              "cardinality_many",
              "cardinality_one_or_many",
              "cardinality_exactly_one",
              "cardinality_zero_or_one",
              "cardinality_zero_or_many",
            ].includes(element[key]),
        ),
      );
      if (element.type === "arrow") {
        check(typeof element.elbowed === "boolean");
        check(
          ["startIsSpecial", "endIsSpecial"].every(
            (key) =>
              element[key] === undefined ||
              element[key] === null ||
              typeof element[key] === "boolean",
          ),
        );
        check(
          element.fixedSegments === undefined ||
            element.fixedSegments === null ||
            (Array.isArray(element.fixedSegments) &&
              element.fixedSegments.every(
                (segment: any) =>
                  fields(segment, ["index", "start", "end"]) &&
                  Number.isInteger(segment.index) &&
                  segment.index > 0 &&
                  segment.index < element.points.length &&
                  pair(segment.start) &&
                  pair(segment.end),
              )),
        );
      }
    }
    if (element.type === "freedraw") {
      check(
        Array.isArray(element.pressures) &&
          element.pressures.every(
            (pressure: unknown) =>
              typeof pressure === "number" && pressure >= 0 && pressure <= 1,
          ) &&
          typeof element.simulatePressure === "boolean",
      );
    }
    if (element.type === "line") {
      check(typeof element.polygon === "boolean");
    }
    if (element.type === "image") {
      check(
        nullableID(element.fileId) &&
          ["pending", "saved", "error"].includes(element.status) &&
          pair(element.scale) &&
          element.scale.every((v: number) => Math.abs(v) === 1),
      );
      check(
        element.crop === null ||
          (element.crop &&
            fields(element.crop, [
              "x",
              "y",
              "width",
              "height",
              "naturalWidth",
              "naturalHeight",
            ]) &&
            [
              "x",
              "y",
              "width",
              "height",
              "naturalWidth",
              "naturalHeight",
            ].every((key) => typeof element.crop[key] === "number") &&
            element.crop.width > 0 &&
            element.crop.height > 0 &&
            element.crop.naturalWidth > 0 &&
            element.crop.naturalHeight > 0),
      );
    }
    if (["frame", "magicframe"].includes(element.type)) {
      check(element.name === null || typeof element.name === "string");
    }
  }
  const target = (id: string, owner: any) => {
    const element = ids.get(id);
    check(
      element &&
        !element.isDeleted &&
        !owner.isDeleted &&
        element.id !== owner.id,
    );
    return element;
  };
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    if (element.frameId) {
      const frame = target(element.frameId, element);
      check(["frame", "magicframe"].includes(frame.type) && !frame.frameId);
    }
    if (element.type === "text" && element.containerId) {
      const container = target(element.containerId, element);
      check(
        ["rectangle", "ellipse", "diamond", "arrow"].includes(container.type) &&
          container.boundElements?.some(
            (edge: any) => edge.id === element.id && edge.type === "text",
          ),
      );
    }
    for (const edge of element.boundElements || []) {
      const bound = target(edge.id, element);
      check(bound.type === edge.type);
      check(
        edge.type === "text"
          ? bound.containerId === element.id
          : [
              bound.startBinding?.elementId,
              bound.endBinding?.elementId,
            ].includes(element.id),
      );
    }
    if (element.type === "arrow" || element.type === "line") {
      for (const binding of [element.startBinding, element.endBinding]) {
        if (binding) {
          const endpoint = target(binding.elementId, element);
          check(
            isBindableElement(endpoint, true) &&
              endpoint.boundElements?.some(
                (edge: any) => edge.id === element.id && edge.type === "arrow",
              ),
          );
        }
      }
    }
  }
  validateFractionalIndices(elements, {
    shouldThrow: true,
    includeBoundTextValidation: true,
    ignoreLogs: true,
  });
}

/** Called only by the shared private-replica preparation owner. */
export const importSceneElements = (scene: Scene, input: unknown): string[] => {
  const value = input as SceneImportInput;
  check(
    value &&
      value.scene &&
      value.scene.type === "excalidraw" &&
      value.scene.version === 2,
  );
  check(
    !("files" in value.scene) &&
      value.targetFileIDs &&
      Object.getPrototypeOf(value.targetFileIDs) === Object.prototype,
  );
  validateImportElements(value.scene.elements);
  validateImportElements(scene.getElementsIncludingDeleted());
  const elements = value.scene.elements.filter((element) => !element.isDeleted);
  check(elements.length > 0);
  const files = new Set(
    elements.flatMap((element) =>
      element.type === "image" && element.fileId ? [element.fileId] : [],
    ),
  );
  check(
    elements.every((element) => element.type !== "image" || element.fileId),
  );
  check(Object.keys(value.targetFileIDs).length === files.size);
  for (const id of files) {
    check(Object.prototype.hasOwnProperty.call(value.targetFileIDs, id));
    const locator = validateAssetLocator(id, value.targetFileIDs[id]);
    check(
      !/^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:data|blob|file):)/i.test(
        locator.trim(),
      ),
    );
  }
  const occupied = new Set<string>();
  for (const element of [
    ...scene.getElementsIncludingDeleted(),
    ...value.scene.elements,
  ]) {
    occupied.add(element.id);
    element.groupIds.forEach((id) => occupied.add(id));
    if (element.type === "image" && element.fileId) {
      occupied.add(element.fileId);
    }
  }
  Object.keys(scene.getAssetLocators()).forEach((id) => occupied.add(id));
  let duplicated: ExcalidrawElement[];
  // Regenerate the whole canonical mapping on a collision, before any writes.
  while (true) {
    const duplication = duplicateElements({
      type: "everything",
      elements,
      preserveFrameChildrenOrder: true,
    });
    duplicated = duplication.duplicatedElements;
    const generated = new Set<string>();
    let collision = false;
    for (const element of duplicated) {
      if (occupied.has(element.id) || generated.has(element.id)) {
        collision = true;
      }
      generated.add(element.id);
      for (const group of element.groupIds) {
        if (occupied.has(group)) {
          collision = true;
        }
      }
    }
    if (collision) {
      continue;
    }
    const groupMap = new Map<string, string>();
    for (const original of elements) {
      const copy = duplication.duplicateElementsMap.get(
        duplication.origIdToDuplicateId.get(original.id)!,
      )!;
      original.groupIds.forEach((id, index) =>
        groupMap.set(id, copy.groupIds[index]),
      );
    }
    for (const group of groupMap.values()) {
      if (generated.has(group)) {
        collision = true;
      }
      generated.add(group);
    }
    if (!collision) {
      break;
    }
  }
  duplicated.forEach((element) => {
    occupied.add(element.id);
    element.groupIds.forEach((id) => occupied.add(id));
  });
  const fileMap = new Map<string, FileId>();
  const locators: Record<string, string> = {};
  for (const id of files) {
    let fresh: string;
    do {
      fresh = randomId();
    } while (occupied.has(fresh));
    occupied.add(fresh);
    fileMap.set(id, fresh as FileId);
    locators[fresh] = value.targetFileIDs[id];
  }
  const imported = duplicated.map((element) =>
    element.type === "image"
      ? { ...element, fileId: fileMap.get(element.fileId!)! }
      : element,
  );
  scene.insertElementsAtIndex(imported, null);
  scene.setAssetLocators(locators);
  return imported.map((element) => element.id);
};
