import React from "react";

import { Scene } from "@excalidraw-yjs/element";
import * as Y from "yjs";

import { Excalidraw } from "../index";

import { act, render } from "./test-utils";

import type { AssetAdapter, BinaryFileData, FileId } from "../types";

const { h } = window;

/**
 * A failing `resolve` must not be retried forever.
 *
 * `refreshFilesFromScene` computes `missing` from "locator present, bytes absent,
 * nothing in flight", then unconditionally re-enters itself when the batch
 * settles. On a rejection the `catch` only logs, the `finally` clears the
 * in-flight key, and nothing records that the attempt failed — so the re-entry
 * recomputes an IDENTICAL `missing` set and fires again immediately.
 *
 * With a real network that is a permanent request storm for the lifetime of the
 * editor. With a rejection that never yields to the network — a cached 404, a
 * synchronous throw inside the async fn, an aborted fetch — `Promise.all`
 * settles on the next microtask and the loop is tight enough to freeze the tab.
 *
 * The same hole exists for the wrong-id branch: it `return`s without caching, so
 * that entry is still "missing" on the next pass.
 *
 * The remedy under test is deliberately minimal — remember which
 * `fileId\0locator` pairs failed and stop treating them as missing. No backoff,
 * no timers, no retry subsystem. A NEW locator is a different key, so a genuine
 * change still refetches; that is asserted below so the fix cannot be "never
 * resolve anything again".
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

/** Put a locator in the doc with no local bytes — exactly what a peer's
 * publish looks like to this replica. */
const publishLocatorFromPeer = (fileId: string, locator: string) => {
  const peer = new Scene(undefined, { doc: new Y.Doc() });
  peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());
  peer.setAssetLocators({ ...peer.getAssetLocators(), [fileId]: locator });
  act(() => {
    h.scene.applyRemoteUpdate(peer.encodeStateAsUpdate());
  });
  peer.destroy();
};

describe("a failing assetAdapter.resolve is not retried forever", () => {
  it("a permanently rejecting resolve is attempted a bounded number of times", async () => {
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
    // The contract: bounded. Unbounded recursion shows up here as a huge number.
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("an adapter returning the WRONG id is also bounded", async () => {
    const calls: string[] = [];
    const adapter: AssetAdapter = {
      store: async (f) => `asset://${f.id}`,
      resolve: async (fileId) => {
        calls.push(fileId);
        // Right shape, wrong identity — rejected by the id check, never cached.
        return bytes("someone-else");
      },
    };
    await render(<Excalidraw assetAdapter={adapter} />);

    publishLocatorFromPeer("f2", "asset://f2");
    await flush();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("a NEW locator for the same file is still retried after a failure", async () => {
    const calls: string[] = [];
    let failing = true;
    const adapter: AssetAdapter = {
      store: async (f) => `asset://${f.id}`,
      resolve: async (fileId: FileId) => {
        calls.push(fileId);
        if (failing) {
          throw new Error("gone");
        }
        return bytes(fileId);
      },
    };
    await render(<Excalidraw assetAdapter={adapter} />);

    publishLocatorFromPeer("f3", "asset://f3-v1");
    await flush();
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // The host republished the asset elsewhere: a different locator is a
    // different key, so the failure must not be sticky across it.
    failing = false;
    publishLocatorFromPeer("f3", "asset://f3-v2");
    await flush();

    expect(calls.length).toBeGreaterThan(afterFirst);
    expect(h.app.files.f3?.dataURL).toBe("data:image/png;base64,AAAA");
  });
});
