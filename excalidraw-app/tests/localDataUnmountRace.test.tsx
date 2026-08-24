import { vi } from "vitest";

import { API } from "@excalidraw-yjs/excalidraw/tests/helpers/api";
import {
  act,
  render,
  unmountComponent,
} from "@excalidraw-yjs/excalidraw/tests/test-utils";

import { LocalData } from "../data/LocalData";
import ExcalidrawApp from "../App";

const { h } = window;

/**
 * TEARDOWN RACE — a debounced `LocalData` save outliving the editor.
 *
 * `App` schedules `LocalData.save(...)` on scene change; `LocalData._save` is
 * debounced by `SAVE_TO_LOCAL_STORAGE_TIMEOUT`. Its `onFilesSaved` callback
 * guards with `if (excalidrawAPI)` — a TRUTHINESS check. After unmount the API
 * object still exists, so the guard passes, but every method deliberately throws
 * "ExcalidrawAPI is no longer usable after the editor has been unmounted".
 *
 * Ownership is split and nobody closes it: the timer belongs to `LocalData` (a
 * module-level static), the callback closes over `App`'s `excalidrawAPI`, and
 * `LocalData` exposes only `flushSave()` — which RUNS the pending save — with no
 * cancel. Its three call sites are unload, blur/visibility and beforeunload;
 * none is a React unmount.
 *
 * The callback is captured and invoked DIRECTLY rather than driven through the
 * debounce timer. Letting the real timer fire post-unmount produces an unhandled
 * rejection that makes the whole runner exit non-zero — which is the very
 * symptom under diagnosis, and a test must not reintroduce it.
 *
 * The minimal ownership boundary is `App`'s callback,
 * not `LocalData`. Persisting data after unmount is legitimate — that is exactly
 * what the unload path wants — but touching the EDITOR must not outlive the
 * editor. `LocalData` should not have to know about React lifecycles; `App` must
 * not hand it a callback capturing an API whose usability it no longer
 * guarantees.
 *
 * FIXED: the callback now checks `isDestroyed` rather than truthiness —
 * `componentWillUnmount` keeps that field as DATA for exactly this purpose while
 * replacing every callable member.
 */
describe("LocalData debounced save vs unmount", () => {
  it("does not touch the editor API after the editor is unmounted", async () => {
    let onFilesSaved: (() => void) | null = null;
    const saveSpy = vi
      .spyOn(LocalData, "save")
      .mockImplementation((_e, _a, _f, cb) => {
        onFilesSaved = cb;
      });

    try {
      await render(<ExcalidrawApp />);

      // A scene change schedules the save, handing LocalData the callback.
      act(() => {
        h.app.updateScene({
          elements: [API.createElement({ type: "rectangle", id: "a" })],
          captureUpdate: "IMMEDIATELY" as never,
        });
      });

      // GUARD: the callback really was handed over, or the assertion below
      // would pass for the wrong reason.
      expect(typeof onFilesSaved).toBe("function");

      // The editor goes away before the pending save completes.
      unmountComponent();

      // The save now finishes and invokes its callback, exactly as the real
      // debounce would.
      expect(() => onFilesSaved!()).not.toThrow();
    } finally {
      saveSpy.mockRestore();
    }
  });
});
