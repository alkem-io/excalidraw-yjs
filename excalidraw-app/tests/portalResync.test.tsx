import { vi } from "vitest";

import { WS_SUBTYPES } from "../app_constants";
import Portal from "../collab/Portal";

import type { TCollabClass } from "../collab/Collab";

/**
 * FIX 1 — the periodic full-scene resync must go on the wire as
 * `WS_SUBTYPES.UPDATE`, NOT `WS_SUBTYPES.INIT`.
 *
 * Native-Yjs core (M3): a post-join peer DROPS `INIT` (it is honored only as the
 * one-time first-in-room seed, guarded by `!socketInitialized`) but always
 * applies `UPDATE`. The earlier code routed the throttled periodic resync via
 * `broadcastSceneInit()` (→ INIT), so every already-joined peer silently dropped
 * it and a replica that missed an incremental update never reconverged. The
 * genuine new-peer seed (`new-user` → `broadcastSceneInit`) must STILL use INIT.
 *
 * These tests pin the routing at the wire-construction boundary: `broadcastScene
 * Resync` emits UPDATE, `broadcastSceneInit` emits INIT — both carrying the full
 * encoded doc state.
 */
describe("Portal — periodic resync routes via UPDATE, new-peer seed via INIT (FIX 1)", () => {
  const FULL_STATE = new Uint8Array([1, 2, 3, 4]);

  const makePortal = () => {
    const collab = {
      encodeSceneAsUpdate: vi.fn(() => FULL_STATE),
    } as unknown as TCollabClass;
    const portal = new Portal(collab);
    // Spy on the single wire-emit method both helpers funnel through, so we read
    // the `updateType` directly without the socket/encryption machinery.
    const spy = vi
      .spyOn(portal, "broadcastSceneUpdate")
      .mockResolvedValue(undefined);
    return { portal, spy };
  };

  it("broadcastSceneResync sends WS_SUBTYPES.UPDATE with the full encoded doc state", async () => {
    const { portal, spy } = makePortal();

    await portal.broadcastSceneResync();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WS_SUBTYPES.UPDATE, FULL_STATE);
    // explicitly NOT INIT (which post-join peers drop)
    expect(spy.mock.calls[0][0]).not.toBe(WS_SUBTYPES.INIT);
  });

  it("broadcastSceneInit (new-peer seed) still sends WS_SUBTYPES.INIT", async () => {
    const { portal, spy } = makePortal();

    await portal.broadcastSceneInit();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WS_SUBTYPES.INIT, FULL_STATE);
  });
});
