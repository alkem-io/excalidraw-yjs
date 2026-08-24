<p align="center"><a href="https://www.alkemio.org/" target="blank"><img src="https://alkem.io/logo.png" width="400" alt="Alkemio Logo" /></a></p>

# Excalidraw Yjs

Excalidraw Yjs is Alkemio's native-Yjs hard fork of [Excalidraw](https://github.com/excalidraw/excalidraw). It keeps Excalidraw's editor and drawing semantics while making a `Y.Doc` the authoritative scene model for collaboration, persistence, history, and headless editing.

This is not the former Alkemio soft fork and it is not a small patch queue over upstream Excalidraw. Its package names, document model, persistence contract, asset boundary, build, and release process intentionally differ. Do not assume wire-format, storage-format, or drop-in compatibility with upstream Excalidraw or with packages from the archived soft fork.

## Why this repository exists

The original integration translated repeatedly between an Excalidraw element array and a separate collaboration document. That bridge made concurrent edits, undo, persistence, and server-authored changes depend on duplicated state and reconciliation rules.

This fork removes the bridge. A scene owns one `Y.Doc`, and every supported writer—browser or server—uses the same element semantics and Yjs schema:

```text
Y.Doc
├── elements           element id -> per-property Y.Map
├── files              file id -> opaque asset locator
├── appState           allow-listed collaborative scalar values
└── elementDeletions   element id -> deletion timestamp
```

The encoded Yjs V2 update is the persisted and transported whiteboard state. Images are deliberately not embedded in it: asset bytes live in host-owned storage and are reached through the locators in `files`.

## Core invariants

- **One mutable source of truth.** Elements, asset references, collaborative app state, and deletion metadata live in the scene's `Y.Doc`.
- **Per-property convergence.** Each element is a nested Yjs map. Concurrent changes to different properties of the same element survive independently.
- **Immutable derived elements.** `Scene` reads return fresh snapshots. Change an element through `Scene.mutateElement()` or `replaceAllElements()`, then use the returned value or re-read it; a previously held object is stale.
- **Closed transaction origins.** Local and structural changes may be published; remote changes are applied without being echoed. Undo and redo track local-origin mutations only.
- **No binary data in the document.** The `files` root stores only validated, opaque locators. `data:` URLs and binary payloads are rejected at this boundary.
- **Assets remain host-owned.** Garbage collection removes old tombstones and unreferenced locators, but never deletes bytes from external storage.
- **Browser and server share semantics.** Node consumers use the supported headless entry point instead of reimplementing element construction, mutation, binding, validation, or snapshot conversion.

These are compatibility boundaries, not implementation suggestions. Changes that weaken them require an explicit design decision and discriminating tests.

## Packages and entry points

The coordinated release publishes these packages:

| Package | Purpose | Runtime |
| --- | --- | --- |
| `@excalidraw-yjs/excalidraw` | React editor and imperative API | Browser |
| `@excalidraw-yjs/excalidraw/headless` | Convenience re-export of the headless element surface | Node, ESM |
| `@excalidraw-yjs/element` | Element and scene implementation | Browser-oriented main barrel |
| `@excalidraw-yjs/element/headless` | DOM-safe scene, element, Yjs, and snapshot operations | Node, ESM and CommonJS |
| `@excalidraw-yjs/common` | Shared primitives used by the published packages | Internal building block |
| `@excalidraw-yjs/fractional-indexing` | Collaborative element ordering | Internal building block |
| `@excalidraw-yjs/math` | Geometry and math primitives | Internal building block |

Use declared exports only. Reaching into package internals is unsupported and can accidentally pull browser-only modules into Node.

## Browser usage

Install the React component and its peers:

```bash
pnpm add @excalidraw-yjs/excalidraw yjs react react-dom
```

```tsx
import { Excalidraw } from "@excalidraw-yjs/excalidraw";
import "@excalidraw-yjs/excalidraw/index.css";

export function Whiteboard() {
  return (
    <div style={{ height: "100vh" }}>
      <Excalidraw />
    </div>
  );
}
```

The editor is client-side. In an SSR application, load it from a client-only component or use the framework's dynamic-import mechanism with SSR disabled.

### Asset storage

Collaborative images require an `AssetAdapter` supplied by the host:

```ts
import type { AssetAdapter } from "@excalidraw-yjs/excalidraw/types";

const assetAdapter: AssetAdapter = {
  store: async (file) => {
    // Persist file.dataURL or its decoded bytes and return an opaque locator.
    return uploadAsset(file);
  },
  resolve: async (fileId, locator) => downloadAsset(fileId, locator),
};

<Excalidraw assetAdapter={assetAdapter} />;
```

`store()` must settle: the host must bound its network operation and reject on timeout. Before reporting a successful save or closing the editor, await `excalidrawAPI.flushAssetPublication()`. A non-empty `failed` result means the scene contains image references whose bytes peers cannot resolve and must be treated as a failed save.

An encoded scene is therefore not a self-contained archive. A complete archive contains both the Yjs V2 update and every externally stored asset referenced by its locators.

## Headless usage

The headless surface is verified in a bare Node process without DOM or React. It supports scene adoption, element construction and mutation, binding, validation, garbage collection, and snapshot encoding/decoding.

ES modules can use the umbrella entry point:

```ts
import * as Y from "yjs";
import { Scene, newElement } from "@excalidraw-yjs/excalidraw/headless";

const scene = new Scene(undefined, { doc: new Y.Doc() });
const rectangle = newElement({
  type: "rectangle",
  x: 0,
  y: 0,
  width: 120,
  height: 80,
});

scene.replaceAllElements([rectangle]);
const updated = scene.mutateElement(scene.getElement(rectangle.id), { x: 40 });
const update = scene.encodeStateAsUpdate("v2");

console.log(updated.x, update.byteLength);
scene.destroy();
```

CommonJS consumers must use the element headless entry, whose `require` condition is built against the same CommonJS Yjs instance as the host:

```js
const Y = require("yjs");
const { Scene, newElement } = require("@excalidraw-yjs/element/headless");

const scene = new Scene(undefined, { doc: new Y.Doc() });
scene.replaceAllElements([
  newElement({ type: "rectangle", x: 0, y: 0, width: 120, height: 80 }),
]);
```

Do not dynamically import the ESM headless bundle and pass it a `Y.Doc` created by `require("yjs")`. Yjs is a dual package; mixing those module-system instances produces different constructors and can fail with `Not same Y.Doc` or `Unexpected content type`.

Text layout is the one intentional headless runtime caveat. Before using a path that measures or wraps text, register a production-grade provider with `setCustomTextMetricsProvider()`. Its font metrics must agree with the browser; the test fallback is deterministic but not visually accurate.

## Development

Use Node.js 22 for the same runtime line as CI. The repository declares pnpm 10.17.1 through Corepack.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

Useful commands:

```bash
pnpm build:packages   # build the coordinated package set
pnpm test:headless   # build and test ESM + CommonJS bare-Node entry points
pnpm test:gates      # complete required gate
pnpm fix             # format and apply safe lint fixes
pnpm rm:build        # remove generated build output
```

Run `pnpm test:gates` before pushing. It performs a frozen install, formatting, linting, type checking, the Vitest coverage suite, package builds, and both headless runtime smokes.

## Publishing

Publishing is coordinated because the packages depend on one another through `workspace:*`:

- Qualifying package/build pull requests and manual workflow runs publish immutable `pkg.pr.new` preview artifacts. Consume the exact identifier emitted by the workflow; do not construct a preview URL from a branch name or commit yourself.
- A `v*` tag publishes the coordinated package set to npm through the `Release Excalidraw Yjs packages` workflow with npm trusted publishing and provenance. A rerun safely skips versions already present in the registry, then waits for each dependency to become visible before publishing its consumers.
- The coordinated `@excalidraw-yjs/*` package set follows this hard fork's own SemVer, beginning at `0.5.0` for all five published packages. Each package records the full upstream Excalidraw commit used as the synchronization baseline. Compare that SHA with current upstream to audit functionality added since the last synchronization; bump the package-set version for releases of this fork even when the upstream baseline has not changed. Version and upstream provenance are independent.

The historical soft-fork workflow—merging an Alkemio branch into an upstream release commit, using Yarn, and publishing a single manually packed package—does not apply to this repository.

## Working with upstream

[Upstream Excalidraw](https://github.com/excalidraw/excalidraw) remains the project's source heritage and an important source of editor improvements. It is not a branch that can be merged mechanically into this repository.

Port upstream changes deliberately:

1. Identify the user-facing behavior and the upstream commits that implement it.
2. Reconcile the change with the native-Yjs scene, origin, history, asset, and headless contracts.
3. Adapt it to the `@excalidraw-yjs/*` workspace and pnpm build.
4. Add or update tests that exercise the fork's real storage and runtime boundaries.
5. Run the complete gate.

Git history and GitHub releases are the change record. This README intentionally does not duplicate a manually maintained historical changelog.

## Design documentation

- [`packages/excalidraw/README.md`](packages/excalidraw/README.md) — React component API and integration details
- [`specs/001-yjs-per-property-binding`](specs/001-yjs-per-property-binding) — per-property Yjs schema and collaboration semantics
- [`specs/002-native-yjs-lineage`](specs/002-native-yjs-lineage) — native-Yjs lineage, persistence, headless, and asset decisions
- [`CLAUDE.md`](CLAUDE.md) — repository engineering rules and current invariant map

## License and attribution

This project is distributed under the [MIT License](LICENSE). It is derived from the open-source [Excalidraw](https://github.com/excalidraw/excalidraw) project; upstream copyright and license notices remain applicable to derived code.

Excalidraw is a trademark of its respective owner. Alkemio's hard fork is published under the `@excalidraw-yjs` scope to make the distinction explicit.
