import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

/**
 * INV-ONE-BROADCAST (spec 002, FR-017) — one logical mutation must reach peers as
 * ONE transport message.
 *
 * Creating an element is deliberately two local transactions under two origins,
 * and that shape is load-bearing for UNDO, not for Store reconciliation: a
 * `LOCAL` structural add would let `UndoManager` hard-remove the element on undo,
 * losing the tombstone/content/binding identity, while a wholly `STRUCTURAL`
 * create would not be undoable at all. Yjs cannot give nested parts of one
 * transaction different origins, so born-tombstoned STRUCTURAL prelude + tracked
 * LOCAL reveal is correct locally.
 *
 * What is NOT correct is that `onDocUpdate` broadcasts each non-REMOTE
 * transaction as it commits, so the two halves leave as two messages. A peer
 * applies two REMOTE transactions, bumps meta twice, recomputes twice, and can
 * manufacture two Store increments for one logical creation. Tombstone-first
 * hides the intermediate state visually; it does not make the mutation atomic on
 * the wire.
 */

const rect = (id: string): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

describe("INV-ONE-BROADCAST — one logical mutation, one transport message", () => {
  it("a pure property change emits exactly one", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);
    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.mutateElement(scene.getElement("a")!, { x: 42 });

    expect(updates.length).toBe(1);
    scene.destroy();
  });

  // WAS a confirmed defect, and this test was SKIPPED while it stood: a creation
  // emitted 2 — the STRUCTURAL tombstone prelude and the LOCAL reveal each
  // broadcast on commit. The Scene-level logical-mutation boundary fixed it by
  // capturing the pre-action state vector, suppressing delivery across both
  // transactions, and emitting ONE delta from that vector after the reveal.
  // Contract: specs/002-native-yjs-lineage/spec.md FR-017.
  it("an element creation emits exactly one", () => {
    const scene = new Scene();
    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.replaceAllElements([rect("a")]);

    expect(updates.length).toBe(1);
    scene.destroy();
  });

  it("nested boundaries JOIN — only the outermost publishes", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    // The peer must hold the pre-boundary state: these updates are INCREMENTAL,
    // so without the parent structs the writes queue as pending and integrate
    // into nothing.
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(scene.encodeStateAsUpdate());

    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.beginLogicalMutation();
    try {
      // each of these opens its own inner boundary
      scene.replaceAllElements([rect("a"), rect("b")]);
      scene.replaceAllElements([rect("a"), rect("b"), rect("c")]);
      expect(updates).toHaveLength(0); // nothing escapes while the outer is open
    } finally {
      scene.endLogicalMutation();
    }

    expect(updates).toHaveLength(1);
    // and the single message carries the FINAL state, not an intermediate one
    peer.applyRemoteUpdate(updates[0]);
    expect(
      peer
        .getElementsIncludingDeleted()
        .filter((e) => !e.isDeleted)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);

    scene.destroy();
    peer.destroy();
  });

  it("a throw after a write still publishes what was committed", () => {
    // Yjs has already committed those bytes; withholding them would diverge the
    // peer permanently, so the balanced close in `finally` publishes them.
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(scene.encodeStateAsUpdate());

    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    expect(() => {
      scene.beginLogicalMutation();
      try {
        scene.replaceAllElements([rect("a"), rect("b")]);
        throw new Error("mid-action failure");
      } finally {
        scene.endLogicalMutation();
      }
    }).toThrow("mid-action failure");

    expect(updates).toHaveLength(1);
    peer.applyRemoteUpdate(updates[0]);
    expect(
      peer
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);

    scene.destroy();
    peer.destroy();
  });

  it("a boundary with no writes publishes NOTHING", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    scene.beginLogicalMutation();
    scene.endLogicalMutation();

    expect(updates).toHaveLength(0);
    scene.destroy();
  });

  it("closing without opening throws", () => {
    const scene = new Scene();
    expect(() => scene.endLogicalMutation()).toThrow(/no logical mutation/);
    scene.destroy();
  });
});
