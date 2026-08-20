# Tasks: Native-Yjs Lineage Preservation

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-06-26 · **Widened**: 2026-08-19 (R2 write-path class)

**Strategy** (plan §Migration): suite-first (author each invariant RED against current HEAD, proving non-vacuity), single-owner (one author holds the lineage seam — no parallel-agent edge edits), edge-by-edge (each FR keeps the whole suite + typecheck + lint green before the next). Land on `split/native-yjs-core`, superseding the throwaway-detour code (commit `96f9bce3`, retained as the RED baseline).

**Revised order (2026-08-19): the write path comes BEFORE the wire.** The 34 re-enabled `multiplayer undo/redo` tests gate FR-009/010/011, not FR-001 — so the original order would have gone RED in Phase 1 for reasons the plan never named. Fixing the write path first also deletes 32 bandaid sites, shrinking what every later phase must keep green.

## Phase 1 — RED suite (the deterministic gate, authored against HEAD first)

- [x] T001 **(done — Scene-level convergence gate)** `Scene.convergence.property.test.ts`. N-replica property for INV-CONVERGE / INV-NO-RESURRECT over the `Scene` wire path: 4 replicas × 12 rounds × 5 fixed seeds, each round making unexchanged concurrent edits (move / soft-delete / create), then exchanging in a seeded Fisher–Yates order, roughly half as full-state resyncs and half as state-vector deltas. Asserts identical canonical content fingerprints (id/x/y/isDeleted — semantic convergence, NOT Yjs byte equality) and that nothing soft-deleted returns. Per-seed guards reject a vacuous pass: >20 edits, ≥1 full-state resync, non-empty live set. - **Proven sharp**: all 5 seeds fail when the Scene encoder is made to rebuild through a throwaway `Y.Doc` with a fresh `clientID`. - **SC-001 is now satisfied together with T032** (landed): the app's INIT/resync no longer rebuilds — `encodeSyncableSceneAsUpdate` is deleted and `Collab.encodeSceneAsUpdate` encodes the live document. This task covers the Scene wire path; T032's own pins cover the app producer, including the per-property loss a rebuild causes.
- [ ] T002 **(FIRST ATTRIBUTIONS LANDED — the dominant cause is measured and is not a defect; a behavioural remainder of 27 stands)** Re-enabling `describe.skip("multiplayer undo/redo")` (history.test.tsx:2218) plus the removed `collab.test.tsx` cases. **Measured by un-skipping and reverting: 36 of 37 fail.** - **Measured clusters** (the only established facts): ~24 snapshot mismatches, concentrated in "conflicts in bound text elements and their containers" and "conflicts in arrows and their bindable elements"; ~16 element-shape mismatches; and several history-depth assertions off by one or more (`expected 4 to be 1`, `expected 1 to be 3`). - **T014b is REMOVED as a lead** — it has since LANDED and the failure count did not move (36 before, 36 after; re-measured on current HEAD). Whatever these failures are, meta-version regression is not it.

  - **T016b/T016c remain UNVERIFIED leads only** — intent-scoped result application is plausible given the clusters, but **no failing case has been traced to either**, so neither is a blocker. Keep them as leads until ONE concrete T002 failure traces to them. Trace one concrete failure to a cause before treating that cause as required work. - **T017 is excluded, not merely untraced**: its premise was falsified — a remote apply already contributes zero to both stacks — so no failure here can originate from it. - Do not fix the 36 as a batch; each cluster needs its own attribution first.

  **RE-MEASURED against current HEAD** (after T014b, T021, T023, T026, T032, T016k all landed; block un-skipped, measured, re-skipped): **36 multiplayer failures remain** — unchanged in count from the original "36 of 37".

  - Classified by FIRST reason per test: **9 snapshot, 27 non-snapshot**.
  - **Not directly comparable to the original "~24 snapshot / ~16 non-snapshot"**, which counted REASONS (a test can emit several) rather than tests. The honest statement is that the count is unchanged and the composition has not been re-derived on the same basis.
  - The dominant non-snapshot shape is whole-array equality (`expected [ { id: 'id0', … } ] to deeply equal …`), 20 of the 27.
  - Causes still NOT attributed. T014b landing did not move the count, which weakens the earlier note listing it as an investigation lead.

  **ATTRIBUTION ROUND 1 — the composition re-derived on ONE consistent basis, and the largest cluster explained.** Method: un-skip the block, run it, classify every mismatched snapshot by KIND, then regenerate snapshots on a throwaway working copy purely to read the true expected→received numbers, then revert both. Nothing was landed from that regeneration — accepting regenerated output for tests that are still skipped would be adopting whatever the code does, which is the failure mode this task exists to avoid.

  **All 36 failing tests carry at least one snapshot mismatch; 27 of them ALSO fail a real assertion; 9 are snapshot-only.** Confirmed two independent ways: by parsing failure reasons, and by regenerating snapshots and re-running — 36 failures fall to exactly 27. This supersedes the earlier "9 snapshot, 27 non-snapshot", which counted first-reason-per-test and so read as a partition when it is not one.

  **72 mismatched snapshots, by kind:**

  | kind                | mismatches | distinct tests |
  | ------------------- | ---------- | -------------- |
  | `number of renders` | **48**     | **24**         |
  | `element N`         | 16         | 8              |
  | `undo stack N`      | 4          | 2              |
  | `appState N`        | 4          | 2              |

  **CAUSE 1 (dominant, 24 of 36 tests) — the editor renders FEWER times, and the snapshots record the legacy cadence.** Every one of the 24 render-count snapshots moved DOWN; not one moved up. Range −1 to −9, median −3 (worst: 22→13 and 24→15, both in "rebind bindings … through the history"). This is an improvement being reported as a failure: per-property Yjs observers coalesce what the legacy whole-element write path re-rendered for. Not a defect, and not fixable by changing product code — the recorded numbers are the artifact.

  **CAUSE 2 (2 tests, and it explains a whole shape of assertion) — history entries no longer carry an element delta.** The `undo stack` snapshots expect the legacy `StoreDelta` shape, `elements: { added, removed, updated }` with a full per-element `deleted`/`inserted` pair and an entry `id`. What HEAD produces is `{ appState: AppStateDelta{…}, hasElementChange: true }`. The element half of history is the Yjs `UndoManager` now, so there is no element delta in the entry at all — which is why regenerating shrank the snapshot file by ~3.5k lines.

  **CAUSE 3 (traced from CAUSE 2, first concrete behavioural attribution) — "should redistribute deltas when element gets removed locally but is restored remotely" (`history.test.tsx:2661`).** Four-point trace: (1) the assertion demands `isDeleted: true` after a second undo, justified by the test's OWN comment — "deleted.isDeleted and inserted.isDeleted are the same and therefore removed delta becomes an updated delta"; (2) that is the legacy `StoreDelta` redistribution algorithm, rewriting a stored delta in the light of a remote change; (3) per CAUSE 2 the entry holds no element delta to rewrite; (4) the Yjs `UndoManager` reverts this client's own operations and does not rewrite them against concurrent remote ones. So the assertion cannot hold on this design. **This is the first T002 failure traced to a cause**, and per this task's own rule that unblocks treating the cause as established — but note what it is: a retired mechanism, not a bug.

  **The behavioural remainder — 27 tests, cleanly isolated for the first time** (measured with snapshots regenerated, so snapshot noise cannot mask them): 22 are whole-array `toEqual` against `ObjectContaining`/`ArrayContaining` (element set, order, or property mismatch) and 5 are numeric equality (history-depth counts, e.g. `expected 4 to be 1`). These are NOT yet attributed and must not be assumed to share CAUSE 3 — that inference is exactly what this task forbids. Next round: trace one of the 22 and one of the 5.

  **Disposition, stated so it is not decided by drift:** the render-count and undo-stack-shape snapshots record a representation this spec deliberately replaced. When these tests are eventually re-enabled, those snapshots must be regenerated WITH the reason recorded per cluster — not accepted silently — and the 27 behavioural failures must each be attributed first.

- [x] T003 **(DONE — the LIVE gate replaced the old flat-boundary block, which was deleted rather than kept as a baseline)** INV-PERSIST-MERGE against the real path.

  The original block described the pre-T021 flattened boundary and left its three acceptance cases `it.skip`, on the grounds that the lineage-bearing API "does not exist yet". It does now, so that block is gone and the gates are live:

  - **order independence** — the SAME base/A/B update bytes saved A→B and B→A must produce both the same decoded result AND the same stored state-vector fingerprint. Converging on values while holding different histories would diverge later, so both are asserted.
  - **CRDT idempotence** — saving the identical lineage-bearing update twice leaves the stored state vector unchanged, with distinct portals so the save-skip token cache cannot be what makes the second save a no-op.
  - the different-property survival case lives with the concurrent-save group.

  **Non-vacuity**: dropping the prior fold fails order-independence and the concurrent-save cases — FIVE cases, identically on every run (verified across 3 runs), because on shared lineage a dropped fold loses the other replica's contribution outright with no tiebreak involved. The old `RACE_ITERATIONS = 12` loop and its probabilistic rationale are therefore REMOVED: they described a `clientID` coin-flip that the shared-lineage fixtures no longer produce, and one deterministic case is the stronger test.

  Stated honestly, two cases are NOT fold detectors and are not counted as such: idempotence (without a fold the second save simply overwrites with identical bytes) and the explicit `isDeleted` conflict (it asserts agreement with a live Yjs merge, which is `clientID`-dependent, so it flaps under sabotage by design).

- [x] T004 **(DONE)** INV-COLD-LOAD-LINEAGE — a cold-loaded replica per-property-merges with an INIT-seeded one.

  The editor has two doors into a room and they must produce compatible lineage: COLD LOAD adopts the persisted document (T020), INIT SEED receives a peer's full-scene broadcast (T032). Before those landed each door minted a fresh `clientID`, so two replicas that entered by different doors shared no history and their concurrent edits could only resolve by whole-element LWW.

  **Coverage** (`coldLoadLineage.test.tsx`, 3): a cold-loaded and an INIT-seeded replica editing DIFFERENT properties of the same element both keep both edits; seeding one from the other teaches it NOTHING (same lineage, not merely the same decoded values); and a deletion made on one door is not resurrected by the other.

  **Non-vacuity by sabotage**: making persistence rebuild the stored document from decoded records fails ALL THREE.

  **Scope, stated**: the cold-load side runs through the real `saveToFirebase`/`loadFromFirebase`. The INIT side MIRRORS `Collab.encodeSceneAsUpdate` rather than calling it (driving the collab layer needs a mounted app); that producer is pinned directly in `collab.test.tsx`. So these prove the doors interoperate given a faithful seed, not that the seed is built correctly.

- [x] T005 **(done — covered by the Store-level case in `reappearReveal.test.tsx`; its "Expected RED (ties at V+1)" is FALSIFIED)** INV-REVEAL. A reappearing element must be re-detected by the editor Store, which retains the synthesized `isDeleted:true` tombstone and gates on `prevElement.version < nextElement.version`. The Store case passes on current code and fails when the reseed is pinned to a constant or to a value equal to the high-water mark, so it is non-vacuous in both directions. The Scene and a peer converge regardless of the seeded version, which is why assertions on them cannot cover this invariant. See T024 for the accompanying finding that no `+= 2` fix is needed.
- [x] T007 **(DONE — closed by T026)** INV-SAVE-SKIP: `isSaved` means everything in the live document has reached the store.

  Two defects were measured, and the one this task predicted was the smaller:

  - **FALSE-DIRTY, unanticipated** — the cache was set from elements returned through `restoreElements`, which RENORMALISES versions, so the cached and live sums never matched and EVERY save was redundant (measured: live sum 10 stored as sum 4), with the unload guard permanently claiming unsaved work.
  - **FALSE-SKIP** — a plain sum collides whenever one element's version rises as much as another's falls, which does happen here.

  Both are closed by `Scene.contentToken` (T026). **Live gates**: `firebasePersistence.test.tsx` → `describe("INV-SAVE-SKIP")` — clean after save, redundant save skipped, in-flight change stays dirty, FAILED save stays dirty and the retry succeeds, sum-collision cannot false-clear, unknown socket is dirty; plus the generation-swap pair. No `it.fails` markers remain.

- [x] T008 INV-WRITE-INTENT (a write through a deliberately stale reference touches only the declared keys; a peer's concurrent edit to another property survives). Cover a simple key, a JSON-leaf (`points`) and a nested one (`boundElements`). **Expected RED** — whole-object flush.
- [x] T009 **(DONE)** INV-HISTORY-LOCKSTEP / INV-VERSION-MONOTONIC.

  - **The original "history depths stay in lockstep" wording is FALSIFIED and must not be restored**: an appState-only step makes a `History` entry with no `UndoManager` item, so equal depths cannot hold for a correct editor. Stated behaviourally instead — a remote apply contributes nothing to local history — and green (`historyLockstep.test.tsx`).
  - **`meta.version` never regresses** — closed by T014b. Live gate: the un-skipped INV-VERSION-MONOTONIC case in `Scene.native-yjs-write-intent.test.ts`, plus the reservation pin in `reappearReveal.test.tsx`.

- [ ] T011 **(SPLIT — one done, one open)** - **INV-APPSTATE-UNDO — DONE (T028)**: undo/redo of background/name survives the next scene update, verified across a linked peer, with `name` narrowed by evidence. Live gate: `appStateUndo.test.tsx`. - **INV-WIRE-ROBUST — OPEN, tracked as T027.** Its original wording ("an invalid update is rejected without desynchronising") is unachievable by catching: Yjs apply is not atomic on a decode failure, measured at 10 of 1056 truncation offsets both throwing AND mutating. Generation replacement now exists with a live consumer, so the dependency is gone; the transport-level reproduction is built and the receiver policy is drafted and measured (`wireRecoveryPolicy.test.tsx`), but no transport code is written — held pending the server ingress policy.

- [x] T014b **(DONE — FR-011 complete)** The version authority: a stale bulk write can no longer move `meta.version` backwards, and the Store no longer silently drops a real edit.

  **Three mechanisms, each narrowing forced by a MEASURED failure** (the earlier rounds' full traces are in the git history of this file):

  1. **No-write rule.** An element contributing zero doc writes moves no doc-derived metadata. `symbols` and `boundElementsEmpty` still refresh — the latter because the CRDT collapses `boundElements: []` and `null`, so that sentinel is the sole carrier of the distinction.
  2. **Content-gated, STRICT-regression bump.** Only `writes > 0 && incoming < previousMeta` advances, to `previousMeta + 1`. A TIE must NOT bump: element creation is a two-phase structural-add-then-reveal, so meta is already stamped when the same version arrives again, and bumping that benign re-presentation manufactured a Store-visible change for ONE logical creation (measured: 3 ephemeral increments for 2 updates).
  3. **Tombstone-watermark reservation** — the missing authority transfer, and the reason (2) alone regressed INV-REVEAL. On a HARD removal the editor Store synthesizes its own tombstone at `lastVisible + 1` and retains it, but the Scene deleted the id's meta without accounting for that number, so the watermark fell behind an invisible Store one and a later reseed collided with it (measured: tombstone and reveal both landed on 5, and the Store's `prev < next` gate rejected the reveal). `reserveTombstoneWatermark` now advances past it at the LOCAL hard-removal sites.

  **Census of every meta-delete site**, classified by whether the Store observes an omission: | site | reserves? | why | |---|---|---| | `replaceAllElements` removedIds | **yes** | local hard removal; the Store sees an omission and mints a tombstone | | `commitPlan` remove | no | `applyElementChanges`/`commitPlan` has **zero production consumers** — verified repo-wide, only Scene-internal references. Reserving there froze behaviour for an unconsumed API on symmetry alone, and removing it fails nothing. Add it when T016b wires a real consumer and the reappearance property can be driven through that boundary — not before, and not via a synthetic test written to preserve it | | `recomputeFromDoc` cleanup | no | the remote/undo path already reserved: `bumpMetaVersionsFor` bumps and raises the watermark BEFORE recompute drops meta, so reserving again would double-advance | | `collectGarbage` | no | **not** for the reason first recorded. "The element was already soft-deleted so the Store synthesizes nothing" is FALSE — `detectChangedElements` synthesizes `newElementWith(prev, {isDeleted:true})` for ANY previously-known element missing from the next set, with no check on `prev.isDeleted`, and that increments its version. The real reason is that GC is FINAL structural reclamation with no supported reappearance consumer, so no later reseed can collide with the watermark the Store minted. Any future same-id revival after GC needs its own watermark contract and this exclusion would then be wrong |

  **Results**: the anchoring INV-VERSION-MONOTONIC case is un-skipped and green; reappearReveal passes with literal versions (tombstone 5, reveal **6**); the creation-tie phantom is gone; full suite 140 files / **1588 passed**.

  **Snapshot changes accepted on the stated criterion**: 194 `"version"` lines across 4 files — no geometry, binding or content key changes anywhere — plus the 10 `"hasElementChange"` lines (5 flips, `false → true`) that were individually adjudicated as CORRECTED recordings: they are all redo-stack entries in the bidirectional-bindings group, `hasElementChange = !delta.elements.isEmpty()`, redoing an unbind/rebind genuinely changes elements, and those tests' behavioural assertions never moved.

  **`textWysiwyg`'s baked-in `version: 2` → `9`**: metadata only. Every semantic field (geometry, `boundElements`, `isDeleted`, `updated`) is byte-identical on both baselines; the assertion mixed reconciliation metadata into an otherwise semantic `objectContaining`. The **+7 is itself a finding**: that flow writes the container about seven times with a version behind meta — seven genuine stale writes, evidence for the T015/T016 helper work.

  **Non-vacuity**: removing the single landed reservation fails reappearReveal with the exact tie symptom, and restoring it fixes it. There is exactly ONE reservation call site and exactly one test pinning it — no unpinned behaviour was frozen. (An earlier draft also reserved in `commitPlan` on symmetry grounds; that was removed, because symmetry is not evidence and the API has no production consumer.)

- [x] T015 **(DONE — answered by the mutation journal, NOT by hand-written key lists)** Side-effecting helper intent.

  The task proposed declaring intent sets inside `redrawTextBoundingBox`, `updateBoundElements` and `bindOrUnbind`. That was rejected as a second unconsumed API that could drift from the real writes. The implemented answer (T016b) journals what each `scene.mutateElement` call ALREADY declares, keyed by id: the `updates` object is both the declaration and the actual write source, so it cannot drift. Helpers are unchanged.

  **Live consumer**: `Scene.beginActionMutationJournal` around each synchronous action; **live gate**: `Scene.mutationJournal.test.ts`.

- [x] T016 **(DONE for the action-result path; the reread FAMILY remains open as T016f)** The bulk write path.

  The re-read sites were never dead code: `replaceAllElements` is authoritative ("make the doc equal this set"), so a handler that captured an array, let a helper write to the doc, then returned its captured array reverted that write. The re-reads masked exactly that.

  **Resolved by changing the bulk path itself** (T016b): an action's result is applied as a diff against its invocation snapshot with explicit ownership, which removes the need those re-reads served. Two are deleted, each proven by a failing production test. The rest stay under T016f — measured, and not to be retired without a test that fails when they return.

- [x] T016a **(done)** `ActionManager` captures a real COPY of the element array at invocation and preserves it alongside the promise (`ActionFn` may be async). A bare reference is not a stable "before" image — `Scene.mutateElement` mutates the passed scratch before re-derivation. **A top-level spread is NOT sufficient**: it leaves nested persisted fields (`points`, `groupIds`, `boundElements`, `roundness`, `scale`, `crop`, `customData`) aliased to the live object, so they mutate underneath the "before" image and diff as unchanged. Copy every persisted field the diff reads, and preserve reconciliation/own-Symbol metadata deliberately — `structuredClone` does not carry symbol-keyed metadata.
- [x] T016b-i **(diff done)** `computeElementIntent` / `diffElementKeys` in `packages/element/src/yjs/intent.ts` — presence-aware, `Object.hasOwn`, `id` + RECONCILE_META_KEYS excluded, 9 tests incl. a no-op-derives-nothing guard and a non-vacuity proof that a value-only diff misses the transitions. Pure function, wired to nothing yet.
- [x] T016b **(DONE — the synchronous action write path)** An action's result is applied as a DIFF against the snapshot it was invoked on, onto whatever the document holds now, with explicit ownership wherever the action and a helper it invoked wrote the same key.

  **Why the authoritative path was wrong.** `syncActionResult` fed `scene.replaceAllElements(result)`, whose contract is "make the doc equal this set". A side-effecting helper (`redrawTextBoundingBox`, `updateBoundElements`, `bindOrUnbind`, the flip repositioners) writes to the doc DURING `perform`, and the array the action returns can predate those writes — so applying it authoritatively reverted them. Measured through production actions, not hypothesised.

  **The mechanism, in three parts.**

  1. **Invocation base.** `ActionManager.updater` already carried `invocationBase` (T016a) and `syncActionResult` discarded it. It now accepts it and, when present, routes to `scene.applyElementChanges(base, result, …)`; callers without a base keep the authoritative path.

  2. **Action mutation journal.** `Scene.beginActionMutationJournal()` / `endActionMutationJournal()` record which keys each `scene.mutateElement` call DECLARES, per id, for the synchronous span of one action. The `updates` object already IS the writer's explicit declaration AND the actual write source, so journaling it cannot drift from a hand-maintained list. Keys are filtered through `isIntentKey`, the same selector intent derivation uses, so a broad element object cannot turn `id` or reconciliation metadata into ownership. A key is recorded even when the value already matches — declaring it is a claim regardless of what the doc held.

     Deliberately SEPARATE from `beginLogicalMutation`: that is a generic transport primitive, and making every logical boundary imply intent capture would couple transport buffering to action semantics. Nested scopes join; the journal is created at the outermost begin and discarded at the matching end; an unbalanced end THROWS.

  3. **Fail-closed ownership.** A key claimed by BOTH the derived diff and the journal, where a scoped write would actually change the document, is AMBIGUOUS — the action may be overriding the helper, or its value may be stale, and nothing may guess. Every such key must be covered exactly once: Ambiguity applies to DERIVED intent only — an explicit `declaredIntent` IS the ownership statement, so naming a key in `keysById` means the action owns it. For derived intent there is exactly ONE channel: `overlapPolicy`, a per-KEY policy applied only to keys that are genuinely ambiguous, for a caller that knows its rule but cannot know which ids will conflict before the journal exists. Anything uncovered **throws before any mutation**, naming every unresolved `id.key`; an unknown choice throws; rejection leaves the state vector unchanged.

  **One comparison authority.** `wouldWriteChange(ymap, element, key)` in `schema.ts` is the single mutation-free predicate for "would a scoped write of this key change the document" — presence/`undefined` handling, `boundElements` set-diff, `deepEqual` for JSON leaves, strict identity otherwise. `writeChangedKeys` and ambiguity detection both consult it, so they cannot diverge. (A `JSON.stringify` comparison is NOT equivalent: key-order sensitive, and it collapses presence distinctions.)

  **Production ownership.** Only flip declares one: `FLIP_OVERLAP_POLICY` maps the geometry keys to `applied`, because `flipSelectedElements` repositions elements and their bound texts/arrows THROUGH THE DOC and then returns the pre-flip array. No action-name branch exists in `Scene`.

  **Two rereads removed, both proven necessary to remove:**

  - `actionFlip`'s post-flip whole-object reread — its stale `selectedElements` clobbered helper geometry;
  - `actionBoundText`'s wrap reread — it replaced the just-reindexed text with the live doc version still carrying the OLD index, turning `syncMovedIndices`' distinct `a1`/`a2` into a tie at `a1`. Measured at four points.

  **Gates**: both flip suites; the text order/z-index assertion; the observable delete-binding gate (converged state locally AND at a linked peer, one undo step); one transport update per action; `Scene.mutationJournal.test.ts` (12).

  **Non-vacuity, every branch**: dropping a flip policy key throws naming `arr.x, rec1.x, rec2.x`; inverting `applied`→`result` produces the real flip regression; sabotaging the delete's owning `mutateElement(startBinding)` site fails the delete gate; restoring either reread fails its own gate.

  **Snapshot movement, in TWO classes** — an earlier report said "exactly 10 lines across 3 files" and was INCOMPLETE, because `git diff -- '*__snapshots__*'` does not cover INLINE snapshots living in `.test.tsx` files:

  - **File snapshots**: 10 lines across 3 files — 6 `version`, 4 `versionNonce`. Zero `updated`, `hasElementChange`, geometry/binding/content, membership/order.
  - **Inline snapshots**: 7 `renderStaticScene` CALL-COUNT values in `linearElementEditor.test.tsx`, every one a REDUCTION (7→6, 9→7, 7→6, 7→6, 10→7, 9→7, 7→6). These count React renders, not content. Fewer renders is the expected consequence of writing only declared keys instead of flushing whole objects — the same cause as the version reduction — and no assertion about element content, order or binding moved.

  The `textWysiwyg` geometry assertion no longer pins a version: measured across both apply routes the doc write SET is identical, so the difference was accumulated in-memory version, not lost content.

- [x] T016c **(CLOSED — no current producer; the rule lives at the boundary)** Async action results.

  **Census, re-audited by brace-matching every `perform: async` body and inspecting only `return { … }` sites: ZERO async performs return an `elements` field** (`actionElementLink` ×1, `actionExport` ×3, `actionClipboard` ×4 — none returns elements). Earlier notes claiming one were wrong; that count came from matching `prepareElementsForExport` ARGUMENTS.

  There is therefore no async producer to build machinery for, and none is built. The durable rule is recorded at the `ActionResult` boundary instead: a future async element result CANNOT use the synchronous derived/journal fallback, because `ActionManager` closes both the transport boundary and the journal scope before the promise resolves. Such a result must supply explicit intent/ownership, or be rejected. Reopen only against a real producer.

- [x] T016e **(DONE — T014b landed and is integrated at this write path)** `meta.version` monotonicity in the action write path.

  `applyElementChanges` inherits the same monotonic rule as every other write: content-gated, strict-regression only, with the tombstone-watermark reservation. **Live gate**: the un-skipped INV-VERSION-MONOTONIC case, green through both the authoritative and the diff route.

- [x] T016f **(DONE — the doc re-read class is fully characterized)** Retire the post-helper re-reads where, and only where, a test discriminates.

  **Denominator, counted directly** (production only, multi-line tolerant): the class is **12** doc re-read sites of the `freshMap`/`resultMap` … `??` shape — NOT the 36 originally recorded. That figure conflated this class with unrelated `fresh-snapshot` markers and with `updatedElementsMap.get(id) ?? element`, which is an action's own map rather than a doc read.

  **3 RETIRED**, each proven by a production test that fails when the re-read returns:

  - `flip:216` — stale `selectedElements` clobbered helper geometry.
  - `boundText:358` — replaced the just-reindexed text with the live doc version still carrying its OLD index, turning `syncMovedIndices`' distinct `a1`/`a2` into a tie.
  - `align:83` — `actionAlign` now has **zero** doc re-reads. Removal without ownership makes the fail-closed boundary throw naming `arr.points, arr.y`; `ALIGN_OVERLAP_POLICY` (geometry → `applied`) closes it, and inverting to `result` leaves the arrow on its pre-align diagonal.

  **9 RETAINED, every one measured**, because removal is unobservable and "the suite is still green" is exactly the reasoning the discrimination bar refuses:

  - `flip:163` — removal IS observable (`expected -50 to be close to 110`), but it feeds `bindOrUnbindBindingElements` as a HELPER INPUT, not the returned array. Ownership governs how a result is applied and cannot substitute; retiring it needs the helper to take doc-derived input.
  - `boundText:184`, `distribute:77`, `actionProperties` ×5 (including all `editedTextIds`/`editedArrowIds`-guarded ones), `actionFinalize` ×1 — each removed in turn with the full suite still green.

  **Why the retained ones are redundant yet not retirable**: under the patch route the derived diff compares the result against the INVOCATION BASE, and the stale entry equals that base — so no key is declared, nothing is written, and the helper's doc value already survives.

  **OBSERVATION, not a task and not a defect**: ~25 further production `fresh-snapshot` markers (34 in total across 14 files) are a DIFFERENT class — single-element re-reads such as `scene.getElement(x.id)` after a helper write (`Stats/*`, `resizeElements`, `transform`, `binding`). They are helper/consumer inputs, an ownership policy cannot retire them, and no production path or test has demonstrated a stale overwrite through them. Recorded so the count is not mistaken for outstanding work; do not open it as a task without a concrete failing case.

  **Harness capacity limit** (not a product flake): `npx vitest run --maxWorkers=32 --minWorkers=32` on a 10-core machine deterministically produces `still loading` timeouts. Normal parallelism has ~2–4× margin; `asyncUtilTimeout` and worker defaults are deliberately unchanged.

**Design note (do not lose):** a base→result diff is a sound migration default but is NOT the definition of intent. "Explicitly set a key to the value it already had in base" is invisible to a diff yet must still beat an interleaved remote write — the same asymmetry FR-009 fixed one layer down. Derive for synchronous actions in the interim; the durable contract carries explicit per-id key sets plus membership intent.

## Phase 2c — Headless Node entry (`@excalidraw-yjs/element/headless`)

- [x] T017a **(done)** `src/headless.ts` — DOM-free export surface (omits `renderElement`, `elementLink`, `visualdebug`, and `store`/`delta`, which self-import the barrel). Second esbuild entry so the subpath resolves to its own bundle (226 KB vs the barrel's 277 KB) rather than the `./*` wildcard sending it back to `index.js`. Exports subpath declared BEFORE the wildcard so it wins.
- [x] T017b **(done, then REPLACED)** The first version walked the import graph and pattern-matched DOM access at brace-depth zero, with special cases for `typeof x !== "undefined"` guards and arrow-function bodies. That approximated something the runtime answers exactly, produced false positives on lazily-evaluated lambdas, and each fix made it a worse model. **Deleted, not extended.** Replaced by `scripts/headless-smoke.mjs` (`pnpm run test:headless`): a bare Node process importing the BUILT bundle and driving the real workflow. The import itself is the assertion for module-scope DOM; a call-time read throws when the call is made. It cannot live in vitest because the suite runs under jsdom with a global setup defining `window.matchMedia` / `document.fonts`, so it cannot observe a missing DOM.

- [x] T017c **(done, pre-existing defect)** `@excalidraw-yjs/common` imported `@excalidraw-yjs/math` at runtime without declaring it — the published package was unresolvable for any consumer. Declared. **Still outstanding: `@excalidraw-yjs/utils` has the same defect for `common`/`element`/`math`, not fixed because declaring `element` would create an `element ↔ utils` cycle — needs a decision.**
- [x] T018 **(CLOSED — the headless entry works end to end)** Root cause was a single character-class of bug, not a structural one: `Scene.ts` read `window?.DEBUG_FRACTIONAL_INDICES` on the fractional-index validation path. **Optional chaining guards a NULL value, not an UNDECLARED identifier**, so the bare `window?.` still throws `ReferenceError: window is not defined` in Node — every element write failed for a headless consumer, over a debug flag. Fixed to `globalThis.window?.`, which is a property access on a defined object. `pnpm run test:headless` now reports 4/4: imports in bare Node, exports the server surface, omits the browser-only surface, and adopts a `Y.Doc` → writes elements → mutates per-property → emits updates → encodes state.

- [x] T018b **(done)** `ExcalidrawImperativeAPI` exposes the collaboration transport — `onLocalSceneUpdate` / `applyRemoteSceneUpdate` / `encodeSceneAsUpdate` — delegating to the `Scene` methods that carry the origin policy. The raw `Y.Doc` is not reachable from the public API, so the policy cannot be bypassed. `Collab.tsx` consumes that boundary and holds no filter of its own; it imports neither `yjs` nor any origin sentinel. Coverage for every transport invariant lives at Scene level, including a remote appState apply producing no outbound update (which guards the `yAppState` observer against a write-back loop).
- [x] T018a **(done)** Corrected the Scene API surface published to consumers. The method is **`encodeStateAsUpdate(...)`** (plus `encodeStateVector()`, `encodeSnapshot()`), NOT `encodeAsUpdate()`. **Verified against the RED baseline, not just against HEAD**: `encodeAsUpdate` never existed at any point — `96f9bce3` already declared `encodeStateAsUpdate` (1049), `applyRemoteUpdate` (1035), `encodeStateVector` (1062), `encodeSnapshot` (1203). So this was purely a prose error in `plan.md`, and the name relayed to the server team would never have resolved. Line numbers in that sentence were also drifted (they pointed into method bodies rather than declarations) and now cite the baseline declarations, per this spec's convention that cited lines resolve against `96f9bce3`. **Server-facing consequence**: anyone who took `encodeAsUpdate()` from the plan needs the corrected name; flagged for the next hand-off rather than assumed harmless.

- [x] T016j **(DONE — scoped index validation, and the tie's real cause)** `applyElementChanges` validates fractional indices for AFFECTED records only.

  **Contract**: validate the records this mutation affects — creations, and existing ids whose declared keys include `index`. Format only: present and parseable. A relational TIE is not rejected and not repaired here; it belongs to the caller that knows the intended array order. An element absent from the result is never inspected.

  **Measured census** over the whole suite: 3225 valid / 2 invalid / 76 missing across 3303 `replaceAllElements` calls. `syncActionResult` itself is 1573 valid, 2 invalid, **zero missing**. The only production callers passing a missing index are `new Scene` and the public `updateScene`, both authoritative, both keeping `syncInvalidIndices`. A strict whole-array prevalidation would have rejected two real action results.

  **The 2 "invalid" are DUPLICATE indices, both from `wrapTextInContainer`**, each a newly added element tying a pre-existing one. `orderByFractionalIndex` breaks ties by element id, so they order deterministically — but deterministically is not correctly: for n=3, accepting the tie puts the container ABOVE its text and inverts the intended z-order.

  **Cause, measured at four points** on the failing path with authoritative repair disabled:

  ```
  before syncMovedIndices : id1@a0, id6@null, id3@a1
  after  syncMovedIndices : id1@a0, id6@a1,   id3@a2   <- distinct, correct
  before reread           : id1@a0, id6@a1,   id3@a2
  after  reread           : id1@a0, id6@a1,   id3@a1   <- TIE
  ```

  `syncMovedIndices` produces a correct tie-free assignment but writes it to the SCRATCH object, so the doc still holds the text's old `a1`; the reread then replaces every element present in the doc and discards the generated index, while the new container survives via `?? element` because it is not in the doc yet. This is the reread class (T016f), not a fractional-index defect — which is why the fix is removing that reread (done in T016b) rather than a tie resolver. `includeBoundTextValidation` is unrelated and unchanged.

- [x] T016k **(done — the action owns the broadcast)** One editor action reaches a peer as ONE transport message. `ActionManager.executeAction` opens a logical mutation around the synchronous span (`perform` through `syncActionResult`); inner `Scene` boundaries JOIN it, so only the outermost close publishes. - **Measured on `wrapTextInContainer`**: `senderUpdates=1, peerStates=1, dangling=[], undoDepth=1`, against a baseline of 4 / 4 / 2 dangling container references. `actionAtomicity.test.tsx` is un-skipped. - **Scope of the guarantee, stated precisely**: it is a TRANSPORT guarantee. The sender's own Scene/Store callbacks may still fire several times locally, and no test claims otherwise. - **Async is delimited, never spanned**: the updater registers a promise continuation and returns, so the boundary closes before an async result lands and the buffer is never held across an `await`. An async action gains nothing from it and is unchanged. - **A throw mid-action still publishes** whatever Yjs already committed — those bytes are in the document, and withholding them would diverge the peer permanently. Balanced closes live in `finally`. - **Boundary rules pinned**: nested join (only the outermost publishes, and its single message carries the final state), throw-after-write publication, a no-write boundary publishing nothing, and closing without opening throwing.
- [x] T017 **(closed by reconciliation — the behavioural contract holds; no fix was needed)** Measured through the real public path (`excalidrawAPI.applyRemoteSceneUpdate`, what `Collab` calls), a remote apply contributes ZERO to both stacks. The task's premise — that it currently contributes a history entry — is false, and a `NEVER` micro-action written to "fix" it changed the numbers not at all, so it was reverted rather than shipped. - **The invariant is restated behaviourally, not as stack depths.** `History` and the `UndoManager` legitimately differ: an appState-only step makes a `History` entry with `hasElementChange: false` and no `UndoManager` item. A depth-equality assertion would fail for a CORRECT editor, which is why the old skipped test was not evidence of a defect. A pairing claim (`hasElementChange` entry ⇔ `UndoManager` item) was considered and NOT adopted — it is another cardinality claim, and `history.ts:153` only calls `stopElementCapture()` to seal a step, which does not by itself guarantee a one-to-one relationship under coalescing. - **Coverage of the three behavioural requirements**: (1) a remote apply adds no locally undoable step — `historyLockstep.test.tsx`, new, non-vacuous (applying the remote update under `LOCAL_ORIGIN` instead fails it); (2) the next local undo affects only the local action and both replicas converge — `Scene.native-yjs-collab.test.ts` origin-scoped undo, which asserts peer content and matching state vectors; (3) appState-only local history stays undoable without an element item — `appStateUndo.test.tsx`, where a background change is appState-only and undoable end to end.
- [x] T032 / T025b **(DONE — landed together as one slice)** The INIT/resync wire encodes the LIVE scene doc; maintenance runs immediately before it and the encoder stays PURE.

  **Producer re-confirmed before changing anything**: `Portal.broadcastSceneInit` (on `new-user`) and `Portal.broadcastSceneResync`, both via `Collab.encodeSceneAsUpdate`. No other producer.

  **What changed.** `encodeSceneAsUpdate` previously rebuilt the scene through a throwaway doc (`encodeSyncableSceneAsUpdate`), giving every join/resync a fresh `clientID` and destroying CRDT lineage (~50% concurrent-edit loss, ~50% deletion resurrection per resync). It now runs `collectSceneGarbage({ deletedBefore: Date.now() - DELETED_ELEMENT_TIMEOUT })` and then encodes the live doc. Two new API methods — `encodeSceneStateAsUpdate` (pure) and `collectSceneGarbage` — kept separate on purpose: an encoder that pruned on encode would make reading the state destructive, and the resync timer would then quietly drive deletion.

  The rebuild existed to keep two things off the wire, and both have better answers now: aged tombstones are reclaimed from the DOCUMENT by maintenance rather than filtered out of one encoding of it, and since T023 the document carries `fileId -> locator` and never bytes, so there is nothing to strip.

  **T019 folded in**: `encodeSyncableSceneAsUpdate` is deleted, now that it has no production caller. Stale comments in `Portal`, `Collab` and the convergence property test that described the old rebuild were corrected rather than left to mislead.

  **Coverage** (`collabWireFilter.test.tsx`, 7): the original filtering invariants, repointed at the live path (they survive; the MECHANISM changed), plus a resync of unchanged content teaching an up-to-date peer NOTHING (state vector unchanged) and a peer's concurrent edit surviving a resync.

  **Non-vacuity**: restoring the throwaway-doc rebuild fails the lineage pin AND the property-level pin below.

  **The loss this task exists to prevent is now pinned directly** (added after review; the first attempt did not cover it). Through the production `Collab.encodeSceneAsUpdate`: seed a peer, then have sender and peer edit DIFFERENT properties of the SAME element, then apply the sender's full resync — both must survive. Per-property merge keeps both; whole-element LWW keeps one. The peer's `clientID` is pinned to 1 so the sabotage loses reliably: Yjs assigns random 32-bit client ids, so a rebuilt seed outranks 1 with probability 1 − 2⁻³², where an unpinned tie would make the sabotage a coin flip. Verified failing on 3 consecutive sabotage runs and passing when restored.

  **MEASURED — the extra broadcast when maintenance actually removes something** (raised in review; recorded rather than "fixed" speculatively). `collectGarbage` writes under `STRUCTURAL_ORIGIN`, which is published, so a sweep that reclaims anything emits **one** additional local scene update — measured directly (`localUpdateEmits=1` for a sweep that removed a tombstone, 0 sends otherwise). During collaboration that becomes one incremental GC update on the socket, ordered BEFORE the full INIT/UPDATE seed, because maintenance runs synchronously before the encode. So a resync that sweeps is 2 sends, not 1. They commute (the seed already reflects the sweep), so this is redundant traffic, not a correctness problem, and it only occurs when something was actually reclaimed. **Accepted as-is**: suppressing it would mean either a second origin filter or an impure encoder, both worse than the occasional extra message. **Harness limit stated**: the count was measured at the Scene-update boundary, not at `Portal`, because the probe was not in a collaborating session — the socket-level count is inferred from the subscription, not observed.

  **MEASURED test-environment artifact, recorded because it bounds what the suite proves.** Deletion markers are stamped from the element's `updated`, and the harness mocks `getUpdatedTimestamp()` to a constant `1` for deterministic snapshots. Every tombstone therefore carries marker `1`, and the PRODUCTION cutoff reclaims all of them — measured. The tombstone-window case moves the cutoff instead of the clock, so the window invariant is covered.

  **Contract**: the wire seed prunes with `Date.now() - DELETED_ELEMENT_TIMEOUT` and maintenance runs BEFORE the encode — pinned in `collab.test.tsx` against the production `Collab.encodeSceneAsUpdate`. Non-vacuous in both directions: passing `Date.now()` fails it, and so does swapping the order. Between the two files the path is covered — window semantics where realistic markers are impossible, arithmetic and ordering where they are not needed.

- [x] T019 **(DONE — folded into the T032/T025b slice)** `encodeSyncableSceneAsUpdate` deleted once it had no production caller; Portal INIT and resync both confirmed to ship live state.

- [x] T020 **(DONE — one slice: docBytes + native initial-data adoption + record application removed at that branch)** Cold-load adopts stored bytes via `applyUpdateV2` into the Scene doc, not decode→records→rebuild. Green **INV-COLD-LOAD-LINEAGE**.

  **Shape (reviewed and approved before implementing).** `initialData` now takes two MUTUALLY EXCLUSIVE forms as a discriminated union — the record form (`elements`/`files`, `encodedScene?: never`) and the native form (`encodedScene: { update, format: "v2" }`, `elements`/`files` forbidden). The union makes mixing them a type error; a runtime guard fails loud for untyped JS callers. `loadFromFirebase` returns `docBytes`; `App.initializeScene` applies them to the CURRENT scene and derives elements, persisted appState and asset locators from it, and does NOT then apply a record element array.

  **Adopt, never replace.** The stored update is applied into the existing generation. A remote update can arrive while the persistence fetch is pending; replacing the Scene afterwards would discard it, so there is deliberately no `replaceSceneGeneration` on this path.

  **Origin.** Reuses `REMOTE_ORIGIN` unchanged — adoption is externally-sourced durable state, which wants exactly its semantics (non-undoable, never rebroadcast). A new origin would rename the source without changing behaviour. `applyRemoteUpdate`'s doc was corrected from "a remote peer's update" to external update (peer **or** adopted durable state).

  **appState precedence.** Collaborative keys come from the doc and beat the caller; a caller override may only touch local UI keys. Overriding `name` or `viewBackgroundColor` through initial data would produce a value no peer sees.

  **Coverage** (`packages/excalidraw/tests/encodedSceneAdoption.test.tsx`, 6): lineage adoption, Scene-level merge, appState precedence, asset resolve-only, fail-loud on both forms, legacy record form unchanged.

  **Non-vacuity, proven by sabotage**: replacing the adoption with a record-rebuild (`new Scene()` → `replaceAllElements`) fails 4 of the 7 tests, including the lineage pin and the app-level race. Recorded honestly in the file: the Scene-level merge test drives `Scene.applyRemoteUpdate` directly, so it does NOT exercise the initialData branch and survives that sabotage.

  **The app-level race IS covered** (added after review, which supplied the recipe). The first attempt at it did not work — the `excalidrawAPI` callback never fires in this harness (measured: `apiFired=false` both before and after resolution). But `h.app`/`h.scene` ARE live while `isLoading` is still true (measured), so the race stages by holding `initialData` unresolved, applying a peer update into the mounted generation, then resolving with `encodedScene`. Both the in-flight and stored elements must survive, with a guard asserting the in-flight edit was present BEFORE adoption.

  **Found while doing it**: the fail-loud guard, placed after `initializeScene`'s try/catch, escaped as an UNHANDLED REJECTION rather than reaching the user — loud in a console nobody reads, invisible in the editor. Moved inside the try so the existing catch surfaces it as `errorMessage`, and the test now pins the surfaced message plus the fact that NEITHER form was applied.

- [x] T021 **(DONE)** `encryptScene` `applyUpdateV2`-folds prior + live over SHARED lineage and encodes that. `mergeStoredElements` + `isExpiredTombstone` deleted. Green **INV-PERSIST-MERGE**.

  **The blocker cleared itself.** This was blocked because the boundary took flat elements carrying no lineage, and because the stored doc was REBUILT on every save (fresh `clientID`), making a Yjs fold whole-element LWW across disjoint lineages. Both premises are now false: T032 made the wire ship the live document, T020 made cold load adopt the stored one, and T023 settled assets as locators. So `saveToFirebase(portal, docUpdate, contentToken)` now takes the live document itself — everything else (elements, references, persistable appState) already lives on it — and the fold is the CORRECT merge while the value merge became the lossy one.

  **What the fold buys, measured**: two replicas from ONE shared base editing DIFFERENT properties of the same element now BOTH survive a concurrent save. Whole-element LWW could only take one side entirely. Same-property conflicts resolve by `clientID` — the same resolution the live socket gives — so persistence no longer has merge semantics of its own to disagree with.

  **A claim I wrote and had to correct.** The obvious justification — "Yjs unions delete sets, so deletions survive" — is FALSE here. Excalidraw deletes SOFTLY: `isDeleted` is an ordinary property, not a Yjs delete, so the delete set is not involved. Deletions survive because the write is normally UNCONTESTED (the other replica edits geometry or colour and never touches `isDeleted`). The residual genuine conflict — one replica deleting while another undoes a deletion — resolves by `clientID`. Both are now stated precisely in the code.

  **The test harness was the real work.** The existing FINDING #2 cases built each side with `new Scene()`, i.e. DISJOINT lineages — a situation no production path produces, since the stored doc descends from a live doc and every peer's doc descends from the room seed. Folding those really is whole-element LWW, so the cases were measuring an impossible scenario. They are rebuilt on `sharedBase` + `replicaFrom`, which is the "two real Scenes derived from ONE shared update" gate T003 said was needed. The persistence save helper now builds a real lineage-bearing document too.

  **Non-vacuity by sabotage**: dropping the prior fold fails 3 cases — disjoint adds, the per-property merge, and the stored-side deletion.

  **Maintenance on the merged result**: the fold can reintroduce tombstones the live scene had already swept, so `collectGarbage` runs on the merged document before encoding, mirroring the wire path.

## Phase 7 — Origin policy + binaries off the wire (FR-012, FR-013)

- [x] T022 **(done)** The origin→wire policy has exactly ONE implementation, in `Scene.onDocUpdate`. No shared lookup table: with a single call site it would be indirection, not deduplication. Pairing a structural tombstone with its reveal is the logical-mutation boundary's job, not the origin table's. **Closed**: INV-ORIGIN's table-driven suite is `Scene.originPolicyTable.test.ts` (T029). Note it is a table-driven TEST, not the runtime lookup table this task rejected.
- [ ] T023 **(PARTIAL — core boundary DONE; one live consumer blocker)** The collaborative document carries `fileId -> opaque locator`; image bytes are out-of-band.

  **The contract, stated directly.** The document stores an opaque host-owned locator string per image and never bytes. Core stores it, round-trips it and garbage-collects it, and never parses it — no URL semantics, no bucket or entity identifiers interpreted. Bytes live in the editor's local cache and in the host's store, moved by the `AssetAdapter`: `store(file) -> locator`, `resolve(fileId, locator) -> BinaryFileData`.

  **Done and live**: locator validation on every write and on EVERY encode (full state and delta); `AssetAdapter` on `ExcalidrawProps`, forwarded through the `Excalidraw` wrapper; persistence and the wire carry locators; orphan references reclaimed by `collectGarbage`; cold load adopts the stored document (T020).

  **Live blocker — ONE, outside this repo**: `client-web` must supply an `AssetAdapter` and delete its `dataURL`-on-upload-failure fallback (`useWhiteboardFilesManager.getUploadedFiles`, which on upload failure keeps the file with its `dataURL` so peers "receive the dataURL directly"). That fallback writes bytes into a document that rejects them.

  **No protocol/version gate is required.** The byte-carrying document shape was never shipped, so there is no mixed population, no stale client and no compatibility boundary to negotiate. No `documentSchemaVersion`, no join payload field, no rejection path.

  **ON HOLD** — the consumer rollout is paused at Anton's instruction. Facts established by a read-only census of `client-web`, preserved so the work can resume without repeating it:

  - **The pin has DIVERGED, not merely fallen behind.** `client-web` pins only **2** packages (`@excalidraw-yjs/element`, `@excalidraw-yjs/excalidraw`) at `2e7c2f00` via pkg.pr.new. That SHA is **not an ancestor of HEAD**: 31 commits are in the pin but not HEAD, 170 in HEAD but not the pin. Reconciling the branches is a prerequisite for any bump.
  - **The locator needs no URL parsing.** `FileUploader.upload` reads only `uploadFileOnStorageBucket.url`, but the mutation returns `StorageBucketUploadFileResult { id, url }` — the server's document-row id is already available ATOMICALLY alongside the URL and is currently discarded. `store()` can return an opaque row id with no extra round-trip.
  - **The exact behaviour to delete** is `useWhiteboardFilesManager`'s `getUploadedFiles`: when `convertLocalFileToRemote` fails it keeps `{...files[id]}` if a `dataURL` is present, so peers "receive the dataURL directly" — writing bytes into a document that rejects them.
  - **Live transport**, reference only: a raw WebSocket per document, `/collab/<documentId>?type=memo|whiteboard`, server sending SyncStep1 after admission. No `join-room`.

- [x] T025b **(DONE — landed with T032; see that entry)** The explicit maintenance call sits immediately before the real INIT/resync encode, and the encoder is PURE. No scheduler, no timer.

- [x] T026 **(DONE — the task's stated design was wrong in two ways and was corrected before coding)** Replace the `getSceneVersion`-sum cache. `isSaved ⇔ nothing changed since the last successful save`. Green **INV-SAVE-SKIP**.

  **Two corrections to the task as written**, both agreed with the reviewer:

  - _Not LOCAL_ORIGIN-scoped._ A peer's edit applied under `REMOTE_ORIGIN` leaves the durable store just as stale as a local one, and this replica may be the one that has to persist it. `Scene.contentRevision` counts transactions from EVERY origin — local, structural, remote, UndoManager — and covers all doc roots (elements, asset references, appState, the deletion sidecar), not elements alone.
  - _Not a boolean._ A bare dirty flag cannot survive an async save: a change landing mid-flight would be cleared by the save that never included it. The token is a monotonic counter; a save captures revision R with the exact state being saved and records only R on success. Anything that moved the doc meanwhile left the live revision past R, so the scene correctly stays dirty. A failed save records nothing.

  **Implementation.** `Scene.contentToken` is replaced from an `afterTransaction` handler — deliberately not `doc.on("update")`, which would make Yjs encode a v1 update on every transaction when this needs no bytes. Exposed as `getSceneContentToken()`. `FirebaseSceneVersionCache` became `FirebaseSavedRevisionCache`; `isSavedToFirebase(portal, token)`. `getSceneVersion` remains a field of the stored document but is no longer the skip authority.

  **A THIRD correction, found in review after the counter had landed — and it was a real defect, not a style note.** The token started as a monotonic NUMBER, which is only monotonic _within one Scene_. The persistence cache is keyed by socket and so outlives a Scene: a reset replaces the generation underneath it, the new generation counts from zero, and it reaches numbers the old one already used — so a save of the old generation marks the new one clean. Measured before the fix: two independent scenes both reached revision 2. Worse, an old generation's in-flight save can complete after replacement and cache a number equal to the new generation's.

  Fixed at the root with an opaque identity token rather than an offset: a frozen object, replaced on every persisted-doc-changing transaction, compared only by `===`. A fresh Scene is distinct from every other even at zero edits. The type is nominally branded, so passing a number where a token belongs is now a compile error rather than a silent collision.

  **Coverage**: `Scene.contentToken.test.ts` (10) — remote apply, asset-only, appState-only, delete/undo/redo, the version-sum collision, adopted docs, that local UI state which never reaches the doc does NOT dirty, that two generations never match, and that a captured token survives intervening reads. `firebasePersistence.test.tsx` `INV-SAVE-SKIP` (7) — clean after save, redundant save skipped, in-flight change stays dirty, FAILED save stays dirty and the retry then succeeds, sum-collision cannot false-clear, unknown socket is dirty rather than saved, plus a generation-swap pair: a replaced generation is never reported saved, and an OLD generation's late-completing save cannot clean the new one.

  **Non-vacuity, proven by sabotage**: reverting the token to the summed version fails 3 of the Scene tests including the collision case; reverting it to a per-Scene numeric counter fails the generation pins — the Scene-level one and BOTH firebase-level ones. The failed-save test asserts the write really failed rather than asserting against a save that quietly succeeded — the first draft did the latter and was vacuous (measured: `failedSave=false`).

  **Deliberately NOT done, and why.** The cold-load path no longer marks the room saved. Since T020 a cold load ADOPTS the stored document, and that adoption is itself a doc-changing transaction occurring after `loadFromFirebase` returns, so no revision available there corresponds to the post-adoption scene. The reviewer's richer rule (adoption may establish a clean baseline _only if_ the fresh generation was clean, staying dirty if a remote update landed during the fetch) is a real improvement and is NOT implemented — deferral reviewed and approved as a bounded follow-up, not a blocker. Cost of the omission is one redundant save after a cold load — the harmless direction. Guessing a baseline would risk the dangerous one: a false-skip, which is silent data loss with nothing to retry it.

- [ ] T027 **(POLICY DRAFTED — one class ready to implement, two not ours)** INV-WIRE-ROBUST.

  **Receiver census** — every production receiver of remote bytes funnels to `Scene.applyRemoteUpdate`: `Collab`'s INIT (`Collab.tsx:710`) and UPDATE (`:724`) handlers via `App.applyRemoteSceneUpdate`, and the cold-load adoption path (`App.tsx:3286`). Three entry points, one boundary.

  **1. TRANSPORT DECODE FAILURE — re-measured on current HEAD.** Over every truncation offset of a real 1596-byte update: **1576 threw with the document untouched, 19 threw AND partially mutated, 0 mutated silently.** The 19 are all in the TAIL (offsets 1577–1595), where enough structs decoded to apply before the stream ran out. Two consequences: a **truncated** update is always announced; but it CAN leave a fragment applied, and no `try/catch` can undo that — the fragment is already in the document. (Supersedes the older "10 of 1056" figure.) **CORRECTED below**: "always announced" holds for truncation only. Exhaustive single-bit corruption falsifies it in general — 258 silent divergences in 12 720 trials.

  **2. SCHEMA POISON — a distinct and arguably worse class.** A structurally-valid Yjs update carrying a banned locator (`data:` URL) **applies cleanly**, lands in the document, and then **every subsequent encode throws**. Measured: `applyThrew=false`, poison present in the derived elements, `encodeThrew=true`. The receiver accepts it silently and only discovers the problem when it next tries to publish — at which point it cannot broadcast **its own work** either. One non-compliant peer can wedge another peer's publishing. This is ingress-vs-egress asymmetry: T023 deliberately validates on every encode and NOT per-update on ingress (a scratch-doc preflight is O(document) on the hot path).

  **3. GENERATION-DISCARD POLICY — the premise was WRONG, and the measurement below retracts it.** This entry previously read "for a truncated update, an unknown fragment is already applied, so **the only sound remedy is discarding the generation and re-seeding**". That is false. A partial apply is a valid PREFIX of the sender's structs — incompleteness, not corruption — and discarding is strictly worse than resyncing because it destroys local work the authority has not yet seen. See the POLICY section.

  **RED landed** (`remoteUpdateRobustness.test.tsx`): one GREEN guarantee that holds today — no truncation mutates without announcing it — plus two `it.fails` REDs pinning the partial mutation and the publish-wedge. Executable, suite stays green, and each fires the moment its class is addressed.

  **COSTING (measured on this machine; reps averaged).** Per-update cost on the hot path, where the receiving doc already exists:

  | board | delta apply alone | per-update scratch preflight | overhead |
  | --- | --- | --- | --- |
  | 50 elements (16 KB doc) | 0.05 ms | 1.3 ms | **27×** |
  | 500 elements (165 KB) | 0.36 ms | 8.9 ms | **25×** |
  | 2000 elements (666 KB) | 0.90 ms | **52.8 ms** | **59×** |

  The preflight is dominated by the CLONE, which is O(document) and independent of delta size (deltas here were 239 B / 2 KB / 8 KB).

  **(a) Per-update scratch clone — REJECTED on measurement.** At 2000 elements it is 52.8 ms per remote update; a peer dragging emits updates at interactive rates (~10–30/s), i.e. 0.5–1.6 s of CPU per second of peer activity. It does not degrade gracefully — it degrades with BOARD size, so the largest boards pay most.

  **(b) Shadow validator generation — the only candidate that costs the right order.** Keeping a second doc in sync costs roughly one extra delta apply (~0.9 ms at n=2000, ≈2×), not a clone per update. Its real cost is elsewhere and must not be waved through: EVERY origin that mutates the live doc — local writes, undo/redo, structural prelude, GC maintenance, cold-load adoption — has to reach the shadow too, or it diverges and starts rejecting valid updates. And after a decode throw the shadow is itself of unknown state, so it must be rebuilt from the live doc — the O(document) clone again, but paid ONCE per failure rather than per update.

  **(c) Discard + reseed — works for truncation, PROVABLY NOT for poison.** See the server finding below.

  **SERVER IMPLICATION (read-only census of `collaboration-service`, a Go service — reported, not modified; changes there belong to its owner).** It maintains and persists a server-side Yjs document (`ApplyUpdate` ×8 in `internal/domain/service/room.go`, 10 checkpoint references, persistence adapters `fileservice` / `inprocess` / `metapointer`) and is **schema-agnostic**: zero references to locator / dataURL / asset anywhere in its Go source. So a structurally-valid poison is accepted into the room AND written to its checkpoint. **A client-side reseed therefore re-fetches the poison and loops forever** — exactly the failure the reviewer predicted.

  **Consequence for policy**: the two classes need different owners.

  - **Transport decode failure** is client-solvable: the fragment is local, server state is valid, so discard the generation and reseed.
  - **Schema poison is NOT client-solvable.** Any client-side remedy is either defeated by the checkpoint (reseed) or amounts to silently dropping a bad root, which is repair-by-guessing. The sound fix is ingress validation at the service, which is outside this repo and must be routed to that owner.

  No policy implemented; the reproduction and costing had to come first.

  **RECEIVER RECOVERY POLICY — drafted, with the requested premise FALSIFIED.** Gate: `wireRecoveryPolicy.test.tsx` (4 tests: 2 green evidence, 2 `it.fails` REDs). No transport code written — held pending the server ingress policy, as agreed.

  **The mechanism, named.** A resync is requested with the y-protocols exchange the transport already speaks: the receiver sends **`SyncStep1`** carrying its state vector, the authority replies **`SyncStep2`** with exactly the structs the receiver lacks (`collaboration-service`: `EncodeSyncStep2(r.doc, info.Body)` in `internal/domain/service/sync.go`, driven from `room.go:965`). Nothing new is needed on either side, and **no new package API is needed either** — `applyRemoteSceneUpdate` already throws through to the embedder and `encodeSceneStateVector` is already exported, so the whole recovery is `catch → encodeSceneStateVector() → transport asks → applyRemoteSceneUpdate(delta)`. Pinned by a test that runs it through the public API only. That keeps the policy in the embedder (`Collab`, the client-web adapter), which is where the session lives, and satisfies the fork's standing rule that customisations come from outside the package.

  **RESYNC, not REPLACE — the requested policy is measurably worse.** Over every truncation offset of a composite logical update (two elements added, one deleted, one moved), **27 of 2114 threw AND mutated**; all 27 converge exactly under a state-vector resync, with acknowledged and unacknowledged local work intact and still publishable. Substituting discard-and-reseed for the resync **loses all 27 unacknowledged edits** — that is the second sabotage, run and recorded. Two-way non-vacuity: removing the resync fails `missingAfter`, and reseeding instead fails `unackLost`.

  Measuring "behind the authority" needed care. Comparing the byte length of `encodeStateAsUpdate(authority, receiverSV)` is WRONG — Yjs always ships the full delete set regardless of the target state vector, so any document with deletions looks permanently behind. The test compares per-client CLOCKS instead.

  **Unacknowledged local edits — what happens to them, and how "acknowledged" is even known.** The protocol has no per-update ack. It does not need one: acknowledgement is read off the authority's state vector — the authority holds our structs `0..n-1` where `n` is its clock for OUR `clientID`, so anything above `n` is unacknowledged. Under the resync policy the distinction turns out not to matter operationally: **both classes survive** (measured `ackLost=0`, `unackLost=0`, and the receiver still publishes back cleanly), because the resync only ADDS the structs we lack and never rewrites our own. The distinction matters only for the rejected policy, which keeps the acknowledged half and drops the rest.

  **A benign detail worth recording**: in all 27 cases the derived scene was already COMPLETE after the partial apply (`derived scene left incomplete=0`) — the missing tail structs were CRDT bookkeeping, not user-visible content, and the Scene's derived cache matched the doc despite the throw. So this class never showed the user wrong content; it left the document quietly behind.

  **THE OPEN HOLE — silent corruption, and it is not ours.** Yjs's binary format carries no integrity check. Exhaustive single-bit corruption of a real 1590-byte update (12 720 trials): **8598 applied WITHOUT throwing**, **258 silently diverged** from the authority, and **134 of those survived a full state-vector resync** — the resync never threw, it just could not help, because the receiver's state vector claims those clocks are already held so the authority's delta omits the real structs. The sting is structural: **the class a resync cannot repair is exactly the class that never announces itself**, so no receiver policy can be triggered for it. Two REDs pin this (`silentlyDiverged`, `unrepairable`). Closing it needs integrity on the wire or validation at ingress — transport/service, not this repo. In production the accidental case is already covered by TLS/TCP integrity; the residual is a malicious or buggy peer, which is the same owner as the poison class.

  **Policy summary — three classes, three owners.**

  | class | announced? | resync repairs? | owner |
  | --- | --- | --- | --- |
  | truncation / partial apply | yes (throws) | **yes, losslessly** | this repo's embedder — `catch` → `SyncStep1`/`SyncStep2` |
  | silent corruption (bit-level) | **no** | **no** (134/258) | transport integrity / ingress — not client-solvable |
  | schema poison | no (fails later, on encode) | no — server checkpoint re-serves it | `collaboration-service` ingress validation |

- [x] T028 **(done — 4 tests, `appStateUndo.test.tsx`)** Green **INV-APPSTATE-UNDO**. Undo/redo writes the reverted collaborative appState through to `yAppState` at `history.ts`, the one point where an undo/redo appState change converges — only the two actions (`actionCanvas`, `actionExport`) wrote through before, and undo does not go through them. Without it the appState mirror pushed the document's stale value back into React state on the next scene update, so the undo silently un-did itself and peers never saw the revert. - **Scoped to the DELTA, not the current state.** Only the keys the entry actually reverted are written, read from `entry.appState.delta.inserted` (`ObservedStandaloneAppState` is exactly `{name, viewBackgroundColor}`). Writing the whole subset instead publishes the background on every element-only undo AND introduces appState into a document that never had any — measured: it fails the zero-traffic test plus two existing history tests, one of which ("should not collapse when applying corrupted history entry") catches it purely as an extra render. - **Two-way non-vacuity**: removing the write-through fails the undo and redo peer cases; writing the whole subset instead of the delta fails the element-only case and the two history tests. - **Coverage across a linked peer** (via `onLocalSceneUpdate`, with delivery counts asserted so an unlinked peer cannot pass vacuously): background undo, background redo, and an element-only undo proving the collaborative appState is byte-identical afterwards. - **`name` claim NARROWED with evidence**, not covered: `changeProjectName` returns `CaptureUpdateAction.EVENTUALLY`, so a name change never becomes its own history entry and there is no name undo to propagate. The write-through is keyed off the delta so it carries `name` if an entry ever holds one, but no action produces that today — pinned by a test asserting the action's capture behaviour.
- [x] T029 **(DONE — gates swept and the gate MAP reconciled)** The live invariant suites and the normal gates pass.

  **Gate sweep, current HEAD**: `typecheck` 0 · `eslint --max-warnings=0` 0 findings · full `vitest` **1620 passed / 86 skipped** across 148 files · `test:headless` 4/4.

  **Prettier — scoped, with the exception named.** Every file this work touches is clean. A repo-wide check reports 5 tracked source files unclean — `textWrapping.ts`, `polyfill.ts`, `harfbuzz-wasm.ts`, `woff2-bindings.ts`, `woff2-wasm.ts` — all **pre-existing upstream drift**: verified `polyfill.ts` was already unclean at `96f9bce3`, the 002 RED baseline, before any work here. `.prettierignore` is empty. Deliberately NOT reformatted: they are upstream files, and rewriting them would manufacture merge conflicts against a repo whose stated process is to minimise divergence.

  **Invariant → live suite map, verified file by file** (not from task names): | invariant | live suite | |---|---| | INV-CONVERGE / INV-NO-RESURRECT | `Scene.convergence.property.test.ts` | | INV-PERSIST-MERGE / INV-SAVE-SKIP | `firebasePersistence.test.tsx` | | INV-COLD-LOAD-LINEAGE | `coldLoadLineage.test.tsx` | | INV-REVEAL | `reappearReveal.test.tsx` | | INV-BOUNDED | `Scene.boundedGC.test.ts` | | INV-WRITE-INTENT / INV-VERSION-MONOTONIC | `Scene.native-yjs-write-intent.test.ts` | | INV-HISTORY-LOCKSTEP | `historyLockstep.test.tsx` | | INV-NO-BINARY-WIRE | `Scene.noBinaryWire.test.ts` | | INV-APPSTATE-UNDO | `appStateUndo.test.tsx` | | INV-ORIGIN | `Scene.originPolicy.test.ts` + `Scene.originPolicyTable.test.ts` | | INV-WIRE-ROBUST | **none — T027, open** |

  **Two map defects found and fixed:**

  - **SC-007 pointed at T010, which does not exist**; the work is T022. `INV-ORIGIN` was also described in plan.md as a lookup table, which T022 explicitly rejected — a table-driven TEST is what the invariant wants, not a runtime table.
  - **T022 deferred "INV-ORIGIN as a table-driven suite" to that non-existent T010**, so the invariant's actual claim — _adding an origin without a declared policy fails the suite_ — was uncovered. The existing case-by-case tests stay green when a fourth origin appears.

  **Closed by `Scene.originPolicyTable.test.ts`** (7): the closed set is enumerated from the module itself and each origin's publish/undo behaviour is asserted against a declared policy. Non-vacuous — adding a `SNEAKY_ORIGIN` export with no policy fails it twice; removing it is clean again. The undo case asserts on the reverted VALUE rather than `undoElements()`'s return, because an untracked write leaves undo free to revert an earlier step, which would prove nothing.

- [ ] T030 SC-003 gate: a fresh FULL adversarial review of the complete HEAD returns ZERO findings of any kind. Ratchet any finding → a new invariant test + back to its phase.

## Analyze (spec↔plan↔tasks consistency — pre-implement gate)

Self-check, re-run after the 2026-08-19 widening. Every FR maps to a task and an invariant test:

| FR | Task | Invariant | Story |
| --- | --- | --- | --- |
| FR-001/002 | T032/T019 | INV-CONVERGE | US1 |
| FR-003 | T021 | INV-PERSIST-MERGE | US3 |
| FR-004 | T020 | INV-COLD-LOAD-LINEAGE | US4 |
| FR-005 | T024 | INV-REVEAL | US5 |
| FR-006 | T025 | INV-BOUNDED | US6 |
| FR-007 | T026 | INV-SAVE-SKIP | US7 |
| FR-008 | T001/T002 | per-task non-vacuity evidence, recorded on each task | — |
| FR-009 | T013/T015/T016 | INV-WRITE-INTENT | US8 |
| FR-010 | T017 | INV-HISTORY-LOCKSTEP | US9 |
| FR-011 | T014 | INV-VERSION-MONOTONIC | US9 |
| FR-012 | T022 | INV-ORIGIN | US10 |
| FR-013 | T023 | INV-NO-BINARY-WIRE | US11 |
| FR-014 | T027 | INV-WIRE-ROBUST | US12 |
| FR-015 | T028 | INV-APPSTATE-UNDO | US13 |

Every SC has a gate, recomputed against live tests:

- **SC-001** → T001 + T032, both landed. The Scene-level N-replica property is sharp (all seeds fail if the encoder rebuilds through a throwaway `clientID`), and the app producer no longer rebuilds — `encodeSyncableSceneAsUpdate` is deleted and INIT/resync encode the live document, with the concurrent per-property loss pinned directly.
- **SC-002** → T002, **NOT satisfied**. 36 multiplayer failures remain, measured on current HEAD. Both recorded leads (T014b, T016b) have since LANDED without moving the count, so there is no standing hypothesis; T016c is closed with zero current producers. Causes remain unattributed and must not be batch-fixed.
- **SC-003** → T030, open: a fresh full adversarial review of HEAD returning zero findings.
- **SC-004** → typecheck, lint (`--max-warnings=0`) and the suite: currently green at 143 files / 1609 passed, headless 4/4.
- **SC-005** → T008 (green) + T016f (DONE). The doc re-read class is fully characterized: 12 sites, 3 retired on a discriminating test, 9 measured and deliberately retained. A raw count was never the metric.
- **SC-006** → T009, green (both halves; the depth-equality wording is falsified and must not return).
- **SC-007** → T022 + `Scene.originPolicyTable.test.ts` (T010 never existed). The origin set is enumerated from the module, so a new origin without a declared policy fails the suite.
