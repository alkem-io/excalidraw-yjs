import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

/** Deterministic PRNG, so a failing case is reproducible from its seed. */
const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

const mk = (
  id: string,
  extra: Record<string, unknown> = {},
): ExcalidrawElement =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as Parameters<typeof newElement>[0]) as ExcalidrawElement),
    id,
    ...extra,
  } as ExcalidrawElement);

/** Canonical content fingerprint — id → the properties that must converge. */
const content = (scene: Scene) =>
  JSON.stringify(
    scene
      .getElementsIncludingDeleted()
      .map((e) => [e.id, e.x, e.y, e.isDeleted])
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
  );

const liveIds = (scene: Scene) =>
  scene
    .getElementsIncludingDeleted()
    .filter((e) => !e.isDeleted)
    .map((e) => e.id)
    .sort();

/**
 * INV-CONVERGE / INV-NO-RESURRECT (SC-001), over the real `Scene` wire path.
 *
 * For any interleaving of concurrent edits across N replicas, mixed with
 * arbitrary FULL-STATE resyncs, every replica must end byte-equal with no edit
 * lost — and a deletion, once observed, must stay deleted under any ordering.
 *
 * The full-state resyncs are the point. Re-encoding a scene through a throwaway
 * `Y.Doc` gives it a fresh `clientID`, which is what destroys lineage: measured
 * on the defective baseline, ~50% of concurrent edits were lost and ~50% of
 * deletions resurrected per resync. Encoding the LIVE doc keeps the lineage, so
 * a resync is an idempotent merge rather than a clobber.
 */
describe("INV-CONVERGE / INV-NO-RESURRECT — N-replica property", () => {
  const REPLICAS = 4;
  const ROUNDS = 12;

  const run = (seed: number) => {
    const rand = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

    const scenes: Scene[] = [];
    const origin = new Scene();
    origin.replaceAllElements(["a", "b", "c"].map((id) => mk(id)));
    scenes.push(origin);
    for (let i = 1; i < REPLICAS; i++) {
      const s = new Scene(undefined, { doc: new Y.Doc() });
      s.applyRemoteUpdate(origin.encodeStateAsUpdate());
      scenes.push(s);
    }

    const deletedEver = new Set<string>();
    let edits = 0;
    let resyncs = 0;

    for (let round = 0; round < ROUNDS; round++) {
      // Each replica makes a concurrent, unexchanged edit.
      for (const s of scenes) {
        const op = rand();
        const current = s.getElementsIncludingDeleted();
        const target = pick(current.filter((e) => !e.isDeleted) as never[]) as
          | ExcalidrawElement
          | undefined;

        if (op < 0.45 && target) {
          // move — a per-property edit that must survive concurrent merges
          s.replaceAllElements(
            current.map((e) =>
              e.id === target.id
                ? ({ ...e, x: Math.floor(rand() * 1000) } as ExcalidrawElement)
                : e,
            ),
          );
          edits++;
        } else if (op < 0.7 && target) {
          // soft delete — must never come back
          s.replaceAllElements(
            current.map((e) =>
              e.id === target.id
                ? ({ ...e, isDeleted: true, updated: 5 } as ExcalidrawElement)
                : e,
            ),
          );
          deletedEver.add(target.id);
          edits++;
        } else {
          // create
          const id = `r${round}-${scenes.indexOf(s)}`;
          s.replaceAllElements([...current, mk(id)]);
          edits++;
        }
      }

      // Exchange in a random order, sometimes as a FULL-STATE resync rather than
      // an incremental delta — the ordering the invariant must survive.
      const order = scenes.map((_, i) => i).sort(() => rand() - 0.5);
      for (const from of order) {
        for (const to of order) {
          if (from === to) {
            continue;
          }
          if (rand() < 0.5) {
            scenes[to].applyRemoteUpdate(scenes[from].encodeStateAsUpdate());
            resyncs++;
          } else {
            scenes[to].applyRemoteUpdate(
              scenes[from].encodeStateAsUpdate(
                "v1",
                scenes[to].encodeStateVector(),
              ),
            );
          }
        }
      }
    }

    // Settle: everyone exchanges full state with everyone.
    for (const from of scenes) {
      for (const to of scenes) {
        if (from !== to) {
          to.applyRemoteUpdate(from.encodeStateAsUpdate());
        }
      }
    }

    const result = {
      edits,
      resyncs,
      contents: scenes.map(content),
      live: scenes.map(liveIds),
      resurrected: [] as string[],
    };
    for (const id of deletedEver) {
      if (result.live[0].includes(id)) {
        result.resurrected.push(id);
      }
    }
    scenes.forEach((s) => s.destroy());
    return result;
  };

  it.each([1, 7, 42, 1337, 90210])("converges for seed %i", (seed) => {
    const r = run(seed);

    // NON-VACUITY: the run must have done real work.
    expect(r.edits).toBeGreaterThan(20);
    expect(r.resyncs).toBeGreaterThan(0);
    expect(r.live[0].length).toBeGreaterThan(0);

    // INV-CONVERGE: every replica byte-equal on content.
    for (const c of r.contents) {
      expect(c).toBe(r.contents[0]);
    }

    // INV-NO-RESURRECT: nothing deleted came back.
    expect(r.resurrected).toEqual([]);
  });
});
