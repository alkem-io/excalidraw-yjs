import { it } from "vitest";
import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

/**
 * INV-WIRE-ROBUST (T027) — measured at the REAL receiver boundary.
 *
 * Every production receiver of remote bytes funnels to `Scene.applyRemoteUpdate`:
 * `Collab`'s INIT and UPDATE handlers via `App.applyRemoteSceneUpdate`, and the
 * cold-load adoption path. These exercise that boundary.
 *
 * The three failure classes are DISTINCT and must not be conflated:
 *
 *  1. TRANSPORT DECODE FAILURE (truncated/garbage bytes). Measured over every
 *     truncation offset of a real 1596-byte update: 1576 threw with the document
 *     untouched, **19 threw AND partially mutated** (all in the tail, offsets
 *     1577-1595), and **0 mutated silently**. So a decode failure is always
 *     announced — the receiver never silently diverges — but it CAN leave a
 *     fragment applied. Catching cannot fix that; only discarding the generation
 *     can.
 *
 *  2. SCHEMA POISON (structurally valid Yjs, invalid content). Measured: applies
 *     CLEANLY, lands in the document, and then every subsequent encode throws.
 *     That is worse than a decode failure — the receiver accepts it silently and
 *     only discovers the problem when it next tries to publish, at which point it
 *     cannot broadcast at all. One non-compliant peer wedges another peer's
 *     ability to publish.
 *
 *  3. GENERATION-DISCARD POLICY — what a receiver does afterwards. NOT yet
 *     designed; these tests deliberately state the problem rather than assume a
 *     remedy.
 */
describe("INV-WIRE-ROBUST: remote update robustness", () => {
  it("a truncated update is always ANNOUNCED, never silently applied", () => {
    const src = new Scene();
    src.replaceAllElements([
      API.createElement({ type: "rectangle", id: "a", x: 1 }),
      API.createElement({ type: "rectangle", id: "b", x: 2 }),
    ]);
    const good = src.encodeStateAsUpdate("v1");

    let silentlyMutated = 0;
    for (let n = 1; n < good.length; n++) {
      const recv = new Scene();
      recv.replaceAllElements([
        API.createElement({ type: "rectangle", id: "z" }),
      ]);
      const before = Y.encodeStateVector(recv.doc);
      let threw = false;
      try {
        recv.applyRemoteUpdate(good.slice(0, n), "v1");
      } catch {
        threw = true;
      }
      const mutated =
        Buffer.compare(
          Buffer.from(before),
          Buffer.from(Y.encodeStateVector(recv.doc)),
        ) !== 0;
      if (mutated && !threw) {
        silentlyMutated++;
      }
      recv.destroy();
    }
    src.destroy();

    // The guarantee that DOES hold today: no truncation mutates without saying so.
    expect(silentlyMutated).toBe(0);
  });

  it.fails(
    "a truncated update does not leave a partial mutation behind",
    () => {
      const src = new Scene();
      src.replaceAllElements([
        API.createElement({ type: "rectangle", id: "a", x: 1 }),
        API.createElement({ type: "rectangle", id: "b", x: 2 }),
      ]);
      const good = src.encodeStateAsUpdate("v1");

      let threwAndMutated = 0;
      for (let n = 1; n < good.length; n++) {
        const recv = new Scene();
        recv.replaceAllElements([
          API.createElement({ type: "rectangle", id: "z" }),
        ]);
        const before = Y.encodeStateVector(recv.doc);
        let threw = false;
        try {
          recv.applyRemoteUpdate(good.slice(0, n), "v1");
        } catch {
          threw = true;
        }
        const mutated =
          Buffer.compare(
            Buffer.from(before),
            Buffer.from(Y.encodeStateVector(recv.doc)),
          ) !== 0;
        if (threw && mutated) {
          threwAndMutated++;
        }
        recv.destroy();
      }
      src.destroy();

      // RED: Yjs apply is NOT atomic on a decode failure. A try/catch cannot
      // make it so — the fragment is already in the document.
      expect(threwAndMutated).toBe(0);
    },
  );

  it.fails(
    "a schema-poisoned update does not wedge the receiver's ability to publish",
    async () => {
      await render(<Excalidraw />);
      API.setElements([API.createElement({ type: "rectangle", id: "mine" })]);

      // A peer speaking valid Yjs but violating the asset schema.
      const evil = new Y.Doc();
      const files = evil.getMap<unknown>("files");
      evil.transact(() => files.set("f1", "data:image/png;base64,AAAA"));

      act(() => {
        h.app.applyRemoteSceneUpdate(Y.encodeStateAsUpdate(evil), "v1");
      });

      // RED: the poison applied silently, and now the receiver cannot encode at
      // all — it can no longer broadcast its OWN work either.
      expect(() => h.app.encodeSceneStateAsUpdate("v1")).not.toThrow();
    },
  );
});
