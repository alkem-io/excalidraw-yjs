import { it } from "vitest";

import { Scene } from "../Scene";
import { newElement } from "../newElement";

import type { ExcalidrawElement } from "../types";

const rect = (id: string, over: Partial<ExcalidrawElement> = {}) =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...over,
  } as Parameters<typeof newElement>[0]);

/**
 * The NO-WRITE meta rule (T014b, split out as its own property).
 *
 * A bulk replace whose document content is IDENTICAL, but whose carried
 * reconciliation metadata differs, must be a no-op for everything the doc
 * derives: no element is changed, so no version/nonce/updated may move. Own
 * Symbols are the exception — they live on the caller's object rather than in
 * the document, so they legitimately refresh.
 *
 * This existed to answer whether the cleanup is REACHABLE before any code
 * changed. It IS: measured on current code, a bulk replace with UNCHANGED
 * content but a stale carried version drives `version` 2 -> -1 and `updated`
 * 1 -> 999, both taken verbatim. So the version regresses with no content change
 * to justify any movement at all.
 *
 * Scope of the `updated` half, stated precisely: this corrupts the LOCAL derived
 * element. The durable deletion marker is NOT affected — `syncDeletionMarker`
 * stamps only on the live->deleted transition and never restamps — so this is
 * not a tombstone-expiry extension.
 *
 * Committed as `it.fails`, not `it.skip`: the defect stays executable and the
 * suite stays green, and it fails loudly the moment the no-write rule lands.
 */
describe("no-write bulk replace leaves doc-derived meta alone", () => {
  it.fails(
    "does not move version/updated when the content is unchanged",
    () => {
      const scene = new Scene();
      scene.replaceAllElements([rect("a", { x: 5 })]);

      const before = scene.getElement("a")!;

      // The SAME content, re-submitted carrying different reconciliation metadata —
      // what a stale action array looks like when its element did not change.
      scene.replaceAllElements([
        { ...before, version: before.version - 3, updated: 999 } as never,
      ]);

      const after = scene.getElement("a")!;

      // GUARD: still the same element, so this is not comparing against a drop.
      expect(after.id).toBe("a");
      expect(after.x).toBe(5);

      expect(after.version).toBe(before.version);
      expect(after.updated).toBe(before.updated);
      expect(after.versionNonce).toBe(before.versionNonce);
    },
  );

  it("does not move meta when the SAME object is re-submitted verbatim", () => {
    const scene = new Scene();
    scene.replaceAllElements([rect("a", { x: 5 })]);
    const before = scene.getElement("a")!;

    scene.replaceAllElements([before]);

    const after = scene.getElement("a")!;
    expect(after.version).toBe(before.version);
    expect(after.updated).toBe(before.updated);
    expect(after.versionNonce).toBe(before.versionNonce);
  });
});
