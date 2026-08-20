import * as Y from "yjs";

import { CaptureUpdateAction } from "@excalidraw-yjs/element";

import { Excalidraw } from "../index";

import { register } from "../actions/register";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

/**
 * The async rule is FAIL-CLOSED, not prose (spec 002 / T016b).
 *
 * By the time an async result resolves, the action's logical-mutation boundary
 * AND its mutation journal are already closed. The derived-intent path would
 * therefore apply a stale diff against an EMPTY journal — silently choosing a
 * winner for every helper-owned key. No async `perform` returns `elements`
 * today, so this rejects instead of guessing.
 */
describe("async action element results are rejected", () => {
  it("throws at the boundary and leaves the document untouched", async () => {
    await render(<Excalidraw />);
    API.setElements([API.createElement({ type: "rectangle", id: "a", x: 0 })]);

    const before = Y.encodeStateVector(h.scene.doc);
    const idsBefore = h.elements.map((e) => e.id);

    const asyncElementAction = register({
      name: "testAsyncElements" as never,
      label: "" as never,
      trackEvent: false,
      perform: async (elements) => ({
        elements: elements.map((e) => ({ ...e, x: 999 })),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      h.app.actionManager.executeAction(asyncElementAction as never);
      await new Promise((r) => setTimeout(r, 0));
    });
    const reported = errors.mock.calls.map((c) => String(c[0])).join(" ");
    errors.mockRestore();

    // SURFACED, not silent — and not an unhandled rejection either.
    expect(reported).toContain("async action returned `elements`");

    // GUARD + contract: the document did not move at all.
    expect(h.elements.map((e) => e.id)).toEqual(idsBefore);
    expect(h.elements[0].x).toBe(0);
    expect(Y.encodeStateVector(h.scene.doc)).toEqual(before);
  });

  it("still applies an ordinary async appState-only result", async () => {
    await render(<Excalidraw />);
    const before = Y.encodeStateVector(h.scene.doc);

    const asyncAppStateAction = register({
      name: "testAsyncAppState" as never,
      label: "" as never,
      trackEvent: false,
      perform: async () => ({
        appState: { zenModeEnabled: true },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    });

    await act(async () => {
      h.app.actionManager.executeAction(asyncAppStateAction as never);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.state.zenModeEnabled).toBe(true);
    // ...and it never touched the element document.
    expect(Y.encodeStateVector(h.scene.doc)).toEqual(before);
  });
});
