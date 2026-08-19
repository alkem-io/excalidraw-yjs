import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { render } from "./test-utils";

const { h } = window;

/**
 * T016m — the paste/import commit site must be ONE logical mutation for a peer.
 *
 * `App.addElementsFromPasteOrLibrary` calls `scene.replaceAllElements(...)`, the
 * authoritative whole-scene path T016 replaces. Measured today: an import that
 * adds ids emits 2 transport updates, and the already-known structural/reveal
 * split for new ids (FR-017) is the leading cause.
 */
describe("T016m — paste/import is one logical mutation for a peer", () => {
  // SKIPPED — asserts the DESIRED contract, which currently fails. Un-skip when
  // T016m lands. Deliberately not rewritten to assert today's counts, which would
  // turn a known defect green.
  it.skip("a multi-element import reaches the peer as ONE update", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
    API.setElements([API.createElement({ type: "rectangle", id: "pre" })]);

    const peer = new Scene(undefined, { doc: new Y.Doc() });
    peer.applyRemoteUpdate(h.scene.encodeStateAsUpdate());

    const senderUpdates: Uint8Array[] = [];
    const peerStates: number[] = [];
    const detachSender = h.scene.onDocUpdate((u) => {
      senderUpdates.push(u);
      peer.applyRemoteUpdate(u);
    });
    const detachPeer = peer.onUpdate(() => {
      peerStates.push(peer.getElementsIncludingDeleted().length);
    });

    h.app.addElementsFromPasteOrLibrary({
      elements: [
        API.createElement({ type: "rectangle", id: "i1", x: 0, y: 0 }),
        API.createElement({ type: "rectangle", id: "i2", x: 50, y: 0 }),
        API.createElement({ type: "rectangle", id: "i3", x: 100, y: 0 }),
      ],
      files: null,
      position: "center",
    });

    expect(senderUpdates.length).toBe(1);

    // EXACTLY one receiver state, asserted by equality rather than by
    // `.every(...)` — which passes on an EMPTY array and would prove nothing
    // about the receiver at all (the sender-count-only hole recorded in T016g).
    expect(peerStates).toEqual([4]);

    // ...and the peer converges on the sender's exact content.
    const sender = h.scene
      .getElementsIncludingDeleted()
      .map((e) => `${e.id}:${e.x},${e.y}`)
      .sort();
    const received = peer
      .getElementsIncludingDeleted()
      .map((e) => `${e.id}:${e.x},${e.y}`)
      .sort();
    expect(received).toEqual(sender);

    detachSender();
    detachPeer();
    peer.destroy();
  });
});
