import { Excalidraw } from "../index";

import { act, render, unmountComponent } from "./test-utils";

import type { AssetAdapter, BinaryFileData } from "../types";

const { h } = window;

const file = (id: string): BinaryFileData =>
  ({
    id,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,AAAA",
    created: 1,
  } as BinaryFileData);

/** An adapter whose `store` only settles when the test says so. */
const gatedAdapter = () => {
  const gates = new Map<
    string,
    { release: (locator: string) => void; reject: (e: unknown) => void }
  >();
  const started: string[] = [];
  const adapter: AssetAdapter = {
    store: (f) => {
      started.push(f.id);
      return new Promise<string>((resolve, reject) => {
        gates.set(f.id, { release: resolve, reject });
      });
    },
    resolve: async (fileId) => file(fileId),
  };
  return {
    adapter,
    started,
    release: (id: string, locator = `asset://${id}`) =>
      act(async () => {
        gates.get(id)!.release(locator);
        await Promise.resolve();
      }),
    fail: (id: string, error: unknown = new Error("upload failed")) =>
      act(async () => {
        gates.get(id)!.reject(error);
        await Promise.resolve();
      }),
  };
};

const settled = <T,>(p: Promise<T>) => {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return () => done;
};

/**
 * `flushAssetPublication` — the awaitable asset boundary.
 *
 * Background publishing is fire-and-forget: `addMissingFiles` kicks a pass and
 * does not wait. That is right while editing and wrong at a save or a close,
 * because **`adapter.store` resolving is not the same as the locator being in
 * the document** — a host that saved immediately could encode an image element
 * with no locator, i.e. content referencing bytes no peer can resolve. These
 * tests hold the boundary at COMMIT, not at `store`.
 */
describe("flushAssetPublication", () => {
  it("stays pending until store releases, and the locator is committed when it resolves", async () => {
    const { adapter, started, release } = gatedAdapter();
    await render(<Excalidraw assetAdapter={adapter} />);

    act(() => {
      h.app.addFiles([file("f1")]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(started).toEqual(["f1"]); // the background pass began

    const flushing = h.app.flushAssetPublication();
    const isDone = settled(flushing);

    // Not resolved while the upload is outstanding, and — the load-bearing half
    // — no locator has been published yet either.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(isDone()).toBe(false);
    expect(h.app.getSceneAssetLocators().f1).toBeUndefined();

    await release("f1");
    const report = await flushing;

    expect(report.failed).toEqual([]);
    expect(report.published).toEqual(["f1"]);
    // Visible in the doc AT resolution, not merely "store returned".
    expect(h.app.getSceneAssetLocators().f1).toBe("asset://f1");
  });

  it("reports a failed store, keeps the bytes local, and publishes nothing", async () => {
    const { adapter, fail } = gatedAdapter();
    await render(<Excalidraw assetAdapter={adapter} />);

    act(() => {
      h.app.addFiles([file("f1")]);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const flushing = h.app.flushAssetPublication();
    await fail("f1");
    const report = await flushing;

    expect(report.published).toEqual([]);
    expect(report.failed.map((f) => f.fileId)).toEqual(["f1"]);
    expect((report.failed[0].error as Error).message).toBe("upload failed");

    // No locator, and above all no dataURL smuggled into the document.
    expect(h.app.getSceneAssetLocators().f1).toBeUndefined();
    expect(JSON.stringify(h.app.getSceneAssetLocators())).not.toContain(
      "data:",
    );
    // The bytes are still cached, which is what makes a retry possible.
    expect(
      (h.app as unknown as { files: Record<string, unknown> }).files.f1,
    ).toBeDefined();
  });

  it("a retry after a failure succeeds", async () => {
    const { adapter, fail, release } = gatedAdapter();
    await render(<Excalidraw assetAdapter={adapter} />);

    act(() => {
      h.app.addFiles([file("f1")]);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const first = h.app.flushAssetPublication();
    await fail("f1");
    expect((await first).failed.map((f) => f.fileId)).toEqual(["f1"]);

    // Retry is the host calling again — there is no autonomous retry.
    const second = h.app.flushAssetPublication();
    await act(async () => {
      await Promise.resolve();
    });
    await release("f1");
    const report = await second;

    expect(report.failed).toEqual([]);
    expect(report.published).toEqual(["f1"]);
    expect(h.app.getSceneAssetLocators().f1).toBe("asset://f1");
  });

  it("never re-uploads a file that already has a locator", async () => {
    // FOUND BY MUTATION TESTING. Deleting the `already has a locator` filter in
    // the publish pass survived the whole suite: the commit-time re-check still
    // stops a redundant WRITE, so the document stays correct and nothing failed.
    // What it does not stop is a redundant UPLOAD — every cached image
    // re-uploaded on every pass, which on a board with fifty images is fifty
    // stores per added file, billed to the host. Correctness tests could not see
    // it; this counts the calls.
    const stores: string[] = [];
    const adapter: AssetAdapter = {
      store: async (f) => {
        stores.push(f.id);
        return `asset://${f.id}`;
      },
      resolve: async (fileId) => file(fileId),
    };
    await render(<Excalidraw assetAdapter={adapter} />);

    act(() => {
      h.app.addFiles([file("f1")]);
    });
    expect((await h.app.flushAssetPublication()).published).toEqual(["f1"]);

    act(() => {
      h.app.addFiles([file("f2")]);
    });
    expect((await h.app.flushAssetPublication()).published).toEqual(["f2"]);

    // f1 was uploaded exactly once, despite being cached through both passes.
    expect(stores).toEqual(["f1", "f2"]);

    // and a flush with nothing pending uploads nothing at all
    const idle = await h.app.flushAssetPublication();
    expect(idle).toEqual({ published: [], skipped: [], failed: [] });
    expect(stores).toEqual(["f1", "f2"]);
  });

  it("unmounting mid-flush resolves with an explicit skip and writes nothing", async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent) => rejections.push(e.reason);
    window.addEventListener("unhandledrejection", onRejection);
    try {
      const { adapter, release } = gatedAdapter();
      await render(<Excalidraw assetAdapter={adapter} />);

      act(() => {
        h.app.addFiles([file("f1")]);
      });
      await act(async () => {
        await Promise.resolve();
      });

      const flushing = h.app.flushAssetPublication();
      const app = h.app;

      act(() => {
        unmountComponent();
      });
      await release("f1");
      const report = await flushing;

      // Explicit, and NOT reported as a failure: nothing went wrong, the commit
      // simply had nowhere to land.
      expect(report.published).toEqual([]);
      expect(report.failed).toEqual([]);
      expect(report.skipped).toEqual([{ fileId: "f1", reason: "unmounted" }]);
      // No post-unmount write reached the document.
      expect(app.getSceneAssetLocators().f1).toBeUndefined();

      await act(async () => {
        await Promise.resolve();
      });
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });
});
