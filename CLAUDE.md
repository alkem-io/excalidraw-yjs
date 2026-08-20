# CLAUDE.md

## Project Structure

Excalidraw is a **monorepo** with a clear separation between the core library and the application:

- **`packages/excalidraw/`** - Main React component library published to npm as `@excalidraw-yjs/excalidraw`
- **`excalidraw-app/`** - Full-featured web application (excalidraw.com) that uses the library
- **`packages/`** - Core packages: `@excalidraw-yjs/common`, `@excalidraw-yjs/element`, `@excalidraw-yjs/math`, `@excalidraw-yjs/utils`
- **`examples/`** - Integration examples (NextJS, browser script)

## Development Workflow

1. **Package Development**: Work in `packages/*` for editor features
2. **App Development**: Work in `excalidraw-app/` for app-specific features
3. **Testing**: Always run `pnpm run test:update` before committing
4. **Type Safety**: Use `pnpm run test:typecheck` to verify TypeScript

## Development Commands

```bash
pnpm run test:gates      # THE gate — mirrors CI command for command (see below)
pnpm run test:typecheck  # TypeScript type checking
pnpm run test:update     # Run all tests (with snapshot updates)
pnpm run test:headless   # Build the packages, then import the BUILT bundles in bare Node
pnpm run fix             # Auto-fix formatting and linting issues
```

**Use `test:gates` before pushing.** It runs what CI runs, in CI's order: `pnpm install --frozen-lockfile` → `test:other` (prettier) → `test:code` (`eslint --max-warnings=0` over the whole repo) → `test:typecheck` → coverage → `test:headless`. This exists because a green local run once certified a branch whose CI was already red: every other gate operates on an already-installed tree, so none of them noticed a stale `pnpm-lock.yaml`.

**A built `packages/*/dist` is local state CI never has** — no workflow builds before running tests. If something fails only locally, remove those directories and re-measure before believing it; when the two disagree, the difference is the finding. This has caused three separate incidents.

## Architecture Notes

### Package System

- Uses pnpm workspaces (`workspace:*` protocol) for monorepo management
- Internal packages use path aliases (see `vitest.config.mts`)
- Build system uses esbuild for packages, Vite for the app
- TypeScript throughout with strict configuration

## Excalidraw - Alkemio Fork

In this case, this is @excalidraw-yjs/excalidraw, a fork of the original Excalidraw repository. Alkemio's custom version is as similar as possible to the original to avoid conflicts when updating from master.

### Differences with standard Excalidraw

**The big one, and the reason most of the rest exists: the Scene's element store IS a `Y.Doc`.** This is not a binding or a sync layer bolted onto the editor — `mutateElement` writes per-property into the doc, rendering materializes JS objects out of it, and single-user history, collaboration and persistence all run on that one document. Read `specs/002-native-yjs-lineage/` before changing anything on the write path, the wire, history or assets; it records what each invariant is and, more usefully, which plausible-sounding assumptions about them turned out to be false.

Consequences worth knowing before you touch adjacent code:

- **Elements are immutable snapshots derived from the doc.** A captured element reference never changes; re-read it from the scene after any write.
- **Only keys whose value actually changed are written**, so a `version` bump means a real change — the old model bumped versions incidentally.
- **Undo/redo is `Y.UndoManager` scoped to `LOCAL_ORIGIN`**, so undo reverts only this replica's edits and never a peer's.
- **The document carries `fileId → opaque locator`, never image bytes**, validated on every write and every encode. Hosts supply an `AssetAdapter` and call `flushAssetPublication()` before a save or close.
- **`@excalidraw-yjs/excalidraw/headless`** is a Node-safe entry (no React, no DOM) for servers and batch jobs.

### Other differences with standard Excalidraw

- Selected from a non-yet-released Excalidraw version that is already upgraded to React 19.
- Added ZoomToFit button to the zoom toolbar.
- Modified the paste functionality to avoid pasting elements (such as images) as JSON when editing text.
- Changed the toolbar Lock button behavior. Now it locks/unlocks elements instead of the tool in use.
- Changed the load from file behavior to fix multi-user collaboration bug. Now elements loaded will be inserted in the current scene instead of replacing all the elements of the scene.
- Added emoji insert tool.
- Added emoji realtime reaction broadcast tool.
- Added a shared broadcasted timer tool.

### Development process

Avoiding conflicts when merging from master is very important to us, Excalidraw is being actively developed and we are only adding some extra features:

- Try to make as few as possible modifications to the original files
- When adding features try to separate them as much as possible in new files
- When adding translations, add them only in the english file and at the end of the file unless it makes a lot of sense to insert them somewhere else
- Don't touch config files, don't upgrade packages, don't change the build process, always try to make customizations available from outside through the API rather than changing things inside the package
