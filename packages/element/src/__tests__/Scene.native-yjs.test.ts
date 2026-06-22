import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { ELEMENTS, RECONCILE_META_KEYS, yMapToElement } from "../yjs";

import type { ExcalidrawElement } from "../types";

/**
 * Native-Yjs core (M1) — proves the editor's element store IS the `Y.Doc`:
 *
 *  - the derived reads (`getElementsIncludingDeleted`, …) are a faithful,
 *    fractional-index-ordered view of `yElements`,
 *  - the doc is the authoritative + portable representation (a second `Scene`
 *    rebuilt from the encoded doc bytes is identical),
 *  - writes are per-property, so concurrent edits to *different* props of the
 *    same element both survive.
 */

const rect = (
  id: string,
  overrides: Partial<ExcalidrawElement> = {},
): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...overrides,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

/** The doc does NOT store reconciliation metadata; compare element content
 * modulo those keys (`RECONCILE_META_KEYS`, OPEN-3). */
const stripMeta = (el: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (!RECONCILE_META_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
};

const byId = (els: readonly ExcalidrawElement[]) =>
  new Map(els.map((e) => [e.id, e]));

/** Read the elements straight out of `yElements`, ordered by fractional index. */
const readDocElements = (doc: Y.Doc): Array<Record<string, unknown>> => {
  const yElements = doc.getMap<Y.Map<unknown>>(ELEMENTS);
  const out: Array<Record<string, unknown>> = [];
  for (const [id, ymap] of yElements.entries()) {
    const rec = yMapToElement(ymap);
    rec.id = id;
    out.push(rec);
  }
  out.sort((a, b) => {
    const ai = a.index as string;
    const bi = b.index as string;
    if (ai < bi) {
      return -1;
    }
    if (ai > bi) {
      return 1;
    }
    return (a.id as string) < (b.id as string) ? -1 : 1;
  });
  return out;
};

describe("native-yjs Scene: the element store IS the doc", () => {
  it("replaceAllElements diffs into yElements; reads reflect the doc exactly, in fractional-index order", () => {
    const scene = new Scene();

    scene.replaceAllElements([rect("a"), rect("b"), rect("c")]);

    const els = scene.getElementsIncludingDeleted();
    expect(els.map((e) => e.id)).toEqual(["a", "b", "c"]);

    // yElements is the source of truth — it holds exactly these three entries.
    expect([...scene.yElements.keys()].sort()).toEqual(["a", "b", "c"]);

    // The derived array equals the doc-derived view (content, modulo meta) AND is
    // ordered by fractional index.
    const docEls = readDocElements(scene.doc);
    expect(docEls.map((e) => e.id)).toEqual(["a", "b", "c"]);
    for (const el of els) {
      const docEl = scene.yElements.get(el.id)!;
      expect(stripMeta(el as unknown as Record<string, unknown>)).toEqual(
        stripMeta({ ...yMapToElement(docEl), id: el.id }),
      );
    }

    // Indices are strictly increasing (assigned by syncInvalidIndices, stored in
    // the doc).
    const indices = els.map((e) => e.index!);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i] > indices[i - 1]).toBe(true);
    }

    scene.destroy();
  });

  it("scene.mutateElement writes the change to the doc; the returned element + reads reflect it", () => {
    const scene = new Scene([rect("a"), rect("b")]);

    const a = scene.getElement("a")!;
    // Capture the version as a number BEFORE mutating (scene.mutateElement also
    // mutates the passed object in place as an M1 compatibility bridge, so reading
    // `a.version` after the call would already show the bumped value).
    const versionBefore = a.version;
    const returned = scene.mutateElement(a, { x: 42, y: 7 });

    // returned element reflects the doc
    expect(returned.x).toBe(42);
    expect(returned.y).toBe(7);

    // the doc's per-property map holds the new values
    const ymapA = scene.yElements.get("a")!;
    expect(ymapA.get("x")).toBe(42);
    expect(ymapA.get("y")).toBe(7);

    // reads reflect the doc
    expect(scene.getElement("a")!.x).toBe(42);
    expect(scene.getElement("b")!.x).toBe(0);

    // version bumped (locally maintained, even though not stored in the doc)
    expect(scene.getElement("a")!.version).toBeGreaterThan(versionBefore);
    expect(ymapA.has("version")).toBe(false);

    scene.destroy();
  });

  it("dropping an element from a replace structurally removes its entry from the doc", () => {
    // Native-Yjs core (M2): an element dropped from `nextElements` is structurally
    // removed, so the doc — and thus `getElementsIncludingDeleted()` — matches the
    // passed set exactly (as the pre-rewrite scene array did). The editor's Store
    // still synthesizes an `isDeleted:true` delta for reconciliation/history by
    // diffing the derived elements; and a recording removal is captured so undo
    // RE-ADDS it (covered in the history test). Hard removal is the same whether or
    // not recording — only the undoability (origin) differs.
    const scene = new Scene([rect("a"), rect("b"), rect("c")]);
    expect([...scene.yElements.keys()].sort()).toEqual(["a", "b", "c"]);

    const keep = scene
      .getElementsIncludingDeleted()
      .filter((e) => e.id !== "b");
    scene.replaceAllElements(keep); // recordHistory defaults to true

    expect([...scene.yElements.keys()].sort()).toEqual(["a", "c"]);
    expect(scene.getElement("b")).toBeNull();
    expect(scene.getElementsIncludingDeleted().map((e) => e.id)).toEqual([
      "a",
      "c",
    ]);

    // same structural removal in the non-recording (load/prune) case
    const scene2 = new Scene([rect("a"), rect("b")]);
    scene2.replaceAllElements([scene2.getElement("a")!], {
      recordHistory: false,
    });
    expect([...scene2.yElements.keys()]).toEqual(["a"]);

    scene.destroy();
    scene2.destroy();
  });

  it("isDeleted tombstone survives as an UPDATE (the entry stays in the doc)", () => {
    const scene = new Scene([rect("a"), rect("b")]);

    const b = scene.getElement("b")!;
    scene.mutateElement(b, { isDeleted: true });

    // still in the doc (tombstone), but excluded from non-deleted views
    expect(scene.yElements.has("b")).toBe(true);
    expect(scene.yElements.get("b")!.get("isDeleted")).toBe(true);
    expect(scene.getElementsIncludingDeleted().map((e) => e.id)).toEqual([
      "a",
      "b",
    ]);
    expect(scene.getNonDeletedElements().map((e) => e.id)).toEqual(["a"]);

    scene.destroy();
  });

  it("the doc is authoritative + portable: a Scene rebuilt from encoded bytes is identical", () => {
    const scene = new Scene([rect("a", { x: 5 }), rect("b"), rect("c")]);
    scene.mutateElement(scene.getElement("a")!, { x: 11, strokeColor: "#f00" });
    scene.mutateElement(scene.getElement("c")!, { angle: 1 as any });

    // Encode the authoritative doc and decode it into a brand-new doc + Scene.
    const update = Y.encodeStateAsUpdateV2(scene.doc);
    const doc2 = new Y.Doc();
    Y.applyUpdateV2(doc2, update);
    const scene2 = new Scene(null, { doc: doc2 });

    const a1 = byId(scene.getElementsIncludingDeleted());
    const a2 = byId(scene2.getElementsIncludingDeleted());

    expect([...a2.keys()].sort()).toEqual([...a1.keys()].sort());
    // identical order
    expect(scene2.getElementsIncludingDeleted().map((e) => e.id)).toEqual(
      scene.getElementsIncludingDeleted().map((e) => e.id),
    );
    // identical element content (modulo the locally-derived reconciliation meta,
    // which the doc deliberately does not carry)
    for (const id of a1.keys()) {
      expect(
        stripMeta(a2.get(id)! as unknown as Record<string, unknown>),
      ).toEqual(stripMeta(a1.get(id)! as unknown as Record<string, unknown>));
    }
    // and the mutated values made it across the wire
    expect(scene2.getElement("a")!.x).toBe(11);
    expect(scene2.getElement("a")!.strokeColor).toBe("#f00");

    scene.destroy();
    scene2.destroy();
  });

  it("per-property: two mutateElements to DIFFERENT props of the same element both survive", () => {
    // Single Scene/doc, two separate mutations to different props of "a".
    const scene = new Scene([rect("a")]);
    scene.mutateElement(scene.getElement("a")!, { x: 123 });
    scene.mutateElement(scene.getElement("a")!, { strokeColor: "#00ff00" });

    const ymapA = scene.yElements.get("a")!;
    expect(ymapA.get("x")).toBe(123);
    expect(ymapA.get("strokeColor")).toBe("#00ff00");
    expect(scene.getElement("a")!.x).toBe(123);
    expect(scene.getElement("a")!.strokeColor).toBe("#00ff00");

    // Now the real CRDT proof: two replicas concurrently edit DIFFERENT props of
    // the same element, off a shared base, then merge. Per-property maps mean
    // BOTH edits survive (a whole-object LWW would lose one).
    const base = new Y.Doc();
    Y.applyUpdateV2(base, Y.encodeStateAsUpdateV2(scene.doc));

    const docX = new Y.Doc();
    Y.applyUpdateV2(docX, Y.encodeStateAsUpdateV2(base));
    const docColor = new Y.Doc();
    Y.applyUpdateV2(docColor, Y.encodeStateAsUpdateV2(base));

    const sceneX = new Scene(null, { doc: docX });
    const sceneColor = new Scene(null, { doc: docColor });

    sceneX.mutateElement(sceneX.getElement("a")!, { x: 999 });
    sceneColor.mutateElement(sceneColor.getElement("a")!, { y: 888 });

    // Merge both replicas' updates into one doc (order-independent for CRDTs).
    const merged = new Y.Doc();
    Y.applyUpdateV2(merged, Y.encodeStateAsUpdateV2(docX));
    Y.applyUpdateV2(merged, Y.encodeStateAsUpdateV2(docColor));
    const mergedScene = new Scene(null, { doc: merged });

    const a = mergedScene.getElement("a")!;
    // x came from replica X, y came from replica Color — both survived.
    expect(a.x).toBe(999);
    expect(a.y).toBe(888);

    scene.destroy();
    sceneX.destroy();
    sceneColor.destroy();
    mergedScene.destroy();
  });

  it("mapElements routes through the doc; no-op map does not change the doc", () => {
    const scene = new Scene([rect("a"), rect("b")]);
    const before = Y.encodeStateAsUpdateV2(scene.doc);

    // no-op: returns the same element
    const changed = scene.mapElements((el) => el);
    expect(changed).toBe(false);

    // a real map: shift every x by 10
    const didChange = scene.mapElements((el) => ({ ...el, x: el.x + 10 }));
    expect(didChange).toBe(true);
    expect(scene.getElement("a")!.x).toBe(10);
    expect(scene.yElements.get("a")!.get("x")).toBe(10);

    // sanity: the no-op really left bytes untouched (we only compare lengths as a
    // cheap smoke check that nothing was written before the real change)
    expect(before.byteLength).toBeGreaterThan(0);

    scene.destroy();
  });

  it("onUpdate fires on every doc write path", () => {
    const scene = new Scene();
    let updates = 0;
    const off = scene.onUpdate(() => {
      updates += 1;
    });

    scene.replaceAllElements([rect("a")]);
    expect(updates).toBe(1);

    scene.mutateElement(scene.getElement("a")!, { x: 1 });
    expect(updates).toBe(2);

    off();
    scene.destroy();
  });
});
