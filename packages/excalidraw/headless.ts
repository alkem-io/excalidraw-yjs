/**
 * `@excalidraw-yjs/excalidraw/headless` — the Node-safe surface, served from the
 * single package a consumer already depends on.
 *
 * ## Why this exists
 *
 * Consumers were pinning TWO packages to get one product: `excalidraw` for the
 * editor and `element` for the headless/snapshot API. Two pins drift — `server`
 * and `client-web` were measured sitting on different build identifiers of the
 * same monorepo. This subpath removes the second pin: everything a server needs
 * is reachable from `@excalidraw-yjs/excalidraw`.
 *
 * ## What it is, precisely
 *
 * A pure re-export of {@link module:@excalidraw-yjs/element/headless}, and
 * deliberately nothing else. It adds no surface of its own, so the two entries
 * cannot drift in content, and it is a SEPARATE esbuild entry point — importing
 * it never loads this package's React barrel. `@excalidraw-yjs/element` is
 * `external` in the build, so the emitted file is a re-export, not a copy: a
 * consumer resolves the same `element` instance either way.
 *
 * ## The guarantee, and how it is checked
 *
 * `pnpm run test:headless` builds the packages and then imports THIS BUILT
 * BUNDLE in a bare Node process — no jsdom — and drives the real snapshot/edit
 * workflow. The import itself is the module-scope assertion. Static analysis is
 * not used and was deliberately abandoned once before (see
 * `scripts/headless-smoke.mjs`); the runtime answers this exactly.
 *
 * The element entry's caveats carry over unchanged and are NOT re-stated here,
 * so they cannot fall out of sync: import-safety is the guarantee rather than
 * zero-reachability, and text measurement needs
 * `setCustomTextMetricsProvider` at bootstrap. See that module's doc comment.
 */
export * from "@excalidraw-yjs/element/headless";
