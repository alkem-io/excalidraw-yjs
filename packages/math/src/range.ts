import type { InclusiveRange } from "./types";

/**
 * Local brand cast, replacing an import of `toBrandedType` from
 * `@excalidraw-yjs/common`.
 *
 * That import was the ONLY thing `math` took from `common` — one symbol, in
 * this one file, for a function whose entire body is `return value` — while
 * `common` imports `math` from three modules. It bought nothing and cost a real
 * dependency CYCLE between two published packages.
 *
 * Deliberately concrete rather than a copy of `common`'s generic: reproducing
 * that signature faithfully would mean duplicating `UnbrandForValue`, ~30 lines
 * of recursive conditional type, which is not a clean trade. Every call site
 * here brands a number pair as an `InclusiveRange`, so naming both types
 * outright is simpler AND tighter — the generic accepted any unbranded shape,
 * this accepts exactly a pair.
 */
const toInclusiveRange = (value: [number, number]): InclusiveRange =>
  value as InclusiveRange;

/**
 * Create an inclusive range from the two numbers provided.
 *
 * @param start Start of the range
 * @param end End of the range
 * @returns
 */
export function rangeInclusive(start: number, end: number): InclusiveRange {
  return toInclusiveRange([start, end]);
}

/**
 * Turn a number pair into an inclusive range.
 *
 * @param pair The number pair to convert to an inclusive range
 * @returns The new inclusive range
 */
export function rangeInclusiveFromPair(pair: [start: number, end: number]) {
  return toInclusiveRange(pair);
}

/**
 * Given two ranges, return if the two ranges overlap with each other e.g.
 * [1, 3] overlaps with [2, 4] while [1, 3] does not overlap with [4, 5].
 *
 * @param param0 One of the ranges to compare
 * @param param1 The other range to compare against
 * @returns TRUE if the ranges overlap
 */
export const rangesOverlap = (
  [a0, a1]: InclusiveRange,
  [b0, b1]: InclusiveRange,
): boolean => {
  if (a0 <= b0) {
    return a1 >= b0;
  }

  if (a0 >= b0) {
    return b1 >= a0;
  }

  return false;
};

/**
 * Given two ranges,return ther intersection of the two ranges if any e.g. the
 * intersection of [1, 3] and [2, 4] is [2, 3].
 *
 * @param param0 The first range to compare
 * @param param1 The second range to compare
 * @returns The inclusive range intersection or NULL if no intersection
 */
export const rangeIntersection = (
  [a0, a1]: InclusiveRange,
  [b0, b1]: InclusiveRange,
): InclusiveRange | null => {
  const rangeStart = Math.max(a0, b0);
  const rangeEnd = Math.min(a1, b1);

  if (rangeStart <= rangeEnd) {
    return toInclusiveRange([rangeStart, rangeEnd]);
  }

  return null;
};

/**
 * Determine if a value is inside a range.
 *
 * @param value The value to check
 * @param range The range
 * @returns
 */
export const rangeIncludesValue = (
  value: number,
  [min, max]: InclusiveRange,
): boolean => {
  return value >= min && value <= max;
};
