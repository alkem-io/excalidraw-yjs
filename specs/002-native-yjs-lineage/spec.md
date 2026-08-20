# Feature Specification: Native-Yjs Lineage Preservation (Whiteboard Collaboration & Persistence)

**Sub-spec dir**: `specs/002-native-yjs-lineage/` **Created**: 2026-06-26 **Status**: Draft (specify) — clarify pending **Repo**: `alkem-io/excalidraw-yjs` (`@excalidraw/*`, Excalidraw 0.18.x; native-Yjs core) **Parent epic**: workspace `006-collab-content-unification` (native-Yjs work-stream of `003-unify-collab-yjs`) **Backlog Story**: https://github.com/alkem-io/alkemio/issues/1909 (#1909) — the single ticket for this work (Part 1 = 003 build, Part 2 = 006 complete) **Redesigns the broken seam in**: PR #2 (`split/native-yjs-core`)

> **Repo-local sub-spec — scope guard.** Same treatment as `001`. This document owns the **requirements** — the convergence + lineage safety/liveness properties the collaboration & persistence layer MUST satisfy — and the acceptance scenarios (the enumerated data-loss failure modes a full adversarial review proved). It does **not** specify the implementation model (live-doc encode, `applyUpdateV2` merge, in-place doc GC) — that is `plan.md`. The per-property element-`Y.Map` schema, the fractional `index`, awareness-for-ephemeral, and the v2 codec are **KEPT** (reviewed sound / frozen at the epic level — see `001`); the **lineage handling across the wire + persistence + cold-load** is redesigned, and — added 2026-08-19 — the **write path, origin taxonomy, and history binding** that destroy the same guarantee from inside the editor.

## Context — why this spec exists

A full adversarial review of PR #2 found **4 confirmed defects** (1 CRITICAL, 2 HIGH, 1 MEDIUM) plus a test-coverage regression, all symptoms of **one root cause**: the scene is flattened to plain records and **re-encoded through a throwaway `Y.Doc` (a fresh random `clientID`) at every boundary** — the collaboration wire (INIT seed + 20s resync), persistence (save), and cold-load. This destroys CRDT lineage, so per-element merges collapse to **whole-element last-writer-wins on a random `clientID` tiebreak**. Measured on yjs 13.6.31 (2000-trial Monte-Carlo): a concurrent per-property edit is **lost ~50.1%** of the time and a deletion is **resurrected ~49.9%** of the time on every resync. The value-level `mergeStoredElements`, the `versionHighWater` reseed, and the `updated`-timeout are all **patches for this self-inflicted lineage loss**; they cannot converge because the foundation regenerates the defect class (the 12-after-"clean" pattern).

The native-Yjs invariant the epic is built on — _"the editor's element store IS one logical `Y.Doc`"_ — requires the doc's CRDT lineage be preserved **end to end**: the bytes on the wire, the bytes in storage, and the bytes a cold-loading peer adopts must all carry the **same Yjs lineage**, so Yjs's own per-property merge holds for **every** replica regardless of how it joined. This spec states that as testable safety/liveness requirements so the seam can be rebuilt correct-by-construction and gated by a deterministic **N-replica convergence suite** (plus the re-enabled multiplayer-undo tests the PR disabled).

### Widened 2026-08-19 — a second root cause, inside the editor

A second full adversarial review (max effort, `origin/main...HEAD`, 36 commits / 452 files, 15 findings with executed repros) **corroborated the above from four independent angles** — and found that fixing it is **not sufficient**. A distinct class destroys per-property merge _before the bytes ever reach a boundary_:

- **The write path flushes whole elements.** `Scene.mutateElement` calls `writeChangedKeys(ymap, element)`, which iterates `Object.keys(element)` — the entire object — and writes back every key differing from the doc. The caller's `updates` intent set is discarded, though bare `mutateElement` tracks `didChange` per key one layer down. A write through a reference held across a frame therefore reverts a peer's concurrent edit to a _different_ property, with the doc's lineage perfectly intact. This is the root of the class `b2f708f5` patched with the `freshMap.get(id) ?? element` idiom copy-pasted at **32 sites across 14 files** — each a symptom, each future call site a latent instance. _[R2-#1]_
- **History is no longer in lockstep with the doc.** The remote-apply path lost `captureUpdate: NEVER`, so a peer's change leaks into the next capturing local increment and `History.undoStack` desynchronises from the Yjs `UndoManager` stack — one Ctrl+Z pops the wrong StackItem and tombstones the user's own shape. _[R2-#4]_ Separately `meta.version` is written unconditionally (the adjacent `versionHighWater` write IS guarded), driving `version` **backwards** so the Store's `prev.version < next.version` gate silently discards a real edit. _[R2-#5]_
- **The origin taxonomy is asymmetric.** `replaceAllElements` Pass 1 writes a content-bearing `isDeleted:true` tombstone under `STRUCTURAL_ORIGIN` while the paired reveal lands separately, so a consumer filtering per transaction can deliver the tombstone and drop the reveal — peers then hold invisible elements until the next resync. **Resolved** by the logical-mutation boundary: the prelude and its reveal are buffered and emitted as ONE update. _[R2-#2]_ _[R2-#10]_

**Why this matters for scope**: R2-#1, #4 and #5 are precisely what `describe.skip("multiplayer undo/redo")` used to cover. They are not new regressions — they are regressions the skipped tests stopped reporting. Since FR-008 re-enables exactly those 34 tests as a gate, the original plan would have gone RED in Phase 1 for reasons **nowhere in its FR list**, and INV-CONVERGE could not have gone green. Hence FR-009..FR-015 below.

## Clarifications

### Session 2026-06-26 (resolved by analysis — the lineage redesign dissolves most of them)

- **D1 (was OPEN-4) — `mergeStoredElements` is DELETED**, superseded by native `applyUpdateV2` concurrent-save merge over preserved lineage. The value-merge, and the `updated`-timeout expiry that fed it, existed _only_ to survive lineage loss. The `versionHighWater` reseed survives **only** for the editor-Store reappearance fix (US5/[3]); the `updated`-timeout merge is removed.
- **D2 (was OPEN-3) — the cold-load lineage race dissolves.** Cold-load and INIT both adopt the SAME persisted/peer bytes via `applyUpdateV2`/`applyUpdate` _into_ the live doc, so every replica inherits **those bytes' lineage**. Element ids are random (nanoid) ⇒ two replicas never independently mint the same id ⇒ no disjoint-lineage-same-id collision survives once re-encoding stops. INV-CONVERGE holds for every replica with no separate deterministic-`clientID` mechanism. (Documented residual, out of scope: a never-persisted doc edited offline by two peers before any sync — an astronomically unlikely id collision.)
- **D3 (was OPEN-1) — GC / growth bound.** A deletion is an `isDeleted` record in the real lineage-preserving doc (no manual timeout merge). Baseline growth is bounded by Yjs `gc:true` (delete-set content GC) + `encodeStateAsUpdateV2` state compaction. Over-timeout tombstones **and** their orphaned asset references are reclaimed by an in-place GC pass under `STRUCTURAL_ORIGIN` — untracked by undo, so a sweep cannot be undone into resurrecting reclaimed content, yet still published so peers reclaim too (it propagates as an ordinary CRDT deletion → converges). Gated by `DELETED_ELEMENT_TIMEOUT`, with age read from the `elementDeletions` sidecar. This closes finding [2] with a **live mechanism**, not a dead check on stripped metadata.
- **D4 (was OPEN-2) — orphan-reference privacy.** A deleted image's asset REFERENCE is removed from the document in-place by the same GC pass once the element is over-timeout and **no SURVIVING element references the file** — counting live elements AND retained tombstones, because a soft-deleted image inside its grace window is still undoable and restoring it without a way to reach its bytes would be a broken undo. Timeout-gated, so a concurrent re-reference inside the window keeps the reference; converges. The sweep removes a REFERENCE from the document and never deletes bytes — those live in the host's asset store, whose lifecycle the host owns.

### Session 2026-08-19 (the widening — resolved by analysis of the R2 findings)

- **D5 — intent, not diff, is the unit of a write.** `writeChangedKeys` gains an explicit key set: the caller states WHICH keys it is changing, and no key outside that set is ever written. This is strictly stronger than re-reading before the diff (the `freshMap.get(id) ?? element` bandaid), because it holds even when the caller's element is arbitrarily stale — the state every one of the 32 patched sites was working around. Those 36 band-aids are then **deletable**, and their deletion is part of the acceptance for FR-009.
- **D6 — one origin taxonomy, one filter, asserted exhaustively.** Rather than patching each filter, the origins become a closed set with a single declared wire-policy per origin (`LOCAL`=tracked+published, `REMOTE`=applied, never echoed, `STRUCTURAL`=untracked+published, paired with its reveal). The policy has exactly ONE implementation, in `Scene.onDocUpdate`; the bundled collaboration client delegates to it and holds no filter of its own. INV-ORIGIN enumerates every origin × every write path — so a new origin cannot be added without a policy.
- **D7 — the undo boundary is the doc, not React state.** An appState undo MUST write the reverted value back to `yAppState`; rewinding React state alone is silently re-reverted by the read-only mirror on the next scene update, and peers never observe the undo at all. _[R2-#7]_
- **D8 (SETTLED — T023) — binaries never traverse the socket.** Originally open: `yFiles` stored whole `BinaryFileData` records including `dataURL` under `LOCAL_ORIGIN`, so a pasted image was broadcast and a raw full-state encode carried every live binary (measured: a 4096-byte payload appeared verbatim in the encoded update). It could NOT be fixed by excluding `yFiles` deltas from a broadcast — Yjs encodes the whole document, and omitting root structs from a full-state update risks receiver clock gaps. Resolved at the root instead: the document carries `fileId -> opaque locator` and never bytes; locators are validated on every encode (data-URLs and over-long values rejected); bytes live in the local cache and the host's asset store behind an `AssetAdapter`. INV-NO-BINARY-WIRE holds by construction for protocol-compliant writers.

## User Scenarios & Testing _(mandatory)_

> "Users" = the **collaborators** whose edits must never be silently lost or resurrected, and the **operator** relying on bounded storage. Each story is a convergence/lineage **outcome**, independently testable with in-process N-replica `Y.Doc`s (no backend), and proven non-vacuous (fails on the pre-redesign code).

### User Story 1 — Concurrent per-property edits survive a full resync (Priority: P1)

Two people edit the same shape at once — one drags it (position), the other recolors it (`strokeColor`) — and the periodic full-scene resync fires. **Both** changes persist on every client.

**Why P1**: This is the headline guarantee of the whole native-Yjs epic, defeated today by the resync clobber (~50% loss). Whole-element LWW loses one of the two edits; per-property lineage loses neither.

**Independent Test**: N in-process docs sharing seeded lineage; apply a position change on A and a `strokeColor` change on B while partitioned; trigger a full resync from A; exchange updates; assert every replica shows the new position **and** the new color, byte-identical. (Realized by the re-enabled multiplayer-undo block + a new N-replica fuzz property test.)

**Invariant INV-CONVERGE**: ∀ sequences of concurrent ops across N replicas interleaved with arbitrary full-resyncs/INITs, after all updates are exchanged every replica agrees on canonical CONTENT (id/x/y/isDeleted fingerprints), with **zero lost edits** and **zero resurrected deletions**. Not Yjs byte equality: replicas legitimately differ in byte layout — integration order, pending-struct packing and GC state all vary — so byte equality is neither necessary nor achievable, and asserting it would fail on correct implementations.

### User Story 2 — A deletion is never resurrected by a resync or a join (Priority: P1)

An element deleted on one replica must not be brought back by a resync, an INIT seed, or a late peer joining.

**Why P1**: Deletion-resurrection is the dual of lost-edit; both stem from the same disjoint-lineage LWW, and a reappearing-after-delete shape is as corrupting as a lost edit.

**Independent Test**: delete on A; resync/INIT from B (which still holds it) into A under every ordering; assert the element stays deleted on all replicas.

**Invariant INV-NO-RESURRECT**: a deletion, once observed by a replica, remains deleted under any resync / INIT / cold-load ordering.

### User Story 3 — Concurrent saves merge per-property, no lost update (Priority: P1)

Two replicas save to storage concurrently. The stored document reflects **both** edits per-property — not whole-element LWW — with no lost update and no resurrected deletion.

**Why P1**: The persistence path destroys lineage exactly like the wire; a concurrent save is the same hazard at the storage boundary (the reason `mergeStoredElements` was bolted on).

**Independent Test**: two replicas over shared lineage each make a disjoint-property edit, save concurrently (read-merge-write); assert the stored doc, decoded, carries both edits; assert order-independence and idempotency.

**Invariant INV-PERSIST-MERGE**: `save(A) ∥ save(B)` over shared lineage ⇒ stored == native per-property merge of A and B; order-independent and idempotent; no value-level whole-element fallback.

### User Story 4 — Cold-load and INIT-seed yield mergeable lineage (Priority: P1)

A peer that cold-loads from storage and a peer seeded by INIT from another peer both end up able to per-property-merge with the rest of the room — because both derive from the **same persisted bytes' lineage**.

**Why P1**: If cold-load mints fresh lineage (today's `decodeSnapshot` → records → rebuilt doc), a cold-loaded replica collides whole-element with an INIT-seeded one even after the wire/persistence fixes. Lineage must be preserved _on adoption_, not just in transit.

**Independent Test**: persist a doc; replica X adopts it via cold-load, replica Y via INIT from a live peer; both make disjoint-property edits; exchange; assert per-property convergence (no whole-element collision between X and Y).

**Invariant INV-COLD-LOAD-LINEAGE**: store→load adopts bytes preserving lineage (`applyUpdateV2` into the live doc, not flatten-and-rebuild), so any two replicas share mergeable lineage however they joined.

### User Story 5 — An element restored after a structural removal reappears in the editor (Priority: P2)

A tracked subset-replace drops an element, then undo restores it; the editor's Store re-detects it as alive (the reconstruction version strictly out-versions the synthesized tombstone). _(Fixes review finding [3].)_

**Why P2**: Narrow trigger (programmatic subset replace + undo, not the normal user delete), but it is a latent bug in the safety mechanism itself — the `+1` reseed ties the Store's `V+1` tombstone, and `V+1 < V+1` is false.

**Independent Test**: drive a tracked `replaceAllElements(subset)` that omits an id at the high-water version, then restore; assert the Store re-detects the element as a live change.

**Invariant INV-REVEAL**: the reconstruction version for a reappearing id strictly exceeds the Store's last synthesized tombstone version for that id.

### User Story 6 — Deleted content and orphan asset references are bounded, not immortal (Priority: P2)

Over-timeout tombstones and orphaned asset references are actually reclaimed; a deleted image's reference is not re-broadcast to every joiner forever. _(Fixes review finding [2].)_

**Why P2**: A privacy + unbounded-growth guarantee. The original defect was that the expiry check read `updated`, which the doc strips, so it was dead code and tombstones were immortal, re-broadcast on every load. Age now comes from the `elementDeletions` sidecar, written atomically with the `isDeleted` flip, and the sweep is an explicit maintenance call run before each full-state encode.

**Independent Test**: delete an image element; advance past the timeout; run the reclamation; assert the asset reference and over-timeout tombstone are gone from what a joiner receives, and store size does not grow monotonically under repeated delete/save churn.

**Invariant INV-BOUNDED**: reclamation is driven by data that survives the encode (not a stripped field); storage does not grow monotonically across save cycles under churn; an over-timeout deleted element's asset REFERENCE is not transmitted to new joiners. Bytes cannot be transmitted in any case — they never enter the document (T023) — so what the sweep reclaims is the locator, never storage.

### User Story 7 — The save-skip cache is correct post-cutover (Priority: P3)

No perpetual redundant saves; no false "already saved" skip of a genuinely-needed save. _(Fixes review finding [4].)_

**Why P3**: Efficiency + a narrow latent data-skip; not corruption, but it re-fires full read-decrypt-merge-encrypt-write transactions needlessly and can skip a real save for a freshly-loaded untouched scene.

**Independent Test**: save; assert a subsequent unchanged check reports "saved" (no redundant write); make one edit; assert it reports "not saved" (write fires); construct the freshly-loaded-untouched case and assert it does not false-skip a needed save.

**Invariant INV-SAVE-SKIP**: `isSaved ⇔ the live doc state equals the last stored state`, compared on a signal that survives the v2 cutover (not a sum of stripped `version`s).

### User Story 8 — A local edit never clobbers a peer's edit to a different property (Priority: P1)

Two people edit the same shape at once. One of them is mid-drag, so the editor is holding a reference to that element captured a frame ago. Neither edit is lost.

**Why P1**: This is US1's guarantee at the layer _below_ it. US1 fails at the resync boundary; this fails on every single write, with no boundary involved. Fixing the wire and leaving this in place still loses ~half of concurrent per-property edits.

**Independent Test**: two Scenes over shared lineage; B edits `strokeColor`; A edits `x` through a reference captured BEFORE B's change arrived; assert both replicas end with A's `x` and B's `strokeColor`. Repeat with `updates` touching a JSON-leaf key (`points`) and a nested key (`boundElements`).

**Invariant INV-WRITE-INTENT**: a doc write modifies exactly the keys the caller declared in `updates` (plus the reconciliation metadata) — never a key that merely differs between the caller's element and the doc, however stale that element is.

### User Story 9 — Undo/redo stays in lockstep while collaborating (Priority: P1)

A peer's edit arrives between two of my gestures. My next Ctrl+Z undoes _my_ last action — not someone else's, and not an action two steps back.

**Why P1**: The failure tombstones the user's own work and leaves every later undo/redo off by one. It is also, with US8, what the 34 disabled tests covered — so FR-008's gate cannot pass without it.

**Independent Test**: draw, apply a peer update via `Y.applyUpdate(doc, u, REMOTE_ORIGIN)`, deselect; assert `History.undoStack` entries and `scene.undoManager.undoStack.length` stay in lockstep (control run without the peer update gives the same depths); assert one undo reverts only the local gesture. Plus: assert a purely passive remote edit does not wipe the local redo branch.

**Invariant INV-HISTORY-LOCKSTEP**: a peer's change is never something this user can undo. Stated behaviourally, because `History` and the `UndoManager` legitimately hold different numbers of entries — an appState-only step creates a `History` entry with `hasElementChange: false` and no `UndoManager` item — so equal stack depths is NOT the contract and asserting it would fail for a correct editor. The three requirements are: (1) a remote apply adds no locally undoable step; (2) after a remote apply, the next local undo affects only the intended local action and both replicas converge; (3) appState-only local history stays locally undoable without requiring an element `UndoManager` item.

**Invariant INV-VERSION-MONOTONIC**: an element's stored `meta.version` never decreases; a write whose scratch version is behind the doc's does not regress it, and the Store never discards a write that genuinely changed the doc.

### User Story 10 — Every doc write reaches peers exactly when it should (Priority: P1)

A structural add is either fully visible to peers or not sent at all — never a content-bearing tombstone with the reveal withheld. A destructive local reset is never broadcast.

**Why P1**: an asymmetric taxonomy ships peers invisible elements carrying full content, and a local reset that reaches the shared document ships them a room-wide wipe. Both are silent until the next resync.

**Independent Test**: table-driven over {origin} × {write path}; for each, assert the broadcast decision matches the declared policy. Specifically: a `captureUpdate: NEVER` scene update introducing new ids leaves no peer holding an invisible element; a local reset through `App.replaceSceneGeneration` broadcasts nothing.

**Invariant INV-ORIGIN**: the set of origins broadcast is exactly the declared wire-policy set, identically in every consumer; a tombstone and its paired reveal are either both broadcast or both withheld.

### User Story 11 — Image binaries never traverse the collaboration socket (Priority: P1)

Pasting a large image into a room works, and does not disconnect anyone.

**Why P1**: User-visible today and independent of the CRDT work — the frame exceeds socket.io's default `maxHttpBufferSize`, so the image never reaches peers even though the out-of-band upload succeeded, and every peer that later fetches it re-broadcasts the whole binary again.

**Independent Test**: paste a multi-MB image while in a room; assert no broadcast frame contains image bytes — the document holds only a bounded `fileId -> locator`, validated on every encode — and that no frame exceeds a declared size ceiling; assert peers still receive the element and resolve the bytes out-of-band through the asset adapter.

**Invariant INV-NO-BINARY-WIRE**: no file binary is ever included in a collaboration broadcast, on any path, for any origin.

### User Story 12 — One bad update cannot stop the room converging (Priority: P2)

A corrupt, truncated, or wrong-format update from any room member is contained: that update is rejected, and the session keeps converging.

**Why P2**: Not a data-loss default, but the blast radius is the whole session and any member can trigger it — `Y.applyUpdate` on peer bytes is unguarded, so the throw escapes an async socket handler as an unhandled rejection and every subsequent message hits the same throw.

**Independent Test**: feed truncated bytes, a v2-encoded payload on the v1 path, and a non-array payload; assert each is rejected without throwing out of the handler, the doc is not left partially integrated, and a subsequent valid update still applies.

**Invariant INV-WIRE-ROBUST**: applying an invalid remote update leaves the doc unchanged and the session live.

### User Story 13 — Undoing a background/name change actually undoes it (Priority: P2)

Ctrl+Z after changing the canvas background restores the previous colour — permanently, and for peers.

**Why P2**: Narrower than element loss, but it is a _silent self-reverting_ undo: the value returns on the next scene update, peers never see the undo, and every save persists the un-undone value.

**Independent Test**: change background, undo, then trigger any subsequent scene update; assert React state AND `yAppState` both hold the pre-change value. Same for the project `name`.

**Invariant INV-APPSTATE-UNDO**: an appState undo/redo writes through to `yAppState`, so the doc and React state agree after any subsequent scene update.

## Requirements _(mandatory)_

- **FR-001** The collaboration wire (INIT seed + periodic resync) MUST transmit the live document's actual Yjs state (lineage-preserving), never a re-encoded throwaway snapshot. _[fixes #1]_
- **FR-002** A received full-state update MUST be a genuinely idempotent, lineage-preserving merge on the receiver — applying it (or re-applying state the receiver already holds) loses nothing and clobbers nothing. _[#1]_
- **FR-003** Persistence MUST store the live document's Yjs state preserving lineage; a concurrent save MUST merge the prior stored state into the live doc via Yjs's native update merge (per-property), not a value-level whole-element merge. _[#1 root — supersedes `mergeStoredElements`]_
- **FR-004** Cold-load MUST adopt stored bytes preserving lineage (`applyUpdateV2` into the live doc), so every replica — however it joined — shares mergeable lineage. _[#1 root]_
- **FR-005** The editor Store MUST re-detect an element that reappears after a structural removal (the reconstruction version strictly out-versions the synthesized tombstone). _[#3]_
- **FR-006** Deleted-content + orphaned-binary reclamation MUST be driven by data that survives the encode (no dead check on stripped metadata) and MUST bound storage growth under churn; a deleted image's binary MUST NOT be re-broadcast to new joiners indefinitely. _[#2]_
- **FR-007** The save-skip optimization MUST be correct post-cutover: no perpetual redundant saves and no false-skip of a needed save. _[#4]_
- **FR-008 (tests)** The disabled multiplayer-undo test block MUST be re-enabled and pass; a new N-replica convergence property test MUST gate INV-CONVERGE + INV-NO-RESURRECT; the whole suite MUST be non-vacuous (each invariant test fails on the pre-redesign code).
- **FR-009** A doc write MUST be scoped to the caller's declared intent keys; no key outside that set may be written, regardless of how stale the caller's element is. The 36 `freshMap.get(id) ?? element` re-read bandaids MUST be removed as part of this. _[R2-#1]_
- **FR-010** A remote apply MUST contribute no entry to the editor's history and MUST NOT wipe the local redo branch; `History.undoStack` and the `UndoManager` stack MUST stay in lockstep under any interleaving. _[R2-#4]_
- **FR-011** An element's `meta.version` MUST NOT regress, and the Store MUST NOT discard a write that genuinely changed the doc. _[R2-#5]_ **STATUS: partially implemented — the `mutateElement` path is done (T014); the `replaceAllElements` bulk path is NOT (T014b).** Independent review established that no Store-local patch can close the bulk path without moving version values that `Store.detectChangedElements`, `ElementsDelta.calculate` (which requires `deleted.version !== inserted.version`) and the bounds/collision caches all depend on — because `element.version` currently serves as both exact history data and the universal dirty token. Closing it properly needs a separate monotonic scene revision token, which is its own piece of work. **FR-011 must be treated as incomplete until T014b lands; do not read a green suite as satisfying it.**
- **FR-012** Every doc origin MUST have one declared wire policy, applied identically by every broadcast consumer; a structural tombstone and its paired reveal MUST share a broadcast decision. _[R2-#2, R2-#10]_
- **FR-013** File binaries MUST NOT be included in any collaboration broadcast on any path. _[R2-#6]_
- **FR-014** An invalid remote update MUST NOT leave the editor operating on a partially-applied document. Yjs apply is not atomic on a decode failure, so rejection alone is insufficient: recovery MUST discard the affected Scene generation and resync, and MUST be owned by the transport that owns the session. _[R2-#11]_
- **FR-015** An appState undo/redo MUST write the reverted value back to `yAppState`. _[R2-#7]_
- **FR-017** One logical mutation MUST reach peers as ONE transport message. A creation commits two Yjs transactions (the structural prelude and its reveal), so the boundary buffers the exact update bytes Yjs emits while it is open, merges them with `Y.mergeUpdates`, and dispatches once. The emitted bytes are buffered rather than a delta recomputed from a pre-mutation state vector, because a state vector tracks inserted struct clocks and not delete-set advancement, so a recomputed delta silently drops deletions.
- **FR-016** Applying an ordinary `ActionResult` MUST NOT use the authoritative whole-set reconcile path. It MUST apply the action's **intent** — added/deleted membership plus changed keys — against the **current** doc, so unrelated keys and ids that changed while the action ran survive. `replaceAllElements` keeps its authoritative "doc = this set" contract for its legitimate callers (load / import / explicit full reconcile — a local reset is NOT among them: it replaces the Scene generation rather than writing to the shared document); `App.syncActionResult` stops being one of them. _[found while re-scoping T016]_
  - The action's **base snapshot must be captured at invocation and be a real copy** — `Scene.mutateElement` mutates the passed scratch before re-derivation, so a bare element-array reference is not a stable "before" image.
  - `ActionFn` may be **async**, so `ActionManager` must preserve that snapshot alongside the promise. Confirmed live instance: `actionCopyElementLink.perform` is async and returns its invocation-time `elements` on both the fallback and `catch` paths, so a remote apply landing during the `await` is reverted wholesale. No helper-site re-read can fix this class. Audit list of async element-returning actions: `actionElementLink.ts`, `actionClipboard.tsx`, `actionExport.tsx`.
  - **Atomicity is a LOGICAL boundary, not a single Yjs transaction.** Creating an element requires two local transactions under two origins, and that shape is load-bearing for UNDO: a `LOCAL` structural add lets `UndoManager` hard-remove the element on undo (losing the tombstone/content/binding identity), while a wholly `STRUCTURAL` create is not undoable at all — and Yjs cannot give nested parts of one transaction different origins. The invariant is therefore: **one logical `ActionResult` ⇒ at most one tracked transaction / UndoManager item, one recompute-visible local commit, one broadcast, and one remote apply**, with a narrowly-scoped untracked structural prelude for genuinely new ids. Actions with no additions keep the stronger single-transaction path.
  - An id classified "added" against the base **may already exist in the current doc** via an interleaved remote update. It MUST NOT be structurally replaced — either reject/remap the collision or treat it as existing and apply only the declared intent. Whole-record replacement would recreate the stale-overwrite class this FR exists to remove.
  - Index repairs MUST be computed before mutation and carried explicitly in the patch. Running a broad `syncInvalidIndices` over the current scene as a side effect of application would reintroduce undeclared writes.
  - A base→result **diff is a sound migration default but is NOT the definition of intent**: "explicitly set key to the value it already had in base" is invisible to a diff yet must still beat an interleaved remote write — the same asymmetry FR-009 fixed one layer down. The durable contract should let an `ActionResult` carry explicit per-id key sets plus membership intent, deriving it only for synchronous actions in the interim.

## Success Criteria _(mandatory)_

- **SC-001** INV-CONVERGE + INV-NO-RESURRECT proven by a non-vacuous N-replica property test over the path the app actually uses. **SATISFIED**: the Scene-level property gate exists and is sharp (all seeds fail when the Scene encoder is made to rebuild through a throwaway `clientID`), and the app's INIT/resync no longer rebuilds — `encodeSyncableSceneAsUpdate` is deleted and the producer encodes the live document (T032), with its own pins including the concurrent per-property loss a rebuild causes.
- **SC-002** The 34-test `multiplayer undo/redo` block (`history.test.tsx`) is re-enabled and green, and the removed `collab.test.tsx` cases are restored and green.
- **SC-003** A full adversarial re-review of the redesigned seam returns **ZERO findings of any kind** — defects AND observations. _(the done-gate)_
- **SC-004** `pnpm run test:typecheck`, lint (`--max-warnings=0`), and all touched suites green.
- **SC-005** INV-WRITE-INTENT proven non-vacuous, and the stale-read band-aids retired where a test discriminates. **Corrected**: the census found **36** `freshMap.get(id) ?? element` sites, not 32, of which **2 are removed** — `actionFlip`'s post-flip reread and `actionBoundText`'s wrap reread, each proven by a failing production test. A raw count is NOT the metric: a semantic difference is not an observable defect, and two measured sites can still be deleted with the suite green. Each remaining site is retired only when a test fails on its return; `align:83` / `distribute:77` were never invoked and are recorded as unknown, not clean.
- **SC-006** INV-HISTORY-LOCKSTEP + INV-VERSION-MONOTONIC green, and SC-002's re-enabled block passes **because** of them, not around them.
- **SC-007** INV-ORIGIN's origin × write-path table is exhaustive: adding an origin without a declared policy fails the suite.

## Out of scope / explicitly KEPT

- The per-property element-`Y.Map` schema, the fractional `index`, awareness-for-ephemeral routing, and the v2 codec — **KEPT** (reviewed sound; `001`).
- `buildSnapshotDoc` is **retained only for a deliberate export / GC-checkpoint**, never on the hot wire / persistence / cold-load paths.
- **Deferred, tracked, NOT fixed here** (R2 findings that are real but not convergence defects): `recomputeFromDoc` re-materialising every element on every transaction, so the identity-keyed render caches miss scene-wide (R2-#9 — a performance defect, and the biggest one, but it cannot lose data); `addMissingFiles(replace)` being defeated by the files mirror (R2-#12); the `cloneJSON` compare asymmetry re-writing `undefined`/`NaN` JSON-leaf keys forever; the undeclared `yjs` dependency on the published package (R2-#15 — changes the published dependency contract, needs a product call). Each keeps its own follow-up; none gates this spec.

## Assumptions

- All four prior open questions are **resolved in Clarifications (D1–D4)** by analysis of the lineage-preserving model — none required a product trade-off the redesign didn't settle. The one with the widest blast radius, the cold-load race (D2), _dissolves_ because `applyUpdateV2` adoption makes every replica inherit the persisted bytes' lineage and random ids preclude independent same-id creation; flagged here so it can be vetoed if a fully-deterministic-lineage guarantee is wanted in-scope instead of documented-and-bounded.
- The live `Y.Doc` is constructed with `gc:true` (D3). If a benchmark later shows tombstone/delete-set growth is material despite compaction + in-place GC, a coordinated snapshot-reload checkpoint is a follow-up — not a correctness gap for this spec.
