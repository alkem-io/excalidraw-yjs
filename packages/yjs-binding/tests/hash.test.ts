import { describe, expect, it } from "vitest";

import { hashDocState } from "../src/hash";
import { exportSceneJSON, populateYDoc } from "../src/migrate";
import { writeDiff } from "../src/diff";
import { BINDING_ORIGIN } from "../src/origin";

import { Y, makeElement } from "./helpers";

import type { SceneJSON } from "../src/migrate";

/**
 * `hashDocState` (US4, T002) — a stable, content-addressed digest of a `Y.Doc`'s
 * whiteboard state, the Yjs-native replacement for the legacy JSON deep-compare
 * dirty-check (`isWhiteboardContentEqual`). Contract:
 *
 *  - deterministic: the same content hashes the same, regardless of element
 *    insertion order or appState key order;
 *  - sensitive: a single-property change yields a different hash;
 *  - boundary-correct: it hashes the *content* (elements/files/appState), NOT the
 *    per-peer reconciliation metadata (version/versionNonce/updated), which is
 *    local-only and would otherwise make two replicas of identical content
 *    disagree.
 */

// `makeElement` assigns a fresh `seed`/`versionNonce` from a module counter on
// every call. `seed` is real Excalidraw content (persisted, render-affecting) and
// is NOT reconciliation metadata, so two scenes that must hash equal have to pin
// it explicitly — otherwise the two builds legitimately differ.
const scene = (): SceneJSON => ({
  elements: [
    makeElement({ id: "a", index: "a1", strokeColor: "#111111", seed: 1 }),
    makeElement({ id: "b", index: "a2", x: 10, seed: 2 }),
  ],
  files: {
    f1: {
      id: "f1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AAAA",
      created: 1,
    } as never,
  },
  appState: { viewBackgroundColor: "#ffffff", name: "Board" },
});

describe("hashDocState (T002 / US4 dirty-check)", () => {
  it("is a non-empty string", () => {
    const doc = new Y.Doc();
    populateYDoc(scene(), doc);
    const h = hashDocState(doc);
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("identical content → identical hash (two independently-populated docs)", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    populateYDoc(scene(), a);
    populateYDoc(scene(), b);
    expect(hashDocState(a)).toBe(hashDocState(b));
  });

  it("is stable across repeated calls on the same doc", () => {
    const doc = new Y.Doc();
    populateYDoc(scene(), doc);
    expect(hashDocState(doc)).toBe(hashDocState(doc));
  });

  it("a one-property change → a different hash", () => {
    const doc = new Y.Doc();
    populateYDoc(scene(), doc);
    const before = hashDocState(doc);

    // Move element "b" by one pixel via the diff write path (BINDING_ORIGIN).
    const out = exportSceneJSON(doc);
    const moved = out.elements.map((el) =>
      el.id === "b" ? { ...el, x: 11 } : el,
    );
    doc.transact(() => {
      writeDiff(
        {
          ydoc: doc,
          elementsMap: doc.getMap("elements"),
          filesMap: doc.getMap("files"),
          appStateMap: doc.getMap("appState"),
        },
        out.elements as never,
        moved as never,
        out.appState as never,
        out.files as never,
      );
    }, BINDING_ORIGIN);

    expect(hashDocState(doc)).not.toBe(before);
  });

  it("a changed appState (background) → a different hash", () => {
    const doc = new Y.Doc();
    populateYDoc(scene(), doc);
    const before = hashDocState(doc);
    doc.transact(() => {
      doc.getMap("appState").set("viewBackgroundColor", "#000000");
    }, BINDING_ORIGIN);
    expect(hashDocState(doc)).not.toBe(before);
  });

  it("a changed file binary → a different hash", () => {
    const doc = new Y.Doc();
    populateYDoc(scene(), doc);
    const before = hashDocState(doc);
    doc.transact(() => {
      doc.getMap("files").set("f1", {
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,BBBB",
        created: 1,
      } as never);
    }, BINDING_ORIGIN);
    expect(hashDocState(doc)).not.toBe(before);
  });

  it("ignores element insertion order (content-addressed, not order-addressed)", () => {
    const forward: SceneJSON = {
      elements: [
        makeElement({ id: "a", index: "a1", seed: 10 }),
        makeElement({ id: "b", index: "a2", seed: 20 }),
      ],
    };
    const reversed: SceneJSON = {
      // same elements + indices + seeds, inserted into the Y.Map in reverse order
      elements: [
        makeElement({ id: "b", index: "a2", seed: 20 }),
        makeElement({ id: "a", index: "a1", seed: 10 }),
      ],
    };
    const a = new Y.Doc();
    const b = new Y.Doc();
    populateYDoc(forward, a);
    populateYDoc(reversed, b);
    expect(hashDocState(a)).toBe(hashDocState(b));
  });

  it("ignores per-peer reconciliation metadata (version/versionNonce/updated)", () => {
    // Two docs with identical content but elements carrying wildly different
    // version/versionNonce/updated must hash the same — those fields are local
    // render metadata, never part of doc content (RECONCILE_META_KEYS).
    const a = new Y.Doc();
    const b = new Y.Doc();
    populateYDoc(
      {
        elements: [makeElement({ id: "x", index: "a1", seed: 7, version: 1 })],
      },
      a,
    );
    populateYDoc(
      {
        elements: [
          makeElement({
            id: "x",
            index: "a1",
            seed: 7,
            version: 999,
            versionNonce: 123456,
            updated: 42,
          }),
        ],
      },
      b,
    );
    expect(hashDocState(a)).toBe(hashDocState(b));
  });

  it("differs on the only content change being an element index (sanity)", () => {
    // Same element + seed; only the fractional index differs → different content.
    const a = new Y.Doc();
    const b = new Y.Doc();
    populateYDoc(
      { elements: [makeElement({ id: "a", index: "a1", seed: 5 })] },
      a,
    );
    populateYDoc(
      { elements: [makeElement({ id: "a", index: "a2", seed: 5 })] },
      b,
    );
    expect(hashDocState(a)).not.toBe(hashDocState(b));
  });

  it("an empty doc hashes stably (and not equal to a populated one)", () => {
    const empty = new Y.Doc();
    const full = new Y.Doc();
    populateYDoc(scene(), full);
    expect(hashDocState(empty)).toBe(hashDocState(new Y.Doc()));
    expect(hashDocState(empty)).not.toBe(hashDocState(full));
  });
});
