import assert from "node:assert/strict";

import * as Y from "yjs";
import * as common from "@excalidraw-yjs/common";

import * as headless from "../headless";
import { Scene } from "../Scene";
import { newElement } from "../newElement";
import { bindBindingElement } from "../binding";
import { moveAllLeft } from "../zindex";
import { deepCopyElement } from "../duplicate";
import { setCustomTextMetricsProvider } from "../textMeasurements";
import { getDefaultAppState } from "../../../excalidraw/appState";
import { serializeAsJSON } from "../../../excalidraw/data/json";
import {
  sceneImportFixture,
  assertSceneImport,
} from "../../../../scripts/scene-import-fixture.cjs";

import type { ExcalidrawRectangleElement } from "../types";

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

it.each(["index", "boundElements", "identity", "map", "geometry", "asset"])(
  "rejects malformed raw destination %s before Scene can normalize it",
  (key) => {
    const doc = new Y.Doc();
    const scene = new Scene(null, { doc });
    scene.insertElement(newElement({ type: "rectangle", x: 0, y: 0 }));
    const id = scene.getNonDeletedElements()[0].id;
    const raw = new Y.Doc();
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(doc));
    scene.destroy();
    const element = raw.getMap<Y.Map<unknown>>("elements").get(id)!;
    if (key === "index") {
      element.set("index", "invalid");
    } else if (key === "boundElements") {
      element.set("boundElements", [{ id: "missing", type: "arrow" }]);
    } else if (key === "identity") {
      element.set("id", "different");
    } else if (key === "map") {
      raw.getMap("elements").set(id, { id });
    } else if (key === "geometry") {
      element.set("x", Infinity);
    } else {
      raw.getMap("files").set("existing-file", { locator: "unreadable" });
    }
    const before = Y.encodeStateAsUpdate(raw);
    const input = source();
    const original = JSON.stringify(input);
    const updates = vi.fn();
    raw.on("update", updates);
    expect(prepare(raw, input)).toEqual({
      ok: false,
      error: { category: "invalid-scene" },
    });
    expect(Y.encodeStateAsUpdate(raw)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    expect(updates).not.toHaveBeenCalled();
    raw.destroy();
  },
);

it.each(["delete-first", "bind-first"])(
  "preserves concurrent delete/bind remnants during unrelated import: %s",
  (order) => {
    const target = new Scene();
    target.doc.clientID = 101;
    const shape = newElement({
      type: "rectangle",
      x: 0,
      y: 0,
    }) as ExcalidrawRectangleElement;
    const arrow = headless.newArrowElement({
      type: "arrow",
      x: 100,
      y: 0,
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [100, 0],
      ] as any,
    });
    target.insertElementsAtIndex([shape, arrow], null);
    const peerDoc = new Y.Doc();
    peerDoc.clientID = 202;
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(target.doc));
    const peer = new Scene(null, { doc: peerDoc });
    try {
      const deletion = headless.prepareSemanticBatch(
        target.doc,
        [{ op: "remove", elementId: arrow.id }],
        { textMetricsProvider: metrics },
      );
      expect(deletion.ok).toBe(true);
      if (!deletion.ok) {
        throw new Error("deletion failed");
      }
      bindBindingElement(
        peer.getElement(arrow.id)! as typeof arrow,
        peer.getElement(shape.id)! as typeof shape,
        "orbit",
        "start",
        peer,
      );
      const binding = Y.encodeStateAsUpdate(peerDoc);
      const changes =
        order === "delete-first"
          ? [deletion.update, binding]
          : [binding, deletion.update];
      changes.forEach((update) => target.applyRemoteUpdate(update));
      peer.applyRemoteUpdate(deletion.update);
      expect(target.yElements.toJSON()).toEqual(peer.yElements.toJSON());
      expect(target.getElement(arrow.id)?.isDeleted).toBe(true);
      expect(target.getElement(shape.id)?.boundElements).toContainEqual({
        id: arrow.id,
        type: "arrow",
      });
      const existing = target.yElements.toJSON();
      const files = target.doc.getMap("files").toJSON();
      const appState = target.doc.getMap("appState").toJSON();
      const input = source();
      const original = JSON.stringify(input);
      const before = Y.encodeStateAsUpdate(target.doc);
      const result = prepare(target.doc, input);
      expect(result.ok).toBe(true);
      expect(Y.encodeStateAsUpdate(target.doc)).toEqual(before);
      expect(JSON.stringify(input)).toBe(original);
      const strictDoc = new Y.Doc();
      expect(
        prepare(strictDoc, {
          scene: {
            type: "excalidraw",
            version: 2,
            elements: target.getElementsIncludingDeleted(),
          },
          targetFileIDs: {},
        }),
      ).toEqual({ ok: false, error: { category: "invalid-scene" } });
      strictDoc.destroy();
      Y.applyUpdate(target.doc, result.update);
      for (const [id, record] of Object.entries(existing)) {
        expect(target.yElements.get(id)!.toJSON()).toEqual(record);
      }
      expect(target.doc.getMap("files").toJSON()).toEqual(files);
      expect(target.doc.getMap("appState").toJSON()).toEqual(appState);
      expect(target.getElementsIncludingDeleted()).toHaveLength(3);
      const once = Y.encodeStateAsUpdate(target.doc);
      Y.applyUpdate(target.doc, result.update);
      expect(Y.encodeStateAsUpdate(target.doc)).toEqual(once);
    } finally {
      peer.destroy();
      target.destroy();
    }
  },
);

it("preserves schema-supported extra destination scalars but rejects them in imported source", () => {
  const scene = new Scene();
  scene.insertElement(source().scene.elements[0]);
  const element = scene.getNonDeletedElements()[0];
  scene.mutateElement(element, { futureScalar: "retained" } as any);
  const existing = scene.yElements.toJSON();
  const before = Y.encodeStateAsUpdate(scene.doc);
  const input = source();
  const original = JSON.stringify(input);
  const result = prepare(scene.doc, input);
  expect(result.ok).toBe(true);
  expect(Y.encodeStateAsUpdate(scene.doc)).toEqual(before);
  expect(JSON.stringify(input)).toBe(original);
  const strictDoc = new Y.Doc();
  expect(
    prepare(strictDoc, {
      scene: {
        type: "excalidraw",
        version: 2,
        elements: scene.getElementsIncludingDeleted(),
      },
      targetFileIDs: {},
    }),
  ).toEqual({ ok: false, error: { category: "invalid-scene" } });
  strictDoc.destroy();
  Y.applyUpdate(scene.doc, result.update);
  expect(scene.yElements.get(element.id)!.toJSON()).toEqual(
    existing[element.id],
  );
  expect(scene.yElements.get(element.id)!.get("futureScalar")).toBe("retained");
  scene.destroy();
});

it.each([
  "https:evil.example/x",
  "https:/evil.example/x",
  // Deliberately invalid input verifies rejection of script URI schemes.
  // eslint-disable-next-line no-script-url
  "javascript:alert(1)",
  "mailto:a@b",
  "urn:example:asset",
  "custom+v1.foo-bar:asset",
  "  HtTpS:evil.example/x  ",
  "\thttps:evil.example/x\n",
  "https://example.com/x",
  "//example.com/x",
  "  //example.com/x  ",
  "data:image/png;base64,secret",
  "blob:asset",
  "file:/asset",
])(
  "rejects scheme or protocol-relative import locator %j without writes",
  (locator) => {
    const fixture = sceneImportFixture(headless);
    const doc = new Y.Doc();
    const input = {
      scene: {
        type: "excalidraw",
        version: 2,
        elements: fixture.getElementsIncludingDeleted(),
      },
      targetFileIDs: { "source-image": locator },
    };
    const before = Y.encodeStateAsUpdate(doc);
    const original = JSON.stringify(input);
    const updates = vi.fn();
    doc.on("update", updates);
    expect(prepare(doc, input)).toEqual({
      ok: false,
      error: { category: "invalid-scene" },
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    expect(updates).not.toHaveBeenCalled();
    fixture.destroy();
    doc.destroy();
  },
);

it.each([
  "11111111-1111-4111-8111-111111111111",
  "target-logical-file",
  "asset_1.2-3",
])("preserves ordinary logical import locator %j", (locator) => {
  const fixture = sceneImportFixture(headless);
  const doc = new Y.Doc();
  const result = prepare(doc, {
    scene: {
      type: "excalidraw",
      version: 2,
      elements: fixture.getElementsIncludingDeleted(),
    },
    targetFileIDs: { "source-image": locator },
  });
  expect(result.ok).toBe(true);
  Y.applyUpdate(doc, result.update);
  expect(Object.values(doc.getMap("files").toJSON())).toEqual([locator]);
  fixture.destroy();
  doc.destroy();
});

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

it.each(["no-peer", "import-first", "peer-first"])(
  "preserves ordinary concurrent target appends and canonical send-to-back: %s",
  (order) => {
    const target = new Scene();
    target.doc.clientID = 101;
    const append = new Scene();
    append.doc.clientID = 202;
    target.insertElement(newElement({ type: "rectangle", x: 100, y: 0 }));
    append.insertElement(newElement({ type: "rectangle", x: 200, y: 0 }));
    target.applyRemoteUpdate(Y.encodeStateAsUpdate(append.doc));
    const existing = target.yElements.toJSON();
    const tied = target.getNonDeletedElements();
    expect(tied.map(({ index }) => index)).toEqual(["a0", "a0"]);
    const fixture = sceneImportFixture(headless);
    const input = {
      scene: JSON.parse(
        serializeAsJSON(fixture.getNonDeletedElements(), {}, {}, "database"),
      ),
      targetFileIDs: { "source-image": "logical-target-file" },
    };
    const original = JSON.stringify(input);
    const sourceBefore = Y.encodeStateAsUpdate(fixture.doc);
    const base = Y.encodeStateAsUpdate(target.doc);
    const on = Y.Doc.prototype.on;
    // Set the private replica's client before capture and before its first write.
    // A higher import client makes competing old-owner writes win deterministically.
    const capture = vi
      .spyOn(Y.Doc.prototype, "on")
      .mockImplementation(function (
        this: Y.Doc,
        ...args: Parameters<typeof on>
      ) {
        if (args[0] === "update") {
          this.clientID = 404;
        }
        return on.apply(this, args);
      });
    let result;
    try {
      result = prepare(target.doc, input);
    } finally {
      capture.mockRestore();
    }
    expect(result.ok).toBe(true);
    expect(Y.encodeStateAsUpdate(target.doc)).toEqual(base);
    expect(Y.encodeStateAsUpdate(fixture.doc)).toEqual(sourceBefore);
    expect(JSON.stringify(input)).toBe(original);
    const peerDoc = new Y.Doc();
    peerDoc.clientID = 303;
    Y.applyUpdate(peerDoc, base);
    const peer = new Scene(null, { doc: peerDoc });
    try {
      if (order === "no-peer") {
        Y.applyUpdate(target.doc, result.update);
        for (const [id, record] of Object.entries(existing)) {
          expect(target.yElements.get(id)!.toJSON()).toEqual(record);
        }
      } else {
        const elements = peer.getElementsIncludingDeleted();
        const selected = elements[1].id;
        peer.applyElementChanges(
          elements,
          moveAllLeft(elements.map(deepCopyElement), {
            ...getDefaultAppState(),
            width: 1000,
            height: 800,
            offsetTop: 0,
            offsetLeft: 0,
            selectedElementIds: { [selected]: true },
          }),
        );
        const sentBack = peer.yElements.get(selected)!.get("index");
        expect(sentBack).toBe("Zz");
        const reorder = Y.encodeStateAsUpdate(
          peerDoc,
          Y.encodeStateVectorFromUpdate(base),
        );
        const updates =
          order === "import-first"
            ? [result.update, reorder]
            : [reorder, result.update];
        updates.forEach((update) => Y.applyUpdate(target.doc, update));
        expect(target.yElements.get(selected)!.get("index")).toBe(sentBack);
        Y.applyUpdate(peerDoc, result.update);
        expect(target.yElements.toJSON()).toEqual(peer.yElements.toJSON());
      }
      const imported = result.addedElementIds.map((id: string) =>
        target.getElement(id),
      );
      const sourceElements = input.scene.elements;
      const idMap = new Map<string, string>(
        sourceElements.map((element: any, index: number) => [
          element.id,
          imported[index].id,
        ]),
      );
      expect(
        target
          .getNonDeletedElements()
          .slice(2)
          .map(({ id }) => id),
      ).toEqual(result.addedElementIds);
      const groups = new Map<string, string>();
      imported.forEach((element: any, index: number) => {
        const original = sourceElements[index];
        expect(idMap.has(element.id)).toBe(false);
        expect(element.index > tied[1].index!).toBe(true);
        expect([element.type, element.x, element.y]).toEqual([
          original.type,
          original.x,
          original.y,
        ]);
        expect(element.frameId).toBe(idMap.get(original.frameId) ?? null);
        if (original.boundElements) {
          expect(element.boundElements).toHaveLength(
            original.boundElements.length,
          );
          expect(element.boundElements).toEqual(
            expect.arrayContaining(
              original.boundElements.map((edge: any) => ({
                ...edge,
                id: idMap.get(edge.id),
              })),
            ),
          );
        } else {
          expect(element.boundElements).toBeNull();
        }
        if (element.type === "text") {
          expect(element.containerId).toBe(
            idMap.get(original.containerId) ?? null,
          );
        }
        if (element.type === "arrow") {
          for (const key of ["startBinding", "endBinding"]) {
            expect(element[key]).toEqual({
              ...original[key],
              elementId: idMap.get(original[key].elementId),
            });
          }
        }
        original.groupIds.forEach((group: string, index: number) => {
          expect(element.groupIds[index]).not.toBe(group);
          if (!groups.has(group)) {
            groups.set(group, element.groupIds[index]);
          }
          expect(element.groupIds[index]).toBe(groups.get(group));
        });
        if (element.type === "image") {
          expect(element.fileId).not.toBe(original.fileId);
          expect(target.getAssetLocators()[element.fileId]).toBe(
            input.targetFileIDs["source-image"],
          );
        }
      });
      const once = Y.encodeStateAsUpdate(target.doc);
      Y.applyUpdate(target.doc, result.update);
      expect(Y.encodeStateAsUpdate(target.doc)).toEqual(once);
    } finally {
      peer.destroy();
      fixture.destroy();
      append.destroy();
      target.destroy();
    }
  },
);

it("assigns imported order keys after the destination's deleted tail", () => {
  const target = new Scene();
  target.insertElementsAtIndex(
    [0, 100].map((x) => newElement({ type: "rectangle", x, y: 0 })),
    null,
  );
  const tail = target.getNonDeletedElements()[1];
  target.mutateElement(tail, { isDeleted: true });
  const existing = target.yElements.toJSON();
  const result = prepare(target.doc, source());
  expect(result.ok).toBe(true);
  Y.applyUpdate(target.doc, result.update);
  expect(
    target.getElement(result.addedElementIds[0])!.index! > tail.index!,
  ).toBe(true);
  for (const [id, record] of Object.entries(existing)) {
    expect(target.yElements.get(id)!.toJSON()).toEqual(record);
  }
  target.destroy();
});

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

it.each(["fragmented", "group-first", "group-last"])(
  "preserves exported stacking for a %s group through preparation and replay",
  (kind) => {
    const sourceScene = new Scene();
    const peer = new Scene();
    const target = new Y.Doc();
    const targetScene = new Scene(null, { doc: target });
    try {
      const shapes = ["A", "B", "C"].map((id) => ({
        ...newElement({
          type: "rectangle",
          x: 10,
          y: 20,
          width: 100,
          height: 80,
          backgroundColor: { A: "red", B: "green", C: "blue" }[id],
          fillStyle: "solid",
          groupIds: id === "B" ? [] : ["G"],
        }),
        id,
      }));
      const [a, b, c] = shapes;
      if (kind === "fragmented") {
        sourceScene.insertElementsAtIndex([a, c], null);
        peer.insertElement(b);
        Y.applyUpdate(sourceScene.doc, Y.encodeStateAsUpdate(peer.doc));
      } else {
        sourceScene.insertElementsAtIndex(
          kind === "group-first" ? [a, c, b] : [b, a, c],
          null,
        );
      }
      const sourceElements = sourceScene.getNonDeletedElements();
      const order =
        kind === "fragmented"
          ? ["A", "B", "C"]
          : kind === "group-first"
          ? ["A", "C", "B"]
          : ["B", "A", "C"];
      expect(sourceElements.map((element) => element.id)).toEqual(order);
      if (kind === "fragmented") {
        expect(sourceElements.map((element) => element.index)).toEqual([
          "a0",
          "a0",
          "a1",
        ]);
      }
      const exported = JSON.parse(
        serializeAsJSON(sourceElements, {}, {}, "database"),
      );
      expect(exported.elements).toEqual(sourceElements);
      const input = { scene: exported, targetFileIDs: {} };
      const original = JSON.stringify(input);
      const sourceBefore = Y.encodeStateAsUpdate(sourceScene.doc);
      targetScene.insertElement(
        newElement({ type: "rectangle", x: -100, y: 0 }),
      );
      const existing = targetScene.getNonDeletedElements()[0];
      const targetBefore = Y.encodeStateAsUpdate(target);
      const result = prepare(target, input);
      expect(result.ok).toBe(true);
      expect(Y.encodeStateAsUpdate(target)).toEqual(targetBefore);
      Y.applyUpdate(target, result.update);
      const elements = targetScene.getNonDeletedElements();
      const imported = elements.slice(1);
      expect(elements[0]).toEqual(existing);
      const content = (items: typeof sourceElements) =>
        items.map(
          ({ id, index, groupIds, version, versionNonce, updated, ...rest }) =>
            rest,
        );
      expect(content(imported)).toEqual(content(sourceElements));
      expect(result.addedElementIds).toEqual(imported.map(({ id }) => id));
      expect(result.summary).toEqual([
        { op: "importScene", elementIds: result.addedElementIds },
      ]);
      const group = imported[order.indexOf("A")].groupIds;
      expect(group).toHaveLength(1);
      expect(group).not.toContain("G");
      expect(imported[order.indexOf("C")].groupIds).toEqual(group);
      expect(imported[order.indexOf("B")].groupIds).toEqual([]);
      expect(new Set(elements.map(({ id }) => id)).size).toBe(4);
      expect(imported.every(({ id }) => !order.includes(id))).toBe(true);
      elements.slice(1).forEach((element, index) => {
        expect(element.index! > elements[index].index!).toBe(true);
      });
      const once = Y.encodeStateAsUpdate(target);
      Y.applyUpdate(target, result.update);
      expect(Y.encodeStateAsUpdate(target)).toEqual(once);
      expect(targetScene.getNonDeletedElements()).toEqual(elements);
      expect(JSON.stringify(input)).toBe(original);
      expect(Y.encodeStateAsUpdate(sourceScene.doc)).toEqual(sourceBefore);
      expect(sourceScene.getNonDeletedElements()).toEqual(sourceElements);
    } finally {
      targetScene.destroy();
      peer.destroy();
      sourceScene.destroy();
    }
  },
);

it.each(["source", "destination"])(
  "requires strict bound-text order only for imported source: %s",
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
    const result = prepare(doc, input);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(JSON.stringify(input)).toBe(original);
    if (location === "source") {
      expect(result).toEqual({
        ok: false,
        error: { category: "invalid-scene" },
      });
    } else {
      expect(result.ok).toBe(true);
      const existing = scene.yElements.toJSON();
      Y.applyUpdate(doc, result.update);
      for (const [id, record] of Object.entries(existing)) {
        expect(scene.yElements.get(id)!.toJSON()).toEqual(record);
      }
    }
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
  "requires strict $name geometry only for imported source: $location",
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
    if (valid || location === "destination") {
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
