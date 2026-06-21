import { describe, expect, it } from "vitest";

import { loadFileAsYDoc, FileImportError } from "../src/load-file";
import { exportSceneJSON } from "../src/migrate";
import { orderByIndex } from "../src/order";

import { makeElement } from "./helpers";

import type { ElementRecord } from "../src/schema";

/**
 * `loadFileAsYDoc(blob) → Promise<Y.Doc>` (US4, T003) — the Yjs-native file-import
 * boundary. It reads an `.excalidraw` / `.json` export, validates it is Excalidraw
 * scene data, and seeds a fresh local `Y.Doc` via `populateYDoc`. This is the
 * import counterpart of `exportSceneJSON` and stays **self-contained**: it does the
 * JSON-boundary parse itself (text → JSON → validate) rather than importing the
 * editor's `parseFileContents` (which would drag editor runtime + `@excalidraw/*`
 * into the published binding).
 */

/** Drop the per-peer reconciliation metadata for content comparison (§6 rule 1). */
const normalize = (el: ElementRecord): ElementRecord => {
  const { version, versionNonce, updated, ...rest } = el;
  void version;
  void versionNonce;
  void updated;
  return rest;
};

const fileBlob = (obj: unknown, type = "application/json"): Blob =>
  new Blob([JSON.stringify(obj)], { type });

const validScene = () => ({
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [
    makeElement({ id: "r1", index: "a1", seed: 1, strokeColor: "#ff0000" }),
    makeElement({
      id: "t1",
      type: "text",
      index: "a2",
      seed: 2,
      text: "hi",
      originalText: "hi",
      fontSize: 16,
      fontFamily: 1,
      containerId: "r1",
    }),
  ],
  appState: {
    viewBackgroundColor: "#abcdef",
    name: "Imported",
    // a non-allow-listed field that must NOT survive into the doc
    zoom: { value: 3 },
  },
  files: {
    f1: {
      id: "f1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AAAA",
      created: 1,
    },
  },
});

describe("loadFileAsYDoc (T003 / US4 file import)", () => {
  it("loads a .excalidraw JSON blob into a populated Y.Doc matching the scene", async () => {
    const src = validScene();
    const doc = await loadFileAsYDoc(fileBlob(src));
    const out = exportSceneJSON(doc);

    const srcOrdered = orderByIndex(src.elements as ElementRecord[]).map(
      normalize,
    );
    const outOrdered = orderByIndex(out.elements).map(normalize);
    expect(outOrdered).toEqual(srcOrdered);
  });

  it("carries files through verbatim", async () => {
    const src = validScene();
    const doc = await loadFileAsYDoc(fileBlob(src));
    const out = exportSceneJSON(doc);
    expect(out.files).toEqual(src.files);
  });

  it("keeps only the appState allow-list (drops zoom/selection/etc.)", async () => {
    const src = validScene();
    const doc = await loadFileAsYDoc(fileBlob(src));
    const out = exportSceneJSON(doc);
    expect(out.appState).toEqual({
      viewBackgroundColor: "#abcdef",
      name: "Imported",
    });
  });

  it("accepts a blob with no MIME type (e.g. a raw File handle)", async () => {
    const src = validScene();
    const doc = await loadFileAsYDoc(fileBlob(src, ""));
    const out = exportSceneJSON(doc);
    expect(out.elements.map((e) => e.id).sort()).toEqual(["r1", "t1"]);
  });

  it("tolerates a missing files / appState section", async () => {
    const blob = fileBlob({
      type: "excalidraw",
      version: 2,
      source: "x",
      elements: [makeElement({ id: "only", index: "a1", seed: 9 })],
    });
    const doc = await loadFileAsYDoc(blob);
    const out = exportSceneJSON(doc);
    expect(out.elements.map((e) => e.id)).toEqual(["only"]);
    expect(out.files).toEqual({});
    expect(out.appState).toEqual({});
  });

  it("returns a fresh, independent Y.Doc each call (no shared state)", async () => {
    const a = await loadFileAsYDoc(fileBlob(validScene()));
    const b = await loadFileAsYDoc(fileBlob(validScene()));
    expect(a).not.toBe(b);
    // mutating one must not touch the other
    a.getMap("elements").delete("r1");
    expect(b.getMap("elements").has("r1")).toBe(true);
  });

  it("rejects non-JSON content with FileImportError", async () => {
    const blob = new Blob(["this is not json {"], { type: "application/json" });
    await expect(loadFileAsYDoc(blob)).rejects.toBeInstanceOf(FileImportError);
  });

  it("rejects valid JSON that is not an Excalidraw scene", async () => {
    const blob = fileBlob({ hello: "world", elements: "not-an-array" });
    await expect(loadFileAsYDoc(blob)).rejects.toBeInstanceOf(FileImportError);
  });

  it("rejects an Excalidraw *library* file (type: excalidrawlib)", async () => {
    const blob = fileBlob({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [],
    });
    await expect(loadFileAsYDoc(blob)).rejects.toBeInstanceOf(FileImportError);
  });

  it("accepts a bare {elements:[...]} document (lenient, no type tag)", async () => {
    // Some legacy exports / programmatic scenes omit the `type` tag but are still
    // valid scene data (an elements array). Accept them.
    const blob = fileBlob({
      elements: [makeElement({ id: "bare", index: "a1", seed: 3 })],
      appState: { viewBackgroundColor: "#123456" },
    });
    const doc = await loadFileAsYDoc(blob);
    const out = exportSceneJSON(doc);
    expect(out.elements.map((e) => e.id)).toEqual(["bare"]);
    expect(out.appState.viewBackgroundColor).toBe("#123456");
  });
});
