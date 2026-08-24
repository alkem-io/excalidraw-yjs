import fs from "node:fs";
import path from "node:path";

const PACKAGES = path.resolve(__dirname, "../..");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

/**
 * No source file may import a package ROOT by relative directory path.
 *
 * `import { Excalidraw } from "../.."` looks equivalent to `"../../index"` and
 * is not: a directory import consults that directory's `package.json`, so once
 * `dist/` exists it resolves to the BUILT bundle while everything around it
 * still resolves to source. The result is two copies of the module graph — two
 * React contexts — and a component reads `appState` as `null` from a provider
 * that is a different instance.
 *
 * That is not hypothetical. Three files did this, and the symptom was ten
 * Sidebar/DefaultSidebar tests failing with "not initialized yet" **only when a
 * build had been run**, which made `pnpm run test:headless` and `pnpm test`
 * non-composable in one working tree. It read as a timeout — a slow startup —
 * and was actually a duplicated module graph. Naming the entry file fixes it.
 *
 * Cheap to state, expensive to rediscover, so it is asserted rather than
 * remembered.
 */
describe("no relative imports of a package root", () => {
  it("every relative import naming a directory with a package.json is rejected", () => {
    const offenders: string[] = [];

    for (const file of walk(PACKAGES)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /(?:from|import)\s*["'](\.[^"']*)["']/g,
      )) {
        const specifier = match[1];
        // Only bare directory specifiers can hit a manifest: anything with a
        // file extension or a named final segment resolves directly.
        const resolved = path.resolve(path.dirname(file), specifier);
        if (
          fs.existsSync(resolved) &&
          fs.statSync(resolved).isDirectory() &&
          fs.existsSync(path.join(resolved, "package.json"))
        ) {
          offenders.push(
            `${path.relative(PACKAGES, file)} imports "${specifier}"`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
