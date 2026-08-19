# T016k contract — the action draft boundary

**Status**: revision 3 — REWRITTEN wholesale, not patched. **Spec**: FR-016, FR-017.

> Revision 2 was patched in place and three edits silently failed, leaving the file internally contradictory (an `ElementPlan` return alongside the corrected partial intent; a "removes derived fallback for every migrated caller" claim I had said was withdrawn; a G-D4 still naming "three async actions" and post-hoc registration rejection). I had verified by asserting the NEW strings appeared, never that the OLD ones were gone. Rewritten in full so reconciliation is structural rather than a matter of my checking carefully enough.

## Why this exists

Measured on the real action, sender and receiver linked before `executeAction`:

```
senderUpdates:         4     (contract: at most 1)
peerObservableStates:  4     (contract: at most 1)
danglingContainerRefs: [ 'state#0: text-1 -> missing id2',
                         'state#1: text-1 -> missing id2' ]
```

`wrapTextInContainer` writes during `perform`. Those are committed, broadcast `LOCAL` transactions before `syncActionResult` runs, so `commitPlan` cannot make the action atomic retroactively.

## The structural fact that makes this small

Scene's reads are already a materialized view: five private caches (`elements`, `elementsMap`, `nonDeletedElements`, `nonDeletedElementsMap`, `frames`) rebuilt by `recomputeFromDoc()`, with all six accessors returning them. A draft changes _what materializes the caches_, from `doc` to `doc + draft`. No accessor overlay, no caller changes.

## Interface

```ts
// Returns PARTIAL declared intent — deliberately NOT an ElementPlan.
runAsLogicalMutation<T>(
  fn: () => T,
): { result: T; declaredKeysById: ReadonlyMap<string, ReadonlySet<string>> };
```

It **cannot** return a complete plan. `Scene.mutateElement` observes per-key writes to EXISTING elements only; membership encoded solely in the `ActionResult` array is invisible to it — a new element may never pass through Scene, and a removal may be nothing but an id absent from `result`. `applyElementChanges` stays the single planner: it compares invocation base against result for membership and the bare-mutate fallback, merges the Scene-declared keys, validates, and builds the one plan. `commitPlan` stays private.

- **begin** — throws if a draft is open. Nesting is rejected, not merged.
- **run** — `fn()` executes; `Scene.mutateElement` behaves as callers expect.
- **end** — returns `{ result, declaredKeysById }`.
- **discard** — on throw, or `fn` returning `false`: drop the draft, rebuild views from committed doc + meta.

### Promise results

`ActionFn` genuinely declares `ActionResult | Promise<ActionResult>` and eight actions exercise the Promise branch. So: invoke under the draft; if the result is promise-like, **discard the (empty) draft and hand the existing Promise to the existing derived path**. Never throw at it, never cancel it — by then the async function is already running and its continuation would proceed regardless.

The load-bearing precondition is measured, not assumed: **all eight async `perform`s have zero element writes in their synchronous prefix** (see `audit-async-actions.md`), so the draft being discarded is always empty. If a future async prefix is not empty, that is a finding to fix at that action — not a reason for a mode, a list, or a registration API.

No `fn.constructor.name === "AsyncFunction"` reflection: it depends on emitted function shape, still misses a sync function returning a promise, and is not needed when the declared runtime union already tells us what to branch on.

## `Scene.mutateElement` while a draft is open

1. Mutates the passed object in place, exactly as now.
2. **Existing ids only.** `mutateElement` on an absent id is a no-op today — "create via mutate" falls through the `inScene` guard. The draft must not make an absent id appear in the caches; membership comes from base/result planning.
3. Records the resulting record and the assigned keys (the T016a out-param).
4. Rebuilds views through a **new pure materializer**, not `recomputeFromDoc` — which does `version: ++this.versionHighWater`, `this.meta.set(id, …)` and `this.meta.delete(id)`. Drafting through it would mutate COMMITTED reconciliation state that discard could not restore: doc byte-identical, change-detection state silently wrong. Factor `materializeViews(records, metaView)`; `recomputeFromDoc` becomes one caller.
5. Committed `meta` and `versionHighWater` untouched; draft reconciliation metadata is a separate overlay; no `triggerUpdate`, `sceneNonce` change, callback or Store scheduling; `selectedElementsCache` handled without publishing.
6. Zero `yElements` transactions, zero notifications, zero broadcasts.

`declaredKeysById` covers **Scene-routed key writes only** — including the same-value assignment no diff can see. Membership, and any bare `mutateElement` not routed through Scene, remain derived until their own bounded audit.

## Guarantees

- **G-D1** No `yElements` transaction during `fn`; one `applyElementChanges` commit follows. **Element-scoped, NOT whole-document**: `actionChangeViewBackgroundColor` and `actionChangeProjectName` call `scene.setAppState` during `perform`, transacting on `yAppState` immediately. Those two either route through the post-action commit boundary or are explicitly out of scope. This contract does not claim to cover them.
- **G-D2** An action that throws leaves `yElements` byte-identical — by construction, not cleanup: the draft never wrote. Same element-only scoping.
- **G-D3** Nesting throws.
- **G-D4** A promise-like result discards an empty draft and continues on the existing derived path. No throw, no cancellation, no registration API.
- **G-D5** No temp `Y.Doc`, no readback adapter, no public API.

## Out of scope, and honestly named

- Bare `mutateElement` not routed through Scene: invisible to the draft, stays derived, tracked separately.
- **Paste / import do NOT have their own atomic boundary today.** `App.addElementsFromPasteOrLibrary` calls `this.scene.replaceAllElements(nextElements)` — the authoritative whole-scene path T016 is replacing — and then `redrawTextBoundingBox`, which mutates Scene again. Other paste branches call `insertNewElements`, which chunks by `frameId` and calls `insertElementsAtIndex` once per chunk: several logical writes. Keeping `actionPaste`/`actionLoadScene` out of the action draft is fine; claiming they already commit atomically is not. Tracked as **T016m** with its own RED integration test at the real paste/import commit site.
- **Double application (T016n)**: `actionLoadScene` calls `app.addElementsFromPasteOrLibrary(...)` and then returns `elements: app.scene.getNonDeletedElements()`, so `syncActionResult` plans and applies the same membership a second time. One of the two applications is redundant and must be deleted, not reconciled.

## Acceptance

The skipped real-action test un-skips and passes: one sender update, one receiver notification, zero dangling states, container immediately below its text, one undo item restoring the whole action. Plus:

- **zero sender Scene callbacks DURING `perform`**, not merely one wire update after commit;
- on throw AND on `false`: `yElements` bytes, committed meta / version / high-water observable behaviour, cache contents and callback count all unchanged;
- a promise-result test proving an already-started Promise is neither orphaned nor rejected, and that the discarded draft was empty;
- a membership test proving a new `ActionResult` element is added even when no `Scene.mutateElement` call touched it.

Begin, run and commit occur in one synchronous JS turn, so no remote update can interleave and no extra concurrency machinery is needed.
