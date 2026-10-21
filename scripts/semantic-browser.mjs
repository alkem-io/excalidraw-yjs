import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { chromium } from "playwright";

import { createNodeTextMetricsProvider } from "../packages/excalidraw/dist/node/nodeMetrics.cjs";
import * as core from "../packages/element/dist/prod/headless.js";

const directory = await mkdtemp(path.join(tmpdir(), "semantic-browser-"));
let browser;
try {
  await build({
    entryPoints: ["scripts/semantic-fixture.ts"],
    outfile: path.join(directory, "fixture.js"),
    bundle: true,
    format: "iife",
    globalName: "fixture",
    platform: "browser",
    loader: {
      ".woff2": "dataurl",
      ".scss": "empty",
      ".css": "empty",
      ".svg": "text",
    },
    define: {
      "import.meta.env": JSON.stringify({ MODE: "production", PROD: true }),
      "process.env.NODE_ENV": '"production"',
    },
    alias: {
      "@excalidraw-yjs/common": path.resolve("packages/common/src"),
      "@excalidraw-yjs/element": path.resolve("packages/element/src"),
      "@excalidraw-yjs/math": path.resolve("packages/math/src"),
      "@excalidraw-yjs/utils": path.resolve("packages/utils/src"),
      "@excalidraw-yjs/fractional-indexing": path.resolve(
        "packages/fractional-indexing/src",
      ),
    },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addScriptTag({
    content: await readFile(path.join(directory, "fixture.js"), "utf8"),
  });
  const actual = await page.evaluate(async () => {
    for (const [family, faces] of Object.entries(fixture.bundledFontFaces)) {
      for (const face of faces) {
        const font = new FontFace(family, `url(${face.uri})`, face.descriptors);
        document.fonts.add(await font.load());
      }
    }
    const context = document.createElement("canvas").getContext("2d");
    const provider = {
      getLineWidth(text, font) {
        context.font = font;
        return context.measureText(text).width;
      },
    };
    fixture.core.setCustomTextMetricsProvider(provider);
    const samples = [];
    for (const family of Object.keys(fixture.bundledFontFaces)) {
      const text = family === "Xiaolai" ? "世界中文" : "Hello café";
      const font = `20px ${family}, Xiaolai, sans-serif`;
      samples.push({
        family,
        text,
        font,
        width: provider.getLineWidth(text, font),
      });
    }
    // Mixed primary/subset/fallback, combining marks, and actual wrapping edges.
    for (const text of [
      "Hello",
      "Привет",
      "αβγ",
      "héllo",
      "Łódź",
      "ӘӨ",
      "a\u030c",
      "Слава! Hello Ελληνικά",
      "世界",
      "e",
      "e\u0301",
      "ñ",
      "Ω",
      "Ж",
      "中",
      "e\u0301 ñ Ω Ж 中",
      "🧪 ∞∫≠",
    ]) {
      const font = "20px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji";
      const width = provider.getLineWidth(text, font);
      samples.push({ family: "Excalifont", text, font, width });
    }
    for (const text of [
      "Hello café Привет 世界 hello again",
      "café\nПривет 世界 e\u0301",
    ]) {
      const font = "20px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji";
      samples.push({
        family: "Excalifont",
        text,
        font,
        width: fixture.core.getTextWidth(text, font),
        multiline: text.includes("\n"),
      });
    }
    const wrapped = [60, 90, 120, 189.9, 190.1].map((width) => ({
      width,
      text: fixture.core.wrapText(
        "Hello café Привет 世界 hello again",
        "20px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji",
        width,
      ),
    }));
    for (const sample of samples) {
      const families = sample.font
        .replace(/^.*?px\s+/, "")
        .split(",")
        .map((family) => family.trim());
      // Classify by declared CSS coverage, never by whether a measurement passes.
      sample.covered = Array.from(sample.text).every((character) =>
        families.some((family) =>
          (fixture.bundledFontFaces[family] || []).some((face) =>
            (face.descriptors?.unicodeRange || "U+0-10FFFF")
              .split(",")
              .some((range) => {
                const [first, last = first] = range
                  .trim()
                  .replace(/^U\+/i, "")
                  .split("-")
                  .map((value) => parseInt(value, 16));
                const codepoint = character.codePointAt(0);
                return codepoint >= first && codepoint <= last;
              }),
          ),
        ),
      );
    }
    const scene = fixture.seed();
    return {
      samples,
      wrapped,
      reference: fixture.reference(),
      widthCases: fixture.widthCases,
      widthReference: fixture.widthReference(),
      importReference: fixture.importReference(),
      fontData: Object.values(fixture.bundledFontFaces).flatMap((faces) =>
        faces.map((face) => face.uri),
      ),
      seed: Array.from(fixture.Y.encodeStateAsUpdate(scene.doc)),
      operations: fixture.operations,
      loadedFonts: Array.from(document.fonts).map((face) => ({
        family: face.family,
        unicodeRange: face.unicodeRange,
        status: face.status,
      })),
    };
  });
  const provider = createNodeTextMetricsProvider();
  const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const browserFonts = actual.fontData
    .map((uri) => checksum(Buffer.from(uri.split(",")[1], "base64")))
    .sort();
  const fontDirectory = "packages/excalidraw/dist/node";
  const nodeFonts = await Promise.all(
    (await readdir(fontDirectory))
      .filter((name) => name.endsWith(".woff2"))
      .map(async (name) =>
        checksum(await readFile(path.join(fontDirectory, name))),
      ),
  );
  assert.deepEqual(
    [...new Set(browserFonts)],
    [...new Set(nodeFonts)].sort(),
    "browser and Node must load identical font bytes",
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  await page.evaluate((samples) => {
    samples.forEach((sample, index) => {
      const element = document.createElement("span");
      element.id = `font-proof-${index}`;
      element.style.font = sample.font;
      element.style.whiteSpace = "pre";
      element.style.display = "block";
      element.textContent = sample.text;
      document.body.append(element);
    });
  }, actual.samples);
  const { root } = await cdp.send("DOM.getDocument");
  for (const [index, sample] of actual.samples.entries()) {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `#font-proof-${index}`,
    });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    sample.selectedFonts = fonts;
  }
  const expectedFamilies = {
    Virgil: "Virgil",
    Cascadia: "Cascadia Code",
    Excalifont: "Excalifont",
    Nunito: "Nunito ExtraLight Medium",
    "Lilita One": "Lilita One",
    "Comic Shanns": "Comic Shanns Regular",
    "Liberation Sans": "Liberation Sans",
    Xiaolai: "Xiaolai SC",
  };
  // These fixed diagnostics were independently shown to select system fallback.
  // Codepoint-range unions do not prove that a rendered cluster uses that face.
  const diagnosticTexts = new Set([
    "a\u030c",
    "Ω",
    "e\u0301 ñ Ω Ж 中",
    "🧪 ∞∫≠",
  ]);
  for (const sample of actual.samples) {
    sample.blocking = !(
      sample.family === "Excalifont" && diagnosticTexts.has(sample.text)
    );
    if (!sample.blocking) {
      assert.ok(
        sample.selectedFonts.some(
          (font) => !font.isCustomFont && font.glyphCount > 0,
        ),
        `fixed diagnostic must prove system fallback: ${sample.text}`,
      );
      continue;
    }
    const expected =
      sample.family === "Excalifont" && /[世界中]/.test(sample.text)
        ? sample.text.replace(/[世界中\s]/g, "")
          ? ["Excalifont", "Xiaolai SC"]
          : ["Xiaolai SC"]
        : [expectedFamilies[sample.family]];
    assert.ok(
      sample.selectedFonts.length > 0 &&
        sample.selectedFonts.every(
          (font) => font.isCustomFont && font.glyphCount > 0,
        ),
      `blocking fixture selected unexpected fallback: ${sample.text}`,
    );
    assert.deepEqual(
      [...new Set(sample.selectedFonts.map((font) => font.familyName))].sort(),
      expected.sort(),
      `blocking fixture font identity: ${sample.text}`,
    );
  }
  assert.equal(
    actual.samples.filter((sample) => sample.blocking).length,
    23,
    "fixed nonempty same-face matrix",
  );
  const measurements = actual.samples.map((sample) => {
    const node = sample.multiline
      ? Math.max(
          ...sample.text
            .split("\n")
            .map((line) => provider.getLineWidth(line, sample.font)),
        )
      : provider.getLineWidth(sample.text, sample.font);
    const difference = Math.abs(node - sample.width);
    return { ...sample, node, difference };
  });
  const diagnostics = measurements.filter((sample) => !sample.blocking);
  process.stdout.write(
    `Non-parity diagnostics (directly proven system-font selection, including cluster fallback despite range-union coverage): ${JSON.stringify(
      diagnostics,
    )}\n`,
  );
  const mismatches = measurements.filter(
    (sample) => sample.blocking && sample.difference > 0.01,
  );
  if (mismatches.length) {
    process.stderr.write(
      `${JSON.stringify(
        {
          measurements,
          loadedFonts: actual.loadedFonts.filter((face) =>
            ["Excalifont", "Liberation Sans"].includes(face.family),
          ),
        },
        null,
        2,
      )}\n`,
    );
  }
  const differences = measurements
    .filter((sample) => sample.blocking)
    .map((sample) => sample.difference);
  core.setCustomTextMetricsProvider(provider);
  for (const expected of actual.wrapped) {
    assert.equal(
      core.wrapText(
        "Hello café Привет 世界 hello again",
        "20px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji",
        expected.width,
      ),
      expected.text,
    );
  }
  const Y = await import("yjs");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(actual.seed));
  const before = Y.encodeStateAsUpdate(doc);
  const prepared = core.prepareSemanticBatch(doc, actual.operations, {
    textMetricsProvider: provider,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  Y.applyUpdate(doc, prepared.update);
  const scene = new core.Scene(null, { doc });
  const canonical = (elements) => {
    const ids = new Map(
      elements.map((element, i) => [element.id, `element-${i}`]),
    );
    for (const element of elements) {
      for (const id of [
        ...element.groupIds,
        ...(element.fileId ? [element.fileId] : []),
      ]) {
        if (!ids.has(id)) {
          ids.set(id, `identity-${ids.size}`);
        }
      }
    }
    const visit = (value, key) => {
      if (["seed", "version", "versionNonce", "updated"].includes(key)) {
        return undefined;
      }
      if (typeof value === "string") {
        return ids.get(value) || value;
      }
      if (Array.isArray(value)) {
        const mapped = value.map((item) => visit(item));
        // Reciprocal bindings are a Y.Map-backed set, not an ordered list.
        return key === "boundElements"
          ? mapped.sort((a, b) => a.id.localeCompare(b.id))
          : mapped;
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .map(([k, v]) => [k, visit(v, k)])
            .filter(([, v]) => v !== undefined),
        );
      }
      return value;
    };
    return visit(elements);
  };
  const compare = (node, browser, at = "scene") => {
    if (typeof node === "number" && typeof browser === "number") {
      assert.ok(
        Math.abs(node - browser) <= 0.01,
        `${at}: ${node} != ${browser}`,
      );
    } else if (
      node &&
      browser &&
      typeof node === "object" &&
      typeof browser === "object"
    ) {
      assert.deepEqual(Object.keys(node), Object.keys(browser), at);
      for (const key of Object.keys(node)) {
        compare(node[key], browser[key], `${at}.${key}`);
      }
    } else {
      assert.equal(node, browser, at);
    }
  };
  compare(
    canonical(scene.getElementsIncludingDeleted()),
    canonical(actual.reference),
  );
  for (const [index, operation] of actual.widthCases.entries()) {
    const doc = new Y.Doc();
    const before = Y.encodeStateAsUpdate(doc);
    const result = core.prepareSemanticBatch(doc, [operation], {
      textMetricsProvider: provider,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    Y.applyUpdate(doc, result.update);
    const scene = new core.Scene(null, { doc });
    compare(
      canonical(scene.getNonDeletedElements()),
      canonical(actual.widthReference[index].initial),
    );
    const changed = core.prepareSemanticBatch(
      doc,
      [
        {
          op: "setText",
          elementId: result.addedElementIds[0],
          text: "Changed text stays within its fixed width\nHello café 世界",
        },
      ],
      { textMetricsProvider: provider },
    );
    assert.equal(changed.ok, true, JSON.stringify(changed));
    Y.applyUpdate(doc, changed.update);
    compare(
      canonical(scene.getNonDeletedElements()),
      canonical(actual.widthReference[index].changed),
    );
    for (const height of [10, null]) {
      assert.equal(
        core.prepareSemanticBatch(doc, [{ ...operation, height }], {
          textMetricsProvider: provider,
        }).ok,
        false,
      );
    }
    scene.destroy();
  }
  const importDoc = new Y.Doc();
  const imported = core.prepareSceneImport(
    importDoc,
    {
      scene: actual.importReference.exported,
      targetFileIDs: { "source-image": "logical-target" },
    },
    { textMetricsProvider: provider },
  );
  assert.equal(imported.ok, true, JSON.stringify(imported));
  Y.applyUpdate(importDoc, imported.update);
  const importedScene = new core.Scene(null, { doc: importDoc });
  compare(
    canonical(importedScene.getNonDeletedElements()),
    canonical(actual.importReference.elements),
  );
  importedScene.destroy();
  scene.destroy();
  assert.deepEqual(mismatches, [], "actual registered font/cluster parity");
  process.stdout.write(
    `PASS actual Chromium font/subset/fallback samples=${
      differences.length
    } maxDelta=${Math.max(...differences)}px; exact wraps=${
      actual.wrapped.length
    }; editor-owner semantic parity operations=${actual.operations.length}\n`,
  );
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
// As in the existing headless smoke, this one-shot harness owns its exit rather
// than waiting for the element owner's sixty-second cache cleanup timer.
process.exit(0);
