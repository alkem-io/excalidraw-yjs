import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

/**
 * Documents WHY the ~36 `fresh-snapshot` re-read sites exist, and why FR-009 did
 * NOT make them removable (spec 002, task T016).
 *
 * FR-009 scoped `Scene.mutateElement` to the caller's declared keys, so a stale
 * reference can no longer revert a peer's concurrent edit through that path.
 * `replaceAllElements` is deliberately NOT scoped — its contract is "make the doc
 * equal this element set", which is the correct semantic for a full reconcile.
 *
 * The consequence is that the stale-read revert class survives at the bulk path:
 * an action handler that captures the element array, lets a side-effect helper
 * write to the doc, then returns its captured array, reverts that write. That is
 * exactly what commit b2f708f5 patched by re-reading the side-effected elements,
 * and those re-reads remain load-bearing until the bulk path itself changes.
 */

const rect = (
  id: string,
  o: Partial<ExcalidrawElement> = {},
): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...o,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

describe("replaceAllElements is whole-object by contract", () => {
  it("a stale caller array reverts a concurrent doc write (why the re-reads exist)", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0, y: 0 })]);

    // Deep-copy: the live array re-derives from the doc, so a bare reference is
    // NOT stale and this test would prove nothing.
    const captured = scene
      .getElementsIncludingDeleted()
      .map((e) => ({ ...e })) as ExcalidrawElement[];

    // A side-effect helper writes through the (now intent-scoped) mutate path.
    scene.mutateElement(scene.getElement("a")!, { y: 500 });

    // Non-vacuity guards: the array really is stale, the doc really did change.
    expect(captured[0].y).toBe(0);
    expect(scene.getElement("a")!.y).toBe(500);

    scene.replaceAllElements(captured);

    // The write is reverted. NOT a bug — `replaceAllElements` means "make the doc
    // equal this set". It is the reason a handler must re-read side-effected
    // elements before returning its array, and why T016 cannot simply delete
    // those re-reads.
    expect(scene.getElement("a")!.y).toBe(0);
    scene.destroy();
  });
});
