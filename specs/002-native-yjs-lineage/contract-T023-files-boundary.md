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
| `id` (`fileId`) | It IS the key | Already on the element. In a reference map it is the map key, not a value stored alongside — do not duplicate it into the record. |
| `mimeType` | **OPEN** | Needed remotely only if a peer must decide how to render _before_ fetching bytes. Otherwise it comes with the fetch. |
| `created` | **OPEN** | No verified remote consumer found. Include only if one is shown. |
| `lastRetrieved` | **No** | Its own doc says it is local storage/cache-cleanup state. |
| `version` | **No** | Concerns `dataURL` schema changes; meaningless without bytes. |
| locator | **OPEN** | Opaque host-owned reference. See below. |

The likely shared minimum is therefore `fileId` + an opaque locator, with `mimeType`/`created` admitted only against a demonstrated remote consumer. That is a much smaller change than inventing a new asset model.

## The locator question (OPEN — the central one)

First, a property core cannot rely on: **`fileId` is not universally a content hash.** `generateIdFromFile` digests the file with SHA-1, but on any digest failure it falls back to `nanoid(40)` — deliberately the same length, so the value is indistinguishable from a hash by inspection. Core therefore cannot treat `fileId` as a derivable content key.

Two candidate shapes:

**(a) No shared map; the host resolves.** Smallest possible surface. Viable ONLY if the host can prove `resolve(documentContext, fileId)` for all three of join, clone and reload. That is not merely a hashing question: multi-tenancy, bucket or ownership scoping, and host namespacing may all require document context beyond the bare id. And even a perfect digest lookup would not cover the random-id fallback above.

Concretely for the first adapter, Excalidraw's `fileId` is SHA-1 (when digesting succeeds) while the Alkemio file-service external id is SHA3-256, so no direct derivation exists today.

**(b) A small byte-impossible reference map in the document,** keyed by `fileId`, whose value is an opaque host locator. Needs no host-side index and is unaffected by both the hash mismatch and the random-id fallback. Costs one more root to keep consistent and to GC.

Evidence currently favours **(b)**. It does not follow that (a) becomes "strictly better" once a digest lookup exists — (a) additionally requires the host to demonstrate context-free resolution across join, clone and reload. **OPEN.**

Whatever is chosen, core must not contain Alkemio URLs, bucket ids, auth ids or row ids. The locator is **opaque to core**: core stores and round-trips it and never parses it. Its representation is **OPEN** — do not assume a URL or even a string until the host boundary is settled.

## Host adapter boundary (shape OPEN)

Core defines asset-reference semantics and calls a host-supplied adapter to store, fetch and resolve. Alkemio supplies the file-service adapter; the bundled app supplies the Firebase one. Core ships no default that assumes either.

## Rules that follow

1. Upload failure fails locally, visibly, and retries. It **never** falls back to publishing bytes into shared state. (Review reports exactly such a fallback in client-web — unverified here, flagged in `audit-files-boundary.md`.)
2. `getFiles`/`addFiles` remain the local binary cache API. If shared metadata exists it is a separate named type, merged into the cache without overwriting local bytes.
3. The persistence checkpoint stores collaborative state. A binary archive, if wanted, is a separate artifact produced by a converter — an export format must not dictate the live document schema. To keep bytes from returning to the document by stealth, the archive shape is explicit: **a collaborative update PLUS a separately enumerated set of assets (or an asset manifest)**. Export emits the two side by side. Import applies the update and resolves each asset **through the host adapter** — never by writing `dataURL` into the live document.
4. Clone/copy semantics (**stated, not designed**): core rewrites only the small references and **delegates any physical copy or de-duplication to the host adapter** — whether bytes are duplicated, shared or content-addressed is a host property, not a core contract. (The Alkemio adapter can, for instance, mint a new row pointing at the same content-addressed blob.) **OPEN.**
5. Rollout is atomic across this package and its consumers, with no alias or dual mode. **OPEN — requires the owner's call**, since it deletes a shape client-web currently depends on.

## What is NOT decided here

The exact shared reference fields; (a) vs (b); the adapter's operation list; the clone model; and the cross-repo migration. Those are marked OPEN above and need the repo owner's decision before any implementation.
