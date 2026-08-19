import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { captureElementBase } from "../yjs/intent";

import type * as Y from "yjs";
import type { ElementRecord } from "../yjs/schema";
import type { ExcalidrawElement } from "../types";

const rec = (id: string, o: Record<string, unknown> = {}) =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as Parameters<typeof newElement>[0]) as unknown as Record<
      string,
      unknown
    >),
    ...o,
  } as ElementRecord);

/** Another writer (a peer apply, an undo, a concurrent local path) changes the doc. */
const otherWriterSets = (
  scene: Scene,
  id: string,
  key: string,
  value: unknown,
) => {
  const ymap = scene.yElements.get(id) as Y.Map<unknown>;
  scene.doc.transact(() => ymap.set(key, value));
};

describe("applyElementChanges — intent against the CURRENT doc", () => {
  it("an unrelated key changed meanwhile SURVIVES the action result", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      rec("a", {
        x: 0,
        strokeColor: "#000000",
      }) as unknown as ExcalidrawElement,
    ]);

    // The action is invoked: base captured here.
    const base = captureElementBase(
      scene.getElementsIncludingDeleted() as never,
    );

    // A peer recolours while the action runs.
    otherWriterSets(scene, "a", "strokeColor", "#00ff00");

    // The action's result was computed from `base`, so it still says #000000.
    const result = [rec("a", { x: 50, strokeColor: "#000000" })];
    scene.applyElementChanges(base as never, result);

    expect(scene.getElement("a")!.x).toBe(50); // the action's actual edit lands
    expect(scene.getElement("a")!.strokeColor).toBe("#00ff00"); // peer's survives
    scene.destroy();
  });

  it("an element added meanwhile is NOT removed by the action result", () => {
    const scene = new Scene();
    scene.replaceAllElements([rec("a") as unknown as ExcalidrawElement]);
    const base = captureElementBase(
      scene.getElementsIncludingDeleted() as never,
    );

    // A peer adds an element the action never saw.
    scene.replaceAllElements([
      rec("a") as unknown as ExcalidrawElement,
      rec("peer") as unknown as ExcalidrawElement,
    ]);

    // The action's result contains only what it knew about.
    scene.applyElementChanges(base as never, [rec("a", { x: 9 })]);

    expect(scene.getElement("a")!.x).toBe(9);
    expect(scene.getElement("peer")).toBeDefined(); // membership not authoritative
    scene.destroy();
  });

  it("EXPLICIT same-value intent beats an interleaved remote value", () => {
    // The case no derived diff can express: the action means "set x to 0",
    // and 0 is what base already showed, so a diff sees nothing — yet the doc
    // has since moved to 10 and the action must win.
    const scene = new Scene();
    scene.replaceAllElements([
      rec("a", { x: 0 }) as unknown as ExcalidrawElement,
    ]);
    const base = captureElementBase(
      scene.getElementsIncludingDeleted() as never,
    );

    otherWriterSets(scene, "a", "x", 10);

    const result = [rec("a", { x: 0 })];

    // Derived: no intent, so the remote value stands.
    scene.applyElementChanges(base as never, result);
    expect(scene.getElement("a")!.x).toBe(10);

    // Declared: the action states the key, and wins.
    scene.applyElementChanges(base as never, result, {
      declaredIntent: {
        addedIds: new Set(),
        removedIds: new Set(),
        keysById: new Map([["a", new Set(["x"])]]),
      },
    });
    expect(scene.getElement("a")!.x).toBe(0);
    scene.destroy();
  });

  it("rejects a contradictory declaration before touching the doc", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      rec("a", { x: 1 }) as unknown as ExcalidrawElement,
    ]);

    expect(() =>
      scene.applyElementChanges(
        captureElementBase(
          scene.getElementsIncludingDeleted() as never,
        ) as never,
        [rec("a", { x: 2 })],
        {
          declaredIntent: {
            addedIds: new Set(),
            // "removed", yet present in result — a caller bug, not something to
            // resolve silently
            removedIds: new Set(["a"]),
            keysById: new Map(),
          },
        },
      ),
    ).toThrow(/removed id a is present in result/);

    expect(scene.getElement("a")!.x).toBe(1);
    scene.destroy();
  });
});
