import * as Y from "yjs";

import * as headless from "../headless";
import { getCommonBounds } from "../bounds";
import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { setCustomTextMetricsProvider } from "../textMeasurements";

import type { ExcalidrawTextElement, NonDeleted } from "../types";
import type { SemanticOperation } from "../semanticBatch";

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

describe("semantic automatic placement", () => {
  const run = (doc: Y.Doc, operations: SemanticOperation[]) => {
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on("update", updates);
    const result = prepare(doc, operations, { textMetricsProvider: metrics });
    expect(result.ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).not.toHaveBeenCalled();
    const scene = consume(doc, result.update);
    const once = Y.encodeStateAsUpdate(scene.doc);
    Y.applyUpdate(scene.doc, result.update);
    expect(Y.encodeStateAsUpdate(scene.doc)).toEqual(once);
    const cold = consume(scene.doc, result.update);
    const content = (current: Scene) =>
      current
        .getNonDeletedElements()
        .map(({ version, versionNonce, updated, ...element }) => element);
    expect(content(cold)).toEqual(content(scene));
    return {
      scene,
      added: result.addedElementIds.map((id) => scene.getElement(id)!),
    };
  };
  const box = { op: "addShape", shape: "rectangle" } as const;
  const lines = Array(20).fill("short").join("\n");

  it("uses completed existing reflow before the first automatic addition", () => {
    const { doc } = seed();
    const { scene, added } = run(doc, [
      { op: "setText", elementId: "source", text: lines },
      box,
    ]);
    expect(scene.getElement("source")!.height).toBe(510);
    const existing = scene
      .getNonDeletedElements()
      .filter((element) => element.id !== added[added.length - 1].id);
    expect(added[added.length - 1].y).toBe(getCommonBounds(existing)[3] + 100);
  });

  it("preserves ordinary compact horizontal positions and wrap", () => {
    const { doc } = seed();
    const { added } = run(doc, Array(6).fill(box));
    expect(added.map(({ x, y }) => [x, y])).toEqual([
      [0, 200],
      [240, 200],
      [480, 200],
      [720, 200],
      [960, 200],
      [0, 340],
    ]);
  });

  it.each([
    { ...box, x: 999 },
    { ...box, y: 999 },
    { op: "addText", text: "partial", x: 999 } as const,
    { op: "addText", text: "partial", y: 999 } as const,
  ])("auto-places without both explicit coordinates: %j", (operation) => {
    const { doc } = seed();
    const { added } = run(doc, [operation]);
    expect(added[0]).toMatchObject({ x: 0, y: 200 });
  });

  it("uses completed label width for wrap and label height for the next row", () => {
    const { doc } = seed();
    const { added } = run(doc, [
      { ...box, width: 1100 },
      { ...box, width: 1, label: lines },
      { ...box, width: 15 },
    ]);
    const roots = added.filter((element) => element.type === "rectangle");
    const label = added.find((element) => element.type === "text")!;
    expect(roots[1].width).toBeGreaterThan(1);
    const row = getCommonBounds([roots[0], roots[1], label]);
    expect(roots[2]).toMatchObject({ x: 0, y: row[3] + 40 });
    expect(roots[2].y).toBeGreaterThan(340);
  });

  it("places an oversized tall unit once and wraps below its full bounds", () => {
    const { doc } = seed();
    const { added } = run(doc, [{ ...box, width: 1300, height: 600 }, box]);
    expect(added[0]).toMatchObject({ x: 0, y: 200, width: 1300, height: 600 });
    expect(added[1]).toMatchObject({ x: 0, y: 840 });
  });

  it("keeps explicit intrusions exact and starts the next auto unit below them", () => {
    const { doc } = seed();
    const { added } = run(doc, [
      box,
      { ...box, x: 240, y: 250, height: 400 },
      box,
    ]);
    expect(added[0]).toMatchObject({ x: 0, y: 200 });
    expect(added[1]).toMatchObject({ x: 240, y: 250, height: 400 });
    expect(added[2]).toMatchObject({ x: 0, y: 690 });
  });

  it("observes connector label extent before the first automatic unit", () => {
    const { doc } = seed();
    const { scene, added } = run(doc, [
      { op: "connect", fromId: "source", toId: "target", arrowLabel: lines },
      box,
    ]);
    const root = added[added.length - 1];
    const existing = scene
      .getNonDeletedElements()
      .filter((el) => el.id !== root.id);
    expect(getCommonBounds(existing)[3]).toBeGreaterThan(100);
    expect(root.y).toBe(getCommonBounds(existing)[3] + 100);
  });

  it("does not reserve bounds for an existing element removed earlier", () => {
    const { doc, scene } = seed();
    scene.mutateElement(scene.getElement("source")!, { x: -500, y: 1000 });
    const { added } = run(doc, [{ op: "remove", elementId: "source" }, box]);
    expect(added[0]).toMatchObject({ x: 400, y: 200 });
  });
});

describe("semantic preparation", () => {
  it.each([0.5, 1, 20])(
    "wraps width at font size %s without font scaling",
    (fontSize) => {
      const { doc } = seed();
      const result = prepare(
        doc,
        [
          {
            op: "addText",
            text: "long text",
            x: 1,
            y: 2,
            width: 30,
            fontSize,
          },
        ],
        { textMetricsProvider: metrics },
      );
      const scene = consume(doc, result.update);
      expect(scene.getElement(result.addedElementIds[0])).toMatchObject({
        autoResize: false,
        fontSize,
        width: 30,
        x: 1,
        y: 2,
      });
      const next = prepare(
        scene.doc,
        [
          {
            op: "setText",
            elementId: result.addedElementIds[0],
            text: "longer text keeps wrapping within its fixed width",
          },
        ],
        { textMetricsProvider: metrics },
      );
      expect(
        consume(scene.doc, next.update).getElement(result.addedElementIds[0]),
      ).toMatchObject({ width: 30, fontSize, autoResize: false });
    },
  );
  it.each([1, 60, 90])(
    "wraps explicit width %s through canonical horizontal resize",
    (width) => {
      const { doc } = seed();
      const result = prepare(
        doc,
        [
          {
            op: "addText",
            text: "long words wrap\nand more words",
            x: 17,
            y: 231,
            fontSize: 20,
            width,
          },
        ],
        { textMetricsProvider: metrics },
      );
      expect(result.ok).toBe(true);
      const scene = consume(doc, result.update);
      const text = scene.getElement(
        result.addedElementIds[0],
      )! as ExcalidrawTextElement;
      expect(text).toMatchObject({
        x: 17,
        y: 231,
        fontSize: 20,
        autoResize: false,
      });
      expect(text.width).toBeGreaterThanOrEqual(width);
      expect(text.text).toContain("\n");
      expect(text.height).toBeGreaterThan(50);
      const next = prepare(
        scene.doc,
        [
          {
            op: "setText",
            elementId: text.id,
            text: "even longer text wraps within the fixed width",
          },
        ],
        { textMetricsProvider: metrics },
      );
      const changed = consume(scene.doc, next.update).getElement(text.id)!;
      expect(changed.width).toBe(text.width);
      expect(changed).toMatchObject({
        x: 17,
        y: 231,
        fontSize: 20,
        autoResize: false,
      });
    },
  );

  it.each([undefined, null, 10, 0, -1, NaN, "100"])(
    "rejects any supplied text height %s atomically",
    (height) => {
      const { doc } = seed();
      const before = Y.encodeStateAsUpdate(doc);
      for (const width of [undefined, 80]) {
        const input = [
          { op: "addShape", shape: "rectangle" },
          { op: "addText", text: "unsupported", height, width },
        ];
        expect(
          prepare(doc, input, { textMetricsProvider: metrics }),
        ).toMatchObject({
          ok: false,
          error: { category: "invalid-operation", operationIndex: 1 },
        });
        expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      }
    },
  );

  it.each([0, -1, NaN, Infinity, null, "80"])(
    "rejects invalid text width %s",
    (width) => {
      const { doc } = seed();
      expect(
        prepare(doc, [{ op: "addText", text: "bad width", width }], {
          textMetricsProvider: metrics,
        }),
      ).toMatchObject({ ok: false, error: { category: "invalid-operation" } });
    },
  );
  it("reports an invalid fill color at its operation without leaking a partial update", () => {
    const { doc } = seed();
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on("update", updates);
    const result = prepare(
      doc,
      [
        { op: "addShape", shape: "rectangle", fillColor: 42 },
        { op: "addText", text: "later valid operation" },
      ],
      { textMetricsProvider: metrics },
    );
    expect(result).toEqual({
      ok: false,
      error: { category: "invalid-operation", operationIndex: 0 },
    });
    expect(result).not.toHaveProperty("update");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).not.toHaveBeenCalled();
  });

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

it.each([
  { fontSize: 0.5, heightRatio: 1, handle: "e", changes: false },
  { fontSize: 20, heightRatio: 0.01, handle: "e", changes: false },
  { fontSize: 20, heightRatio: 1, handle: "e", changes: true },
  { fontSize: 20, heightRatio: 2, handle: "s", changes: true },
] as const)(
  "retains browser text resize behavior for $fontSize/$heightRatio/$handle",
  ({ fontSize, heightRatio, handle, changes }) => {
    const scene = new Scene();
    scene.insertElement(
      headless.newTextElement({ text: "long text", x: 10, y: 20, fontSize }),
    );
    const text =
      scene.getNonDeletedElements()[0] as NonDeleted<ExcalidrawTextElement>;
    const nextHeight = text.height * heightRatio;
    headless.resizeSingleTextElement(
      text,
      text,
      scene,
      handle,
      false,
      30,
      nextHeight,
    );
    const resized = scene.getElement(text.id)!;
    if (!changes) {
      expect(resized).toEqual(text);
    } else if (handle === "s") {
      expect(resized).toMatchObject({
        fontSize: fontSize * heightRatio,
        height: nextHeight,
      });
    } else {
      expect(resized).toMatchObject({ width: 30, fontSize, autoResize: false });
    }
    scene.destroy();
  },
);
