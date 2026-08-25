import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { resolvablePromise } from "@excalidraw-yjs/common";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { mockHTMLImageElement } from "./helpers/mocks";
import { act, render, waitFor } from "./test-utils";

import type { AssetAdapter, BinaryFileData } from "../types";

const { h } = window;

/**
 * T020 — cold load ADOPTS the stored document.
 *
 * The point of the native initial-data form is lineage: adopting the stored
 * bytes keeps the persisted CRDT history, where rebuilding a scene from decoded
 * records starts a fresh one. These pin the observable consequences of that,
 * not the implementation.
 */

/** A durable snapshot, built the way persistence builds one. */
const storedDocument = (build: (scene: Scene) => void) => {
  const source = new Scene();
  build(source);
  return {
    update: source.encodeStateAsUpdate("v2"),
    format: "v2" as const,
    stateVector: Y.encodeStateVector(source.doc),
    doc: source.doc,
  };
};

describe("encodedScene adoption (T020)", () => {
  it("adopts the stored LINEAGE, not just the decoded values", async () => {
    const stored = storedDocument((scene) => {
      scene.replaceAllElements([
        API.createElement({ id: "a", type: "rectangle", x: 10 }),
      ]);
    });

    await render(
      <Excalidraw
        initialData={{ encodedScene: stored, scrollToContent: true }}
      />,
    );

    // The values arrived...
    expect(h.elements.map((e) => e.id)).toEqual(["a"]);

    // ...and so did the lineage. A scene rebuilt from decoded records would
    // carry a fresh clientID and could not be a no-op against the stored state
    // vector. This is the assertion that a record-rebuild cannot pass.
    const delta = Y.encodeStateAsUpdateV2(h.scene.doc, stored.stateVector);
    const probe = new Y.Doc();
    Y.applyUpdateV2(probe, Y.encodeStateAsUpdateV2(stored.doc));
    const before = Y.encodeStateVector(probe);
    Y.applyUpdateV2(probe, delta);
    expect(Y.encodeStateVector(probe)).toEqual(before);
  });

  /**
   * SCOPE, stated because it is weaker than it looks: this drives
   * `Scene.applyRemoteUpdate` directly, NOT the `initialData` branch, so it
   * survives a sabotage that rebuilds the scene from records. It pins the
   * Scene-level guarantee (adoption merges into the existing doc rather than
   * replacing it) and is the reason no `replaceSceneGeneration` may be added
   * after the fetch. The app-level interleaving — a remote update arriving
   * while the persistence fetch is still pending — is NOT covered here; the
   * harness consumes `initialData` at mount, so it cannot stage that race —
   * that is covered separately by the in-flight case at the end of this file,
   * which holds `initialData` unresolved and DOES fail the record-rebuild
   * sabotage.
   */
  it("MERGES with an edit that landed while the snapshot was in flight", async () => {
    const stored = storedDocument((scene) => {
      scene.replaceAllElements([
        API.createElement({ id: "stored", type: "rectangle" }),
      ]);
    });

    // A live editor whose generation already received a remote edit.
    const { container } = await render(<Excalidraw />);
    expect(container).toBeTruthy();

    const peer = new Scene();
    peer.replaceAllElements([
      API.createElement({ id: "inflight", type: "rectangle" }),
    ]);
    act(() => {
      h.scene.applyRemoteUpdate(peer.encodeStateAsUpdate("v2"), "v2");
    });
    expect(h.elements.map((e) => e.id)).toContain("inflight");

    // Adopting the durable snapshot must not discard it.
    act(() => {
      h.scene.applyRemoteUpdate(stored.update, stored.format);
    });

    expect(h.elements.map((e) => e.id).sort()).toEqual(["inflight", "stored"]);
  });

  it("takes collaborative appState from the DOC, not from the caller", async () => {
    const stored = storedDocument((scene) => {
      scene.replaceAllElements([API.createElement({ type: "rectangle" })]);
      scene.setAppState({
        viewBackgroundColor: "#abcdef",
        name: "from-the-doc",
      });
    });

    await render(
      <Excalidraw
        initialData={{
          encodedScene: stored,
          // A caller override of a COLLABORATIVE key must lose: it would be a
          // value no peer ever sees. A LOCAL UI key must still win.
          appState: {
            viewBackgroundColor: "#ff0000",
            name: "from-the-caller",
            zenModeEnabled: true,
          },
        }}
      />,
    );

    expect(h.state.viewBackgroundColor).toBe("#abcdef");
    expect(h.state.name).toBe("from-the-doc");
    expect(h.state.zenModeEnabled).toBe(true);
  });

  it("resolves asset bytes through the adapter and never re-stores them", async () => {
    const calls = { store: [] as string[], resolve: [] as string[] };
    const adapter: AssetAdapter = {
      store: async (f) => {
        calls.store.push(f.id);
        return `asset://${f.id}`;
      },
      resolve: async (fileId) => {
        calls.resolve.push(fileId);
        return {
          id: fileId,
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AAAA",
          created: 1,
        } as BinaryFileData;
      },
    };

    const stored = storedDocument((scene) => {
      scene.replaceAllElements([
        API.createElement({ id: "img", type: "image", fileId: "f1" as any }),
      ]);
      scene.setAssetLocators({ f1: "asset://f1" });
    });

    await render(
      <Excalidraw
        initialData={{ encodedScene: stored }}
        assetAdapter={adapter}
      />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calls.resolve).toContain("f1");
    // Re-storing an already-persisted asset would republish it under a new
    // locator and orphan the stored one.
    expect(calls.store).toEqual([]);
    expect(h.app.files.f1?.dataURL).toBe("data:image/png;base64,AAAA");
  });

  it("renders an asynchronously resolved cold asset without interaction", async () => {
    mockHTMLImageElement(1, 1);

    const resolution = resolvablePromise<BinaryFileData>();
    const store = vi.fn(async (f: BinaryFileData) => `asset://${f.id}`);
    const adapter: AssetAdapter = {
      store,
      resolve: async () => resolution,
    };
    const stored = storedDocument((scene) => {
      scene.replaceAllElements([
        API.createElement({ id: "img", type: "image", fileId: "f1" as any }),
      ]);
      scene.setAssetLocators({ f1: "asset://f1" });
    });

    await render(
      <Excalidraw
        initialData={{ encodedScene: stored }}
        assetAdapter={adapter}
      />,
    );

    expect(h.app.imageCache.has("f1" as any)).toBe(false);

    await act(async () => {
      resolution.resolve({
        id: "f1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      } as BinaryFileData);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.app.files.f1).toBeDefined();
    expect(h.app.imageCache.has("f1" as any)).toBe(true);
    expect(store).not.toHaveBeenCalled();
  });

  it("fails loud when a caller supplies BOTH forms", async () => {
    const stored = storedDocument((scene) => {
      scene.replaceAllElements([
        API.createElement({ id: "from-doc", type: "rectangle" }),
      ]);
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await render(
      <Excalidraw
        initialData={
          {
            encodedScene: stored,
            elements: [
              API.createElement({ id: "from-records", type: "rectangle" }),
            ],
          } as any
        }
      />,
    );
    spy.mockRestore();

    // Surfaced in the editor, not merely logged — and NEITHER form was applied,
    // which is the point: silently honouring one would be a scene the caller
    // never asked for.
    expect(h.state.errorMessage).toEqual(
      expect.stringContaining("mutually exclusive"),
    );
    expect(h.elements.map((e) => e.id)).not.toContain("from-doc");
    expect(h.elements.map((e) => e.id)).not.toContain("from-records");
  });

  it("still initializes the legacy RECORD form unchanged", async () => {
    await render(
      <Excalidraw
        initialData={{
          elements: [API.createElement({ id: "legacy", type: "rectangle" })],
          appState: { viewBackgroundColor: "#123456" },
        }}
      />,
    );

    expect(h.elements.map((e) => e.id)).toEqual(["legacy"]);
    expect(h.state.viewBackgroundColor).toBe("#123456");
  });

  /**
   * The app-level race, which the Scene-level merge test above cannot stage:
   * a remote update arrives while the durable snapshot is still being fetched.
   *
   * Staged by holding `initialData` unresolved. The editor mounts and its Scene
   * is live while `isLoading` is still true (measured), so a peer edit can be
   * applied into the very generation that adoption will later land in.
   */
  it("keeps an in-flight remote edit when the snapshot resolves LATER", async () => {
    const stored = storedDocument((scene) => {
      scene.replaceAllElements([
        API.createElement({ id: "stored", type: "rectangle" }),
      ]);
    });

    const initialData = resolvablePromise<any>();

    // Deliberately NOT awaited — the scene must still be waiting on the fetch.
    const rendered = render(<Excalidraw initialData={initialData as any} />);
    rendered.catch(() => {});

    await waitFor(() => {
      expect(h.app).toBeDefined();
      expect(h.state.isLoading).toBe(true);
    });

    // A peer edit lands in the fresh generation while the fetch is pending.
    const peer = new Scene();
    peer.replaceAllElements([
      API.createElement({ id: "inflight", type: "rectangle" }),
    ]);
    act(() => {
      h.app.applyRemoteSceneUpdate(peer.encodeStateAsUpdate("v2"), "v2");
    });
    // GUARD: the in-flight edit really is present BEFORE adoption, so losing it
    // below would be adoption dropping it rather than it never arriving.
    expect(h.elements.map((e) => e.id)).toContain("inflight");

    // Now the durable snapshot arrives.
    await act(async () => {
      initialData.resolve({ encodedScene: stored });
    });
    await waitFor(() => {
      expect(h.state.isLoading).toBe(false);
    });

    // Both survive: adopting MERGES into the generation the remote edit landed
    // in. Replacing the generation after the fetch — or rebuilding from records
    // — would drop "inflight" on the floor.
    expect(h.elements.map((e) => e.id).sort()).toEqual(["inflight", "stored"]);
  });
});
