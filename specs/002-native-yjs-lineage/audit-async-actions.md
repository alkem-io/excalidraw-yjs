# Async action audit (T016k prerequisite)

**Method**: enumerate every `perform: async` DEFINITION, then trace transitive effects across each `await`. Not a text scan for `scene.mutateElement` — that certifies `actionPaste` falsely, since its insertion is delegated out-of-band.

**Correction**: my earlier "three async element-mutating actions" counted FILES. There are **eight** definitions.

## Write semantics, classified

The classes matter more than the count. "Never drafts" is mechanism wording and proves nothing about writes, so each row states what the action actually does.

| Action | file:line | sync prefix writes | class | after `await` |
| --- | --- | --- | --- | --- |
| `actionCopy` | Clipboard:28 | 0 | **no element effect** | clipboard only |
| `actionCopyAsSvg` | Clipboard:129 | 0 | **no element effect**; returns input `elements` unchanged | `exportCanvas` |
| `actionCopyAsPng` | Clipboard:197 | 0 | **no element effect**; returns input `elements` unchanged | `exportCanvas` |
| `actionSaveToActiveFile` | Export:321 | 0 | **no element effect** | file I/O |
| `actionSaveFileToDisk` | Export:390 | 0 | **no element effect** | file I/O |
| `actionCopyElementLink` | ElementLink:21 | 0 | **returns STALE invocation `elements`** on the fallback and `catch` paths — handled by base/result planning, not by a write | clipboard only |
| `actionPaste` | Clipboard:59 | 0 | **DELEGATES A WRITE AFTER `await`** — `app.pasteFromClipboard(createPasteEvent({types}))` (line 92) | inserts elements without returning them |
| `actionLoadScene` | Export:458 | 0 | **DELEGATES A WRITE AFTER `await`, THEN RETURNS A SECOND ActionResult** — `app.addElementsFromPasteOrLibrary({...})`, then `return { elements: app.scene.getNonDeletedElements() }` | membership applied twice (see T016n) |

**Measured precondition**: all eight have **zero element writes in their synchronous prefix** (checked from the `perform` body to the first `await`). This is what makes "discard an _empty_ draft on a promise-like result" valid.

## `actionCut` — why function-level labels are insufficient

`actionCut` (Clipboard:112) has a **synchronous** `perform` that calls `actionCopy.perform(...)` **without awaiting** — a detached async continuation — then returns `actionDeleteSelected.perform(...)`. `actionCopy` performs zero element writes, so the detached continuation is harmless and `actionCut` may draft on its synchronous result. But a sync/async label on the function would have told us nothing.

## What paste/import actually do today — NOT an atomic boundary

I previously wrote that paste/import "own their own commit boundary". **That was false and described something that does not exist.** Verified:

- `App.addElementsFromPasteOrLibrary` calls `this.scene.replaceAllElements(nextElements)` — the authoritative whole-scene path T016 is replacing — and then `redrawTextBoundingBox(...)`, which mutates Scene again.
- Other paste branches call `insertNewElements`, which chunks by `frameId` and calls `scene.insertElementsAtIndex` **once per chunk** — several logical writes.

Keeping `actionPaste`/`actionLoadScene` out of the action draft is reasonable. Claiming they already commit atomically is not. Tracked as **T016m**: a real RED integration test at the paste/import commit site, then migrate it.

**T016n**: `actionLoadScene` applies membership twice — once via `addElementsFromPasteOrLibrary`, once via the `ActionResult` it returns afterwards. One application is redundant and must be **deleted**, not reconciled.

## Consequence for the draft mechanism

No async action needs the draft, so there is no fallback machinery to build: on a promise-like result the draft is discarded (provably empty) and the existing path continues untouched. Discrimination is behavioural and follows the declared `ActionResult | Promise<ActionResult>` union — no constructor-name reflection, no mode, no list, no registration API.

**Honest limit, deliberately unguarded**: a `perform` declared sync that returns a thenable would enter the draft and then be discarded on the same rule — which is correct behaviour, not a hazard, precisely because the discard requires no cleanup. This table remains the gate for any new async element-mutating action.
