import * as Y from "yjs";

import { pointFrom } from "@excalidraw-yjs/math";

import type { LocalPoint } from "@excalidraw-yjs/math";

import { newArrowElement, newElement } from "../newElement";
import { Scene } from "../Scene";
import { ELEMENTS } from "../yjs/schema";

import type { ExcalidrawElement, ExcalidrawLinearElement } from "../types";

/**
 * Regression: an undo that races a peer's concurrent edit of the SAME keys must
 * never leave an element without a required property.
 *
 * Production incident (2026-11-03): user B dragged a rectangle, so its bound
 * arrow was rewritten every frame (`x`/`y`/`width`/`height`/`points`). Peer A
 * (a LOWER Yjs client id) was concurrently dragging that arrow's endpoint
 * (`height`/`points`). B then pressed undo. `Y.UndoManager` deleted B's writes
 * but refused to restore the pre-drag value ("conflicts with a change from
 * another client"), and A's concurrent value had already been tombstoned when it
 * lost the map-key conflict — so `points` and `height` vanished from the doc.
 * Every replica then materialized an arrow with no `points`, and every editor
 * on the board crashed in the renderer.
 */

const rect = (id: string): ExcalidrawElement =>
  newElement({
    type: "rectangle",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  } as Parameters<typeof newElement>[0]) as ExcalidrawElement;

const arrow = (id: string): ExcalidrawLinearElement =>
  newArrowElement({
    type: "arrow",
    id,
    x: 10,
    y: 10,
    width: 100,
    height: 0,
    points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(100, 0)],
  } as Parameters<typeof newArrowElement>[0]) as ExcalidrawLinearElement;

const sceneWithClientId = (clientID: number): Scene => {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return new Scene(null, { doc });
};

/** Manual-flush link: updates queue until `flush()`, so edits can be staged
 * concurrently on both replicas before either sees the other's. */
const link = (a: Scene, b: Scene) => {
  let toA: Uint8Array[] = [];
  let toB: Uint8Array[] = [];
  const off = [
    a.onDocUpdate((u) => toB.push(u)),
    b.onDocUpdate((u) => toA.push(u)),
  ];
  return {
    flush() {
      for (let i = 0; i < 50 && (toA.length || toB.length); i++) {
        const forB = toB;
        toB = [];
        forB.forEach((u) => b.applyRemoteUpdate(u));
        const forA = toA;
        toA = [];
        forA.forEach((u) => a.applyRemoteUpdate(u));
      }
    },
    destroy() {
      off.forEach((d) => d());
    },
  };
};

const getArrow = (s: Scene, id: string) =>
  s.getElement(id) as ExcalidrawLinearElement;

/** Props of the arrow as the DOC holds them — raw entries, not `yMapToElement`,
 * so the read-side defaults cannot mask a key the doc actually lost. */
const docArrow = (s: Scene, id: string) =>
  s.doc
    .getMap<Y.Map<unknown>>(ELEMENTS)
    .get(id)!
    .toJSON() as Partial<ExcalidrawLinearElement>;

describe("undo racing a concurrent peer edit of the same keys", () => {
  it("never leaves the arrow without points/height on either replica", () => {
    // Real ids from the incident: the peer's id is lower than the undoer's,
    // which is the ordering where the peer's concurrent write loses the
    // map-key conflict and is tombstoned.
    const peer = sceneWithClientId(1125037587);
    const undoer = sceneWithClientId(2253171213);
    const net = link(peer, undoer);

    peer.replaceAllElements([rect("rect"), arrow("arrow")]);
    net.flush();
    peer.clearElementHistory();
    undoer.clearElementHistory();

    const drag = (i: number) => {
      undoer.mutateElement(undoer.getElement("rect")!, { x: i, y: i });
      undoer.mutateElement(getArrow(undoer, "arrow"), {
        x: 10 + i,
        y: 10 + i,
        width: 100 + i,
        height: i,
        points: [
          pointFrom<LocalPoint>(0, 0),
          pointFrom<LocalPoint>(100 + i, i),
        ],
      });
    };

    // First drag frame, then the peer edits the arrow's endpoint before either
    // side has seen the other's change.
    drag(1);
    for (let j = 0; j < 3; j++) {
      peer.mutateElement(getArrow(peer, "arrow"), {
        height: 50 + j,
        points: [
          pointFrom<LocalPoint>(0, 0),
          pointFrom<LocalPoint>(100, 50 + j),
        ],
      });
    }
    net.flush();
    for (let i = 2; i <= 6; i++) {
      drag(i);
    }
    undoer.stopElementCapture();
    net.flush();

    expect(undoer.undoElements()).toBe(true);
    net.flush();

    for (const s of [undoer, peer]) {
      const a = docArrow(s, "arrow");
      expect(Array.isArray(a.points)).toBe(true);
      expect(a.points!.length).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(a.height)).toBe(true);
      // The keys the undo could restore were restored.
      expect(a.x).toBe(10);
      expect(a.y).toBe(10);
      expect(a.width).toBe(100);
    }
    expect(docArrow(undoer, "arrow")).toEqual(docArrow(peer, "arrow"));

    net.destroy();
    peer.destroy();
    undoer.destroy();
  });

  it("a doc that already lost points/height still materializes a renderable arrow", () => {
    // The live board from the incident: the doc itself is already damaged, so
    // every client that loads it must still get a valid element.
    const source = new Scene([arrow("arrow")]);
    const doc = source.doc;
    const yArrow = doc.getMap<Y.Map<unknown>>(ELEMENTS).get("arrow")!;
    doc.transact(() => {
      yArrow.set("width", 911);
      yArrow.delete("points");
      yArrow.delete("height");
    });

    const loaded = new Scene(null, { doc });
    const a = loaded.getElement("arrow") as ExcalidrawLinearElement;
    expect(a.height).toBe(0);
    expect(a.points).toEqual([
      [0, 0],
      [911, 0],
    ]);

    loaded.destroy();
    source.destroy();
  });

  it("an undo with no concurrent edit still restores every key exactly", () => {
    const peer = sceneWithClientId(1125037587);
    const undoer = sceneWithClientId(2253171213);
    const net = link(peer, undoer);
    peer.replaceAllElements([arrow("arrow")]);
    net.flush();
    undoer.clearElementHistory();

    undoer.mutateElement(getArrow(undoer, "arrow"), {
      height: 7,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(100, 7)],
    });
    undoer.stopElementCapture();
    expect(undoer.undoElements()).toBe(true);
    net.flush();

    for (const s of [undoer, peer]) {
      const a = docArrow(s, "arrow");
      expect(a.height).toBe(0);
      expect(a.points).toEqual([
        [0, 0],
        [100, 0],
      ]);
    }

    net.destroy();
    peer.destroy();
    undoer.destroy();
  });
});
