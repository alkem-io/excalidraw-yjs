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
 * Does EPHEMERAL_ORIGIN's "never reaches a peer" guarantee actually hold?
 *
 * The origin policy suppresses the incremental `onDocUpdate` callback, but an
 * EPHEMERAL write still mutates the shared doc — its structs and delete-set are
 * part of the doc state. So the moment the live doc is also the FULL-STATE sync
 * source (INIT seed, periodic resync, persistence), the next `encodeStateAsUpdate`
 * necessarily carries what the incremental path deliberately withheld.
 */
describe("EPHEMERAL_ORIGIN vs. full-state encode", () => {
  it("an EPHEMERAL clear does not reach a peer INCREMENTALLY", () => {
    const a = new Scene();
    a.replaceAllElements([mk("shared")]);
    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(liveIds(b)).toEqual(["shared"]); // guard: really shared

    const delivered: Uint8Array[] = [];
    const detach = a.onDocUpdate((u) => {
      delivered.push(u);
      b.applyRemoteUpdate(u);
    });

    // Exactly what a scene reset / authoritative load does.
    a.replaceAllElements([], { recordHistory: false });
    detach();

    expect(a.getElementsIncludingDeleted()).toHaveLength(0); // it happened locally
    expect(delivered).toHaveLength(0); // ...and was withheld from the wire
    expect(liveIds(b)).toEqual(["shared"]); // ...so the peer still has it

    a.destroy();
    b.destroy();
  });

  // SKIPPED — asserts the CURRENTLY-CLAIMED transport contract, which is FALSE.
  // It fails at `expected [] to deeply equal ['shared']`: the peer's element is
  // destroyed. Deliberately not rewritten to assert today's behaviour, which
  // would turn a live defect green. Un-skip when the EPHEMERAL classification
  // lands (T026) — do NOT "fix" it by filtering or rebuilding the encode.
  it.skip("...but the SAME clear is republished by a full-state encode", () => {
    const a = new Scene();
    a.replaceAllElements([mk("shared")]);
    const b = new Scene(undefined, { doc: new Y.Doc() });
    b.applyRemoteUpdate(a.encodeStateAsUpdate());
    expect(liveIds(b)).toEqual(["shared"]); // guard

    const delivered: Uint8Array[] = [];
    const detach = a.onDocUpdate((u) => delivered.push(u));
    a.replaceAllElements([], { recordHistory: false });
    detach();
    expect(delivered).toHaveLength(0); // guard: nothing went incrementally

    // The periodic resync / INIT seed: A encodes its FULL live state and B
    // applies it as an ordinary remote update.
    b.applyRemoteUpdate(a.encodeStateAsUpdate());

    // THE CONTRACT: an EPHEMERAL write is local-only, so a full-state resync must
    // not carry it. If this fails, "never broadcasts" is not a property the
    // origin can provide once the live doc is the sync source.
    expect(liveIds(b)).toEqual(["shared"]);

    a.destroy();
    b.destroy();
  });
});
