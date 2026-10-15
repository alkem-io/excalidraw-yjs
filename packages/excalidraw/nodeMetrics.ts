import { join } from "node:path";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

import type { TextMetricsProvider } from "@excalidraw-yjs/element/headless";

import { bundledFontFaces } from "./fonts/bundledFontFaces";

let aliases: Map<string, string> | undefined;

/**
 * Synchronous actual-font metrics for a disposable Node process. Import this
 * Node-only subpath explicitly; ordinary editor/headless imports stay unchanged.
 * Local Helvetica/generic/emoji fallback remains platform-owned, as in browsers.
 */
export const createNodeTextMetricsProvider = (): TextMetricsProvider => {
  if (!aliases) {
    const registered = new Map<string, string>();
    for (const [family, faces] of Object.entries(bundledFontFaces)) {
      const subsets: string[] = [];
      for (const [index, face] of faces.entries()) {
        const alias = `ExcalidrawNode_${family.replace(/\W/g, "_")}_${index}`;
        // A same-family registration shadows previous subsets in Skia. Separate
        // aliases retain glyph fallback across every real bundled subset.
        if (!GlobalFonts.registerFromPath(join(__dirname, face.uri), alias)) {
          throw new Error("Unable to register bundled font face");
        }
        subsets.push(alias);
      }
      registered.set(family, subsets.join(", "));
    }
    aliases = registered;
  }
  const families = aliases;
  const context = createCanvas(1, 1).getContext("2d");
  return {
    getLineWidth(text, fontString) {
      context.font = fontString.replace(
        /^(.*?px)\s+(.+)$/,
        (_, size, stack: string) =>
          `${size} ${stack
            .split(",")
            .map((family) => families.get(family.trim()) || family.trim())
            .join(", ")}`,
      );
      const width = context.measureText(text).width;
      if (!Number.isFinite(width)) {
        throw new Error("Invalid font measurement");
      }
      return width;
    },
  };
};
