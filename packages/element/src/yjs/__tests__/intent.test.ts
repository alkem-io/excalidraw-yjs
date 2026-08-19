import { newElement } from "../../newElement";
import {
  captureElementBase,
  computeElementIntent,
  diffElementKeys,
} from "../intent";
import { deepEqual } from "../schema";

import type { ElementRecord } from "../schema";

const rec = (id: string, o: Record<string, unknown> = {}): ElementRecord =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    } as Parameters<typeof newElement>[0]) as unknown as ElementRecord),
    ...o,
  } as ElementRecord);

describe("presence-aware intent diff (FR-016 / T016b)", () => {
  it("a no-op action derives NO intent", () => {
    // Guards against canonicalization manufacturing intent: the base is copied
    // from the canonical Scene snapshot, so optional defaults must already be
    // present on both sides and diff empty.
    const base = rec("a");
    const result = { ...base };
    expect([...diffElementKeys(base, result)]).toEqual([]);

    const intent = computeElementIntent([base], [result]);
    expect(intent.added).toEqual([]);
    expect(intent.deleted).toEqual([]);
    expect(intent.changed.size).toBe(0);
  });

  it("a changed value is intent", () => {
    const base = rec("a", { x: 0 });
    const result = rec("a", { x: 50 });
    expect(diffElementKeys(base, result).has("x")).toBe(true);
  });

  it("a key ABSENT in base and present in result is intent — even when undefined", () => {
    // The case a value-only diff misses: `deepEqual(undefined, undefined)` is
    // true, so this would derive no intent and lose to a doc value introduced
    // after the base was captured.
    const base: ElementRecord = { id: "a" };
    const withValue: ElementRecord = { id: "a", link: "https://example.com" };
    const withUndefined: ElementRecord = { id: "a", link: undefined };

    expect(diffElementKeys(base, withValue).has("link")).toBe(true);
    expect(diffElementKeys(base, withUndefined).has("link")).toBe(true);
  });

  it("a key present in base and DROPPED from result is intent (a deletion)", () => {
    const base: ElementRecord = { id: "a", link: "https://example.com" };
    const dropped: ElementRecord = { id: "a" };
    expect(diffElementKeys(base, dropped).has("link")).toBe(true);
  });

  it("equal values on both sides derive NO intent (the known asymmetry)", () => {
    // An explicit same-value assignment is invisible to any derived diff. It
    // requires the explicit-intent channel; pinned here so the boundary is
    // recorded rather than assumed.
    const base: ElementRecord = { id: "a", x: 7 };
    const result: ElementRecord = { id: "a", x: 7 };
    expect([...diffElementKeys(base, result)]).toEqual([]);
  });

  it("excludes id and the reconciliation metadata keys", () => {
    const base: ElementRecord = {
      id: "a",
      version: 1,
      versionNonce: 1,
      updated: 1,
    };
    const result: ElementRecord = {
      id: "a",
      version: 99,
      versionNonce: 99,
      updated: 99,
    };
    expect([...diffElementKeys(base, result)]).toEqual([]);
  });

  it("does not treat prototype-chain keys as present", () => {
    // `key in base` would see an inherited key; `Object.hasOwn` correctly reports
    // an absent->present transition. The distinction matters because a base whose
    // prototype carried the same value would otherwise derive NOTHING.
    const base = Object.create({ inherited: "nope" }) as ElementRecord;
    base.id = "a";
    const result: ElementRecord = { id: "a", inherited: "yes" };
    expect(diffElementKeys(base, result).has("inherited")).toBe(true);
  });

  it("NON-VACUITY: a value-only diff would miss both presence transitions", () => {
    // Proves presence-awareness is load-bearing rather than defensive. If these
    // assertions ever fail, `deepEqual` changed and the presence checks may be
    // redundant — but until then a plain value comparison derives NO intent for
    // either transition, and the action's write would lose to whatever another
    // writer put in the doc after the base was captured.
    const base: ElementRecord = { id: "a" };
    const explicitUndefined: ElementRecord = { id: "a", link: undefined };
    expect(deepEqual(base.link, explicitUndefined.link)).toBe(true);

    const hadValue: ElementRecord = { id: "a", link: "https://example.com" };
    const dropped: ElementRecord = { id: "a" };
    expect(deepEqual(hadValue.link, dropped.link)).toBe(false); // this one a value diff DOES see
    // ...but null/undefined conflation hides the equivalent nullish transition:
    expect(deepEqual(null, undefined)).toBe(true);
  });

  it("tracks membership: added and deleted ids", () => {
    const a = rec("a");
    const b = rec("b");
    const intent = computeElementIntent([a, b], [a, rec("c")]);
    expect(intent.added.map((e) => e.id)).toEqual(["c"]);
    expect(intent.deleted).toEqual(["b"]);
    expect(intent.changed.size).toBe(0);
  });
});

describe("captureElementBase — the invocation snapshot (FR-016 / T016a)", () => {
  it("does not alias NESTED persisted fields", () => {
    // The failure a top-level spread produces: the nested array is shared, so a
    // later in-place mutation changes the "before" image too and the key diffs
    // as UNCHANGED — deriving no intent for a real change.
    const live: ElementRecord = {
      id: "a",
      groupIds: ["g1"],
      boundElements: [{ id: "t1", type: "text" }],
      customData: { nested: { deep: 1 } },
    };
    const [base] = captureElementBase([live]);

    (live.groupIds as string[]).push("g2");
    (live.boundElements as { id: string }[])[0].id = "CHANGED";
    ((live.customData as any).nested as any).deep = 99;

    expect(base.groupIds).toEqual(["g1"]);
    expect((base.boundElements as { id: string }[])[0].id).toBe("t1");
    expect(((base.customData as any).nested as any).deep).toBe(1);

    // ...and the diff therefore SEES the change, which is the point.
    expect(diffElementKeys(base, live).has("groupIds")).toBe(true);
    expect(diffElementKeys(base, live).has("boundElements")).toBe(true);
    expect(diffElementKeys(base, live).has("customData")).toBe(true);
  });

  it("NON-VACUITY: a top-level spread WOULD alias and miss those changes", () => {
    const live: ElementRecord = { id: "a", groupIds: ["g1"] };
    const shallow = { ...live } as ElementRecord;
    (live.groupIds as string[]).push("g2");
    // The shallow copy tracked the mutation, so the diff sees nothing.
    expect(shallow.groupIds).toEqual(["g1", "g2"]);
    expect([...diffElementKeys(shallow, live)]).toEqual([]);
  });

  it("preserves own Symbol properties that a spread and structuredClone drop", () => {
    const ORIG_ID = Symbol("ORIG_ID");
    const live: ElementRecord = { id: "a" };
    Object.defineProperty(live, ORIG_ID, {
      value: "original",
      enumerable: false,
    });

    const [base] = captureElementBase([live]);
    expect((base as any)[ORIG_ID]).toBe("original");
    expect({ ...live }[ORIG_ID as any]).toBeUndefined(); // a spread loses it
  });
});
