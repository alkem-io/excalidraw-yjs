import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "semantic-package-"));
try {
  const dependencies = { yjs: "13.6.27" };
  let canvasVersion;
  for (const name of [
    "common",
    "fractional-indexing",
    "math",
    "element",
    "excalidraw",
  ]) {
    const pkg = JSON.parse(
      await readFile(`packages/${name}/package.json`, "utf8"),
    );
    if (name === "excalidraw") {
      canvasVersion = pkg.peerDependencies["@napi-rs/canvas"];
      assert.equal(pkg.dependencies["@napi-rs/canvas"], undefined);
      assert.equal(pkg.peerDependenciesMeta["@napi-rs/canvas"].optional, true);
      assert.equal(canvasVersion, pkg.devDependencies["@napi-rs/canvas"]);
    }
    execFileSync("pnpm", ["pack", "--pack-destination", directory], {
      cwd: `packages/${name}`,
      stdio: "pipe",
    });
    dependencies[pkg.name] = `file:${path.join(
      directory,
      `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`,
    )}`;
  }
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      private: true,
      dependencies,
      pnpm: { overrides: dependencies },
    }),
  );
  execFileSync(
    "pnpm",
    ["install", "--ignore-scripts"],
    { cwd: directory, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [
      "-e",
      `const assert = require("node:assert/strict");
       assert.throws(() => require.resolve("@napi-rs/canvas"), {code:"MODULE_NOT_FOUND"});
       const core = require("@excalidraw-yjs/excalidraw/headless");
       assert.equal(typeof core.prepareSemanticBatch, "function");
       console.log("PASS packed browser-only dependency graph and headless import without native canvas");`,
    ],
    { cwd: directory, stdio: "inherit" },
  );
  execFileSync(
    "pnpm",
    ["add", `@napi-rs/canvas@${canvasVersion}`, "--ignore-scripts"],
    { cwd: directory, stdio: "pipe" },
  );
  const installed = path.join(
    directory,
    "node_modules/@excalidraw-yjs/excalidraw/dist/node",
  );
  assert.ok(
    (await readdir(installed)).filter((file) => file.endsWith(".woff2"))
      .length > 50,
    "actual bundled subset assets must be packed",
  );
  const exercise = `
    const assert = require("node:assert/strict");
    const Y = require("yjs");
    const core = require("@excalidraw-yjs/excalidraw/headless");
    const {createNodeTextMetricsProvider} = require("@excalidraw-yjs/excalidraw/node-metrics");
    assert.equal(typeof document, "undefined");
    assert.equal(typeof window, "undefined");
    const provider = createNodeTextMetricsProvider();
    const font = "20px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji";
    assert.ok(Math.abs(provider.getLineWidth("Hello", font) - 43.2) < 0.01);
    assert.ok(Math.abs(provider.getLineWidth("Привет", font) - 63.44) < 0.01);
    assert.ok(Math.abs(provider.getLineWidth("世界", font) - 40) < 0.01);
    core.setCustomTextMetricsProvider(provider);
    assert.equal(core.wrapText("Hello Hello", font, 95), "Hello Hello");
    assert.equal(core.wrapText("Hello Hello", font, 80), "Hello\\nHello");
    const doc = new Y.Doc();
    const before = Y.encodeStateAsUpdate(doc);
    let broadcasts = 0;
    doc.on("update", () => broadcasts++);
    const result = core.prepareSemanticBatch(doc, [
      {op:"addShape",shape:"rectangle",label:"Привет 世界"},
      {op:"addText",text:"café\\nαβγ",x:0,y:300},
    ], {textMetricsProvider:provider});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    assert.equal(broadcasts, 0);
    Y.applyUpdate(doc, result.update);
    const scene = new core.Scene(null, {doc});
    assert.equal(scene.getNonDeletedElements().length, 3);
    const shape = scene.getNonDeletedElements().find(el => el.type === "rectangle");
    const label = scene.getElement(shape.boundElements[0].id);
    assert.equal(label.containerId, shape.id);
    assert.equal(label.originalText, "Привет 世界");
    const once = Y.encodeStateAsUpdate(doc);
    Y.applyUpdate(doc, result.update);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), once);
    const failed = core.prepareSemanticBatch(doc,[{op:"addText",text:"not leaked"},{op:"setText",elementId:"missing",text:"bad"}],{textMetricsProvider:provider});
    assert.equal(failed.ok,false);
    assert.equal(failed.update,undefined);
    assert.deepEqual(Y.encodeStateAsUpdate(doc),once);
    scene.destroy();
    console.log("PASS packed CommonJS actual-font semantic preparation, unchanged input, late-invalid atomicity, wrapped metrics and exact update replay");
    // The existing element-owner cache retains a sixty-second cleanup timer.
    // This one-shot subprocess, like the existing headless smoke, owns its exit.
    process.exit(0);
  `;
  execFileSync(process.execPath, ["-e", exercise], {
    cwd: directory,
    stdio: "inherit",
  });
  const esm = `
    import assert from "node:assert/strict";
    import * as Y from "yjs";
    import {prepareSemanticBatch,Scene} from "@excalidraw-yjs/excalidraw/headless";
    import {createNodeTextMetricsProvider} from "@excalidraw-yjs/excalidraw/node-metrics";
    const doc = new Y.Doc();
    const result = prepareSemanticBatch(doc,[{op:"addText",text:"built ESM 世界"}],{textMetricsProvider:createNodeTextMetricsProvider()});
    assert.equal(result.ok,true,JSON.stringify(result));
    Y.applyUpdate(doc,result.update);
    const scene = new Scene(null,{doc});
    assert.equal(scene.getNonDeletedElements()[0].originalText,"built ESM 世界");
    scene.destroy();
    console.log("PASS packed ESM actual-font semantic execution without DOM or source aliases");
    process.exit(0);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", esm], {
    cwd: directory,
    stdio: "inherit",
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
