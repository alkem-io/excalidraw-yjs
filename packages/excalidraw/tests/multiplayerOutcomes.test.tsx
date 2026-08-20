import * as Y from "yjs";

import { CaptureUpdateAction, Scene } from "@excalidraw-yjs/element";

import type { ExcalidrawElement } from "@excalidraw-yjs/element/types";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { act, render } from "./test-utils";

const { h } = window;

/**
 * SC-002 — multiplayer outcomes, measured at the PRODUCTION boundary.
 *
 * This replaces the retired `describe.skip("multiplayer undo/redo")` block. That
 * block never exercised multiplayer at all: audited directly, its 37 tests make
 * 71 `API.updateScene` calls and **zero** calls to `applyRemoteSceneUpdate`,
 * `applyRemoteUpdate` or `encodeStateAsUpdate`. `API.updateScene(…,
 * captureUpdate: NEVER)` is `Scene.replaceAllElements(recordHistory: false)` —
 * a write to the SAME doc under the SAME client identity, `STRUCTURAL_ORIGIN`.
 * Production collaboration is a DIFFERENT replica's structs arriving through
 * `App.applyRemoteSceneUpdate` under `REMOTE_ORIGIN`. Those are not the same
 * thing, so the old block's failures were never product debt. See T002.
 *
 * Every test here therefore:
 *   - uses a real second `Scene` with its own `Y.Doc` and a DISTINCT `clientID`
 *     (asserted, or the test would be measuring one replica talking to itself),
 *   - delivers the peer's work through `h.app.applyRemoteSceneUpdate` — the
 *     production entry point — with a delivery count asserted so an unlinked
 *     peer cannot pass vacuously,
 *   - and asserts PRODUCT OUTCOMES only: which elements exist and what their
 *     user-visible values are. No render counts, no generated ids or versions,
 *     no `StoreDelta` shapes, no absolute history-stack depths — those are the
 *     recorded artifacts that made the old block fail.
 */
describe("SC-002: multiplayer outcomes at the production boundary", () => {
  /** A real second replica, linked in BOTH directions through the App API. */
  const linkPeer = () => {
    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.app.encodeSceneAsUpdate());

    let outbound = 0;
    const detach = h.app.onLocalSceneUpdate((update: Uint8Array) => {
      outbound++;
      peer.applyRemoteUpdate(update);
    });

    /** How many structs OUR doc holds that the PEER's client identity authored. */
    const peerClock = () =>
      Y.decodeStateVector(h.app.encodeSceneStateVector()).get(
        peer.doc.clientID,
      ) ?? 0;

    let inbound = 0;
    /**
     * Deliver everything the peer has that we lack, through production code.
     *
     * The post-condition is the load-bearing part: our doc must now hold structs
     * authored by the PEER's client identity. Without it this whole matrix is
     * satisfied by a same-doc structural write — measured, sabotaging `deliver`
     * to `API.updateScene(…, NEVER)` (exactly what the retired block called a
     * "remote update") left all six cases GREEN. That is the difference between
     * testing multiplayer and testing one replica talking to itself.
     */
    const deliver = () => {
      const before = peerClock();
      const delta = peer.encodeStateAsUpdate(
        "v1",
        h.app.encodeSceneStateVector(),
      );
      act(() => {
        h.app.applyRemoteSceneUpdate(delta, "v1");
      });
      inbound++;
      expect(peerClock()).toBeGreaterThan(before);
    };

    // Guard: a peer sharing our client identity would make every case vacuous.
    expect(peer.doc.clientID).not.toBe(h.scene.doc.clientID);

    return {
      peer,
      detach,
      deliver,
      outbound: () => outbound,
      inbound: () => inbound,
    };
  };

  /** Mutate on the peer as the peer's OWN local edit. */
  const peerEdits = (
    peer: Scene,
    fn: (els: readonly ExcalidrawElement[]) => ExcalidrawElement[],
  ) => peer.replaceAllElements(fn(peer.getElementsIncludingDeleted()));

  /**
   * Seed the scene the way a host does — through the public `updateScene` with
   * an explicit capture. NOT `API.setElements`, which writes elements into the
   * scene without the store snapshot agreeing; measured, that leaves a baseline
   * whose later property edits are unreachable from the UI undo even though
   * `Scene.undoElements()` can still revert them. That is a harness artifact,
   * not a product defect (verified: the same edit undoes correctly when the
   * baseline comes from `updateScene` or from `UI.createElement`) — but it
   * would have made these cases pass for the wrong reason.
   */
  const seed = (elements: ExcalidrawElement[]) =>
    act(() => {
      API.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });

  const byId = (id: string) => h.elements.find((e) => e.id === id);
  const live = () => h.elements.filter((e) => !e.isDeleted).map((e) => e.id);

  const setBackground = (color: string) =>
    act(() => {
      h.app.actionManager.executeAction(
        h.app.actionManager.actions.changeViewBackgroundColor as never,
        "ui",
        { viewBackgroundColor: color } as never,
      );
    });

  beforeEach(async () => {
    // `handleKeyboardGlobally` is what makes `Keyboard.undo()` reach the app in
    // this harness — without it the keypress goes nowhere and every "survives
    // undo" assertion below would pass vacuously. That is not hypothetical: it
    // is how the first draft of this file passed. Each case therefore also
    // carries a POSITIVE CONTROL asserting the local edit really was reverted.
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  // (a)
  it("a remote element on a DIFFERENT element survives local undo and redo", () => {
    seed([API.createElement({ type: "rectangle", id: "mine" })]);
    const { peer, detach, deliver, inbound } = linkPeer();
    try {
      act(() => {
        API.updateScene({
          elements: [
            ...h.elements,
            API.createElement({ type: "rectangle", id: "local-2", x: 5 }),
          ],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });

      peerEdits(peer, (els) => [
        ...els,
        API.createElement({ type: "rectangle", id: "theirs", x: 50 }),
      ]);
      deliver();
      expect(inbound()).toBe(1);
      expect(live()).toContain("theirs");

      Keyboard.undo();
      expect(live()).not.toContain("local-2"); // control: undo did something
      expect(live()).toContain("theirs");
      Keyboard.redo();
      expect(live()).toContain("local-2"); // control: redo did something
      expect(live()).toContain("theirs");
    } finally {
      detach();
      peer.destroy();
    }
  });

  // (b)
  it("a remote change to a DIFFERENT property of the same element survives local undo", () => {
    seed([API.createElement({ type: "rectangle", id: "shared", x: 0 })]);
    const { peer, detach, deliver } = linkPeer();
    try {
      // local edits x
      act(() => {
        API.updateScene({
          elements: h.elements.map((e) =>
            e.id === "shared" ? { ...e, x: 111 } : e,
          ),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });
      // peer edits strokeColor on the SAME element
      peerEdits(peer, (els) =>
        els.map((e) =>
          e.id === "shared" ? { ...e, strokeColor: "#00ff00" } : e,
        ),
      );
      deliver();
      expect(byId("shared")?.strokeColor).toBe("#00ff00");

      Keyboard.undo();
      expect(byId("shared")?.x).toBe(0); // control: our x edit was reverted
      // the peer's property is untouched by our undo
      expect(byId("shared")?.strokeColor).toBe("#00ff00");
    } finally {
      detach();
      peer.destroy();
    }
  });

  // (c)
  it("a causally-LATER remote value on the same property is not undone by local undo", () => {
    seed([
      API.createElement({
        type: "rectangle",
        id: "shared",
        backgroundColor: "transparent",
      }),
    ]);
    const { peer, detach, deliver, outbound } = linkPeer();
    try {
      act(() => {
        API.updateScene({
          elements: h.elements.map((e) =>
            e.id === "shared" ? { ...e, backgroundColor: "#ff0000" } : e,
          ),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });
      // the peer SAW our red (outbound link) and then wrote yellow on top
      expect(outbound()).toBeGreaterThan(0);
      expect(
        peer.getElementsIncludingDeleted().find((e) => e.id === "shared")
          ?.backgroundColor,
      ).toBe("#ff0000");
      peerEdits(peer, (els) =>
        els.map((e) =>
          e.id === "shared" ? { ...e, backgroundColor: "#ffff00" } : e,
        ),
      );
      deliver();
      expect(byId("shared")?.backgroundColor).toBe("#ffff00");

      // Undoing our own red must not resurrect it over a causally-later value.
      Keyboard.undo();
      expect(byId("shared")?.backgroundColor).toBe("#ffff00");
    } finally {
      detach();
      peer.destroy();
    }
  });

  // (d)
  it("a remote delete is not resurrected by local history navigation", () => {
    seed([
      API.createElement({ type: "rectangle", id: "a" }),
      API.createElement({ type: "rectangle", id: "doomed" }),
    ]);
    const { peer, detach, deliver } = linkPeer();
    try {
      act(() => {
        API.updateScene({
          elements: h.elements.map((e) => (e.id === "a" ? { ...e, x: 77 } : e)),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });

      peerEdits(peer, (els) =>
        els.map((e) => (e.id === "doomed" ? { ...e, isDeleted: true } : e)),
      );
      deliver();
      expect(live()).not.toContain("doomed");

      Keyboard.undo();
      expect(byId("a")?.x).toBe(0); // control: our move was reverted
      expect(live()).not.toContain("doomed");
      Keyboard.redo();
      expect(byId("a")?.x).toBe(77); // control: redo re-applied it
      expect(live()).not.toContain("doomed");
    } finally {
      detach();
      peer.destroy();
    }
  });

  // (e)
  it("bound text and arrow bindings stay referentially consistent across a remote change and a local undo", () => {
    const container = API.createElement({
      type: "rectangle",
      id: "container",
      boundElements: [{ id: "label", type: "text" }],
    });
    const label = API.createElement({
      type: "text",
      id: "label",
      containerId: "container",
    });
    const target = API.createElement({ type: "rectangle", id: "target" });
    const arrow = API.createElement({
      type: "arrow",
      id: "arrow",
      startBinding: { elementId: "container", focus: 0, gap: 1 } as never,
      endBinding: { elementId: "target", focus: 0, gap: 1 } as never,
    });
    seed([container, label, target, arrow]);

    const { peer, detach, deliver } = linkPeer();
    try {
      act(() => {
        API.updateScene({
          elements: h.elements.map((e) =>
            e.id === "container" ? { ...e, x: 40 } : e,
          ),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });

      peerEdits(peer, (els) =>
        els.map((e) => (e.id === "target" ? { ...e, y: 300 } : e)),
      );
      deliver();

      const dangling = () => {
        const ids = new Set(h.elements.map((e) => e.id));
        const bad: string[] = [];
        for (const el of h.elements) {
          const cid = (el as { containerId?: string | null }).containerId;
          if (cid && !ids.has(cid)) {
            bad.push(`${el.id}.containerId -> ${cid}`);
          }
          for (const b of (el as { boundElements?: { id: string }[] | null })
            .boundElements ?? []) {
            if (!ids.has(b.id)) {
              bad.push(`${el.id}.boundElements -> ${b.id}`);
            }
          }
          for (const key of ["startBinding", "endBinding"] as const) {
            const bind = (
              el as unknown as Record<string, { elementId?: string } | null>
            )[key];
            if (bind?.elementId && !ids.has(bind.elementId)) {
              bad.push(`${el.id}.${key} -> ${bind.elementId}`);
            }
          }
        }
        return bad;
      };

      expect(dangling()).toEqual([]);
      Keyboard.undo();
      expect(byId("container")?.x).toBe(0); // control: our move was reverted
      expect(dangling()).toEqual([]);
      Keyboard.redo();
      expect(byId("container")?.x).toBe(40); // control: redo re-applied it
      expect(dangling()).toEqual([]);
      // and the peer's move is still there
      expect(byId("target")?.y).toBe(300);
    } finally {
      detach();
      peer.destroy();
    }
  });

  // (f)
  it("a peer change is not a local undo step, and local undo still reaches the peer", () => {
    seed([API.createElement({ type: "rectangle", id: "mine", x: 0 })]);
    const { peer, detach, deliver, outbound } = linkPeer();
    try {
      setBackground("#123456");

      peerEdits(peer, (els) => [
        ...els,
        API.createElement({ type: "rectangle", id: "theirs" }),
      ]);
      deliver();
      expect(live()).toContain("theirs");

      const before = outbound();
      Keyboard.undo();

      // The FIRST undo reverts OUR edit, not the peer's — if the peer's change
      // had become a local undo step it would have been consumed here instead.
      expect(h.scene.getPersistedAppState().viewBackgroundColor).not.toBe(
        "#123456",
      );
      expect(live()).toContain("theirs");

      // and the undo was published: the peer converges on the reverted value.
      expect(outbound()).toBeGreaterThan(before);
      expect(peer.getPersistedAppState().viewBackgroundColor).toBe(
        h.scene.getPersistedAppState().viewBackgroundColor,
      );
    } finally {
      detach();
      peer.destroy();
    }
  });
});
