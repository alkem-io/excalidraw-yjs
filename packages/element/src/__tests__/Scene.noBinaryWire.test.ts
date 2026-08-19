import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { writeAssetLocators } from "../yjs/schema";

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

const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/**
 * INV-NO-BINARY-WIRE — image bytes cannot reach the collaborative document.
 *
 * A full-state encode carries every root verbatim, so anything in the document
 * is on every INIT and every periodic resync. The guarantee therefore has to be
 * structural: the document stores an opaque locator per `fileId` and rejects
 * anything else, rather than relying on callers to pass the right shape.
 */
describe("INV-NO-BINARY-WIRE", () => {
  it("rejects a non-string value instead of storing it", () => {
    const scene = new Scene();
    const payload = {
      id: "f1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AAAA",
    };

    expect(() =>
      scene.setAssetLocators({ f1: payload as unknown as string }),
    ).toThrow(/must be a string/);

    // ...and nothing was stored on the way to throwing.
    expect(scene.getAssetLocators()).toEqual({});
    scene.destroy();
  });

  it("a full-state encode of a scene with images contains no bytes", () => {
    const scene = new Scene();
    scene.replaceAllElements([
      mk("img", { type: "image", fileId: "f1" }),
      mk("plain"),
    ]);
    scene.setAssetLocators({ f1: "asset://f1" });

    const wire = decode(scene.encodeStateAsUpdate());

    // GUARD: the reference IS on the wire, so this is not passing by emptiness.
    expect(wire).toContain("asset://f1");
    // ...and no byte-shaped value is.
    expect(wire).not.toContain("data:");
    expect(wire).not.toContain("base64");
    scene.destroy();
  });

  it("a peer receives the reference and can resolve it, without bytes crossing", () => {
    const a = new Scene();
    a.replaceAllElements([mk("img", { type: "image", fileId: "f1" })]);
    a.setAssetLocators({ f1: "asset://f1" });

    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());

    // The peer learns WHERE the bytes are, not what they are — which is what
    // lets it fetch them out of band through its own adapter.
    expect(b.getAssetLocators()).toEqual({ f1: "asset://f1" });
    a.destroy();
    b.destroy();
  });

  it("the guard is at the schema boundary, not only the Scene wrapper", () => {
    // So a future caller reaching the schema directly cannot bypass it.
    const doc = new Y.Doc();
    const yAssets = doc.getMap<unknown>("files");
    expect(() =>
      doc.transact(() =>
        writeAssetLocators(yAssets, {
          f1: { dataURL: "data:image/png;base64,AAAA" } as unknown as string,
        }),
      ),
    ).toThrow(/must be a string/);
    doc.destroy();
  });
});
