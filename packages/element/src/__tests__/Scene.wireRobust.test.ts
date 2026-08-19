import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

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

/** Canonical full-doc fingerprint: every root plus the delete set. */
const fingerprint = (scene: Scene) =>
  JSON.stringify({
    sv: [...Y.encodeStateVector(scene.doc)],
    update: [...Y.encodeStateAsUpdateV2(scene.doc)],
  });

/**
 * What a malformed remote update actually does — measured, because the answer
 * constrains how recovery must be built.
 *
 * These are NOT tests of a guard. `applyRemoteUpdate` deliberately throws; the
 * point here is to pin the two facts a transport has to design around.
 */
describe("remote-update robustness — measured behaviour", () => {
  it("throws on malformed bytes rather than corrupting silently", () => {
    for (const bytes of [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    ]) {
      const scene = new Scene();
      scene.replaceAllElements([mk("a")]);
      expect(() => scene.applyRemoteUpdate(bytes)).toThrow();
      scene.destroy();
    }

    // Control: an all-zeroes payload is a VALID empty update and is accepted, so
    // "throws" is a real signal and not just "anything unusual is rejected".
    const ok = new Scene();
    ok.replaceAllElements([mk("a")]);
    expect(() => ok.applyRemoteUpdate(new Uint8Array(32))).not.toThrow();
    ok.destroy();
  });

  it("apply is NOT ATOMIC: a truncated update can throw AND still mutate", () => {
    // This is why `applyRemoteUpdate` must not catch-and-continue. Recovery has
    // to discard the Scene generation and resync; carrying on with the same doc
    // means carrying on with a partially-applied, internally inconsistent one.
    const source = new Scene();
    source.replaceAllElements([mk("a"), mk("b")]);
    source.setFiles({
      f1: { id: "f1", mimeType: "image/png", dataURL: "X".repeat(200) },
    } as Parameters<Scene["setFiles"]>[0]);

    // A peer produces a rich delta: several new elements, an edit, a new file.
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(source.encodeStateAsUpdate());
    peer.replaceAllElements([
      ...peer.getElementsIncludingDeleted(),
      mk("c"),
      mk("d"),
      mk("e"),
    ]);
    peer.setFiles({
      f2: { id: "f2", mimeType: "image/png", dataURL: "Z".repeat(300) },
    } as Parameters<Scene["setFiles"]>[0]);
    const delta = Y.encodeStateAsUpdate(
      peer.doc,
      Y.encodeStateVector(source.doc),
    );
    expect(delta.byteLength).toBeGreaterThan(64); // non-vacuity: a real delta

    let threwAndMutated = 0;
    let threwAndClean = 0;
    for (let cut = 1; cut < delta.byteLength; cut++) {
      const target = new Scene();
      target.replaceAllElements([mk("a"), mk("b")]);
      target.setFiles({
        f1: { id: "f1", mimeType: "image/png", dataURL: "X".repeat(200) },
      } as Parameters<Scene["setFiles"]>[0]);
      const before = fingerprint(target);
      let threw = false;
      try {
        target.applyRemoteUpdate(delta.slice(0, cut));
      } catch {
        threw = true;
      }
      if (threw) {
        if (fingerprint(target) === before) {
          threwAndClean++;
        } else {
          threwAndMutated++;
        }
      }
      target.destroy();
    }

    // Both branches must be non-zero, or this test would pass for the wrong
    // reason (e.g. nothing threw at all, or every offset happened to mutate).
    expect(threwAndClean).toBeGreaterThan(0);
    expect(threwAndMutated).toBeGreaterThan(0);

    source.destroy();
    peer.destroy();
  });
});
