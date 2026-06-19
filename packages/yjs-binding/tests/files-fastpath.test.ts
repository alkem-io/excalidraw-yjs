import { describe, expect, it, vi } from "vitest";

import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

import { writeDiff } from "../src/diff";
import { diffFiles } from "../src/files";
import * as schema from "../src/schema";

import { Y, makeElement } from "./helpers";

import type { ElementRecord } from "../src/schema";

/**
 * FIX 1 — `BinaryFileData` reference fast-path in the hot path.
 *
 * `hasDiffWork` (diff.ts) and `diffFiles` (files.ts) run on EVERY editor
 * `onChange` (many per second while drawing). A `BinaryFileData.dataURL` is a
 * base64 blob (hundreds of KB), so a `deepEqual` over it walks it char-by-char
 * per frame. Excalidraw treats `BinaryFileData` as immutable (it replaces file
 * entries, never mutates a `dataURL` in place), so reference equality is a
 * correct, cheap fast-path: equal references ⇒ unchanged, skip `deepEqual`.
 */

const makeRoots = () => {
  const doc = new Y.Doc();
  return {
    ydoc: doc,
    elementsMap: doc.getMap<Y.Map<unknown>>("elements"),
    filesMap: doc.getMap<BinaryFileData>("files"),
    appStateMap: doc.getMap<unknown>("appState"),
  };
};

/** A `BinaryFileData` with a large base64 blob, like a real image. */
const makeFile = (id: string, dataURL: string): BinaryFileData =>
  ({
    id,
    mimeType: "image/png",
    dataURL,
    created: 1,
  } as unknown as BinaryFileData);

const bigBlob = `data:image/png;base64,${"A".repeat(200_000)}`;

describe("FIX 1: diffFiles BinaryFileData reference fast-path", () => {
  it("treats a file unchanged by reference as unchanged WITHOUT calling deepEqual", () => {
    const doc = new Y.Doc();
    const filesMap = doc.getMap<BinaryFileData>("files");

    const file = makeFile("f", bigBlob);
    // seed the doc with the file
    doc.transact(() => {
      filesMap.set("f", file);
    });

    const spy = vi.spyOn(schema, "deepEqual");
    // re-diff with the SAME object reference (Excalidraw never mutates in place)
    const files: BinaryFiles = { f: file };
    let mutations = 0;
    doc.transact(() => {
      mutations = diffFiles(filesMap, files);
    });

    expect(mutations).toBe(0);
    // reference-equal ⇒ fast-path, never walk the base64 blob
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still detects a file REPLACED by a new object with changed bytes", () => {
    const doc = new Y.Doc();
    const filesMap = doc.getMap<BinaryFileData>("files");

    const original = makeFile("f", bigBlob);
    doc.transact(() => {
      filesMap.set("f", original);
    });

    // Excalidraw replaces the entry with a NEW object carrying new bytes.
    const replaced = makeFile("f", `${bigBlob}B`);
    const files: BinaryFiles = { f: replaced };
    let mutations = 0;
    doc.transact(() => {
      mutations = diffFiles(filesMap, files);
    });

    expect(mutations).toBe(1);
    expect((filesMap.get("f") as unknown as BinaryFileData).dataURL).toBe(
      replaced.dataURL,
    );
  });
});

describe("FIX 1: hasDiffWork (writeDiff) BinaryFileData reference fast-path", () => {
  it("a no-op onChange with a reference-equal file emits zero work and zero deepEqual", () => {
    const roots = makeRoots();
    const el: ElementRecord = makeElement({
      id: "img",
      index: "a1",
      fileId: "f",
    });
    const file = makeFile("f", bigBlob);
    const files: BinaryFiles = { f: file };

    // seed
    writeDiff(roots, [], [el], undefined, files);

    const spy = vi.spyOn(schema, "deepEqual");
    // identical onChange: same element (same version), same file REFERENCE
    const writes = writeDiff(roots, [el], [el], undefined, files);

    expect(writes).toBe(0);
    // `hasDiffWork` still uses `deepEqual` for element JSON-leaf properties
    // (groupIds, roundness, ...) — that's out of scope. The fast-path only
    // guarantees the (hundreds-of-KB) base64 file blob is NEVER walked: assert
    // `deepEqual` was never called WITH the file object on either side.
    const calledWithFile = spy.mock.calls.some(
      ([a, b]) => a === file || b === file,
    );
    expect(calledWithFile).toBe(false);
    spy.mockRestore();
  });

  it("a file replaced by a new object (changed bytes) is still detected as work", () => {
    const roots = makeRoots();
    const el: ElementRecord = makeElement({
      id: "img",
      index: "a1",
      fileId: "f",
    });
    const file = makeFile("f", bigBlob);
    writeDiff(roots, [], [el], undefined, { f: file });

    const replaced = makeFile("f", `${bigBlob}B`);
    const writes = writeDiff(roots, [el], [el], undefined, { f: replaced });

    expect(writes).toBeGreaterThan(0);
    expect((roots.filesMap.get("f") as unknown as BinaryFileData).dataURL).toBe(
      replaced.dataURL,
    );
  });
});
