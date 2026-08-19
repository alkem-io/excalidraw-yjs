# Files boundary — producer/consumer evidence

Read-only evidence for the question "where do image bytes live relative to the collaborative document?". **No design decision is made here.** Every row was verified by reading the code, not inferred.

## The measurement that forces the question

`yFiles` stores whole `BinaryFileData` records — `dataURL` included — in the same `Y.Doc` as the elements. A raw live-doc encode therefore carries live image bytes verbatim: a scene holding one 4096-byte payload encodes to 4189 bytes and the payload appears in the update. So switching the wire to a raw live encode (T032) would ship **every live binary on every INIT and every periodic resync**.

This is not fixable by excluding `yFiles` from a broadcast: Yjs encodes the whole document, and omitting root structs from a full-state update risks receiver clock gaps and pending dependencies.

Orphan GC (T025) does not address it — that reclaims only _unreferenced_ files. The problem is **live** binary transport.

## Producers — what writes bytes into the document

| Producer | Site | Notes |
| --- | --- | --- |
| `App.addMissingFiles` → `Scene.setFiles` | `App.tsx:4763` | The **only** production writer. Under `LOCAL_ORIGIN`, so each added binary is already emitted incrementally through `onDocUpdate`. |
| `buildSnapshotDoc` → `writeFiles` | `schema.ts` | Snapshot construction for persistence/export. |

## Consumers — what reads them

| Consumer | Site | Needs bytes _in the doc_? |
| --- | --- | --- |
| `App.refreshFilesFromScene` | `App.tsx:4871` | No — a read-only mirror into the local `this.files` cache. Would work from any local source. |
| `ExcalidrawAPI.getFiles` | `App.tsx:786` | No — returns the local cache to app/AI/export callers. |
| `decodeSnapshot` → firebase load | `firebase.ts:297` | **Yes, today** — the persistence checkpoint is expected to return elements + files + appState together. |
| `encodeSnapshotAsUpdate` → save | `data/index.ts:128` | **Yes, today** — same checkpoint shape. |

## The pre-existing out-of-band path (already correct, already shipped)

| Piece | Site |
| --- | --- |
| `FileManager` | `excalidraw-app/data/FileManager.ts:22` |
| upload | `Collab.tsx:181` → `saveFilesToFirebase` (`firebase.ts:333`) |
| download | `Collab.tsx:173` → `loadFilesFromFirebase` (`firebase.ts:500`) |
| signalling | image element carries `fileId` + `status`; peers seeing `status: "saved"` fetch bytes and call `addFiles` |

So the bundled app **already** has a complete binary transport that does not use the CRDT. Firebase also stores files separately from the scene checkpoint.

## What this establishes

1. There are **two** binary authorities: the out-of-band asset path, and `yFiles` inside the collaborative document. The second duplicates the first.
2. `yFiles`' only _unique_ consumer is the persistence checkpoint's "one blob is the whole whiteboard" shape — a **portable-archive** requirement, which is not the same requirement as live collaboration lineage.
3. Nothing in the editor needs bytes in the document to render or to collaborate; the mirrors are read-only into a local cache that the out-of-band path can fill.

## Open question for the design decision (NOT answered here)

Does any real consumer require binary bytes inside the _live_ document, as opposed to (a) a local byte cache plus a host asset store, and (b) an explicit archive converter that returns assets alongside the Yjs content?

If a shared **reference** is genuinely needed, the open sub-question is whether a manifest is required at all or whether a host `resolve(fileId)` suffices. Either way the shared record would have to be a type that cannot carry `dataURL` by construction — casting `BinaryFileData` into a loose record and trusting callers to omit the bytes is what produced the current duplication.

## Cross-repo consumers (reported by review; NOT verified in this repo)

These are outside this worktree and are recorded as leads to confirm, not as findings:

- **client-web** — `useWhiteboardFilesManager` reportedly mixes `{url, dataURL}` in the shared record and, on upload failure, falls back to publishing `dataURL` "so peers receive it directly". If accurate that is a live INV-NO-BINARY-WIRE violation and an upload-failure path that changes transport.
- **server** — `whiteboard-scene.writer.ts` reportedly drives `Scene.insertElement` / `mutateElement` directly to implement shape/text/connector tools. The chain is real in _this_ repo: `insertElement` → `insertElementsAtIndex` → **`replaceAllElements`** (`Scene.ts:1933` → `:1901` → the authoritative whole-scene path). Any claim that such a tool avoids whole-scene reconcile is false, and it consumes exactly the path T016 exists to retire.
