import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import type { ExcalidrawElement } from "@excalidraw-yjs/element/types";

import { actionWrapTextInContainer } from "../actions/actionBoundText";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { render } from "./test-utils";

const { h } = window;

/**
 * FR-016/FR-017 atomicity, asserted around a REAL action rather than around
 * `commitPlan` in isolation.
 *
 * `commitPlan` can only make the FINAL result transaction atomic. An action that
 * writes to the doc during `perform` — `wrapTextInContainer` calls
 * `scene.mutateElement` and `redrawTextBoundingBox` before `syncActionResult`
 * ever runs — has already emitted those as separate LOCAL transactions and
 * broadcasts. A test that links the replicas only for the final sync, or that
 * checks only the final order, passes over exactly that violation.
 *
 * So: link BEFORE the action, count everything, and inspect every intermediate
 * state the receiver observes.
 */
describe("one action, one logical mutation", () => {
  // HISTORICAL, before the logical-mutation boundary existed. Measured then:
  //   senderUpdates: 4          (contract says at most 1)
  //   peerObservableStates: 4   (contract says at most 1)
  //   danglingContainerRefs: [ 'state#0: text-1 -> missing id2',
  //                            'state#1: text-1 -> missing id2' ]
  //
  // The peer twice OBSERVED a text element pointing at a container that did not
  // exist yet. `wrapTextInContainer` writes to the doc DURING `perform`
  // (scene.mutateElement, redrawTextBoundingBox), and those were already
  // committed, broadcast LOCAL transactions by the time `syncActionResult` ran,
  // so `commitPlan` could not retroactively make them atomic. See spec 002 T016k.
  //
  // FIXED by the Scene-level boundary, which buffers delivery across the whole
  // action. This asserts the CONTRACT values (1, 1, 0); the assertions below are
  // the source of truth, not this comment.
  it("wrapTextInContainer is ONE logical mutation for the peer", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);

    const text = API.createElement({
      type: "text",
      id: "text-1",
      text: "hello",
      x: 0,
      y: 0,
    });
    API.setElements([text]);
    API.setSelectedElements([text]);

    // A peer, synced to the pre-action state, linked BEFORE the action runs.
    const peerDoc = new Y.Doc();
    const peer = new Scene(undefined, { doc: peerDoc });
    peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());

    const senderUpdates: Uint8Array[] = [];
    const peerStates: ReadonlyArray<ExcalidrawElement>[] = [];
    const detachSender = h.scene.onDocUpdate((u) => {
      senderUpdates.push(u);
      peer.applyRemoteUpdate(u);
    });
    const detachPeer = peer.onUpdate(() => {
      peerStates.push(peer.getElementsIncludingDeleted() as never);
    });

    API.executeAction(actionWrapTextInContainer);

    const dangling: string[] = [];
    for (const state of peerStates) {
      const ids = new Set(state.map((e) => e.id));
      for (const el of state) {
        const containerId = (el as { containerId?: string | null }).containerId;
        if (containerId && !ids.has(containerId)) {
          dangling.push(`${el.id} -> missing ${containerId}`);
        }
      }
    }

    // GUARDS — without these a green result could mean "the action never ran"
    // or "the receiver was never linked", which is how such a test goes vacuous.
    expect(h.elements.length).toBeGreaterThan(1);
    expect(senderUpdates.length).toBeGreaterThan(0);

    // THE CONTRACT (FR-016/FR-017): ONE transport message, so a peer observes
    // ONE state and never an intermediate one — here, a text element whose
    // container does not exist yet. This is a TRANSPORT guarantee: the sender's
    // own Scene/Store callbacks may still fire several times locally, and this
    // test deliberately does not claim otherwise.
    expect(senderUpdates.length).toBe(1);
    expect(peerStates.length).toBe(1);
    expect(dangling).toEqual([]);

    // 4. final order: the container sits immediately below its text
    const finalOrder = peer.getElementsIncludingDeleted();
    const textIdx = finalOrder.findIndex((e) => e.id === "text-1");
    const container = finalOrder[textIdx - 1];
    expect(container).toBeDefined();
    expect((finalOrder[textIdx] as { containerId?: string }).containerId).toBe(
      container.id,
    );

    detachSender();
    detachPeer();
    peer.destroy();
  });

  /**
   * T016b — the ORDER the action intends must survive the boundary.
   *
   * `pushContainerBelowText` runs `syncMovedIndices`, which mints DISTINCT
   * indices placing the new container immediately below its text. The action
   * then re-reads every element from the live doc, which restores the text's OLD
   * doc index and ties it against the fresh container. Today's authoritative
   * `replaceAllElements` repairs that tie on the way in, which is exactly why
   * the re-read looks harmless — but the repair is a global re-index, not the
   * action's intent, and with a third element present the result is the wrong
   * z-order.
   *
   * n = 3 on purpose: with only the pair there is nothing for a repaired tie to
   * be ordered WRONG against.
   */
  it("keeps the container directly below its text, locally and at a peer", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);

    const below = API.createElement({
      type: "rectangle",
      id: "below",
      x: 0,
      y: 0,
    });
    const text = API.createElement({
      type: "text",
      id: "text-1",
      text: "hello",
      x: 0,
      y: 0,
    });
    const above = API.createElement({
      type: "rectangle",
      id: "above",
      x: 0,
      y: 0,
    });
    API.setElements([below, text, above]);
    API.setSelectedElements([text]);

    const peerDoc = new Y.Doc();
    const peer = new Scene(undefined, { doc: peerDoc });
    peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());

    const senderUpdates: Uint8Array[] = [];
    const detachSender = h.scene.onDocUpdate((u) => {
      senderUpdates.push(u);
      peer.applyRemoteUpdate(u);
    });

    API.executeAction(actionWrapTextInContainer);

    detachSender();

    const orderOf = (els: readonly ExcalidrawElement[]) => {
      const textEl = els.find((e) => e.id === "text-1")!;
      const containerId = (textEl as { containerId?: string | null })
        .containerId;
      const ids = els.map((e) => e.id);
      return {
        containerId,
        containerIdx: ids.indexOf(containerId ?? "\u0000none"),
        textIdx: ids.indexOf("text-1"),
        ids,
      };
    };

    // GUARDS: the action ran, a container was created, and the peer was linked.
    expect(senderUpdates.length).toBeGreaterThan(0);
    const local = orderOf(h.elements);
    expect(local.containerId).toBeTruthy();
    expect(h.elements.length).toBe(4);

    // The container must sit DIRECTLY below its text — that is what
    // `pushContainerBelowText` intended.
    expect(local.containerIdx).toBe(local.textIdx - 1);

    // ...and the peer must agree, since order is carried by the shared indices.
    const remote = orderOf(
      peer.getElementsIncludingDeleted() as unknown as readonly ExcalidrawElement[],
    );
    expect(remote.containerIdx).toBe(remote.textIdx - 1);
    expect(remote.ids).toEqual(local.ids);

    peer.destroy();
  });
});
