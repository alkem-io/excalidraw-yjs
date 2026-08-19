import * as Y from "yjs";

import { Scene } from "@excalidraw-yjs/element";

import type { ExcalidrawElement } from "@excalidraw-yjs/element/types";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { render } from "./test-utils";

const { h } = window;

/**
 * T016m — the paste/import commit site.
 *
 * The async-action audit initially recorded that `actionPaste` / `actionLoadScene`
 * "own their own commit boundary". That was false. `addElementsFromPasteOrLibrary`
 * calls `scene.replaceAllElements(nextElements)` — the authoritative whole-scene
 * path T016 replaces — and then `redrawTextBoundingBox`, which mutates Scene
 * again. Other paste branches go through `insertNewElements`, which chunks by
 * `frameId` and calls `insertElementsAtIndex` once per chunk.
 *
 * This measures what a peer actually observes for ONE import, so the claim is
 * grounded in behaviour rather than in a reading of the code.
 */
describe("T016m — paste/import is one logical mutation for a peer", () => {
  const measureImport = async (imported: readonly ExcalidrawElement[]) => {
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
      elements: imported,
      files: null,
      position: "center",
    });

    detachSender();
    detachPeer();
    const result = { senderUpdates: senderUpdates.length, peerStates };
    peer.destroy();
    return result;
  };

  // SKIPPED — asserts the DESIRED contract. Currently fails: the import is several
  // logical writes, so a peer observes intermediate scenes. Un-skip when T016m
  // lands. Not rewritten to assert the broken counts, which would turn a known
  // defect green.
  it.skip("a multi-element import reaches the peer as ONE update", async () => {
    const imported = [
      API.createElement({ type: "rectangle", id: "i1", x: 0, y: 0 }),
      API.createElement({ type: "rectangle", id: "i2", x: 50, y: 0 }),
      API.createElement({ type: "rectangle", id: "i3", x: 100, y: 0 }),
    ];

    const { senderUpdates, peerStates } = await measureImport(imported);

    // GUARD — a green result must not mean "nothing was imported".
    expect(h.elements.length).toBeGreaterThan(1);

    expect(senderUpdates).toBe(1);
    // and the peer never sees a partial import
    expect(peerStates.every((n) => n === 1 || n === 4)).toBe(true);
  });

  // Measurement, always run: records what actually happens today so the RED above
  // is grounded in observed behaviour rather than a reading of the source.
  it("MEASUREMENT: records today's import write count", async () => {
    const imported = [
      API.createElement({ type: "rectangle", id: "m1", x: 0, y: 0 }),
      API.createElement({ type: "rectangle", id: "m2", x: 50, y: 0 }),
    ];

    const { senderUpdates, peerStates } = await measureImport(imported);

    // eslint-disable-next-line no-console
    console.log("[T016m] plain import ->", { senderUpdates, peerStates });
    expect(senderUpdates).toBeGreaterThan(0);
  });

  it("MEASUREMENT: does a text element (redrawTextBoundingBox) add writes?", async () => {
    const imported = [
      API.createElement({ type: "rectangle", id: "t0", x: 0, y: 0 }),
      API.createElement({
        type: "text",
        id: "t1",
        text: "hello world",
        x: 50,
        y: 0,
      }),
    ];

    const { senderUpdates, peerStates } = await measureImport(imported);

    // eslint-disable-next-line no-console
    console.log("[T016m] import WITH TEXT ->", { senderUpdates, peerStates });
    expect(senderUpdates).toBeGreaterThan(0);
  });
});
