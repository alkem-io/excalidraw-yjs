# T023 — files boundary contract (DRAFT, docs only)

Proposal for review. **No code, and the marked `OPEN` items are decisions for the repo owner, not settled here.** Evidence is in `audit-files-boundary.md`.

## The invariant

Binary bytes never reach the collaboration wire, and cannot be placed on it by construction rather than by a filter. A filter is not available anyway: Yjs encodes the whole document, so omitting `yFiles` structs from a full-state update risks receiver clock gaps and pending dependencies.

## Ownership

| Concern | Owner |
| --- | --- |
| Image bytes (`dataURL`) | Local editor cache (`App.files`) + the host asset store |
| Upload / download | Host adapter (bundled app: `FileManager` + Firebase) |
| "Which asset does this element use" | The image element's existing `fileId` + `status` — already in the document |
| Portable archive | An explicit converter, separate from the live document |

## Field-by-field decision table

`BinaryFileData` today: `id`, `mimeType`, `dataURL`, `created`, `lastRetrieved?`, `version?`. `BinaryFileMetadata = Omit<BinaryFileData, "dataURL">` already exists but is **not** a safe shared shape as-is — it still carries `lastRetrieved`.

| Field | Shared? | Why |
| --- | --- | --- |
| `dataURL` | **Never** | The whole point. Must be impossible by type, not by convention. |
| `id` (`fileId`) | Yes | Already on the element; the key any locator resolves. |
| `mimeType` | **OPEN** | Needed remotely only if a peer must decide how to render _before_ fetching bytes. Otherwise it comes with the fetch. |
| `created` | **OPEN** | No verified remote consumer found. Include only if one is shown. |
| `lastRetrieved` | **No** | Its own doc says it is local storage/cache-cleanup state. |
| `version` | **No** | Concerns `dataURL` schema changes; meaningless without bytes. |
| locator | **OPEN** | Opaque host-owned reference. See below. |

The likely shared minimum is therefore `fileId` + an opaque locator, with `mimeType`/`created` admitted only against a demonstrated remote consumer. That is a much smaller change than inventing a new asset model.

## The locator question (OPEN — the central one)

Two candidate shapes:

**(a) No shared map; host resolves `fileId`.** Smallest possible surface. Blocked today by a concrete mismatch: Excalidraw's `fileId` is a SHA-1 content hash while the Alkemio file-service external id is SHA3-256, so `resolve(fileId)` is not derivable without a separate mapping the host would have to keep anyway.

**(b) A small byte-impossible reference map in the document,** keyed by `fileId`, holding an opaque host locator. Survives the hash mismatch and needs no host-side index. Costs one more root to keep consistent and GC.

Evidence currently favours **(b)**, but only because of the hash mismatch — if a deterministic lookup is established, **(a)** is strictly better. **OPEN.**

Whatever is chosen, core must not contain Alkemio URLs, bucket ids, auth ids or row ids. The locator is opaque to core.

## Host adapter boundary (shape OPEN)

Core defines asset-reference semantics and calls a host-supplied adapter to store, fetch and resolve. Alkemio supplies the file-service adapter; the bundled app supplies the Firebase one. Core ships no default that assumes either.

## Rules that follow

1. Upload failure fails locally, visibly, and retries. It **never** falls back to publishing bytes into shared state. (Review reports exactly such a fallback in client-web — unverified here, flagged in `audit-files-boundary.md`.)
2. `getFiles`/`addFiles` remain the local binary cache API. If shared metadata exists it is a separate named type, merged into the cache without overwriting local bytes.
3. The persistence checkpoint stores collaborative state. A binary archive, if wanted, is a separate artifact produced by a converter — an export format must not dictate the live document schema.
4. Clone/copy semantics (**stated, not designed**): with ownership-scoped locators, a clone duplicates or de-duplicates asset rows and rewrites only the small references. Bytes stay content-addressed and are not copied. **OPEN.**
5. Rollout is atomic across this package and its consumers, with no alias or dual mode. **OPEN — requires the owner's call**, since it deletes a shape client-web currently depends on.

## What is NOT decided here

The exact shared reference fields; (a) vs (b); the adapter's operation list; the clone model; and the cross-repo migration. Those are marked OPEN above and need the repo owner's decision before any implementation.
