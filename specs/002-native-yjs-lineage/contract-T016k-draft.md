# T016k contract — the action draft boundary

**Status**: pre-implementation, for review. **Spec**: FR-016, FR-017. **Blocks**: the caller migration.

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
// sync only; throws if `fn` returns a thenable
runAsLogicalMutation<T>(fn: () => T): { result: T; plan: ElementPlan };
```

Internally:

```ts
private draft: {
  records: Map<string, ElementRecord>;   // drafted element state
  intent: Map<string, Set<string>>;      // declared keys per id
  added: Set<string>;
  removed: Set<string>;
} | null = null;
```

- **begin** — throws if a draft is already open. Nesting/reentrancy is rejected, not merged.
- **run** — `fn()` executes; `Scene.mutateElement` is live and behaves as callers expect.
- **end** — returns the accumulated `ElementPlan`; the caller passes it to `applyElementChanges`.
- **discard** — on throw, or on `fn` returning `false`: drop the draft, `recomputeFromDoc()`.

## `Scene.mutateElement` while a draft is open

1. Mutates the passed object in place, exactly as now (callers depend on this).
2. Writes the resulting record into `draft.records` and the assigned keys into `draft.intent` — the keys `mutateElement` already reports via the T016a out-param.
3. Rebuilds the caches from `doc + draft`, so a helper reading back mid-action sees drafted values.
4. Performs **zero** `Y.Doc` transactions, zero notifications, zero broadcasts.

`declaredIntent` therefore falls out of the draft rather than being derived — which removes the derived-diff fallback for every migrated caller, including the same-value-assignment case a diff cannot see.

## Guarantees

- **G-D1** No `Y.Doc` transaction occurs during `fn`. One `applyElementChanges` commit follows.
- **G-D2** An action that throws leaves the doc **byte-identical** — _by construction, not by cleanup_: the draft never wrote. There is no rollback machinery to get wrong.
- **G-D3** Nesting throws. A second `runAsLogicalMutation` while one is open is a caller bug.
- **G-D4** A `perform` returning a thenable throws. An async action cannot hold a global draft across `await` — unrelated UI work would be captured into it. Async element-mutating actions (`actionElementLink`, `actionClipboard`, `actionExport`) stay on the derived path until audited.
- **G-D5** No temp `Y.Doc`, no readback adapter, no public API. `runAsLogicalMutation` is internal to the action path.

## Out of scope, deliberately

Bare `mutateElement` calls not routed through `Scene` are invisible to the draft and stay on the derived-diff fallback. They need auditing for the same-value explicit-intent case, tracked separately rather than folded in here.

## Acceptance

The skipped real-action test un-skips and passes: one sender update, one receiver notification, zero dangling states, container immediately below its text, one undo item restoring the whole action.
