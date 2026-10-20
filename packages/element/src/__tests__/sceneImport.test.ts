import assert from "node:assert/strict";

import * as Y from "yjs";
import * as common from "@excalidraw-yjs/common";

import * as headless from "../headless";
import { Scene } from "../Scene";
import { newElement } from "../newElement";
import { setCustomTextMetricsProvider } from "../textMeasurements";
import { serializeAsJSON } from "../../../excalidraw/data/json";
import {
  sceneImportFixture,
  assertSceneImport,
} from "../../../../scripts/scene-import-fixture.cjs";

const metrics = { getLineWidth: (text: string) => text.length * 10 };
beforeEach(() => setCustomTextMetricsProvider(metrics));
const source = () => {
  const scene = new Scene();
  scene.insertElement(
    newElement({ type: "rectangle", x: 10, y: 20, width: 100, height: 80 }),
  );
  return {
    scene: {
      type: "excalidraw",
      version: 2,
      elements: scene.getElementsIncludingDeleted(),
    },
    targetFileIDs: {},
  };
};
const prepare = (doc: Y.Doc, input: unknown) =>
  (headless as any).prepareSceneImport(doc, input, {
    textMetricsProvider: metrics,
  });

it("imports fresh identities as replayable additive bytes without mutating either input", () => {
  const doc = new Y.Doc();
  const scene = new Scene(null, { doc });
  const input = source();
  scene.insertElement(input.scene.elements[0]);
  const before = Y.encodeStateAsUpdate(doc);
  const original = JSON.stringify(input);
  const result = prepare(doc, input);
  expect(result.ok).toBe(true);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  expect(JSON.stringify(input)).toBe(original);
  scene.mutateElement(scene.getElementsIncludingDeleted()[0], {
    strokeColor: "red",
  });
  Y.applyUpdate(doc, result.update);
  expect(scene.getNonDeletedElements()).toHaveLength(2);
  expect(scene.getNonDeletedElements()[0].strokeColor).toBe("red");
  expect(result.addedElementIds).not.toContain(input.scene.elements[0].id);
  const once = Y.encodeStateAsUpdate(doc);
  Y.applyUpdate(doc, result.update);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(once);
});

it("rejects an invalid last element without caller or source writes", () => {
  const doc = new Y.Doc();
  const input = source();
  input.scene.elements = [
    ...input.scene.elements,
    { ...input.scene.elements[0], id: "last", x: NaN },
  ];
  const before = Y.encodeStateAsUpdate(doc);
  const original = JSON.stringify(input);
  expect(prepare(doc, input)).toEqual({
    ok: false,
    error: { category: "invalid-scene" },
  });
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  expect(JSON.stringify(input)).toBe(original);
});

it("imports a representative editor export with a frame, group, bound labels, arrow, free draw and image", () => {
  const scene = sceneImportFixture(headless);
  const exported = JSON.parse(
    serializeAsJSON(scene.getElementsIncludingDeleted(), {}, {}, "database"),
  );
  const doc = new Y.Doc();
  const result = prepare(doc, {
    scene: exported,
    targetFileIDs: { "source-image": "target-logical-file" },
  });
  expect(result.ok).toBe(true);
  assertSceneImport(assert, headless, Y, metrics);
});

it.each([
  "dangling",
  "deleted",
  "duplicate",
  "legacy",
  "version",
  "media",
  "bytes",
  "url",
  "index",
  "unknown-field",
  "nested-field",
])("rejects malformed %s before any caller write", (kind) => {
  const scene = sceneImportFixture(headless);
  const elements = JSON.parse(
    JSON.stringify(scene.getElementsIncludingDeleted()),
  );
  const input = {
    scene: { type: "excalidraw", version: 2, elements },
    targetFileIDs: { "source-image": "target-logical-file" },
  };
  if (kind === "dangling") {
    elements.find((e: any) => e.type === "arrow").endBinding.elementId =
      "missing";
  }
  if (kind === "deleted") {
    elements.find((e: any) => e.type === "frame").isDeleted = true;
  }
  if (kind === "duplicate") {
    elements[elements.length - 1].id = elements[0].id;
  }
  if (kind === "legacy") {
    delete elements.find((e: any) => e.type === "text").originalText;
  }
  if (kind === "version") {
    input.scene.version = 1;
  }
  if (kind === "media") {
    input.targetFileIDs = {} as typeof input.targetFileIDs;
  }
  if (kind === "bytes") {
    input.targetFileIDs["source-image"] = "data:image/png;base64,secret";
  }
  if (kind === "url") {
    input.targetFileIDs["source-image"] = "https://example.com/image";
  }
  if (kind === "index") {
    elements[elements.length - 1].index = "invalid";
  }
  if (kind === "unknown-field") {
    elements[elements.length - 1].dataURL = "secret";
  }
  if (kind === "nested-field") {
    elements.find((e: any) => e.type === "arrow").endBinding.unrecognized =
      true;
  }
  const doc = new Y.Doc();
  const before = Y.encodeStateAsUpdate(doc);
  const original = JSON.stringify(input);
  expect(prepare(doc, input)).toEqual({
    ok: false,
    error: { category: "invalid-scene" },
  });
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  expect(JSON.stringify(input)).toBe(original);
});

it("rejects malformed destination text without repairing the caller", () => {
  const doc = new Y.Doc();
  const scene = new Scene(null, { doc });
  scene.insertElement(headless.newTextElement({ text: "valid", x: 0, y: 0 }));
  scene.yElements.values().next().value!.delete("originalText");
  const before = Y.encodeStateAsUpdate(doc);
  expect(prepare(doc, source())).toEqual({
    ok: false,
    error: { category: "invalid-scene" },
  });
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
});

it("regenerates a forced canonical fresh-ID collision before appending", () => {
  const input = source();
  const doc = new Y.Doc();
  const scene = new Scene(null, { doc });
  scene.insertElement(input.scene.elements[0]);
  const random = vi
    .spyOn(common, "randomId")
    .mockReturnValueOnce(input.scene.elements[0].id);
  try {
    const result = prepare(doc, input);
    expect(result.ok).toBe(true);
    expect(random.mock.calls.length).toBeGreaterThanOrEqual(2);
    Y.applyUpdate(doc, result.update);
    expect(scene.getNonDeletedElements()).toHaveLength(2);
    expect(result.addedElementIds[0]).not.toBe(input.scene.elements[0].id);
  } finally {
    random.mockRestore();
  }
});

it.each(["index", "boundElements"])(
  "rejects malformed raw destination %s before Scene can normalize it",
  (key) => {
    const doc = new Y.Doc();
    const scene = new Scene(null, { doc });
    scene.insertElement(newElement({ type: "rectangle", x: 0, y: 0 }));
    const element = scene.yElements.values().next().value!;
    if (key === "index") {
      element.set("index", "invalid");
    } else {
      const bound = new Y.Map();
      bound.set("missing", "arrow");
      element.set("boundElements", bound);
    }
    const before = Y.encodeStateAsUpdate(doc);
    expect(prepare(doc, source())).toMatchObject({
      ok: false,
      error: { category: "invalid-scene" },
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  },
);
