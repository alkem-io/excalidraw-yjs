# T023 — producer/consumer migration table

The gate before implementing T023 + T025b + T032. **No decision is recorded here**; the boundary design is still awaiting the repo owner's direct confirmation. This establishes what would have to change and whether any consumer is unresolved.

Scope: verified in THIS repo. Cross-repo rows are marked unverified.

## Two questions the contract left open — both now answered here

### `mimeType` — does any consumer need it BEFORE the bytes arrive?

**No.** All three production readers already hold the local `BinaryFileData`:

| Site | Reads from | Uses bytes in the same breath? |
| --- | --- | --- |
| `element/src/image.ts:56` | `files[fileId]` (local cache) | Yes — `loadHTMLImageElement(fileData.dataURL)` on the next line |
| `excalidraw/components/App.tsx:4732` | `fileData` being added locally | Yes — `dataURLToString(fileData.dataURL)` immediately after |
| `element/src/renderElement.ts:472` | `imageCache` entry | Yes — the cache entry only exists once bytes have loaded |

Nothing decides rendering before fetching. **`mimeType` must stay out of the shared map**, as proposed.

### Clone — whose concern is reference rewriting?

**Not core's.** There is no locator-rewriting or file-cloning consumer in this repo at all: `duplicate.ts` does not touch `fileId`, so a duplicated image element deliberately keeps the same reference and shares the asset.

Rewriting is only meaningful when copying across an OWNERSHIP boundary (a board clone), which no code here performs. So clone semantics belong to the host adapter and its embedder, not to core converter semantics — and physical copy/dedup stays entirely out of core, as proposed.

## Producers — what would have to change

| Producer | Site | Change |
| --- | --- | --- |
| `App.addMissingFiles` → `Scene.setFiles` | `App.tsx:4763` | Stop writing `BinaryFileData` to the doc. Bytes stay in `this.files`; publish only the reference. **The single write path.** |
| `buildSnapshotDoc` → `writeFiles` | `yjs/schema.ts` | Snapshot construction stops carrying bytes. |

## Consumers — what breaks and what does not

| Consumer | Site | Impact |
| --- | --- | --- |
| `App.refreshFilesFromScene` | `App.tsx:4871` | **Changes.** Today it mirrors bytes out of the doc into `this.files`. With references only, it must merge reference metadata WITHOUT clobbering local bytes, and fetching becomes the host's job. |
| `ExcalidrawAPI.getFiles` | `App.tsx:786` | Unchanged — already returns the local cache. |
| `image.ts` / `renderElement.ts` | above | Unchanged — read the local cache, never the doc. |
| `decodeSnapshot` → firebase load | `firebase.ts:297` | **Changes.** The checkpoint stops being self-contained; assets are enumerated separately. |
| `encodeSnapshotAsUpdate` → save | `data/index.ts:128` | **Changes.** Same split. |
| `Scene.collectGarbage` file branch | `Scene.ts` | **Simplifies.** GC reclaims small references, not binaries; the privacy argument weakens to metadata only. |

## Minimal adapter surface actually demanded

Only what the two current consumers need — no speculative operations:

1. **upload/store** → returns the opaque locator. Demanded by `addMissingFiles`.
2. **fetch/resolve(locator)** → returns bytes into the local cache. Demanded by `refreshFilesFromScene` when it sees a reference it has no bytes for.

`delete` is NOT demanded: nothing in this repo deletes a host asset today — `collectGarbage` would drop the reference only. Do not add it without a consumer.

## Unresolved consumers — the gate

| Consumer | Status |
| --- | --- |
| **client-web** `useWhiteboardFilesManager` | **UNVERIFIED and unresolved.** Reported to mix `{url, dataURL}` in the shared record and to fall back to publishing `dataURL` on upload failure. If accurate, the atomic cutover cannot happen without changing it in the same slice. |
| **server** `whiteboard-scene.writer.ts` | **UNVERIFIED.** Reported to drive `Scene.insertElement`; that chain resolves to `replaceAllElements` here, so it is on the authoritative whole-scene path, but its relationship to files is unconfirmed. |
| Firebase file storage | Resolved — already separate from the scene checkpoint. |

**Conclusion: the table has at least one unresolved consumer (client-web).** By the stated gate, implementation cannot start until that repo is inspected and included in the same atomic change.
