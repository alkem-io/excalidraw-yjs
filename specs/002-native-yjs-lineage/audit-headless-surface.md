# Headless public-surface audit (consumer-driven)

**Method**: one row per workflow the current consumers actually asked for. Each row names the **semantic planner**, the **commit primitive**, and who owns **transport/durability** — separately. No helper is exported to turn a red cell green.

**Wording correction**: it is not true that "no semantic planners exist". They do, and most live in `packages/element/src` — so they are in principle exportable. The accurate finding is that **there is no audited, supported high-level planner boundary**, because the planners that exist are _commit-coupled_.

## The structural blocker: planners write, they do not plan

Measured:

| planner                 | takes `Scene` | internal `mutateElement` calls |
| ----------------------- | ------------- | ------------------------------ |
| `resizeSingleElement`   | yes           | 3                              |
| `redrawTextBoundingBox` | yes           | 3                              |
| `addElementsToFrame`    | no            | 1                              |
| `updateBoundElements`   | yes           | 0 (writes via helpers)         |
| `duplicateElements`     | no            | 0 — pure                       |

So calling `resizeSingleElement` headlessly performs **three separate doc transactions**, each its own broadcast. A consumer gets the T016k defect directly: several observable states, no atomic boundary, and no way to batch them. Exporting these today would publish that behaviour as the supported API.

`duplicateElements` is the exception — it is pure and returns elements.

## Workflow table

| workflow | semantic planner | commit primitive | transport / durability | status |
| --- | --- | --- | --- | --- |
| adopt an existing `Y.Doc` | — | `new Scene({ doc })` | consumer | **available** |
| encode / decode native updates | — | `encodeStateAsUpdate`, `applyRemoteUpdate` | consumer | **available** |
| import Excalidraw JSON (fresh lineage) | `restoreElements` (excalidraw pkg) | `buildSnapshotDoc` / `encodeSnapshot` | consumer | **partial** — planner is in the React package, not headless |
| read elements / text | — | `Scene` accessors, `getTextFromElements` | — | **available** |
| create element | `newElement` + placement/index logic in **App** | `applyElementChanges` | consumer | **unavailable** — placement planner is App-internal |
| edit properties | action layer (`changeProperty`) — App | `Scene.mutateElement` | consumer | **unavailable** as a planner; raw scoped write is available |
| delete | `actionDeleteSelected` — App (handles bound text, frame children, binding cleanup) | — | — | **unavailable** |
| move | `dragSelectedElements` — App, plus `updateBoundElements` | — | — | **unavailable** |
| resize | `resizeSingleElement` / `resizeMultipleElements` — element pkg, **commit-coupled (3 writes)** | — | — | **unavailable** as an atomic operation |
| duplicate | `duplicateElements` — element pkg, **pure** | `applyElementChanges` | consumer | **available** once exported |
| template import into an existing board | `addElementsFromPasteOrLibrary` — App, multi-write (T016m) | — | — | **unavailable** |

## Consequence for the barrel

The current barrel re-exports 36 modules, which advertises capability the package does not have: a consumer importing `resizeElements` gets a function that writes three times and cannot be batched.

Minimum honest surface today = the **available** rows:

```
Scene                       (adopt doc, accessors, mutateElement, applyElementChanges,
                             onDocUpdate, applyRemoteUpdate, encodeStateAsUpdate)
newElement + constructors   (element construction, not placement)
yjs schema / origins / intent
setCustomTextMetricsProvider
getTextFromElements
duplicateElements           (the one pure planner)
decodeSnapshot / buildSnapshotDoc   (with lineage-explicit names — see below)
```

`bounds` and `typeChecks` are NOT included: neither has a named consumer, and each is the reason for one remaining type leak. If a workflow needs them, they come in with that workflow.

## Blockers this makes explicit

1. **No generic transport boundary. (RESOLVED)** `getSceneDoc` handed out a mutable `Y.Doc`, so every embedder had to reimplement origin filtering and logical-update batching. Now `ExcalidrawImperativeAPI` exposes `onLocalSceneUpdate` / `applyRemoteSceneUpdate` / `encodeSceneAsUpdate`, delegating to the `Scene` methods that already carry the policy, and `getSceneDoc` is **removed** from the public API — the raw doc is no longer reachable, so the policy cannot be bypassed by construction. `Collab.tsx` is migrated onto the boundary and its duplicate origin filter is deleted, leaving ONE copy of the policy; it no longer imports `yjs`, `REMOTE_ORIGIN`, or `EPHEMERAL_ORIGIN` at all. **One boundary, and the second engine (`CollabEngine`) is deleted rather than left as a parallel implementation.**
2. **No atomic planner API.** Blocked on T016k — the planners must return plans rather than writing.
3. **Version** `0.18.0-864353b-alkemio-16` — unresolved release blocker, needs a neutral scheme decision. Contamination is NOT cleared while this stands.
4. Converter naming: `decodeSnapshot` materializes a view and **discards lineage**; `buildSnapshotDoc`/`encodeSnapshot(snapshot)` mint a **fresh** lineage. Rename before the surface freezes. Note `encodeSnapshotAsUpdate` and one `buildSnapshotDoc` call site live in `96f9bce3`, the known-defective baseline 002 deletes — that part of the surface disappears with the code.
