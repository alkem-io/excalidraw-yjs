import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type * as Y from "yjs";
import type { ExcalidrawElement } from "../types";

/**
 * The private commit primitive (spec 002, T016b). Reached by cast: it is
 * deliberately NOT public API — the two semantic planners are the supported
 * surface — but its guarantees need proving before any caller is migrated.
 */

const rec = (id: string, o: Record<string, unknown> = {}) =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as Parameters<typeof newElement>[0]) as unknown as Record<
      string,
      unknown
    >),
    ...o,
  } as Record<string, unknown>);

const allKeys = (r: Record<string, unknown>) => new Set(Object.keys(r));

const commit = (scene: Scene, plan: Record<string, unknown>) =>
  (
    scene as unknown as {
      commitPlan: (p: unknown) => { changedIds: Set<string> };
    }
  ).commitPlan(plan);

const emptyPlan = (over: Record<string, unknown> = {}) => ({
  add: [],
  remove: [],
  write: new Map(),
  recordHistory: true,
  ...over,
});

describe("commitPlan", () => {
  it("an invalid plan writes NOTHING", () => {
    const scene = new Scene();
    const a = rec("a");
    scene.replaceAllElements([a as unknown as ExcalidrawElement]);
    const before = scene.getElement("a")!.x;

    // same id in add and remove — contradictory membership
    expect(() =>
      commit(
        scene,
        emptyPlan({
          add: [{ record: rec("a", { x: 999 }), keys: new Set(["x"]) }],
          remove: ["a"],
        }),
      ),
    ).toThrow(/appears twice/);

    expect(scene.getElement("a")!.x).toBe(before);
    scene.destroy();
  });

  it("a collided add is a scoped write — the Y.Map is never replaced", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      rec("a", {
        x: 1,
        strokeColor: "#111111",
      }) as unknown as ExcalidrawElement,
    ]);
    const originalYMap = scene.yElements.get("a") as Y.Map<unknown>;

    // "add" an id that already exists (an interleaved remote add), declaring
    // only `x`. A structural replacement would drop the peer's strokeColor.
    commit(
      scene,
      emptyPlan({
        add: [{ record: rec("a", { x: 42 }), keys: new Set(["x"]) }],
      }),
    );

    expect(scene.yElements.get("a")).toBe(originalYMap); // identity preserved
    expect(scene.getElement("a")!.x).toBe(42);
    expect(scene.getElement("a")!.strokeColor).toBe("#111111");
    scene.destroy();
  });

  it("a no-op plan emits ZERO notifications and ZERO transport updates", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      rec("a", { x: 7 }) as unknown as ExcalidrawElement,
    ]);

    const updates: Uint8Array[] = [];
    let notifications = 0;
    scene.onDocUpdate((u) => updates.push(u));
    scene.onUpdate(() => {
      notifications++;
    });

    // declares x, but the doc already holds 7
    const { changedIds } = commit(
      scene,
      emptyPlan({
        write: new Map([
          ["a", { record: rec("a", { x: 7 }), keys: new Set(["x"]) }],
        ]),
      }),
    );

    expect(changedIds.size).toBe(0);
    expect(updates.length).toBe(0);
    expect(notifications).toBe(0);
    scene.destroy();
  });

  it("a creation emits exactly ONE transport delta (FR-017)", () => {
    const scene = new Scene();
    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    const created = rec("new", { x: 5 });
    const { changedIds } = commit(
      scene,
      emptyPlan({ add: [{ record: created, keys: allKeys(created) }] }),
    );

    // The create is still two Yjs transactions (STRUCTURAL prelude + reveal) —
    // that shape is load-bearing for undo — but it leaves as ONE message.
    expect(updates.length).toBe(1);
    expect(changedIds.has("new")).toBe(true);
    expect(scene.getElement("new")!.x).toBe(5);
    expect(scene.getElement("new")!.isDeleted).toBe(false);
    scene.destroy();
  });

  it("a post-prelude failure still publishes the committed state, then rethrows", () => {
    const scene = new Scene();
    scene.replaceAllElements([rec("existing") as unknown as ExcalidrawElement]);

    const updates: Uint8Array[] = [];
    scene.onDocUpdate((u) => updates.push(u));

    const created = rec("boom", { x: 3 });
    // Poison a DIFFERENT id than the add, so the disjointness assert passes and
    // the throw lands in the ACTION transaction — after the structural prelude
    // has already committed. (An earlier version of this test poisoned the same
    // id, so it tripped validation before the prelude and proved nothing.)
    const poisoned = {
      [Symbol.iterator]: () => {
        throw new Error("injected post-prelude failure");
      },
      has: () => true,
    } as unknown as ReadonlySet<string>;

    expect(() =>
      commit(
        scene,
        emptyPlan({
          add: [{ record: created, keys: allKeys(created) }],
          write: new Map([
            ["existing", { record: rec("existing"), keys: poisoned }],
          ]),
        }),
      ),
    ).toThrow("injected post-prelude failure");

    // The prelude's tombstone IS committed in the doc — Yjs does not roll back —
    // so it must reach peers. Publishing it is what preserves convergence;
    // dropping it silently is how replicas diverge.
    expect(updates.length).toBe(1);
    expect(scene.yElements.has("boom")).toBe(true);
    scene.destroy();
  });
});

describe("commitPlan — deletions must reach a peer (G5 convergence)", () => {
  /** Two Scenes wired through the public collaboration surface. */
  const link = (a: Scene, b: Scene) => {
    const detach = [
      a.onDocUpdate((u) => b.applyRemoteUpdate(u)),
      b.onDocUpdate((u) => a.applyRemoteUpdate(u)),
    ];
    return () => detach.forEach((d) => d());
  };

  it("a structural REMOVAL reaches the peer", () => {
    // A Yjs state vector tracks inserted struct clocks, NOT delete-set
    // advancement — so a deletion leaves the vector unchanged while still
    // emitting an update. Any no-op test based on state-vector equality silently
    // drops deletion-only mutations and the peer diverges forever.
    const a = new Scene();
    const b = new Scene();
    a.replaceAllElements([
      rec("keep") as unknown as ExcalidrawElement,
      rec("doomed") as unknown as ExcalidrawElement,
    ]);
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(b.getElement("doomed")).toBeDefined();

    const unlink = link(a, b);
    commit(a, emptyPlan({ remove: ["doomed"] }));

    expect(a.getElement("doomed")).toBeFalsy();
    expect(b.getElement("doomed")).toBeFalsy();
    expect(b.getElement("keep")).toBeDefined();
    unlink();
    a.destroy();
    b.destroy();
  });

  it("clearing an existing PROPERTY reaches the peer", () => {
    const a = new Scene();
    const b = new Scene();
    a.replaceAllElements([
      rec("a", { link: "https://example.com" }) as unknown as ExcalidrawElement,
    ]);
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(b.getElement("a")!.link).toBe("https://example.com");

    const unlink = link(a, b);
    // declared: clear `link` — a delete-only write on the Y.Map
    commit(
      a,
      emptyPlan({
        write: new Map([
          [
            "a",
            { record: rec("a", { link: undefined }), keys: new Set(["link"]) },
          ],
        ]),
      }),
    );

    expect(a.getElement("a")!.link).toBeUndefined();
    expect(b.getElement("a")!.link).toBeUndefined();
    unlink();
    a.destroy();
    b.destroy();
  });
});
