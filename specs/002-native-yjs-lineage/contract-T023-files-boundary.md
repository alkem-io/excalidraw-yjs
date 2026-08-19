# T023 — files boundary contract (DRAFT, docs only)

**SETTLED — approved by the repo owner 2026-08-20.** This is the contract the implementation follows. Evidence is in `audit-files-boundary.md`; the producer/consumer migration is in `audit-files-migration-table.md`.

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
| `id` (`fileId`) | It IS the key | Already on the element. In a reference map it is the map key, not a value stored alongside — do not duplicate it into the record. |
| `mimeType` | **No** | Verified: all three production readers already hold the local `BinaryFileData` and use its bytes in the same breath, so nothing decides rendering before fetching. |
| `created` | **No** | No verified remote consumer. Cache metadata stays local. |
| `lastRetrieved` | **No** | Its own doc says it is local storage/cache-cleanup state. |
| `version` | **No** | Concerns `dataURL` schema changes; meaningless without bytes. |
| locator | **Yes — the only value** | An opaque host-owned string. The record is `fileId -> locator` and nothing else. |

The likely shared minimum is therefore `fileId` + an opaque locator, with `mimeType`/`created` admitted only against a demonstrated remote consumer. That is a much smaller change than inventing a new asset model.

## The locator: a small shared reference map (settled)

The shared document carries a map keyed by `fileId` whose value is an **opaque string locator**. `fileId` is the key and is never duplicated into the value.

Core treats the locator as uninterpreted: it stores it, round-trips it and GCs it, and never parses it. No URL semantics, no bucket, auth or row identifiers, no host-specific schema in core.

A bare `resolve(fileId)` with no map was considered and rejected. `fileId` is not a reliable content key: `generateIdFromFile` digests SHA-1 but falls back to `nanoid(40)` on any digest failure — deliberately the same length, so indistinguishable by inspection. Resolution would also need document context for multi-tenancy and ownership scoping, which the bare id does not carry.

## Host adapter boundary (settled)

Core defines asset-reference semantics and calls a host-supplied adapter to store, fetch and resolve. Alkemio supplies the file-service adapter; the bundled app supplies the Firebase one. Core ships no default that assumes either.

## Rules that follow

1. Upload failure fails locally, visibly, and retries. It **never** falls back to publishing bytes into shared state. (Review reports exactly such a fallback in client-web — unverified here, flagged in `audit-files-boundary.md`.)
2. `getFiles`/`addFiles` remain the local binary cache API. If shared metadata exists it is a separate named type, merged into the cache without overwriting local bytes.
3. The persistence checkpoint stores collaborative state. A binary archive, if wanted, is a separate artifact produced by a converter — an export format must not dictate the live document schema. To keep bytes from returning to the document by stealth, the archive shape is explicit: **a collaborative update PLUS a separately enumerated set of assets (or an asset manifest)**. Export emits the two side by side. Import applies the update and resolves each asset **through the host adapter** — never by writing `dataURL` into the live document.
4. Clone/copy semantics: core rewrites the small references only and delegates any physical copy or de-duplication to the host adapter — whether bytes are duplicated, shared or content-addressed is a host property, not a core contract. No consumer in this repo performs a clone; `duplicate.ts` does not touch `fileId`, so a duplicated image deliberately shares the same reference.
5. Rollout is atomic across this package and its consumers, with no alias and no dual schema. This deletes a shape client-web currently depends on, so its `dataURL`-on-upload-failure fallback is removed in the SAME slice — a core-only cutover is not an acceptable intermediate state.

## Clone / archive encodes carry FRESH lineage — deliberately

A clone or a portable archive builds a NEW document: no shared history with the source, element ids preserved. Encoding it with fresh lineage is therefore CORRECT, and must not be confused with the defect this spec exists to remove.

The defect is re-encoding a **live collaborative** document through a throwaway doc with a fresh `clientID`, which silently loses concurrent edits and resurrects deletions. A clone has no concurrent peers to lose edits from, so the same mechanism is the requirement rather than the failure.

Stated here because a downstream consumer is building a clone against this contract, and the two cases look identical at the call site. Any clone/archive converter should say so where it encodes, or a later reader will "fix" it into carrying lineage it must not have.

## Adapter surface — only what a consumer demands

`store(bytes) -> locator` and `resolve(locator) -> bytes`. Nothing else. `delete` is deliberately absent: nothing in this repo deletes a host asset, and GC drops the reference only. Host-side deletion, copy and de-duplication stay with the host.
