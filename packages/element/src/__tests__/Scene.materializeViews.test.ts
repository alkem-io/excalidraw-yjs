import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

const rect = (
  id: string,
  o: Partial<ExcalidrawElement> = {},
): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...o,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

/**
 * Behaviour-neutrality of the `materializeViews` extraction (spec 002, T016k).
 *
 * The six derived views were built inline in `recomputeFromDoc`; they are now built
 * by a pure function it calls. The property most easily broken by such a move is
 * **cross-view object identity** — the array, the map, and the non-deleted views
 * must hold the SAME instances, because `ShapeCache` and `elementWithCanvasCache`
 * are identity-keyed WeakMaps. A copy anywhere would silently miss every cache.
 */
describe("materializeViews (via Scene) is identity- and order-preserving", () => {
  it("all views share one instance per element", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a"), rect("b"), rect("c")]);
    // `newElement` forces isDeleted:false, so deletion has to be a real mutation.
    scene.mutateElement(scene.getElement("c")!, { isDeleted: true });

    const arr = scene.getElementsIncludingDeleted();
    const map = scene.getElementsMapIncludingDeleted();
    const live = scene.getNonDeletedElements();
    const liveMap = scene.getNonDeletedElementsMap();

    for (const el of arr) {
      expect(map.get(el.id)).toBe(el); // same instance, not a copy
    }
    for (const el of live) {
      expect(liveMap.get(el.id)).toBe(el);
      expect(arr).toContain(el);
    }
    scene.destroy();
  });

  it("non-deleted views exclude deleted elements; the full views keep them", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("keep"), rect("gone")]);
    scene.mutateElement(scene.getElement("gone")!, { isDeleted: true });

    expect(
      scene
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["gone", "keep"]);
    expect(scene.getNonDeletedElements().map((e) => e.id)).toEqual(["keep"]);
    expect(scene.getNonDeletedElementsMap().has("gone")).toBe(false);
    scene.destroy();
  });

  it("order follows the fractional index, and the map agrees with the array", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("x"), rect("y"), rect("z")]);

    const ids = scene.getElementsIncludingDeleted().map((e) => e.id);
    const indices = scene
      .getElementsIncludingDeleted()
      .map((e) => String(e.index));
    // sorted ascending by index — the ordering rule the views must preserve
    expect([...indices].sort()).toEqual(indices);
    expect([...scene.getElementsMapIncludingDeleted().keys()].sort()).toEqual(
      [...ids].sort(),
    );
    scene.destroy();
  });

  it("frame views contain exactly the frame-like elements", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      rect("plain"),
      newElement({
        type: "frame",
        id: "f1",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      } as Parameters<typeof newElement>[0]) as ExcalidrawElement,
    ]);

    expect(scene.getFramesIncludingDeleted().map((f) => f.id)).toEqual(["f1"]);
    scene.destroy();
  });
});
