import * as Y from "yjs";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { populateYDoc } from "./migrate";

import type { SceneJSON } from "./migrate";
import type { ElementRecord } from "./schema";

/**
 * Thrown when a blob cannot be loaded as an Excalidraw scene — unreadable bytes,
 * non-JSON content, or JSON that is not scene data (e.g. an Excalidraw *library*
 * file, or arbitrary JSON). Carries an optional `cause` for the underlying error.
 */
export class FileImportError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FileImportError";
    this.cause = cause;
  }
}

/**
 * `loadFileAsYDoc(blob) → Promise<Y.Doc>` (US4) — the Yjs-native file-import
 * boundary. Reads an `.excalidraw` / `.json` export, validates it is Excalidraw
 * **scene** data, and seeds a fresh local `Y.Doc` via `populateYDoc`. It is the
 * import counterpart of `exportSceneJSON`, and the helper every non-collab import
 * path (template/preview/single-user open, "load from file") uses to land a file
 * straight in the doc-backed representation — no intermediate JSON scene kept in
 * memory.
 *
 * **Self-contained on purpose.** The published binding carries no editor runtime
 * (only `yjs` / `y-protocols` / `fractional-indexing`). So rather than call the
 * editor's `parseFileContents` / `loadFromBlob` (which pull in PNG/SVG metadata
 * decoders, `@excalidraw/common`, `restore*`, …), this does the JSON-boundary
 * parse itself: `blob.text()` → `JSON.parse` → shape-validate. That covers the
 * `.excalidraw`/`.json` text formats — the only formats a Yjs whiteboard import
 * needs. (Image-embedded scenes — a `.png`/`.svg` with scene metadata — are an
 * editor-app concern; a caller that needs them decodes the blob to JSON with the
 * editor first, then hands the JSON boundary to `populateYDoc`.)
 *
 * `populateYDoc` already enforces the content rules — appState is filtered to the
 * synced allow-list, indices are repaired, tombstones carried — so a malformed but
 * structurally-valid scene still lands deterministically.
 *
 * @throws {FileImportError} if the blob is unreadable, not JSON, or not a scene.
 */
export const loadFileAsYDoc = async (blob: Blob): Promise<Y.Doc> => {
  const scene = await parseSceneBlob(blob);
  const ydoc = new Y.Doc();
  populateYDoc(scene, ydoc);
  return ydoc;
};

/**
 * Read + validate a blob into a `SceneJSON`, without touching Yjs. Exposed
 * separately so a caller that wants the parsed scene (e.g. to merge a template
 * into an existing doc rather than seed a new one) can reuse the boundary.
 *
 * Clipboard / paste (T004, deferred). A dedicated clipboard-subset helper is NOT
 * shipped here because paste needs no new binding primitive: the clipboard payload
 * is already JSON (an `{ elements, files }` subset, or a full scene), so paste
 * crosses the **same JSON boundary** this module owns. The paste flow is:
 *   1. parse the clipboard JSON into a scene subset (reuse `parseSceneBlob` for a
 *      blob, or `JSON.parse` for a string) → `SceneJSON`;
 *   2. `populateYDoc(subset, tempDoc)` into a throwaway local `Y.Doc`;
 *   3. `exportSceneJSON(tempDoc)` (or `applyToScene`) to merge the materialized
 *      elements into the live scene/doc at the drop position.
 * In other words, copy = `exportSceneJSON` of a selection, paste = `populateYDoc`
 * of the boundary JSON — both already exported. If a future need arises for an
 * in-binding selection-subset copy/paste, add it alongside `parseSceneBlob`.
 *
 * @throws {FileImportError}
 */
export const parseSceneBlob = async (blob: Blob): Promise<SceneJSON> => {
  let text: string;
  try {
    text = await readBlobText(blob);
  } catch (error) {
    throw new FileImportError("Could not read file contents", error);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new FileImportError(
      "File is not valid JSON (expected an .excalidraw / .json scene)",
      error,
    );
  }

  return toSceneJSON(data);
};

/**
 * Read a blob's text in both browser and Node — `Blob.text()` exists in modern
 * browsers and Node ≥ 15 (and in the test environment's `Blob`). The `FileReader`
 * branch is the legacy fallback for environments that predate `Blob.prototype.text`.
 */
const readBlobText = async (blob: Blob): Promise<string> => {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => {
      if (reader.readyState === FileReader.DONE) {
        resolve(reader.result as string);
      }
    };
    reader.readAsText(blob, "utf8");
  });
};

/**
 * Validate parsed JSON is Excalidraw scene data and project it to `SceneJSON`.
 *
 * Accepted shapes (mirrors the editor's `isValidExcalidrawData` permissiveness,
 * minus the editor-only restore step):
 *  - the canonical export `{ type: "excalidraw", elements: [...], appState?, files? }`;
 *  - a bare `{ elements: [...] }` document (some legacy/programmatic scenes drop
 *    the `type` tag).
 *
 * Rejected: a library file (`type: "excalidrawlib"`), or anything without an
 * `elements` array.
 */
const toSceneJSON = (data: unknown): SceneJSON => {
  if (data == null || typeof data !== "object") {
    throw new FileImportError("File does not contain an Excalidraw scene");
  }
  const obj = data as Record<string, unknown>;

  if (obj.type === "excalidrawlib") {
    throw new FileImportError(
      "File is an Excalidraw library, not a whiteboard scene",
    );
  }

  if (!Array.isArray(obj.elements)) {
    throw new FileImportError(
      "File does not contain an Excalidraw scene (no elements array)",
    );
  }

  const scene: SceneJSON = {
    elements: obj.elements as ElementRecord[],
  };
  if (obj.files != null && typeof obj.files === "object") {
    scene.files = obj.files as BinaryFiles;
  }
  if (obj.appState != null && typeof obj.appState === "object") {
    scene.appState = obj.appState as Record<string, unknown>;
  }
  return scene;
};
