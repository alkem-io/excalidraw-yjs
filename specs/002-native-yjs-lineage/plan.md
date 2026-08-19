# Implementation Plan: Native-Yjs Lineage Preservation

**Spec**: [spec.md](./spec.md) · **Created**: 2026-06-26 · **Status**: Plan (widened 2026-08-19 for the R2 write-path class)

## Summary

The four review defects are one root cause: the scene is flattened to records and re-encoded through a **throwaway `Y.Doc`** (`buildSnapshotDoc` → fresh random `clientID`) on the wire, in persistence, and on cold-load — collapsing per-property CRDT merge to whole-element LWW. **Proven** (yjs 13.6.31, `/tmp/lineage-probe.cjs`): throwaway re-encode = per-property merge **0/2000**; live-doc-state encode = **2000/2000, zero loss**.

**Widened 2026-08-19 — a second root cause.** The above is the *boundary* cause. A max-effort re-review found per-property merge is also destroyed **inside the editor**, before any boundary: `Scene.mutateElement` → `writeChangedKeys(ymap, element)` iterates `Object.keys(element)`, so a write through a stale reference rewrites keys a peer just changed, with lineage intact. Fixing every boundary leaves this untouched. Worse, the three defects it produces (write clobber, history desync, version regression) are exactly what the 34 disabled `multiplayer undo/redo` tests covered — the tests FR-008 re-enables as the Phase-1 gate. So the write path must be fixed **first**, or Phase 1 goes RED for reasons this plan never names.

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
| FR-009 | [R2-#1] write clobber | `writeChangedKeys(ymap, element, intentKeys)` — the caller declares WHICH keys it is changing; keys outside the set are never touched. `Scene.mutateElement` passes `Object.keys(updates)`; bare `mutateElement` already computes `didChange` per key, so the set exists one layer down and is currently discarded. Then DELETE the 32 `freshMap.get(id) ?? element` re-read sites the old behaviour forced. | Scene.ts:1450–1455, schema.ts `writeChangedKeys`, mutateElement.ts:139, + 14 files of bandaid removal |
| FR-010 | [R2-#4] history desync | Restore the `captureUpdate: NEVER` semantics the remote-apply path lost: a `REMOTE_ORIGIN` apply must absorb into the Store snapshot without contributing a history entry or clearing the redo branch. | Collab.tsx:967, history.ts, Scene.ts:452 `trackedOrigins` |
| FR-011 | [R2-#5] version regression | Guard the `meta.version` write the same way the adjacent `versionHighWater` write is already guarded — never write a version behind the doc's. | Scene.ts:1459 |
| FR-012 | [R2-#2, #10] origin policy | ONE exported origin→wire-policy table; both `Collab.onDocUpdate` and `Scene.onDocUpdate`/`CollabEngine` derive from it instead of hand-rolling filters. Pair the structural tombstone with its reveal so they share a broadcast decision. | Collab.tsx:689, Scene.ts:693/1091, CollabEngine.ts:84 |
| FR-013 | [R2-#6] binaries on the wire | Exclude `yFiles` deltas from broadcast structurally (not by origin), making `CollabEngine`'s "binaries are out-of-band" comment true. | Scene.ts:1124 `setFiles`, Collab.tsx:689, Portal.tsx:139 |
| FR-014 | [R2-#11] unguarded apply | Validate payload shape, then `Y.applyUpdate` inside a try/catch that rejects the update and keeps the session live. | Collab.tsx:745/759/967 |
| FR-015 | [R2-#7] appState undo | The undo path writes the reverted `viewBackgroundColor`/`name` back to `yAppState`; React-state-only rewind is re-reverted by the read-only mirror. | history.ts `perform()`, App.tsx:4782, actionCanvas/actionExport |
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
- **INV-WRITE-INTENT** — a write through a deliberately stale reference touches only the declared keys; a peer's concurrent edit to another property survives. RED on HEAD (whole-object flush). **The new headline gate, below INV-CONVERGE.**
- **INV-HISTORY-LOCKSTEP / INV-VERSION-MONOTONIC** — history depths stay in lockstep across local/remote interleavings; `meta.version` never regresses. RED on HEAD (both have executed repros).
- **INV-ORIGIN** — table-driven over {origin} × {write path}; adding an origin without a declared policy fails. RED on HEAD (asymmetric tombstone/reveal; `CollabEngine` misses EPHEMERAL).
- **INV-NO-BINARY-WIRE** — no broadcast frame ever carries file content. RED on HEAD.
- **INV-WIRE-ROBUST** — truncated / wrong-format / non-array updates are rejected without wedging the session. RED on HEAD (unguarded).
- **INV-APPSTATE-UNDO** — undo of background/name survives the next scene update, on both replicas. RED on HEAD.
- **Re-enabled multiplayer-undo block (34)** + restored collab.test.tsx cases. **Note: this block gates FR-009/010/011, not the wire** — that is why it must come after them.

## Migration strategy

Mirrors the #10 redesign discipline: **suite-first** (author every invariant red against today's code), **single-owner** (one author holds the lineage seam end-to-end — NO parallel-agent edge edits; that is the diagnosed defect source), **edge-by-edge** (each FR keeps the whole suite + typecheck + lint green before the next). Land on the PR #2 branch (`split/native-yjs-core`), superseding the throwaway-detour code (keep + extend its tests).

Order (revised 2026-08-19 — **write path before wire**): re-enable the disabled multiplayer block + write INV-CONVERGE / INV-WRITE-INTENT (RED) → **FR-009 write-path intent keys + FR-011 version guard** (the deepest fix; unblocks deleting 32 bandaids) → **FR-010 history lockstep** (together these three flip the re-enabled 34-test block green) → FR-001/002 wire → FR-004 cold-load → FR-003 persist → **FR-012 origin policy + FR-013 binaries off the wire** → FR-005 reveal → FR-006 GC → FR-007 save-skip → FR-014 robustness → FR-015 appState undo → full re-review (SC-003).

Rationale for the reorder: the wire fix was previously first as "the biggest correctness win", but INV-CONVERGE cannot go green while every local write clobbers whole elements — and the 34 re-enabled tests gate the write path, not the wire. Fixing the write path first also *removes* code (32 bandaids), shrinking the surface every later phase has to keep green.

## Risks

- **R1 — `applyUpdateV2` fold must be over genuinely shared lineage.** If any path still mints fresh lineage, the fold silently whole-element-LWWs again. Mitigation: INV-COLD-LOAD-LINEAGE + INV-PERSIST-MERGE assert per-property survival across _independently adopted_ replicas, not just same-doc.
- **R2 — In-place GC racing a concurrent re-reference** (un-delete / re-add of a binary inside the timeout window). Mitigation: timeout-gated (only well-aged orphans); GC is a normal CRDT deletion so a concurrent re-add converges; INV-BOUNDED includes a concurrent-re-reference case.
- **R3 — Scene doc-adoption on cold-load** must not double-construct or leak the prior doc. Mitigation: adopt via the existing `options.doc` / `applyRemoteUpdate` path (Scene.ts:431/1037), verified by INV-COLD-LOAD-LINEAGE + the existing destroy()-ordering tests.
- **R5 — removing the 32 bandaids could mask an incomplete FR-009.** If any call site relied on the re-read for something other than the whole-object flush, deleting it silently changes behaviour. Mitigation: remove them one file at a time with the full suite green between, and treat any test that only passes WITH a bandaid as evidence FR-009 is incomplete — not as a reason to keep the bandaid.
- **R6 — intent keys must cover side-effecting helpers.** `redrawTextBoundingBox` / `updateBoundElements` / `bindOrUnbind` mutate through their own `mutateElement` calls; each must declare its own intent set or FR-009 leaks. Mitigation: INV-WRITE-INTENT exercises a container+bound-text edit, not just a simple property.
- **R4 — `dirty` flag correctness** (must set on LOCAL edits only, clear only on confirmed store write). Mitigation: INV-SAVE-SKIP covers both the redundant-save and false-skip directions.
