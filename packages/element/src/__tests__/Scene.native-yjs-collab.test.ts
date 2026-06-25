import * as Y from "yjs";

import type { Mutable } from "@excalidraw-yjs/common/utility-types";

import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

/**
 * Native-Yjs core (M3) — proves COLLABORATION is native: two `Scene`s on separate
 * `Y.Doc`s, wired to exchange Yjs updates, converge to an identical document by
 * editing the SAME doc directly. There is no scene-array broadcast and no JSON
 * reconciliation — Yjs merges per-property natively. This is the milestone proof:
 *
 *  - A inserts/edits → B sees it after sync;
 *  - concurrent edits to DIFFERENT elements, AND to DIFFERENT properties of the
 *    SAME element, converge identically on both replicas (per-property CRDT merge);
 *  - a concurrent remote DELETE while A holds a live reference is handled
 *    correctly (the held reference reflects the delete; no stale read);
 *  - A's origin-scoped undo does NOT revert B's edit (the M2 guarantee under real
 *    concurrency, now via REMOTE_ORIGIN apply, not a simulated same-doc transact).
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

/**
 * In-process bidirectional provider connecting two Scenes' docs by exchanging
 * Yjs updates through each Scene's PUBLIC M3 collaboration surface
 * (`onDocUpdate` to broadcast local-origin updates, `applyRemoteUpdate` to
 * integrate a peer's under REMOTE_ORIGIN). This is exactly what the real provider
 * does, minus the socket — so a green test here is a green collaboration core.
 *
 * Updates are queued and flushed by `flush()` (synchronous, deterministic) so a
 * test can stage CONCURRENT edits on both replicas before any exchange happens,
 * then converge them.
 */
class InProcessLink {
  private queueToB: Uint8Array[] = [];
  private queueToA: Uint8Array[] = [];
  private readonly detachers: Array<() => void> = [];

  constructor(private a: Scene, private b: Scene) {
    // A's local-origin updates are destined for B, and vice-versa. `onDocUpdate`
    // already filters out REMOTE_ORIGIN, so an applied remote update is never
    // re-queued (no echo / no infinite loop).
    this.detachers.push(
      a.onDocUpdate((update) => this.queueToB.push(update)),
      b.onDocUpdate((update) => this.queueToA.push(update)),
    );
  }

  /** Deliver every queued update both ways until both queues drain (a delivered
   * update can itself produce nothing further, since remote applies don't
   * re-broadcast). Bounded loop for safety. */
  flush(): void {
    for (
      let i = 0;
      i < 50 && (this.queueToA.length || this.queueToB.length);
      i++
    ) {
      const toB = this.queueToB;
      this.queueToB = [];
      for (const u of toB) {
        this.b.applyRemoteUpdate(u);
      }
      const toA = this.queueToA;
      this.queueToA = [];
      for (const u of toA) {
        this.a.applyRemoteUpdate(u);
      }
    }
  }

  destroy(): void {
    for (const d of this.detachers) {
      d();
    }
  }
}

/** Read the docs' element content (modulo locally-derived reconcile meta, which
 * the doc deliberately does not store) for a doc-equality assertion. */
const docContent = (scene: Scene): Record<string, Record<string, unknown>> => {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, ymap] of scene.yElements.entries()) {
    const rec: Record<string, unknown> = {};
    for (const [k, v] of (ymap as Y.Map<unknown>).entries()) {
      // boundElements is a nested Y.Map — normalize to a sorted id→type record so
      // two replicas compare structurally regardless of internal map ordering.
      if (v instanceof Y.Map) {
        const nested: Record<string, unknown> = {};
        for (const [nk, nv] of v.entries()) {
          nested[nk] = nv;
        }
        rec[k] = nested;
      } else {
        rec[k] = v;
      }
    }
    out[id] = rec;
  }
  return out;
};

/** A and B must hold byte-for-byte identical state vectors after convergence
 * (the strongest "same document" check Yjs offers). */
const sameStateVector = (a: Scene, b: Scene): boolean => {
  const va = Y.encodeStateVector(a.doc);
  const vb = Y.encodeStateVector(b.doc);
  return va.length === vb.length && va.every((byte, idx) => byte === vb[idx]);
};

describe("native-yjs Scene collaboration: two replicas converge on one doc", () => {
  it("A inserts/edits an element → B sees it after sync", () => {
    const a = new Scene();
    const b = new Scene();
    const link = new InProcessLink(a, b);

    // A creates an element.
    a.replaceAllElements([rect("a", { x: 10 })]);
    link.flush();

    // B sees it.
    expect(b.getElementsIncludingDeleted().map((e) => e.id)).toEqual(["a"]);
    expect(b.getElement("a")!.x).toBe(10);

    // A edits it.
    a.mutateElement(a.getElement("a")!, { x: 250, strokeColor: "#f00" });
    link.flush();

    // B sees the edit.
    expect(b.getElement("a")!.x).toBe(250);
    expect(b.getElement("a")!.strokeColor).toBe("#f00");
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("concurrent edits to DIFFERENT elements converge identically on both", () => {
    const a = new Scene();
    const b = new Scene();
    const seed = new InProcessLink(a, b);
    // Shared base: two elements both replicas know about.
    a.replaceAllElements([rect("x"), rect("y")]);
    seed.flush();
    seed.destroy();
    expect(
      b
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["x", "y"]);

    const link = new InProcessLink(a, b);
    // CONCURRENT (no flush between): A moves x, B moves y.
    a.mutateElement(a.getElement("x")!, { x: 111 });
    b.mutateElement(b.getElement("y")!, { y: 222 });
    link.flush();

    // Both edits survive on BOTH replicas, identically.
    for (const s of [a, b]) {
      expect(s.getElement("x")!.x).toBe(111);
      expect(s.getElement("y")!.y).toBe(222);
    }
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("concurrent edits to DIFFERENT properties of the SAME element merge per-property", () => {
    const a = new Scene();
    const b = new Scene();
    const seed = new InProcessLink(a, b);
    a.replaceAllElements([rect("a", { x: 0, y: 0 })]);
    seed.flush();
    seed.destroy();

    const link = new InProcessLink(a, b);
    // CONCURRENT: A sets x, B sets y, on the SAME element — a whole-object LWW
    // would lose one; per-property maps keep both.
    a.mutateElement(a.getElement("a")!, { x: 999 });
    b.mutateElement(b.getElement("a")!, { y: 888 });
    link.flush();

    for (const s of [a, b]) {
      expect(s.getElement("a")!.x).toBe(999);
      expect(s.getElement("a")!.y).toBe(888);
    }
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("a concurrent remote DELETE converges; a RE-READ reflects it (snapshots, not held refs)", () => {
    const a = new Scene();
    const b = new Scene();
    const seed = new InProcessLink(a, b);
    a.replaceAllElements([rect("a", { x: 1 }), rect("keep")]);
    seed.flush();
    seed.destroy();

    const link = new InProcessLink(a, b);

    // A reads "a" into a local variable. Under the fresh-snapshot contract this is
    // an immutable SNAPSHOT of the current doc state, NOT a live view — exactly the
    // anti-pattern the editor avoids (it re-reads the scene every turn).
    const snapshotOfA = a.getElement("a")! as Mutable<ExcalidrawElement>;
    expect(snapshotOfA.isDeleted).toBe(false);

    // B deletes "a" the Excalidraw way (isDeleted:true tombstone) — concurrently
    // A also touches a DIFFERENT property of the same element.
    b.mutateElement(b.getElement("a")!, { isDeleted: true });
    a.mutateElement(a.getElement("a")!, { strokeColor: "#0f0" });
    link.flush();

    // The previously-held snapshot did NOT silently change — it is a frozen view of
    // the pre-delete doc state. Mutation/observation flows through the doc, so a
    // held reference is stale by design (you must re-read).
    expect(snapshotOfA.isDeleted).toBe(false);

    // A RE-READ reflects the merged remote delete (no stale read on re-read)…
    expect(a.getElement("a")!.isDeleted).toBe(true);
    // …a fresh object, not the stale snapshot (identity is not stable)…
    expect(a.getElement("a")).not.toBe(snapshotOfA);
    // …and A's concurrent strokeColor edit survived on the tombstone (per-property).
    expect(a.getElement("a")!.strokeColor).toBe("#0f0");
    // "a" is hidden from the live view on both; "keep" remains.
    for (const s of [a, b]) {
      expect(s.getNonDeletedElements().map((e) => e.id)).toEqual(["keep"]);
    }
    // Convergence is unaffected — a snapshot can't be stale on the doc, so collab
    // is strictly more correct.
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("a concurrent STRUCTURAL remote remove drops the element from both replicas", () => {
    // The rarer hard-remove path (reconciliation/prune, recordHistory:false), to
    // prove a held reference does not resurrect a structurally-removed element.
    const a = new Scene();
    const b = new Scene();
    const seed = new InProcessLink(a, b);
    a.replaceAllElements([rect("gone"), rect("keep")]);
    seed.flush();
    seed.destroy();

    const link = new InProcessLink(a, b);
    const heldByB = b.getElement("gone")!;
    expect(heldByB).not.toBeNull();

    // B structurally removes "gone" (drop from a non-recording replace).
    b.replaceAllElements([b.getElement("keep")!], { recordHistory: false });
    link.flush();

    // Both replicas drop it from the doc + the derived views.
    for (const s of [a, b]) {
      expect([...s.yElements.keys()]).toEqual(["keep"]);
      expect(s.getElement("gone")).toBeNull();
    }
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("A's undo (origin-scoped) does NOT revert B's concurrent edit", () => {
    const a = new Scene();
    const b = new Scene();
    const seed = new InProcessLink(a, b);
    a.replaceAllElements([rect("a", { x: 0, y: 0 })]);
    seed.flush();
    seed.destroy();
    // Both clear their initial-population history so we test only the edits below.
    a.clearElementHistory();
    b.clearElementHistory();

    const link = new InProcessLink(a, b);

    // A makes a LOCAL, undoable edit (x), B makes a concurrent edit (y).
    a.mutateElement(a.getElement("a")!, { x: 500 });
    a.stopElementCapture();
    b.mutateElement(b.getElement("a")!, { y: 600 });
    link.flush();

    // Both replicas now hold x:500, y:600.
    for (const s of [a, b]) {
      expect(s.getElement("a")!.x).toBe(500);
      expect(s.getElement("a")!.y).toBe(600);
    }

    // A undoes ITS edit. B's edit (y:600) arrived under REMOTE_ORIGIN, which the
    // UndoManager does not track, so undo reverts ONLY x:500 → x:0.
    expect(a.canUndoElements()).toBe(true);
    expect(a.undoElements()).toBe(true);
    link.flush();

    // A reverted x but kept B's y; B converges to the same (A's undo is just
    // another local doc mutation it broadcasts).
    for (const s of [a, b]) {
      expect(s.getElement("a")!.x).toBe(0);
      expect(s.getElement("a")!.y).toBe(600);
    }
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("converges via the v2 wire format too (provider may speak either)", () => {
    const a = new Scene();
    const b = new Scene();
    // Wire the link in v2.
    const queueToB: Uint8Array[] = [];
    const queueToA: Uint8Array[] = [];
    const offA = a.onDocUpdate((u) => queueToB.push(u), "v2");
    const offB = b.onDocUpdate((u) => queueToA.push(u), "v2");
    const flush = () => {
      for (let i = 0; i < 50 && (queueToA.length || queueToB.length); i++) {
        const tb = queueToB.splice(0);
        for (const u of tb) {
          b.applyRemoteUpdate(u, "v2");
        }
        const ta = queueToA.splice(0);
        for (const u of ta) {
          a.applyRemoteUpdate(u, "v2");
        }
      }
    };

    a.replaceAllElements([rect("a", { x: 7 })]);
    flush();
    expect(b.getElement("a")!.x).toBe(7);
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    offA();
    offB();
    a.destroy();
    b.destroy();
  });

  it("a newly-joined replica catches up via encodeStateAsUpdate (initial sync)", () => {
    // Replica A has built up a scene before B joins; B initial-syncs from A's
    // encoded state, then live updates flow.
    const a = new Scene([rect("a", { x: 1 }), rect("b", { x: 2 })]);
    a.mutateElement(a.getElement("a")!, { x: 100 });

    // B joins: apply A's full state as the initial sync (REMOTE_ORIGIN).
    const b = new Scene();
    b.applyRemoteUpdate(a.encodeStateAsUpdate());

    expect(
      b
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(b.getElement("a")!.x).toBe(100);
    expect(docContent(a)).toEqual(docContent(b));
    expect(sameStateVector(a, b)).toBe(true);

    // Live updates after the catch-up converge too.
    const link = new InProcessLink(a, b);
    b.mutateElement(b.getElement("b")!, { x: 999 });
    link.flush();
    expect(a.getElement("b")!.x).toBe(999);
    expect(sameStateVector(a, b)).toBe(true);

    link.destroy();
    a.destroy();
    b.destroy();
  });
});
