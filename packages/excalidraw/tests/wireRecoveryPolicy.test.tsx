import { it, expect, describe } from "vitest";
import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

/**
 * INV-WIRE-ROBUST (T027) — receiver recovery, EVIDENCE rather than an open gate.
 *
 * **No shipped caller can produce a truncated update.** These tests inject
 * malformed bytes DIRECTLY into `Scene.applyRemoteUpdate`. Every receiver in
 * this repo hands over a complete payload — `Collab`'s INIT and UPDATE apply a
 * decrypted socket message, cold-load adoption applies an `encodedScene` the
 * host supplies whole. Downstream, the transport frames whole messages, client
 * and hub candidate-apply before broadcasting, and checkpoint restore validates
 * before serving; that half was traced through the landed client and service by
 * the collab-assists session and is not re-verified here.
 *
 * So this file does NOT describe work anybody owes. It was written when the
 * class looked live, and an earlier revision of this comment said the
 * implementation "belongs to the embedder's provider (`UnifiedCollabProvider`,
 * client-web)" — **that is withdrawn; nobody is implementing a client resync.**
 * The file is kept for two reasons: the measurements are the evidence for that
 * conclusion, and if a caller ever does hand over a fragment, these pin what the
 * remedy is and prove it needs no new API.
 *
 * The measured fact, if that day comes: an announced partial apply is not
 * corruption, it is INCOMPLETENESS. Yjs integrates a prefix of valid structs, so
 * a state vector out and the authority's delta back repairs it exactly — 23 of
 * 23 truncation offsets that both threw and mutated converge, with acknowledged
 * AND unacknowledged local work intact and still publishable. RESYNC, not
 * REPLACE: discarding the generation would also converge but destroys local
 * edits the authority has not yet seen.
 *
 * SILENT SEMANTIC CORRUPTION is a separate class and an **accepted risk** — a
 * flipped bit that still decodes, which no resync can repair and nothing
 * announces. TLS covers accidental wire flips; the residual is a malicious or
 * buggy peer, which needs a product contract and an ingress owner rather than a
 * generic integrity layer in the editor. The three `it.fails` cases measure that
 * gap. They are kept, not deleted, because `it.fails` inverts: if anyone ever
 * closes it the suite goes RED and forces this note to be revisited consciously.
 */

const summarise = (s: Scene) =>
  s
    .getElementsIncludingDeleted()
    .map((e) => `${e.id}:${e.x}:${e.isDeleted ? "D" : "L"}`)
    .sort()
    .join(",");

/** Derive from the doc bytes through a fresh Scene, bypassing any cache. */
const rederive = (s: Scene) => {
  const fresh = new Scene();
  Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(s.doc));
  const out = summarise(fresh);
  fresh.destroy();
  return out;
};

describe("INV-WIRE-ROBUST: receiver recovery policy", () => {
  it("an announced partial apply is repaired EXACTLY by a state-vector resync, losing no local work", () => {
    // `src` stands in for the authority (the server-side doc).
    const src = new Scene();
    src.replaceAllElements([
      API.createElement({ type: "rectangle", id: "a", x: 1 }),
      API.createElement({ type: "rectangle", id: "b", x: 2 }),
    ]);
    const seed = src.encodeStateAsUpdate("v1");
    // ONE composite logical update: two elements added, one deleted, one moved.
    src.replaceAllElements([
      { ...src.getElementsIncludingDeleted()[0], x: 11 },
      { ...src.getElementsIncludingDeleted()[1], isDeleted: true },
      API.createElement({ type: "rectangle", id: "c", x: 3 }),
      API.createElement({ type: "rectangle", id: "d", x: 4 }),
    ]);
    const good = src.encodeStateAsUpdate("v1");

    let mutating = 0;
    let derivedChanged = 0;
    let missingBefore = 0;
    let missingAfter = 0;
    let derivedIncompleteBefore = 0;
    let ackLost = 0;
    let unackLost = 0;
    let publishBack = 0;

    // Does the authority still hold structs this receiver lacks? Compared at
    // clock level: an update's byte length cannot answer this, because Yjs
    // always ships the full delete set regardless of the target state vector.
    const stillMissing = (recvScene: Scene) => {
      const mine = Y.decodeStateVector(recvScene.encodeStateVector());
      let behind = 0;
      Y.decodeStateVector(src.encodeStateVector()).forEach((clock, client) => {
        behind += Math.max(0, clock - (mine.get(client) ?? 0));
      });
      return behind;
    };

    // Every offset that both throws AND mutates lies in the TAIL — enough structs
    // decoded to integrate before the stream ran out. Scanned exhaustively
    // out-of-band (23 such offsets of 2114, all in the last 24 bytes); the suite
    // scans the tail so it stays fast, and `mutating > 0` below fails loudly if
    // the class ever moves.
    for (let n = Math.max(1, good.length - 64); n < good.length; n++) {
      const recv = new Scene();
      Y.applyUpdate(recv.doc, seed);

      // local work the authority HAS seen ("acknowledged")
      recv.replaceAllElements([
        ...recv.getElementsIncludingDeleted(),
        API.createElement({ type: "rectangle", id: "mine-ack", x: 90 }),
      ]);
      Y.applyUpdate(src.doc, recv.encodeStateAsUpdate("v1"));

      const beforeVector = recv.encodeStateVector();
      const beforeDerived = rederive(recv);
      let threw = false;
      try {
        recv.applyRemoteUpdate(good.slice(0, n), "v1");
      } catch {
        threw = true;
      }
      const mutated =
        Buffer.compare(
          Buffer.from(beforeVector),
          Buffer.from(recv.encodeStateVector()),
        ) !== 0;
      if (!(threw && mutated)) {
        recv.destroy();
        continue;
      }
      mutating++;
      // non-vacuity: the fragment really did change the derived scene, so the
      // repair below is not reconciling a no-op.
      if (rederive(recv) !== beforeDerived) {
        derivedChanged++;
      }

      if (stillMissing(recv) > 0) {
        missingBefore++;
      }
      if (
        !rederive(src)
          .split(",")
          .every((t) => rederive(recv).includes(t))
      ) {
        derivedIncompleteBefore++;
      }

      // local work the authority has NOT seen ("unacknowledged")
      recv.replaceAllElements([
        ...recv.getElementsIncludingDeleted(),
        API.createElement({ type: "rectangle", id: "mine-unack", x: 91 }),
      ]);

      // THE POLICY: state vector out, authority's delta back. No discard.
      recv.applyRemoteUpdate(
        src.encodeStateAsUpdate("v1", recv.encodeStateVector()),
        "v1",
      );

      if (stillMissing(recv) > 0) {
        missingAfter++;
      }
      const healed = rederive(recv);
      if (!healed.includes("mine-ack:90")) {
        ackLost++;
      }
      if (!healed.includes("mine-unack:91")) {
        unackLost++;
      }

      // and the receiver can still publish its own work upstream
      const mirror = new Scene();
      Y.applyUpdate(mirror.doc, Y.encodeStateAsUpdate(src.doc));
      Y.applyUpdate(mirror.doc, recv.encodeStateAsUpdate("v1"));
      if (summarise(mirror) === summarise(recv)) {
        publishBack++;
      }
      mirror.destroy();
      recv.destroy();
    }
    src.destroy();

    expect(mutating).toBeGreaterThan(0); // the class exists
    expect(derivedChanged).toBe(mutating); // the fragment really changed the scene
    // LOAD-BEARING non-vacuity: before the resync the receiver is genuinely
    // behind the authority, so removing the resync fails this pair.
    expect(missingBefore).toBe(mutating);
    expect(missingAfter).toBe(0);
    expect(ackLost).toBe(0);
    expect(unackLost).toBe(0); // discard-and-reseed fails THIS line
    expect(publishBack).toBe(mutating);
    // Reported, not asserted: whether the missing structs were user-visible.
    // eslint-disable-next-line no-console
    console.log(
      `[T027] tail truncations that threw+mutated=${mutating}, derived scene left incomplete=${derivedIncompleteBefore}`,
    );
  });

  it("the embedder can run the whole recovery through the EXISTING public API", async () => {
    // No new package surface is needed: the transport catches the throw, reads
    // the state vector, asks its authority for the delta, and applies it. This
    // is why the policy lives in the embedder (Collab / the client adapter) and
    // not in a catch block inside the element layer.
    await render(<Excalidraw />);
    API.setElements([API.createElement({ type: "rectangle", id: "mine" })]);

    const authority = new Scene();
    authority.replaceAllElements([
      API.createElement({ type: "rectangle", id: "far", x: 7 }),
    ]);
    const good = authority.encodeStateAsUpdate("v1");

    let announced = false;
    act(() => {
      try {
        h.app.applyRemoteSceneUpdate(good.slice(0, good.length - 2), "v1");
      } catch {
        // 1. the failure is ANNOUNCED — the embedder gets to act
        announced = true;
        // 2. ask the authority for exactly what we are missing
        const delta = authority.encodeStateAsUpdate(
          "v1",
          h.app.encodeSceneStateVector(),
        );
        // 3. apply it through the same receiver boundary
        h.app.applyRemoteSceneUpdate(delta, "v1");
      }
    });

    expect(announced).toBe(true);
    const ids = h.app
      .getSceneElementsIncludingDeleted()
      .map((e) => e.id)
      .sort();
    expect(ids).toContain("far"); // the authority's work arrived
    expect(ids).toContain("mine"); // ours was never discarded
    authority.destroy();
  });

  it.fails(
    "OUT OF SCOPE (accepted risk): a corrupted-but-decodable update is never accepted silently",
    () => {
      // Yjs's binary format carries no integrity check, so a flipped bit often
      // decodes as a VALID struct. Exhaustive single-bit corruption of a real
      // 1590-byte update: 8598 of 12720 trials applied without throwing and 258
      // silently diverged from the authority. Scoped here to a bounded prefix so
      // it stays a fast suite test.
      const src = new Scene();
      src.replaceAllElements([
        API.createElement({ type: "rectangle", id: "a", x: 1 }),
        API.createElement({ type: "rectangle", id: "b", x: 2 }),
      ]);
      const seed = src.encodeStateAsUpdate("v1");
      src.replaceAllElements([
        ...src.getElementsIncludingDeleted(),
        API.createElement({ type: "rectangle", id: "c", x: 3 }),
      ]);
      const good = src.encodeStateAsUpdate("v1");
      const authority = rederive(src);

      let silentlyDiverged = 0;
      for (let i = 0; i < Math.min(64, good.length); i++) {
        for (let bit = 0; bit < 8; bit++) {
          const bad = good.slice();
          bad[i] ^= 1 << bit;
          const recv = new Scene();
          Y.applyUpdate(recv.doc, seed);
          try {
            recv.applyRemoteUpdate(bad, "v1");
            if (rederive(recv) !== authority) {
              silentlyDiverged++;
            }
          } catch {
            // announced — the recoverable class, covered above
          }
          recv.destroy();
        }
      }
      src.destroy();

      // RED. Nothing in this repo can close it: detection needs integrity on the
      // wire or validation at ingress, both owned by the transport/service.
      expect(silentlyDiverged).toBe(0);
    },
  );

  it.fails(
    "OUT OF SCOPE (accepted risk): v2 — the format the COLD-LOAD path always speaks — is no worse than v1 under corruption",
    () => {
      // `EncodedSceneDocument.format` is the literal `"v2"` (types.ts), so the
      // cold-load adoption path — one of the three production receivers — always
      // applies V2 bytes, while every other T027 measurement was v1. Measured
      // over the same bounded flip budget, v2 is MATERIALLY WORSE: it silently
      // diverged 91 times to v1's 42, and 69 of those resisted a resync to v1's
      // 25. Its run-length encoding means one flipped bit perturbs a wider
      // decoded span. Worse still, this is the one path with no live authority
      // to resync FROM — the stored document IS the authority.
      const measure = (format: "v1" | "v2") => {
        const src = new Scene();
        src.replaceAllElements([
          API.createElement({ type: "rectangle", id: "a", x: 1 }),
          API.createElement({ type: "rectangle", id: "b", x: 2 }),
        ]);
        const seed = src.encodeStateAsUpdate(format);
        src.replaceAllElements([
          ...src.getElementsIncludingDeleted(),
          API.createElement({ type: "rectangle", id: "c", x: 3 }),
        ]);
        const good = src.encodeStateAsUpdate(format);
        const authority = rederive(src);
        let diverged = 0;
        for (let i = 0; i < Math.min(64, good.length); i++) {
          for (let bit = 0; bit < 8; bit++) {
            const bad = good.slice();
            bad[i] ^= 1 << bit;
            const recv = new Scene();
            recv.applyRemoteUpdate(seed, format);
            try {
              recv.applyRemoteUpdate(bad, format);
              if (rederive(recv) !== authority) {
                diverged++;
              }
            } catch {
              // announced
            }
            recv.destroy();
          }
        }
        src.destroy();
        return diverged;
      };

      // RED, and the gap is the point: the cold-load path is both the most
      // exposed to silent corruption and the least able to recover from it.
      expect(measure("v2")).toBeLessThanOrEqual(measure("v1"));
    },
  );

  it.fails(
    "OUT OF SCOPE (accepted risk): a silent divergence is repaired by a state-vector resync",
    () => {
      // The sting: the class that is NOT announced is also the class the CRDT
      // catch-up cannot repair. The receiver's state vector claims it already
      // holds those clocks, so the authority's delta omits the real structs and
      // the corruption is permanent. Measured exhaustively: 134 of the 258 silent
      // divergences survived a full resync, with the resync itself never throwing.
      const src = new Scene();
      src.replaceAllElements([
        API.createElement({ type: "rectangle", id: "a", x: 1 }),
        API.createElement({ type: "rectangle", id: "b", x: 2 }),
      ]);
      const seed = src.encodeStateAsUpdate("v1");
      src.replaceAllElements([
        ...src.getElementsIncludingDeleted(),
        API.createElement({ type: "rectangle", id: "c", x: 3 }),
      ]);
      const good = src.encodeStateAsUpdate("v1");
      const authority = rederive(src);

      let unrepairable = 0;
      for (let i = 0; i < Math.min(64, good.length); i++) {
        for (let bit = 0; bit < 8; bit++) {
          const bad = good.slice();
          bad[i] ^= 1 << bit;
          const recv = new Scene();
          Y.applyUpdate(recv.doc, seed);
          try {
            recv.applyRemoteUpdate(bad, "v1");
            if (rederive(recv) !== authority) {
              recv.applyRemoteUpdate(
                src.encodeStateAsUpdate("v1", recv.encodeStateVector()),
                "v1",
              );
              if (rederive(recv) !== authority) {
                unrepairable++;
              }
            }
          } catch {
            // announced
          }
          recv.destroy();
        }
      }
      src.destroy();

      // RED, and deliberately NOT closable by the resync policy above.
      expect(unrepairable).toBe(0);
    },
  );
});
