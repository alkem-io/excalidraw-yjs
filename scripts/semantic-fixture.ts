import * as Y from "yjs";

import { pointFrom } from "@excalidraw-yjs/math";

import * as core from "../packages/element/src/headless";
import { bundledFontFaces } from "../packages/excalidraw/fonts/bundledFontFaces";
import { actionDeleteSelected } from "../packages/excalidraw/actions/actionDeleteSelected";
import { getDefaultAppState } from "../packages/excalidraw/appState";
import { serializeAsJSON } from "../packages/excalidraw/data/json";

import { sceneImportFixture } from "./scene-import-fixture.cjs";

import type { SemanticOperation } from "../packages/element/src/semanticBatch";
import type {
  ExcalidrawTextContainer,
  ExcalidrawTextElement,
} from "../packages/element/src/types";

export const operations: SemanticOperation[] = [
  { op: "addShape", shape: "diamond", label: "héllo\n世界" },
  { op: "addText", text: "Καλημέρα\nПривет café", x: 10, y: 450 },
  {
    op: "connect",
    fromId: "source",
    toId: "target",
    arrowLabel: "arrow label",
  },
  {
    op: "connect",
    fromId: "existing-text",
    toId: "source",
    arrowLabel: "text start",
  },
  {
    op: "connect",
    fromId: "target",
    toId: "centered-text",
    arrowLabel: "text end",
  },
  {
    op: "setText",
    elementId: "source",
    text: "A long label wraps over several lines and grows its container\n世界",
  },
  { op: "setText", elementId: "existing-text", text: "changed\nmultiline" },
  { op: "setText", elementId: "centered-text", text: "changed\nmultiline" },
  { op: "setText", elementId: "right-text", text: "changed\nmultiline" },
  { op: "remove", elementId: "target" },
];

export const seed = () => {
  const scene = new core.Scene();
  for (const [id, x] of [
    ["source", 0],
    ["target", 400],
  ] as const) {
    scene.insertElement({
      ...core.newElement({
        type: "rectangle",
        x,
        y: 0,
        width: 200,
        height: 100,
      }),
      id,
    });
  }
  scene.insertElement({
    ...core.newTextElement({ text: "before", x: 0, y: 120 }),
    id: "existing-text",
  });
  for (const textAlign of ["center", "right"] as const) {
    scene.insertElement({
      ...core.newTextElement({
        text: "before",
        x: 100,
        y: 120,
        textAlign,
        verticalAlign: "middle",
      }),
      id: textAlign === "center" ? "centered-text" : "right-text",
    });
  }
  return scene;
};

// The browser oracle drives the existing editor owners, not the new batch API.
export const reference = () => {
  const scene = seed();
  const label = (container: ExcalidrawTextContainer, text: string) => {
    const bound = core.newTextElement({
      text,
      x: container.x,
      y: container.y,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: container.id,
      strokeColor: container.strokeColor,
    });
    scene.insertElement(bound);
    scene.mutateElement(container, {
      boundElements: [
        ...(container.boundElements || []),
        { id: bound.id, type: "text" },
      ],
    });
    core.redrawTextBoundingBox(bound, scene.getElement(container.id), scene);
    core.updateBoundElements(scene.getElement(container.id)!, scene);
  };
  const shape = core.newElement({
    type: "diamond",
    x: 0,
    y: 245,
    width: 200,
    height: 100,
  });
  scene.insertElement(shape);
  label(shape as ExcalidrawTextContainer, "héllo\n世界");
  scene.insertElement(
    core.newTextElement({ text: "Καλημέρα\nПривет café", x: 10, y: 450 }),
  );
  const connect = (fromId: string, toId: string, caption: string) => {
    const from = scene.getElement(fromId)!;
    const to = scene.getElement(toId)!;
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    const dx = to.x + to.width / 2 - x;
    const dy = to.y + to.height / 2 - y;
    const arrow = core.newArrowElement({
      type: "arrow",
      x,
      y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [pointFrom(0, 0), pointFrom(dx, dy)],
      endArrowhead: "arrow",
    });
    scene.insertElement(arrow);
    core.bindBindingElement(
      arrow,
      from as Parameters<typeof core.bindBindingElement>[1],
      "orbit",
      "start",
      scene,
    );
    core.bindBindingElement(
      scene.getElement(arrow.id)! as typeof arrow,
      to as Parameters<typeof core.bindBindingElement>[1],
      "orbit",
      "end",
      scene,
    );
    label(scene.getElement(arrow.id)! as typeof arrow, caption);
  };
  connect("source", "target", "arrow label");
  connect("existing-text", "source", "text start");
  connect("target", "centered-text", "text end");
  label(
    scene.getElement("source")! as ExcalidrawTextContainer,
    "A long label wraps over several lines and grows its container\n世界",
  );
  for (const id of ["existing-text", "centered-text", "right-text"]) {
    const text = scene.getElement(id)! as ExcalidrawTextElement;
    const replacement = "changed\nmultiline";
    scene.mutateElement(text, {
      originalText: replacement,
      ...core.refreshTextDimensions(
        text,
        null,
        scene.getElementsMapIncludingDeleted(),
        replacement,
      ),
    });
    core.updateBoundElements(
      scene.getNonDeletedElementsMap().get(text.id)!,
      scene,
    );
  }
  const base = scene.getElementsIncludingDeleted();
  const invocationBase = core.captureElementBase(base);
  const state = {
    ...getDefaultAppState(),
    selectedElementIds: { target: true },
  };
  const result = actionDeleteSelected.perform(base, state, null, {
    scene,
    state,
  } as Parameters<typeof actionDeleteSelected.perform>[3]);
  if (!result || result instanceof Promise || !result.elements) {
    throw new Error("delete action did not return elements");
  }
  scene.applyElementChanges(invocationBase, result.elements);
  return scene.getElementsIncludingDeleted();
};

export const widthCases = [
  { op: "addText", text: "Natural text", x: 31, y: 47, fontSize: 20 },
  ...[1, 60, 90, 190].map((width) => ({
    op: "addText",
    text: "Hello café Привет 世界 hello again\nand another long line",
    x: 31,
    y: 47,
    fontSize: 20,
    width,
  })),
] as const;

export const widthReference = () =>
  widthCases.map((operation) => {
    const scene = new core.Scene();
    const text = core.newTextElement(operation);
    scene.insertElement(text);
    if ("width" in operation) {
      core.resizeSingleTextElement(
        text,
        text,
        scene,
        "e",
        false,
        operation.width,
        text.height,
      );
    }
    const initial = JSON.parse(JSON.stringify(scene.getNonDeletedElements()));
    const current = scene.getElement(text.id)! as ExcalidrawTextElement;
    const replacement =
      "Changed text stays within its fixed width\nHello café 世界";
    scene.mutateElement(current, {
      originalText: replacement,
      ...core.refreshTextDimensions(
        current,
        null,
        scene.getNonDeletedElementsMap(),
        replacement,
      ),
    });
    return { initial, changed: scene.getNonDeletedElements() };
  });

export const importReference = () => {
  const source = sceneImportFixture(core);
  const exported = JSON.parse(
    serializeAsJSON(source.getElementsIncludingDeleted(), {}, {}, "database"),
  );
  const scene = new core.Scene();
  const duplicated = core.duplicateElements({
    type: "everything",
    elements: exported.elements,
    preserveFrameChildrenOrder: true,
  }).duplicatedElements;
  scene.insertElementsAtIndex(duplicated, null);
  return { exported, elements: scene.getNonDeletedElements() };
};

export { core, Y, bundledFontFaces };
