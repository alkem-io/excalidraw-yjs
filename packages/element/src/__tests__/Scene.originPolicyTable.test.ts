import * as origins from "../yjs/origin";
import { Scene } from "../Scene";
import { newElement } from "../newElement";

import type * as Y from "yjs";

import type { ExcalidrawElement } from "../types";

const rect = (id: string, over: Partial<ExcalidrawElement> = {}) =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...over,
  } as Parameters<typeof newElement>[0]);

/**
 * INV-ORIGIN, table-driven (the suite T022 left open).
 *
 * The existing `Scene.originPolicy.test.ts` covers each origin case by case,
 * which is why the policy is correct today — but it has no bite against the
 * invariant's actual claim: *adding an origin without a declared policy must
 * fail the suite*. Case-by-case tests simply stay green when a fourth origin
 * appears.
 *
 * This enumerates the closed set from the module itself, so a new export cannot
 * be added without either declaring its policy here or failing.
 */

/** The declared policy for every origin. `published` = reaches the transport. */
const POLICY: Record<string, { published: boolean; tracked: boolean }> = {
  LOCAL_ORIGIN: { published: true, tracked: true },
  STRUCTURAL_ORIGIN: { published: true, tracked: false },
  REMOTE_ORIGIN: { published: false, tracked: false },
};

const exportedOrigins = Object.keys(origins).filter((k) =>
  k.endsWith("_ORIGIN"),
);

describe("INV-ORIGIN — every origin has a declared policy", () => {
  it("the closed set is exactly the origins with declared policies", () => {
    // The bite: a NEW `*_ORIGIN` export with no entry in POLICY fails here, and
    // a removed one fails too. Neither can slip through silently.
    expect(exportedOrigins.sort()).toEqual(Object.keys(POLICY).sort());
  });

  it.each(exportedOrigins)("%s publishes per its declared policy", (name) => {
    const declared = POLICY[name];
    expect(declared).toBeDefined();

    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);

    const seen: Uint8Array[] = [];
    const detach = scene.onDocUpdate((u) => seen.push(u));
    // A VALID per-property write on the element's own map — writing a scalar
    // onto the elements root would break the derive and prove nothing.
    scene.doc.transact(() => {
      const ymap = scene.doc
        .getMap<Y.Map<unknown>>("elements")
        .get("a") as Y.Map<unknown>;
      ymap.set("x", 77);
    }, (origins as Record<string, unknown>)[name]);
    detach();

    expect(seen.length > 0).toBe(declared.published);
    scene.destroy();
  });

  it.each(exportedOrigins)("%s is undoable per its declared policy", (name) => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const before = scene.getElement("a" as never)!.x;

    scene.doc.transact(() => {
      const ymap = scene.doc
        .getMap<Y.Map<unknown>>("elements")
        .get("a") as Y.Map<unknown>;
      ymap.set("x", 123);
    }, (origins as Record<string, unknown>)[name]);
    expect(scene.getElement("a" as never)!.x).toBe(123);

    scene.undoElements();

    // Assert on the VALUE, not on undo's return: an untracked write leaves undo
    // free to revert some earlier step, so "undo did something" proves nothing
    // about THIS origin.
    const reverted = scene.getElement("a" as never)?.x === before;
    expect(reverted).toBe(POLICY[name].tracked);
    scene.destroy();
  });
});
