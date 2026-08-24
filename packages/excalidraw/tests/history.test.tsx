import React from "react";
import {
  queryByText,
  fireEvent,
  queryByTestId,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";

import {
  EXPORT_DATA_TYPES,
  MIME_TYPES,
  ORIG_ID,
  KEYS,
  arrayToMap,
  COLOR_PALETTE,
  DEFAULT_ELEMENT_BACKGROUND_COLOR_INDEX,
  DEFAULT_ELEMENT_STROKE_COLOR_INDEX,
  reseed,
  randomId,
} from "@excalidraw-yjs/common";

import "@excalidraw-yjs/utils/test-utils";

import { AppStateDelta } from "@excalidraw-yjs/element";

import { CaptureUpdateAction } from "@excalidraw-yjs/element";

import type {
  ExcalidrawGenericElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  FileId,
  SceneElementsMap,
} from "@excalidraw-yjs/element/types";

import "../global.d.ts";

import { actionSendBackward, actionBringForward } from "../actions";
import { createUndoAction, createRedoAction } from "../actions/actionHistory";
import { actionToggleViewMode } from "../actions/actionToggleViewMode";
import * as StaticScene from "../renderer/staticScene";
import { getDefaultAppState } from "../appState";
import { Excalidraw } from "../index";
import { createPasteEvent } from "../clipboard";
import { HistoryEntry } from "../history";

import * as blobModule from "../data/blob";

import {
  DEER_IMAGE_DIMENSIONS,
  SMILEY_IMAGE_DIMENSIONS,
} from "./fixtures/constants";
import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { INITIALIZED_IMAGE_PROPS } from "./helpers/constants";
import {
  GlobalTestState,
  act,
  assertSelectedElements,
  render,
  togglePopover,
  getCloneByOrigId,
  checkpointHistory,
  unmountComponent,
} from "./test-utils";
import { setupImageTest as _setupImageTest } from "./image.test";

import type { AppState } from "../types";

const { h } = window;

const mouse = new Pointer("mouse");

const checkpoint = (name: string) => {
  expect(renderStaticScene.mock.calls.length).toMatchSnapshot(
    `[${name}] number of renders`,
  );
  // `scrolledOutside` does not appear to be stable between test runs
  // `selectedLinearElemnt` includes `startBindingElement` containing seed and versionNonce
  const {
    name: _,
    scrolledOutside,
    selectedLinearElement,
    ...strippedAppState
  } = h.state;
  expect(strippedAppState).toMatchSnapshot(`[${name}] appState`);
  expect(h.elements.length).toMatchSnapshot(`[${name}] number of elements`);

  h.elements
    .map(({ seed, versionNonce, ...strippedElement }) => strippedElement)
    .forEach((element, i) =>
      expect(element).toMatchSnapshot(`[${name}] element ${i}`),
    );

  checkpointHistory(h.history, name);
};

const renderStaticScene = vi.spyOn(StaticScene, "renderStaticScene");

const transparent = COLOR_PALETTE.transparent;
const black = COLOR_PALETTE.black;
const red = COLOR_PALETTE.red[DEFAULT_ELEMENT_BACKGROUND_COLOR_INDEX];
const blue = COLOR_PALETTE.blue[DEFAULT_ELEMENT_BACKGROUND_COLOR_INDEX];

describe("history", () => {
  beforeEach(() => {
    unmountComponent();
    renderStaticScene.mockClear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    reseed(7);

    const generateIdSpy = vi.spyOn(blobModule, "generateIdFromFile");
    const resizeFileSpy = vi.spyOn(blobModule, "resizeImageFile");

    generateIdSpy.mockImplementation(() =>
      Promise.resolve(randomId() as FileId),
    );
    resizeFileSpy.mockImplementation((file: File) => Promise.resolve(file));

    Object.assign(document, {
      elementFromPoint: () => GlobalTestState.canvas,
    });
  });

  afterEach(() => {
    checkpoint("end of test");
  });

  describe("singleplayer undo/redo", () => {
    // Native-Yjs core (M2): rewritten for the native history. Element undo/redo is
    // the doc's `Y.UndoManager`; a `History` stack entry now carries only the paired
    // inverse appState delta + a `hasElementChange` flag (no `StoreDelta` with an
    // `elements.applyTo` to corrupt). The resilience guarantee is unchanged and still
    // worth proving: if APPLYING an entry throws, `History.perform` must still pop it
    // from the source stack and push it onto the opposite stack (its `try/finally`),
    // so a single bad entry can never wedge undo/redo forever. We assert that by
    // mocking the entry's `appState.applyTo` to throw.
    it("should not collapse when applying corrupted history entry", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);
      const rect = API.createElement({ type: "rectangle" });

      API.setElements([rect]);

      // A corrupted entry: appState-only (no element step), whose applyTo throws.
      const corruptedDelta = AppStateDelta.empty();
      vi.spyOn(corruptedDelta, "applyTo").mockImplementation(() => {
        throw new Error("Oh no, I am corrupted!");
      });
      const corruptedEntry = new HistoryEntry(corruptedDelta, false);

      (h.history as any).undoStack.push(corruptedEntry);

      const appState = getDefaultAppState() as AppState;

      try {
        // due to this we unfortunately we couldn't do simple .toThrow()
        act(
          () =>
            h.history.undo(
              arrayToMap(h.elements) as SceneElementsMap,
              appState,
            ) as any,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
      // we popped the entry, even though it is corrupted, so the user could perform subsequent undo/redo and would not be stuck on this entry forever
      expect(API.getUndoStack().length).toBe(0);
      // we pushed the entry, as we don't want to just lose it and throw it away - it might be perfectly valid on subsequent redo
      expect(API.getRedoStack().length).toBe(1);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, isDeleted: false }), // no changes detected
      ]);

      try {
        // due to this we unfortunately we couldn't do simple .toThrow()
        act(
          () =>
            h.history.redo(
              arrayToMap(h.elements) as SceneElementsMap,
              appState,
            ) as any,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
      expect(API.getUndoStack().length).toBe(1); // vice versa for redo
      expect(API.getRedoStack().length).toBe(0); // vice versa for undo
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, isDeleted: false }),
      ]);
    });

    it("should not end up with history entry when there are no appstate changes", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);
      const rect1 = API.createElement({ type: "rectangle", groupIds: ["A"] });
      const rect2 = API.createElement({ type: "rectangle", groupIds: ["A"] });

      API.setElements([rect1, rect2]);
      mouse.select(rect1);
      assertSelectedElements([rect1, rect2]);
      expect(h.state.selectedGroupIds).toEqual({ A: true });
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);

      mouse.select(rect2);
      assertSelectedElements([rect1, rect2]);
      expect(h.state.selectedGroupIds).toEqual({ A: true });
      expect(API.getUndoStack().length).toBe(1); // no new entry was created
      expect(API.getRedoStack().length).toBe(0);
    });

    it("should not end up with history entry when there are no elements changes", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const rect1 = API.createElement({ type: "rectangle" });
      const rect2 = API.createElement({ type: "rectangle" });

      API.updateScene({
        elements: [rect1, rect2],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
      ]);

      API.updateScene({
        elements: [rect1, rect2],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY, // even though the flag is on, same elements are passed, nothing to commit
      });
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
      ]);
    });

    it("should not modify anything on unrelated appstate change", async () => {
      const rect = API.createElement({ type: "rectangle" });
      await render(
        <Excalidraw
          handleKeyboardGlobally={true}
          initialData={{
            elements: [rect],
          }}
        />,
      );

      API.updateScene({
        appState: {
          viewModeEnabled: true,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      await waitFor(() => {
        expect(h.state.viewModeEnabled).toBe(true);
        expect(API.getUndoStack().length).toBe(0);
        expect(API.getRedoStack().length).toBe(0);
        expect(h.elements).toEqual([
          expect.objectContaining({ id: rect.id, isDeleted: false }),
        ]);
        expect(h.store.snapshot.elements.get(rect.id)).toEqual(
          expect.objectContaining({ id: rect.id, isDeleted: false }),
        );
      });
    });

    it("should not clear the redo stack on standalone appstate change", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const rect1 = UI.createElement("rectangle", { x: 10 });
      const rect2 = UI.createElement("rectangle", { x: 20 });

      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements(rect2);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      assertSelectedElements(rect1);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
      ]);

      mouse.clickAt(-10, -10);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1); // we still have a possibility to redo!
      expect(API.getSelectedElements().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
      ]);

      mouse.downAt(-10, -10);
      mouse.moveTo(25, 25);
      mouse.moveTo(50, 50);
      mouse.upAt(50, 50);
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(1); // even after re-select!
      assertSelectedElements(rect1);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(4);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements(rect2);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
      ]);
    });

    it("should not override appstate changes when redo stack is not cleared", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const rect = UI.createElement("rectangle", { x: 10 });
      togglePopover("Background");
      UI.clickOnTestId("color-red");
      UI.clickOnTestId("color-blue");

      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements(rect);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: blue }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1);
      assertSelectedElements(rect);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: red }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(2);
      assertSelectedElements(rect);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: transparent }),
      ]);

      mouse.clickAt(-10, -10);
      expect(API.getUndoStack().length).toBe(2); // pushed appstate change,
      expect(API.getRedoStack().length).toBe(2); // redo stack is not cleared
      expect(API.getSelectedElements().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: transparent }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSelectedElements().length).toBe(0); // previously the item was selected, not it is not
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: red }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(4);
      expect(API.getRedoStack().length).toBe(0);
      expect(API.getSelectedElements().length).toBe(0); // previously the item was selected, not it is not
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: blue }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSelectedElements().length).toBe(0); // previously the item was selected, not it is not
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: red }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(2);
      expect(API.getSelectedElements().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: transparent }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(3);
      assertSelectedElements(rect); // get's reselected with out pushed entry!
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, backgroundColor: transparent }),
      ]);
    });

    it("should clear the redo stack on elements change", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const rect1 = UI.createElement("rectangle", { x: 10 });

      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements(rect1);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(0);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSelectedElements()).toEqual([]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: true }),
      ]);

      const rect2 = UI.createElement("rectangle", { x: 20 });

      assertSelectedElements(rect2);
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0); // redo stack got cleared
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: true }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: true }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
      ]);
    });

    it("should iterate through the history when selection changes do not produce visible change", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const rect = UI.createElement("rectangle", { x: 10 });

      mouse.clickAt(-10, -10);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(API.getSelectedElements().length).toBe(0);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      assertSelectedElements(rect);

      mouse.clickAt(-10, -10);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSelectedElements().length).toBe(0);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(2); // now we have two same redos
      assertSelectedElements(rect);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1); // didn't iterate through completely, as first redo already results in a visible change
      expect(API.getSelectedElements().length).toBe(0);

      Keyboard.redo(); // acceptable empty redo
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(0);
      expect(API.getSelectedElements().length).toBe(0);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1);
      assertSelectedElements(rect);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(0); // now we iterated through the same undos!
      expect(API.getRedoStack().length).toBe(3);
      expect(API.getSelectedElements().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect.id, isDeleted: true }),
      ]);
    });

    it("should end up with no history entry after initializing scene", async () => {
      await render(
        <Excalidraw
          initialData={{
            elements: [API.createElement({ type: "rectangle", id: "A" })],
            appState: {
              zenModeEnabled: true,
            },
          }}
        />,
      );

      await waitFor(() => {
        expect(h.state.zenModeEnabled).toBe(true);
        expect(h.elements).toEqual([expect.objectContaining({ id: "A" })]);
        expect(h.history.isUndoStackEmpty).toBeTruthy();
      });

      const undoAction = createUndoAction(h.history);
      const redoAction = createRedoAction(h.history);
      // noop
      API.executeAction(undoAction);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
      ]);
      const rectangle = UI.createElement("rectangle");
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: rectangle.id }),
      ]);
      API.executeAction(undoAction);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: rectangle.id, isDeleted: true }),
      ]);

      // noop
      API.executeAction(undoAction);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: rectangle.id, isDeleted: true }),
      ]);
      expect(API.getUndoStack().length).toBe(0);

      API.executeAction(redoAction);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: rectangle.id, isDeleted: false }),
      ]);
      expect(API.getUndoStack().length).toBe(1);
    });

    // Native-Yjs core (M2): scene import (replace-all) drops the prior element from
    // the doc; undo RE-ADDS it and redo re-drops it — all off the doc's
    // `Y.UndoManager`. The assertions track the user-visible scene (`h.elements`)
    // plus the Store snapshot tombstones (`getSnapshot()`, the editor's own diffing
    // bookkeeping, unchanged here). The native model unifies the OLD scene-array-vs-
    // delta duality: a redo reproduces the import exactly (dropped element gone, not
    // a leftover tombstone in the scene) — see the redo block.
    it("should create new history entry on scene import via drag&drop", async () => {
      await render(
        <Excalidraw
          initialData={{
            elements: [API.createElement({ type: "rectangle", id: "A" })],
            appState: {
              viewBackgroundColor: "#FFF",
            },
          }}
        />,
      );

      await waitFor(() => expect(h.state.viewBackgroundColor).toBe("#FFF"));
      await waitFor(() =>
        expect(h.elements).toEqual([expect.objectContaining({ id: "A" })]),
      );

      await API.drop([
        {
          kind: "file",
          file: new Blob(
            [
              JSON.stringify({
                type: EXPORT_DATA_TYPES.excalidraw,
                appState: {
                  ...getDefaultAppState(),
                  viewBackgroundColor: "#000",
                },
                elements: [API.createElement({ type: "rectangle", id: "B" })],
              }),
            ],
            { type: MIME_TYPES.json },
          ),
        },
      ]);

      await waitFor(() => expect(API.getUndoStack().length).toBe(1));
      expect(h.state.viewBackgroundColor).toBe("#000");
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A", isDeleted: true }),
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);

      const undoAction = createUndoAction(h.history);
      const redoAction = createRedoAction(h.history);
      API.executeAction(undoAction);

      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
      expect(h.state.viewBackgroundColor).toBe("#FFF");

      API.executeAction(redoAction);
      expect(h.state.viewBackgroundColor).toBe("#000");
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A", isDeleted: true }),
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);
      // Native-Yjs core (M2): the doc is the single source of truth, so re-applying
      // the import drops A the *same way the original import did* — A is structurally
      // gone from the scene (`h.elements`), not left behind as a tombstone. The OLD
      // model had a scene-array-vs-Store-snapshot duality where the first import
      // hard-removed A but a redo of it tombstoned A in the scene array; the native
      // model unifies them (redo reproduces the import exactly → `[B]`). The Store
      // snapshot still tracks A as a tombstone (asserted above) for its own diffing.
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);
    });

    it("should create new history entry on embeddable link drag&drop", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const link = "https://www.youtube.com/watch?v=gkGMXY0wekg";
      await API.drop([
        {
          kind: "string",
          value: link,
          type: MIME_TYPES.text,
        },
      ]);

      await waitFor(() => {
        expect(API.getUndoStack().length).toBe(1);
        expect(API.getRedoStack().length).toBe(0);
        expect(h.elements).toEqual([
          expect.objectContaining({
            type: "embeddable",
            link,
          }),
        ]);
      });

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(0);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.elements).toEqual([
        expect.objectContaining({
          type: "embeddable",
          link,
          isDeleted: true,
        }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({
          type: "embeddable",
          link,
          isDeleted: false,
        }),
      ]);
    });

    const setupImageTest = () =>
      _setupImageTest([DEER_IMAGE_DIMENSIONS, SMILEY_IMAGE_DIMENSIONS]);

    const assertImageTest = async () => {
      await waitFor(() => {
        expect(API.getUndoStack().length).toBe(1);
        expect(API.getRedoStack().length).toBe(0);

        // Native-Yjs core (M2): the element history is the doc's `Y.UndoManager`,
        // so the undo entry no longer carries an inspectable element delta. The
        // equivalent check is that the doc (the single source of truth, which the
        // undo step reverts) holds the *initialized* image elements — with fileId
        // & natural dimensions — and that exactly one element undo step exists.
        expect(h.app.scene.undoManager.undoStack.length).toBe(1);
        expect(
          h.app.scene
            .getElementsIncludingDeleted()
            .filter((el) => el.type === "image"),
        ).toEqual([
          expect.objectContaining({
            ...INITIALIZED_IMAGE_PROPS,
            ...DEER_IMAGE_DIMENSIONS,
          }),
          expect.objectContaining({
            ...INITIALIZED_IMAGE_PROPS,
            ...SMILEY_IMAGE_DIMENSIONS,
          }),
        ]);
      });

      // Native-Yjs core (M2): the placeholder insert and the async fileId/natural-
      // dimension writes are one continuous local gesture (no capture boundary
      // between them), so the doc's `Y.UndoManager` collapses them into a SINGLE
      // step. A single undo therefore removes the image entirely — reverting the
      // reveal *and* the init writes, so each element returns to a tombstone
      // (`isDeleted:true`). The user-visible guarantee is identical to the old
      // snapshot model (image gone on undo, restored on redo); only the tombstone's
      // frozen content differs (placeholder vs initialized), which is an internal
      // detail of where the captured boundary sits — so we assert the guarantee
      // (both images gone) rather than the obsolete tombstoned-initialized shape.
      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(0);
      expect(API.getRedoStack().length).toBe(1);
      const undoneImages = h.app.scene
        .getElementsIncludingDeleted()
        .filter((el) => el.type === "image");
      expect(undoneImages.length).toBe(2);
      expect(undoneImages.every((el) => el.isDeleted)).toBe(true);
      expect(h.app.scene.getNonDeletedElements()).toEqual([]);

      // Redo re-applies the whole gesture, restoring the fully INITIALIZED images
      // (fileId + natural dimensions) — proving the coalesced step round-trips.
      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({
          ...INITIALIZED_IMAGE_PROPS,
          isDeleted: false,
          ...DEER_IMAGE_DIMENSIONS,
        }),
        expect.objectContaining({
          ...INITIALIZED_IMAGE_PROPS,
          isDeleted: false,
          ...SMILEY_IMAGE_DIMENSIONS,
        }),
      ]);
    };

    // Native-Yjs core (M2): async image insertion is a placeholder (drawn while
    // loading) that is later updated with the resolved `fileId` + natural
    // dimensions. The OLD store computed the captured history delta against the
    // last *snapshot* (taken before the placeholder), so a single undo step spanned
    // "nothing → initialized image" and undo restored a tombstoned-but-initialized
    // image. The native `Y.UndoManager` captures the actual doc transactions of the
    // gesture (placeholder reveal + the fileId/dimension writes merge into one
    // step), so undo reverts to the *placeholder* (pre-init) state rather than a
    // tombstoned-initialized image. The image still inserts and undoes correctly;
    // only the intermediate captured state differs. Deferred: to be rewritten to
    // the native capture semantics (and/or make the placeholder insert non-capturing
    // so the captured step spans empty → initialized).
    it("should create new history entry on image drag&drop", async () => {
      await setupImageTest();

      await API.drop(
        (
          await Promise.all([
            API.loadFile("./fixtures/deer.png"),
            API.loadFile("./fixtures/smiley.png"),
          ])
        ).map((file) => ({
          kind: "file",
          file,
        })),
      );

      await assertImageTest();
    });

    // See the note on "image drag&drop" above — same native async-placeholder
    // capture divergence. Deferred.
    it("should create new history entry on image paste", async () => {
      await setupImageTest();

      document.dispatchEvent(
        createPasteEvent({
          files: await Promise.all([
            API.loadFile("./fixtures/deer.png"),
            API.loadFile("./fixtures/smiley.png"),
          ]),
        }),
      );

      await assertImageTest();
    });

    it("should create new history entry on embeddable link paste", async () => {
      await render(
        <Excalidraw autoFocus={true} handleKeyboardGlobally={true} />,
      );

      const link = "https://www.youtube.com/watch?v=gkGMXY0wekg";

      document.dispatchEvent(
        createPasteEvent({
          types: {
            "text/plain": link,
          },
        }),
      );

      await waitFor(() => {
        expect(API.getUndoStack().length).toBe(1);
        expect(API.getRedoStack().length).toBe(0);
        expect(h.elements).toEqual([
          expect.objectContaining({
            type: "embeddable",
            link,
          }),
        ]);
      });

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(0);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.elements).toEqual([
        expect.objectContaining({
          type: "embeddable",
          link,
          isDeleted: true,
        }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({
          type: "embeddable",
          link,
          isDeleted: false,
        }),
      ]);
    });

    it("should support appstate name or viewBackgroundColor change", async () => {
      await render(
        <Excalidraw
          handleKeyboardGlobally={true}
          initialData={{
            appState: {
              name: "Old name",
              viewBackgroundColor: "#FFF",
            },
          }}
        />,
      );

      expect(h.state.isLoading).toBe(false);
      expect(h.state.name).toBe("Old name");

      API.updateScene({
        appState: {
          name: "New name",
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.name).toBe("New name");

      API.updateScene({
        appState: {
          viewBackgroundColor: "#000",
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.name).toBe("New name");
      expect(h.state.viewBackgroundColor).toBe("#000");

      // just to double check that same change is not recorded
      API.updateScene({
        appState: {
          name: "New name",
          viewBackgroundColor: "#000",
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.name).toBe("New name");
      expect(h.state.viewBackgroundColor).toBe("#000");

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.state.name).toBe("New name");
      expect(h.state.viewBackgroundColor).toBe("#FFF");

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(0);
      expect(API.getRedoStack().length).toBe(2);
      expect(h.state.name).toBe("Old name");
      expect(h.state.viewBackgroundColor).toBe("#FFF");

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.state.name).toBe("New name");
      expect(h.state.viewBackgroundColor).toBe("#FFF");

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.name).toBe("New name");
      expect(h.state.viewBackgroundColor).toBe("#000");
    });

    it("should support element creation, deletion and appstate element selection change", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const rect1 = UI.createElement("rectangle", { x: 10 });
      const rect2 = UI.createElement("rectangle", { x: 20, y: 20 });
      const rect3 = UI.createElement("rectangle", { x: 40, y: 40 });

      mouse.select([rect2, rect3]);
      Keyboard.keyDown(KEYS.DELETE);

      expect(API.getUndoStack().length).toBe(6);

      Keyboard.undo();
      assertSelectedElements(rect2, rect3);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
        expect.objectContaining({ id: rect3.id, isDeleted: false }),
      ]);

      Keyboard.undo();
      assertSelectedElements(rect2);

      Keyboard.undo();
      assertSelectedElements(rect3);

      Keyboard.undo();
      assertSelectedElements(rect2);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect2.id }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);

      Keyboard.undo();
      assertSelectedElements(rect1);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);

      Keyboard.undo();
      assertSelectedElements();
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: true }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);

      // no-op
      Keyboard.undo();
      assertSelectedElements();
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: true }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);

      Keyboard.redo();
      assertSelectedElements(rect1);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);

      Keyboard.redo();
      assertSelectedElements(rect2);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect2.id }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);

      Keyboard.redo();
      assertSelectedElements(rect3);

      Keyboard.redo();
      assertSelectedElements(rect2);

      Keyboard.redo();
      assertSelectedElements(rect2, rect3);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
        expect.objectContaining({ id: rect3.id, isDeleted: false }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(6);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements();
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);

      // no-op
      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(6);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements();
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: true }),
        expect.objectContaining({ id: rect3.id, isDeleted: true }),
      ]);
    });

    // Native-Yjs core (M2): multi-step linear-element point editing builds many
    // captured doc transactions; the precise undo-step *boundaries* and the
    // mid-edit (informMutation:false) capture coalescing differ from the OLD
    // snapshot-delta history's per-`scheduleCapture` granularity (e.g. exactly
    // when the tombstone-on-undo-of-creation lands relative to point edits). The
    // element still creates/edits/undoes; the captured granularity diverges.
    // Deferred: to be re-validated against the native capture boundaries.
    it("should support linear element creation and points manipulation through the editor", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      // create three point arrow
      UI.clickTool("arrow");
      mouse.click(0, 0);
      mouse.click(10, 10);
      mouse.click(10, -10);

      // actionFinalize
      Keyboard.keyPress(KEYS.ENTER);

      // open editor
      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress(KEYS.ENTER);
      });

      // move point
      mouse.downAt(20, 0);
      mouse.moveTo(20, 20);
      mouse.up();

      // leave editor
      Keyboard.keyPress(KEYS.ESCAPE);

      expect(API.getUndoStack().length).toBe(5);
      expect(API.getRedoStack().length).toBe(0);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing ?? false).toBe(false);
      expect(h.state.selectedLinearElement).not.toBeNull();
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 20],
          ],
        }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(4);
      expect(API.getRedoStack().length).toBe(1);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing).toBe(true);
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 20],
          ],
        }),
      ]);

      // making sure clicking on points in the editor does not generate new history entries!
      mouse.clickAt(0, 0);
      mouse.clickAt(10, 10);
      mouse.clickAt(20, 20);
      expect(API.getUndoStack().length).toBe(4);
      expect(API.getRedoStack().length).toBe(1);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(2);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing).toBe(true);
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 0],
          ],
        }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(3);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing).toBe(false); // undo `open editor`
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 0],
          ],
        }),
      ]);

      // Keyboard.undo();
      // expect(API.getUndoStack().length).toBe(2);
      // expect(API.getRedoStack().length).toBe(4);
      // expect(assertSelectedElements(h.elements[0]));
      // expect(h.state.selectedLinearElement?.isEditing).toBe(false);
      // expect(h.state.selectedLinearElement).toBeNull(); // undo `actionFinalize`
      // expect(h.elements).toEqual([
      //   expect.objectContaining({
      //     isDeleted: false,
      //     points: [
      //       [0, 0],
      //       [10, 10],
      //       [20, 0],
      //     ],
      //   }),
      // ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(4);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing).toBe(false);
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
          ],
        }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(0);
      expect(API.getRedoStack().length).toBe(5);
      expect(API.getSelectedElements().length).toBe(0);
      expect(h.state.selectedLinearElement).toBeNull();
      // Native-Yjs core (M2): the deepest undo step is the arrow's creation. The
      // doc's `Y.UndoManager` reverses the *actual transactions* of that step — the
      // reveal AND the first committed segment — so the tombstone freezes at the
      // pre-segment `[[0,0],[0,0]]` rather than the OLD snapshot model's
      // `[[0,0],[10,10]]` (which captured creation as one atomic 2-point step). The
      // arrow is gone either way (the user-visible guarantee), and redo below
      // restores the full `[[0,0],[10,10]]` — so we assert deletion, not the
      // invisible frozen geometry of the tombstone.
      expect(h.elements.length).toBe(1);
      expect(h.elements[0].isDeleted).toBe(true);
      expect(h.app.scene.getNonDeletedElements()).toEqual([]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(4);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing).toBe(false);
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
          ],
        }),
      ]);

      // Keyboard.redo();
      // expect(API.getUndoStack().length).toBe(2);
      // expect(API.getRedoStack().length).toBe(3);
      // expect(assertSelectedElements(h.elements[0]));
      // expect(h.state.selectedLinearElement?.isEditing).toBe(false);
      // expect(h.state.selectedLinearElement).toBeNull(); // undo `actionFinalize`
      // expect(h.elements).toEqual([
      //   expect.objectContaining({
      //     isDeleted: false,
      //     points: [
      //       [0, 0],
      //       [10, 10],
      //       [20, 0],
      //     ],
      //   }),
      // ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(3);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing ?? false).toBe(false); // undo `open editor`
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 0],
          ],
        }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(2);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing).toBe(true);
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 0],
          ],
        }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(4);
      expect(API.getRedoStack().length).toBe(1);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing).toBe(true);
      expect(h.state.selectedLinearElement?.elementId).toBe(h.elements[0].id);
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 20],
          ],
        }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(5);
      expect(API.getRedoStack().length).toBe(0);
      expect(assertSelectedElements(h.elements[0]));
      expect(h.state.selectedLinearElement?.isEditing ?? false).toBe(false);
      expect(h.state.selectedLinearElement).not.toBeNull();
      expect(h.elements).toEqual([
        expect.objectContaining({
          isDeleted: false,
          points: [
            [0, 0],
            [10, 10],
            [20, 20],
          ],
        }),
      ]);
    });

    it("should create entry when selecting freedraw", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      UI.clickTool("rectangle");
      mouse.down(-10, -10);
      mouse.up(10, 10);

      UI.clickTool("freedraw");
      mouse.down(40, -20);
      mouse.up(50, 10);

      const rectangle = h.elements[0];
      const freedraw1 = h.elements[1];

      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(0);
      expect(API.getSelectedElements().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rectangle.id }),
        expect.objectContaining({ id: freedraw1.id, strokeColor: black }),
      ]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSelectedElements().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rectangle.id }),
        expect.objectContaining({
          id: freedraw1.id,
          strokeColor: black,
          isDeleted: true,
        }),
      ]);

      togglePopover("Stroke");
      UI.clickOnTestId("color-red");
      mouse.down(40, -20);
      mouse.up(50, 10);

      const freedraw2 = h.elements[2];

      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rectangle.id }),
        expect.objectContaining({
          id: freedraw1.id,
          strokeColor: black,
          isDeleted: true,
        }),
        expect.objectContaining({
          id: freedraw2.id,
          strokeColor: COLOR_PALETTE.red[DEFAULT_ELEMENT_STROKE_COLOR_INDEX],
        }),
      ]);

      // ensure we don't end up with duplicated entries
      UI.clickTool("freedraw");
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(0);
    });

    it("should support duplication of groups, appstate group selection and editing group", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);
      const rect1 = API.createElement({
        type: "rectangle",
        groupIds: ["A"],
        x: 0,
      });
      const rect2 = API.createElement({
        type: "rectangle",
        groupIds: ["A"],
        x: 100,
      });

      API.setElements([rect1, rect2]);
      mouse.select(rect1);
      assertSelectedElements([rect1, rect2]);
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.editingGroupId).toBeNull();
      expect(h.state.selectedGroupIds).toEqual({ A: true });

      // inside the editing group
      mouse.doubleClickOn(rect2);
      assertSelectedElements([rect2]);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.editingGroupId).toBe("A");
      expect(h.state.selectedGroupIds).not.toEqual({ A: true });

      mouse.clickOn(rect1);
      assertSelectedElements([rect1]);
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.editingGroupId).toBe("A");
      expect(h.state.selectedGroupIds).not.toEqual({ A: true });

      Keyboard.undo();
      assertSelectedElements([rect2]);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.state.editingGroupId).toBe("A");
      expect(h.state.selectedGroupIds).not.toEqual({ A: true });

      Keyboard.undo();
      assertSelectedElements([rect1, rect2]);
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(2);
      expect(h.state.editingGroupId).toBeNull();
      expect(h.state.selectedGroupIds).toEqual({ A: true });

      Keyboard.redo();
      assertSelectedElements([rect2]);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.state.editingGroupId).toBe("A");
      expect(h.state.selectedGroupIds).not.toEqual({ A: true });

      Keyboard.redo();
      assertSelectedElements([rect1]);
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.state.editingGroupId).toBe("A");
      expect(h.state.selectedGroupIds).not.toEqual({ A: true });

      Keyboard.undo();
      assertSelectedElements([rect2]);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.state.editingGroupId).toBe("A");
      expect(h.state.selectedGroupIds).not.toEqual({ A: true });

      Keyboard.undo();
      assertSelectedElements([rect1, rect2]);
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(2);
      expect(h.state.editingGroupId).toBeNull();
      expect(h.state.selectedGroupIds).toEqual({ A: true });

      // outside the editing group, testing duplication
      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress("d");
      });
      assertSelectedElements([h.elements[2], h.elements[3]]);
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements.length).toBe(4);
      expect(h.state.editingGroupId).toBeNull();
      expect(h.state.selectedGroupIds).not.toEqual(
        expect.objectContaining({ A: true }),
      );

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(h.elements.length).toBe(4);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
        expect.objectContaining({ [ORIG_ID]: rect1.id, isDeleted: true }),
        expect.objectContaining({ [ORIG_ID]: rect2.id, isDeleted: true }),
      ]);
      expect(h.state.editingGroupId).toBeNull();
      expect(h.state.selectedGroupIds).toEqual({ A: true });

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements.length).toBe(4);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id, isDeleted: false }),
        expect.objectContaining({ id: rect2.id, isDeleted: false }),
        expect.objectContaining({ [ORIG_ID]: rect1.id, isDeleted: false }),
        expect.objectContaining({ [ORIG_ID]: rect2.id, isDeleted: false }),
      ]);
      expect(h.state.editingGroupId).toBeNull();
      expect(h.state.selectedGroupIds).not.toEqual(
        expect.objectContaining({ A: true }),
      );

      // undo again, and duplicate once more
      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress("z");
        Keyboard.keyPress("d");
      });
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(h.elements.length).toBe(6);
      expect(h.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: rect1.id, isDeleted: false }),
          expect.objectContaining({ id: rect2.id, isDeleted: false }),
          expect.objectContaining({ [ORIG_ID]: rect1.id, isDeleted: true }),
          expect.objectContaining({ [ORIG_ID]: rect2.id, isDeleted: true }),
          expect.objectContaining({
            [ORIG_ID]: getCloneByOrigId(rect1.id)?.id,
            isDeleted: false,
          }),
          expect.objectContaining({
            [ORIG_ID]: getCloneByOrigId(rect2.id)?.id,
            isDeleted: false,
          }),
        ]),
      );
      expect(h.state.editingGroupId).toBeNull();
      expect(h.state.selectedGroupIds).not.toEqual(
        expect.objectContaining({ A: true }),
      );
    });

    it("should support changes in elements' order", async () => {
      await render(<Excalidraw handleKeyboardGlobally={true} />);

      const rect1 = UI.createElement("rectangle", { x: 10 });
      const rect2 = UI.createElement("rectangle", { x: 20, y: 20 });
      const rect3 = UI.createElement("rectangle", { x: 40, y: 40 });

      API.executeAction(actionSendBackward);

      expect(API.getUndoStack().length).toBe(4);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements(rect3);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(3);
      expect(API.getRedoStack().length).toBe(1);
      assertSelectedElements(rect3);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect2.id }),
        expect.objectContaining({ id: rect3.id }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(4);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements(rect3);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect3.id }),
        expect.objectContaining({ id: rect2.id }),
      ]);

      mouse.select([rect1, rect3]);
      expect(API.getUndoStack().length).toBe(6);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements([rect1, rect3]);

      API.executeAction(actionBringForward);

      expect(API.getUndoStack().length).toBe(7);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements([rect1, rect3]);

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(6);
      expect(API.getRedoStack().length).toBe(1);
      assertSelectedElements([rect1, rect3]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect3.id }),
        expect.objectContaining({ id: rect2.id }),
      ]);

      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(7);
      expect(API.getRedoStack().length).toBe(0);
      assertSelectedElements([rect1, rect3]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: rect2.id }),
        expect.objectContaining({ id: rect1.id }),
        expect.objectContaining({ id: rect3.id }),
      ]);
    });

    describe("should support bidirectional bindings", async () => {
      let rect1: ExcalidrawGenericElement;
      let rect2: ExcalidrawGenericElement;
      let text: ExcalidrawTextElement;
      let arrow: ExcalidrawLinearElement;

      const rect1Props = {
        type: "rectangle",
        height: 100,
        width: 100,
        x: -100,
        y: -50,
      } as const;

      const rect2Props = {
        type: "rectangle",
        height: 100,
        width: 100,
        x: 100,
        y: -50,
      } as const;

      const textProps = {
        type: "text",
        x: -200,
        text: "ola",
      } as const;

      beforeEach(async () => {
        await render(<Excalidraw handleKeyboardGlobally={true} />);

        rect1 = API.createElement({ ...rect1Props });
        text = API.createElement({ ...textProps });
        rect2 = API.createElement({ ...rect2Props });

        API.updateScene({
          elements: [rect1, text, rect2],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });

        // The Scene mints derived elements as fresh immutable snapshots on every
        // recompute, so the raw `rect1`/`text`/`rect2`/`arrow` captured above are
        // STALE after any mutation/undo/redo. Re-read the LIVE element by its
        // stable id for every post-mutation assertion. (id is stable across
        // re-derivation; the captured reference is not.)
        const liveRect1 = () => h.elements.find((e) => e.id === rect1.id)!;
        const liveRect2 = () => h.elements.find((e) => e.id === rect2.id)!;
        const liveText = () =>
          h.elements.find((e) => e.id === text.id)! as ExcalidrawTextElement;

        // bind text1 to rect1
        mouse.select([rect1, text]);
        fireEvent.contextMenu(GlobalTestState.interactiveCanvas);
        fireEvent.click(
          queryByText(
            document.querySelector(".context-menu") as HTMLElement,
            "Bind text to the container",
          )!,
        );

        expect(API.getUndoStack().length).toBe(4);
        expect(liveText().containerId).toBe(rect1.id);
        expect(liveRect1().boundElements).toStrictEqual([
          { id: text.id, type: "text" },
        ]);

        // bind arrow to rect1 and rect2
        UI.clickTool("arrow");
        mouse.down(3, 0);
        mouse.moveTo(50, 0);
        mouse.up(47, 0);

        arrow = h.elements[3] as ExcalidrawLinearElement;
        const liveArrow = () =>
          h.elements.find((e) => e.id === arrow.id) as ExcalidrawLinearElement;

        expect(API.getUndoStack().length).toBe(5);
        expect(liveArrow().startBinding).toEqual({
          elementId: rect1.id,
          fixedPoint: expect.arrayContaining([1, 0.5001]),
          mode: "orbit",
        });
        expect(liveArrow().endBinding).toEqual({
          elementId: rect2.id,
          fixedPoint: expect.arrayContaining([0.5001, 0.5001]),
          mode: "orbit",
        });
        expect(liveRect1().boundElements).toStrictEqual([
          { id: text.id, type: "text" },
          { id: arrow.id, type: "arrow" },
        ]);
        expect(liveRect2().boundElements).toStrictEqual([
          { id: arrow.id, type: "arrow" },
        ]);
      });

      // Native-Yjs core (M2): undoing the arrow's creation reverts ALL transactions
      // that creation captured — the arrow's own reveal + `startBinding`/`endBinding`
      // AND the `boundElements` additions on rect1/rect2 — because they were one
      // local gesture under `LOCAL_ORIGIN`. So the doc's `Y.UndoManager` "unbinds"
      // the bindable elements purely by reverting the doc (no special binding-
      // reconciliation pass needed), and redo replays them, restoring the full
      // binding graph losslessly (asserted below). Two native differences from the
      // OLD snapshot model, both correct: the *tombstoned* arrow's own
      // start/endBinding revert to null (they were set during creation; invisible
      // while deleted), and an emptied `boundElements` round-trips as null rather
      // than `[]` (the CRDT does not distinguish the two — schema note).
      it("should unbind arrow from non deleted bindable elements on undo and rebind on redo", async () => {
        // `arrow` captured in beforeEach is stale after undo/redo (Scene re-derives
        // fresh snapshots); re-read the live element by its stable id.
        const liveArrow = () =>
          h.elements.find((e) => e.id === arrow.id) as ExcalidrawLinearElement;

        Keyboard.undo();
        expect(API.getUndoStack().length).toBe(4);
        expect(API.getRedoStack().length).toBe(1);
        // The arrow is tombstoned; its bindings were reverted with the creation.
        expect(liveArrow().isDeleted).toBe(true);
        expect(liveArrow().startBinding).toBeNull();
        expect(liveArrow().endBinding).toBeNull();
        // rect1 keeps its text binding but no longer references the arrow; rect2 no
        // longer references the arrow either (empty → null natively).
        expect(h.elements).toEqual([
          expect.objectContaining({
            id: rect1.id,
            boundElements: [{ id: text.id, type: "text" }],
          }),
          expect.objectContaining({ id: text.id }),
          expect.objectContaining({ id: rect2.id, boundElements: null }),
          expect.objectContaining({ id: arrow.id, isDeleted: true }),
        ]);

        Keyboard.redo();
        expect(API.getUndoStack().length).toBe(5);
        expect(API.getRedoStack().length).toBe(0);
        expect(liveArrow().startBinding).toEqual({
          elementId: rect1.id,
          fixedPoint: expect.arrayContaining([1, 0.5001]),
          mode: "orbit",
        });
        expect(liveArrow().endBinding).toEqual({
          elementId: rect2.id,
          fixedPoint: expect.arrayContaining([0.5001, 0.5001]),
          mode: "orbit",
        });
        expect(h.elements).toEqual([
          expect.objectContaining({
            id: rect1.id,
            boundElements: [
              { id: text.id, type: "text" },
              { id: arrow.id, type: "arrow" },
            ],
          }),
          expect.objectContaining({ id: text.id }),
          expect.objectContaining({
            id: rect2.id,
            boundElements: [{ id: arrow.id, type: "arrow" }],
          }),
          expect.objectContaining({ id: arrow.id, isDeleted: false }),
        ]);
      });

      it("should unbind arrow from non deleted bindable elements on deletion and rebind on undo", async () => {
        // `arrow` captured in beforeEach is stale after delete/undo (Scene
        // re-derives fresh snapshots); re-read the live element by its stable id.
        const liveArrow = () =>
          h.elements.find((e) => e.id === arrow.id) as ExcalidrawLinearElement;

        Keyboard.keyDown(KEYS.DELETE);
        expect(API.getUndoStack().length).toBe(6);
        expect(API.getRedoStack().length).toBe(0);
        expect(liveArrow().startBinding).toEqual({
          elementId: rect1.id,
          fixedPoint: expect.arrayContaining([1, 0.5001]),
          mode: "orbit",
        });
        expect(liveArrow().endBinding).toEqual({
          elementId: rect2.id,
          fixedPoint: expect.arrayContaining([0.5001, 0.5001]),
          mode: "orbit",
        });
        expect(h.elements).toEqual([
          expect.objectContaining({
            id: rect1.id,
            boundElements: [{ id: text.id, type: "text" }],
          }),
          expect.objectContaining({ id: text.id }),
          expect.objectContaining({ id: rect2.id, boundElements: [] }),
          expect.objectContaining({ id: arrow.id, isDeleted: true }),
        ]);

        Keyboard.undo();
        expect(API.getUndoStack().length).toBe(5);
        expect(API.getRedoStack().length).toBe(1);
        expect(liveArrow().startBinding).toEqual({
          elementId: rect1.id,
          fixedPoint: expect.arrayContaining([1, 0.5001]),
          mode: "orbit",
        });
        expect(liveArrow().endBinding).toEqual({
          elementId: rect2.id,
          fixedPoint: expect.arrayContaining([0.5001, 0.5001]),
          mode: "orbit",
        });
        expect(h.elements).toEqual([
          expect.objectContaining({
            id: rect1.id,
            boundElements: [
              { id: text.id, type: "text" },
              { id: arrow.id, type: "arrow" },
            ],
          }),
          expect.objectContaining({ id: text.id }),
          expect.objectContaining({
            id: rect2.id,
            boundElements: [{ id: arrow.id, type: "arrow" }],
          }),
          expect.objectContaining({ id: arrow.id, isDeleted: false }),
        ]);
      });

      // Native-Yjs core (M2): iterating the entire undo stack reverts every captured
      // transaction, so all four elements return to tombstones with their bindings
      // fully unwound (boundElements emptied → null, the arrow's own start/endBinding
      // and the text's containerId reverted to null — invisible while deleted). The
      // reverse pass replays them all, restoring the complete binding graph
      // losslessly (asserted below). This works off the doc's `Y.UndoManager` alone —
      // no separate binding-reconciliation pass — exactly the single-user guarantee.
      it("should unbind everything from non deleted elements when iterating through the whole undo stack and vice versa rebind everything on redo", async () => {
        Keyboard.undo();
        Keyboard.undo();
        Keyboard.undo();
        Keyboard.undo();
        Keyboard.undo();

        expect(API.getUndoStack().length).toBe(0);
        expect(API.getRedoStack().length).toBe(5);
        expect(h.app.scene.getNonDeletedElements()).toEqual([]);
        expect(h.elements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: rect1.id,
              boundElements: null,
              isDeleted: true,
            }),
            expect.objectContaining({
              id: text.id,
              containerId: null,
              isDeleted: true,
            }),
            expect.objectContaining({
              id: rect2.id,
              boundElements: null,
              isDeleted: true,
            }),
            expect.objectContaining({
              id: arrow.id,
              startBinding: null,
              endBinding: null,
              isDeleted: true,
            }),
          ]),
        );

        Keyboard.redo();
        Keyboard.redo();
        Keyboard.redo();
        Keyboard.redo();
        Keyboard.redo();

        expect(API.getUndoStack().length).toBe(5);
        expect(API.getRedoStack().length).toBe(0);
        expect(h.elements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: rect1.id,
              boundElements: expect.arrayContaining([
                { id: text.id, type: "text" },
                { id: arrow.id, type: "arrow" },
              ]),
              isDeleted: false,
            }),
            expect.objectContaining({
              id: text.id,
              containerId: rect1.id,
              isDeleted: false,
            }),
            expect.objectContaining({
              id: rect2.id,
              boundElements: [{ id: arrow.id, type: "arrow" }],
              isDeleted: false,
            }),
            expect.objectContaining({
              id: arrow.id,
              startBinding: expect.objectContaining({
                elementId: rect1.id,
                fixedPoint: expect.arrayContaining([
                  expect.toBeNonNaNNumber(),
                  expect.toBeNonNaNNumber(),
                ]),
                mode: "orbit",
              }),
              endBinding: expect.objectContaining({
                elementId: rect2.id,
                fixedPoint: expect.arrayContaining([
                  expect.toBeNonNaNNumber(),
                  expect.toBeNonNaNNumber(),
                ]),
                mode: "orbit",
              }),
              isDeleted: false,
            }),
          ]),
        );
      });

      it("should unbind rectangle from arrow on deletion and rebind on undo", async () => {
        // `rect1` captured in beforeEach is stale (its geometry changed when the
        // text was bound into it); select the live element so the click geometry
        // is correct.
        const liveRect1 = () => h.elements.find((e) => e.id === rect1.id)!;

        mouse.select(liveRect1());
        Keyboard.keyPress(KEYS.DELETE);
        expect(API.getUndoStack().length).toBe(7);
        expect(API.getRedoStack().length).toBe(0);
        expect(h.elements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: rect1.id,
              boundElements: [
                { id: text.id, type: "text" },
                { id: arrow.id, type: "arrow" },
              ],
              isDeleted: true,
            }),
            expect.objectContaining({
              id: text.id,
              containerId: rect1.id,
              isDeleted: true,
            }),
            expect.objectContaining({
              id: rect2.id,
              boundElements: [{ id: arrow.id, type: "arrow" }],
              isDeleted: false,
            }),
            expect.objectContaining({
              id: arrow.id,
              startBinding: null,
              endBinding: expect.objectContaining({
                elementId: rect2.id,
                fixedPoint: expect.arrayContaining([
                  expect.toBeNonNaNNumber(),
                  expect.toBeNonNaNNumber(),
                ]),
                mode: "orbit",
              }),
              isDeleted: false,
            }),
          ]),
        );

        Keyboard.undo();
        expect(API.getUndoStack().length).toBe(6);
        expect(API.getRedoStack().length).toBe(1);
        expect(h.elements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: rect1.id,
              boundElements: expect.arrayContaining([
                { id: arrow.id, type: "arrow" },
                { id: text.id, type: "text" }, // order has now changed!
              ]),
              isDeleted: false,
            }),
            expect.objectContaining({
              id: text.id,
              containerId: rect1.id,
              isDeleted: false,
            }),
            expect.objectContaining({
              id: rect2.id,
              boundElements: [{ id: arrow.id, type: "arrow" }],
              isDeleted: false,
            }),
            expect.objectContaining({
              id: arrow.id,
              startBinding: expect.objectContaining({
                elementId: rect1.id,
                fixedPoint: expect.arrayContaining([
                  expect.toBeNonNaNNumber(),
                  expect.toBeNonNaNNumber(),
                ]),
                mode: "orbit",
              }),
              endBinding: expect.objectContaining({
                elementId: rect2.id,
                fixedPoint: expect.arrayContaining([
                  expect.toBeNonNaNNumber(),
                  expect.toBeNonNaNNumber(),
                ]),
                mode: "orbit",
              }),
              isDeleted: false,
            }),
          ]),
        );
      });

      it("should unbind rectangles from arrow on deletion and rebind on undo", async () => {
        // `rect1`/`rect2` captured in beforeEach are stale (rect1's geometry
        // changed when the text was bound in); select the live elements so the
        // click geometry is correct.
        const liveRect1 = () => h.elements.find((e) => e.id === rect1.id)!;
        const liveRect2 = () => h.elements.find((e) => e.id === rect2.id)!;

        mouse.select([liveRect1(), liveRect2()]);
        Keyboard.keyPress(KEYS.DELETE);
        expect(API.getUndoStack().length).toBe(8);
        expect(API.getRedoStack().length).toBe(0);
        expect(h.elements).toEqual([
          expect.objectContaining({
            id: rect1.id,
            boundElements: [
              { id: text.id, type: "text" },
              { id: arrow.id, type: "arrow" },
            ],
            isDeleted: true,
          }),
          expect.objectContaining({
            id: text.id,
            containerId: rect1.id,
            isDeleted: true,
          }),
          expect.objectContaining({
            id: rect2.id,
            boundElements: [{ id: arrow.id, type: "arrow" }],
            isDeleted: true,
          }),
          expect.objectContaining({
            id: arrow.id,
            startBinding: null,
            endBinding: null,
            isDeleted: false,
          }),
        ]);

        Keyboard.undo();
        expect(API.getUndoStack().length).toBe(7);
        expect(API.getRedoStack().length).toBe(1);
        expect(h.elements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: rect1.id,
              boundElements: expect.arrayContaining([
                { id: arrow.id, type: "arrow" },
                { id: text.id, type: "text" }, // order has now changed!
              ]),
              isDeleted: false,
            }),
            expect.objectContaining({
              id: text.id,
              containerId: rect1.id,
              isDeleted: false,
            }),
            expect.objectContaining({
              id: rect2.id,
              boundElements: [{ id: arrow.id, type: "arrow" }],
              isDeleted: false,
            }),
            expect.objectContaining({
              id: arrow.id,
              startBinding: expect.objectContaining({
                elementId: rect1.id,
                fixedPoint: expect.arrayContaining([
                  expect.toBeNonNaNNumber(),
                  expect.toBeNonNaNNumber(),
                ]),
                mode: "orbit",
              }),
              endBinding: expect.objectContaining({
                elementId: rect2.id,
                fixedPoint: expect.arrayContaining([
                  expect.toBeNonNaNNumber(),
                  expect.toBeNonNaNNumber(),
                ]),
                mode: "orbit",
              }),
              isDeleted: false,
            }),
          ]),
        );
      });
    });

    it("should disable undo/redo buttons when stacks empty", async () => {
      const { container } = await render(
        <Excalidraw
          initialData={{
            elements: [API.createElement({ type: "rectangle", id: "A" })],
          }}
        />,
      );

      const undoAction = createUndoAction(h.history);
      const redoAction = createRedoAction(h.history);

      await waitFor(() => {
        expect(h.elements).toEqual([expect.objectContaining({ id: "A" })]);
        expect(h.history.isUndoStackEmpty).toBeTruthy();
        expect(h.history.isRedoStackEmpty).toBeTruthy();
      });

      const undoButton = queryByTestId(container, "button-undo");
      const redoButton = queryByTestId(container, "button-redo");

      expect(undoButton).toBeDisabled();
      expect(redoButton).toBeDisabled();

      const rectangle = UI.createElement("rectangle");
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: rectangle.id }),
      ]);

      expect(h.history.isUndoStackEmpty).toBeFalsy();
      expect(h.history.isRedoStackEmpty).toBeTruthy();
      expect(undoButton).not.toBeDisabled();
      expect(redoButton).toBeDisabled();

      API.executeAction(undoAction);

      expect(h.history.isUndoStackEmpty).toBeTruthy();
      expect(h.history.isRedoStackEmpty).toBeFalsy();
      expect(undoButton).toBeDisabled();
      expect(redoButton).not.toBeDisabled();

      API.executeAction(redoAction);

      expect(h.history.isUndoStackEmpty).toBeFalsy();
      expect(h.history.isRedoStackEmpty).toBeTruthy();
      expect(undoButton).not.toBeDisabled();
      expect(redoButton).toBeDisabled();
    });

    it("remounting undo/redo buttons should initialize undo/redo state correctly", async () => {
      const { container } = await render(
        <Excalidraw
          initialData={{
            elements: [API.createElement({ type: "rectangle", id: "A" })],
          }}
        />,
      );

      const undoAction = createUndoAction(h.history);

      await waitFor(() => {
        expect(h.elements).toEqual([expect.objectContaining({ id: "A" })]);
        expect(h.history.isUndoStackEmpty).toBeTruthy();
        expect(h.history.isRedoStackEmpty).toBeTruthy();
      });

      expect(queryByTestId(container, "button-undo")).toBeDisabled();
      expect(queryByTestId(container, "button-redo")).toBeDisabled();

      // testing undo button
      // -----------------------------------------------------------------------

      const rectangle = UI.createElement("rectangle");
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: rectangle.id }),
      ]);

      expect(h.history.isUndoStackEmpty).toBeFalsy();
      expect(h.history.isRedoStackEmpty).toBeTruthy();
      expect(queryByTestId(container, "button-undo")).not.toBeDisabled();
      expect(queryByTestId(container, "button-redo")).toBeDisabled();

      API.executeAction(actionToggleViewMode);
      expect(h.state.viewModeEnabled).toBe(true);

      expect(queryByTestId(container, "button-undo")).toBeNull();
      expect(queryByTestId(container, "button-redo")).toBeNull();

      API.executeAction(actionToggleViewMode);
      expect(h.state.viewModeEnabled).toBe(false);

      await waitFor(() => {
        expect(queryByTestId(container, "button-undo")).not.toBeDisabled();
        expect(queryByTestId(container, "button-redo")).toBeDisabled();
      });

      // testing redo button
      // -----------------------------------------------------------------------

      API.executeAction(undoAction);

      expect(h.history.isUndoStackEmpty).toBeTruthy();
      expect(h.history.isRedoStackEmpty).toBeFalsy();
      expect(queryByTestId(container, "button-undo")).toBeDisabled();
      expect(queryByTestId(container, "button-redo")).not.toBeDisabled();

      API.executeAction(actionToggleViewMode);
      expect(h.state.viewModeEnabled).toBe(true);

      expect(queryByTestId(container, "button-undo")).toBeNull();
      expect(queryByTestId(container, "button-redo")).toBeNull();

      API.executeAction(actionToggleViewMode);
      expect(h.state.viewModeEnabled).toBe(false);

      expect(h.history.isUndoStackEmpty).toBeTruthy();
      expect(h.history.isRedoStackEmpty).toBeFalsy();
      expect(queryByTestId(container, "button-undo")).toBeDisabled();
      expect(queryByTestId(container, "button-redo")).not.toBeDisabled();
    });
  });
});
