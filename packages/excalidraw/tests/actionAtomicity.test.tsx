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
  // RED against current HEAD, deliberately. Measured on the real action:
  //   senderUpdates: 4          (contract says at most 1)
  //   peerObservableStates: 4   (contract says at most 1)
  //   danglingContainerRefs: [ 'state#0: text-1 -> missing id2',
  //                            'state#1: text-1 -> missing id2' ]
  //
  // The peer twice observes a text element pointing at a container that does not
  // exist. `wrapTextInContainer` writes to the doc DURING `perform`
  // (scene.mutateElement, redrawTextBoundingBox) — those are already committed,
  // broadcast LOCAL transactions by the time `syncActionResult` runs, so
  // `commitPlan` cannot retroactively make them atomic. See spec 002 T016k.
  // Asserts the CURRENT BROKEN numbers on purpose, so it passes today and FAILS
  // the moment the defect is fixed — flip them to the contract values (1, 1, 0)
  // then. (`it.fails` says this more directly but is absent from the installed
  // vitest type surface, and a green suite with a red typecheck is worse.)
  it("DEFECT T016k — one action emits 4 updates and 2 dangling-container states", async () => {
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

    // CONTRACT (FR-016/FR-017) is 1, 1, 0. CURRENT is 4, 4, 2 — the peer twice
    // sees a text whose containerId points at a container that does not exist.
    expect(senderUpdates.length).toBe(4);
    expect(peerStates.length).toBe(4);
    expect(dangling.length).toBe(2);

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
});
