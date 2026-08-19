/**
 * Verifies the `@excalidraw-yjs/element/headless` contract the way a consumer
 * experiences it: a bare Node process, no jsdom, importing the BUILT bundle and
 * driving the real workflow.
 *
 * Run: `pnpm run test:headless`, which BUILDS the element package and its
 * workspace siblings first. That ordering is part of the command, not a
 * convention the caller has to remember — running the script directly against a
 * stale `dist/` would happily pass after a source regression.
 *
 * Why a script and not a vitest case: the suite runs under jsdom with a global
 * setup that defines `window.matchMedia`, `document.fonts` and friends, so it
 * cannot observe a missing DOM. An earlier attempt walked the import graph and
 * pattern-matched DOM access at brace-depth zero, with special cases for
 * `typeof x !== "undefined"` guards and arrow-function bodies — an approximation
 * of something the runtime answers exactly, which produced false positives on
 * lazily-evaluated lambdas. Deleted in favour of this.
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const BUNDLE = path.resolve(
  process.cwd(),
  "packages/element/dist/prod/headless.js",
);

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push([true, name, null]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
};

try {
  require.resolve(BUNDLE);
} catch {
  console.error(
    `headless bundle not built: ${BUNDLE}\nRun \`pnpm run build:packages\` first.`,
  );
  process.exit(2);
}

// The import itself is the first assertion: module-scope DOM access throws here.
let mod;
await check("imports in bare Node (no DOM)", async () => {
  mod = await import(BUNDLE);
});

if (mod) {
  await check("exports the server-facing surface", () => {
    const required = [
      "Scene",
      "newElement",
      "mutateElement",
      "setCustomTextMetricsProvider",
      "computeElementIntent",
      "captureElementBase",
      "elementToYMap",
      "yMapToElement",
      "encodeSnapshot",
      "decodeSnapshot",
    ];
    const missing = required.filter((n) => mod[n] === undefined);
    if (missing.length) {
      throw new Error(`missing exports: ${missing.join(", ")}`);
    }
  });

  await check("omits the browser-only surface", () => {
    const leaked = ["renderElement", "elementWithCanvasCache"].filter(
      (n) => mod[n] !== undefined,
    );
    if (leaked.length) {
      throw new Error(`browser-only exports leaked: ${leaked.join(", ")}`);
    }
  });

  await check("adopts a Y.Doc, writes elements, emits updates", async () => {
    const Y = await import("yjs");
    const doc = new Y.Doc();
    const scene = new mod.Scene(undefined, { doc });
    const updates = [];
    scene.onDocUpdate((u) => updates.push(u));

    const el = mod.newElement({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    scene.replaceAllElements([el]);
    if (scene.getElementsIncludingDeleted().length !== 1) {
      throw new Error("element not in doc after replaceAllElements");
    }

    scene.mutateElement(scene.getElement(el.id), { x: 42 });
    if (scene.getElement(el.id).x !== 42) {
      throw new Error("mutateElement did not reach the doc");
    }
    if (updates.length === 0) {
      throw new Error("no updates emitted");
    }
    if (scene.encodeStateAsUpdate().byteLength === 0) {
      throw new Error("encodeStateAsUpdate produced no bytes");
    }
    scene.destroy();
  });
}

let failed = 0;
for (const [ok, name, err] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${err ? ` — ${err}` : ""}`);
  if (!ok) {
    failed++;
  }
}
console.log(
  `\n${results.length - failed}/${results.length} headless checks passed`,
);
process.exit(failed ? 1 : 0);
