import * as Y from "yjs";

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
 * The action mutation journal (T016b).
 *
 * A `mutateElement` call's `updates` object already IS the writer's explicit
 * per-id/per-key declaration, AND it is the actual write source — so journaling
 * it cannot drift the way a hand-maintained key list beside each helper would.
 *
 * Deliberately a SEPARATE scope from `beginLogicalMutation`: that is a generic
 * transport primitive, and making every logical boundary imply intent capture
 * would couple transport buffering to action semantics.
 */
describe("Scene action mutation journal", () => {
  it("records DECLARED keys even when the value is already equal", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 5 })]);

    scene.beginActionMutationJournal();
    // Same value as the doc already holds: no Yjs write results, but declaring
    // it is still a claim of ownership over that key.
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { x: 5 } as never,
    );

    expect([
      ...((scene.getActionMutationJournal() as Map<string, Set<string>>).get(
        "a",
      ) ?? []),
    ]).toContain("x");
    scene.endActionMutationJournal();
  });

  it("THROWS on a close without an open", () => {
    const scene = new Scene();
    // Loud, not lenient: a no-op would hide caller imbalance, which is the bug.
    expect(() => scene.endActionMutationJournal()).toThrow(
      /without a matching beginActionMutationJournal/,
    );
  });

  it("a throw mid-action still clears the journal for the NEXT action", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    expect(() => {
      scene.beginActionMutationJournal();
      try {
        scene.mutateElement(
          scene.getElement("a" as never)! as never,
          {
            x: 1,
          } as never,
        );
        throw new Error("action blew up");
      } finally {
        scene.endActionMutationJournal();
      }
    }).toThrow("action blew up");

    // No stale declarations survive into the next action.
    expect(scene.getActionMutationJournal().size).toBe(0);
  });

  it("records only the PERSISTED key domain — never id or reconciliation metadata", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 1 })]);
    const live = scene.getElement("a" as never)!;

    scene.beginActionMutationJournal();
    // A broad element object passed as `updates` must not turn `id`/`version`/
    // `versionNonce`/`updated` into action ownership.
    scene.mutateElement(live as never, { ...live, x: 2 } as never);
    const keys = [
      ...((scene.getActionMutationJournal() as Map<string, Set<string>>).get(
        "a",
      ) ?? []),
    ];
    scene.endActionMutationJournal();

    expect(keys).toContain("x");
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("version");
    expect(keys).not.toContain("versionNonce");
    expect(keys).not.toContain("updated");
  });

  it("is empty when no scope is open, and is cleared at end", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { x: 1 } as never,
    );
    expect(scene.getActionMutationJournal().size).toBe(0);

    scene.beginActionMutationJournal();
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { x: 2 } as never,
    );
    expect(scene.getActionMutationJournal().size).toBe(1);

    scene.endActionMutationJournal();
    // A stale journal must not be reusable by the next action.
    expect(scene.getActionMutationJournal().size).toBe(0);
  });

  it("UNIONS nested scopes and clears only at the outermost end", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    scene.beginActionMutationJournal();
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { x: 1 } as never,
    );

    // A nested begin joins the same journal rather than starting a fresh one.
    scene.beginActionMutationJournal();
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { y: 2 } as never,
    );
    scene.endActionMutationJournal();

    const keys = [
      ...((scene.getActionMutationJournal() as Map<string, Set<string>>).get(
        "a",
      ) ?? []),
    ];
    expect(keys).toEqual(expect.arrayContaining(["x", "y"]));

    scene.endActionMutationJournal();
    expect(scene.getActionMutationJournal().size).toBe(0);
  });

  it("accumulates keys across several calls to the same id", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a")]);

    scene.beginActionMutationJournal();
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { x: 1 } as never,
    );
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { y: 2 } as never,
    );

    expect(
      [
        ...((scene.getActionMutationJournal() as Map<string, Set<string>>).get(
          "a",
        ) ?? []),
      ].sort(),
    ).toEqual(expect.arrayContaining(["x", "y"]));
    scene.endActionMutationJournal();
  });

  it("an EXPLICIT declaredIntent key IS ownership — it overrides a journaled key", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const base = scene.getElementsIncludingDeleted().map((e) => ({ ...e }));

    scene.beginActionMutationJournal();
    // A helper writes x to the doc.
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { x: 50 } as never,
    );
    const journal = scene.getActionMutationJournal();
    expect([...(journal.get("a") ?? [])]).toContain("x");

    // The action then explicitly declares x — the escape hatch. Its canonical
    // result value must win over the helper's doc-side write.
    const result = base.map((e) => ({ ...e, x: 99 }));
    scene.applyElementChanges(base as never, result as never, {
      declaredIntent: {
        addedIds: new Set(),
        removedIds: new Set(),
        // Naming the key in `keysById` IS the ownership statement.
        keysById: new Map([["a", new Set(["x"])]]),
      } as never,
      alreadyAppliedIntent: journal,
    });
    scene.endActionMutationJournal();

    expect(scene.getElement("a")!.x).toBe(99);
  });

  it("a DERIVED key already in the journal is suppressed, so the doc value survives", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const base = scene.getElementsIncludingDeleted().map((e) => ({ ...e }));

    scene.beginActionMutationJournal();
    // The helper writes the CORRECT value to the doc...
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      { x: 50 } as never,
    );

    // ...while the action's result carries a value derived from the stale base.
    const result = base.map((e) => ({ ...e, x: 99 }));
    scene.applyElementChanges(base as never, result as never, {
      alreadyAppliedIntent: scene.getActionMutationJournal(),
      overlapPolicy: new Map([["x", "applied"]]),
    });
    scene.endActionMutationJournal();

    // The helper's write survives — this is the whole point of the journal.
    expect(scene.getElement("a")!.x).toBe(50);
  });

  it("REJECTS an unresolved ambiguous overlap, with ZERO mutation", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const base = scene.getElementsIncludingDeleted().map((e) => ({ ...e }));

    scene.beginActionMutationJournal();
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      {
        x: 50,
      } as never,
    );
    const before = scene.getElement("a" as never)!.x;
    const svBefore = Y.encodeStateVector(scene.doc);

    const result = base.map((e) => ({ ...e, x: 99 }));
    expect(() =>
      scene.applyElementChanges(base as never, result as never, {
        alreadyAppliedIntent: scene.getActionMutationJournal(),
        // no resolution supplied for a.x
      }),
    ).toThrow(/unresolved ownership for a\.x/);
    scene.endActionMutationJournal();

    // Rejected BEFORE any mutation: neither the value nor the document moved.
    expect(scene.getElement("a" as never)!.x).toBe(before);
    expect(Y.encodeStateVector(scene.doc)).toEqual(svBefore);
  });

  it("needs NO resolution when the overlap is same-valued", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const base = scene.getElementsIncludingDeleted().map((e) => ({ ...e }));

    scene.beginActionMutationJournal();
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      {
        x: 42,
      } as never,
    );

    // The action derives the SAME value the helper already wrote — both sides
    // agree, so there is nothing to choose.
    const result = base.map((e) => ({ ...e, x: 42 }));
    expect(() =>
      scene.applyElementChanges(base as never, result as never, {
        alreadyAppliedIntent: scene.getActionMutationJournal(),
      }),
    ).not.toThrow();
    scene.endActionMutationJournal();

    expect(scene.getElement("a" as never)!.x).toBe(42);
  });

  it("REJECTS an unknown resolution value", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 0 })]);
    const base = scene.getElementsIncludingDeleted().map((e) => ({ ...e }));

    scene.beginActionMutationJournal();
    scene.mutateElement(
      scene.getElement("a" as never)! as never,
      {
        x: 50,
      } as never,
    );
    const result = base.map((e) => ({ ...e, x: 99 }));

    expect(() =>
      scene.applyElementChanges(base as never, result as never, {
        alreadyAppliedIntent: scene.getActionMutationJournal(),
        overlapPolicy: new Map([["x", "whatever"]]) as never,
      }),
    ).toThrow(/unknown overlap resolution/);
    scene.endActionMutationJournal();
  });
});
