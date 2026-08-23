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
 * `Collab.runSceneResyncTick` IS covered, in `collab.test.tsx` — which renders
 * `<ExcalidrawApp />` and reaches the real instance via `window.collab`. I first
 * wrote here that no such harness existed and that the tick rested on typecheck
 * alone; that was wrong, and I found the harness only when deleting a dead
 * throttle broke a test using it. What is still NOT covered is the `new-user`
 * handler's catch in `Portal`, which needs a socket to reach.
 *
 * I also wrote and then DELETED a test that re-implemented the tick inline: it
 * would have asserted my own copy of the logic and passed whether or not the
 * shipped code caught anything.
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
