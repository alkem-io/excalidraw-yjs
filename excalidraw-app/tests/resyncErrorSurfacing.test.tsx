import { vi } from "vitest";

import Portal from "../collab/Portal";

import type { TCollabClass } from "../collab/Collab";

/**
 * A poisoned asset root must reach the user, not the void.
 *
 * `Scene.encodeStateAsUpdate` calls `assertAssetRootValid()` on EVERY encode and
 * throws on a bad value. A remote peer can cause that — `applyRemoteUpdate` does
 * not validate (only encode does), and `assertAssetRootValid`'s docblock records
 * exactly this: "A remote peer can put an arbitrary value in the asset root."
 *
 * Both broadcast paths swallowed it by being un-awaited:
 *
 *   Collab.tsx   setInterval(... void this.portal.broadcastSceneResync())
 *   Portal.tsx   socket.on("new-user", ... this.broadcastSceneInit())
 *
 * so every resync tick threw into the console as an unhandled rejection, the
 * resync safety net was dead, new joiners were never seeded, and the collab
 * error indicator never fired — the user saw nothing.
 *
 * These tests pin the half that is reachable in real code: the throw still
 * propagates out of `Portal.broadcastSceneResync` (fail loud — the fix must not
 * sanitize the root or soften the assertion), and a healthy encode neither
 * rejects nor raises the indicator.
 *
 * COVERAGE LIMIT, stated rather than faked: `Collab.runSceneResyncTick` and the
 * `new-user` handler's catch are NOT exercised here. This repo has no harness
 * that constructs a `Collab` (both are class properties assigned in its
 * constructor, so they cannot be reached off the prototype either), and a test
 * that re-implemented the tick inline would only assert my own copy of the
 * logic — it would pass whether or not the shipped code caught anything. Those
 * two call sites rest on typecheck plus the rejection contract pinned below.
 */

const POISON = "Scene: asset root holds a non-string value";

describe("a failing full-scene encode surfaces instead of vanishing", () => {
  it("broadcastSceneResync still REJECTS — the assertion is not swallowed", async () => {
    const collab = {
      encodeSceneAsUpdate: vi.fn(() => {
        throw new Error(POISON);
      }),
    } as unknown as TCollabClass;
    const portal = new Portal(collab);
    vi.spyOn(portal, "broadcastSceneUpdate").mockResolvedValue(undefined);

    await expect(portal.broadcastSceneResync()).rejects.toThrow(POISON);
  });

  it("a healthy encode neither rejects nor raises the indicator", async () => {
    const setErrorIndicator = vi.fn();
    const collab = {
      encodeSceneAsUpdate: vi.fn(() => new Uint8Array([1, 2, 3])),
      setErrorIndicator,
    } as unknown as TCollabClass;
    const portal = new Portal(collab);
    const spy = vi
      .spyOn(portal, "broadcastSceneUpdate")
      .mockResolvedValue(undefined);

    await expect(portal.broadcastSceneResync()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(setErrorIndicator).not.toHaveBeenCalled();
  });
});
