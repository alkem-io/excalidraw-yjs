import * as Y from "yjs";

import { newElement } from "../newElement";
import { Scene } from "../Scene";

import type { ExcalidrawElement } from "../types";

const mk = (id: string): ExcalidrawElement =>
  ({
    ...(newElement({
      type: "rectangle",
      id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as Parameters<typeof newElement>[0]) as ExcalidrawElement),
    id,
  } as ExcalidrawElement);

const liveIds = (scene: Scene) =>
  scene
    .getElementsIncludingDeleted()
    .filter((e) => !e.isDeleted)
    .map((e) => e.id)
    .sort();

/**
 * A non-recording write and the full-state encode must tell peers the same story.
 *
 * Withholding a non-recording write from the incremental callback never hid it:
 * its structs and delete-set stay in the shared doc, so once that doc is also the
 * FULL-STATE sync source (INIT seed, periodic resync, persistence) the next
 * `encodeStateAsUpdate` carries it anyway — and applying that to a peer deleted
 * the peer's elements. The two paths must agree, and work that must NOT reach
 * peers has to happen on a doc peers never see.
 */
describe("a non-recording write and the full-state encode agree", () => {
  it("is published incrementally, so a later full-state resync tells peers nothing new", () => {
    // The incremental path and the full-state encode must agree: the update
    // carries the change, and a later full-state resync is a no-op for a peer
    // that already has it. Any write withheld incrementally would still be
    // republished by that resync, so agreement is the only coherent contract.
    const a = new Scene();
    a.replaceAllElements([mk("shared"), mk("other")]);
    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(liveIds(b)).toEqual(["other", "shared"]); // guard

    const delivered: Uint8Array[] = [];
    const detach = a.onDocUpdate((u) => {
      delivered.push(u);
      b.applyRemoteUpdate(u);
    });

    // An authoritative non-recording change (the shape a load/import takes).
    a.replaceAllElements([mk("shared")], { recordHistory: false });
    detach();

    expect(delivered.length).toBeGreaterThan(0); // it reached the wire...
    expect(liveIds(b)).toEqual(liveIds(a)); // ...and the peer converged

    // The resync now adds nothing: incremental and full-state say the same thing.
    const beforeResync = liveIds(b);
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(liveIds(b)).toEqual(beforeResync);

    a.destroy();
    b.destroy();
  });
});
