# Minimal package-boundary plan (generic excalidraw-yjs)

**Status**: report only, no refactor started. Numbers are measured, not estimated.

## Defect 1 — `@excalidraw-yjs/element/headless` is not a sound standalone TS package

**Measured.** Across `packages/element/src`:

```
62  imports from "@excalidraw-yjs/excalidraw/types"
 4  imports from "@excalidraw-yjs/excalidraw/scene/types"
 2  imports from "@excalidraw-yjs/excalidraw/components/App"   (type-only, store.ts — NOT in headless)
```

**21 of the 36 modules the headless barrel re-exports** import from the excalidraw package: `align`, `binding`, `bounds`, `collision`, `comparisons`, `distribute`, `duplicate`, `elbowArrow`, `flowchart`, `frame`, `groups`, `image`, `resizeElements`, `selection`, `shape` (×2), `sizeHelpers`, `textElement`, `typeChecks`, `utils`, `zindex`, `arrows/helpers`.

`packages/element/package.json` declares no dependency on `@excalidraw-yjs/excalidraw`. So a consumer installing only `element` gets working JS (proved by the bare-Node smoke) but **cannot resolve the public types**.

**Where the types live** — this decides the shape of the fix:

| type | defined in |
| --- | --- |
| `SceneElementsMap`, `NonDeletedSceneElementsMap` | `element/src/types.ts` ✅ already neutral |
| `AppState`, `InteractiveCanvasAppState`, `StaticCanvasAppState`, `AppClassProperties`, `Zoom`, `PendingExcalidrawElements` | `excalidraw/types.ts` ❌ |

`AppState` is pervasive — 335 identifier occurrences in `element/src`. So **narrowing the headless surface is not viable**: it would have to drop `binding`, `shape`, `selection`, `resizeElements` and most of the geometry, which is the whole point of the entry.

**Direction**: move the dependency-neutral type shapes DOWN into a package `element` already depends on (`@excalidraw-yjs/common`), and have `excalidraw` re-export them for its own consumers. Not a circular dependency from `element` → `excalidraw`, and not shipping the React editor as a runtime dep.

`AppClassProperties` is the one that may not be movable — it is the App class surface. Modules needing it (14 occurrences) may need a narrower structural parameter type instead. That is the part of this plan I would not call mechanical.

**Proof required**: a packed-tarball consumer fixture — fresh temp project, installs only declared deps, runs `tsc` **and** a bare-Node import. The current smoke proves runtime only.

## Defect 2 — `CollabEngine` is not attachable through the public API

Exported from `@excalidraw-yjs/excalidraw`, but its constructor requires `Scene`, which is not exported from the main package. `ExcalidrawImperativeAPI` exposes only `getSceneDoc(): Y.Doc`. Only tests construct it — zero production callers.

**Direction**: make it operate on the `Y.Doc` (+ generic origin/handler config) so `api.getSceneDoc()` suffices, OR give `ExcalidrawImperativeAPI` a minimal collaboration attach point. Not exposing `Scene`. Proof is an external-consumer test using only published exports.

Note this interacts with FR-017: `CollabEngine` currently subscribes via `Scene.onDocUpdate`, which filters only `REMOTE_ORIGIN` — the R2-#10 defect where an embedder broadcasts `resetScene`'s destructive deletes. Whatever shape it takes must consume the same origin policy, not re-derive one.

## Defect 3 — product identity in generic runtime vocabulary

| item | measured |
| --- | --- |
| origin sentinels `alkemio-yjs-*` | 8 occurrences in `yjs/origin.ts` |
| package version `0.18.0-864353b-alkemio-16` | `excalidraw/package.json` |
| Alkemio named in published source | 3 files |
| `element` repository metadata | points at **upstream** `excalidraw/excalidraw` ❌ |
| `excalidraw` repository metadata | points at `alkem-io/excalidraw-fork` — the **old repo name**, now `excalidraw-yjs` ❌ |

Origins become `local` / `structural` / `ephemeral` / `remote`. No aliases: none of this shipped.

## Defect 4 — converter naming, not converter deletion

Converters stay: fresh-lineage import from ordinary Excalidraw JSON is a generic necessity. But two operations currently have near-identical names and opposite lineage semantics:

- `encodeSnapshot(snapshot)` (schema) — builds a **fresh** `Y.Doc`, new lineage
- `Scene.encodeSnapshot()` — encodes the **live** doc, preserving lineage

An external consumer choosing wrongly gets the ~50% concurrent-edit loss this whole spec exists to remove. Rename so the distinction is unmissable, and document both.

## Ordering

Defect 3 is mechanical and can land immediately. Defect 4 is naming plus docs. Defects 1 and 2 are real design work and should not start before T016's correctness work is settled — but the generic-readiness claim cannot be made until both have their boundary tests.
