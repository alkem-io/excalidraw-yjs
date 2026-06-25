import * as Y from "yjs";

import { newElement, newImageElement } from "../newElement";
import { Scene } from "../Scene";
import {
  ELEMENTS,
  FILES,
  APPSTATE,
  RECONCILE_META_KEYS,
  encodeSnapshot,
  decodeSnapshot,
  type FileRecord,
} from "../yjs";

import type { ExcalidrawElement } from "../types";

/**
 * Native-Yjs core (M4) — proves PERSISTENCE is native: the scene's `Y.Doc` is the
 * persistence unit. A save encodes the WHOLE doc (elements + files + persistable
 * appState, in the one doc under `getMap("elements"/"files"/"appState")`) to Yjs
 * **V2** bytes; a load decodes those bytes back into a doc a `Scene` adopts. There
 * is no element-JSON scene snapshot any more.
 *
 *  - a Scene with elements + a file + persistable appState round-trips through
 *    `encodeStateAsUpdateV2` → `applyUpdateV2` into a FRESH Scene with elements,
 *    files, AND persisted appState all intact;
 *  - the persisted doc matches the server's `getMap("elements"/"files"/
 *    "appState")` convention (the exact stored format), so a doc the editor saves
 *    is what the backend stores;
 *  - LOCAL-ONLY appState (selection / zoom / scroll / active tool) is NEVER
 *    persisted — only the allow-listed subset is.
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

const imageEl = (id: string, fileId: string): ExcalidrawElement =>
  newImageElement({
    type: "image",
    id,
    x: 10,
    y: 20,
    width: 64,
    height: 64,
    fileId: fileId as ExcalidrawElement["id"] as never,
    status: "saved",
  } as Parameters<typeof newImageElement>[0]) as unknown as ExcalidrawElement;

/** A flat BinaryFileData-shaped record (the value the doc stores whole). */
const file = (id: string, dataURL: string): FileRecord => ({
  mimeType: "image/png",
  id,
  dataURL,
  created: 1_700_000_000_000,
  lastRetrieved: 1_700_000_000_500,
  version: 1,
});

/** The doc does NOT store reconciliation metadata; compare element content
 * modulo those keys (`RECONCILE_META_KEYS`, OPEN-3). */
const stripMeta = (el: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (!RECONCILE_META_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
};

const byId = (els: readonly ExcalidrawElement[]) =>
  new Map(els.map((e) => [e.id, e]));

describe("native-yjs Scene persistence: the doc IS the persistence unit", () => {
  it("ROUND-TRIP: a Scene with elements + a file + persistable appState encodes to V2 bytes and a FRESH Scene restores them all", () => {
    // Build a scene with real content on the doc: two elements (one image
    // referencing a file), a binary file, and the persistable appState subset.
    const scene = new Scene([
      rect("a", { x: 5, strokeColor: "#f00" }),
      imageEl("img", "file-1"),
    ]);
    scene.setFiles({ "file-1": file("file-1", "data:image/png;base64,AAAA") });
    scene.setAppState({ viewBackgroundColor: "#abcdef", name: "My board" });

    // SAVE: encode the whole doc (elements + files + appState) to Yjs V2 bytes.
    const bytes = scene.encodeSnapshot();
    expect(bytes.byteLength).toBeGreaterThan(0);

    // LOAD: decode the bytes into a FRESH, independent Scene (no shared doc).
    const restored = Scene.fromSnapshot(bytes);

    // --- elements match (content, modulo locally-derived reconcile meta) ---
    const before = byId(scene.getElementsIncludingDeleted());
    const after = byId(restored.getElementsIncludingDeleted());
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    expect(restored.getElementsIncludingDeleted().map((e) => e.id)).toEqual(
      scene.getElementsIncludingDeleted().map((e) => e.id),
    );
    for (const id of before.keys()) {
      expect(
        stripMeta(after.get(id)! as unknown as Record<string, unknown>),
      ).toEqual(
        stripMeta(before.get(id)! as unknown as Record<string, unknown>),
      );
    }
    // a concrete spot-check of the mutated element value across the wire
    expect(restored.getElement("a")!.strokeColor).toBe("#f00");
    expect(restored.getElement("a")!.x).toBe(5);

    // --- files match (the whole BinaryFileData round-trips byte-stable) ---
    expect(restored.getFiles()).toEqual({
      "file-1": file("file-1", "data:image/png;base64,AAAA"),
    });

    // --- persisted appState matches (only the allow-list subset) ---
    expect(restored.getPersistedAppState()).toEqual({
      viewBackgroundColor: "#abcdef",
      name: "My board",
    });

    scene.destroy();
    restored.destroy();
  });

  it("the persisted doc uses the server's getMap('elements'/'files'/'appState') convention", () => {
    const scene = new Scene([imageEl("img", "f1")]);
    scene.setFiles({ f1: file("f1", "data:image/png;base64,BBBB") });
    scene.setAppState({ viewBackgroundColor: "#123456", name: "n" });

    const bytes = scene.encodeSnapshot();

    // Decode into a bare Y.Doc (no Scene) and read the canonical root maps — this
    // is exactly how the Alkemio server / collab-service reads the stored bytes.
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, bytes);

    const yElements = doc.getMap<Y.Map<unknown>>(ELEMENTS);
    const yFiles = doc.getMap<unknown>(FILES);
    const yAppState = doc.getMap<unknown>(APPSTATE);

    // elements live under "elements", keyed by element id, as per-property maps.
    expect([...yElements.keys()]).toEqual(["img"]);
    expect(yElements.get("img")!.get("fileId")).toBe("f1");

    // files live under "files", keyed by fileId, value = the whole BinaryFileData.
    expect([...yFiles.keys()]).toEqual(["f1"]);
    expect(yFiles.get("f1")).toEqual(file("f1", "data:image/png;base64,BBBB"));

    // appState lives under "appState", only the allow-list keys.
    expect(yAppState.get("viewBackgroundColor")).toBe("#123456");
    expect(yAppState.get("name")).toBe("n");

    doc.destroy();
    scene.destroy();
  });

  it("LOCAL-ONLY appState (selection / zoom / scroll / tool) is NEVER persisted", () => {
    const scene = new Scene([rect("a")]);

    // Throw the whole appState at the doc, including local-only fields. Only the
    // allow-list subset must survive; the rest must never reach the doc.
    scene.setAppState({
      viewBackgroundColor: "#fff",
      name: "kept",
      // local-only fields — must be ignored
      selectedElementIds: { a: true },
      zoom: { value: 2 },
      scrollX: 500,
      scrollY: -300,
      activeTool: { type: "rectangle" },
    } as Parameters<Scene["setAppState"]>[0]);

    const persisted = scene.getPersistedAppState();
    expect(persisted).toEqual({ viewBackgroundColor: "#fff", name: "kept" });
    // and the doc's appState map holds ONLY the two allow-listed keys.
    expect([...scene.yAppState.keys()].sort()).toEqual([
      "name",
      "viewBackgroundColor",
    ]);

    // It also does not appear in the encoded snapshot.
    const restored = Scene.fromSnapshot(scene.encodeSnapshot());
    const restoredKeys = Object.keys(restored.getPersistedAppState()).sort();
    expect(restoredKeys).toEqual(["name", "viewBackgroundColor"]);

    scene.destroy();
    restored.destroy();
  });

  it("setFiles MERGES (append-mostly) — a later file does not drop an earlier one", () => {
    const scene = new Scene([rect("a")]);
    scene.setFiles({ f1: file("f1", "data:,1") });
    scene.setFiles({ f2: file("f2", "data:,2") });

    // both files present (Excalidraw never removes a binary on element delete).
    expect(Object.keys(scene.getFiles()).sort()).toEqual(["f1", "f2"]);

    // re-setting an unchanged file is a no-op; updating its bytes replaces it.
    scene.setFiles({ f1: file("f1", "data:,1-updated") });
    expect(scene.getFiles().f1.dataURL).toBe("data:,1-updated");
    expect(Object.keys(scene.getFiles()).sort()).toEqual(["f1", "f2"]);

    scene.destroy();
  });

  it("standalone encodeSnapshot/decodeSnapshot round-trips elements + files + appState (the backend-format helpers)", () => {
    // The schema-level helpers the persistence layer (firebase.ts) uses, exercised
    // directly: a plain snapshot object → V2 bytes → an equal snapshot object.
    const a = rect("a", { x: 9 });
    const b = imageEl("img", "f1");
    const snapshot = {
      elements: [a, b] as unknown as readonly Record<string, unknown>[],
      files: { f1: file("f1", "data:image/png;base64,CCCC") },
      appState: { viewBackgroundColor: "#0f0", name: "snap" },
    };

    const bytes = encodeSnapshot(snapshot);
    const decoded = decodeSnapshot(bytes);

    // elements: same ids, in fractional-index order, content-equal modulo meta.
    expect(decoded.elements.map((e) => e.id)).toEqual(["a", "img"]);
    expect(stripMeta(decoded.elements[0])).toEqual(
      stripMeta(a as unknown as Record<string, unknown>),
    );
    expect(decoded.elements[1].fileId).toBe("f1");

    // files + appState survive exactly.
    expect(decoded.files).toEqual({
      f1: file("f1", "data:image/png;base64,CCCC"),
    });
    expect(decoded.appState).toEqual({
      viewBackgroundColor: "#0f0",
      name: "snap",
    });
  });

  it("an empty scene round-trips to an empty scene (no elements / files / appState)", () => {
    const scene = new Scene();
    const restored = Scene.fromSnapshot(scene.encodeSnapshot());

    expect(restored.getElementsIncludingDeleted()).toEqual([]);
    expect(restored.getFiles()).toEqual({});
    expect(restored.getPersistedAppState()).toEqual({});

    scene.destroy();
    restored.destroy();
  });

  it("files + appState set on the doc collaborate via applyRemoteUpdate (they ride the same doc as elements)", () => {
    // Persistence-on-doc also means files/appState are part of the doc that
    // collaborates — a peer's file/appState change arrives through the same
    // remote-apply path the elements do. (Single-link smoke of that.)
    const a = new Scene([rect("a")]);
    const b = new Scene();

    a.setFiles({ f1: file("f1", "data:,x") });
    a.setAppState({ viewBackgroundColor: "#777", name: "shared" });

    // B catches up via the full doc state (the initial-sync path).
    b.applyRemoteUpdate(a.encodeStateAsUpdate("v2"), "v2");

    expect(b.getFiles()).toEqual({ f1: file("f1", "data:,x") });
    expect(b.getPersistedAppState()).toEqual({
      viewBackgroundColor: "#777",
      name: "shared",
    });
    expect(b.getElement("a")).not.toBeNull();

    a.destroy();
    b.destroy();
  });
});
