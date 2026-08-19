/**
 * `@excalidraw-yjs/element/headless` — the Node-safe surface of the element
 * package (spec 002, FR-016 companion).
 *
 * ## What this is for
 *
 * Server-side consumers (the MCP whiteboard tools, batch/import jobs) need the
 * fork's element semantics — construct elements, mutate them, bind them,
 * read/write the `Y.Doc` — running headless in Node. They must NOT reimplement
 * those semantics, or server-authored content diverges from client-authored
 * content.
 *
 * The general barrel (`@excalidraw-yjs/element`) also re-exports rendering,
 * hyperlink and visual-debug helpers that require a browser. Those are omitted
 * here. This entry is the declared contract; reaching past it into the barrel
 * from Node works today only by accident.
 *
 * ## The contract, precisely
 *
 * - **Verified in a real DOM-free runtime**, not by static analysis. `pnpm run
 *   test:headless` builds this package and its siblings, then imports the BUILT
 *   bundle in a bare Node process and drives the workflow: adopt a `Y.Doc`, write
 *   elements, mutate per-property, emit updates, encode state. The import itself
 *   is the module-scope assertion; a call-time DOM read throws when called.
 *
 *   Import-safety is the guarantee, NOT zero-reachability. `shape` imports the
 *   `elementWithCanvasCache` WeakMap from `renderElement`, so that module is
 *   loaded; its DOM access lives inside function bodies this entry does not
 *   export and a headless caller must not invoke.
 * - **One runtime DOM dependency, with an escape hatch.** Text measurement
 *   lazily constructs a canvas-backed provider on first use. Call
 *   {@link setCustomTextMetricsProvider} at process bootstrap, BEFORE touching any
 *   text element, or anything routing through `measureText` / `wrapText` /
 *   `redrawTextBoundingBox` will throw in Node. Note the built-in provider's
 *   `isTestEnv()` branch returns `charCount * 10` for test determinism — it is
 *   deliberately wrong and must not be used as a reference implementation. A
 *   server provider must agree with the browser's real font metrics, or text
 *   wraps at different points and every bound element shifts.
 *
 * ## Not exported here (browser-only)
 *
 * `renderElement` (canvas rasterization), `elementLink` (reads the browser
 * location), `visualdebug`, and `store` — the editor's Store/StoreDelta
 * machinery, which is editor-side history/reconciliation rather than document
 * semantics, and which self-imports the package barrel (dragging the browser-only
 * modules back in). `delta` is omitted for the same reason — it reaches `store`.
 * `Scene` depends on neither.
 */

export * from "./align";
export * from "./binding";
export * from "./bounds";
export * from "./collision";
export * from "./comparisons";
export * from "./containerCache";
export * from "./cropElement";
export * from "./distance";
export * from "./distribute";
export * from "./duplicate";
export * from "./elbowArrow";
export * from "./flowchart";
export * from "./fractionalIndex";
export * from "./frame";
export * from "./groups";
export * from "./heading";
export * from "./image";
export * from "./mutateElement";
export * from "./newElement";
export * from "./positionElementsOnGrid";
export * from "./resizeElements";
export * from "./Scene";
export * from "./selection";
export * from "./shape";
export * from "./sizeHelpers";
export * from "./sortElements";
export * from "./textElement";
export * from "./textMeasurements";
export * from "./textWrapping";
export * from "./transform";
export * from "./typeChecks";
export * from "./utils";
export * from "./zindex";
export * from "./arrows/helpers";
export * from "./arrowheads";
export * from "./yjs";
