import { Scene, newElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { CollabEngine } from "./CollabEngine";

import type { CollabTransport } from "./CollabEngine";

/**
 * Native-Yjs core (M3) — proves the unified provider engine (`CollabEngine`)
 * drives a `Scene.doc` correctly: it broadcasts ONLY updates the replica
 * originated (never echoes a remote apply), integrates peer updates under the
 * REMOTE origin so they re-render without entering local history, and two engines
 * over a bidirectional transport make their Scenes converge — the same proof as
 * the in-process Scene test, but exercising the public engine API the app uses.
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
 * A pair of in-process transports forming a two-node "room": whatever A
 * broadcasts is delivered (flush-driven, synchronous) to B and vice-versa. This
 * is the socket relay's job, minus the socket.
 */
const makeLinkedTransports = (): {
  a: CollabTransport;
  b: CollabTransport;
  flush: () => void;
} => {
  const toB: Uint8Array[] = [];
  const toA: Uint8Array[] = [];
  let handlerA: ((u: Uint8Array) => void) | null = null;
  let handlerB: ((u: Uint8Array) => void) | null = null;

  const a: CollabTransport = {
    broadcast: (u) => toB.push(u),
    onMessage: (h) => {
      handlerA = h;
      return () => {
        handlerA = null;
      };
    },
  };
  const b: CollabTransport = {
    broadcast: (u) => toA.push(u),
    onMessage: (h) => {
      handlerB = h;
      return () => {
        handlerB = null;
      };
    },
  };

  const flush = () => {
    for (let i = 0; i < 50 && (toA.length || toB.length); i++) {
      const batchB = toB.splice(0);
      for (const u of batchB) {
        handlerB?.(u);
      }
      const batchA = toA.splice(0);
      for (const u of batchA) {
        handlerA?.(u);
      }
    }
  };

  return { a, b, flush };
};

describe("CollabEngine: the unified provider drives Scene.doc", () => {
  it("broadcasts local edits and applies remote ones so two scenes converge", () => {
    const sceneA = new Scene();
    const sceneB = new Scene();
    const { a, b, flush } = makeLinkedTransports();
    const engineA = new CollabEngine(sceneA, a);
    const engineB = new CollabEngine(sceneB, b);

    sceneA.replaceAllElements([rect("a", { x: 10 })]);
    flush();
    expect(sceneB.getElement("a")!.x).toBe(10);

    sceneB.mutateElement(sceneB.getElement("a")!, { x: 99 });
    flush();
    expect(sceneA.getElement("a")!.x).toBe(99);

    engineA.destroy();
    engineB.destroy();
    sceneA.destroy();
    sceneB.destroy();
  });

  it("does NOT echo a remote apply back to the transport (no loop)", () => {
    const sceneA = new Scene();
    const sceneB = new Scene();

    // Count what A's engine broadcasts.
    let aBroadcasts = 0;
    const aTransport: CollabTransport = {
      broadcast: () => {
        aBroadcasts += 1;
      },
      onMessage: () => () => {},
    };
    const engineA = new CollabEngine(sceneA, aTransport);

    // A makes a local edit → exactly that is broadcast.
    sceneA.replaceAllElements([rect("a")]);
    const afterLocal = aBroadcasts;
    expect(afterLocal).toBeGreaterThan(0);

    // Now apply a REMOTE update (from B) into A's scene. The engine integrates it
    // under REMOTE_ORIGIN; `onDocUpdate` must NOT re-broadcast it.
    sceneB.replaceAllElements([rect("b")]);
    const fromB = sceneB.encodeStateAsUpdate();
    sceneA.applyRemoteUpdate(fromB);
    expect(sceneA.getElement("b")).not.toBeNull(); // it applied…
    expect(aBroadcasts).toBe(afterLocal); // …but produced no new broadcast.

    engineA.destroy();
    sceneA.destroy();
    sceneB.destroy();
  });

  it("a remote apply does not enter the local undo stack (origin-scoped)", () => {
    const sceneA = new Scene();
    const sceneB = new Scene();
    const aTransport: CollabTransport = {
      broadcast: () => {},
      onMessage: () => () => {},
    };
    const engineA = new CollabEngine(sceneA, aTransport);

    // A local edit IS undoable.
    sceneA.replaceAllElements([rect("a")]);
    sceneA.stopElementCapture();
    expect(sceneA.canUndoElements()).toBe(true);
    const depth = sceneA.undoManager.undoStack.length;

    // A remote element arrives via the engine's apply path.
    sceneB.replaceAllElements([rect("remote")]);
    engineA.applyInitialUpdate(sceneB.encodeStateAsUpdate());
    expect(sceneA.getElement("remote")).not.toBeNull();
    // It did not add an undo step (REMOTE_ORIGIN is not tracked).
    expect(sceneA.undoManager.undoStack.length).toBe(depth);

    engineA.destroy();
    sceneA.destroy();
    sceneB.destroy();
  });

  it("initial sync: a late joiner catches up via encodeInitialUpdate", () => {
    const sceneA = new Scene([rect("a", { x: 1 }), rect("b", { x: 2 })]);
    const aTransport: CollabTransport = {
      broadcast: () => {},
      onMessage: () => () => {},
    };
    const engineA = new CollabEngine(sceneA, aTransport);

    const sceneB = new Scene();
    const bTransport: CollabTransport = {
      broadcast: () => {},
      onMessage: () => () => {},
    };
    const engineB = new CollabEngine(sceneB, bTransport);

    // B joins and applies A's full state.
    engineB.applyInitialUpdate(engineA.encodeInitialUpdate());
    expect(
      sceneB
        .getElementsIncludingDeleted()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);

    engineA.destroy();
    engineB.destroy();
    sceneA.destroy();
    sceneB.destroy();
  });

  it("destroy() stops broadcasting and applying", () => {
    const sceneA = new Scene();
    let broadcasts = 0;
    const transport: CollabTransport = {
      broadcast: () => {
        broadcasts += 1;
      },
      onMessage: () => () => {},
    };
    const engine = new CollabEngine(sceneA, transport);

    sceneA.replaceAllElements([rect("a")]);
    const before = broadcasts;
    expect(before).toBeGreaterThan(0);

    engine.destroy();
    // After destroy, a local edit no longer broadcasts.
    sceneA.mutateElement(sceneA.getElement("a")!, { x: 5 });
    expect(broadcasts).toBe(before);

    sceneA.destroy();
  });
});
