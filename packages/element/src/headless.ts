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
 * - **Import-safe in Node.** Nothing reachable from this entry performs DOM
 *   access at MODULE SCOPE, so importing it cannot throw. Enforced by
 *   `__tests__/headless.contract.test.ts`, which walks the runtime import graph
 *   (value imports only — `import type` is erased at compile time) and fails if a
 *   new module-scope DOM access appears.
 *
 *   Import-safety is the guarantee, NOT zero-reachability. `shape` imports the
 *   `elementWithCanvasCache` WeakMap from `renderElement`, so that module is
 *   loaded; its DOM access lives inside function bodies that this entry does not
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
 * ## KNOWN GAP — this contract is NOT yet sufficient for Node
 *
 * Verified by building the bundle and importing it in bare Node: the import
 * SUCCEEDS, but `scene.replaceAllElements([...])` then throws
 * `ReferenceError: window is not defined`. The dependency comes from
 * `@excalidraw-yjs/common` (`constants.ts` reads `window.EXCALIDRAW_EXPORT_SOURCE`
 * / `window.location.origin`; `utils.ts` uses `window.setTimeout` and
 * `requestAnimationFrame`), which is bundled into this entry's runtime.
 *
 * The contract test below walks only relative imports, so it stops at the package
 * boundary and does not see this. Until that is closed, treat this entry as
 * "import-safe and export-scoped" — NOT as "usable headless end to end". See spec
 * 002 task T018.
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
