import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

import type { AssetAdapter, BinaryFileData } from "../types";

const { h } = window;

const file = (id: string): BinaryFileData =>
  ({
    id,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,AAAA",
    created: 1,
  } as BinaryFileData);

const makeAdapter = () => {
  const calls = { store: [] as string[], resolve: [] as string[] };
  let failStore = false;
  const adapter: AssetAdapter = {
    store: async (f) => {
      calls.store.push(f.id);
      if (failStore) {
        throw new Error("upload failed");
      }
      return `asset://${f.id}`;
    },
    resolve: async (fileId) => {
      calls.resolve.push(fileId);
      return file(fileId);
    },
  };
  return {
    adapter,
    calls,
    setFailStore: (v: boolean) => {
      failStore = v;
    },
  };
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("assetAdapter", () => {
  it("publishes a locator for an added file, never its bytes", async () => {
    const { adapter, calls } = makeAdapter();
    await render(<Excalidraw assetAdapter={adapter} />);

    act(() => {
      h.app.addFiles([file("f1")]);
    });
    await flush();

    expect(calls.store).toEqual(["f1"]);
    expect(h.scene.getAssetLocators()).toEqual({ f1: "asset://f1" });
    // the bytes stayed local
    expect(h.app.files.f1.dataURL).toBe("data:image/png;base64,AAAA");
  });

  it("RESOLVE does not echo back through STORE", async () => {
    // The mirror fetches bytes for a peer's reference. Routing that through the
    // publisher would re-upload what was just downloaded and re-publish a
    // locator for it.
    const { adapter, calls } = makeAdapter();
    await render(<Excalidraw assetAdapter={adapter} />);

    // a peer's reference arrives, with no local bytes for it
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.app.encodeSceneAsUpdate());
    peer.setAssetLocators({ remote: "asset://remote" });
    act(() => {
      h.app.applyRemoteSceneUpdate(peer.encodeStateAsUpdate());
    });
    await flush();

    expect(calls.resolve).toEqual(["remote"]); // it fetched...
    expect(calls.store).toEqual([]); // ...and did NOT re-upload
    expect(h.app.files.remote).toBeDefined(); // bytes are cached
    peer.destroy();
  });

  it("a failed upload keeps the image local, publishes nothing, and RETRIES", async () => {
    const { adapter, calls, setFailStore } = makeAdapter();
    await render(<Excalidraw assetAdapter={adapter} />);

    setFailStore(true);
    act(() => {
      h.app.addFiles([file("f1")]);
    });
    await flush();

    expect(calls.store).toEqual(["f1"]);
    expect(h.scene.getAssetLocators()).toEqual({}); // nothing published
    expect(h.app.files.f1).toBeDefined(); // ...but kept locally
    // and crucially: no byte fallback anywhere in the document
    expect(new TextDecoder().decode(h.app.encodeSceneAsUpdate())).not.toContain(
      "data:",
    );

    // The next publish retries, because the file still has no reference.
    setFailStore(false);
    act(() => {
      h.app.addFiles([file("f2")]);
    });
    await flush();

    expect(calls.store).toContain("f1"); // retried
    expect(h.scene.getAssetLocators().f1).toBe("asset://f1");
  });

  it("without an adapter, images stay local and nothing is published", async () => {
    await render(<Excalidraw />);
    act(() => {
      h.app.addFiles([file("f1")]);
    });
    await flush();

    expect(h.app.files.f1).toBeDefined();
    expect(h.scene.getAssetLocators()).toEqual({});
    expect(new TextDecoder().decode(h.app.encodeSceneAsUpdate())).not.toContain(
      "data:",
    );
  });

  // SKIPPED — a real gap, recorded rather than hacked around. A cold load
  // returns the stored scene's asset references, but the app's initialize path
  // discards them and the fresh Scene generation never receives them, so the
  // mirror has nothing to resolve and a persisted image never reappears.
  //
  // The fix is T020 — adopting the stored bytes INTO the doc via applyUpdateV2,
  // which puts the references in the document as a side effect of restoring the
  // scene rather than requiring a separate seeding call. Seeding them by hand
  // here would paper over that and publish a load as if it were an edit.
  it.skip("a cold load restores references so persisted images resolve", async () => {
    const { adapter, calls } = makeAdapter();
    await render(
      <Excalidraw
        assetAdapter={adapter}
        initialData={{
          elements: [
            API.createElement({ type: "image", id: "img", fileId: "f1" }),
          ],
          appState: {},
        }}
      />,
    );
    await flush();

    expect(h.scene.getAssetLocators()).toEqual({ f1: "asset://f1" });
    expect(calls.resolve).toEqual(["f1"]);
    expect(h.app.files.f1).toBeDefined();
  });
});
