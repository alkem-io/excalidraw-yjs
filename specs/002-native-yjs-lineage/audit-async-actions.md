# Async action audit (T016k prerequisite)

**Method**: enumerate every `perform: async` DEFINITION, then trace post-`await` transitive effects. Not a text scan for `scene.mutateElement` — that would certify `actionPaste` falsely, because its element insertion is delegated out-of-band.

**Correction to my earlier claim of "three async element-mutating actions": there are EIGHT async `perform` definitions.** I had counted files, not definitions.

| Action | file:line | awaits | post-await transitive effect | element authority | boundary |
| --- | --- | --- | --- | --- | --- |
| `actionCopy` | Clipboard:28 | `copyToClipboard` | none (0 element writes) | none — returns no `elements` | unchanged; never drafts |
| `actionPaste` | Clipboard:59 | `readSystemClipboard()` | **`app.pasteFromClipboard(createPasteEvent({types}))`** (line 92) | **delegated out-of-band** — inserts elements without returning them | **own commit boundary at the paste/import site**; must NOT be classified as safe derived-fallback |
| `actionCopyAsSvg` | Clipboard:129 | `exportCanvas` | none | passthrough of input `elements` | unchanged; never drafts |
| `actionCopyAsPng` | Clipboard:197 | `exportCanvas` | none | passthrough of input `elements` | unchanged; never drafts |
| `actionSaveToActiveFile` | Export:321 | `resaveAsImageWithScene` / `saveAsJSON` | file I/O only | none | unchanged; never drafts |
| `actionSaveFileToDisk` | Export:390 | `saveAsJSON` | file I/O only | none | unchanged; never drafts |
| `actionLoadScene` | Export:458 | `loadFromJSON` | **`app.addElementsFromPasteOrLibrary({...})`** | **delegated out-of-band** | **own commit boundary at the import site** |
| `actionCopyElementLink` | ElementLink:21 | `copyTextToSystemClipboard` | none | returns invocation-time `elements` on fallback + `catch` | unchanged; never drafts |

**Also audited, and it is why function-level labels are insufficient**: `actionCut` (Clipboard:112) has a **synchronous** `perform` that calls `actionCopy.perform(...)` **without awaiting** — a detached async continuation — then returns `actionDeleteSelected.perform(...)`. Verified `actionCopy` performs zero element writes, so the detached continuation is safe and `actionCut` may draft on the strength of its synchronous `actionDeleteSelected` result.

## Consequence: the async fallback mechanism is DELETED, not designed

Applying "try to delete it": no async action needs the draft. Four touch no elements at all; two pass their input through unchanged; two (`actionPaste`, `actionLoadScene`) delegate insertion out-of-band to paths that already own their own commit. **There is no reachable state in which an async action needs to enter and then leave a draft.**

So there is no discard-and-fallback, no post-hoc thenable handling, and no orphaned-promise hazard to guard — the mechanism that would have needed all three does not exist.

Discrimination is **before invocation** and structural, not a mode or a list:

```ts
const isAsyncPerform = (fn: Function) =>
  fn.constructor.name === "AsyncFunction";
```

All eight are declared `perform: async`, so this covers every current case, and it is evaluated without calling anything.

**Honest limit**: a `perform` declared sync that returns a thenable would not be detected. None exists today. Per the standing rule this is NOT guarded speculatively — this table is the gate, and a new async element-mutating action must be added here.
