import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { MAX_ASSET_LOCATOR_BYTES, writeAssetLocators } from "../yjs/schema";

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
 * A full-state encode carries every root verbatim, so anything in the document is
 * on every INIT and every periodic resync.
 *
 * SCOPE — this is an EGRESS guarantee, and the distinction is load-bearing:
 *
 *  - this editor never writes bytes into the document. Every locator is
 *    validated before any mutation, so a batch containing one bad value writes
 *    nothing;
 *  - a REMOTE peer can still put whatever it likes in the assets root, exactly
 *    as it can put a megabyte of text in any element property. A CRDT trusts its
 *    peers by construction, so this is not an asset-specific hole and is not
 *    closed by validating assets alone. What core does guarantee is that such a
 *    value is DETECTED and never used: reads fail loud rather than silently
 *    dropping it.
 */
describe("INV-NO-BINARY-WIRE", () => {
  it("rejects a dataURL STRING — the shape a byte-fallback actually takes", () => {
    // The case a `typeof value === "string"` check lets through, and the exact
    // shape of an upload-failure fallback: bytes wearing a string's clothes.
    const scene = new Scene();
    for (const bytes of [
      `data:image/png;base64,${"A".repeat(2048)}`,
      "DATA:image/png;base64,AAAA", // case
      "   data:image/png;base64,AAAA", // leading whitespace
    ]) {
      expect(() => scene.setAssetLocators({ f1: bytes })).toThrow(/data URL/);
    }
    expect(scene.getAssetLocators()).toEqual({});
    scene.destroy();
  });

  it("rejects an oversized string even when it is not a data URL", () => {
    const scene = new Scene();
    expect(() =>
      scene.setAssetLocators({ f1: "x".repeat(MAX_ASSET_LOCATOR_BYTES + 1) }),
    ).toThrow(/over the/);
    expect(scene.getAssetLocators()).toEqual({});
    scene.destroy();
  });

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

    expect(scene.getAssetLocators()).toEqual({});
    scene.destroy();
  });

  it("a bad entry leaves the WHOLE batch unwritten", () => {
    // Prevalidation is atomic, so one poisoned value cannot half-write a batch.
    const scene = new Scene();
    scene.setAssetLocators({ good0: "asset://good0" });

    expect(() =>
      scene.setAssetLocators({
        good1: "asset://good1",
        bad: "data:image/png;base64,AAAA",
        good2: "asset://good2",
      }),
    ).toThrow(/data URL/);

    expect(scene.getAssetLocators()).toEqual({ good0: "asset://good0" });
    scene.destroy();
  });

  it("a read FAILS LOUD on a value that is not a valid locator", () => {
    // A document written in the older shape must not decode as "no assets".
    const scene = new Scene();
    scene.doc.transact(() => {
      scene.yAssets.set("f1", { dataURL: "data:image/png;base64,AAAA" });
    });
    expect(() => scene.getAssetLocators()).toThrow(/must be a string/);
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
    // Covers a caller reaching the schema directly. It does NOT cover a remote
    // update writing into the assets root — see the trust-boundary test below.
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

  it("TRUST BOUNDARY: a peer CAN inject, and core detects rather than uses it", () => {
    // Stated as a test so the limit is not mistaken for a guarantee. Injection
    // is possible — integration puts it in the document and in its history, so
    // it also re-encodes. What holds is that core refuses to read it as a
    // locator, so nothing downstream treats those bytes as an asset reference.
    const victim = new Scene();
    const hostile = new Y.Doc();
    hostile.transact(() => {
      hostile
        .getMap("files")
        .set("f1", `data:image/png;base64,${"A".repeat(64)}`);
    });

    victim.applyRemoteUpdate(Y.encodeStateAsUpdate(hostile));

    // it did land — this is the honest part
    expect(victim.yAssets.has("f1")).toBe(true);
    // ...and core will not hand it onward as a reference
    expect(() => victim.getAssetLocators()).toThrow(/data URL/);

    victim.destroy();
    hostile.destroy();
  });
});
