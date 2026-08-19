# Package-boundary plan — revision 2 (deletion-first)

**Status**: report only. Revision 1 is withdrawn; its central conclusion was backwards.

## What I got wrong

Revision 1 argued: _"`AppState` has 335 occurrences in `element/src`, therefore narrowing the headless surface is not viable, therefore move the shared type graph into `common`."_

That reasoning is inverted. **I wrote the headless barrel by copying `index.ts` minus the browser-only modules** — 36 modules — and then used its size as evidence that it could not be smaller. The leak count is a property of my barrel, not of any generic consumer's needs. The smoke test consumes exactly two symbols (`Scene`, `newElement`).

## Measured: a minimal surface barely leaks at all

| module                                   | leaks `excalidraw` types |
| ---------------------------------------- | ------------------------ |
| `Scene`                                  | **0**                    |
| `newElement`                             | **0**                    |
| `textMeasurements`                       | **0**                    |
| `yjs/schema`, `yjs/origin`, `yjs/intent` | **0**                    |
| `typeChecks`                             | 1 — `ElementOrToolType`  |
| `bounds`                                 | 1 — `AppState`           |

Both residuals are a single type, and neither needs `AppState` moved:

- `bounds.ts:1182` destructures **five viewport fields** — `{ scrollX, scrollY, width, height, zoom }`. Narrow the parameter to that structural shape. A headless consumer has no viewport anyway.
- `typeChecks` uses `ElementOrToolType = ExcalidrawElementType | ToolType | "custom"` in 3 functions. `ToolType` is editor-side; either keep those 3 internal or narrow to the element-side union.

`AppClassProperties` does **not** move, per review. Any retained public operation that needs it gets the narrow structural capability instead, or stays internal.

## Public-surface audit (to complete before any code)

For each generic workflow, list the exact functions/types consumed; export only those. Everything else stays internal — `Scene` already provides binding, group and frame semantics through `mutateElement`, so a consumer does not import `binding`, `groups` or `frame` to get them.

| workflow | expected surface |
| --- | --- |
| create / adopt a doc | `Scene` (+ `{ doc }` option) |
| import an existing Excalidraw board | the fresh-lineage JSON converter |
| scoped element mutations (binding/group/frame semantics included) | `Scene.mutateElement`, `applyElementChanges`, element constructors |
| files / appState | `Scene.setFiles/getFiles/getPersistedAppState` |
| encode / decode | `encodeStateAsUpdate`, `applyRemoteUpdate`, `decodeSnapshot` |
| observe / apply updates | `Scene.onDocUpdate`, `Scene.applyRemoteUpdate` |
| text in Node | `setCustomTextMetricsProvider` |

**Proof**: a packed-tarball consumer in a fresh temp project, installing only declared deps, compiling a **real workflow** under `tsc` and running it in Node — not merely importing the barrel.

## Deletions (measured, no aliases — none of this shipped)

| target | evidence |
| --- | --- |
| `CollabEngine` public export | non-test references are **only** its own definition and the `index.tsx` export line. Zero callers, unattachable through the public API (constructor needs `Scene`, which is not exported), and its correct origin/filter boundary depends on unfinished FR-017. Keeping it is preserving an intermediate stage. |
| `Scene.encodeSnapshot()` | **0** production callers, 4 test uses, and the body is `return Y.encodeStateAsUpdateV2(this.doc)` — a duplicate of `encodeStateAsUpdate("v2")`. |
| `Scene.fromSnapshot()` | **0** production callers, 3 test uses. |

Reintroduce collaboration as one coherent public attach boundary when designed — preference noted: `App`/`ExcalidrawImperativeAPI` owning `attachCollaboration(transport)` returning a destroy handle, never handing out `Scene`. Name frozen only after the workflow audit.

## Converter naming (after the call-site audit, not before)

Keep the converters. Make the lineage semantics unmissable:

- fresh-lineage import from ordinary Excalidraw JSON → e.g. `importExcalidrawSnapshotAsYjsUpdate`
- `decodeSnapshot` returns JSON and **discards lineage** — the name must say so; it is used by `firebase.ts`, so it is a real consumer, not test-only.

## Ordering

1. **Now**: product-neutral origin sentinels, correct repository metadata on both packages, delete the `CollabEngine` public export. Independent of T016.
2. **Now-ish**: delete the two redundant `Scene` snapshot methods once their tests are re-pointed.
3. **Next**: the public-surface audit and the narrowed barrel + tarball consumer test. This is the smallest slice that unblocks headless consumers and does **not** wait on T016, nor block it.
4. **Deferred**: converter renaming, after the call-site audit.

The package version needs a neutral Yjs prerelease scheme rather than another historical suffix — flagging as a decision, not inventing one.
