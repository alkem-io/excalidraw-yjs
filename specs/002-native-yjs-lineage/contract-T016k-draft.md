# T016k contract — the action draft boundary

**Status**: revision 2 — five structural corrections from review, each verified against the code before accepting. GO to implement. **Spec**: FR-016, FR-017. **Blocks**: the caller migration.

## Why this exists

RED, measured on the real action with sender and receiver linked before `executeAction`:

```
senderUpdates:         4     (contract: at most 1)
peerObservableStates:  4     (contract: at most 1)
danglingContainerRefs: [ 'state#0: text-1 -> missing id2',
                         'state#1: text-1 -> missing id2' ]
```

`wrapTextInContainer` writes to the doc during `perform`. Those are committed, broadcast `LOCAL` transactions before `syncActionResult` ever runs, so `commitPlan` cannot make the action atomic retroactively.

## The load-bearing structural fact

Scene's reads are **already a materialized view**. Five private caches — `elements`, `elementsMap`, `nonDeletedElements`, `nonDeletedElementsMap`, `frames` — are rebuilt wholesale by `recomputeFromDoc()`, and all six public accessors (`getElementsIncludingDeleted`, `getElementsMapIncludingDeleted`, `getNonDeletedElements`, `getNonDeletedElementsMap`, `getNonDeletedElement`, `getFramesIncludingDeleted`) just return them.

So a draft does **not** need an overlay in the accessors, and no caller changes. It changes _what materializes the caches_: `doc` becomes `doc + draft`. My earlier "214 call sites" framing was the blast radius of getting it wrong, not the edit — the edit is one materialization function.

## Interface

```ts
// sync path only. Returns PARTIAL declared intent — deliberately NOT an ElementPlan.
runAsLogicalMutation<T>(
  fn: () => T,
): { result: T; declaredKeysById: ReadonlyMap<string, ReadonlySet<string>> };
```

**It cannot return a complete plan, and must not pretend to.** `Scene.mutateElement` observes per-key writes to EXISTING elements only. Membership encoded solely in the `ActionResult` array is invisible to it: a new element may never pass through Scene at all, and a removal may be nothing more than an id absent from `result`. So `draft.added` / `draft.removed` have no sound producer and are **removed from draft state**.

`applyElementChanges` stays the single planner. It compares invocation base against result for membership and for the bare-mutate fallback, merges in the Scene-declared keys, validates, and builds the one `ElementPlan`. No second planner, and `commitPlan` stays private.

Internally:

```ts
private draft: {
  records: Map<string, ElementRecord>;   // drafted state of EXISTING ids only
  keysById: Map<string, Set<string>>;    // keys declared via Scene.mutateElement
} | null = null;
```

- **begin** — throws if a draft is already open. Nesting/reentrancy is rejected, not merged.
- **run** — `fn()` executes; `Scene.mutateElement` is live and behaves as callers expect.
- **end** — returns the accumulated `ElementPlan`; the caller passes it to `applyElementChanges`.
- **discard** — on throw, or on `fn` returning `false`: drop the draft, `recomputeFromDoc()`.

## `Scene.mutateElement` while a draft is open

1. Mutates the passed object in place, exactly as now (callers depend on this).
2. **Only for ids already in the Scene.** `Scene.mutateElement` on an absent id is a no-op today — "create via mutate" falls through the `inScene` guard, and membership arrives via the create path. The draft must NOT make an absent id appear in the caches merely because `mutateElement` touched it; that would change existing semantics.
3. Writes the resulting record into `draft.records` and the assigned keys into `draft.keysById` (the T016a out-param).
4. Rebuilds the cache views through a **NEW pure materializer**, not `recomputeFromDoc`. That function is not a pure cache builder: it does `version: ++this.versionHighWater`, `this.meta.set(id, …)` and `this.meta.delete(id)`. Reusing it for a draft would mutate COMMITTED reconciliation state, and discard could not restore the old versions/nonces/high-water — the doc would be byte-identical while Scene's change-detection state was not. Factor `materializeViews(records, metaView)` returning the five caches; `recomputeFromDoc` becomes one caller of it.
5. During a draft: committed `meta` and `versionHighWater` are untouched, draft reconciliation metadata is a separate overlay, and there is **no** `triggerUpdate`, `sceneNonce` change, callback, or Store scheduling. `selectedElementsCache` invalidation/identity is handled for draft reads without being published externally.
6. Performs **zero** `yElements` transactions, zero notifications, zero broadcasts.

`declaredIntent` therefore falls out of the draft rather than being derived — which removes the derived-diff fallback for every migrated caller, including the same-value-assignment case a diff cannot see.

## Guarantees

- **G-D1** No `yElements` transaction occurs during `fn`; one `applyElementChanges` commit follows. **Scoped to elements, NOT the whole document.** `actionChangeViewBackgroundColor` and `actionChangeProjectName` call `scene.setAppState` during `perform`, which transacts on `yAppState` immediately — so whole-document atomicity is false however good element drafting is. Those two either route through the post-action commit boundary (the cleaner root direction) or are explicitly audited as out-of-scope direct writers. This contract does not claim to cover them.
- **G-D2** An action that throws leaves **`yElements`** byte-identical — _by construction, not by cleanup_: the element draft never wrote, so there is no rollback machinery to get wrong. Same element-only scoping as G-D1.
- **G-D3** Nesting throws. A second `runAsLogicalMutation` while one is open is a caller bug.
- **G-D4** A `perform` returning a thenable **discards the draft and falls back to the existing Promise/derived path** — it does NOT throw. By the time `fn` has returned a Promise the async function is already running; throwing cancels nothing, and its continuation would still mutate Scene after `ActionManager` believed the action failed. Prerequisite: audit the three async element-mutating actions (`actionElementLink`, `actionClipboard`, `actionExport`) and prove zero Scene/`Y.Doc` element writes in BOTH the synchronous prefix and the continuation. A future async action that does write must be rejected by the registration/type contract **before invocation**, never discovered afterward.
- **G-D5** No temp `Y.Doc`, no readback adapter, no public API. `runAsLogicalMutation` is internal to the action path.

## Out of scope, deliberately

Bare `mutateElement` calls not routed through `Scene` are invisible to the draft and stay on the derived-diff fallback. They need auditing for the same-value explicit-intent case, tracked separately rather than folded in here.

## Acceptance

The skipped real-action test un-skips and passes: one sender update, one receiver notification, zero dangling states, container immediately below its text, one undo item restoring the whole action.

Plus, because the current assertions would pass over a violation:

- **zero sender Scene callbacks DURING `perform`**, not merely one wire update after the commit;
- on throw AND on a `false` result: `yElements` bytes, committed meta / version / high-water observable behaviour, cache contents and callback count all unchanged;
- an async-fallback test proving an already-started Promise is neither orphaned nor rejected by post-hoc detection;
- a membership test proving a new `ActionResult` element is added even when no `Scene.mutateElement` call touched it.

No extra concurrency machinery is required: begin, run and commit occur within one synchronous JS turn, so no remote update can interleave.
