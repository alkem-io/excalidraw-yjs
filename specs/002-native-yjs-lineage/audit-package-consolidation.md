# Audit — one consumer release unit for `@excalidraw-yjs/*`

**Status:** audit + proposal. Nothing landed. Requested because consumers are being asked to coordinate five packages and, worse, are drifting onto different build identifiers: `server` currently pins `@excalidraw-yjs/element` at `cdf8f67bca0289d4accb1bacfb1e6548891c21c1` while `client-web` pins `element` and `excalidraw` at a different one. **The goal is one direct dependency per consumer, one identifier selecting the whole graph.**

The existing installable preview is untouched by everything below.

## The finding that shortens this a lot

**The client half needs no packaging change at all — it is already done and nobody noticed.** `packages/excalidraw/index.tsx:415-421` already re-exports the snapshot API, with a comment stating precisely this intent:

> re-export the native-Yjs snapshot schema so consumers get it from the single published `@excalidraw-yjs/excalidraw` package rather than a separately-published `@excalidraw-yjs/element`

And `client-web` imports **exactly three names** from `@excalidraw-yjs/element`, across three files: `encodeSnapshot`, `decodeSnapshot`, and the type `WhiteboardSnapshot`. All three are on the umbrella already.

- `src/domain/collaboration/whiteboard/utils/mergeWhiteboard.ts`
- `src/domain/common/whiteboard/EmptyWhiteboard.ts`
- `src/domain/common/whiteboard/excalidraw/whiteboardContent.ts`

So client-web drops to **one** direct pin by rewriting three import specifiers. No build change, no new package, no release change.

## Q1 — can `@excalidraw-yjs/excalidraw` be the umbrella?

**Client: yes, today** (above). **Server: yes, with one new runtime subpath.**

`server` uses `import('@excalidraw-yjs/element/headless')` — dynamically, in `src/services/mcp-server/collaboration/whiteboard-fork.ts`. The umbrella cannot serve that today because **every subpath export on `excalidraw` is types-only** (`./common/*`, `./element/*`, `./math/*`, `./utils/*`, `./*`); only `.` and `./index.css` carry runtime.

Adding a runtime `./headless` to the umbrella looks feasible and cheap:

- `element/headless` **imports no React** — checked — and builds to a separate 235 KB artifact against the element barrel's 286 KB, so it is already a distinct entry rather than a filtered view of a bigger one.
- The umbrella builds with `entryPoints: ["index.tsx", "**/*.chunk.ts"]` (`scripts/buildPackage.js:110`). A `headless.ts` entry that re-exports **only** `@excalidraw-yjs/element/headless` produces its own output file; nothing in the React barrel is reachable from it, so the server never bundles or executes UI.
- The precedent is in-repo: `scripts/buildBase.js:16` already lists `src/headless.ts` as a second entry for exactly this reason.
- **The guarantee is already testable.** `pnpm run test:headless` builds and then imports the BUILT bundle in a bare Node process. Extending it to the umbrella's `./headless` makes the claim measured rather than argued — which is the condition for landing this at all.

## Q2 — is a separate facade package needed?

**No, and it would work against the goal.** The umbrella already is the facade for the client; extending it with one runtime subpath is less machinery than a sixth published artifact added to the set we are trying to shrink. Revisit only if the umbrella's `.` entry ever has to stay React-free for someone.

Tree-shaking caveat worth fixing regardless: **no package declares `sideEffects`**, so every bundler must assume side effects throughout. Declaring it (`false`, or a precise list for the CSS entry) is a small independent win.

## Q3 — one authoritative identifier

**Already true mechanically; the burden is self-inflicted by pinning more than one package.** Verified by real install: pinning only the top-level package(s), the lockfile resolves **exactly one** identifier and all five packages land in the store, because the published manifests carry their siblings pinned to the same build. Consumers never need to name `common`, `math` or `fractional-indexing`.

- **Previews**: `pkg-pr-new` publishes all five because the `workspace:*` closure requires it, and rewrites sibling deps to same-build URLs. Nothing to change.
- **Tagged releases**: `pnpm publish` rewrites `workspace:*` to exact versions, so one version selects the graph **provided all five are bumped in lockstep**. That lockstep is the one real release-process obligation. `fractional-indexing` sits on its own version line (`3.3.0` vs `0.18.0`) — fine, as long as it is exact-pinned, which it is.

## Q4 — migration (owned by collab-unification)

1. **client-web** — rewrite three import specifiers to `@excalidraw-yjs/excalidraw`; drop the `@excalidraw-yjs/element` dependency. Available now.
2. **fork** — add the umbrella `./headless` entry + export, extend `test:headless` to cover it. Small, and gated on that test passing.
3. **server** — swap `@excalidraw-yjs/element/headless` for `@excalidraw-yjs/excalidraw/headless`; drop the `element` dependency. This is what ends the two-repos-on-two-SHAs drift.

Step 1 is independent of 2 and 3 and can land first.

## Q5 — is the `common` ↔ `math` cycle real?

**Real in source, in both directions, and barely load-bearing.** `common/src/{colors,utils,points}.ts` import from `math`; `math/src/range.ts` imports exactly **one** symbol back — `toBrandedType`. Moving that single symbol to a leaf (or into `math`) breaks the cycle. Worth doing while the package boundary is being tidied, but it blocks nothing above and should not be bundled into the same change.

## What is deliberately NOT proposed

Renaming or republishing the internal packages, changing what `pkg-pr-new` publishes, or "pin the same SHA everywhere" — the last being the current headache rather than a fix.
