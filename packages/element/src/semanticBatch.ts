import * as Y from "yjs";

import { pointFrom } from "@excalidraw-yjs/math";

import { bindBindingElement, updateBoundElements } from "./binding";
import { getCommonBounds } from "./bounds";
import {
  planElementDeletion,
  repairBindingsAfterDeletion,
} from "./deleteElements";
import { newArrowElement, newElement, newTextElement } from "./newElement";
import { Scene } from "./Scene";
import { getBoundTextElement, redrawTextBoundingBox } from "./textElement";
import { normalizeText, withTextMetricsProvider } from "./textMeasurements";
import {
  isBindableElement,
  isExcalidrawElement,
  isFrameLikeElement,
  isTextBindableContainer,
  isTextElement,
} from "./typeChecks";
import { captureElementBase } from "./yjs/intent";

import type { TextMetricsProvider } from "./textMeasurements";
import type { ExcalidrawTextElement, ExcalidrawTextContainer } from "./types";

type Placement = { x?: number; y?: number; width?: number; height?: number };
export type SemanticOperation =
  | ({
      op: "addShape";
      shape: "rectangle" | "ellipse" | "diamond";
      label?: string;
      fillColor?: string;
      strokeColor?: string;
    } & Placement)
  | ({
      op: "addText";
      text: string;
      fontSize?: number;
      strokeColor?: string;
    } & Placement)
  | { op: "connect"; fromId: string; toId: string; arrowLabel?: string }
  | { op: "setText"; elementId: string; text: string }
  | { op: "remove"; elementId: string };

export type SemanticBatchResult =
  | {
      ok: true;
      update: Uint8Array;
      addedElementIds: string[];
      summary: Array<{ op: SemanticOperation["op"]; elementIds: string[] }>;
    }
  | {
      ok: false;
      error: {
        category: "invalid-operation" | "invalid-scene" | "semantic-failure";
        operationIndex?: number;
      };
    };

class InvalidOperation extends Error {}

const requireCondition: (condition: unknown) => asserts condition = (
  condition,
) => {
  if (!condition) {
    throw new InvalidOperation();
  }
};

const finiteTree = (value: unknown): boolean => {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(finiteTree);
  }
  if (value && typeof value === "object") {
    return Object.values(value).every(finiteTree);
  }
  return true;
};

const validateScene = (doc: Y.Doc) => {
  for (const [id, value] of doc.getMap("elements")) {
    if (!(value instanceof Y.Map)) {
      throw new Error("invalid element map");
    }
    const element = value.toJSON();
    if (
      element.id !== id ||
      typeof element.backgroundColor !== "string" ||
      typeof element.strokeColor !== "string" ||
      !isExcalidrawElement({ type: element.type }) ||
      !finiteTree(element) ||
      !["x", "y", "width", "height", "angle"].every(
        (key) => typeof element[key] === "number",
      ) ||
      typeof element.isDeleted !== "boolean" ||
      !Array.isArray(element.groupIds) ||
      !element.groupIds.every((group: unknown) => typeof group === "string") ||
      (value.get("boundElements") !== undefined &&
        !(value.get("boundElements") instanceof Y.Map)) ||
      (element.type === "text" &&
        (typeof element.text !== "string" ||
          typeof element.originalText !== "string" ||
          typeof element.fontSize !== "number" ||
          element.fontSize <= 0 ||
          typeof element.fontFamily !== "number" ||
          typeof element.lineHeight !== "number" ||
          element.lineHeight <= 0)) ||
      (["arrow", "line", "freedraw"].includes(element.type) &&
        (!Array.isArray(element.points) ||
          !element.points.every(
            (point: unknown) =>
              Array.isArray(point) &&
              point.length === 2 &&
              point.every((coordinate) => typeof coordinate === "number"),
          )))
    ) {
      throw new Error("invalid element");
    }
  }
};

/**
 * Prepare exactly once on a lineage-preserving private replica. The caller owns
 * publication; neither successful preparation nor failure writes to its doc.
 * Only the captured update may be replayed, never the semantic invocation.
 */
export const prepareSemanticBatch = (
  doc: Y.Doc,
  operations: readonly SemanticOperation[],
  options: { textMetricsProvider: TextMetricsProvider },
): SemanticBatchResult => {
  const working = new Y.Doc();
  let scene: Scene | undefined;
  let operationIndex: number | undefined;
  let phase: "invalid-scene" | "semantic-failure" = "invalid-scene";
  try {
    Y.applyUpdate(working, Y.encodeStateAsUpdate(doc));
    validateScene(working);
    scene = new Scene(null, { doc: working });
    const privateScene = scene;
    const captured: Uint8Array[] = [];
    working.on("update", (update: Uint8Array) => captured.push(update));
    phase = "semantic-failure";
    return withTextMetricsProvider(options.textMetricsProvider, () => {
      requireCondition(Array.isArray(operations) && operations.length > 0);
      const addedElementIds: string[] = [];
      const summary: Array<{
        op: SemanticOperation["op"];
        elementIds: string[];
      }> = [];
      const live = privateScene.getNonDeletedElements();
      const [minX, , , maxY] = live.length
        ? getCommonBounds(live)
        : [0, 0, 0, -100];
      const cursor = { x: minX, y: maxY + 100, rowHeight: 0 };
      const place = (op: Placement, width: number, height: number) => {
        if (op.x !== undefined && op.y !== undefined) {
          return { x: op.x, y: op.y };
        }
        if (cursor.x > minX && cursor.x - minX + width > 1200) {
          cursor.x = minX;
          cursor.y += cursor.rowHeight + 40;
          cursor.rowHeight = 0;
        }
        const position = { x: cursor.x, y: cursor.y };
        cursor.x += width + 40;
        cursor.rowHeight = Math.max(cursor.rowHeight, height);
        return position;
      };
      const get = (id: string) => {
        requireCondition(typeof id === "string" && id.length > 0);
        const element = privateScene.getNonDeletedElementsMap().get(id);
        requireCondition(element);
        return element;
      };
      const setLabel = (container: ExcalidrawTextContainer, text: string) => {
        let label: ExcalidrawTextElement | null = getBoundTextElement(
          container,
          privateScene.getNonDeletedElementsMap(),
        );
        if (!label) {
          label = newTextElement({
            x: container.x,
            y: container.y,
            text,
            textAlign: "center",
            verticalAlign: "middle",
            containerId: container.id,
            strokeColor: container.strokeColor,
          });
          privateScene.insertElement(label);
          addedElementIds.push(label.id);
          privateScene.mutateElement(container, {
            boundElements: [
              ...(container.boundElements || []),
              { id: label.id, type: "text" },
            ],
          });
        } else {
          privateScene.mutateElement(label, {
            text: normalizeText(text),
            originalText: normalizeText(text),
          });
          label = privateScene.getElement(label.id)! as typeof label;
        }
        redrawTextBoundingBox(
          label,
          privateScene.getElement(container.id),
          privateScene,
        );
        updateBoundElements(
          privateScene.getElement(container.id)!,
          privateScene,
        );
      };
      operations.forEach((op, index) => {
        operationIndex = index;
        requireCondition(op && typeof op === "object" && finiteTree(op));
        if (op.op === "addShape" || op.op === "addText") {
          requireCondition(
            [op.x, op.y, op.width, op.height].every(
              (value) => value === undefined || typeof value === "number",
            ),
          );
          requireCondition(
            op.strokeColor === undefined || typeof op.strokeColor === "string",
          );
        }
        const operationIds: string[] = [];
        switch (op.op) {
          case "addShape": {
            requireCondition(
              ["rectangle", "ellipse", "diamond"].includes(op.shape),
            );
            const width = op.width ?? 200;
            const height = op.height ?? 100;
            requireCondition(
              typeof width === "number" &&
                width > 0 &&
                typeof height === "number" &&
                height > 0,
            );
            const shape = newElement({
              type: op.shape,
              ...place(op, width, height),
              width,
              height,
              backgroundColor: op.fillColor,
              strokeColor: op.strokeColor,
            });
            privateScene.insertElement(shape);
            addedElementIds.push(shape.id);
            operationIds.push(shape.id);
            if (op.label !== undefined) {
              requireCondition(typeof op.label === "string");
              if (op.label.trim()) {
                requireCondition(isTextBindableContainer(shape));
                setLabel(shape, op.label);
              }
            }
            break;
          }
          case "addText": {
            requireCondition(
              typeof op.text === "string" && op.text.trim().length > 0,
            );
            requireCondition(
              op.fontSize === undefined ||
                (typeof op.fontSize === "number" && op.fontSize > 0),
            );
            let text = newTextElement({
              x: 0,
              y: 0,
              text: op.text,
              fontSize: op.fontSize,
              strokeColor: op.strokeColor,
            });
            text = { ...text, ...place(op, text.width, text.height) };
            privateScene.insertElement(text);
            addedElementIds.push(text.id);
            operationIds.push(text.id);
            break;
          }
          case "connect": {
            const from = get(op.fromId);
            const to = get(op.toId);
            requireCondition(isBindableElement(from) && isBindableElement(to));
            const x = from.x + from.width / 2;
            const y = from.y + from.height / 2;
            const dx = to.x + to.width / 2 - x;
            const dy = to.y + to.height / 2 - y;
            const arrow = newArrowElement({
              type: "arrow",
              x,
              y,
              width: Math.abs(dx),
              height: Math.abs(dy),
              points: [pointFrom(0, 0), pointFrom(dx, dy)],
              endArrowhead: "arrow",
            });
            privateScene.insertElement(arrow);
            bindBindingElement(arrow, from, "orbit", "start", privateScene);
            bindBindingElement(
              privateScene.getElement(arrow.id)! as typeof arrow,
              get(to.id) as typeof to,
              "orbit",
              "end",
              privateScene,
            );
            addedElementIds.push(arrow.id);
            operationIds.push(arrow.id);
            if (op.arrowLabel !== undefined) {
              requireCondition(typeof op.arrowLabel === "string");
              if (op.arrowLabel.trim()) {
                setLabel(
                  privateScene.getElement(arrow.id)! as typeof arrow,
                  op.arrowLabel,
                );
              }
            }
            break;
          }
          case "setText": {
            requireCondition(
              typeof op.text === "string" && op.text.trim().length > 0,
            );
            const target = get(op.elementId);
            if (isTextElement(target)) {
              privateScene.mutateElement(target, {
                text: normalizeText(op.text),
                originalText: normalizeText(op.text),
              });
              const current = privateScene.getElement(
                target.id,
              )! as typeof target;
              const container = current.containerId
                ? get(current.containerId)
                : null;
              redrawTextBoundingBox(current, container, privateScene);
              if (container) {
                updateBoundElements(
                  privateScene.getElement(container.id)!,
                  privateScene,
                );
              }
            } else {
              requireCondition(isTextBindableContainer(target));
              setLabel(target, op.text);
            }
            operationIds.push(target.id);
            break;
          }
          case "remove": {
            const target = get(op.elementId);
            const base = privateScene.getElementsIncludingDeleted();
            const invocationBase = captureElementBase(base);
            const deletion = planElementDeletion(
              base,
              { [target.id]: true },
              new Set(isFrameLikeElement(target) ? [target.id] : []),
              privateScene,
            );
            repairBindingsAfterDeletion(deletion.elements);
            privateScene.applyElementChanges(invocationBase, deletion.elements);
            operationIds.push(target.id);
            break;
          }
          default:
            throw new InvalidOperation();
        }
        summary.push({ op: op.op, elementIds: operationIds });
      });
      validateScene(working);
      return {
        ok: true,
        update: Y.mergeUpdates(captured),
        addedElementIds,
        summary,
      };
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        category:
          error instanceof InvalidOperation ? "invalid-operation" : phase,
        ...(operationIndex === undefined ? {} : { operationIndex }),
      },
    };
  } finally {
    if (scene) {
      scene.destroy();
    } else {
      working.destroy();
    }
  }
};
