const path = require("path");

const { build } = require("esbuild");

const HEADLESS_ENTRY = "src/headless.ts";

// contains all dependencies bundled inside
const getConfig = (outdir) => ({
  outdir,
  bundle: true,
  format: "esm",
  // `src/headless.ts` is a SECOND entry so `@excalidraw-yjs/element/headless`
  // resolves to its own bundle rather than the full barrel. Without it the
  // exports map's `./*` wildcard would send the subpath back to `index.js`,
  // loading the browser-only modules the entry exists to exclude. Packages
  // without that file are unaffected — esbuild skips a missing entry only if we
  // filter it, so the list is built from what exists on disk.
  entryPoints: ["src/index.ts", "src/headless.ts"].filter((e) =>
    require("fs").existsSync(path.resolve(process.cwd(), e)),
  ),
  entryNames: "[name]",
  assetNames: "[dir]/[name]",
  alias: {
    "@excalidraw-yjs/utils": path.resolve(__dirname, "../packages/utils/src"),
  },
  external: [
    "@excalidraw-yjs/common",
    "@excalidraw-yjs/element",
    "@excalidraw-yjs/math",
    "@excalidraw-yjs/fractional-indexing",
    // Public upstream package the order helpers depend on directly (re-pointed off
    // the internal, unpublished `@excalidraw-yjs/fractional-indexing` so the published
    // package installs without a consumer override). Kept external so it resolves
    // from the consumer's node_modules rather than being inlined into the bundle.
    "fractional-indexing",
    // The CRDT runtime MUST be externalized, never bundled. Native-Yjs core: the
    // editor's element store IS a `Y.Doc` (`@excalidraw-yjs/element`'s `Scene` owns it)
    // and collaboration/persistence exchange Yjs updates on it. A consumer that
    // creates or receives its own `Y.Doc` (collab provider, persistence) and a
    // bundled copy of yjs would be two distinct `yjs` instances, and yjs's
    // `instanceof` checks fail across copies ("Unexpected content type", yjs#438).
    // Externalizing makes every ESM consumer share the single `yjs` /
    // `y-protocols` / `lib0` it installs (declared as peerDependencies).
    //
    // NOT SUFFICIENT ON ITS OWN, and the peerDependency does not guarantee one
    // instance either: `yjs` is a DUAL package, so `require("yjs")` and
    // `import("yjs")` load different files from the same installed copy and
    // produce different constructors. A CommonJS host therefore needs a real
    // `require` condition on this package — see `getCJSConfig` below.
    "yjs",
    "y-protocols",
    "y-protocols/*",
    "lib0",
    "lib0/*",
  ],
});

function buildDev(config) {
  return build({
    ...config,
    sourcemap: true,
    define: {
      "import.meta.env": JSON.stringify({ DEV: true }),
    },
  });
}

function buildProd(config) {
  return build({
    ...config,
    minify: true,
    define: {
      "import.meta.env": JSON.stringify({ PROD: true }),
    },
  });
}

/**
 * CommonJS output, for `require()` consumers of the headless entry.
 *
 * WHY THIS EXISTS. `yjs` is a dual package: `require("yjs")` gets
 * `dist/yjs.cjs` and `import("yjs")` gets `dist/yjs.mjs`, and those are two
 * distinct module instances with two distinct `Doc`/`AbstractType`
 * constructors. Shipping only ESM meant a CommonJS host — `server`'s
 * `loadWhiteboardFork`, which `require()`s yjs and dynamically imports this
 * package — handed a `require("yjs")` `Y.Doc` to a Scene whose bundle had
 * imported `yjs.mjs`. Reproduced against the server's own installed tree:
 *
 *     require("yjs")            -> yjs/dist/yjs.cjs
 *     require.resolve(headless) -> element/dist/prod/headless.js   (ESM)
 *     [yjs#509] Not same Y.Doc
 *     insertElement FAILED -> Unexpected content type
 *
 * Externalising `yjs` (below) is necessary but NOT sufficient for this: it makes
 * every ESM consumer share one copy, and says nothing about a CJS one. The fix
 * is a real `require` condition whose bundle resolves `yjs` through CommonJS, so
 * the host's `require("yjs")` and this bundle's `require("yjs")` are the same
 * file and therefore the same instance.
 *
 * The internal `@excalidraw-yjs/*` packages are deliberately NOT external here.
 * They publish ESM only, so a CJS bundle cannot `require()` them; they are
 * bundled in instead. That duplicates their code into this one file, which is
 * acceptable precisely because none of them owns cross-instance state — the CRDT
 * runtime does, and it stays external.
 */
const getCJSConfig = (outdir) => ({
  ...getConfig(outdir),
  format: "cjs",
  outdir,
  // Explicitly a bare-Node export: use Node resolution and built-in semantics,
  // not esbuild's default browser platform.
  platform: "node",
  // ONLY the headless entry. `server` consumes `./headless`; a CJS root barrel
  // would be new, untested surface and a dead artifact, so it is not emitted and
  // the root subpath keeps no `require` condition.
  entryPoints: [HEADLESS_ENTRY],
  // Only the CRDT runtime stays external — see the docblock above. Everything
  // `@excalidraw-yjs/*` is bundled because those packages are ESM-only.
  external: ["yjs", "y-protocols", "y-protocols/*", "lib0", "lib0/*"],
  // `splitting` is ESM-only in esbuild; CJS emits one file per entry.
  splitting: false,
  // The package is `"type": "module"`, so a `.js` file is ESM no matter what is
  // inside it — Node would parse this CommonJS bundle as ESM and die on
  // `module is not defined in ES module scope`. The `.cjs` extension is what
  // actually makes it CommonJS.
  outExtension: { ".js": ".cjs" },
});

const createESMRawBuild = async () => {
  // development unminified build with source maps
  await buildDev(getConfig("dist/dev"));

  // production minified build without sourcemaps
  await buildProd(getConfig("dist/prod"));
};

const createCJSBuild = async () => {
  // This script builds EVERY package (common, math, fractional-indexing,
  // element); only `element` has a headless entry, so the others emit no CJS at
  // all rather than failing on a missing entry point.
  if (!require("fs").existsSync(path.resolve(process.cwd(), HEADLESS_ENTRY))) {
    return;
  }
  await buildProd(getCJSConfig("dist/cjs"));
};

(async () => {
  await createESMRawBuild();
  await createCJSBuild();
})();
