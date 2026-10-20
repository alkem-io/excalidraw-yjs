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

it.each(
  ["Data: customer events", "data: ready", "  DATA: reference"].flatMap(
    (text) => ["source", "destination"].map((location) => ({ text, location })),
  ),
)("preserves literal $text in $location text", ({ text, location }) => {
  const doc = new Y.Doc();
  const scene = new Scene(null, { doc });
  const input = source();
  if (location === "source") {
    const sourceScene = new Scene();
    sourceScene.insertElement(headless.newTextElement({ text, x: 0, y: 0 }));
    input.scene.elements = sourceScene.getElementsIncludingDeleted();
    sourceScene.destroy();
  } else {
    scene.insertElement(headless.newTextElement({ text, x: 0, y: 0 }));
  }
  const before = Y.encodeStateAsUpdate(doc);
  const original = JSON.stringify(input);
  const result = prepare(doc, input);
  expect(result.ok).toBe(true);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  expect(JSON.stringify(input)).toBe(original);
  Y.applyUpdate(doc, result.update);
  expect(
    scene.getNonDeletedElements().find((element) => element.type === "text"),
  ).toMatchObject({ text, originalText: text });
  scene.destroy();
});

it("retries a collision with a later grouped source before reading its missing mapping", () => {
  const input = source();
  const sourceScene = new Scene();
  sourceScene.insertElementsAtIndex(
    [
      { ...input.scene.elements[0], groupIds: ["group"] },
      { ...input.scene.elements[0], id: "later-source", groupIds: ["group"] },
    ],
    null,
  );
  input.scene.elements = sourceScene.getElementsIncludingDeleted();
  const doc = new Y.Doc();
  const before = Y.encodeStateAsUpdate(doc);
  const original = JSON.stringify(input);
  const random = vi
    .spyOn(common, "randomId")
    .mockReturnValueOnce("later-source");
  try {
    const result = prepare(doc, input);
    expect(result.ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    Y.applyUpdate(doc, result.update);
    const scene = new Scene(null, { doc });
    const elements = scene.getNonDeletedElements();
    expect(elements).toHaveLength(2);
    expect(new Set(elements.map((element) => element.id)).size).toBe(2);
    expect(elements[0].groupIds).toEqual(elements[1].groupIds);
    expect(elements[0].groupIds).not.toContain("group");
    scene.destroy();
  } finally {
    random.mockRestore();
    sourceScene.destroy();
    doc.destroy();
  }
});

it.each([
  "bound-label",
  "standalone-text",
  "locked-text",
  "missing-reciprocal",
])("validates canonical endpoint eligibility for %s", (kind) => {
  const sourceScene = sceneImportFixture(headless);
  const elements = JSON.parse(
    JSON.stringify(sourceScene.getElementsIncludingDeleted()),
  );
  const arrow = elements.find((element: any) => element.type === "arrow");
  const container = elements.find(
    (element: any) => element.id === arrow.startBinding.elementId,
  );
  const label = elements.find(
    (element: any) => element.containerId === container.id,
  );
  container.boundElements = container.boundElements.filter(
    (edge: any) => edge.id !== arrow.id,
  );
  arrow.startBinding.elementId = label.id;
  label.boundElements =
    kind === "missing-reciprocal" ? null : [{ id: arrow.id, type: "arrow" }];
  if (kind !== "bound-label") {
    label.containerId = null;
    container.boundElements = null;
  }
  label.locked = kind === "locked-text";
  const input = {
    scene: { type: "excalidraw", version: 2, elements },
    targetFileIDs: { "source-image": "target-logical-file" },
  };
  const doc = new Y.Doc();
  const before = Y.encodeStateAsUpdate(doc);
  const original = JSON.stringify(input);
  const result = prepare(doc, input);
  if (kind === "bound-label" || kind === "missing-reciprocal") {
    expect(result).toEqual({ ok: false, error: { category: "invalid-scene" } });
  } else {
    expect(result.ok).toBe(true);
  }
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  expect(JSON.stringify(input)).toBe(original);
  sourceScene.destroy();
  doc.destroy();
});

it.each([
  null,
  [],
  {},
  { status: "unknown" },
  { status: "error" },
  { status: "error", code: 1 },
  { status: "error", code: "error", message: { toString: 0 } },
  { status: "error", code: "error", message: null },
  { status: "done" },
  { status: "done", html: 1 },
])(
  "rejects malformed reserved iframe generation metadata %j atomically",
  (generationData) => {
    const input = source();
    input.scene.elements = [
      {
        ...input.scene.elements[0],
        type: "iframe",
        customData: { generationData },
      } as any,
    ];
    const doc = new Y.Doc();
    const before = Y.encodeStateAsUpdate(doc);
    const original = JSON.stringify(input);
    expect(prepare(doc, input)).toEqual({
      ok: false,
      error: { category: "invalid-scene" },
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    doc.destroy();
  },
);

it.each([
  {},
  { generationData: { status: "pending" } },
  { generationData: { status: "done", html: "<p>ready</p>" } },
  { generationData: { status: "error", code: "ERR_GENERATION_INTERRUPTED" } },
  {
    generationData: {
      status: "error",
      code: "custom",
      message: "Data: unavailable",
    },
  },
])(
  "preserves valid iframe metadata and unrelated custom fields %j",
  (reserved) => {
    const customData = { ...reserved, unrelated: { label: "ordinary" } };
    const input = source();
    input.scene.elements = [
      { ...input.scene.elements[0], type: "iframe", customData } as any,
    ];
    const doc = new Y.Doc();
    const result = prepare(doc, input);
    expect(result.ok).toBe(true);
    Y.applyUpdate(doc, result.update);
    const scene = new Scene(null, { doc });
    expect(scene.getElement(result.addedElementIds[0])?.customData).toEqual(
      customData,
    );
    scene.destroy();
  },
);

it.each(["self", "other-source"])(
  "keeps source local keys independent of trusted logical locators: %s",
  (kind) => {
    const sourceScene = sceneImportFixture(headless);
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const image = sourceScene
      .getNonDeletedElements()
      .find((element: any) => element.type === "image")!;
    sourceScene.mutateElement(image, { fileId: first } as any);
    sourceScene.insertElement({
      ...image,
      id: "second-image",
      fileId: second,
    } as any);
    const locator = kind === "self" ? first : second;
    const input = {
      scene: {
        type: "excalidraw",
        version: 2,
        elements: sourceScene.getElementsIncludingDeleted(),
      },
      targetFileIDs: { [first]: locator, [second]: first },
    };
    const doc = new Y.Doc();
    const before = Y.encodeStateAsUpdate(doc);
    const original = JSON.stringify(input);
    const result = prepare(doc, input);
    expect(result.ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    Y.applyUpdate(doc, result.update);
    const scene = new Scene(null, { doc });
    const images = scene
      .getNonDeletedElements()
      .filter((element) => element.type === "image");
    expect(images).toHaveLength(2);
    expect(
      images.every(
        (element) => element.fileId !== first && element.fileId !== second,
      ),
    ).toBe(true);
    expect(new Set(images.map((element) => element.fileId)).size).toBe(2);
    expect(Object.values(scene.getAssetLocators())).toEqual([locator, first]);
    const once = Y.encodeStateAsUpdate(doc);
    Y.applyUpdate(doc, result.update);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(once);
    scene.destroy();
    sourceScene.destroy();
  },
);

it.each(["empty", "nonempty", "editor-append"])(
  "imports after concurrent appends to a %s destination",
  (kind) => {
    const doc = new Y.Doc();
    const scene = new Scene(null, { doc });
    if (kind === "nonempty") {
      scene.insertElement(newElement({ type: "rectangle", x: -100, y: 0 }));
    }
    const input = source();
    const content = (elements: typeof input.scene.elements) =>
      elements.map(({ version, versionNonce, updated, ...element }) => element);
    const original = JSON.stringify(input);
    const base = Y.encodeStateAsUpdate(doc);
    const first = prepare(doc, input);
    expect(first.ok).toBe(true);
    let secondUpdate;
    if (kind === "editor-append") {
      scene.insertElement(newElement({ type: "rectangle", x: 200, y: 0 }));
      secondUpdate = Y.encodeStateAsUpdate(
        doc,
        Y.encodeStateVectorFromUpdate(base),
      );
    } else {
      const second = prepare(doc, input);
      expect(second.ok).toBe(true);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(base);
      secondUpdate = second.update;
    }
    Y.applyUpdate(doc, first.update);
    Y.applyUpdate(doc, secondUpdate);
    const merged = scene.getElementsIncludingDeleted();
    expect(new Set(merged.map((element) => element.index)).size).toBeLessThan(
      merged.length,
    );
    const reverse = new Y.Doc();
    Y.applyUpdate(reverse, base);
    Y.applyUpdate(reverse, secondUpdate);
    Y.applyUpdate(reverse, first.update);
    const reverseScene = new Scene(null, { doc: reverse });
    expect(content(reverseScene.getElementsIncludingDeleted())).toEqual(
      content(merged),
    );
    const before = Y.encodeStateAsUpdate(doc);
    const third = prepare(doc, input);
    expect(third.ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    Y.applyUpdate(doc, third.update);
    Y.applyUpdate(reverse, third.update);
    expect(content(reverseScene.getElementsIncludingDeleted())).toEqual(
      content(scene.getElementsIncludingDeleted()),
    );
    const once = Y.encodeStateAsUpdate(doc);
    Y.applyUpdate(doc, third.update);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(once);

    reverseScene.destroy();
    reverse.destroy();
    scene.destroy();
    doc.destroy();
  },
);

it("preserves array order from an actual editor export with merged tied keys", () => {
  const doc = new Y.Doc();
  const scene = new Scene(null, { doc });
  const peer = new Scene();
  scene.insertElement(newElement({ type: "rectangle", x: 100, y: 0 }));
  peer.insertElement(newElement({ type: "rectangle", x: 200, y: 0 }));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.doc));
  const merged = scene.getElementsIncludingDeleted();
  expect(merged[0].index).toBe(merged[1].index);
  const exported = JSON.parse(serializeAsJSON(merged, {}, {}, "database"));
  expect(exported.elements.map((element: any) => element.index)).toEqual(
    merged.map((element) => element.index),
  );
  const exportedInput = { scene: exported, targetFileIDs: {} };
  const exportedBefore = JSON.stringify(exportedInput);
  const target = new Y.Doc();
  const targetBefore = Y.encodeStateAsUpdate(target);
  const imported = prepare(target, exportedInput);
  expect(imported.ok).toBe(true);
  expect(Y.encodeStateAsUpdate(target)).toEqual(targetBefore);
  expect(JSON.stringify(exportedInput)).toBe(exportedBefore);
  Y.applyUpdate(target, imported.update);
  const targetScene = new Scene(null, { doc: target });
  expect(
    targetScene.getNonDeletedElements().map((element) => element.x),
  ).toEqual(merged.map((element) => element.x));
  targetScene.destroy();
  target.destroy();
  peer.destroy();
  scene.destroy();
  doc.destroy();
});

it.each(["source", "destination"])(
  "rejects bound text at its container key in the %s",
  (location) => {
    const fixture = sceneImportFixture(headless);
    const elements = JSON.parse(
      JSON.stringify(fixture.getElementsIncludingDeleted()),
    );
    const label = elements.find((element: any) => element.type === "text");
    const container = elements.find(
      (element: any) => element.id === label.containerId,
    );
    label.index = container.index;
    const doc = new Y.Doc();
    const scene = new Scene(null, { doc });
    const input =
      location === "source"
        ? {
            scene: { type: "excalidraw", version: 2, elements },
            targetFileIDs: { "source-image": "target-logical-file" },
          }
        : source();
    if (location === "destination") {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(fixture.doc));
      scene.yElements.get(label.id)!.set("index", container.index);
    }
    const before = Y.encodeStateAsUpdate(doc);
    const original = JSON.stringify(input);
    expect(prepare(doc, input)).toEqual({
      ok: false,
      error: { category: "invalid-scene" },
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    scene.destroy();
    fixture.destroy();
    doc.destroy();
  },
);

it.each(
  [
    {
      name: "diagonal elbow",
      elbowed: true,
      points: [
        [0, 0],
        [100, 100],
      ],
      valid: false,
    },
    {
      name: "orthogonal elbow",
      elbowed: true,
      points: [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      valid: true,
    },
    {
      name: "horizontal elbow",
      elbowed: true,
      points: [
        [0, 0],
        [100, 0],
      ],
      valid: true,
    },
    {
      name: "ordinary diagonal",
      elbowed: false,
      points: [
        [0, 0],
        [100, 100],
      ],
      valid: true,
    },
  ].flatMap((geometry) =>
    ["source", "destination"].map((location) => ({ ...geometry, location })),
  ),
)(
  "validates $name geometry in $location",
  ({ elbowed, points, valid, location }) => {
    const sourceScene = new Scene();
    sourceScene.insertElement(
      headless.newArrowElement({
        type: "arrow",
        x: 0,
        y: 0,
        width: 100,
        height: points[points.length - 1][1],
        points: points as any,
        elbowed,
        fixedSegments: [],
      } as any),
    );
    const input =
      location === "source"
        ? {
            scene: {
              type: "excalidraw",
              version: 2,
              elements: sourceScene.getElementsIncludingDeleted(),
            },
            targetFileIDs: {},
          }
        : source();
    const doc = new Y.Doc();
    if (location === "destination") {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(sourceScene.doc));
    }
    const before = Y.encodeStateAsUpdate(doc);
    const original = JSON.stringify(input);
    const updates = vi.fn();
    doc.on("update", updates);
    const result = prepare(doc, input);
    if (valid) {
      expect(result.ok).toBe(true);
    } else {
      expect(result).toEqual({
        ok: false,
        error: { category: "invalid-scene" },
      });
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    expect(updates).not.toHaveBeenCalled();
    sourceScene.destroy();
    doc.destroy();
  },
);
