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
- [x] T008 INV-WRITE-INTENT (a write through a deliberately stale reference touches only the declared keys; a peer's concurrent edit to another property survives). Cover a simple key, a JSON-leaf (`points`) and a nested one (`boundElements`). **Expected RED** — whole-object flush.
- [ ] T009 INV-HISTORY-LOCKSTEP + INV-VERSION-MONOTONIC (history depths in lockstep across local/remote interleavings; `meta.version` never regresses; a passive remote edit does not wipe the redo branch). **Expected RED.**
- [ ] T010 INV-ORIGIN table-driven over {origin} × {write path}, incl. `captureUpdate: NEVER` introducing new ids, and `resetScene` through `CollabEngine`. **Expected RED.**
- [ ] T011 INV-NO-BINARY-WIRE + INV-WIRE-ROBUST + INV-APPSTATE-UNDO. **Expected RED.**
- [ ] T012 Record the RED baseline + the non-vacuity ledger (each test fails on `96f9bce3` for the named defect). Include the bandaid census: the 32 `freshMap.get(id) ?? element` sites across 14 files, enumerated, as the FR-009 acceptance metric.

## Phase 2 — Write-path intent keys (FR-009, FR-011) — the DEEPEST fix

- [x] T013 `writeChangedKeys(ymap, element, intentKeys)`; `Scene.mutateElement` passes `Object.keys(updates)`. Thread the per-key `didChange` set that bare `mutateElement` already computes rather than recomputing it. Green **INV-WRITE-INTENT**.
- [x] T014 Guard the `meta.version` write (mirror the adjacent `versionHighWater` guard). Green **INV-VERSION-MONOTONIC**.
- [ ] T014b **(found by independent review; confirmed; FR-011 is EXPLICITLY INCOMPLETE until this lands)** `replaceAllElements` records `meta.version` verbatim, so a stale action array changing a property while carrying a low version moves meta BACKWARDS after `bumpMetaVersionsFor` (undo/redo, remote apply) raised it. `Store.update` detects a change only when `prev.version < next.version`, so a genuine edit is silently dropped from the change set and the history delta. T014 fixed only the `mutateElement` path. - **Evidence**: the `it.skip`ped INV-VERSION-MONOTONIC case in `Scene.native-yjs-write-intent.test.ts`. It carries a guard assertion (`raised > base.version`) so it cannot pass or fail for the wrong reason — it fails at `expected 2 to be greater than 3`, i.e. a genuine regression below a genuinely raised meta. Pre-existing (fails against 9cb4a460 too). - **Why the obvious fixes do not work — classified, not a headline number.** A blanket `max(record.version, prev + 1)` produces 70 failures: **68 are snapshot-expectation churn** (cheap in principle — but each regenerated snapshot must be reviewed to confirm the new version is _correct_, not merely different), and the remainder are **semantic and are the actual blockers**: `collab.test` "should emit two ephemeral increments" gets 3 instead of 2 (version inflation manufactures extra Store increments), `linearElementEditor` bound-text wrap-on-move, and a `handleBindTextResize` called-with mismatch. A narrowed regression-only bump (`writes > 0 && record.version <= prevMeta`) still moves versions that transform snapshots encode exactly. - **The root conflict (independent review's analysis, and it is the real finding).** `element.version` is simultaneously (a) exact action/history data and (b) the universal dirty token. Those requirements conflict. `Store.detectChangedElements` gates on `prev.version < next.version`; `ElementsDelta.calculate` then gates on `versionNonce` and its invariant requires `deleted.version !== inserted.version`; bounds/collision caches key on version too. So no Store-local patch can both fix the regression and leave version values unmoved. - **The only no-version-move shape is a redesign**: a separate local monotonic scene revision / change token (a sidecar, NOT serialized element lineage), with Store delta detection and every cache-invalidation consumer migrated onto it. That is materially larger than T014b as scoped and should be judged on its own merits.
- [ ] T015 Declare intent sets in the side-effecting helpers (`redrawTextBoundingBox`, `updateBoundElements`, `bindOrUnbind`) — see plan R6.
- [ ] T016 **(PREMISE FALSIFIED — re-scope before doing any of this)** The re-read sites are **not** dead code after FR-009 and must not be bulk-deleted. - **Census correction**: 36 `fresh-snapshot` sites across 17 files (16 literal `*Map.get(id) ?? element` idioms), not the 32/14 first reported. - **Why they survive**: FR-009 scoped `Scene.mutateElement`, but `replaceAllElements` is deliberately unscoped — its contract is "make the doc equal this element set", which is correct for a full reconcile. The stale-read revert class therefore survives at the BULK path: a handler that captures the array, lets a side-effect helper write to the doc, then returns its captured array, reverts that write. Proven by `Scene.replaceAll-wholeObject.test.ts` (with non-vacuity guards on both the staleness of the array and the reality of the doc write). Deleting the re-reads would reintroduce exactly the class `b2f708f5` fixed. - **What the earlier "1/32 done" actually was**: not a bandaid removal. `changeFontSize`'s `editedTextIds` carve-out was an _exception_ to re-reading, removed because the font size became a real doc write — the surrounding re-read stayed. Prior claim withdrawn. - **Re-scope**: removing the re-reads requires first changing the bulk path — either scoping `replaceAllElements` to a declared changed-set, or changing how action handlers return arrays so a stale one never reaches it. That is a new requirement, not a cleanup task, and it interacts with T014b (both are about the bulk write path). Decide the bulk-path design before touching any of the 36 sites.

## Phase 2b — Action-result patch semantics (FR-016) — precedes History lockstep

Two independent findings (T014b's meta regression and T016's surviving revert class) both land on the unscoped bulk write path, so it is the next real work.

- [ ] T016a `ActionManager` captures a real COPY of the element array at invocation and preserves it alongside the promise (`ActionFn` may be async). A bare reference is not a stable "before" image — `Scene.mutateElement` mutates the passed scratch before re-derivation. **A top-level spread is NOT sufficient**: it leaves nested persisted fields (`points`, `groupIds`, `boundElements`, `roundness`, `scale`, `crop`, `customData`) aliased to the live object, so they mutate underneath the "before" image and diff as unchanged. Copy every persisted field the diff reads, and preserve reconciliation/own-Symbol metadata deliberately — `structuredClone` does not carry symbol-keyed metadata.
- [x] T016b-i **(diff done)** `computeElementIntent` / `diffElementKeys` in `packages/element/src/yjs/intent.ts` — presence-aware, `Object.hasOwn`, `id` + RECONCILE_META_KEYS excluded, 9 tests incl. a no-op-derives-nothing guard and a non-vacuity proof that a value-only diff misses the transitions. Pure function, wired to nothing yet.
- [ ] T016b `scene.applyElementChanges(base, result, intent?)`: diff result against the invocation snapshot for added/deleted ids and changed keys, apply only those against the CURRENT doc. Order/index is an ordinary explicit key. `replaceAllElements` stays authoritative and keeps its callers (load/reset/import). - **ATOMICITY (hard requirement).** Membership changes and every per-key intent MUST land in ONE `Y.Doc` transaction under ONE origin, and the metadata for actual writes must be updated inside that same transaction, with a single recompute after. Otherwise one `ActionResult` becomes several observer-visible states — several broadcasts, and potentially several `UndoManager`/Store increments. That is precisely the inflation T014b already exposed (`collab.test` seeing 3 ephemeral increments instead of 2). Compute the whole patch first, then transact. - **Scope of the derived diff**: it is the INTERIM mechanism for SYNCHRONOUS actions only. See the design note below.
- [ ] T016c Point `App.syncActionResult` at the new path. RED first: a test where a remote apply lands mid-action and must survive the result application. **This does NOT make the async path solved** — that test proves preservation of an unrelated remote key, not the same-base explicit-intent case. An async action is only covered once it either carries explicit intent or is audited to return no element changes (T016d). Do not mark the async class closed on the strength of T016c.
- [ ] T016d Audit the async element-returning actions that return their invocation-time array — `actionElementLink.ts` (confirmed live defect on the fallback + catch paths), `actionClipboard.tsx`, `actionExport.tsx`.
- [ ] T016e Integrate **T014b** here — this write path is the right integration point, but **the mechanism remains an OPEN, RED-first problem and must not be assumed solved by it**. Correction of an earlier claim: the narrowed experiment already tried `writes > 0 && record.version <= prevMeta ? prevMeta + 1 : record.version` — i.e. it was ALREADY scoped to ids whose doc properties actually changed — and it still broke transform snapshots. So "unchanged elements caused the 68 snapshot failures" is **unproven**, and patch semantics cannot be presumed to fix them. Patch semantics may well remove stale/unintended writes and shrink the failure set, but that has to be MEASURED: re-run the genuine raised-meta regression test plus the semantic failures and reclassify from scratch. Do not carry the blanket-fix explanation forward.
- [ ] T016f Only then revisit the 36 re-read sites, retiring each as patch mode proves it redundant.

**Design note (do not lose):** a base→result diff is a sound migration default but is NOT the definition of intent. "Explicitly set a key to the value it already had in base" is invisible to a diff yet must still beat an interleaved remote write — the same asymmetry FR-009 fixed one layer down. Derive for synchronous actions in the interim; the durable contract carries explicit per-id key sets plus membership intent.

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
