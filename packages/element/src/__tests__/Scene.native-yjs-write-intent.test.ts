import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type * as Y from "yjs";

import type { ExcalidrawElement } from "../types";

/**
 * INV-WRITE-INTENT (spec 002 / US8 / FR-009) — a doc write modifies exactly the
 * keys the caller declared in `updates`, never a key that merely DIFFERS between
 * the caller's element and the doc, however stale that element is.
 *
 * Why the existing per-property merge test (`Scene.native-yjs-collab.test.ts`)
 * does not cover this: it reads `getElement(id)` immediately before mutating, so
 * the scratch element matches its own doc and only the intended key differs. The
 * real editor does the opposite — `state.newElement`, `state.multiElement` and
 * the public `ExcalidrawImperativeAPI.mutateElement` all hold a reference ACROSS
 * frames, so a peer's update lands in the local doc while the reference is held.
 *
 * `writeChangedKeys(ymap, element)` currently iterates `Object.keys(element)` and
 * writes back every key differing from the doc, so that held reference silently
 * reverts the peer's edit — whole-element LWW with the CRDT lineage perfectly
 * intact. Fixing the wire/persistence/cold-load boundaries does not touch it.
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

/** Bidirectional in-process provider over the public M3 surface (mirrors the one
 * in `Scene.native-yjs-collab.test.ts`). */
class InProcessLink {
  private queueToB: Uint8Array[] = [];
  private queueToA: Uint8Array[] = [];
  private readonly detachers: Array<() => void> = [];

  constructor(private a: Scene, private b: Scene) {
    this.detachers.push(
      a.onDocUpdate((update) => this.queueToB.push(update)),
      b.onDocUpdate((update) => this.queueToA.push(update)),
    );
  }

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

/** A and B synced on one element, with a live link left connected. */
const syncedPair = (element: ExcalidrawElement) => {
  const a = new Scene();
  const b = new Scene();
  const seed = new InProcessLink(a, b);
  a.replaceAllElements([element]);
  seed.flush();
  seed.destroy();
  return { a, b, link: new InProcessLink(a, b) };
};

describe("INV-WRITE-INTENT — a write touches only the declared keys", () => {
  it("a scalar edit through a reference held across a peer's edit does not revert it", () => {
    const { a, b, link } = syncedPair(rect("a", { strokeColor: "#000000" }));

    // A holds a reference — as the editor does across a drag frame.
    const heldByA = a.getElement("a")!;

    // B recolours; the update reaches A's doc while A still holds `heldByA`.
    b.mutateElement(b.getElement("a")!, { strokeColor: "#00ff00" });
    link.flush();
    expect(a.getElement("a")!.strokeColor).toBe("#00ff00");

    // A now moves the element through the STALE reference. Intent: `x` only.
    a.mutateElement(heldByA, { x: 50 });
    link.flush();

    for (const s of [a, b]) {
      expect(s.getElement("a")!.x).toBe(50);
      // The key A never asked to change must still hold B's value.
      expect(s.getElement("a")!.strokeColor).toBe("#00ff00");
    }

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("a JSON-leaf key (groupIds) is not reverted by an unrelated edit", () => {
    const { a, b, link } = syncedPair(rect("a", { groupIds: [] }));

    const heldByA = a.getElement("a")!;

    b.mutateElement(b.getElement("a")!, { groupIds: ["g1"] });
    link.flush();
    expect(a.getElement("a")!.groupIds).toEqual(["g1"]);

    a.mutateElement(heldByA, { y: 25 });
    link.flush();

    for (const s of [a, b]) {
      expect(s.getElement("a")!.y).toBe(25);
      expect(s.getElement("a")!.groupIds).toEqual(["g1"]);
    }

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("the declared key IS written even when the held reference is stale elsewhere", () => {
    // The dual of the above: scoping writes to the intent set must not cause the
    // intended edit itself to be dropped.
    const { a, b, link } = syncedPair(
      rect("a", { strokeColor: "#000000", backgroundColor: "#ffffff" }),
    );

    const heldByA = a.getElement("a")!;

    b.mutateElement(b.getElement("a")!, { strokeColor: "#00ff00" });
    link.flush();

    a.mutateElement(heldByA, { backgroundColor: "#ff0000" });
    link.flush();

    for (const s of [a, b]) {
      expect(s.getElement("a")!.backgroundColor).toBe("#ff0000");
      expect(s.getElement("a")!.strokeColor).toBe("#00ff00");
    }

    link.destroy();
    a.destroy();
    b.destroy();
  });

  it("writes only the declared keys into the doc map (direct doc assertion)", () => {
    // Boundary-free statement of the invariant: no peer, no link — just a doc
    // whose value for an undeclared key was changed behind the held reference.
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { strokeColor: "#000000" })]);

    const held = scene.getElement("a")!;

    // Change `strokeColor` directly in the doc, simulating any writer that is not
    // this caller (a peer apply, an undo, a concurrent local path).
    const ymap = scene.yElements.get("a") as Y.Map<unknown>;
    scene.doc.transact(() => {
      ymap.set("strokeColor", "#00ff00");
    });

    scene.mutateElement(held, { x: 7 });

    expect(ymap.get("x")).toBe(7);
    expect(ymap.get("strokeColor")).toBe("#00ff00");

    scene.destroy();
  });

  it("applies a declared write whose value equals the HELD copy but not the doc", () => {
    // Found by independent review of the first cut of FR-009, and pre-existing
    // before it. The unchanged-value checks in `mutateElement` compare against
    // the caller's element, which may be behind the doc — so setting a property
    // back to the value the stale copy already shows looked like a no-op and was
    // dropped, even though it is a real declared change to the document.
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const held = scene.getElement("a")!; // x = 0

    const ymap = scene.yElements.get("a") as Y.Map<unknown>;
    scene.doc.transact(() => ymap.set("x", 10)); // another writer moves it

    scene.mutateElement(held, { x: 0 }); // deliberately back to 0

    expect(ymap.get("x")).toBe(0);
    scene.destroy();
  });

  it("does not bump the version when the doc already holds the declared value", () => {
    // The dual of the above: deciding "did anything change" from the stale
    // scratch object is unsound in both directions. Here the scratch DOES change
    // (0 -> 10) so its version bumps, but the doc already held 10, so nothing
    // was written. Recording that bump would advance the element's version with
    // no corresponding change and the Store would report a phantom modification.
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const held = scene.getElement("a")!;

    const ymap = scene.yElements.get("a") as Y.Map<unknown>;
    scene.doc.transact(() => ymap.set("x", 10));

    const versionBefore = scene.getElement("a")!.version;
    scene.mutateElement(held, { x: 10 }); // doc already 10

    expect(scene.getElement("a")!.version).toBe(versionBefore);
    scene.destroy();
  });
});

describe("INV-VERSION-MONOTONIC — meta.version never regresses", () => {
  // SKIPPED — confirmed defect, deliberately not yet fixed. See spec 002 FR-011
  // task T014b and the KNOWN DEFECT comment in `Scene.replaceAllElements`.
  it.skip("a stale-versioned bulk write still out-versions a raised meta", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const base = scene.getElement("a")!;

    // Raise the local meta the way undo/redo and a remote apply do: a doc
    // transaction whose origin is not LOCAL routes through `bumpMetaVersionsFor`.
    const ymap = scene.yElements.get("a") as Y.Map<unknown>;
    scene.doc.transact(() => ymap.set("x", 42));

    const raised = scene.getElement("a")!.version;
    // Guard: if this does not hold the fixture is not exercising the defect at
    // all, and the assertion below would fail for an unrelated reason.
    expect(raised).toBeGreaterThan(base.version);

    // A stale action array now changes a property while carrying the OLD version.
    scene.replaceAllElements([
      { ...base, x: 99, version: base.version } as ExcalidrawElement,
    ]);

    expect(scene.getElement("a")!.x).toBe(99);
    // THE DEFECT: recorded verbatim, so meta regresses below `raised` and
    // `Store.update`'s `prev.version < next.version` gate drops the edit.
    expect(scene.getElement("a")!.version).toBeGreaterThan(raised);
    scene.destroy();
  });
});
