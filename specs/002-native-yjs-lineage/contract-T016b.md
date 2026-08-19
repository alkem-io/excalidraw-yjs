# T016b contract — one commit primitive, two planners

**Status**: revision 2, pre-implementation. **Spec**: FR-016, FR-017, T014b.

> Revision 2 corrects six defects found in review. Verified each before accepting: the census arithmetic (my table was **16/4**, not 15/5 — I counted table ROWS, several of which cover two sites), three omitted Scene-internal callers (I filtered out `Scene.ts` wholesale to avoid matching the method definition and lost its call sites with it), and the claim that `syncActionResult` reaches the doc via public `updateScene` — it does **not**, it calls `this.scene.replaceAllElements` directly at `App.tsx:2832`. I invented that relationship; the boundary choice must not rest on it.

## 1. The plan shape

Encodes only operations already required today. No modes, no phases, no extension points.

```ts
type ElementPlan = {
  /**
   * ids absent from the doc: born-tombstoned in the prelude, revealed in the action txn.
   * Carries `keys` — every persisted own key the creation explicitly establishes — because
   * G7 reclassifies a collided add as a scoped write and needs a declared key set to write.
   */
  readonly add: readonly { record: ElementRecord; keys: ReadonlySet<string> }[];
  /** ids to structurally remove from the doc */
  readonly remove: readonly string[];
  /** id -> the record to write from, and the exact keys to write */
  readonly write: ReadonlyMap<
    string,
    { record: ElementRecord; keys: ReadonlySet<string> }
  >;
  /** the existing origin/history choice — LOCAL (tracked) vs EPHEMERAL (not) */
  readonly recordHistory: boolean;
};
```

`add`/`remove`/`write` id sets are disjoint; `commitPlan` asserts it rather than resolving it.

## 2. The commit primitive

```ts
commitPlan(plan: ElementPlan): { writtenIds: ReadonlySet<string> }
```

Sole owner of tombstone materialization, origins, the transaction and broadcast boundary, metadata handling, observer scheduling and failure cleanup. Neither planner may touch a `Y.Map` directly.

**Index resolution lives in the PLANNERS, not here.** That is precisely where the two semantics differ: the authoritative planner may normalize/repair the whole supplied set, while the intent planner may resolve only indices belonging to declared membership/order intent. A committer that "owns index resolution" must either broad-repair the current scene — undeclared writes, the exact thing FR-016 exists to stop — or branch on planner provenance, which is a mode in disguise. Planners emit fully normalized records with explicit index keys; `commitPlan` validates the finished plan and refuses to write if any record or index is invalid. There is NO validation bypass on `ElementPlan`: a finished plan must always be structurally valid before it reaches the committer.

Observable guarantees:

- **G1** At most ONE untracked `STRUCTURAL` prelude, only for `plan.add`, materializing complete born-tombstoned records. Required because a `LOCAL` structural add lets `UndoManager` hard-remove the element on undo, and a wholly `STRUCTURAL` create is not undoable; Yjs cannot give nested parts of one transaction different origins.
- **G2** Exactly ONE action transaction carrying `remove`, `write`, and the reveal of `add` — reveal last, so an element is never live before its complete record exists. History-tracked **iff** the origin is `LOCAL`; `EPHEMERAL` is not a tracked transaction.
- **G3** Metadata for actually-written ids is updated inside that same transaction, with the **current** behaviour preserved. This contract does **NOT** close T014b, and revision 1's claim that it did was wrong: the already-scoped `max(meta, prev + 1)` bump was measured to break semantic tests, and T016e records the mechanism as OPEN. What this primitive provides is the _integration seam_ — it returns the effective changed ids, which is the information a fix needs and the reason T014b should be solved here. T014b stays RED until the separate revision-token migration across Store / `ElementsDelta` / caches is designed and measured.
- **G4** **At most one** externally observable Scene notification / Store scheduling point — exactly one only when the commit actually changes the doc. A no-op plan, or a collision whose declared values already equal current state, produces ZERO notification rather than manufacturing activity. (The STRUCTURAL pass still recomputes internally; `suppressTrigger` hides it from callbacks.)
- **G5** **At most one** broadcast for the whole plan, emitted as a single delta from the pre-plan state vector, and none at all when the doc did not change. **(closes FR-017)** Scoped to `Scene.onDocUpdate` / `CollabEngine` transport: an arbitrary external `doc.on("update")` observer still sees the underlying Yjs transactions, and this contract does not claim otherwise.
- **G6** The finished plan is validated BEFORE the prelude (indices already resolved by the planner). On failure, a `finally` either publishes the resulting delta or performs explicit structural cleanup and publishes that net result — never silently discards a committed structural write.
- **G7** An id in `plan.add` that already exists in the doc (interleaved remote add) is NOT structurally replaced: it is treated as existing and only its declared keys are written.

## 3. The two planners

```ts
// intent-preserving: apply what the action meant, to the doc as it is now
applyElementChanges(base, result, declaredIntent?, opts) -> commitPlan(plan)
// authoritative: membership of the supplied set is the truth
reconcileAllElementsAuthoritatively(elements, opts) -> commitPlan(plan)
//   opts.skipValidation: for the isolated mid-history temp Scene (delta.ts:1899), which has no
//   up-to-date scene to validate against. An AUTHORITATIVE-PLANNER option, never on ElementPlan.
```

`declaredIntent` is **not** a later addition. The governing spec already states that a derived diff is not the definition of intent — an explicit same-value assignment is invisible to any diff, and async actions cannot be solved by one. So the explicit per-id membership/key channel exists from day one, for headless MCP and async action paths. `computeElementIntent` is the DERIVED fallback, valid only on the **audited synchronous** migration path.

The authoritative planner derives `remove` = docIds − suppliedIds and `write` = whole-object diff, and owns any index normalization/repair of the supplied set.

## 4. Caller classification (measured — 23 sites, 18 ordinary / 5 authoritative)

Revision 1 said "20 sites, 15 ordinary / 5 authoritative". Both halves were wrong. The table counted ROWS (several cover two sites) giving 16/4, and it omitted three production callers inside `Scene.ts` because I filtered that file out wholesale to avoid matching the method definition.

**`base source` is the load-bearing column.** Migrating a caller to `applyElementChanges` while capturing base at the FINAL call site — after its helpers have already written to the doc — derives an empty or wrong intent and silently drops the edit. Every ordinary caller needs a stable _pre-operation_ snapshot (a deep copy, per T016a), or explicit declared intent instead.

| Site | Class | Base source | Destination |
| --- | --- | --- | --- |
| `Scene.ts:548` constructor | authoritative | — | stays |
| `Scene.ts:640` `mapElements` | ordinary | the elements the map iterates, copied before mapping | `applyElementChanges` |
| `Scene.ts:1359` `insertElementsAtIndex` | ordinary | current elements, copied before insert | `applyElementChanges` |
| `App.tsx:2832` `syncActionResult` | ordinary | **the ActionManager invocation snapshot (T016a — already built)** | `applyElementChanges` — the FR-016 headline |
| `App.tsx:2938` `resetScene` | authoritative | — | stays |
| `App.tsx:4067` frame eligibility | ordinary | the array the frame logic started from | `applyElementChanges` |
| `App.tsx:4706` public `updateScene` | authoritative | — | stays |
| `App.tsx:5874` text-editor `updateElement` | ordinary | deep copy taken immediately BEFORE the call's own map over the current Scene snapshot — **not** editor-session start, which would classify remote changes accumulated during editing as this keystroke's intent. Better still, carry the explicit keys from `newElementWith` + `refreshTextDimensions`. | `applyElementChanges` (prefer explicit intent) |
| `App.tsx:10467` index sync | ordinary | elements before `syncInvalidIndices` | `applyElementChanges` (index is a declared key) |
| `App.tsx:11165` `addElementsToFrame` | ordinary | the array passed in | `applyElementChanges` |
| `App.tsx:11316`, `:11361` | ordinary | their source array | `applyElementChanges` |
| `App.tsx:11829` eraser commit | ordinary | elements before erasure marking | `applyElementChanges` |
| `App.tsx:12058` image-cache error | ordinary | `getElementsIncludingDeleted()` at the same instant — base == current, so intent is exactly the status changes | `applyElementChanges` |
| `App.tsx:13192` `h.elements` setter | authoritative | — | stays |
| `zindex.ts:189` reorder | ordinary | the array passed to the reorder | `applyElementChanges` |
| `transform.ts:817` `convertToExcalidrawElements` | authoritative | — | stays |
| `ConvertElementTypePopup.tsx:476`, `:557` | ordinary | elements before conversion | `applyElementChanges` |
| `Stats/Dimension.tsx:214`, `:311` | ordinary | deep copy taken AFTER `resizeSingleElement` has written geometry and BEFORE `replaceAllElementsInFrame` — the bulk call exists only to persist frame-membership, so that helper's input is the base | `applyElementChanges` |
| `Stats/MultiDimension.tsx:276`, `:432` | ordinary | same as `Dimension` — after the geometry writes, before `replaceAllElementsInFrame` | `applyElementChanges` |

No row is unresolved: unresolved base provenance is precisely how this migration becomes vacuous.

**Do not conflate the gesture-calculation base with the write-intent base.** `DragInput.tsx:238-247` already deep-captures `originalElementsMap` at pointer-down, and that IS correct for computing absolute resize geometry across a drag. It is the WRONG base for the later, narrower frame-membership commit: pointer-down would re-declare all accumulated geometry and every intervening value on each move, widening the intent and reintroducing the stale-overwrite class this work exists to remove. One gesture can legitimately carry several write-intent bases.

Also corrected: revision 1 flagged `App.tsx:4706` as a judgment call on the grounds that `syncActionResult` reaches the doc through public `updateScene`. **It does not** — it calls `this.scene.replaceAllElements` directly at `:2832`. That relationship was invented and no boundary decision may rest on it.

## 5. Naming + enforcement

`replaceAllElements` is renamed `reconcileAllElementsAuthoritatively` so destructive semantics cannot be chosen inattentively. Enforcement is a **runtime boundary test** — drive an ActionResult through `syncActionResult` with a concurrent remote change staged, and assert the remote change survives — not an import or text scan.

## 6. Removal boundary

The 36 `fresh-snapshot` re-read sites exist because the bulk path reverts helper writes. Once the boundary lands and the interleaving tests are green, the affected family is removed **in the same story** — not one-at-a-time indefinitely. No permanent dual defense.
