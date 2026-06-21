const path = require("path");

const { build } = require("esbuild");

// contains all dependencies bundled inside
const getConfig = (outdir) => ({
  outdir,
  bundle: true,
  format: "esm",
  entryPoints: ["src/index.ts"],
  entryNames: "[name]",
  assetNames: "[dir]/[name]",
  alias: {
    "@excalidraw/utils": path.resolve(__dirname, "../packages/utils/src"),
  },
  external: [
    "@excalidraw/common",
    "@excalidraw/element",
    "@excalidraw/math",
    "@excalidraw/fractional-indexing",
    // Public upstream package the yjs-binding now depends on directly (its order
    // helpers were re-pointed off the internal, unpublished
    // `@excalidraw/fractional-indexing` so the published binding installs without
    // a consumer override). Kept external so it resolves from the consumer's
    // node_modules rather than being inlined into the bundle.
    "fractional-indexing",
    // The CRDT runtime MUST be externalized, never bundled: a consumer that
    // creates its own `Y.Doc` (every client whiteboard/memo content path) and
    // hands it to `populateYDoc` / `exportSceneJSON` / `hashDocState` /
    // `WhiteboardBinding` would otherwise mix two distinct `yjs` instances, and
    // yjs's `instanceof` checks fail across copies ("Unexpected content type",
    // yjs#438). Externalizing makes the binding share the single `yjs` /
    // `y-protocols` / `lib0` the consumer installs (declared as peerDependencies).
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

const createESMRawBuild = async () => {
  // development unminified build with source maps
  await buildDev(getConfig("dist/dev"));

  // production minified build without sourcemaps
  await buildProd(getConfig("dist/prod"));
};

(async () => {
  await createESMRawBuild();
})();
