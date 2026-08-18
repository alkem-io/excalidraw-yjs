# Tasks: Native-Yjs Lineage Preservation

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-06-26

**Strategy** (plan §Migration): suite-first (author each invariant RED against current HEAD, proving non-vacuity), single-owner (one author holds the lineage seam — no parallel-agent edge edits), edge-by-edge (each FR keeps the whole suite + typecheck + lint green before the next). Land on `split/native-yjs-core`, superseding the throwaway-detour code.

## Phase 1 — RED suite (the deterministic gate, authored against HEAD first)

- [ ] T001 INV-CONVERGE / INV-NO-RESURRECT N-replica property test (seed from `/tmp/lineage-probe.cjs`, against the real `Scene` wire path). **Expected RED** on HEAD.
- [ ] T002 Re-enable `describe.skip("multiplayer undo/redo")` (history.test.tsx:2218) + restore removed collab.test.tsx cases. Record which fail on HEAD.
- [ ] T003 INV-PERSIST-MERGE (concurrent save merge, order-independent, idempotent). **Expected RED.**
- [ ] T004 INV-COLD-LOAD-LINEAGE (cold-loaded replica per-property-merges with an INIT-seeded one). **Expected RED.**
- [ ] T005 INV-REVEAL (reappear-after-structural-removal re-detected). **Expected RED** (ties at V+1).
- [ ] T006 INV-BOUNDED (over-timeout tombstone + orphan binary reclaimed; non-monotone store; deleted-image binary not sent to joiner). **Expected RED** (dead expiry check).
- [ ] T007 INV-SAVE-SKIP (isSaved ⇔ live==stored; no redundant save, no false-skip). **Expected RED.**
- [ ] T008 Record the RED baseline + the non-vacuity ledger (each test fails on HEAD for the named defect).

## Phase 2 — Wire lineage (FR-001/002) — the CRITICAL fix

- [ ] T009 `Collab.encodeSceneAsUpdate()` → `Y.encodeStateAsUpdate(getSceneDoc())` (live state). Remove `encodeSyncableSceneAsUpdate` from the wire (INIT seed + resync). Green **INV-CONVERGE / INV-NO-RESURRECT** + the re-enabled multiplayer block.
- [ ] T010 Delete `encodeSyncableSceneAsUpdate` (data/index.ts) once unused; confirm Portal INIT/resync both ship live state.

## Phase 3 — Cold-load lineage (FR-004)

- [ ] T011 Cold-load adopts stored bytes via `applyUpdateV2` into the Scene doc (`new Scene({ doc })` / `applyRemoteUpdate`), not decode→records→rebuild. Green **INV-COLD-LOAD-LINEAGE**.

## Phase 4 — Persistence lineage (FR-003)

- [ ] T012 `encryptScene`: `applyUpdateV2`-fold prior + live into a scratch doc over shared lineage, encode that. DELETE `mergeStoredElements` + `isExpiredTombstone`. Green **INV-PERSIST-MERGE**.

## Phase 5 — Editor-Store reveal (FR-005, [3])

- [ ] T013 Scene.ts:919 reseed advances `versionHighWater` to STRICTLY out-version the synthesized tombstone (`+= 2`). Green **INV-REVEAL**.

## Phase 6 — Bounded GC + privacy (FR-006, [2])

- [ ] T014 In-place GC pass: `yElements.delete` over-timeout `isDeleted` (LOCAL_ORIGIN); drop `yFiles` entries no live element references; `gc:true` confirmed on the doc. Green **INV-BOUNDED**.

## Phase 7 — Save-skip (FR-007, [4])

- [ ] T015 `dirtySinceLastSave` flag (LOCAL_ORIGIN update observer sets, successful save clears); replace `getSceneVersion`-sum cache. `isSaved ⇔ !dirty`. Green **INV-SAVE-SKIP**.

## Phase 8 — Validate

- [ ] T016 Whole suite + re-enabled block green; non-vacuity ledger re-verified (revert each fix → its invariant RED); `yarn test:typecheck` + lint (`--max-warnings=0`) + touched suites green.
- [ ] T017 SC-003 gate: a fresh FULL adversarial review of the complete HEAD returns ZERO findings of any kind. Ratchet any finding → a new invariant test + back to its phase.

## Analyze (spec↔plan↔tasks consistency — pre-implement gate)

Self-check, this set: every FR (001–008) maps to a task (FR-001/002→T009/T010, FR-003→T012, FR-004→T011, FR-005→T013, FR-006→T014, FR-007→T015, FR-008→T001/T002) and to an invariant test (US1→T001, US2→T001, US3→T003, US4→T004, US5→T005, US6→T006, US7→T007). Every SC has a gate (SC-001→T001, SC-002→T002, SC-003→T017, SC-004→T016). No orphan tasks, no uncovered FR/SC, no terminology drift (lineage / per-property / `applyUpdateV2` used consistently). **Consistent — clear to implement.**
