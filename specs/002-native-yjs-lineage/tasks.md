# Tasks: Native-Yjs Lineage Preservation

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-06-26 · **Widened**: 2026-08-19 (R2 write-path class)

**Strategy** (plan §Migration): suite-first (author each invariant RED against current HEAD, proving non-vacuity), single-owner (one author holds the lineage seam — no parallel-agent edge edits), edge-by-edge (each FR keeps the whole suite + typecheck + lint green before the next). Land on `split/native-yjs-core`, superseding the throwaway-detour code (commit `96f9bce3`, retained as the RED baseline).

**Revised order (2026-08-19): the write path comes BEFORE the wire.** The 34 re-enabled `multiplayer undo/redo` tests gate FR-009/010/011, not FR-001 — so the original order would have gone RED in Phase 1 for reasons the plan never named. Fixing the write path first also deletes 32 bandaid sites, shrinking what every later phase must keep green.

## Phase 1 — RED suite (the deterministic gate, authored against HEAD first)

- [ ] T001 INV-CONVERGE / INV-NO-RESURRECT N-replica property test (seed from `/tmp/lineage-probe.cjs`, against the real `Scene` wire path). **Expected RED** on HEAD.
- [ ] T002 Re-enable `describe.skip("multiplayer undo/redo")` (history.test.tsx:2218) + restore removed collab.test.tsx cases. Record which fail on HEAD.
- [ ] T003 INV-PERSIST-MERGE (concurrent save merge, order-independent, idempotent). **Expected RED.**
- [ ] T004 INV-COLD-LOAD-LINEAGE (cold-loaded replica per-property-merges with an INIT-seeded one). **Expected RED.**
- [ ] T005 INV-REVEAL (reappear-after-structural-removal re-detected). **Expected RED** (ties at V+1).
- [ ] T006 INV-BOUNDED (over-timeout tombstone + orphan binary reclaimed; non-monotone store; deleted-image binary not sent to joiner). **Expected RED** (dead expiry check).
- [ ] T007 INV-SAVE-SKIP (isSaved ⇔ live==stored; no redundant save, no false-skip). **Expected RED.**
- [ ] T008 INV-WRITE-INTENT (a write through a deliberately stale reference touches only the declared keys; a peer's concurrent edit to another property survives). Cover a simple key, a JSON-leaf (`points`) and a nested one (`boundElements`). **Expected RED** — whole-object flush.
- [ ] T009 INV-HISTORY-LOCKSTEP + INV-VERSION-MONOTONIC (history depths in lockstep across local/remote interleavings; `meta.version` never regresses; a passive remote edit does not wipe the redo branch). **Expected RED.**
- [ ] T010 INV-ORIGIN table-driven over {origin} × {write path}, incl. `captureUpdate: NEVER` introducing new ids, and `resetScene` through `CollabEngine`. **Expected RED.**
- [ ] T011 INV-NO-BINARY-WIRE + INV-WIRE-ROBUST + INV-APPSTATE-UNDO. **Expected RED.**
- [ ] T012 Record the RED baseline + the non-vacuity ledger (each test fails on `96f9bce3` for the named defect). Include the bandaid census: the 32 `freshMap.get(id) ?? element` sites across 14 files, enumerated, as the FR-009 acceptance metric.

## Phase 2 — Write-path intent keys (FR-009, FR-011) — the DEEPEST fix

- [ ] T013 `writeChangedKeys(ymap, element, intentKeys)`; `Scene.mutateElement` passes `Object.keys(updates)`. Thread the per-key `didChange` set that bare `mutateElement` already computes rather than recomputing it. Green **INV-WRITE-INTENT**.
- [ ] T014 Guard the `meta.version` write (mirror the adjacent `versionHighWater` guard). Green **INV-VERSION-MONOTONIC**.
- [ ] T015 Declare intent sets in the side-effecting helpers (`redrawTextBoundingBox`, `updateBoundElements`, `bindOrUnbind`) — see plan R6.
- [ ] T016 Delete the 32 `freshMap.get(id) ?? element` bandaids, ONE FILE AT A TIME with the full suite green between (plan R5). A test that only passes with a bandaid means FR-009 is incomplete — fix FR-009, do not restore the bandaid.

## Phase 3 — History lockstep (FR-010)

- [ ] T017 A `REMOTE_ORIGIN` apply absorbs into the Store snapshot without contributing a history entry or clearing the redo branch. Green **INV-HISTORY-LOCKSTEP** — and with T013/T014, the re-enabled 34-test block from T002.

## Phase 4 — Wire lineage (FR-001/002)

- [ ] T018 `Collab.encodeSceneAsUpdate()` → `Y.encodeStateAsUpdate(getSceneDoc())` (live state). Remove `encodeSyncableSceneAsUpdate` from the wire (INIT seed + resync). Green **INV-CONVERGE / INV-NO-RESURRECT**.
- [ ] T019 Delete `encodeSyncableSceneAsUpdate` (data/index.ts) once unused; confirm Portal INIT/resync both ship live state.

## Phase 5 — Cold-load lineage (FR-004)

- [ ] T020 Cold-load adopts stored bytes via `applyUpdateV2` into the Scene doc (`new Scene({ doc })` / `applyRemoteUpdate`), not decode→records→rebuild. Green **INV-COLD-LOAD-LINEAGE**.

## Phase 6 — Persistence lineage (FR-003)

- [ ] T021 `encryptScene`: `applyUpdateV2`-fold prior + live into a scratch doc over shared lineage, encode that. DELETE `mergeStoredElements` + `isExpiredTombstone`. Green **INV-PERSIST-MERGE**.

## Phase 7 — Origin policy + binaries off the wire (FR-012, FR-013)

- [ ] T022 ONE exported origin→wire-policy table; `Collab.onDocUpdate` and `Scene.onDocUpdate`/`CollabEngine` both derive from it. Pair the structural tombstone with its reveal. Green **INV-ORIGIN**.
- [ ] T023 Exclude `yFiles` deltas from broadcast structurally. Green **INV-NO-BINARY-WIRE**.

## Phase 8 — Editor-Store reveal (FR-005, [3])

- [ ] T024 Scene.ts:919 reseed advances `versionHighWater` to STRICTLY out-version the synthesized tombstone (`+= 2`). Green **INV-REVEAL**.

## Phase 9 — Bounded GC + privacy (FR-006, [2])

- [ ] T025 In-place GC pass: `yElements.delete` over-timeout `isDeleted` (LOCAL_ORIGIN); drop `yFiles` entries no live element references; `gc:true` confirmed on the doc. Green **INV-BOUNDED**.

## Phase 10 — Save-skip (FR-007, [4])

- [ ] T026 `dirtySinceLastSave` flag (LOCAL_ORIGIN update observer sets, successful save clears); replace `getSceneVersion`-sum cache. `isSaved ⇔ !dirty`. Green **INV-SAVE-SKIP**.

## Phase 11 — Robustness + appState undo (FR-014, FR-015)

- [ ] T027 Validate payload shape and guard `Y.applyUpdate`; an invalid update is rejected without wedging the session. Green **INV-WIRE-ROBUST**.
- [ ] T028 The undo path writes the reverted `viewBackgroundColor`/`name` back to `yAppState`. Green **INV-APPSTATE-UNDO**.

## Phase 12 — Validate

- [ ] T029 Whole suite + re-enabled block green; non-vacuity ledger re-verified (revert each fix → its invariant RED); `pnpm run test:typecheck` + lint (`--max-warnings=0`) + touched suites green.
- [ ] T030 SC-003 gate: a fresh FULL adversarial review of the complete HEAD returns ZERO findings of any kind. Ratchet any finding → a new invariant test + back to its phase.

## Analyze (spec↔plan↔tasks consistency — pre-implement gate)

Self-check, re-run after the 2026-08-19 widening. Every FR maps to a task and an invariant test:

| FR         | Task           | Invariant             | Story |
| ---------- | -------------- | --------------------- | ----- |
| FR-001/002 | T018/T019      | INV-CONVERGE          | US1   |
| FR-003     | T021           | INV-PERSIST-MERGE     | US3   |
| FR-004     | T020           | INV-COLD-LOAD-LINEAGE | US4   |
| FR-005     | T024           | INV-REVEAL            | US5   |
| FR-006     | T025           | INV-BOUNDED           | US6   |
| FR-007     | T026           | INV-SAVE-SKIP         | US7   |
| FR-008     | T001/T002/T012 | non-vacuity ledger    | —     |
| FR-009     | T013/T015/T016 | INV-WRITE-INTENT      | US8   |
| FR-010     | T017           | INV-HISTORY-LOCKSTEP  | US9   |
| FR-011     | T014           | INV-VERSION-MONOTONIC | US9   |
| FR-012     | T022           | INV-ORIGIN            | US10  |
| FR-013     | T023           | INV-NO-BINARY-WIRE    | US11  |
| FR-014     | T027           | INV-WIRE-ROBUST       | US12  |
| FR-015     | T028           | INV-APPSTATE-UNDO     | US13  |

Every SC has a gate: SC-001→T001, SC-002→T002 (now satisfied by Phases 2–3, not Phase 4), SC-003→T030, SC-004→T029, SC-005→T016 (bandaid census reaches zero), SC-006→T009, SC-007→T010. No orphan tasks, no uncovered FR/SC. **Consistent — clear to implement.**
