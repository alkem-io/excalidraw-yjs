# Feature Specification: Native-Yjs Lineage Preservation (Whiteboard Collaboration & Persistence)

**Sub-spec dir**: `specs/002-native-yjs-lineage/` **Created**: 2026-06-26 **Status**: Draft (specify) — clarify pending **Repo**: `alkem-io/excalidraw-yjs` (`@excalidraw/*`, Excalidraw 0.18.x; native-Yjs core) **Parent epic**: workspace `006-collab-content-unification` (native-Yjs work-stream of `003-unify-collab-yjs`) **Backlog Story**: https://github.com/alkem-io/alkemio/issues/1909 (#1909) — the single ticket for this work (Part 1 = 003 build, Part 2 = 006 complete) **Redesigns the broken seam in**: PR #2 (`split/native-yjs-core`)

> **Repo-local sub-spec — scope guard.** Same treatment as `001`. This document owns the **requirements** — the convergence + lineage safety/liveness properties the collaboration & persistence layer MUST satisfy — and the acceptance scenarios (the enumerated data-loss failure modes a full adversarial review proved). It does **not** specify the implementation model (live-doc encode, `applyUpdateV2` merge, in-place doc GC) — that is `plan.md`. The per-property element-`Y.Map` schema, the fractional `index`, awareness-for-ephemeral, and the v2 codec are **KEPT** (reviewed sound / frozen at the epic level — see `001`); only the **lineage handling across the wire + persistence + cold-load** is redesigned.

## Context — why this spec exists

A full adversarial review of PR #2 found **4 confirmed defects** (1 CRITICAL, 2 HIGH, 1 MEDIUM) plus a test-coverage regression, all symptoms of **one root cause**: the scene is flattened to plain records and **re-encoded through a throwaway `Y.Doc` (a fresh random `clientID`) at every boundary** — the collaboration wire (INIT seed + 20s resync), persistence (save), and cold-load. This destroys CRDT lineage, so per-element merges collapse to **whole-element last-writer-wins on a random `clientID` tiebreak**. Measured on yjs 13.6.31 (2000-trial Monte-Carlo): a concurrent per-property edit is **lost ~50.1%** of the time and a deletion is **resurrected ~49.9%** of the time on every resync. The value-level `mergeStoredElements`, the `versionHighWater` reseed, and the `updated`-timeout are all **patches for this self-inflicted lineage loss**; they cannot converge because the foundation regenerates the defect class (the 12-after-"clean" pattern).

The native-Yjs invariant the epic is built on — _"the editor's element store IS one logical `Y.Doc`"_ — requires the doc's CRDT lineage be preserved **end to end**: the bytes on the wire, the bytes in storage, and the bytes a cold-loading peer adopts must all carry the **same Yjs lineage**, so Yjs's own per-property merge holds for **every** replica regardless of how it joined. This spec states that as testable safety/liveness requirements so the seam can be rebuilt correct-by-construction and gated by a deterministic **N-replica convergence suite** (plus the re-enabled multiplayer-undo tests the PR disabled).

## Clarifications

### Session 2026-06-26 (resolved by analysis — the lineage redesign dissolves most of them)

- **D1 (was OPEN-4) — `mergeStoredElements` is DELETED**, superseded by native `applyUpdateV2` concurrent-save merge over preserved lineage. The value-merge, and the `updated`-timeout expiry that fed it, existed _only_ to survive lineage loss. The `versionHighWater` reseed survives **only** for the editor-Store reappearance fix (US5/[3]); the `updated`-timeout merge is removed.
- **D2 (was OPEN-3) — the cold-load lineage race dissolves.** Cold-load and INIT both adopt the SAME persisted/peer bytes via `applyUpdateV2`/`applyUpdate` _into_ the live doc, so every replica inherits **those bytes' lineage**. Element ids are random (nanoid) ⇒ two replicas never independently mint the same id ⇒ no disjoint-lineage-same-id collision survives once re-encoding stops. INV-CONVERGE holds for every replica with no separate deterministic-`clientID` mechanism. (Documented residual, out of scope: a never-persisted doc edited offline by two peers before any sync — an astronomically unlikely id collision.)
- **D3 (was OPEN-1) — GC / growth bound.** A deletion is an `isDeleted` record in the real lineage-preserving doc (no manual timeout merge). Baseline growth is bounded by Yjs `gc:true` (delete-set content GC) + `encodeStateAsUpdateV2` state compaction. Over-timeout tombstones **and** their orphaned file binaries are reclaimed by an in-place GC pass under `LOCAL_ORIGIN` (propagates as an ordinary CRDT deletion → converges), gated by `DELETED_ELEMENT_TIMEOUT`. This closes finding [2] with a **live mechanism**, not a dead check on stripped metadata.
- **D4 (was OPEN-2) — orphan-binary privacy.** A deleted image's binary is removed from `yFiles` in-place by the same GC pass once the element is over-timeout and **no live element references the file** (mirrors the old `filterReferencedFiles` intent, now in-doc + lineage-preserving). Timeout-gated, so a concurrent re-reference inside the window keeps the binary; converges.

## User Scenarios & Testing _(mandatory)_

> "Users" = the **collaborators** whose edits must never be silently lost or resurrected, and the **operator** relying on bounded storage. Each story is a convergence/lineage **outcome**, independently testable with in-process N-replica `Y.Doc`s (no backend), and proven non-vacuous (fails on the pre-redesign code).

### User Story 1 — Concurrent per-property edits survive a full resync (Priority: P1)

Two people edit the same shape at once — one drags it (position), the other recolors it (`strokeColor`) — and the periodic full-scene resync fires. **Both** changes persist on every client.

**Why P1**: This is the headline guarantee of the whole native-Yjs epic, defeated today by the resync clobber (~50% loss). Whole-element LWW loses one of the two edits; per-property lineage loses neither.

**Independent Test**: N in-process docs sharing seeded lineage; apply a position change on A and a `strokeColor` change on B while partitioned; trigger a full resync from A; exchange updates; assert every replica shows the new position **and** the new color, byte-identical. (Realized by the re-enabled multiplayer-undo block + a new N-replica fuzz property test.)

**Invariant INV-CONVERGE**: ∀ sequences of concurrent ops across N replicas interleaved with arbitrary full-resyncs/INITs, after all updates are exchanged every replica is byte-equal, with **zero lost edits** and **zero resurrected deletions**.

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

### User Story 6 — Deleted content and orphan binaries are bounded, not immortal (Priority: P2)

Over-timeout tombstones and orphaned image binaries are actually reclaimed; a deleted image's binary is not re-broadcast to every joiner forever. _(Fixes review finding [2].)_

**Why P2**: A privacy + unbounded-growth guarantee. Today the expiry check reads `updated`, which the doc strips, so it is dead code — tombstones are immortal and re-broadcast on every load.

**Independent Test**: delete an image element; advance past the timeout; run the reclamation; assert the binary and over-timeout tombstone are gone from what a joiner receives, and store size does not grow monotonically under repeated delete/save churn.

**Invariant INV-BOUNDED**: reclamation is driven by data that survives the encode (not a stripped field); storage does not grow monotonically across save cycles under churn; an over-timeout deleted element's binary is not transmitted to new joiners.

### User Story 7 — The save-skip cache is correct post-cutover (Priority: P3)

No perpetual redundant saves; no false "already saved" skip of a genuinely-needed save. _(Fixes review finding [4].)_

**Why P3**: Efficiency + a narrow latent data-skip; not corruption, but it re-fires full read-decrypt-merge-encrypt-write transactions needlessly and can skip a real save for a freshly-loaded untouched scene.

**Independent Test**: save; assert a subsequent unchanged check reports "saved" (no redundant write); make one edit; assert it reports "not saved" (write fires); construct the freshly-loaded-untouched case and assert it does not false-skip a needed save.

**Invariant INV-SAVE-SKIP**: `isSaved ⇔ the live doc state equals the last stored state`, compared on a signal that survives the v2 cutover (not a sum of stripped `version`s).

## Requirements _(mandatory)_

- **FR-001** The collaboration wire (INIT seed + periodic resync) MUST transmit the live document's actual Yjs state (lineage-preserving), never a re-encoded throwaway snapshot. _[fixes #1]_
- **FR-002** A received full-state update MUST be a genuinely idempotent, lineage-preserving merge on the receiver — applying it (or re-applying state the receiver already holds) loses nothing and clobbers nothing. _[#1]_
- **FR-003** Persistence MUST store the live document's Yjs state preserving lineage; a concurrent save MUST merge the prior stored state into the live doc via Yjs's native update merge (per-property), not a value-level whole-element merge. _[#1 root — supersedes `mergeStoredElements`]_
- **FR-004** Cold-load MUST adopt stored bytes preserving lineage (`applyUpdateV2` into the live doc), so every replica — however it joined — shares mergeable lineage. _[#1 root]_
- **FR-005** The editor Store MUST re-detect an element that reappears after a structural removal (the reconstruction version strictly out-versions the synthesized tombstone). _[#3]_
- **FR-006** Deleted-content + orphaned-binary reclamation MUST be driven by data that survives the encode (no dead check on stripped metadata) and MUST bound storage growth under churn; a deleted image's binary MUST NOT be re-broadcast to new joiners indefinitely. _[#2]_
- **FR-007** The save-skip optimization MUST be correct post-cutover: no perpetual redundant saves and no false-skip of a needed save. _[#4]_
- **FR-008 (tests)** The disabled multiplayer-undo test block MUST be re-enabled and pass; a new N-replica convergence property test MUST gate INV-CONVERGE + INV-NO-RESURRECT; the whole suite MUST be non-vacuous (each invariant test fails on the pre-redesign code).

## Success Criteria _(mandatory)_

- **SC-001** INV-CONVERGE + INV-NO-RESURRECT proven by a non-vacuous N-replica property test: it FAILS on current HEAD (the throwaway-clientID resync) and PASSES after the redesign.
- **SC-002** The 34-test `multiplayer undo/redo` block (`history.test.tsx`) is re-enabled and green, and the removed `collab.test.tsx` cases are restored and green.
- **SC-003** A full adversarial re-review of the redesigned seam returns **ZERO findings of any kind** — defects AND observations. _(the done-gate)_
- **SC-004** `yarn test:typecheck`, lint (`--max-warnings=0`), and all touched suites green.

## Out of scope / explicitly KEPT

- The per-property element-`Y.Map` schema, the fractional `index`, awareness-for-ephemeral routing, and the v2 codec — **KEPT** (reviewed sound; `001`).
- `buildSnapshotDoc` is **retained only for a deliberate export / GC-checkpoint**, never on the hot wire / persistence / cold-load paths.

## Assumptions

- All four prior open questions are **resolved in Clarifications (D1–D4)** by analysis of the lineage-preserving model — none required a product trade-off the redesign didn't settle. The one with the widest blast radius, the cold-load race (D2), _dissolves_ because `applyUpdateV2` adoption makes every replica inherit the persisted bytes' lineage and random ids preclude independent same-id creation; flagged here so it can be vetoed if a fully-deterministic-lineage guarantee is wanted in-scope instead of documented-and-bounded.
- The live `Y.Doc` is constructed with `gc:true` (D3). If a benchmark later shows tombstone/delete-set growth is material despite compaction + in-place GC, a coordinated snapshot-reload checkpoint is a follow-up — not a correctness gap for this spec.
