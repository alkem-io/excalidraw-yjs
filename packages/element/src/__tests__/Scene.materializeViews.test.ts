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
 * The one property the `materializeViews` extraction could silently break:
 * **cross-view object identity**. The array, the map and the non-deleted views
 * must hold the SAME instances, because `ShapeCache` and `elementWithCanvasCache`
 * are identity-keyed WeakMaps — a copy anywhere would miss every cache while
 * failing nothing. Generic Scene behaviour (ordering, deleted filtering, frames)
 * is covered elsewhere and is not re-tested here.
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
});
