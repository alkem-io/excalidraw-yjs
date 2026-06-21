import { describe, expect, it } from "vitest";

import { exportSceneJSON } from "../src/migrate";
import { hashDocState } from "../src/hash";
import { BINDING_ORIGIN } from "../src/origin";

import {
  StubExcalidrawAPI,
  WhiteboardBinding,
  Y,
  makeElement,
} from "./helpers";

import type { SceneJSON } from "../src/migrate";

/**
 * T005 / R1 — the binding runs on a **local** `Y.Doc` with NO provider and NO
 * awareness. This is the proof that EVERY non-collab scene-content path
 * (single-user editing, template hydration, preview, export/import) can be
 * Yjs-backed through the very same binding the collab path uses — only the
 * *transport* (a network provider + awareness) is added when collaborating, and
 * it is entirely optional (FR-B-011: the binding opens no socket and knows no
 * server).
 *
 * Each test constructs `new WhiteboardBinding(localDoc, api, { initialScene })`
 * with no `awareness`/`ephemeral`, and asserts the scene ↔ doc loop works:
 * the doc seeds the scene, local edits flow scene → doc, and doc edits flow
 * doc → scene — all without a second peer or any network.
 */

const initialScene = (): SceneJSON => ({
  elements: [
    makeElement({ id: "seed-1", index: "a1", seed: 1, strokeColor: "#101010" }),
    makeElement({ id: "seed-2", index: "a2", seed: 2, x: 50 }),
  ],
  appState: { viewBackgroundColor: "#fafafa", name: "Local Board" },
});

describe("WhiteboardBinding on a LOCAL Y.Doc, no provider/awareness (T005 / R1)", () => {
  it("seeds an empty local doc from initialScene and renders it to the scene", () => {
    const doc = new Y.Doc();
    const api = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api.asBindingAPI(), {
      initialScene: initialScene(),
    });

    // No awareness was wired (single-user / template / preview mode).
    expect(binding.awarenessRouter).toBeUndefined();

    // The doc was seeded from the initial scene…
    const out = exportSceneJSON(doc);
    expect(out.elements.map((e) => e.id)).toEqual(["seed-1", "seed-2"]);
    expect(out.appState).toEqual({
      viewBackgroundColor: "#fafafa",
      name: "Local Board",
    });

    // …and the seed was applied to the editor scene (initial updateScene).
    expect(api.elements.map((e) => e.id).sort()).toEqual(["seed-1", "seed-2"]);

    binding.destroy();
  });

  it("does NOT re-seed a doc that already has content (initialScene ignored)", () => {
    const doc = new Y.Doc();
    // Pre-populate the doc with a different element than initialScene carries.
    const api1 = new StubExcalidrawAPI();
    const seeder = new WhiteboardBinding(doc, api1.asBindingAPI(), {
      initialScene: {
        elements: [makeElement({ id: "pre-existing", index: "a1", seed: 9 })],
      },
    });
    seeder.destroy();

    // A second binding over the same (non-empty) doc must keep the doc's content,
    // not overwrite it with its own initialScene.
    const api2 = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api2.asBindingAPI(), {
      initialScene: initialScene(),
    });
    const out = exportSceneJSON(doc);
    expect(out.elements.map((e) => e.id)).toEqual(["pre-existing"]);

    binding.destroy();
  });

  it("flows a local edit scene → doc (single-user editing, no network)", () => {
    const doc = new Y.Doc();
    const api = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api.asBindingAPI(), {
      initialScene: initialScene(),
    });

    // User edits an element in the editor.
    api.emitChange([
      {
        ...api.elements.find((e) => e.id === "seed-1")!,
        strokeColor: "#00ff00",
      },
      ...api.elements.filter((e) => e.id !== "seed-1"),
    ]);

    // The change is reflected in the local doc — no provider needed.
    const out = exportSceneJSON(doc);
    const edited = out.elements.find((e) => e.id === "seed-1")!;
    expect(edited.strokeColor).toBe("#00ff00");

    binding.destroy();
  });

  it("flows a new element scene → doc and a deletion (tombstone) scene → doc", () => {
    const doc = new Y.Doc();
    const api = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api.asBindingAPI(), {
      initialScene: initialScene(),
    });

    // Add a fresh element.
    api.emitChange([
      ...api.elements,
      makeElement({ id: "added", index: "a3", seed: 3 }),
    ]);
    expect(exportSceneJSON(doc).elements.map((e) => e.id)).toContain("added");

    // Soft-delete an element (Excalidraw never hard-removes — it tombstones).
    api.emitChange(
      api.elements.map((e) =>
        e.id === "added" ? { ...e, isDeleted: true } : e,
      ),
    );
    const tomb = exportSceneJSON(doc).elements.find((e) => e.id === "added")!;
    expect(tomb.isDeleted).toBe(true);

    binding.destroy();
  });

  it("flows a doc edit doc → scene (e.g. a stored-snapshot update applied locally)", () => {
    const doc = new Y.Doc();
    const api = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api.asBindingAPI(), {
      initialScene: initialScene(),
    });

    const before = api.updateSceneCalls.length;

    // Simulate a NON-binding write into the doc (origin !== BINDING_ORIGIN), such
    // as applying a freshly-loaded snapshot or a programmatic local mutation.
    doc.transact(() => {
      const el = doc.getMap<Y.Map<unknown>>("elements").get("seed-2")!;
      el.set("x", 777);
    }, "external-local");

    // The binding applied it to the scene (doc → scene), without any network.
    expect(api.updateSceneCalls.length).toBeGreaterThan(before);
    const applied = api.elements.find((e) => e.id === "seed-2")!;
    expect(applied.x).toBe(777);

    binding.destroy();
  });

  it("round-trips: seed → local edit → exportSceneJSON reflects the edit", () => {
    const doc = new Y.Doc();
    const api = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api.asBindingAPI(), {
      initialScene: initialScene(),
    });

    const h0 = hashDocState(doc);
    api.emitChange([
      { ...api.elements.find((e) => e.id === "seed-2")!, x: 123 },
      ...api.elements.filter((e) => e.id !== "seed-2"),
    ]);
    const h1 = hashDocState(doc);

    // The dirty-check hash moved (the doc content changed) — proving the local
    // edit landed in the doc, observable via the same hash the save path uses.
    expect(h1).not.toBe(h0);
    expect(
      exportSceneJSON(doc).elements.find((e) => e.id === "seed-2")!.x,
    ).toBe(123);

    binding.destroy();
  });

  it("never writes to the doc under any origin but BINDING_ORIGIN for a local edit", () => {
    const doc = new Y.Doc();
    const api = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api.asBindingAPI(), {
      initialScene: initialScene(),
    });

    const foreignTx: unknown[] = [];
    doc.on("afterTransaction", (tx: Y.Transaction) => {
      if (tx.origin !== BINDING_ORIGIN) {
        foreignTx.push(tx.origin);
      }
    });

    api.emitChange([
      { ...api.elements[0], x: (api.elements[0].x as number) + 1 },
      ...api.elements.slice(1),
    ]);

    // The binding's own writes always carry BINDING_ORIGIN (so a provider, when
    // present, can distinguish local writes). With no provider, nobody else writes.
    expect(foreignTx).toEqual([]);

    binding.destroy();
  });

  it("destroy() detaches cleanly with no provider (idempotent)", () => {
    const doc = new Y.Doc();
    const api = new StubExcalidrawAPI();
    const binding = new WhiteboardBinding(doc, api.asBindingAPI(), {
      initialScene: initialScene(),
    });
    binding.destroy();
    const callsAfterDestroy = api.updateSceneCalls.length;

    // A post-destroy edit must not drive any more applies, and a second destroy
    // must not throw.
    api.emitChange([makeElement({ id: "late", index: "z1", seed: 4 })]);
    expect(api.updateSceneCalls.length).toBe(callsAfterDestroy);
    expect(() => binding.destroy()).not.toThrow();
  });
});
