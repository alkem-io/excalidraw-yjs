import * as Y from "yjs";

import * as headless from "../headless";
import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { setCustomTextMetricsProvider } from "../textMeasurements";

import type { ExcalidrawTextElement } from "../types";

// Geometry tests use the same deterministic provider as browser unit fixtures.
// Real font and browser comparisons run separately against built packages.
const metrics = { getLineWidth: (text: string) => text.length * 10 };

const seed = () => {
  const doc = new Y.Doc();
  const scene = new Scene(null, { doc });
  for (const [id, x] of [
    ["source", 0],
    ["target", 400],
  ] as const) {
    scene.insertElement({
      ...newElement({ type: "rectangle", x, y: 0, width: 200, height: 100 }),
      id,
    });
  }
  return { doc, scene };
};

const prepare = (...args: unknown[]) => {
  const api = headless as unknown as {
    prepareSemanticBatch: (...input: unknown[]) => {
      ok: boolean;
      update: Uint8Array;
      addedElementIds: string[];
      error?: { category: string; operationIndex?: number };
    };
  };
  return api.prepareSemanticBatch(...args);
};

const consume = (doc: Y.Doc, update: Uint8Array) => {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  Y.applyUpdate(replica, update);
  return new Scene(null, { doc: replica });
};

beforeEach(() => setCustomTextMetricsProvider(metrics));

describe("semantic preparation", () => {
  it("prepares multiline text and a bound label without touching input", () => {
    const { doc } = seed();
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on("update", updates);
    const result = prepare(
      doc,
      [
        { op: "addText", text: "héllo\n世界", x: 10, y: 200 },
        { op: "addShape", shape: "diamond", label: "bound\nlabel" },
      ],
      { textMetricsProvider: metrics },
    );
    expect(result.ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).not.toHaveBeenCalled();
    const scene = consume(doc, result.update);
    const added = result.addedElementIds.map((id) => scene.getElement(id)!);
    const standalone = added.find(
      (el) => el.type === "text" && !el.containerId,
    ) as ExcalidrawTextElement;
    expect(standalone).toMatchObject({
      text: "héllo\n世界",
      originalText: "héllo\n世界",
      width: 50,
    });
    const shape = added.find((el) => el.type === "diamond")!;
    const label = added.find(
      (el) => el.type === "text" && el.containerId === shape.id,
    )!;
    expect(shape.boundElements).toContainEqual({ id: label.id, type: "text" });
  });

  it("rejects a late-invalid operation without partial update or input writes", () => {
    const { doc } = seed();
    const before = Y.encodeStateAsUpdate(doc);
    const result = prepare(
      doc,
      [
        { op: "addText", text: "must not leak" },
        { op: "setText", elementId: "missing", text: "invalid" },
      ],
      { textMetricsProvider: metrics },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { category: "invalid-operation", operationIndex: 1 },
    });
    expect(result).not.toHaveProperty("update");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("creates canonical arrow points and reciprocal endpoint bindings", () => {
    const { doc } = seed();
    const result = prepare(
      doc,
      [{ op: "connect", fromId: "source", toId: "target", arrowLabel: "link" }],
      { textMetricsProvider: metrics },
    );
    expect(result.ok).toBe(true);
    const scene = consume(doc, result.update);
    const arrow = scene
      .getNonDeletedElements()
      .find((el) => el.type === "arrow")!;
    expect(arrow).toMatchObject({
      type: "arrow",
      startBinding: { elementId: "source" },
      endBinding: { elementId: "target" },
    });
    for (const id of ["source", "target"]) {
      expect(scene.getElement(id)!.boundElements).toContainEqual({
        id: arrow.id,
        type: "arrow",
      });
    }
  });

  it("reflows bound text and removes dependent text through exact replayable bytes", () => {
    const { doc } = seed();
    const first = prepare(
      doc,
      [
        {
          op: "setText",
          elementId: "source",
          text: "a long label that wraps across the shape",
        },
      ],
      { textMetricsProvider: metrics },
    );
    expect(first.ok).toBe(true);
    const labelled = consume(doc, first.update);
    const label = labelled
      .getNonDeletedElements()
      .find((el) => el.type === "text")!;
    const before = Y.encodeStateAsUpdate(labelled.doc);
    const removed = prepare(
      labelled.doc,
      [{ op: "remove", elementId: "source" }],
      { textMetricsProvider: metrics },
    );
    expect(removed.ok).toBe(true);
    expect(Y.encodeStateAsUpdate(labelled.doc)).toEqual(before);
    const final = consume(labelled.doc, removed.update);
    expect(final.getElement("source")!.isDeleted).toBe(true);
    expect(final.getElement(label.id)!.isDeleted).toBe(true);
    const once = Y.encodeStateAsUpdate(final.doc);
    Y.applyUpdate(final.doc, removed.update);
    expect(Y.encodeStateAsUpdate(final.doc)).toEqual(once);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite operation geometry %s",
    (x) => {
      const { doc } = seed();
      const result = prepare(
        doc,
        [{ op: "addShape", shape: "rectangle", x, y: 0 }],
        { textMetricsProvider: metrics },
      );
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("update");
    },
  );

  it("merges a concurrent peer edit without replacing shared lineage", () => {
    const { doc, scene } = seed();
    const result = prepare(
      doc,
      [{ op: "setText", elementId: "source", text: "label" }],
      { textMetricsProvider: metrics },
    );
    expect(result.ok).toBe(true);
    scene.mutateElement(scene.getElement("source")!, {
      strokeColor: "#ff0000",
    });
    Y.applyUpdate(doc, result.update);
    expect(scene.getElement("source")!.strokeColor).toBe("#ff0000");
    expect(scene.getElement("source")!.boundElements).toHaveLength(1);
  });

  it.each([NaN, Infinity, "wrong-type"])(
    "rejects malformed peer geometry %s without writing to input",
    (x) => {
      const { doc, scene } = seed();
      scene.yElements.get("source")!.set("x", x);
      const before = Y.encodeStateAsUpdate(doc);
      const result = prepare(doc, [{ op: "addText", text: "not published" }], {
        textMetricsProvider: metrics,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { category: "invalid-scene" },
      });
      expect(result).not.toHaveProperty("update");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    },
  );

  it.each(["backgroundColor", "strokeColor"])(
    "rejects object-valued peer %s without producing an update or writing input",
    (property) => {
      const { doc, scene } = seed();
      scene.yElements.get("source")!.set(property, { invalid: true });
      const before = Y.encodeStateAsUpdate(doc);
      const updates = vi.fn();
      doc.on("update", updates);
      const result = prepare(doc, [{ op: "addText", text: "not published" }], {
        textMetricsProvider: metrics,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { category: "invalid-scene" },
      });
      expect(result).not.toHaveProperty("update");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(updates).not.toHaveBeenCalled();
    },
  );

  it("retains actual delete-set bytes when removing a bound label", () => {
    const { doc } = seed();
    const labelled = prepare(
      doc,
      [{ op: "setText", elementId: "source", text: "label" }],
      { textMetricsProvider: metrics },
    );
    expect(labelled.ok).toBe(true);
    Y.applyUpdate(doc, labelled.update);
    const scene = new Scene(null, { doc });
    const label = scene.getElement("source")!.boundElements![0].id;
    const removed = prepare(doc, [{ op: "remove", elementId: label }], {
      textMetricsProvider: metrics,
    });
    expect(removed.ok).toBe(true);
    expect(Y.decodeUpdate(removed.update).ds.clients.size).toBeGreaterThan(0);
    const replica = consume(doc, removed.update);
    expect(replica.getElement(label)!.isDeleted).toBe(true);
    expect(replica.getElement("source")!.boundElements || []).toEqual([]);
  });

  it("cleans a removed connector endpoint while preserving the other binding and grouped siblings", () => {
    const { doc, scene } = seed();
    scene.mutateElement(scene.getElement("source")!, { groupIds: ["group"] });
    scene.mutateElement(scene.getElement("target")!, { groupIds: ["group"] });
    const connected = prepare(
      doc,
      [{ op: "connect", fromId: "source", toId: "target" }],
      { textMetricsProvider: metrics },
    );
    expect(connected.ok).toBe(true);
    Y.applyUpdate(doc, connected.update);
    const arrowId = connected.addedElementIds[0];
    const removed = prepare(doc, [{ op: "remove", elementId: "source" }], {
      textMetricsProvider: metrics,
    });
    const replica = consume(doc, removed.update);
    expect(replica.getElement(arrowId)).toMatchObject({
      startBinding: null,
      endBinding: { elementId: "target" },
      isDeleted: false,
    });
    expect(replica.getElement("target")).toMatchObject({
      isDeleted: false,
      groupIds: ["group"],
    });
  });

  it("rejects a non-finite metrics result after construction without partial bytes", () => {
    const { doc } = seed();
    const before = Y.encodeStateAsUpdate(doc);
    const result = prepare(doc, [{ op: "addText", text: "invalid metrics" }], {
      textMetricsProvider: { getLineWidth: () => NaN },
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("update");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});
