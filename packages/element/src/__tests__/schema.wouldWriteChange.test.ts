import * as Y from "yjs";

import { wouldWriteChange, writeChangedKeys } from "../yjs/schema";

import type { ElementRecord } from "../yjs/schema";

/**
 * `wouldWriteChange` is the SOLE predicate for "would a scoped write of this key
 * change the document". `writeChangedKeys` consults it first for every key, and
 * ambiguous-overlap detection consults the same function — so the writer and the
 * conflict detector cannot drift apart.
 *
 * These pin the branches that a `JSON.stringify` comparison would get wrong.
 */
describe("wouldWriteChange", () => {
  const mapWith = (entries: Record<string, unknown>) => {
    const doc = new Y.Doc();
    const ymap = doc.getMap<unknown>("m");
    for (const [k, v] of Object.entries(entries)) {
      ymap.set(k, v);
    }
    return ymap;
  };

  it("is false for an equal scalar and true for a different one", () => {
    const ymap = mapWith({ x: 5 });
    expect(wouldWriteChange(ymap, { x: 5 } as ElementRecord, "x")).toBe(false);
    expect(wouldWriteChange(ymap, { x: 6 } as ElementRecord, "x")).toBe(true);
  });

  it("treats an explicit undefined as a DELETE only when the key is present", () => {
    const present = mapWith({ link: "https://x" });
    expect(
      wouldWriteChange(present, { link: undefined } as ElementRecord, "link"),
    ).toBe(true);

    const absent = mapWith({});
    // Nothing to clear — writing would be a no-op.
    expect(
      wouldWriteChange(absent, { link: undefined } as ElementRecord, "link"),
    ).toBe(false);
  });

  it("compares JSON leaves by VALUE, not by key order", () => {
    // `JSON.stringify` would report these as different; deepEqual does not.
    const ymap = mapWith({ customData: { a: 1, b: 2 } });
    expect(
      wouldWriteChange(
        ymap,
        { customData: { b: 2, a: 1 } } as unknown as ElementRecord,
        "customData",
      ),
    ).toBe(false);
    expect(
      wouldWriteChange(
        ymap,
        { customData: { a: 1, b: 3 } } as unknown as ElementRecord,
        "customData",
      ),
    ).toBe(true);
  });

  it("uses SET semantics for boundElements", () => {
    const doc = new Y.Doc();
    const ymap = doc.getMap<unknown>("m");
    writeChangedKeys(ymap, {
      id: "e",
      boundElements: [
        { id: "t", type: "text" },
        { id: "a", type: "arrow" },
      ],
    } as unknown as ElementRecord);

    // Same set, different order — not a change.
    expect(
      wouldWriteChange(
        ymap,
        {
          boundElements: [
            { id: "a", type: "arrow" },
            { id: "t", type: "text" },
          ],
        } as unknown as ElementRecord,
        "boundElements",
      ),
    ).toBe(false);

    // A removal, an addition and a type change are each changes.
    for (const next of [
      [{ id: "t", type: "text" }],
      [
        { id: "t", type: "text" },
        { id: "a", type: "arrow" },
        { id: "z", type: "text" },
      ],
      [
        { id: "t", type: "arrow" },
        { id: "a", type: "arrow" },
      ],
      null,
    ]) {
      expect(
        wouldWriteChange(
          ymap,
          { boundElements: next } as unknown as ElementRecord,
          "boundElements",
        ),
      ).toBe(true);
    }
  });

  it("never reports reconciliation metadata as a change", () => {
    const ymap = mapWith({ x: 1 });
    for (const key of ["version", "versionNonce", "updated"]) {
      expect(
        wouldWriteChange(ymap, { [key]: 99999 } as ElementRecord, key),
      ).toBe(false);
    }
  });

  it("agrees with what writeChangedKeys actually writes", () => {
    const doc = new Y.Doc();
    const ymap = doc.getMap<unknown>("m");
    const record = {
      id: "e",
      x: 1,
      customData: { a: 1 },
    } as unknown as ElementRecord;

    expect(writeChangedKeys(ymap, record)).toBeGreaterThan(0);
    // Re-writing the identical record predicts — and performs — nothing.
    for (const key of ["x", "customData"]) {
      expect(wouldWriteChange(ymap, record, key)).toBe(false);
    }
    expect(writeChangedKeys(ymap, record)).toBe(0);
  });
});
