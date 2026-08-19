import fs from "node:fs";
import path from "node:path";

/**
 * Enforces the `@excalidraw-yjs/element/headless` contract (spec 002, FR-016
 * companion) so that Node-safety is a guarantee rather than an accident.
 *
 * Today the package happens to be importable in Node because every DOM access
 * sits inside a function body. Nothing prevents an upstream merge from adding a
 * module-scope `document.` reference, which would break the server at import
 * time with no signal until runtime. This test is that signal.
 */

const SRC = path.resolve(__dirname, "..");
const ENTRY = path.join(SRC, "headless.ts");

/** Modules known to contain DOM access, each reachable for a stated reason. A
 * NEW entry appearing here is the thing this test exists to catch. */
const ALLOWED_DOM_MODULES: Record<string, string> = {
  "textMeasurements.ts":
    "lazy canvas provider; replaced via setCustomTextMetricsProvider at bootstrap",
  "renderElement.ts":
    "shape.ts imports the elementWithCanvasCache WeakMap; the DOM code is in unexported-from-here functions",
};

const stripCommentsAndStrings = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");

const resolveImport = (from: string, spec: string): string | null => {
  if (!spec.startsWith(".")) {
    return null;
  }
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
};

/** Value imports only — `import type` is erased at compile time and cannot pull
 * DOM code into a runtime bundle. */
const valueImports = (file: string): string[] => {
  const src = fs.readFileSync(file, "utf8");
  const out = new Set<string>();
  const re =
    /(?:^|\n)\s*(import|export)(\s+type)?\b([\s\S]*?)from\s+["']([^"']+)["']/g;
  let m = re.exec(src);
  while (m) {
    if (!m[2]) {
      const named = m[3].match(/\{([\s\S]*)\}/);
      const allTypes =
        named &&
        named[1]
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .every((x) => x.startsWith("type "));
      if (!allTypes) {
        const r = resolveImport(file, m[4]);
        if (r) {
          out.add(r);
        }
      }
    }
    m = re.exec(src);
  }
  return [...out];
};

const closure = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) {
      continue;
    }
    seen.add(f);
    stack.push(...valueImports(f));
  }
  return seen;
};

/** A `typeof document !== "undefined"` style guard, which makes module-scope
 * access safe in Node — upstream already uses one for the image placeholder. */
const GUARD = /typeof\s+(document|window)\s*[!=]==?\s*["']undefined["']/;

/**
 * UNGUARDED DOM access at brace-depth 0 — evaluated on import rather than inside
 * a function or class body, and not protected by an environment check. That is
 * what makes an import throw in Node.
 *
 * Brace depth is a heuristic, not a parse; a guarded hit is recognised by looking
 * at a small window around the line, because the guard is typically a ternary
 * spanning several lines. Both approximations err toward reporting, so a false
 * positive shows up as a failing test to investigate rather than a silent pass.
 */
const moduleScopeDomAccess = (file: string): string[] => {
  const raw = fs.readFileSync(file, "utf8");
  // Guard detection runs on RAW lines: `stripCommentsAndStrings` would remove the
  // `"undefined"` literal the guard is written in terms of.
  const rawLines = raw.split("\n");
  const lines = stripCommentsAndStrings(raw).split("\n");
  const hits: string[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 0 && /\b(document|window)\s*\./.test(line)) {
      const window_ = rawLines.slice(Math.max(0, i - 3), i + 2).join("\n");
      if (!GUARD.test(window_)) {
        hits.push(line.trim());
      }
    }
    for (const ch of line) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return hits;
};

describe("@excalidraw-yjs/element/headless contract", () => {
  const reachable = closure(ENTRY);

  it("is importable in Node — no DOM access at module scope anywhere reachable", () => {
    const offenders = [...reachable]
      .map((f) => [path.relative(SRC, f), moduleScopeDomAccess(f)] as const)
      .filter(([, hits]) => hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it("does not reach outside the element package", () => {
    const outside = [...reachable].filter((f) => !f.startsWith(SRC));
    expect(outside).toEqual([]);
  });

  it("reaches no browser-only module beyond the documented allow-list", () => {
    const domModules = [...reachable]
      .filter((f) =>
        /\b(document|window)\s*\./.test(
          stripCommentsAndStrings(fs.readFileSync(f, "utf8")),
        ),
      )
      .map((f) => path.relative(SRC, f))
      .sort();

    // A new name here means something browser-only became reachable. Either route
    // around it, or add it with a reason once you have confirmed its DOM access
    // cannot run on an import.
    expect(domModules).toEqual(Object.keys(ALLOWED_DOM_MODULES).sort());
  });

  it("exports the text-metrics escape hatch, since text work needs it in Node", async () => {
    const mod = await import("../headless");
    expect(typeof mod.setCustomTextMetricsProvider).toBe("function");
    expect(typeof mod.Scene).toBe("function");
    expect(typeof mod.newElement).toBe("function");
    expect(typeof mod.mutateElement).toBe("function");
    expect(typeof mod.computeElementIntent).toBe("function");
  });

  // SKIPPED — records a CONFIRMED gap (spec 002 T018). The closure walker follows
  // only relative imports, so it stops at the package boundary and never inspects
  // `@excalidraw-yjs/common`, which IS bundled into the headless runtime and reads
  // `window.EXCALIDRAW_EXPORT_SOURCE` / `window.location.origin` (constants.ts) and
  // `window.setTimeout` / `requestAnimationFrame` (utils.ts). Measured against the
  // built bundle in bare Node: import succeeds, `replaceAllElements` throws
  // `ReferenceError: window is not defined`.
  it.skip("closure crosses workspace package boundaries", () => {
    expect("crosses @excalidraw-yjs/* package boundaries").toBe("implemented");
  });

  it("does NOT export the browser-only surface", async () => {
    const mod = (await import("../headless")) as Record<string, unknown>;
    for (const name of ["renderElement", "elementWithCanvasCache"]) {
      expect(mod[name]).toBeUndefined();
    }
  });
});
