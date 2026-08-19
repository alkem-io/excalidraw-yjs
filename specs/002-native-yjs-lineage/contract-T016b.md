# T016b contract — one commit primitive, two planners

**Status**: pre-implementation, for review. **Spec**: FR-016, FR-017, T014b.

## 1. The plan shape

Encodes only operations already required today. No modes, no phases, no extension points.

```ts
type ElementPlan = {
  /** ids absent from the doc: born-tombstoned in the prelude, revealed in the action txn */
  readonly add: readonly ElementRecord[];
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
- **G2** Exactly ONE tracked transaction (`LOCAL` or `EPHEMERAL` per `recordHistory`) carrying `remove`, `write`, and the reveal of `add` — reveal last, so an element is never live before its complete record exists.
- **G3** Metadata for actually-written ids is updated inside that same transaction. Version is monotonic: it never regresses below what `bumpMetaVersionsFor` raised. **(closes T014b)**
- **G4** Exactly ONE externally observable Scene notification / Store scheduling point. (The STRUCTURAL pass still recomputes internally; `suppressTrigger` hides it from callbacks.)
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

## 4. Caller classification (measured, 20 production sites)

My earlier "load/reset/import" characterisation was wrong. Actual:

| Site | What it does | Class | Destination |
| --- | --- | --- | --- |
| `App.tsx:2832` `syncActionResult` | applies an ActionResult | **ordinary** | `applyElementChanges` — the FR-016 headline |
| `App.tsx:2938` `resetScene` | clears to `[]` | authoritative | stays |
| `App.tsx:4706` `updateScene` (public API) | host asserts the scene | authoritative | stays |
| `App.tsx:13192` `h.elements` setter | test/debug harness | authoritative | stays |
| `App.tsx:4067` frame-eligibility | drag into/out of frame | ordinary | `applyElementChanges` |
| `App.tsx:5874` text editor `updateElement` | edits one text element | ordinary | `applyElementChanges` |
| `App.tsx:10467` index sync | writes fixed indices | ordinary | `applyElementChanges` (index is a declared key) |
| `App.tsx:11165` `addElementsToFrame` | frame membership | ordinary | `applyElementChanges` |
| `App.tsx:11316`, `11361` | element edits | ordinary | `applyElementChanges` |
| `App.tsx:11829` eraser commit | marks erased | ordinary | `applyElementChanges` |
| `App.tsx:12058` image-cache error | per-element status | ordinary (self-derived from current doc) | `applyElementChanges` |
| `zindex.ts:189` | reorder | ordinary | `applyElementChanges` |
| `transform.ts:817` `convertToExcalidrawElements` | builds a full set programmatically | authoritative | stays |
| `ConvertElementTypePopup.tsx:476`, `557` | converts selected elements | ordinary | `applyElementChanges` |
| `Stats/Dimension.tsx:214`, `311` | panel edit | ordinary | `applyElementChanges` |
| `Stats/MultiDimension.tsx:276`, `432` | panel edit | ordinary | `applyElementChanges` |

**15 ordinary, 5 authoritative.** The authoritative API is currently the default, which is the defect: destructive semantics are easy to select by accident.

## 5. Naming + enforcement

`replaceAllElements` is renamed `reconcileAllElementsAuthoritatively` so destructive semantics cannot be chosen inattentively. Enforcement is a **runtime boundary test** — drive an ActionResult through `syncActionResult` with a concurrent remote change staged, and assert the remote change survives — not an import or text scan.

## 6. Removal boundary

The 36 `fresh-snapshot` re-read sites exist because the bulk path reverts helper writes. Once the boundary lands and the interleaving tests are green, the affected family is removed **in the same story** — not one-at-a-time indefinitely. No permanent dual defense.
