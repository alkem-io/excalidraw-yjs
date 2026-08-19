import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";
import { ELEMENTS, FILES } from "../yjs/schema";

import type { ExcalidrawElement } from "../types";

const NOW = 1_000 * 60 * 60 * 1000;

/**
 * Build an element record. `newElement` forces `isDeleted: false` and drops
 * image-only fields, so deleted/image fixtures are spread on afterwards — the
 * doc write derives keys from the live object, so both carry.
 */
const el = (
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

const img = (id: string, fileId: string, extra: Record<string, unknown> = {}) =>
  el(id, { type: "image", fileId, ...extra });

const dead = (id: string, extra: Record<string, unknown> = {}) =>
  el(id, { isDeleted: true, ...extra });

const BINARY = "A".repeat(512);
const file = (id: string) => ({
  id,
  mimeType: "image/png" as const,
  dataURL: `data:image/png;base64,${BINARY}`,
  created: NOW,
});

const docKeys = (scene: Scene) => [...scene.yElements.keys()].sort();

/**
 * INV-BOUNDED (FR-006) — reclamation bounds storage under churn and keeps an
 * aged deleted element's binary off the wire to a new joiner.
 *
 * `Scene.collectGarbage` takes the eligible ids from the caller: `updated` is in
 * RECONCILE_META_KEYS and is never written to the doc, so age is not computable
 * here. These tests pin the doc mechanics and the file-reference rule.
 */
describe("INV-BOUNDED — bounded GC + privacy", () => {
  it("reclaims an expired deleted element and its now-orphaned binary", () => {
    const scene = new Scene();
    scene.setFiles({ f1: file("f1"), f2: file("f2") });
    scene.replaceAllElements([
      img("live", "f1"),
      img("gone", "f2", { isDeleted: true }),
    ]);

    const removed = scene.collectGarbage({
      expiredElementIds: new Set(["gone"]),
    });

    expect(docKeys(scene)).toEqual(["live"]);
    expect(Object.keys(scene.getFiles()).sort()).toEqual(["f1"]);
    expect(removed).toEqual({ elements: 1, files: 1 });
    scene.destroy();
  });

  it("keeps a RETAINED tombstone's file, so undo restores a complete image", () => {
    const scene = new Scene();
    scene.setFiles({ shared: file("shared"), solo: file("solo") });
    scene.replaceAllElements([
      img("liveImg", "shared"),
      img("agedShared", "shared", { isDeleted: true }),
      img("recentSolo", "solo", { isDeleted: true }),
    ]);

    // Only `agedShared` is eligible; `recentSolo` is still inside the window.
    const removed = scene.collectGarbage({
      expiredElementIds: new Set(["agedShared"]),
    });

    expect(docKeys(scene)).toEqual(["liveImg", "recentSolo"]);
    // `shared` is held by a live element, `solo` by a RETAINED tombstone. A file
    // dropped here would restore an image element without its image.
    expect(Object.keys(scene.getFiles()).sort()).toEqual(["shared", "solo"]);
    expect(removed.files).toBe(0);
    scene.destroy();
  });

  it("PRIVACY: an expired deleted image is not transmitted to a new joiner", () => {
    const host = new Scene();
    host.setFiles({ secret: file("secret") });
    host.replaceAllElements([
      el("live"),
      img("pasted-then-deleted", "secret", { isDeleted: true }),
    ]);

    // Non-vacuity: the binary IS on the wire before the sweep.
    expect(
      new TextDecoder("utf-8", { fatal: false }).decode(
        host.encodeStateAsUpdate(),
      ),
    ).toContain(BINARY);

    host.collectGarbage({
      expiredElementIds: new Set(["pasted-then-deleted"]),
    });

    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, host.encodeStateAsUpdate());

    // Absent from the decoded structures, not merely hidden behind a getter.
    expect([...joiner.getMap<Y.Map<unknown>>(ELEMENTS).keys()]).toEqual([
      "live",
    ]);
    expect([...joiner.getMap<unknown>(FILES).keys()]).toEqual([]);
    expect(
      new TextDecoder("utf-8", { fatal: false }).decode(
        host.encodeStateAsUpdate(),
      ),
    ).not.toContain(BINARY);
    host.destroy();
  });

  it("storage growth under churn is INDEPENDENT of payload size", () => {
    // The real bounded-storage property. An earlier version asserted "growth <
    // 512 bytes", which is an arbitrary threshold that says nothing: measured,
    // 5 paste/delete cycles leave ~2KB of residue REGARDLESS of payload size
    // (2023 bytes with a 512B binary, 2021 bytes with a 4096B one). That residue
    // is Yjs delete-set + struct-id overhead, not retained content — so the
    // invariant worth pinning is that growth does not scale with the payload.
    const churn = (payloadLen: number) => {
      const binary = "A".repeat(payloadLen);
      const scene = new Scene();
      const sizes: number[] = [];
      for (let cycle = 0; cycle < 5; cycle++) {
        const fid = `f${cycle}`;
        scene.setFiles({
          [fid]: {
            id: fid,
            mimeType: "image/png",
            dataURL: `data:image/png;base64,${binary}`,
            created: NOW,
          },
        } as Parameters<Scene["setFiles"]>[0]);
        scene.replaceAllElements([el("live"), img(`img${cycle}`, fid)]);
        scene.replaceAllElements([
          el("live"),
          img(`img${cycle}`, fid, { isDeleted: true }),
        ]);
        scene.collectGarbage({ expiredElementIds: new Set([`img${cycle}`]) });
        sizes.push(scene.encodeStateAsUpdate().byteLength);
      }
      const encoded = new TextDecoder("utf-8", { fatal: false }).decode(
        scene.encodeStateAsUpdate(),
      );
      scene.destroy();
      return {
        growth: sizes[4] - sizes[0],
        retainsPayload: encoded.includes(binary),
      };
    };

    const small = churn(512);
    const large = churn(4096);

    // No payload is retained at all...
    expect(small.retainsPayload).toBe(false);
    expect(large.retainsPayload).toBe(false);
    // ...and an 8x larger binary does not make the doc grow measurably more.
    expect(small.growth).toBeGreaterThan(0); // non-vacuity: churn really ran
    expect(Math.abs(large.growth - small.growth)).toBeLessThan(256);
    // Sanity: an unreclaimed 4096B binary per cycle would blow past this.
    expect(large.growth).toBeLessThan(4096);
  });

  it("the sweep is NOT undoable — Ctrl+Z cannot resurrect reclaimed content", () => {
    const scene = new Scene();
    scene.replaceAllElements([el("live"), dead("gone")]);

    scene.collectGarbage({ expiredElementIds: new Set(["gone"]) });
    expect(docKeys(scene)).toEqual(["live"]);

    // Maintenance, not user intent. Under LOCAL_ORIGIN the UndoManager would
    // track the sweep and this loop would bring the reclaimed element back.
    while (scene.canUndoElements()) {
      scene.undoElements();
    }
    expect(docKeys(scene)).not.toContain("gone");
    expect(scene.yElements.get("gone")).toBeUndefined();
    scene.destroy();
  });

  it("one sweep is ONE logical update; a no-op sweep emits ZERO", () => {
    const scene = new Scene();
    scene.replaceAllElements([el("live"), dead("a"), dead("b")]);

    const updates: Uint8Array[] = [];
    const detach = scene.onDocUpdate((u) => updates.push(u));

    const first = scene.collectGarbage({
      expiredElementIds: new Set(["a", "b"]),
    });
    expect(first.elements).toBe(2); // non-vacuity: it really swept
    expect(updates).toHaveLength(1); // ...as ONE message, not one per element

    const second = scene.collectGarbage({
      expiredElementIds: new Set(["a", "b"]),
    });
    expect(second).toEqual({ elements: 0, files: 0 });
    expect(updates).toHaveLength(1); // no transaction at all

    detach();
    scene.destroy();
  });

  it("CONCURRENCY: two replicas sweeping the same ids converge, no echo loop", () => {
    const a = new Scene();
    a.replaceAllElements([el("live"), dead("aged")]);
    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());

    const updates: Uint8Array[] = [];
    const detach = a.onDocUpdate((u) => updates.push(u));
    a.collectGarbage({ expiredElementIds: new Set(["aged"]) });
    detach();

    // The sweep MUST reach peers, or B keeps the tombstone and re-seeds it to
    // the next joiner — the privacy hole reopens one hop away.
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      b.applyRemoteUpdate(u);
    }

    // B now sweeps the same ids independently: deletes commute, nothing is left.
    const bEcho: Uint8Array[] = [];
    const detachB = b.onDocUpdate((u) => bEcho.push(u));
    const bRemoved = b.collectGarbage({ expiredElementIds: new Set(["aged"]) });
    detachB();

    expect(bRemoved).toEqual({ elements: 0, files: 0 });
    expect(bEcho).toHaveLength(0);
    expect(docKeys(b)).toEqual(docKeys(a));
    a.destroy();
    b.destroy();
  });
});
