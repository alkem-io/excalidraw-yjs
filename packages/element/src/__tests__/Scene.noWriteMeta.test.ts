import { Scene } from "../Scene";
import { newElement } from "../newElement";

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
 * The NO-WRITE meta rule (T014b, split out as its own property).
 *
 * A bulk replace whose document content is IDENTICAL, but whose carried
 * reconciliation metadata differs, must be a no-op for everything the doc
 * derives: no element is changed, so no version/nonce/updated may move. Own
 * Symbols are the exception — they live on the caller's object rather than in
 * the document, so they legitimately refresh.
 *
 * The violation was REACHABLE before the rule landed: a bulk replace with
 * UNCHANGED content but a stale carried version drove `version` 2 -> -1 and
 * `updated` 1 -> 999, both taken verbatim — a regression with no content change
 * to justify any movement at all.
 *
 * Scope of the `updated` half, stated precisely: it corrupted the LOCAL derived
 * element only. The durable deletion marker was never affected —
 * `syncDeletionMarker` stamps solely on the live->deleted transition and never
 * restamps — so this was not a tombstone-expiry extension.
 *
 * TWO fields must still refresh on a zero-write replace, and freezing everything
 * would be too broad:
 *  - `symbols`, which live on the caller's object rather than in the doc;
 *  - `boundElementsEmpty`, because the CRDT collapses `boundElements: []` and
 *    `null` into the same empty representation, so this sentinel is the ONLY
 *    carrier of that distinction — switching between them is a legitimate change
 *    that produces zero Yjs writes.
 */
describe("no-write bulk replace leaves doc-derived meta alone", () => {
  it("does not move version/updated when the content is unchanged", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 5 })]);

    const before = scene.getElement("a")!;

    // The SAME content, re-submitted carrying different reconciliation metadata —
    // what a stale action array looks like when its element did not change.
    scene.replaceAllElements([
      { ...before, version: before.version - 3, updated: 999 } as never,
    ]);

    const after = scene.getElement("a")!;

    // GUARD: still the same element, so this is not comparing against a drop.
    expect(after.id).toBe("a");
    expect(after.x).toBe(5);

    expect(after.version).toBe(before.version);
    expect(after.updated).toBe(before.updated);
    expect(after.versionNonce).toBe(before.versionNonce);
  });

  it("does not move meta when the SAME object is re-submitted verbatim", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 5 })]);
    const before = scene.getElement("a")!;

    scene.replaceAllElements([before]);

    const after = scene.getElement("a")!;
    expect(after.version).toBe(before.version);
    expect(after.updated).toBe(before.updated);
    expect(after.versionNonce).toBe(before.versionNonce);
  });

  /**
   * The collapsed representation, both directions. `[]` and `null` are the same
   * thing in the document, so these transitions write NOTHING — yet the derived
   * element must still follow the caller, and no element change may be observed.
   */
  it("follows a null -> [] boundElements switch with no doc write", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { boundElements: null })]);
    const before = scene.getElement("a")!;
    expect(before.boundElements).toBeNull();

    scene.replaceAllElements([{ ...before, boundElements: [] } as never]);

    const after = scene.getElement("a")!;
    expect(after.boundElements).toEqual([]);
    // No content changed in the doc, so the reconciliation metadata must not move.
    expect(after.version).toBe(before.version);
    expect(after.updated).toBe(before.updated);
  });

  it("follows a [] -> null boundElements switch with no doc write", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { boundElements: [] })]);
    const before = scene.getElement("a")!;
    expect(before.boundElements).toEqual([]);

    scene.replaceAllElements([{ ...before, boundElements: null } as never]);

    const after = scene.getElement("a")!;
    expect(after.boundElements).toBeNull();
    expect(after.version).toBe(before.version);
    expect(after.updated).toBe(before.updated);
  });

  it("still refreshes own Symbols on a no-write replace", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 5 })]);
    const before = scene.getElement("a")!;

    const TAG = Symbol.for("test.origId");
    const carrier = { ...before };
    Object.defineProperty(carrier, TAG, {
      value: "from-caller",
      enumerable: false,
      configurable: true,
    });

    scene.replaceAllElements([carrier as never]);

    // Symbols live on the caller's object, not the doc, so they must reach the
    // freshly derived snapshot even though nothing was written.
    const derived = scene.getElement("a") as unknown as Record<symbol, unknown>;
    expect(derived[TAG]).toBe("from-caller");
    expect(scene.getElement("a")!.version).toBe(before.version);
  });
});
