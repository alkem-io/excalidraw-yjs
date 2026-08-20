# Tasks: Native-Yjs Lineage Preservation

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-06-26 · **Widened**: 2026-08-19 (R2 write-path class)

**Strategy** (plan §Migration): suite-first (author each invariant RED against current HEAD, proving non-vacuity), single-owner (one author holds the lineage seam — no parallel-agent edge edits), edge-by-edge (each FR keeps the whole suite + typecheck + lint green before the next). Land on `split/native-yjs-core`, superseding the throwaway-detour code (commit `96f9bce3`, retained as the RED baseline).

**Revised order (2026-08-19): the write path comes BEFORE the wire.** The 34 re-enabled `multiplayer undo/redo` tests gate FR-009/010/011, not FR-001 — so the original order would have gone RED in Phase 1 for reasons the plan never named. Fixing the write path first also deletes 32 bandaid sites, shrinking what every later phase must keep green.

## Phase 1 — RED suite (the deterministic gate, authored against HEAD first)

- [x] T001 **(done — Scene-level convergence gate)** `Scene.convergence.property.test.ts`. N-replica property for INV-CONVERGE / INV-NO-RESURRECT over the `Scene` wire path: 4 replicas × 12 rounds × 5 fixed seeds, each round making unexchanged concurrent edits (move / soft-delete / create), then exchanging in a seeded Fisher–Yates order, roughly half as full-state resyncs and half as state-vector deltas. Asserts identical canonical content fingerprints (id/x/y/isDeleted — semantic convergence, NOT Yjs byte equality) and that nothing soft-deleted returns. Per-seed guards reject a vacuous pass: >20 edits, ≥1 full-state resync, non-empty live set. - **Proven sharp**: all 5 seeds fail when the Scene encoder is made to rebuild through a throwaway `Y.Doc` with a fresh `clientID`. - **SC-001 is now satisfied together with T032** (landed): the app's INIT/resync no longer rebuilds — `encodeSyncableSceneAsUpdate` is deleted and `Collab.encodeSceneAsUpdate` encodes the live document. This task covers the Scene wire path; T032's own pins cover the app producer, including the per-property loss a rebuild causes.
- [ ] T002 **(MEASURED — the failures are recorded; their causes are NOT yet attributed)** Re-enabling `describe.skip("multiplayer undo/redo")` (history.test.tsx:2218) plus the removed `collab.test.tsx` cases. **Measured by un-skipping and reverting: 36 of 37 fail.** - **Measured clusters** (the only established facts): ~24 snapshot mismatches, concentrated in "conflicts in bound text elements and their containers" and "conflicts in arrows and their bindable elements"; ~16 element-shape mismatches; and several history-depth assertions off by one or more (`expected 4 to be 1`, `expected 1 to be 3`). - **T014b is REMOVED as a lead** — it has since LANDED and the failure count did not move (36 before, 36 after; re-measured on current HEAD). Whatever these failures are, meta-version regression is not it.
  - **T016b/T016c remain UNVERIFIED leads only** — intent-scoped result application is plausible given the clusters, but **no failing case has been traced to either**, so neither is a blocker. Keep them as leads until ONE concrete T002 failure traces to them. Trace one concrete failure to a cause before treating that cause as required work. - **T017 is excluded, not merely untraced**: its premise was falsified — a remote apply already contributes zero to both stacks — so no failure here can originate from it. - Do not fix the 36 as a batch; each cluster needs its own attribution first.

  **RE-MEASURED against current HEAD** (after T014b, T021, T023, T026, T032,
  T016k all landed; block un-skipped, measured, re-skipped):
  **36 multiplayer failures remain** — unchanged in count from the original
  "36 of 37".
  - Classified by FIRST reason per test: **9 snapshot, 27 non-snapshot**.
  - **Not directly comparable to the original "~24 snapshot / ~16 non-snapshot"**,
    which counted REASONS (a test can emit several) rather than tests. The honest
    statement is that the count is unchanged and the composition has not been
    re-derived on the same basis.
  - The dominant non-snapshot shape is whole-array equality
    (`expected [ { id: 'id0', … } ] to deeply equal …`), 20 of the 27.
  - Causes still NOT attributed. T014b landing did not move the count, which
    weakens the earlier note listing it as an investigation lead.
- [x] T003 **(DONE — the LIVE gate replaced the old flat-boundary block, which was deleted rather than kept as a baseline)** INV-PERSIST-MERGE against the real path.

  The original block described the pre-T021 flattened boundary and left its three
  acceptance cases `it.skip`, on the grounds that the lineage-bearing API "does
  not exist yet". It does now, so that block is gone and the gates are live:
  - **order independence** — the SAME base/A/B update bytes saved A→B and B→A
    must produce both the same decoded result AND the same stored state-vector
    fingerprint. Converging on values while holding different histories would
    diverge later, so both are asserted.
  - **CRDT idempotence** — saving the identical lineage-bearing update twice
    leaves the stored state vector unchanged, with distinct portals so the
    save-skip token cache cannot be what makes the second save a no-op.
  - the different-property survival case lives with the concurrent-save group.

  **Non-vacuity**: dropping the prior fold fails order-independence and the
  concurrent-save cases — FIVE cases, identically on every run (verified across 3
  runs), because on shared lineage a dropped fold loses the other replica's
  contribution outright with no tiebreak involved. The old `RACE_ITERATIONS = 12`
  loop and its probabilistic rationale are therefore REMOVED: they described a
  `clientID` coin-flip that the shared-lineage fixtures no longer produce, and one
  deterministic case is the stronger test.

  Stated honestly, two cases are NOT fold detectors and are not counted as such:
  idempotence (without a fold the second save simply overwrites with identical
  bytes) and the explicit `isDeleted` conflict (it asserts agreement with a live
  Yjs merge, which is `clientID`-dependent, so it flaps under sabotage by design).

- [x] T004 **(DONE)** INV-COLD-LOAD-LINEAGE — a cold-loaded replica per-property-merges with an INIT-seeded one.

  The editor has two doors into a room and they must produce compatible lineage:
  COLD LOAD adopts the persisted document (T020), INIT SEED receives a peer's
  full-scene broadcast (T032). Before those landed each door minted a fresh
  `clientID`, so two replicas that entered by different doors shared no history
  and their concurrent edits could only resolve by whole-element LWW.

  **Coverage** (`coldLoadLineage.test.tsx`, 3): a cold-loaded and an INIT-seeded
  replica editing DIFFERENT properties of the same element both keep both edits;
  seeding one from the other teaches it NOTHING (same lineage, not merely the
  same decoded values); and a deletion made on one door is not resurrected by the
  other.

  **Non-vacuity by sabotage**: making persistence rebuild the stored document
  from decoded records fails ALL THREE.

  **Scope, stated**: the cold-load side runs through the real
  `saveToFirebase`/`loadFromFirebase`. The INIT side MIRRORS
  `Collab.encodeSceneAsUpdate` rather than calling it (driving the collab layer
  needs a mounted app); that producer is pinned directly in `collab.test.tsx`. So
  these prove the doors interoperate given a faithful seed, not that the seed is
  built correctly.

- [x] T005 **(done — covered by the Store-level case in `reappearReveal.test.tsx`; its "Expected RED (ties at V+1)" is FALSIFIED)** INV-REVEAL. A reappearing element must be re-detected by the editor Store, which retains the synthesized `isDeleted:true` tombstone and gates on `prevElement.version < nextElement.version`. The Store case passes on current code and fails when the reseed is pinned to a constant or to a value equal to the high-water mark, so it is non-vacuous in both directions. The Scene and a peer converge regardless of the seeded version, which is why assertions on them cannot cover this invariant. See T024 for the accompanying finding that no `+= 2` fix is needed.
- [ ] T007 **(RED LANDED — and the dominant defect is NOT the one this task predicted)** INV-SAVE-SKIP (isSaved ⇔ live==stored; no redundant save, no false-skip).

  Two independent breakages, both **measured** through the real save path
  (`firebasePersistence.test.tsx`, `describe("INV-SAVE-SKIP")`, committed as
  `it.fails` so they stay executable and fail loudly once fixed):

  1. **FALSE-DIRTY — every save is redundant. This is the bigger one and it was
     not anticipated.** The version cache is set from the elements returned
     through `restoreElements`, which RENORMALISES versions. Measured: live
     `[a:5, b:5]` (sum 10) is stored as `[a:2, b:2]` (sum 4). The cached sum
     therefore never equals the live sum, so `isSavedToFirebase` is **false
     immediately after a successful save** — every cycle pays a full firestore
     transaction (read + decrypt + merge + encrypt + write), and the
     beforeunload guard permanently claims unsaved work.
  2. **FALSE-SKIP — silent loss.** `getSceneVersion` is a plain SUM, so it
     collides whenever one element's version rises as much as another's falls.
     T014b established versions DO move backwards here, so this is a recorded
     mechanism rather than a contrived collision. Nothing retries a dropped save.

  T026 (dirty flag) is the fix for **both**, and defect 1 is why it should not be
  deferred: it is a live production cost, not just a latent correctness risk.
- [x] T008 INV-WRITE-INTENT (a write through a deliberately stale reference touches only the declared keys; a peer's concurrent edit to another property survives). Cover a simple key, a JSON-leaf (`points`) and a nested one (`boundElements`). **Expected RED** — whole-object flush.
- [ ] T009 **(SPLIT — its three parts are in different states; "Expected RED" was true of none of them as a whole)** - **INV-HISTORY-LOCKSTEP — DONE (T017)**, and its wording here is the falsified one: "history depths in lockstep" cannot hold for a correct editor, because an appState-only step makes a `History` entry with no `UndoManager` item. The invariant is now stated behaviourally in spec.md and covered. - **`meta.version` never regresses — OPEN and BLOCKED (T014b)**, re-verified at current HEAD: the defect reproduces and the blanket fix still breaks ~71 tests. This is the only genuinely open part. - **"a passive remote edit does not wipe the redo branch" — NOT separately covered.** T017 established that a remote apply contributes zero to both stacks, which is adjacent but not the same claim; the redo-branch half needs its own case and an accessor the harness does not expose. Author it against the behavioural formulation, not the depth one.
- [ ] T011 **(SPLIT — one done, one restated, one blocked)** - **INV-APPSTATE-UNDO — DONE (T028)**, covered across a linked peer for undo and redo, with `name` narrowed by evidence. - **INV-WIRE-ROBUST — RESTATED, blocked (T027)**. "An invalid update is rejected without desynchronising" is not achievable by catching: Yjs apply is not atomic on a decode failure, measured at 10 of 1056 truncation offsets both throwing AND mutating. Recovery is discard-the-generation-and-resync, owned by the transport, and is gated on demonstrating the session-loss failure at the real transport boundary. - **INV-NO-BINARY-WIRE — BLOCKED on T023.** A live encode carries image bytes verbatim, and this cannot be fixed by filtering a full-state update.
- [x] T014b **(DONE — FR-011 complete)** The version authority: a stale bulk write can no longer move `meta.version` backwards, and the Store no longer silently drops a real edit.

  **Three mechanisms, each narrowing forced by a MEASURED failure** (the earlier
  rounds' full traces are in the git history of this file):

  1. **No-write rule.** An element contributing zero doc writes moves no
     doc-derived metadata. `symbols` and `boundElementsEmpty` still refresh —
     the latter because the CRDT collapses `boundElements: []` and `null`, so
     that sentinel is the sole carrier of the distinction.
  2. **Content-gated, STRICT-regression bump.** Only `writes > 0 && incoming <
     previousMeta` advances, to `previousMeta + 1`. A TIE must NOT bump: element
     creation is a two-phase structural-add-then-reveal, so meta is already
     stamped when the same version arrives again, and bumping that benign
     re-presentation manufactured a Store-visible change for ONE logical creation
     (measured: 3 ephemeral increments for 2 updates).
  3. **Tombstone-watermark reservation** — the missing authority transfer, and
     the reason (2) alone regressed INV-REVEAL. On a HARD removal the editor
     Store synthesizes its own tombstone at `lastVisible + 1` and retains it, but
     the Scene deleted the id's meta without accounting for that number, so the
     watermark fell behind an invisible Store one and a later reseed collided
     with it (measured: tombstone and reveal both landed on 5, and the Store's
     `prev < next` gate rejected the reveal). `reserveTombstoneWatermark` now
     advances past it at the LOCAL hard-removal sites.

  **Census of every meta-delete site**, classified by whether the Store observes
  an omission:
  | site | reserves? | why |
  |---|---|---|
  | `replaceAllElements` removedIds | **yes** | local hard removal; the Store sees an omission and mints a tombstone |
  | `commitPlan` remove | no | `applyElementChanges`/`commitPlan` has **zero production consumers** — verified repo-wide, only Scene-internal references. Reserving there froze behaviour for an unconsumed API on symmetry alone, and removing it fails nothing. Add it when T016b wires a real consumer and the reappearance property can be driven through that boundary — not before, and not via a synthetic test written to preserve it |
  | `recomputeFromDoc` cleanup | no | the remote/undo path already reserved: `bumpMetaVersionsFor` bumps and raises the watermark BEFORE recompute drops meta, so reserving again would double-advance |
  | `collectGarbage` | no | **not** for the reason first recorded. "The element was already soft-deleted so the Store synthesizes nothing" is FALSE — `detectChangedElements` synthesizes `newElementWith(prev, {isDeleted:true})` for ANY previously-known element missing from the next set, with no check on `prev.isDeleted`, and that increments its version. The real reason is that GC is FINAL structural reclamation with no supported reappearance consumer, so no later reseed can collide with the watermark the Store minted. Any future same-id revival after GC needs its own watermark contract and this exclusion would then be wrong |

  **Results**: the anchoring INV-VERSION-MONOTONIC case is un-skipped and green;
  reappearReveal passes with literal versions (tombstone 5, reveal **6**); the
  creation-tie phantom is gone; full suite 140 files / **1588 passed**.

  **Snapshot changes accepted on the stated criterion**: 194 `"version"` lines
  across 4 files — no geometry, binding or content key changes anywhere — plus
  the 10 `"hasElementChange"` lines (5 flips, `false → true`) that were
  individually adjudicated as CORRECTED recordings: they are all redo-stack
  entries in the bidirectional-bindings group, `hasElementChange =
  !delta.elements.isEmpty()`, redoing an unbind/rebind genuinely changes
  elements, and those tests' behavioural assertions never moved.

  **`textWysiwyg`'s baked-in `version: 2` → `9`**: metadata only. Every semantic
  field (geometry, `boundElements`, `isDeleted`, `updated`) is byte-identical on
  both baselines; the assertion mixed reconciliation metadata into an otherwise
  semantic `objectContaining`. The **+7 is itself a finding**: that flow writes
  the container about seven times with a version behind meta — seven genuine
  stale writes, evidence for the T015/T016 helper work.

  **Non-vacuity**: removing the single landed reservation fails reappearReveal
  with the exact tie symptom, and restoring it fixes it. There is exactly ONE
  reservation call site and exactly one test pinning it — no unpinned behaviour
  was frozen. (An earlier draft also reserved in `commitPlan` on symmetry
  grounds; that was removed, because symmetry is not evidence and the API has no
  production consumer.)

- [ ] T015 Declare intent sets in the side-effecting helpers (`redrawTextBoundingBox`, `updateBoundElements`, `bindOrUnbind`) — see plan R6.
- [ ] T016 **(PREMISE FALSIFIED — re-scope before doing any of this)** The re-read sites are **not** dead code after FR-009 and must not be bulk-deleted. - **Census correction**: 36 `fresh-snapshot` sites across 17 files (16 literal `*Map.get(id) ?? element` idioms), not the 32/14 first reported. - **Why they survive**: FR-009 scoped `Scene.mutateElement`, but `replaceAllElements` is deliberately unscoped — its contract is "make the doc equal this element set", which is correct for a full reconcile. The stale-read revert class therefore survives at the BULK path: a handler that captures the array, lets a side-effect helper write to the doc, then returns its captured array, reverts that write. Proven by `Scene.replaceAll-wholeObject.test.ts` (with non-vacuity guards on both the staleness of the array and the reality of the doc write). Deleting the re-reads would reintroduce exactly the class `b2f708f5` fixed. - **What the earlier "1/32 done" actually was**: not a bandaid removal. `changeFontSize`'s `editedTextIds` carve-out was an _exception_ to re-reading, removed because the font size became a real doc write — the surrounding re-read stayed. Prior claim withdrawn. - **Re-scope**: removing the re-reads requires first changing the bulk path — either scoping `replaceAllElements` to a declared changed-set, or changing how action handlers return arrays so a stale one never reaches it. That is a new requirement, not a cleanup task, and it interacts with T014b (both are about the bulk write path). Decide the bulk-path design before touching any of the 36 sites.

## Phase 2b — Action-result patch semantics (FR-016) — precedes History lockstep

Two independent findings (T014b's meta regression and T016's surviving revert class) both land on the unscoped bulk write path, so it is the next real work.

- [x] T016a **(done)** `ActionManager` captures a real COPY of the element array at invocation and preserves it alongside the promise (`ActionFn` may be async). A bare reference is not a stable "before" image — `Scene.mutateElement` mutates the passed scratch before re-derivation. **A top-level spread is NOT sufficient**: it leaves nested persisted fields (`points`, `groupIds`, `boundElements`, `roundness`, `scale`, `crop`, `customData`) aliased to the live object, so they mutate underneath the "before" image and diff as unchanged. Copy every persisted field the diff reads, and preserve reconciliation/own-Symbol metadata deliberately — `structuredClone` does not carry symbol-keyed metadata.
- [x] T016b-i **(diff done)** `computeElementIntent` / `diffElementKeys` in `packages/element/src/yjs/intent.ts` — presence-aware, `Object.hasOwn`, `id` + RECONCILE_META_KEYS excluded, 9 tests incl. a no-op-derives-nothing guard and a non-vacuity proof that a value-only diff misses the transitions. Pure function, wired to nothing yet.
- [x] T016b **(DONE — the synchronous action write path)** An action's result is applied as a DIFF against the snapshot it was invoked on, onto whatever the document holds now, with explicit ownership wherever the action and a helper it invoked wrote the same key.

  **Why the authoritative path was wrong.** `syncActionResult` fed
  `scene.replaceAllElements(result)`, whose contract is "make the doc equal this
  set". A side-effecting helper (`redrawTextBoundingBox`, `updateBoundElements`,
  `bindOrUnbind`, the flip repositioners) writes to the doc DURING `perform`,
  and the array the action returns can predate those writes — so applying it
  authoritatively reverted them. Measured through production actions, not
  hypothesised.

  **The mechanism, in three parts.**

  1. **Invocation base.** `ActionManager.updater` already carried
     `invocationBase` (T016a) and `syncActionResult` discarded it. It now accepts
     it and, when present, routes to
     `scene.applyElementChanges(base, result, …)`; callers without a base keep
     the authoritative path.

  2. **Action mutation journal.** `Scene.beginActionMutationJournal()` /
     `endActionMutationJournal()` record which keys each `scene.mutateElement`
     call DECLARES, per id, for the synchronous span of one action. The
     `updates` object already IS the writer's explicit declaration AND the actual
     write source, so journaling it cannot drift from a hand-maintained list.
     Keys are filtered through `isIntentKey`, the same selector intent derivation
     uses, so a broad element object cannot turn `id` or reconciliation metadata
     into ownership. A key is recorded even when the value already matches —
     declaring it is a claim regardless of what the doc held.

     Deliberately SEPARATE from `beginLogicalMutation`: that is a generic
     transport primitive, and making every logical boundary imply intent capture
     would couple transport buffering to action semantics. Nested scopes join;
     the journal is created at the outermost begin and discarded at the matching
     end; an unbalanced end THROWS.

  3. **Fail-closed ownership.** A key claimed by BOTH the derived diff and the
     journal, where a scoped write would actually change the document, is
     AMBIGUOUS — the action may be overriding the helper, or its value may be
     stale, and nothing may guess. Every such key must be covered exactly once:
     Ambiguity applies to DERIVED intent only — an explicit `declaredIntent` IS
     the ownership statement, so naming a key in `keysById` means the action owns
     it. For derived intent there is exactly ONE channel: `overlapPolicy`, a
     per-KEY policy applied only to keys that are genuinely ambiguous, for a
     caller that knows its rule but cannot know which ids will conflict before
     the journal exists. Anything uncovered **throws before any mutation**,
     naming every unresolved `id.key`; an unknown choice throws; rejection leaves
     the state vector unchanged.

  **One comparison authority.** `wouldWriteChange(ymap, element, key)` in
  `schema.ts` is the single mutation-free predicate for "would a scoped write of
  this key change the document" — presence/`undefined` handling, `boundElements`
  set-diff, `deepEqual` for JSON leaves, strict identity otherwise.
  `writeChangedKeys` and ambiguity detection both consult it, so they cannot
  diverge. (A `JSON.stringify` comparison is NOT equivalent: key-order sensitive,
  and it collapses presence distinctions.)

  **Production ownership.** Only flip declares one: `FLIP_OVERLAP_POLICY` maps
  the geometry keys to `applied`, because `flipSelectedElements` repositions
  elements and their bound texts/arrows THROUGH THE DOC and then returns the
  pre-flip array. No action-name branch exists in `Scene`.

  **Two rereads removed, both proven necessary to remove:**
  - `actionFlip`'s post-flip whole-object reread — its stale `selectedElements`
    clobbered helper geometry;
  - `actionBoundText`'s wrap reread — it replaced the just-reindexed text with
    the live doc version still carrying the OLD index, turning `syncMovedIndices`'
    distinct `a1`/`a2` into a tie at `a1`. Measured at four points.

  **Gates**: both flip suites; the text order/z-index assertion; the observable
  delete-binding gate (converged state locally AND at a linked peer, one undo
  step); one transport update per action; `Scene.mutationJournal.test.ts` (12).

  **Non-vacuity, every branch**: dropping a flip policy key throws naming
  `arr.x, rec1.x, rec2.x`; inverting `applied`→`result` produces the real flip
  regression; sabotaging the delete's owning `mutateElement(startBinding)` site
  fails the delete gate; restoring either reread fails its own gate.

  **Snapshot movement, in TWO classes** — an earlier report said "exactly 10
  lines across 3 files" and was INCOMPLETE, because
  `git diff -- '*__snapshots__*'` does not cover INLINE snapshots living in
  `.test.tsx` files:
  - **File snapshots**: 10 lines across 3 files — 6 `version`, 4 `versionNonce`.
    Zero `updated`, `hasElementChange`, geometry/binding/content, membership/order.
  - **Inline snapshots**: 7 `renderStaticScene` CALL-COUNT values in
    `linearElementEditor.test.tsx`, every one a REDUCTION
    (7→6, 9→7, 7→6, 7→6, 10→7, 9→7, 7→6). These count React renders, not
    content. Fewer renders is the expected consequence of writing only declared
    keys instead of flushing whole objects — the same cause as the version
    reduction — and no assertion about element content, order or binding moved.

  The `textWysiwyg` geometry assertion no longer pins a version: measured across
  both apply routes the doc write SET is identical, so the difference was
  accumulated in-memory version, not lost content.

- [x] T016c **(CLOSED — no current producer; the rule lives at the boundary)** Async action results.

  **Census, re-audited by brace-matching every `perform: async` body and
  inspecting only `return { … }` sites: ZERO async performs return an
  `elements` field** (`actionElementLink` ×1, `actionExport` ×3,
  `actionClipboard` ×4 — none returns elements). Earlier notes claiming one were
  wrong; that count came from matching `prepareElementsForExport` ARGUMENTS.

  There is therefore no async producer to build machinery for, and none is
  built. The durable rule is recorded at the `ActionResult` boundary instead: a
  future async element result CANNOT use the synchronous derived/journal
  fallback, because `ActionManager` closes both the transport boundary and the
  journal scope before the promise resolves. Such a result must supply explicit
  intent/ownership, or be rejected. Reopen only against a real producer.

- [ ] T016e Integrate **T014b** here — this write path is the right integration point, but **the mechanism remains an OPEN, RED-first problem and must not be assumed solved by it**. Correction of an earlier claim: the narrowed experiment already tried `writes > 0 && record.version <= prevMeta ? prevMeta + 1 : record.version` — i.e. it was ALREADY scoped to ids whose doc properties actually changed — and it still broke transform snapshots. So "unchanged elements caused the 68 snapshot failures" is **unproven**, and patch semantics cannot be presumed to fix them. Patch semantics may well remove stale/unintended writes and shrink the failure set, but that has to be MEASURED: re-run the genuine raised-meta regression test plus the semantic failures and reclassify from scratch. Do not carry the blanket-fix explanation forward.
- [ ] T016f **(OPEN — this slice removed TWO of the sites, not the family)** Revisit the remaining re-read sites, retiring each only where patch mode proves it redundant AND a test discriminates.
  - Removed so far: `actionFlip`'s post-flip whole-object reread, and `actionBoundText`'s wrap reread. Both were proven by a failing production test, not by inspection.
  - **Measured, per invocation, across the six families that call side-effecting helpers**: `flip:163` 63 reached / 2 semantic; `boundText:184` 25 / 10 (`boundElements`); `boundText:358` 14 / 3 (`index`); `props:319` 9 / 1; `props:1107` and `props:1379` 8 / 0 each; `align:83` and `distribute:77` **never reached — unknown, not clean**; `actionStyles`' is already narrow (copies only `width`/`height`).
  - A semantic difference is NOT an observable defect: `boundText:184` and `boundText:358` can each be deleted with the suite still green. Do not retire a site without a test that fails when it returns.

**Design note (do not lose):** a base→result diff is a sound migration default but is NOT the definition of intent. "Explicitly set a key to the value it already had in base" is invisible to a diff yet must still beat an interleaved remote write — the same asymmetry FR-009 fixed one layer down. Derive for synchronous actions in the interim; the durable contract carries explicit per-id key sets plus membership intent.

## Phase 2c — Headless Node entry (`@excalidraw-yjs/element/headless`)

- [x] T017a **(done)** `src/headless.ts` — DOM-free export surface (omits `renderElement`, `elementLink`, `visualdebug`, and `store`/`delta`, which self-import the barrel). Second esbuild entry so the subpath resolves to its own bundle (226 KB vs the barrel's 277 KB) rather than the `./*` wildcard sending it back to `index.js`. Exports subpath declared BEFORE the wildcard so it wins.
- [x] T017b **(done, then REPLACED)** The first version walked the import graph and pattern-matched DOM access at brace-depth zero, with special cases for `typeof x !== "undefined"` guards and arrow-function bodies. That approximated something the runtime answers exactly, produced false positives on lazily-evaluated lambdas, and each fix made it a worse model. **Deleted, not extended.** Replaced by `scripts/headless-smoke.mjs` (`pnpm run test:headless`): a bare Node process importing the BUILT bundle and driving the real workflow. The import itself is the assertion for module-scope DOM; a call-time read throws when the call is made. It cannot live in vitest because the suite runs under jsdom with a global setup defining `window.matchMedia` / `document.fonts`, so it cannot observe a missing DOM.

- [x] T017c **(done, pre-existing defect)** `@excalidraw-yjs/common` imported `@excalidraw-yjs/math` at runtime without declaring it — the published package was unresolvable for any consumer. Declared. **Still outstanding: `@excalidraw-yjs/utils` has the same defect for `common`/`element`/`math`, not fixed because declaring `element` would create an `element ↔ utils` cycle — needs a decision.**
- [x] T018 **(CLOSED — the headless entry works end to end)** Root cause was a single character-class of bug, not a structural one: `Scene.ts` read `window?.DEBUG_FRACTIONAL_INDICES` on the fractional-index validation path. **Optional chaining guards a NULL value, not an UNDECLARED identifier**, so the bare `window?.` still throws `ReferenceError: window is not defined` in Node — every element write failed for a headless consumer, over a debug flag. Fixed to `globalThis.window?.`, which is a property access on a defined object. `pnpm run test:headless` now reports 4/4: imports in bare Node, exports the server surface, omits the browser-only surface, and adopts a `Y.Doc` → writes elements → mutates per-property → emits updates → encodes state.

- [x] T018b **(done)** `ExcalidrawImperativeAPI` exposes the collaboration transport — `onLocalSceneUpdate` / `applyRemoteSceneUpdate` / `encodeSceneAsUpdate` — delegating to the `Scene` methods that carry the origin policy. The raw `Y.Doc` is not reachable from the public API, so the policy cannot be bypassed. `Collab.tsx` consumes that boundary and holds no filter of its own; it imports neither `yjs` nor any origin sentinel. Coverage for every transport invariant lives at Scene level, including a remote appState apply producing no outbound update (which guards the `yAppState` observer against a write-back loop).
- [x] T018a **(done)** Corrected the Scene API surface published to consumers. The method is **`encodeStateAsUpdate(...)`** (plus `encodeStateVector()`, `encodeSnapshot()`), NOT `encodeAsUpdate()`. **Verified against the RED baseline, not just against HEAD**: `encodeAsUpdate` never existed at any point — `96f9bce3` already declared `encodeStateAsUpdate` (1049), `applyRemoteUpdate` (1035), `encodeStateVector` (1062), `encodeSnapshot` (1203). So this was purely a prose error in `plan.md`, and the name relayed to the server team would never have resolved. Line numbers in that sentence were also drifted (they pointed into method bodies rather than declarations) and now cite the baseline declarations, per this spec's convention that cited lines resolve against `96f9bce3`. **Server-facing consequence**: anyone who took `encodeAsUpdate()` from the plan needs the corrected name; flagged for the next hand-off rather than assumed harmless.

- [x] T016j **(DONE — scoped index validation, and the tie's real cause)** `applyElementChanges` validates fractional indices for AFFECTED records only.

  **Contract**: validate the records this mutation affects — creations, and
  existing ids whose declared keys include `index`. Format only: present and
  parseable. A relational TIE is not rejected and not repaired here; it belongs
  to the caller that knows the intended array order. An element absent from the
  result is never inspected.

  **Measured census** over the whole suite: 3225 valid / 2 invalid / 76 missing
  across 3303 `replaceAllElements` calls. `syncActionResult` itself is 1573 valid,
  2 invalid, **zero missing**. The only production callers passing a missing index
  are `new Scene` and the public `updateScene`, both authoritative, both keeping
  `syncInvalidIndices`. A strict whole-array prevalidation would have rejected
  two real action results.

  **The 2 "invalid" are DUPLICATE indices, both from `wrapTextInContainer`**, each
  a newly added element tying a pre-existing one. `orderByFractionalIndex` breaks
  ties by element id, so they order deterministically — but deterministically is
  not correctly: for n=3, accepting the tie puts the container ABOVE its text and
  inverts the intended z-order.

  **Cause, measured at four points** on the failing path with authoritative
  repair disabled:
  ```
  before syncMovedIndices : id1@a0, id6@null, id3@a1
  after  syncMovedIndices : id1@a0, id6@a1,   id3@a2   <- distinct, correct
  before reread           : id1@a0, id6@a1,   id3@a2
  after  reread           : id1@a0, id6@a1,   id3@a1   <- TIE
  ```
  `syncMovedIndices` produces a correct tie-free assignment but writes it to the
  SCRATCH object, so the doc still holds the text's old `a1`; the reread then
  replaces every element present in the doc and discards the generated index,
  while the new container survives via `?? element` because it is not in the doc
  yet. This is the reread class (T016f), not a fractional-index defect — which is
  why the fix is removing that reread (done in T016b) rather than a tie resolver.
  `includeBoundTextValidation` is unrelated and unchanged.

- [x] T016k **(done — the action owns the broadcast)** One editor action reaches a peer as ONE transport message. `ActionManager.executeAction` opens a logical mutation around the synchronous span (`perform` through `syncActionResult`); inner `Scene` boundaries JOIN it, so only the outermost close publishes. - **Measured on `wrapTextInContainer`**: `senderUpdates=1, peerStates=1, dangling=[], undoDepth=1`, against a baseline of 4 / 4 / 2 dangling container references. `actionAtomicity.test.tsx` is un-skipped. - **Scope of the guarantee, stated precisely**: it is a TRANSPORT guarantee. The sender's own Scene/Store callbacks may still fire several times locally, and no test claims otherwise. - **Async is delimited, never spanned**: the updater registers a promise continuation and returns, so the boundary closes before an async result lands and the buffer is never held across an `await`. An async action gains nothing from it and is unchanged. - **A throw mid-action still publishes** whatever Yjs already committed — those bytes are in the document, and withholding them would diverge the peer permanently. Balanced closes live in `finally`. - **Boundary rules pinned**: nested join (only the outermost publishes, and its single message carries the final state), throw-after-write publication, a no-write boundary publishing nothing, and closing without opening throwing.
- [x] T017 **(closed by reconciliation — the behavioural contract holds; no fix was needed)** Measured through the real public path (`excalidrawAPI.applyRemoteSceneUpdate`, what `Collab` calls), a remote apply contributes ZERO to both stacks. The task's premise — that it currently contributes a history entry — is false, and a `NEVER` micro-action written to "fix" it changed the numbers not at all, so it was reverted rather than shipped. - **The invariant is restated behaviourally, not as stack depths.** `History` and the `UndoManager` legitimately differ: an appState-only step makes a `History` entry with `hasElementChange: false` and no `UndoManager` item. A depth-equality assertion would fail for a CORRECT editor, which is why the old skipped test was not evidence of a defect. A pairing claim (`hasElementChange` entry ⇔ `UndoManager` item) was considered and NOT adopted — it is another cardinality claim, and `history.ts:153` only calls `stopElementCapture()` to seal a step, which does not by itself guarantee a one-to-one relationship under coalescing. - **Coverage of the three behavioural requirements**: (1) a remote apply adds no locally undoable step — `historyLockstep.test.tsx`, new, non-vacuous (applying the remote update under `LOCAL_ORIGIN` instead fails it); (2) the next local undo affects only the local action and both replicas converge — `Scene.native-yjs-collab.test.ts` origin-scoped undo, which asserts peer content and matching state vectors; (3) appState-only local history stays undoable without an element item — `appStateUndo.test.tsx`, where a background change is appState-only and undoable end to end.
- [x] T032 / T025b **(DONE — landed together as one slice)** The INIT/resync wire encodes the LIVE scene doc; maintenance runs immediately before it and the encoder stays PURE.

  **Producer re-confirmed before changing anything**: `Portal.broadcastSceneInit`
  (on `new-user`) and `Portal.broadcastSceneResync`, both via
  `Collab.encodeSceneAsUpdate`. No other producer.

  **What changed.** `encodeSceneAsUpdate` previously rebuilt the scene through a
  throwaway doc (`encodeSyncableSceneAsUpdate`), giving every join/resync a fresh
  `clientID` and destroying CRDT lineage (~50% concurrent-edit loss, ~50%
  deletion resurrection per resync). It now runs
  `collectSceneGarbage({ deletedBefore: Date.now() - DELETED_ELEMENT_TIMEOUT })`
  and then encodes the live doc. Two new API methods —
  `encodeSceneStateAsUpdate` (pure) and `collectSceneGarbage` — kept separate on
  purpose: an encoder that pruned on encode would make reading the state
  destructive, and the resync timer would then quietly drive deletion.

  The rebuild existed to keep two things off the wire, and both have better
  answers now: aged tombstones are reclaimed from the DOCUMENT by maintenance
  rather than filtered out of one encoding of it, and since T023 the document
  carries `fileId -> locator` and never bytes, so there is nothing to strip.

  **T019 folded in**: `encodeSyncableSceneAsUpdate` is deleted, now that it has
  no production caller. Stale comments in `Portal`, `Collab` and the convergence
  property test that described the old rebuild were corrected rather than left
  to mislead.

  **Coverage** (`collabWireFilter.test.tsx`, 7): the original filtering
  invariants, repointed at the live path (they survive; the MECHANISM changed),
  plus a resync of unchanged content teaching an up-to-date peer NOTHING (state
  vector unchanged) and a peer's concurrent edit surviving a resync.

  **Non-vacuity**: restoring the throwaway-doc rebuild fails the lineage pin AND
  the property-level pin below.

  **The loss this task exists to prevent is now pinned directly** (added after
  review; the first attempt did not cover it). Through the production
  `Collab.encodeSceneAsUpdate`: seed a peer, then have sender and peer edit
  DIFFERENT properties of the SAME element, then apply the sender's full resync —
  both must survive. Per-property merge keeps both; whole-element LWW keeps one.
  The peer's `clientID` is pinned to 1 so the sabotage loses reliably: Yjs
  assigns random 32-bit client ids, so a rebuilt seed outranks 1 with probability
  1 − 2⁻³², where an unpinned tie would make the sabotage a coin flip. Verified
  failing on 3 consecutive sabotage runs and passing when restored.

  **MEASURED — the extra broadcast when maintenance actually removes something**
  (raised in review; recorded rather than "fixed" speculatively). `collectGarbage`
  writes under `STRUCTURAL_ORIGIN`, which is published, so a sweep that reclaims
  anything emits **one** additional local scene update — measured directly
  (`localUpdateEmits=1` for a sweep that removed a tombstone, 0 sends otherwise).
  During collaboration that becomes one incremental GC update on the socket,
  ordered BEFORE the full INIT/UPDATE seed, because maintenance runs
  synchronously before the encode. So a resync that sweeps is 2 sends, not 1.
  They commute (the seed already reflects the sweep), so this is redundant
  traffic, not a correctness problem, and it only occurs when something was
  actually reclaimed. **Accepted as-is**: suppressing it would mean either a
  second origin filter or an impure encoder, both worse than the occasional extra
  message. **Harness limit stated**: the count was measured at the Scene-update
  boundary, not at `Portal`, because the probe was not in a collaborating
  session — the socket-level count is inferred from the subscription, not
  observed.

  **MEASURED test-environment artifact, recorded because it bounds what the
  suite proves.** Deletion markers are stamped from the element's `updated`, and
  the harness mocks `getUpdatedTimestamp()` to a constant `1` for deterministic
  snapshots. Every tombstone therefore carries marker `1`, and the PRODUCTION
  cutoff reclaims all of them — measured. The tombstone-window case moves the
  cutoff instead of the clock, so the window invariant is covered.

  **Contract**: the wire seed prunes with `Date.now() - DELETED_ELEMENT_TIMEOUT`
  and maintenance runs BEFORE the encode — pinned in `collab.test.tsx` against
  the production `Collab.encodeSceneAsUpdate`. Non-vacuous in both directions:
  passing `Date.now()` fails it, and so does swapping the order. Between the two
  files the path is covered — window semantics where realistic markers are
  impossible, arithmetic and ordering where they are not needed.

- [x] T019 **(DONE — folded into the T032/T025b slice)** `encodeSyncableSceneAsUpdate` deleted once it had no production caller; Portal INIT and resync both confirmed to ship live state.

- [x] T020 **(DONE — one slice: docBytes + native initial-data adoption + record application removed at that branch)** Cold-load adopts stored bytes via `applyUpdateV2` into the Scene doc, not decode→records→rebuild. Green **INV-COLD-LOAD-LINEAGE**.

  **Shape (reviewed and approved before implementing).** `initialData` now takes
  two MUTUALLY EXCLUSIVE forms as a discriminated union — the record form
  (`elements`/`files`, `encodedScene?: never`) and the native form
  (`encodedScene: { update, format: "v2" }`, `elements`/`files` forbidden). The
  union makes mixing them a type error; a runtime guard fails loud for untyped
  JS callers. `loadFromFirebase` returns `docBytes`; `App.initializeScene`
  applies them to the CURRENT scene and derives elements, persisted appState and
  asset locators from it, and does NOT then apply a record element array.

  **Adopt, never replace.** The stored update is applied into the existing
  generation. A remote update can arrive while the persistence fetch is pending;
  replacing the Scene afterwards would discard it, so there is deliberately no
  `replaceSceneGeneration` on this path.

  **Origin.** Reuses `REMOTE_ORIGIN` unchanged — adoption is externally-sourced
  durable state, which wants exactly its semantics (non-undoable, never
  rebroadcast). A new origin would rename the source without changing behaviour.
  `applyRemoteUpdate`'s doc was corrected from "a remote peer's update" to
  external update (peer **or** adopted durable state).

  **appState precedence.** Collaborative keys come from the doc and beat the
  caller; a caller override may only touch local UI keys. Overriding `name` or
  `viewBackgroundColor` through initial data would produce a value no peer sees.

  **Coverage** (`packages/excalidraw/tests/encodedSceneAdoption.test.tsx`, 6):
  lineage adoption, Scene-level merge, appState precedence, asset resolve-only,
  fail-loud on both forms, legacy record form unchanged.

  **Non-vacuity, proven by sabotage**: replacing the adoption with a
  record-rebuild (`new Scene()` → `replaceAllElements`) fails 4 of the 7 tests,
  including the lineage pin and the app-level race. Recorded honestly in the
  file: the Scene-level merge test drives `Scene.applyRemoteUpdate` directly, so
  it does NOT exercise the initialData branch and survives that sabotage.

  **The app-level race IS covered** (added after review, which supplied the
  recipe). The first attempt at it did not work — the `excalidrawAPI` callback
  never fires in this harness (measured: `apiFired=false` both before and after
  resolution). But `h.app`/`h.scene` ARE live while `isLoading` is still true
  (measured), so the race stages by holding `initialData` unresolved, applying a
  peer update into the mounted generation, then resolving with `encodedScene`.
  Both the in-flight and stored elements must survive, with a guard asserting
  the in-flight edit was present BEFORE adoption.

  **Found while doing it**: the fail-loud guard, placed after
  `initializeScene`'s try/catch, escaped as an UNHANDLED REJECTION rather than
  reaching the user — loud in a console nobody reads, invisible in the editor.
  Moved inside the try so the existing catch surfaces it as `errorMessage`, and
  the test now pins the surfaced message plus the fact that NEITHER form was
  applied.

- [x] T021 **(DONE)** `encryptScene` `applyUpdateV2`-folds prior + live over SHARED lineage and encodes that. `mergeStoredElements` + `isExpiredTombstone` deleted. Green **INV-PERSIST-MERGE**.

  **The blocker cleared itself.** This was blocked because the boundary took flat
  elements carrying no lineage, and because the stored doc was REBUILT on every
  save (fresh `clientID`), making a Yjs fold whole-element LWW across disjoint
  lineages. Both premises are now false: T032 made the wire ship the live
  document, T020 made cold load adopt the stored one, and T023 settled assets as
  locators. So `saveToFirebase(portal, docUpdate, contentToken)` now takes the
  live document itself — everything else (elements, references, persistable
  appState) already lives on it — and the fold is the CORRECT merge while the
  value merge became the lossy one.

  **What the fold buys, measured**: two replicas from ONE shared base editing
  DIFFERENT properties of the same element now BOTH survive a concurrent save.
  Whole-element LWW could only take one side entirely. Same-property conflicts
  resolve by `clientID` — the same resolution the live socket gives — so
  persistence no longer has merge semantics of its own to disagree with.

  **A claim I wrote and had to correct.** The obvious justification — "Yjs unions
  delete sets, so deletions survive" — is FALSE here. Excalidraw deletes SOFTLY:
  `isDeleted` is an ordinary property, not a Yjs delete, so the delete set is not
  involved. Deletions survive because the write is normally UNCONTESTED (the other
  replica edits geometry or colour and never touches `isDeleted`). The residual
  genuine conflict — one replica deleting while another undoes a deletion —
  resolves by `clientID`. Both are now stated precisely in the code.

  **The test harness was the real work.** The existing FINDING #2 cases built each
  side with `new Scene()`, i.e. DISJOINT lineages — a situation no production path
  produces, since the stored doc descends from a live doc and every peer's doc
  descends from the room seed. Folding those really is whole-element LWW, so the
  cases were measuring an impossible scenario. They are rebuilt on `sharedBase` +
  `replicaFrom`, which is the "two real Scenes derived from ONE shared update"
  gate T003 said was needed. The persistence save helper now builds a real
  lineage-bearing document too.

  **Non-vacuity by sabotage**: dropping the prior fold fails 3 cases — disjoint
  adds, the per-property merge, and the stored-side deletion.

  **Maintenance on the merged result**: the fold can reintroduce tombstones the
  live scene had already swept, so `collectGarbage` runs on the merged document
  before encoding, mirroring the wire path.

## Phase 7 — Origin policy + binaries off the wire (FR-012, FR-013)

- [x] T022 **(done)** The origin→wire policy has exactly ONE implementation, in `Scene.onDocUpdate`. No shared lookup table: with a single call site it would be indirection, not deduplication. Pairing a structural tombstone with its reveal is the logical-mutation boundary's job, not the origin table's. **Still open**: INV-ORIGIN as a table-driven suite (T010).
- [ ] T023 **(PARTIAL — core boundary landed; NO consumer may bump)** The document carries `fileId -> opaque locator`, never bytes written by this editor. - **What is guaranteed, narrowly**: supported writers publish only validated, bounded locator strings; the whole batch is prevalidated so one bad value writes nothing; decoders and a full-state egress check (`assertAssetRootValid`) reject a malformed asset root instead of serializing it; no path turns a failed upload into inline data; async adapter results cannot overwrite newer state. - **What is NOT guaranteed**: a universal "no bytes can enter Yjs". A remote peer can put an arbitrary value in the asset root — as it can in any element property — and it persists in CRDT history. Closing that needs an ingress trust decision across the whole accepted schema, not an asset-only guard, and is NOT done. The `data:` check targets the known retired fallback; `MAX_ASSET_LOCATOR_BYTES` is a schema bound, not a binary exclusion, since a short base64 string without the prefix is indistinguishable from a token. - **Failure contract, narrowly**: a failed `store` retains the image locally and publishes nothing, and is retried on a LATER PUBLISH PASS (when files are next added). There is no autonomous retry, no backoff, no observable failure state. - **BLOCKERS before any consumer bumps**: (1) cold load discards the stored references so a persisted image never resolves — needs T020's doc adoption, RED committed skipped; (2) the ingress/rolling-client decision above; (3) client-web must supply an adapter and delete its `dataURL` fallback. - **`MAX_ASSET_LOCATOR_BYTES = 2048`** is a starting value, not derived from a measured consumer; a host with long signed URLs may need it raised deliberately.
- [x] T025b **(DONE — landed with T032; see that entry)** The explicit maintenance call sits immediately before the real INIT/resync encode, and the encoder is PURE. No scheduler, no timer.

- [x] T026 **(DONE — the task's stated design was wrong in two ways and was corrected before coding)** Replace the `getSceneVersion`-sum cache. `isSaved ⇔ nothing changed since the last successful save`. Green **INV-SAVE-SKIP**.

  **Two corrections to the task as written**, both agreed with the reviewer:
  - *Not LOCAL_ORIGIN-scoped.* A peer's edit applied under `REMOTE_ORIGIN`
    leaves the durable store just as stale as a local one, and this replica may
    be the one that has to persist it. `Scene.contentRevision` counts
    transactions from EVERY origin — local, structural, remote, UndoManager —
    and covers all doc roots (elements, asset references, appState, the deletion
    sidecar), not elements alone.
  - *Not a boolean.* A bare dirty flag cannot survive an async save: a change
    landing mid-flight would be cleared by the save that never included it. The
    token is a monotonic counter; a save captures revision R with the exact state
    being saved and records only R on success. Anything that moved the doc
    meanwhile left the live revision past R, so the scene correctly stays dirty.
    A failed save records nothing.

  **Implementation.** `Scene.contentToken` is replaced from an
  `afterTransaction` handler — deliberately not `doc.on("update")`, which would
  make Yjs encode a v1 update on every transaction when this needs no bytes.
  Exposed as `getSceneContentToken()`. `FirebaseSceneVersionCache` became
  `FirebaseSavedRevisionCache`; `isSavedToFirebase(portal, token)`.
  `getSceneVersion` remains a field of the stored document but is no longer the
  skip authority.

  **A THIRD correction, found in review after the counter had landed — and it
  was a real defect, not a style note.** The token started as a monotonic
  NUMBER, which is only monotonic *within one Scene*. The persistence cache is
  keyed by socket and so outlives a Scene: a reset replaces the generation
  underneath it, the new generation counts from zero, and it reaches numbers the
  old one already used — so a save of the old generation marks the new one
  clean. Measured before the fix: two independent scenes both reached revision
  2. Worse, an old generation's in-flight save can complete after replacement
  and cache a number equal to the new generation's.

  Fixed at the root with an opaque identity token rather than an offset: a
  frozen object, replaced on every persisted-doc-changing transaction, compared
  only by `===`. A fresh Scene is distinct from every other even at zero edits.
  The type is nominally branded, so passing a number where a token belongs is
  now a compile error rather than a silent collision.

  **Coverage**: `Scene.contentToken.test.ts` (10) — remote apply, asset-only,
  appState-only, delete/undo/redo, the version-sum collision, adopted docs, that
  local UI state which never reaches the doc does NOT dirty, that two generations
  never match, and that a captured token survives intervening reads.
  `firebasePersistence.test.tsx` `INV-SAVE-SKIP` (7) — clean after save,
  redundant save skipped, in-flight change stays dirty, FAILED save stays dirty
  and the retry then succeeds, sum-collision cannot false-clear, unknown socket
  is dirty rather than saved, plus a generation-swap pair: a replaced generation
  is never reported saved, and an OLD generation's late-completing save cannot
  clean the new one.

  **Non-vacuity, proven by sabotage**: reverting the token to the summed version
  fails 3 of the Scene tests including the collision case; reverting it to a
  per-Scene numeric counter fails the generation pins — the Scene-level one and
  BOTH firebase-level ones. The
  failed-save test asserts the write really failed rather than asserting against
  a save that quietly succeeded — the first draft did the latter and was vacuous
  (measured: `failedSave=false`).

  **Deliberately NOT done, and why.** The cold-load path no longer marks the room
  saved. Since T020 a cold load ADOPTS the stored document, and that adoption is
  itself a doc-changing transaction occurring after `loadFromFirebase` returns,
  so no revision available there corresponds to the post-adoption scene. The
  reviewer's richer rule (adoption may establish a clean baseline *only if* the
  fresh generation was clean, staying dirty if a remote update landed during the
  fetch) is a real improvement and is NOT implemented — deferral reviewed and
  approved as a bounded follow-up, not a blocker. Cost of the omission is
  one redundant save after a cold load — the harmless direction. Guessing a
  baseline would risk the dangerous one: a false-skip, which is silent data loss
  with nothing to retry it.

- [ ] T027 **(REVERTED — its central premise is FALSE; blocked behind generation-replacement)** The first attempt wrapped `applyRemoteUpdate` in try/catch, logged, and returned a boolean, justified as "an unguarded throw wedges the collaboration session". Decorrelated review rejected it and was right on the decisive point. - **MEASURED: Yjs apply is NOT atomic on a decode failure.** Over every truncation offset of a real 1057-byte delta, **10 of 1056 both THREW and left the doc MUTATED** — all of them near the tail, which is exactly what a dropped connection produces. Inspected concretely, one such case integrated four new elements while the file, the deletion marker and the property edit belonging to the SAME logical update never arrived: a partially-applied, internally inconsistent doc. The measurement's own control passes (fingerprinting the same doc twice is identical), so the mutations are real, not an artifact of non-deterministic encoding. - **Therefore catch-and-continue is not merely unproven, it is HARMFUL**: it would carry on with a maybe-corrupt doc and hide the corruption, which is strictly worse than failing loudly. The earlier "doc unchanged" assertions compared element ids and encoded byte LENGTH — equal length is not equal state, and they ignored files, appState, the deletion sidecar and delete sets entirely. That is how a false premise passed as verified. - **Reverted**: `applyRemoteUpdate` throws again, with the measurement recorded at the call site. `Scene.wireRobust.test.ts` now pins the two MEASURED facts (malformed bytes throw; an all-zeroes payload is a valid empty update and is accepted; apply is non-atomic) rather than testing a guard. Both branches of the non-atomicity count are asserted non-zero so it cannot pass for the wrong reason. - **The other premise remains UNMEASURED**: nothing has demonstrated that a throw in the real Collab/Portal Socket.IO handler actually removes the listener or wedges the session. Prove that at the real transport boundary before building anything. - **Correct shape when it is built**: recovery is "discard this Scene generation and resync", which belongs to the transport that owns the session — and it needs the generation-replacement machinery from **T031**, so T027 lands after it. No error framework, no `console.error` of network bytes in a library, and no boolean that erases which failure occurred (malformed bytes / wrong codec / programming defect / partial application are different situations).
- [x] T028 **(done — 4 tests, `appStateUndo.test.tsx`)** Green **INV-APPSTATE-UNDO**. Undo/redo writes the reverted collaborative appState through to `yAppState` at `history.ts`, the one point where an undo/redo appState change converges — only the two actions (`actionCanvas`, `actionExport`) wrote through before, and undo does not go through them. Without it the appState mirror pushed the document's stale value back into React state on the next scene update, so the undo silently un-did itself and peers never saw the revert. - **Scoped to the DELTA, not the current state.** Only the keys the entry actually reverted are written, read from `entry.appState.delta.inserted` (`ObservedStandaloneAppState` is exactly `{name, viewBackgroundColor}`). Writing the whole subset instead publishes the background on every element-only undo AND introduces appState into a document that never had any — measured: it fails the zero-traffic test plus two existing history tests, one of which ("should not collapse when applying corrupted history entry") catches it purely as an extra render. - **Two-way non-vacuity**: removing the write-through fails the undo and redo peer cases; writing the whole subset instead of the delta fails the element-only case and the two history tests. - **Coverage across a linked peer** (via `onLocalSceneUpdate`, with delivery counts asserted so an unlinked peer cannot pass vacuously): background undo, background redo, and an element-only undo proving the collaborative appState is byte-identical afterwards. - **`name` claim NARROWED with evidence**, not covered: `changeProjectName` returns `CaptureUpdateAction.EVENTUALLY`, so a name change never becomes its own history entry and there is no name undo to propagate. The write-through is keyed off the delta so it carries `name` if an entry ever holds one, but no action produces that today — pinned by a test asserting the action's capture behaviour.
- [ ] T029 The live invariant suites and the normal gates pass: `pnpm run test:typecheck`, lint, prettier, the full vitest suite, and `pnpm run test:headless`. Non-vacuity is each invariant test's own responsibility — it is asserted where the invariant lives, and the sabotage that established it is preserved in commit history. No central ledger and no retained baselines to re-verify against.
- [ ] T030 SC-003 gate: a fresh FULL adversarial review of the complete HEAD returns ZERO findings of any kind. Ratchet any finding → a new invariant test + back to its phase.

## Analyze (spec↔plan↔tasks consistency — pre-implement gate)

Self-check, re-run after the 2026-08-19 widening. Every FR maps to a task and an invariant test:

| FR         | Task           | Invariant             | Story |
| ---------- | -------------- | --------------------- | ----- |
| FR-001/002 | T032/T019      | INV-CONVERGE          | US1   |
| FR-003     | T021           | INV-PERSIST-MERGE     | US3   |
| FR-004     | T020           | INV-COLD-LOAD-LINEAGE | US4   |
| FR-005     | T024           | INV-REVEAL            | US5   |
| FR-006     | T025           | INV-BOUNDED           | US6   |
| FR-007     | T026           | INV-SAVE-SKIP         | US7   |
| FR-008     | T001/T002      | non-vacuity ledger    | —     |
| FR-009     | T013/T015/T016 | INV-WRITE-INTENT      | US8   |
| FR-010     | T017           | INV-HISTORY-LOCKSTEP  | US9   |
| FR-011     | T014           | INV-VERSION-MONOTONIC | US9   |
| FR-012     | T022           | INV-ORIGIN            | US10  |
| FR-013     | T023           | INV-NO-BINARY-WIRE    | US11  |
| FR-014     | T027           | INV-WIRE-ROBUST       | US12  |
| FR-015     | T028           | INV-APPSTATE-UNDO     | US13  |

Every SC has a gate: SC-001→T001 + T032 (Scene-level half done; app path open), SC-002→T002 (now satisfied by Phases 2–3, not Phase 4), SC-003→T030, SC-004→T029, SC-005→T016 (bandaid census reaches zero), SC-006→T009, SC-007→T010. No orphan tasks, no uncovered FR/SC. **Consistent — clear to implement.**
