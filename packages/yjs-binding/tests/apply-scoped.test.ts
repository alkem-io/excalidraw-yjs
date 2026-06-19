import { describe, expect, it, vi } from "vitest";

import * as schema from "../src/schema";

import {
  StubExcalidrawAPI,
  WhiteboardBinding,
  Y,
  makeElement,
  sync,
} from "./helpers";

import type { ElementRecord } from "../src/schema";

/**
 * FIX 2 — O(changed) apply path.
 *
 * `onDocChange` ignored the `observeDeep` events and always rebuilt the ENTIRE
 * scene on every doc change (violating NFR-B-001 / T012: apply touches only
 * affected elements, O(changed)). These tests pin the scoped behaviour:
 *
 *  - a single-element remote change → only that element is decoded/bumped;
 *  - unchanged elements KEEP object identity (same reference) so React/Excalidraw
 *    can skip re-rendering them;
 *  - a full-rebuild fallback is still acceptable for structural events.
 */

/** Grab the elements array reference handed to the most recent `updateScene`. */
const lastSceneElements = (api: StubExcalidrawAPI): ElementRecord[] => {
  const call = api.updateSceneCalls[api.updateSceneCalls.length - 1];
  return (call?.elements ?? []) as ElementRecord[];
};

const byId = (els: readonly ElementRecord[]): Map<string, ElementRecord> =>
  new Map(els.map((e) => [e.id as string, e]));

describe("FIX 2: scoped apply keeps unchanged element identity", () => {
  it("a single remote element change re-uses the object identity of every untouched element", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const apiA = new StubExcalidrawAPI();
    const apiB = new StubExcalidrawAPI();
    const bindingA = new WhiteboardBinding(docA, apiA.asBindingAPI());
    const bindingB = new WhiteboardBinding(docB, apiB.asBindingAPI());

    // Seed three elements on A and sync to B.
    apiA.emitChange([
      makeElement({ id: "a", index: "a1", x: 0 }),
      makeElement({ id: "b", index: "a2", x: 0 }),
      makeElement({ id: "c", index: "a3", x: 0 }),
    ]);
    sync(docA, docB);

    // Capture B's element objects from the most recent updateScene.
    const beforeById = byId(lastSceneElements(apiB));
    expect(beforeById.size).toBe(3);
    const callsBefore = apiB.updateSceneCalls.length;

    // A mutates ONLY element "b".
    apiA.emitChange([
      apiA.elements[0],
      { ...apiA.elements[1], x: 500 },
      apiA.elements[2],
    ]);
    sync(docA, docB);

    expect(apiB.updateSceneCalls.length).toBeGreaterThan(callsBefore);
    const afterById = byId(lastSceneElements(apiB));

    // The changed element is a NEW object reflecting the new value…
    expect(afterById.get("b")!.x).toBe(500);
    expect(afterById.get("b")).not.toBe(beforeById.get("b"));

    // …while the untouched elements keep their exact object identity (so React
    // can bail out of re-rendering them).
    expect(afterById.get("a")).toBe(beforeById.get("a"));
    expect(afterById.get("c")).toBe(beforeById.get("c"));

    bindingA.destroy();
    bindingB.destroy();
  });

  it("does NOT decode untouched elements on a scoped change (only the changed id is read)", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const apiA = new StubExcalidrawAPI();
    const apiB = new StubExcalidrawAPI();
    const bindingA = new WhiteboardBinding(docA, apiA.asBindingAPI());
    const bindingB = new WhiteboardBinding(docB, apiB.asBindingAPI());

    apiA.emitChange([
      makeElement({ id: "a", index: "a1" }),
      makeElement({ id: "b", index: "a2" }),
      makeElement({ id: "c", index: "a3" }),
    ]);
    sync(docA, docB);

    // Spy on the element decoder; a scoped apply must only decode the changed id.
    const spy = vi.spyOn(schema, "yMapToElement");

    apiA.emitChange([
      apiA.elements[0],
      { ...apiA.elements[1], strokeColor: "#ff0000" },
      apiA.elements[2],
    ]);
    sync(docA, docB);

    // The decoder was called for "b" only (not for "a"/"c"). It may be called >1
    // across the two sync rounds, but never for an unchanged id.
    const decodedIds = new Set<string>();
    for (const call of spy.mock.calls) {
      const ymap = call[0] as Y.Map<unknown>;
      const id = ymap.get("id") as string | undefined;
      if (id) {
        decodedIds.add(id);
      }
    }
    // Only "b" should have been decoded by B's scoped applies.
    expect(decodedIds.has("a")).toBe(false);
    expect(decodedIds.has("c")).toBe(false);
    expect(decodedIds.has("b")).toBe(true);

    spy.mockRestore();
    bindingA.destroy();
    bindingB.destroy();
  });

  it("a remote ADD of a new element keeps the existing elements' identity", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const apiA = new StubExcalidrawAPI();
    const apiB = new StubExcalidrawAPI();
    const bindingA = new WhiteboardBinding(docA, apiA.asBindingAPI());
    const bindingB = new WhiteboardBinding(docB, apiB.asBindingAPI());

    apiA.emitChange([
      makeElement({ id: "a", index: "a1" }),
      makeElement({ id: "b", index: "a3" }),
    ]);
    sync(docA, docB);
    const beforeById = byId(lastSceneElements(apiB));

    // A inserts a new element between a and b.
    apiA.emitChange([
      apiA.elements[0],
      makeElement({ id: "mid", index: "a2" }),
      apiA.elements[1],
    ]);
    sync(docA, docB);

    const afterById = byId(lastSceneElements(apiB));
    expect(afterById.has("mid")).toBe(true);
    // Pre-existing elements keep identity.
    expect(afterById.get("a")).toBe(beforeById.get("a"));
    expect(afterById.get("b")).toBe(beforeById.get("b"));

    bindingA.destroy();
    bindingB.destroy();
  });

  it("a remote DELETE (tombstone) keeps the surviving elements' identity", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const apiA = new StubExcalidrawAPI();
    const apiB = new StubExcalidrawAPI();
    const bindingA = new WhiteboardBinding(docA, apiA.asBindingAPI());
    const bindingB = new WhiteboardBinding(docB, apiB.asBindingAPI());

    apiA.emitChange([
      makeElement({ id: "keep", index: "a1" }),
      makeElement({ id: "gone", index: "a2" }),
    ]);
    sync(docA, docB);
    const beforeById = byId(lastSceneElements(apiB));

    // A deletes "gone" (drops it from the array → tombstone).
    apiA.emitChange([apiA.elements[0]]);
    sync(docA, docB);

    const afterById = byId(lastSceneElements(apiB));
    // "keep" survives with the same identity; "gone" is now tombstoned.
    expect(afterById.get("keep")).toBe(beforeById.get("keep"));
    expect(afterById.get("gone")!.isDeleted).toBe(true);

    bindingA.destroy();
    bindingB.destroy();
  });

  it("a files-only remote change leaves every element's identity intact", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const apiA = new StubExcalidrawAPI();
    const apiB = new StubExcalidrawAPI();
    const bindingA = new WhiteboardBinding(docA, apiA.asBindingAPI());
    const bindingB = new WhiteboardBinding(docB, apiB.asBindingAPI());

    apiA.emitChange([makeElement({ id: "img", index: "a1", fileId: "f" })]);
    sync(docA, docB);
    const beforeById = byId(lastSceneElements(apiB));

    // A adds a file binary (files-only change — no element edit).
    apiA.emitChange([apiA.elements[0]], undefined, {
      f: { id: "f", mimeType: "image/png", dataURL: "X", created: 1 },
    });
    sync(docA, docB);

    // B received the file…
    expect(apiB.files.f).toBeDefined();
    // …and the element identity is untouched by a files-only change.
    const afterById = byId(lastSceneElements(apiB));
    expect(afterById.get("img")).toBe(beforeById.get("img"));

    bindingA.destroy();
    bindingB.destroy();
  });
});
