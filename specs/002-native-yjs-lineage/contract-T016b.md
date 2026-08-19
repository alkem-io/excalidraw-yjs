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

Sole owner of tombstone materialization, origins, the transaction and broadcast boundary, metadata/version handling, index resolution, observer scheduling and failure cleanup. Neither planner may touch a `Y.Map` directly.

Observable guarantees:

- **G1** At most ONE untracked `STRUCTURAL` prelude, only for `plan.add`, materializing complete born-tombstoned records. Required because a `LOCAL` structural add lets `UndoManager` hard-remove the element on undo, and a wholly `STRUCTURAL` create is not undoable; Yjs cannot give nested parts of one transaction different origins.
- **G2** Exactly ONE action transaction carrying `remove`, `write`, and the reveal of `add` — reveal last, so an element is never live before its complete record exists.
- **G3** Metadata for actually-written ids is updated inside that same transaction. Version is monotonic: it never regresses below what `bumpMetaVersionsFor` raised. **(closes T014b)**
- **G4** **At most one** externally observable Scene notification / Store scheduling point — exactly one only when the commit actually changes the doc. A no-op plan, or a collision whose declared values already equal current state, produces ZERO notification rather than manufacturing activity. (The STRUCTURAL pass still recomputes internally; `suppressTrigger` hides it from callbacks.)
- **G5** Exactly ONE broadcast for the whole plan, emitted as a single delta from the pre-plan state vector. **(closes FR-017)**
- **G6** Everything is validated and every required fractional index resolved BEFORE the prelude. On failure, a `finally` either publishes the resulting delta or performs explicit structural cleanup and publishes that net result — never silently discards a committed structural write.
- **G7** An id in `plan.add` that already exists in the doc (interleaved remote add) is NOT structurally replaced: it is treated as existing and only its declared keys are written.

## 3. The two planners

```ts
// intent-preserving: apply what the action meant, to the doc as it is now
applyElementChanges(base, result, opts) -> commitPlan(planFromIntent)
// authoritative: membership of the supplied set is the truth
reconcileAllElementsAuthoritatively(elements, opts) -> commitPlan(planFromFullSet)
```

`applyElementChanges` derives its plan from `computeElementIntent` (already built, presence-aware). The authoritative planner derives `remove` = docIds − suppliedIds and `write` = whole-object diff.

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
| `App.tsx:5874` text-editor `updateElement` | ordinary | ⚠ needs per-site confirmation — editor-session start vs per-keystroke | `applyElementChanges` |
| `App.tsx:10467` index sync | ordinary | elements before `syncInvalidIndices` | `applyElementChanges` (index is a declared key) |
| `App.tsx:11165` `addElementsToFrame` | ordinary | the array passed in | `applyElementChanges` |
| `App.tsx:11316`, `:11361` | ordinary | their source array | `applyElementChanges` |
| `App.tsx:11829` eraser commit | ordinary | elements before erasure marking | `applyElementChanges` |
| `App.tsx:12058` image-cache error | ordinary | `getElementsIncludingDeleted()` at the same instant — base == current, so intent is exactly the status changes | `applyElementChanges` |
| `App.tsx:13192` `h.elements` setter | authoritative | — | stays |
| `zindex.ts:189` reorder | ordinary | the array passed to the reorder | `applyElementChanges` |
| `transform.ts:817` `convertToExcalidrawElements` | authoritative | — | stays |
| `ConvertElementTypePopup.tsx:476`, `:557` | ordinary | elements before conversion | `applyElementChanges` |
| `Stats/Dimension.tsx:214`, `:311` | ordinary | ⚠ **drag handlers — base must be captured at pointer-DOWN, not per pointer-move**, or every frame re-derives against a moving base | `applyElementChanges` |
| `Stats/MultiDimension.tsx:276`, `:432` | ordinary | ⚠ same drag-handler hazard | `applyElementChanges` |

Three rows are marked ⚠ where I have not confirmed the base source by reading the call path. Those are flagged rather than guessed: a wrong base is exactly the failure this column exists to prevent, so they are per-site work items, not assumptions.

Also corrected: revision 1 flagged `App.tsx:4706` as a judgment call on the grounds that `syncActionResult` reaches the doc through public `updateScene`. **It does not** — it calls `this.scene.replaceAllElements` directly at `:2832`. That relationship was invented and no boundary decision may rest on it.

## 5. Naming + enforcement

`replaceAllElements` is renamed `reconcileAllElementsAuthoritatively` so destructive semantics cannot be chosen inattentively. Enforcement is a **runtime boundary test** — drive an ActionResult through `syncActionResult` with a concurrent remote change staged, and assert the remote change survives — not an import or text scan.

## 6. Removal boundary

The 36 `fresh-snapshot` re-read sites exist because the bulk path reverts helper writes. Once the boundary lands and the interleaving tests are green, the affected family is removed **in the same story** — not one-at-a-time indefinitely. No permanent dual defense.
