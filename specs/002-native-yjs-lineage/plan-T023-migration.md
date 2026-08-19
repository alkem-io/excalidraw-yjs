# T023 — cross-repo migration plan

Approved 2026-08-20. Written before any destructive change, per the agreed order.

## What "atomic" means here, concretely

This package is an **unreleased hard fork on a feature branch**. Consumers pin it by SHA. So atomicity is _not_ "edit three repos in one commit" — it is:

> core lands the new boundary on the branch; each consumer completes its own side **before bumping its pin**; nobody bumps to a SHA whose boundary they have not yet adopted.

Nothing in production changes when core lands, because nothing consumes core until it bumps. That is what makes a core-first landing safe here, and it is the only reason it is safe — on a released package it would not be.

## The shared-doc surface that actually changes

Most `BinaryFiles` usage in this repo is local cache, render and export plumbing and is untouched. The shared-document boundary is small:

| Site | Change |
| --- | --- |
| `yjs/schema.ts` — `FILES` root, `writeFiles`, `readFiles` | Replaced by a reference root: `fileId -> opaque locator string`. |
| `yjs/schema.ts` — `buildSnapshotDoc`, `decodeSnapshot` | Carry references, not bytes. |
| `Scene.ts` — `yFiles`, `setFiles`, `getFiles`, files observer | Become the reference map and its accessors. |
| `Scene.collectGarbage` — orphan file branch | Reclaims unreferenced _references_; asset deletion stays host-side. |
| `App.tsx:4780` `scene.setFiles(addedFiles)` | The single writer. Stores bytes via the adapter, writes the returned locator. |
| `App.tsx:4888` `refreshFilesFromScene` | Merges references without clobbering local bytes; resolves what it lacks. |

`ExcalidrawAPI.getFiles` keeps returning the local `BinaryFiles` cache and does not change shape.

## Consumer cutover, per repo

**core (this repo)** — reference map, adapter seam, GC over references. Lands first on the branch. Does not bump anyone.

**client-web** — the hard one, and the reason a core-only _bump_ is forbidden:

- `useWhiteboardFilesManager` publishes `dataURL` into shared state when upload fails (verified: it promises dataURL-only files can be broadcast, inserts the `dataURL` after failure, and logs "using dataURL fallback"). **Delete it.** On failure the image stays local and pending, and the existing retry state owns it. It is never shared as bytes.
- Remove the mixed `{url, dataURL}` shared record type.
- Supply the adapter: `store` uploads via file-service and returns its opaque id; `resolve` fetches by that id.
- `useCollab.ts` / `ExcalidrawWrapper.tsx` already need the transport port (`onLocalSceneUpdate`, `applyRemoteSceneUpdate`, `encodeSceneAsUpdate`, `encodeSceneStateVector`) — that half is already shipped in core.

**server** — consumes `decode`/`encode` reference views for the clone lifecycle. Its locator rewriting and physical row copy are host-side and do not enter core. Clone/archive encodes carry **fresh lineage by design** (see the contract).

## Order

1. Core boundary + adapter seam + GC over references. _(this repo)_
2. client-web adopts the adapter, deletes the `dataURL` fallback and the mixed type, then bumps its pin.
3. server builds the clone against the reference view, then bumps.
4. Only then T025b + T032 (wire lineage) and T021/T004 (persistence lineage), against the settled shape.

## What must not happen

- No alias, no dual schema, no compatibility path.
- No consumer bumps its pin before completing its own side.
- No `dataURL` reaches shared state on any path, including failure paths.
- No adapter operation beyond `store` and `resolve` without a demonstrated consumer. In particular no `delete`: GC drops references, and host-side asset deletion belongs to the host.
