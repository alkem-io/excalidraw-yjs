import * as Y from "yjs";

import { pointFrom } from "@excalidraw-yjs/math";

import * as core from "../packages/element/src/headless";
import { bundledFontFaces } from "../packages/excalidraw/fonts/bundledFontFaces";
import { actionDeleteSelected } from "../packages/excalidraw/actions/actionDeleteSelected";
import { getDefaultAppState } from "../packages/excalidraw/appState";

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
    op: "setText",
    elementId: "source",
    text: "A long label wraps over several lines and grows its container\n世界",
  },
  { op: "setText", elementId: "existing-text", text: "changed\nmultiline" },
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
  const from = scene.getElement("source")!;
  const to = scene.getElement("target")!;
  const arrow = core.newArrowElement({
    type: "arrow",
    x: 100,
    y: 50,
    width: 400,
    height: 0,
    points: [pointFrom(0, 0), pointFrom(400, 0)],
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
  label(scene.getElement(arrow.id)! as typeof arrow, "arrow label");
  label(
    scene.getElement("source")! as ExcalidrawTextContainer,
    "A long label wraps over several lines and grows its container\n世界",
  );
  const text = scene.getElement("existing-text")! as ExcalidrawTextElement;
  scene.mutateElement(text, {
    text: "changed\nmultiline",
    originalText: "changed\nmultiline",
  });
  core.redrawTextBoundingBox(
    scene.getElement(text.id)! as typeof text,
    null,
    scene,
  );
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

export { core, Y, bundledFontFaces };
