# Native-Yjs Excalidraw Core — Architecture

**Goal:** the whiteboard editor **is** Yjs. Excalidraw's element store is a `Y.Doc`.
There is no scene-array source of truth and no scene↔Yjs binding. Collaboration,
history, and persistence all derive from the one doc. This is a deliberate rewrite
of Excalidraw's core — deep internal changes are the task, not a violation of it.

## What's being replaced (today)

- `Scene` (`packages/element/src/Scene.ts`) is the element store: `elements:
  OrderedExcalidrawElement[]` + `elementsMap`, plus derived caches
  (`nonDeletedElements`, `frames`, …). Two write paths:
  - `replaceAllElements(next)` — bulk replace (insert/map/etc. all funnel here).
  - `scene.mutateElement(el, updates)` → `mutateElement()` mutates the JS object
    **in place**, bumps `version`, then `triggerUpdate()`.
- The `Y.Doc` is **external**: `WhiteboardBinding` (`packages/yjs-binding`) observes
  the scene and mirrors it into a `Y.Doc` — a *second* representation kept in sync.
  That is precisely why the editor is "JSON internally": the scene is the source,
  the doc is a copy.

## Target

- `Scene` owns `doc: Y.Doc` with **`yElements: Y.Map<id, Y.Map<prop, value>>`** —
  per-property element maps (concurrent edits to one element merge per-property) —
  as the **single source of truth**, plus `yAppState` / `yFiles`.
- **Writes** (`replaceAllElements`, `mutateElement`) write to `yElements` inside
  `doc.transact()`. No in-place JS mutation as the source of truth.
- **Reads**: `elements` / `elementsMap` / `nonDeleted*` / `frames` are **derived,
  recomputed from `yElements`** (ordered by fractional index) on the doc's
  `observe`, then `triggerUpdate()` fires the existing callbacks. The renderer
  (which iterates an array) reads these derived views — untouched above `Scene`.
- The element↔Y.Map **schema** (`elementToYMap` / `yMapToElement`, per-property
  tiering, fractional-index order) **moves from `packages/yjs-binding` into
  `packages/element`** — it is a core element concern now.
- **History**: `Y.UndoManager` on the doc replaces `packages/excalidraw/history.ts`.
- **Collab**: the unified provider attaches to `Scene.doc` directly.
  **`WhiteboardBinding` is deleted** — there is nothing left to bridge.
- **Persistence**: `encodeStateAsUpdateV2(Scene.doc)` / `applyUpdateV2` — the
  wire/storage-is-Yjs layer (already built server-side) is exactly this.

## The real challenge (why it's staged, not a patch)

Excalidraw mutates element **objects in place** and holds live references to them
all over the codebase. Native means writes go to the doc and element objects are
**derived (fresh each recompute)**. So `mutateElement()` and every holder of a live
element reference must move to *write-to-doc → re-read*. That conversion is the
bulk of the work.

## Milestones — each demoed **running native**, not reported

- **M1 — Scene on Y.Doc.** `yElements` is the source; `replaceAllElements` +
  `scene.mutateElement` write to it; reads derive via `observe`; schema moved into
  `packages/element`. The editor edits single-user **straight off the doc** (no
  provider attached yet).
- **M2 — History.** `Y.UndoManager`; undo/redo off the doc; delete snapshot history.
- **M3 — Collab.** Attach the unified provider to `Scene.doc`; **delete**
  `WhiteboardBinding`, `useCollab`'s scene-sync, and the template/merge scene utils.
  Two users edit one doc directly.
- **M4 — Persistence cutover.** Create/load/save encode/decode `Scene.doc`; server
  stores the bytes (done); remove any remaining scene/JSON paths.

## Done bar (yours to check, per milestone)

The editor's element store **is** the `Y.Doc`; there is no `elements` array as a
source of truth; `WhiteboardBinding` is deleted; two users edit one doc. **Not**
"a save emits bytes."
