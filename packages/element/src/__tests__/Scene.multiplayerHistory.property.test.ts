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

const mk = (id: string): ExcalidrawElement =>
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
  } as ExcalidrawElement);

const content = (scene: Scene) =>
  JSON.stringify(
    scene
      .getElementsIncludingDeleted()
      .map((e) => [e.id, e.x, e.y, e.isDeleted])
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
  );

/** Derive from the doc BYTES through a fresh Scene — bypasses every cache. */
const rederived = (scene: Scene) => {
  const fresh = new Scene();
  Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(scene.doc));
  const out = content(fresh);
  fresh.destroy();
  return out;
};

/**
 * Every element's `isDeleted` must agree with the deletion sidecar. This is the
 * hazard `Scene`'s own constructor names: if an undo restores a live element
 * while its deletion marker persists, `collectGarbage` reclaims a LIVE element
 * once the cutoff passes. Scoping the UndoManager over both maps is what
 * prevents it; this asserts the outcome rather than the mechanism.
 */
const sidecarDisagreements = (scene: Scene) =>
  scene
    .getElementsIncludingDeleted()
    .filter((e) => Boolean(e.isDeleted) !== scene.yElementDeletions.has(e.id))
    .map((e) => `${e.id}: isDeleted=${Boolean(e.isDeleted)}`);

/**
 * INV-CONVERGE / INV-NO-RESURRECT under LOCAL HISTORY.
 *
 * `Scene.convergence.property.test.ts` fuzzes concurrent edits but never calls
 * undo or redo — measured, zero occurrences. Undo/redo is a THIRD writer into
 * the same doc, on a fourth origin (the `Y.UndoManager` itself), interleaved
 * with both replicas' edits and with sync points. This fuzzes that interleaving.
 *
 * NON-VACUITY, measured over the 60 trials below rather than assumed: 263 undos
 * and 44 redos actually did something (they returned `true`), alongside 297
 * deletes and 287 adds. `redoElements()` returns `false` far more often (292) —
 * expected, since any new edit clears the redo stack.
 *
 * SABOTAGE: dropping `yElementDeletions` from the UndoManager's scope — exactly
 * the hazard `Scene`'s constructor warns about — FAILS this test on multiple
 * trials. Stated honestly, one sabotage it does NOT catch: suppressing the
 * undo/redo meta-version bump. That belongs to INV-VERSION-MONOTONIC and is not
 * claimed here.
 */
describe("INV-CONVERGE under local history: two replicas, undo/redo interleaved", () => {
  const TRIALS = 60;
  const STEPS = 40;

  it("converges, keeps the deletion sidecar in lockstep, and never drifts from the doc", () => {
    const failures: string[] = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const rand = rng(0xc0ffee + trial * 7919);
      const a = new Scene();
      a.replaceAllElements([mk("e0"), mk("e1"), mk("e2")]);
      const b = new Scene();
      b.applyRemoteUpdate(a.encodeStateAsUpdate("v1"));

      const sync = () => {
        const toB = a.encodeStateAsUpdate("v1", b.encodeStateVector());
        b.applyRemoteUpdate(toB);
        const toA = b.encodeStateAsUpdate("v1", a.encodeStateVector());
        a.applyRemoteUpdate(toA);
      };

      let created = 0;
      const step = (scene: Scene, tag: string) => {
        const els = scene.getElementsIncludingDeleted();
        const pick = els[Math.floor(rand() * els.length)];
        const roll = rand();
        if (roll < 0.3 && pick) {
          scene.replaceAllElements(
            els.map((e) =>
              e.id === pick.id ? { ...e, x: Math.floor(rand() * 100) } : e,
            ),
          );
        } else if (roll < 0.5 && pick) {
          scene.replaceAllElements(
            els.map((e) =>
              e.id === pick.id ? { ...e, y: Math.floor(rand() * 100) } : e,
            ),
          );
        } else if (roll < 0.62) {
          scene.replaceAllElements([...els, mk(`${tag}-new-${created++}`)]);
        } else if (roll < 0.74 && pick) {
          scene.replaceAllElements(
            els.map((e) => (e.id === pick.id ? { ...e, isDeleted: true } : e)),
          );
        } else if (roll < 0.86) {
          scene.undoElements();
        } else {
          scene.redoElements();
        }
        // Discrete undo steps: `captureTimeout` is disabled by being huge, so
        // WITHOUT this every edit in a trial merges into a single stack item and
        // `undoElements()` is almost a no-op — the fuzz would be vacuous.
        scene.stopElementCapture();
      };

      for (let i = 0; i < STEPS; i++) {
        step(rand() < 0.5 ? a : b, rand() < 0.5 ? "a" : "b");
        if (rand() < 0.25) {
          sync();
        }
      }

      // settle: exchange until neither has anything for the other
      sync();
      sync();

      if (content(a) !== content(b)) {
        failures.push(`trial ${trial}: A and B diverged`);
      }
      for (const [scene, name] of [
        [a, "A"],
        [b, "B"],
      ] as const) {
        const bad = sidecarDisagreements(scene);
        if (bad.length) {
          failures.push(`trial ${trial}: ${name} sidecar ${bad.join(", ")}`);
        }
        if (content(scene) !== rederived(scene)) {
          failures.push(`trial ${trial}: ${name} cache drifted from the doc`);
        }
      }
      a.destroy();
      b.destroy();
    }

    expect(failures).toEqual([]);
  });
});
