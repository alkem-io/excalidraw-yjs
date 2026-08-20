# Audit — is a whole-scene REPLACE supported by the current API?

**Read-only. No code written.** Question from the server lane: it will receive a desired full Yjs-V2 snapshot, sync the live room into a `Y.Doc`, and must semantically **replace** the live scene in one logical published mutation — no merge, no schema hand-editing, wire stays ordinary Yjs.

## Answer

**No new whole-scene primitive is needed. Three of the four operations already work today; one does not.** Measured by composing the existing API against a seeded "live room" and inspecting the result and a peer:

```
updates emitted: 1
elements:  ["new1"]                          ← old1, old2 gone
assets:    {"newAsset":"asset://new"}        ← oldAsset gone
appState:  {"viewBackgroundColor":"#ffffff","name":"old name"}   ← name SURVIVED
canUndo:   false
peer:      converges on all three roots from the single update
```

| requirement | supported? | how |
| --- | --- | --- |
| replace all elements, incl. removal | **yes** | `replaceAllElements(desired, { recordHistory: false })` |
| non-recording (not undoable) | **yes** | same `recordHistory: false` → `STRUCTURAL_ORIGIN` |
| replace asset root exactly | **mechanism exists, not reachable cleanly** | `writeAssetLocators(root, desired, { prune: true })` |
| replace persisted appState exactly | **NO** | no prune path exists |
| one aggregate update | **yes** | `beginLogicalMutation()` / `endLogicalMutation()` |

### Elements — already exact, and this surprised me

`replaceAllElements` is genuinely a whole-set replace, not a merge: ids in the doc but absent from the input are **structurally removed** (`yElements.delete(id)`), along with their deletion markers and reconciliation meta, in one transaction — with `reserveTombstoneWatermark(id)` protecting version monotonicity. Nothing extra is required.

### Assets — the mechanism exists but is not exposed

`writeAssetLocators` already takes `{ prune?: boolean }` and deletes locators absent from the desired set. **`Scene.setAssetLocators` does not forward it**, so the public method is merge-only.

A caller _can_ reach `scene.yAssets` (it is `public readonly`) and call `writeAssetLocators` directly — that is what the measurement above did, and it works. **It should not be the recommendation**: writing to the root outside `doc.transact(fn, LOCAL_ORIGIN)` produces a transaction whose origin is `null`, which is outside this spec's deliberately closed set of three origins. It publishes (the filter only suppresses `REMOTE_ORIGIN`) and it takes the non-local branch of the observer. Harmless here, but it is an undeclared origin in a design whose whole point is that origins are closed.

### appState — the one real gap

`writeAppState` skips `undefined` (`if (next === undefined) continue`), so a key present in the doc but absent from the desired appState is **left in place** — confirmed above, where `name: "old name"` survived a replacement that did not mention it. There is no prune path at any layer.

## LANDED (2026-08-21)

Both options built exactly as scoped — additive, opt-in, defaults unchanged. Gate: `Scene.exactReplacement.test.ts` (5 cases) plus a four-way sabotage.

- `setAssetLocators(locators, { prune })` forwards the flag `writeAssetLocators` already implemented, under `LOCAL_ORIGIN` — so the write carries a declared origin instead of the `null` one a direct root write would produce.
- `setAppState(appState, { prune })` reconciles the allow-list exactly. In prune mode `undefined` means "not present" rather than "no opinion"; without that an exact replacement silently keeps a key the desired state never mentioned.
- **Atomicity was already correct** and is now pinned: `writeAssetLocators` validates the entire desired map _before_ the prune loop, so one bad locator cannot leave a half-pruned root, and a `data:` URL throws before the first deletion.

**Non-vacuity — four sabotages, each run**: dropping the prune forward in `setAssetLocators` fails 2 of 5; removing prune from `writeAppState` fails 2 of 5; moving the asset prevalidation after the prune loop fails 1 of 5; removing the logical-mutation boundary turns one emitted update into three.

Composition, public API only:

```ts
scene.beginLogicalMutation();
try {
  scene.replaceAllElements(desired.elements, { recordHistory: false });
  scene.setAssetLocators(desired.assets, { prune: true });
  scene.setAppState(desired.appState, { prune: true });
} finally {
  scene.endLogicalMutation();
}
```

## Smallest fork-owned change

Two options on existing methods. No new primitive, no new concept.

1. `setAssetLocators(locators, { prune?: boolean })` — forward to the flag `writeAssetLocators` already implements, under `LOCAL_ORIGIN`.
2. `setAppState(appState, { prune?: boolean })` — plus a few lines in `writeAppState` to delete allow-listed keys absent from the desired record. The allow-list is two keys, so the blast radius is small.

Both are additive and default to today's merge behaviour.

## Concurrency semantics — must be stated, not assumed

**Replacement is not exclusive.** It is an ordinary Yjs mutation, so a peer editing concurrently is not overridden:

- a peer's concurrently-added element is a separate struct and **survives** the replacement;
- a peer's concurrent property edit on a surviving element **merges per-property** — replacement does not win by virtue of being a replacement;
- only what the replacing client could see is replaced.

**DECIDED: causal / non-exclusive is the intended semantics.** What the operation replaces is _the generation the replacer observed after sync_, not the room. No lock and no quiescence mechanism is offered, deliberately — a genuinely concurrent addition or edit survives according to Yjs, and that is correct rather than a limitation to engineer around. Pinned by a test rather than left implied: a concurrent peer add survives the replacement, a concurrent property edit merges per-property, and both replicas converge.

## REDs the change would need

- old elements / assets / appState keys **absent** after replacement;
- desired values **exact**, including keys the desired set omits;
- **no `dataURL`** reachable (the existing egress guard already covers it — the new path must not bypass `writeAssetLocators`);
- **exactly one** emitted update for the whole replacement;
- a **remote replica converges** on all three roots from that update;
- the replacement produces **no undo step**;
- **concurrency**: a peer's concurrent add survives; a concurrent property edit merges — asserted so the non-exclusive semantics are pinned rather than implied.
