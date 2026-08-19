import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

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

const ids = (scene: Scene) =>
  scene
    .getElementsIncludingDeleted()
    .map((e) => e.id)
    .sort();

/**
 * INV-WIRE-ROBUST — applying an invalid remote update leaves the doc unchanged
 * and the session live.
 *
 * The transport is a network boundary: bytes arrive from a peer, a relay, or
 * storage, and may be truncated, corrupted, or in the wrong format. Yjs throws
 * on a malformed update, so an unguarded apply propagates out of the message
 * handler and wedges the collaboration session — every subsequent update is lost
 * even though the doc itself is still perfectly usable.
 */
describe("INV-WIRE-ROBUST — a malformed remote update cannot wedge the session", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array([])],
    ["truncated", new Uint8Array([1, 2, 3])],
    ["garbage", new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])],
    ["all zeroes", new Uint8Array(32)],
  ];

  for (const [name, bytes] of cases) {
    it(`rejects a ${name} update without throwing or mutating the doc`, () => {
      const scene = new Scene();
      scene.replaceAllElements([mk("a"), mk("b")]);
      const before = ids(scene);
      const beforeBytes = scene.encodeStateAsUpdate().byteLength;

      expect(() => scene.applyRemoteUpdate(bytes)).not.toThrow();

      expect(ids(scene)).toEqual(before);
      expect(scene.encodeStateAsUpdate().byteLength).toBe(beforeBytes);
      scene.destroy();
    });
  }

  it("stays live: a VALID update still applies after a malformed one", () => {
    // The real failure mode is not the bad message, it is everything after it.
    const a = new Scene();
    a.replaceAllElements([mk("a")]);
    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());

    b.applyRemoteUpdate(new Uint8Array([9, 9, 9, 9]));

    a.replaceAllElements([mk("a"), mk("c")]);
    b.applyRemoteUpdate(a.encodeStateAsUpdate());

    expect(ids(b)).toEqual(["a", "c"]);
    a.destroy();
    b.destroy();
  });

  it("a v1 update fed to the v2 decoder is rejected, not applied", () => {
    // A format mismatch is a realistic wiring bug, and v1 bytes are not valid v2.
    const a = new Scene();
    a.replaceAllElements([mk("a")]);
    const v1 = a.encodeStateAsUpdate("v1");

    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.replaceAllElements([mk("keep")]);
    const before = ids(b);

    expect(() => b.applyRemoteUpdate(v1, "v2")).not.toThrow();
    expect(ids(b)).toEqual(before);

    a.destroy();
    b.destroy();
  });
});
