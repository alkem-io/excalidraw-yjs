/* eslint-disable no-console -- a smoke harness reports by printing; matches scripts/headless-smoke.mjs */
/**
 * The CommonJS half of the headless contract.
 *
 * `scripts/headless-smoke.mjs` imports the built bundle BY ABSOLUTE PATH from an
 * ESM process. That never touches the package's `exports` map and never involves
 * a second module system, so it was structurally incapable of catching this:
 *
 *     require("yjs")            -> yjs/dist/yjs.cjs
 *     require.resolve(headless) -> element/dist/prod/headless.js   (ESM)
 *     [yjs#509] Not same Y.Doc
 *     insertElement FAILED -> Unexpected content type
 *
 * `yjs` is a DUAL package: `require("yjs")` and `import("yjs")` load different
 * files from the same installed copy and produce different `Doc`/`AbstractType`
 * constructors. `server`'s `loadWhiteboardFork` requires yjs and dynamically
 * imports this package, so it handed a CJS `Y.Doc` to a Scene built against the
 * ESM one — and yjs's `instanceof` checks fail across the two.
 *
 * Externalising `yjs` in the bundle does not fix that, and neither does the
 * peerDependency: both make ESM consumers share ONE INSTALL, and the hazard is
 * two module systems reading one install. What fixes it is a real `require`
 * condition whose bundle resolves `yjs` through CommonJS.
 *
 * So this file must, and does, differ from the ESM smoke in three ways that all
 * matter: it is CommonJS, it resolves BY PACKAGE NAME through the exports map,
 * and it creates the `Y.Doc` from `require("yjs")` rather than from whatever the
 * bundle happened to import.
 */

const { createRequire } = require("node:module");
const path = require("node:path");
const process = require("node:process");

// Resolve as a consumer does — by name, through the exports map. Anchored at
// `packages/element` because a pnpm workspace links siblings per package rather
// than at the root; a consumer's own node_modules gives the same resolution.
const consumerRequire = createRequire(
  path.resolve(__dirname, "../packages/element/package.json"),
);

let failures = 0;
let checks = 0;

const check = (label, fn) => {
  checks += 1;
  try {
    fn();
    say(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    say(`  FAIL  ${label}\n        ${error && error.message}`);
  }
};

// yjs reports the cross-instance failure by LOGGING `[yjs#509] Not same Y.Doc`
// and only then throwing something vaguer ("Unexpected content type"). Capture
// the console so the diagnostic itself is an assertion rather than noise that
// scrolls past.
const logged = [];
const originalConsole = {};
const say = console.log.bind(console);
for (const level of ["log", "warn", "error"]) {
  originalConsole[level] = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map(String).join(" "));
    if (process.env.CJS_SMOKE_VERBOSE) {
      originalConsole[level](...args);
    }
  };
}
const restoreConsole = () => {
  for (const level of ["log", "warn", "error"]) {
    console[level] = originalConsole[level];
  }
};

const RECT = {
  id: "r1",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version: 1,
  versionNonce: 1,
  updated: 1,
  index: "a1",
  isDeleted: false,
  seed: 1,
};

const Y = consumerRequire("yjs");
const resolvedYjs = consumerRequire.resolve("yjs");
const resolvedHeadless = consumerRequire.resolve(
  "@excalidraw-yjs/element/headless",
);

let headless = null;
let scene = null;
let encoded = null;

check("require('yjs') resolves to the CommonJS build", () => {
  if (!resolvedYjs.endsWith(".cjs")) {
    throw new Error(`expected a .cjs file, got ${resolvedYjs}`);
  }
});

check("the exports map serves CommonJS a CommonJS bundle", () => {
  if (!resolvedHeadless.endsWith(".cjs")) {
    throw new Error(
      `require() resolved to ${resolvedHeadless} — an ESM file, so the host's ` +
        `require("yjs") and this bundle's yjs are different instances`,
    );
  }
});

check("require() of the headless entry succeeds", () => {
  headless = consumerRequire("@excalidraw-yjs/element/headless");
  if (typeof headless.Scene !== "function") {
    throw new Error("no Scene export");
  }
});

check("a Scene adopts a Y.Doc created by require('yjs')", () => {
  scene = new headless.Scene(undefined, { doc: new Y.Doc() });
});

check("insertElement writes through that adopted doc", () => {
  scene.insertElement({ ...RECT });
  const back = scene.getElement("r1");
  if (!back || back.id !== "r1") {
    throw new Error("element did not materialize");
  }
});

check("mutateElement writes through that adopted doc", () => {
  scene.mutateElement(scene.getElement("r1"), { x: 42 });
  if (scene.getElement("r1").x !== 42) {
    throw new Error("mutation did not land");
  }
});

check("encodeStateAsUpdate produces bytes", () => {
  encoded = scene.encodeStateAsUpdate("v2");
  if (!(encoded instanceof Uint8Array) || encoded.byteLength === 0) {
    throw new Error("no bytes");
  }
});

// Nonempty bytes prove only that something was written. This proves the bytes
// are readable BY A SECOND CommonJS Y.Doc — a real round trip across the
// boundary that was broken, rather than a length check.
check("those bytes round-trip into a fresh require('yjs') Doc", () => {
  const receiving = new Y.Doc();
  Y.applyUpdateV2(receiving, encoded);
  const adopted = new headless.Scene(undefined, { doc: receiving });
  const back = adopted.getElement("r1");
  if (!back) {
    throw new Error("element did not survive the round trip");
  }
  if (back.x !== 42) {
    throw new Error(`expected the mutated x=42, got ${back.x}`);
  }
});

// The whole point: yjs must never have reported a cross-instance mismatch.
check("yjs reported no cross-instance failure (#509 / #438)", () => {
  const bad = logged.filter((line) =>
    /#509|Not same Y\.Doc|Unexpected content type|already imported/i.test(line),
  );
  if (bad.length) {
    throw new Error(bad.join(" | ").slice(0, 300));
  }
});

// Node's conditions are ORDER-SENSITIVE and `development`/`production` are real
// conditions a host can pass. With `require` listed after them, a CommonJS
// process started with `--conditions=development` matches `development` first,
// gets the ESM file, and the dual-instance split returns — invisible to a
// default-node run, which is why this spawns a child with the flag set.
check("require() still lands .cjs under --conditions=development", () => {
  const { execFileSync } = require("node:child_process");
  const probe =
    "const {createRequire}=require('node:module');" +
    `const r=createRequire(${JSON.stringify(
      path.resolve(__dirname, "../packages/element/package.json"),
    )});` +
    "process.stdout.write(r.resolve('@excalidraw-yjs/element/headless'));";
  for (const condition of ["development", "production"]) {
    const out = execFileSync(
      process.execPath,
      [`--conditions=${condition}`, "-e", probe],
      { encoding: "utf8" },
    );
    if (!out.endsWith(".cjs")) {
      throw new Error(
        `--conditions=${condition} resolved require() to ${out} — an ESM file, ` +
          "so `require` must be ordered BEFORE it in the exports map",
      );
    }
  }
});

restoreConsole();

say(
  `\n${checks - failures}/${checks} CommonJS headless checks passed${
    failures ? ` — ${failures} FAILED` : ""
  }`,
);
process.exit(failures ? 1 : 0);
