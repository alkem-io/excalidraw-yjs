import React from "react";

import { Scene } from "@excalidraw-yjs/element";
import * as Y from "yjs";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

import type { AssetAdapter, BinaryFileData } from "../types";

const { h } = window;

/**
 * A failing `resolve` must not loop — and must not become permanent either.
 *
 * `refreshFilesFromScene` computes `missing` from "locator present, bytes
 * absent, nothing in flight" and used to re-enter itself UNCONDITIONALLY when
 * the batch settled. On a rejection nothing changes, so the re-entry recomputed
 * an identical `missing` set and fired again immediately — an unbounded loop
 * which, for a rejection that never reaches the network, is tight enough to
 * freeze the tab (the RED for it timed the runner out rather than failing an
 * assertion). The wrong-id branch had the same hole: it returns without caching.
 *
 * The first fix for this remembered failed `fileId\0locator` pairs and skipped
 * them. That was an OVERCORRECTION and is deliberately not what is tested here:
 * the host adapter (`useWhiteboardAssetAdapter.resolve`) throws on ordinary
 * transient trouble — a GraphQL lookup miss, an expired URL, a transport error —
 * and nothing in its contract says a rejection is permanent. Remembering one
 * turns a network blip into an image that never loads again for the life of the
 * editor.
 *
 * What actually needs to stop is the IMMEDIATE re-entry. The tail exists for
 * exactly one case — a locator that changed while its fetch was in flight, whose
 * result was discarded and which nothing else would re-trigger — so it now fires
 * only for that. Everything else recovers the ordinary way: the next scene
 * update runs this again through `scene.onUpdate`.
 */

const bytes = (id: string): BinaryFileData =>
  ({
    id,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,AAAA",
    created: 1,
  } as BinaryFileData);

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });
};

/** Put a locator in the doc with no local bytes — what a peer's publish looks
 * like to this replica. Each call is an INDEPENDENT scene update. */
const publishLocatorFromPeer = (fileId: string, locator: string) => {
  const peer = new Scene(undefined, { doc: new Y.Doc() });
  peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());
  peer.setAssetLocators({ ...peer.getAssetLocators(), [fileId]: locator });
  act(() => {
    h.scene.applyRemoteUpdate(peer.encodeStateAsUpdate());
  });
  peer.destroy();
};

/** An unrelated doc change, to prove recovery is driven by ordinary scene
 * activity rather than by anything asset-specific. */
const unrelatedSceneUpdate = (id: string) => {
  act(() => {
    h.app.updateScene({
      elements: [
        ...h.scene.getElementsIncludingDeleted(),
        API.createElement({ type: "rectangle", id, x: 0, y: 0 }),
      ] as never,
      captureUpdate: "IMMEDIATELY" as never,
    });
  });
};

describe("a failing assetAdapter.resolve neither loops nor becomes permanent", () => {
  it("a permanently rejecting stable locator does not microtask-loop", async () => {
    const calls: string[] = [];
    const adapter: AssetAdapter = {
      store: async (f) => `asset://${f.id}`,
      resolve: async (fileId) => {
        calls.push(fileId);
        // Rejects without ever yielding to the network.
        throw new Error("gone");
      },
    };
    await render(<Excalidraw assetAdapter={adapter} />);

    publishLocatorFromPeer("f1", "asset://f1");
    await flush();

    // GUARD — a green result must not mean "resolve was never called".
    expect(calls.length).toBeGreaterThan(0);
    // ONE attempt per scene update. Unbounded recursion shows up as a huge
    // number here, or as the runner never returning at all.
    expect(calls.length).toBe(1);
  });

  it("the SAME stable locator retries and succeeds after a later scene update", async () => {
    const calls: string[] = [];
    let failing = true;
    const adapter: AssetAdapter = {
      store: async (f) => `asset://${f.id}`,
      resolve: async (fileId) => {
        calls.push(fileId);
        if (failing) {
          throw new Error("transient");
        }
        return bytes(fileId);
      },
    };
    await render(<Excalidraw assetAdapter={adapter} />);

    publishLocatorFromPeer("f2", "asset://f2");
    await flush();
    expect(calls.length).toBe(1);
    expect(h.app.files.f2).toBeUndefined();

    // The blip passes. The locator has NOT changed — this is exactly the case
    // the first fix made unrecoverable.
    failing = false;
    unrelatedSceneUpdate("filler-1");
    await flush();

    expect(calls.length).toBe(2);
    expect(h.app.files.f2?.dataURL).toBe("data:image/png;base64,AAAA");
  });

  it("a locator that changed mid-flight is fetched without a further update", async () => {
    const calls: string[] = [];
    let swap: (() => void) | null = null;
    const adapter: AssetAdapter = {
      store: async (f) => `asset://${f.id}`,
      resolve: async (fileId, locator) => {
        calls.push(locator);
        // While THIS fetch is in flight, the locator moves. Its result must be
        // discarded, and the new one fetched with no further scene activity.
        if (swap) {
          const go = swap;
          swap = null;
          go();
        }
        return bytes(fileId);
      },
    };
    await render(<Excalidraw assetAdapter={adapter} />);

    swap = () => publishLocatorFromPeer("f3", "asset://f3-v2");
    publishLocatorFromPeer("f3", "asset://f3-v1");
    await flush();

    // Both locators were attempted, the second WITHOUT another external update.
    expect(calls).toContain("asset://f3-v1");
    expect(calls).toContain("asset://f3-v2");
    expect(h.app.files.f3?.dataURL).toBe("data:image/png;base64,AAAA");
  });

  it("a wrong-id result does not immediate-loop but stays recoverable", async () => {
    const calls: string[] = [];
    let wrong = true;
    const adapter: AssetAdapter = {
      store: async (f) => `asset://${f.id}`,
      resolve: async (fileId) => {
        calls.push(fileId);
        // Right shape, wrong identity — rejected by the id check, never cached.
        return wrong ? bytes("someone-else") : bytes(fileId);
      },
    };
    await render(<Excalidraw assetAdapter={adapter} />);

    publishLocatorFromPeer("f4", "asset://f4");
    await flush();
    expect(calls.length).toBe(1);
    expect(h.app.files.f4).toBeUndefined();

    wrong = false;
    unrelatedSceneUpdate("filler-2");
    await flush();

    expect(calls.length).toBe(2);
    expect(h.app.files.f4?.dataURL).toBe("data:image/png;base64,AAAA");
  });
});
