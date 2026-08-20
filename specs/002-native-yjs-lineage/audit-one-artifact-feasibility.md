# Audit — what one artifact would actually cost

**Status: read-only. Nothing repackaged, nothing published, `@2af664c` untouched and still the pin for the client migration.**

## The measured cost of putting `server` on the umbrella

Two scratch installs at the same identifier (`2af664c`), pnpm 10.17.1, one direct dependency each:

|  | `@excalidraw-yjs/element` | `@excalidraw-yjs/excalidraw` | factor |
| --- | --- | --- | --- |
| published tarball | **1.3 MB** | **31.7 MB** | 24× |
| installed `node_modules` | **18 MB** | **267 MB** | 14.8× |
| packages in the store | **10** | **289** | 28.9× |
| lockfile lines | **79** | **3125** | 39.6× |

The gap is concentrated, not diffuse. `mermaid@11.17.0` alone is **84 MB**, and with `@mermaid-js/parser` (13 + 6 MB), `cytoscape` (6 + 9 MB) and `langium` (6 MB) the mermaid subtree is **~124 MB of the 267**. Then `es-toolkit` 17 MB, `react-dom` 8 MB, `sass` 5 MB.

**Runtime cost is zero; install and image cost is all of it.** Mermaid is `await import(...)`-ed lazily (`App.tsx:4141`, `TTDDialog.tsx:73`) and is **absent from the emitted `headless.js`** — a server never executes a byte of it. It is installed anyway, because it is a hard `dependency` in the umbrella's manifest. npm and pnpm have no notion of "install only what this subpath needs".

## The premise deserves re-checking before anything is rebuilt

The complaint was that consumers _"must not coordinate five packages or multiple SHAs"_. Measured against the repos:

- **`server` pinned exactly ONE package** (`@excalidraw-yjs/element`) and imported `element/headless`. It never coordinated five.
- **`client-web` pinned TWO** — and that was already fixed by the umbrella re-exporting `encodeSnapshot` / `decodeSnapshot` / `WhiteboardSnapshot`, which it has done since before this work started. Three import specifiers, no new subpath required.
- The five artifacts `pkg-pr-new` publishes were never something a consumer named. They are transitive; the lockfile resolves them from one identifier.

So **"one direct dependency per consumer" was one import-specifier change away, and did not require server to move at all.** Moving it onto the umbrella bought a shared package _name_ and cost 249 MB. That is the tradeoff to decide consciously, because it is not what the original complaint asked for.

## Is a TRUE one-artifact publish feasible?

**Not without the server installing the UI graph.** Taking the routes in turn:

1. **Bundle the internal workspace packages into the umbrella** (drop `@excalidraw-yjs/*` from `external` in `scripts/buildPackage.js`). Mechanically the easiest thing here: `splitting: true` already emits shared chunks, so `index.js` and `headless.js` would share element's code rather than duplicate it. This genuinely gets **5 published artifacts → 1**. It does **nothing** for the 34 UI dependencies — the server still installs mermaid. It solves "five artifacts", which nobody was actually complaining about, and not "the server pays for the UI", which is the real cost.
2. **`peerDependenciesMeta.optional` on the 34 UI deps.** Moves the burden to the client, which would then have to declare all 34 itself. Strictly worse than two package names.
3. **`optionalDependencies`.** No effect: pnpm installs them by default.
4. **Vendor the UI deps into the tarball.** Inflates a 31.7 MB tarball much further, breaks deduplication, and breaks React/jotai singletons. Not viable.

**Conclusion: one artifact and a cheap server install are mutually exclusive under npm/pnpm semantics.** Any claim otherwise needs to name the mechanism.

## Ranked routes, with what each actually buys

**A. Leave the split; server pins the headless artifact.** Cost to server: 18 MB. Consumers coordinate one package each — server the headless one, client the UI one — at the same identifier. This is what the original complaint asked for and it needs no repackaging at all; the umbrella `/headless` subpath stays as a convenience for anyone who wants a single name and can afford it.

**B. Rename for clarity, same shape.** If two names are acceptable but `element` reads as an internal, publish the headless artifact under an intention-revealing name (`@excalidraw-yjs/core`) and mark `common` / `math` / `fractional-indexing` as implementation detail. Cost: a rename and one migration. Buys clarity, not bytes.

**C. Bundle internals → one artifact, accept the install.** 5 artifacts → 1, and every consumer installs 267 MB. Choose only if a single published name is worth more than the server's image size.

**D. Split the UI feature out.** The single biggest lever is mermaid: moving `@excalidraw/mermaid-to-excalidraw` to an optional peer dependency would cut ~124 MB for **every** consumer, including client-web, since it is already loaded lazily. It changes behaviour for hosts that use the TTD dialog, so it is a product decision, not a packaging one. Flagged, not proposed.

## One thing worth fixing regardless of the route

**`sass` and `cross-env` are declared as runtime `dependencies` of the umbrella** and are build-time tools — verified, neither is imported by any shipped source and neither appears in the built bundle. Every consumer installs them (~5 MB, 2 packages) for nothing. Moving them to `devDependencies` is independent of every decision above.

## Not done here, deliberately

No manifest was edited, no build config touched, nothing republished. The measurements are reproducible from two scratch manifests at `2af664c`.
