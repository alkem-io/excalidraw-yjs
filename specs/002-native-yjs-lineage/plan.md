# Implementation Plan: Native-Yjs Lineage Preservation

**Spec**: [spec.md](./spec.md) · **Created**: 2026-06-26 · **Status**: Plan (pre-tasks)

## Summary

The four review defects are one root cause: the scene is flattened to records and re-encoded through a **throwaway `Y.Doc`** (`buildSnapshotDoc` → fresh random `clientID`) on the wire, in persistence, and on cold-load — collapsing per-property CRDT merge to whole-element LWW. **Proven** (yjs 13.6.31, `/tmp/lineage-probe.cjs`): throwaway re-encode = per-property merge **0/2000**; live-doc-state encode = **2000/2000, zero loss**.

**Key leverage:** the `Scene` ALREADY has the correct lineage-preserving primitives — `encodeAsUpdate()` (Scene.ts:1054, live-doc `encodeStateAsUpdate(this.doc)`), `applyRemoteUpdate()` (1037, v1+v2 into `this.doc`), and **doc adoption via `new Scene({ doc })`** (431). The PR's wire/persistence/cold-load paths _bypass_ them through the throwaway detour. So the redesign is mostly **delete the detour + route through the native primitives**, not net-new machinery. The in-doc GC (D3/D4) and the editor-Store reseed (FR-005) are the only genuinely new code.

## Architecture — FR → mechanism (grounded in current line numbers)

| FR | Defect | Mechanism | Touches |
| --- | --- | --- | --- |
| FR-001/002 | [1] wire clobber | `Collab.encodeSceneAsUpdate()` → `Y.encodeStateAsUpdate(getSceneDoc())` (live state, lineage-preserving). Delete `encodeSyncableSceneAsUpdate` from the wire. Receiver (`applyRemoteSceneUpdate`→`applyUpdate(...,REMOTE_ORIGIN)`) is already correct. INIT + resync converge by construction. | Collab.tsx:1118, Portal.tsx:160/178, data/index.ts:122 |
| FR-003 | [1] persist clobber | `encryptScene`: merge prior + live via `applyUpdateV2` into a scratch doc over **shared lineage** (per-property), encode that. DELETE `mergeStoredElements` + `isExpiredTombstone`. (firebase.ts already documents the `applyUpdateV2`-fold it deliberately avoided _because_ lineage was disjoint — now it isn't.) | firebase.ts:162–265 |
| FR-004 | [1] cold-load lineage | Cold-load adopts stored bytes via `applyUpdateV2` into the Scene doc (`new Scene({ doc })` at 431, or `applyRemoteUpdate`), NOT decode→records→rebuild. Every replica inherits the stored bytes' lineage ⇒ mergeable with INIT-seeded peers (D2). | firebase.ts:474 loadFromFirebase, Scene.ts:431 adoption, Collab init |
| FR-005 | [3] reveal | On reseed of a reappeared id, advance `versionHighWater` so the seed STRICTLY out-versions the Store's synthesized tombstone (`prev.version+1`); `+1` ties (`V+1 < V+1` false). Seed `version = (versionHighWater += 2)` and assert via INV-REVEAL. | Scene.ts:919 |
| FR-006 | [2] immortal tombstones + binaries | In-place GC pass: for `isDeleted` elements past `DELETED_ELEMENT_TIMEOUT`, `yElements.delete(id)` under `LOCAL_ORIGIN`; drop `yFiles` entries no live element references. Propagates as ordinary CRDT deletions → converges. Replaces the dead `updated`-timeout check. `gc:true` (Yjs default) + v2 state compaction bound the rest. | Scene.ts (new gcPass), schema.ts |
| FR-007 | [4] save-skip | Replace `getSceneVersion`-sum cache (sums stripped `version`) with a `dirtySinceLastSave` flag: the LOCAL_ORIGIN doc-update observer sets it, a successful save clears it. `isSaved ⇔ !dirty`. | firebase.ts:306–326, Scene/Collab dirty wiring |
| FR-008 | test regression | Re-enable `describe.skip("multiplayer undo/redo")` (history.test.tsx:2218, 34 tests); restore removed collab.test.tsx cases; add the INV-CONVERGE N-replica property test (seeded from the probe) + per-FR invariant tests; each proven non-vacuous (fails on pre-redesign code). | tests |

**`buildSnapshotDoc` / `decodeSnapshot` survive ONLY for deliberate export / a future GC-checkpoint** — removed from wire/persistence/cold-load.

## Invariant suite (the deterministic gate)

Authored RED against current HEAD first (proving non-vacuity + reproducing the defects), driven green:

- **INV-CONVERGE / INV-NO-RESURRECT** — N-replica property test: random op-sequences (edit-prop, delete, re-add, concurrent) across N in-process Scenes interleaved with INIT/resync; assert byte-equal convergence, zero lost edits, zero resurrected deletions. RED on HEAD (the probe shows 0/2000), GREEN after. The headline gate.
- **INV-PERSIST-MERGE** — concurrent `save(A)∥save(B)` over shared lineage ⇒ stored == per-property merge; order-independent, idempotent. RED on HEAD.
- **INV-COLD-LOAD-LINEAGE** — a cold-loaded replica per-property-merges with an INIT-seeded one. RED on HEAD.
- **INV-REVEAL** — reappear-after-structural-removal is re-detected by the Store. RED on HEAD (ties at `V+1`).
- **INV-BOUNDED** — over-timeout tombstone + orphan binary reclaimed; store size non-monotone under churn; deleted-image binary not sent to a joiner. RED on HEAD (dead expiry check).
- **INV-SAVE-SKIP** — `isSaved ⇔ live==stored`; no perpetual redundant save, no false-skip. RED on HEAD.
- **Re-enabled multiplayer-undo block (34)** + restored collab.test.tsx cases.

## Migration strategy

Mirrors the #10 redesign discipline: **suite-first** (author every invariant red against today's code), **single-owner** (one author holds the lineage seam end-to-end — NO parallel-agent edge edits; that is the diagnosed defect source), **edge-by-edge** (each FR keeps the whole suite + typecheck + lint green before the next). Land on the PR #2 branch (`split/native-yjs-core`), superseding the throwaway-detour code (keep + extend its tests).

Order: re-enable the disabled multiplayer block + write INV-CONVERGE (RED) → FR-001/002 wire (the biggest correctness win, flips INV-CONVERGE green) → FR-004 cold-load → FR-003 persist (flips INV-PERSIST-MERGE) → FR-005 reveal → FR-006 GC → FR-007 save-skip → full re-review (SC-003).

## Risks

- **R1 — `applyUpdateV2` fold must be over genuinely shared lineage.** If any path still mints fresh lineage, the fold silently whole-element-LWWs again. Mitigation: INV-COLD-LOAD-LINEAGE + INV-PERSIST-MERGE assert per-property survival across _independently adopted_ replicas, not just same-doc.
- **R2 — In-place GC racing a concurrent re-reference** (un-delete / re-add of a binary inside the timeout window). Mitigation: timeout-gated (only well-aged orphans); GC is a normal CRDT deletion so a concurrent re-add converges; INV-BOUNDED includes a concurrent-re-reference case.
- **R3 — Scene doc-adoption on cold-load** must not double-construct or leak the prior doc. Mitigation: adopt via the existing `options.doc` / `applyRemoteUpdate` path (Scene.ts:431/1037), verified by INV-COLD-LOAD-LINEAGE + the existing destroy()-ordering tests.
- **R4 — `dirty` flag correctness** (must set on LOCAL edits only, clear only on confirmed store write). Mitigation: INV-SAVE-SKIP covers both the redundant-save and false-skip directions.
