import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { decodeSnapshot, encodeSnapshot } from "../yjs/schema";

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

/**
 * A brand-new board arrives as a document with NO ROOTS, and must open.
 *
 * The producer is outside this repo: the server encodes an empty whiteboard as
 * `Y.encodeStateAsUpdateV2(new Y.Doc())` — nothing populated, so no root types
 * are materialised at all. Measured, that is **13 bytes**, and a `Scene`'s own
 * empty encode is the same 13 bytes, because Yjs emits no structs for a root
 * that has no content. The two are the same document.
 *
 * That equality is the whole contract, and nothing tested it. If the `Scene`
 * constructor ever came to depend on its roots pre-existing in the adopted
 * bytes, this would break with no local symptom — every EXISTING board would
 * keep working, and only brand-new ones would fail to open. That is the worst
 * shape of regression: invisible to every test that starts from content.
 *
 * The rootless case is the one that matters. A doc whose roots were created by
 * a different producer (the collaboration-service materialises `elements`,
 * `files` and `appState`, but not the deletion sidecar) is covered too, because
 * a partial root set is the same problem one step less severe.
 */
describe("adopting an empty document", () => {
  it("adopts a ROOTLESS empty V2 document and is usable afterwards", () => {
    // Exactly what the server's `whiteboardSceneToYjsV2State('')` emits.
    const producer = new Y.Doc();
    const bytes = Y.encodeStateAsUpdateV2(producer);
    expect([...producer.share.keys()]).toEqual([]); // no roots, by construction

    const scene = new Scene();
    scene.applyRemoteUpdate(bytes, "v2");

    expect(scene.getElementsIncludingDeleted()).toEqual([]);
    expect(scene.getAssetLocators()).toEqual({});
    expect(scene.getPersistedAppState()).toEqual({});

    // ...and it is a working scene, not merely a non-throwing one.
    scene.replaceAllElements([mk("first")], { recordHistory: false });
    scene.setAssetLocators({ f: "asset://f" });
    expect(scene.getElementsIncludingDeleted().map((e) => e.id)).toEqual([
      "first",
    ]);
    expect(scene.encodeStateAsUpdate("v2").byteLength).toBeGreaterThan(
      bytes.byteLength,
    );
    scene.destroy();
    producer.destroy();
  });

  it("a PARTIAL root set from another producer adopts just as well", () => {
    // The collaboration-service's whiteboard convention: three roots, no
    // `elementDeletions`. The Scene must supply what the producer omitted.
    const producer = new Y.Doc();
    producer.getMap("elements");
    producer.getMap("files");
    producer.getMap("appState");

    const scene = new Scene();
    scene.applyRemoteUpdate(Y.encodeStateAsUpdateV2(producer), "v2");

    expect(scene.getElementsIncludingDeleted()).toEqual([]);
    // the sidecar the producer never created still works
    scene.replaceAllElements([mk("a"), mk("b")], { recordHistory: false });
    scene.replaceAllElements(
      scene
        .getElementsIncludingDeleted()
        .map((e) => (e.id === "b" ? { ...e, isDeleted: true } : e)),
      { recordHistory: false },
    );
    expect(scene.yElementDeletions.has("b")).toBe(true);
    scene.destroy();
    producer.destroy();
  });

  it("an empty document round-trips through the snapshot codec", () => {
    const bytes = encodeSnapshot({
      elements: [],
      assets: {},
      appState: {},
    } as never);
    expect(decodeSnapshot(bytes)).toEqual({
      elements: [],
      assets: {},
      appState: {},
    });

    // and decoding a rootless producer document is equally clean
    expect(decodeSnapshot(Y.encodeStateAsUpdateV2(new Y.Doc()))).toEqual({
      elements: [],
      assets: {},
      appState: {},
    });
  });
});
