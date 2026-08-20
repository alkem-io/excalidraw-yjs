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
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const BUNDLES = [
  ["element/headless", "packages/element/dist/prod/headless.js"],
  // The umbrella subpath a consumer pins ONE package to reach. Same contract,
  // checked independently — a re-export can still be broken by a build config
  // that bundles it into the React barrel, and only importing the built file in
  // bare Node can tell.
  ["excalidraw/headless", "packages/excalidraw/dist/prod/headless.js"],
].map(([name, rel]) => [name, path.resolve(process.cwd(), rel)]);

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push([true, name, null]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
};

const REQUIRED = [
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

const BROWSER_ONLY = ["renderElement", "elementWithCanvasCache"];

for (const [label, bundle] of BUNDLES) {
  try {
    require.resolve(bundle);
  } catch {
    console.error(
      `headless bundle not built: ${bundle}\nRun \`pnpm run build:packages\` first.`,
    );
    process.exit(2);
  }

  // The import itself is the first assertion: module-scope DOM access throws here.
  let mod;
  await check(`${label}: imports in bare Node (no DOM)`, async () => {
    mod = await import(bundle);
  });
  if (!mod) {
    continue;
  }

  await check(`${label}: exports the server-facing surface`, () => {
    const missing = REQUIRED.filter((n) => mod[n] === undefined);
    if (missing.length) {
      throw new Error(`missing exports: ${missing.join(", ")}`);
    }
  });

  await check(`${label}: omits the browser-only surface`, () => {
    const leaked = BROWSER_ONLY.filter((n) => mod[n] !== undefined);
    if (leaked.length) {
      throw new Error(`browser-only exports leaked: ${leaked.join(", ")}`);
    }
  });

  await check(`${label}: the emitted bundle pulls in no React`, () => {
    // Scan the ARTIFACT, plus every chunk it imports — `splitting: true` hoists
    // shared code into chunks, and a chunk is exactly where UI could arrive
    // without ever appearing in the entry file. Checking the built output
    // rather than the source is the point: the build config is what breaks this.
    const seen = new Set();
    const scan = (file) => {
      if (seen.has(file)) {
        return;
      }
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      if (/from\s*["']react/.test(text) || /require\(["']react/.test(text)) {
        throw new Error(`react import in ${path.basename(file)}`);
      }
      for (const re of [
        /from\s*["'](\.\/[^"']+)["']/g,
        /import\s*["'](\.\/[^"']+)["']/g,
      ]) {
        for (const m of text.matchAll(re)) {
          scan(path.resolve(path.dirname(file), m[1]));
        }
      }
    };
    scan(bundle);
  });

  await check(`${label}: runs without a DOM`, () => {
    // `navigator` is a Node global from 18 on, so it proves nothing either way.
    // Written as `typeof` rather than a `globalThis` lookup: this file lints
    // under a config without `globalThis` declared, and an eslint error here is
    // how the previous revision of this check shipped broken.
    if (typeof window !== "undefined") {
      throw new Error("window exists — this is not a bare Node process");
    }
    if (typeof document !== "undefined") {
      throw new Error("document exists — this is not a bare Node process");
    }
  });

  await check(
    `${label}: adopts a Y.Doc, writes elements, emits updates`,
    async () => {
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
    },
  );

  await check(
    `${label}: round-trips a snapshot — the server's actual use`,
    () => {
      // `server` reaches for this surface to read and rewrite whiteboard content;
      // exercising it here is the difference between "the module imported" and
      // "the module works".
      const el = mod.newElement({
        type: "rectangle",
        x: 5,
        y: 6,
        width: 10,
        height: 10,
      });
      const bytes = mod.encodeSnapshot({
        elements: [el],
        assets: {},
        appState: {},
      });
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new Error("encodeSnapshot produced no bytes");
      }
      const back = mod.decodeSnapshot(bytes);
      if (back.elements.length !== 1) {
        throw new Error(
          `decodeSnapshot lost elements: ${back.elements.length}`,
        );
      }
      if (back.elements[0].x !== 5 || back.elements[0].y !== 6) {
        throw new Error("decodeSnapshot did not preserve geometry");
      }
    },
  );
}

// NOTE: this command builds `packages/excalidraw/dist`, and it used to remove it
// again, because a built dist made ten Sidebar tests fail and left
// `test:headless` and `test` non-composable in one working tree. That cleanup is
// gone: the cause was found and fixed at the root — three test files imported
// the package ROOT by relative directory path (`from "../.."`), which consults
// the package manifest and so resolved to the built bundle while everything
// around them resolved to source, giving two React contexts. `pnpm test` now
// passes with the build present, so deleting a developer's build output as a
// side effect of running tests is no longer warranted. Guarded by
// `packageRootImports.test.ts`.

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
