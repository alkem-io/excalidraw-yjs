import { deepEqual, RECONCILE_META_KEYS } from "./schema";

import type { ElementRecord } from "./schema";

/**
 * Derived write intent for one `ActionResult` (spec 002, FR-016 / T016b).
 *
 * An action's result is computed from the scene as it was when the action was
 * invoked. Applying it through the authoritative whole-set path
 * (`replaceAllElements`) therefore reverts anything that changed in between —
 * a peer's edit, or a side-effect helper's own doc write. This computes what the
 * action actually INTENDED, so only that can be applied to the current doc.
 *
 * ## Presence-aware, deliberately
 *
 * A plain value comparison cannot see presence transitions: `deepEqual` treats
 * `undefined` as equal to `undefined` (and equates `null` with `undefined`), so a
 * key that is ABSENT in base and explicitly `undefined` in the result compares
 * equal and would yield no intent — even though the action means "clear this",
 * and must beat a value another writer introduced meanwhile. The diff is
 * therefore computed over the union of own string keys, testing presence with
 * `Object.hasOwn`, never `key in` (which would walk the prototype chain).
 *
 * | base | result | intent |
 * |---|---|---|
 * | absent | own property (even `undefined`) | SET — `writeChangedKeys` clears it when the value is `undefined` |
 * | own property | absent | DELETE — the result record reads `undefined`, which `writeChangedKeys` turns into a `Y.Map` deletion |
 * | both, values differ | | SET |
 * | both, values equal | | NONE — an explicit same-value assignment is invisible here; that is the known asymmetry requiring the explicit-intent channel |
 *
 * `id` and {@link RECONCILE_META_KEYS} are excluded: identity is the map key, and
 * reconciliation metadata, membership and own-Symbol props travel in their own
 * channels.
 */
export type DeclaredElementIntent = {
  readonly addedIds: ReadonlySet<string>;
  readonly removedIds: ReadonlySet<string>;
  /**
   * Existing-id writes only. A creation establishes all persisted own keys, so
   * an added id does not appear here.
   */
  readonly keysById: ReadonlyMap<string, ReadonlySet<string>>;
};

const isIntentKey = (key: string): boolean =>
  key !== "id" && !RECONCILE_META_KEYS.has(key);

/**
 * The per-key intent between two records. See the table on {@link ElementIntent}.
 */
export const diffElementKeys = (
  base: ElementRecord,
  result: ElementRecord,
): Set<string> => {
  const keys = new Set<string>();
  for (const key of Object.keys(base)) {
    if (isIntentKey(key)) {
      keys.add(key);
    }
  }
  for (const key of Object.keys(result)) {
    if (isIntentKey(key)) {
      keys.add(key);
    }
  }

  const intent = new Set<string>();
  for (const key of keys) {
    const inBase = Object.hasOwn(base, key);
    const inResult = Object.hasOwn(result, key);

    if (inBase !== inResult) {
      // A presence transition either way is unambiguous intent: the action added
      // a key or dropped one. Value comparison cannot see this.
      intent.add(key);
      continue;
    }
    if (inBase && inResult && !deepEqual(base[key], result[key])) {
      intent.add(key);
    }
  }
  return intent;
};

/**
 * Derive intent by diffing `base` against `result`. Returns SELECTORS — the same
 * shape an explicit declaration uses — so there is one intent channel, not two.
 * Values are always read from `result` by the planner.
 *
 * Valid only for audited SYNCHRONOUS callers: a derived diff cannot see an
 * explicit assignment of the value a key already held, and cannot represent an
 * async action whose base is arbitrarily stale (FR-016).
 */
export const computeElementIntent = (
  base: readonly ElementRecord[],
  result: readonly ElementRecord[],
): DeclaredElementIntent => {
  const baseById = new Map<string, ElementRecord>();
  for (const el of base) {
    baseById.set(el.id as string, el);
  }
  const resultIds = new Set<string>();

  const addedIds = new Set<string>();
  const keysById = new Map<string, ReadonlySet<string>>();

  for (const record of result) {
    const id = record.id as string;
    resultIds.add(id);
    const prior = baseById.get(id);
    if (!prior) {
      addedIds.add(id);
      continue;
    }
    const keys = diffElementKeys(prior, record);
    if (keys.size > 0) {
      keysById.set(id, keys);
    }
  }

  const removedIds = new Set<string>();
  for (const id of baseById.keys()) {
    if (!resultIds.has(id)) {
      removedIds.add(id);
    }
  }

  return { addedIds, removedIds, keysById };
};

/**
 * The stable "before" image an action is diffed against (spec 002, FR-016 /
 * T016a).
 *
 * A bare reference to the scene array is NOT a snapshot. `Scene.mutateElement`
 * mutates the caller's scratch object in place before the doc re-derives, so a
 * held reference tracks the live element and would diff as unchanged. A
 * top-level spread is not enough either: it leaves nested persisted fields
 * (`points`, `groupIds`, `boundElements`, `roundness`, `scale`, `crop`,
 * `customData`) aliased to the same objects, which then mutate underneath the
 * base and again diff as unchanged — silently yielding "no intent" for a real
 * change.
 *
 * So every own enumerable value is deep-copied. Own **Symbol** properties (e.g.
 * `ORIG_ID`) are re-attached by descriptor rather than copied by value:
 * `structuredClone` drops them entirely, and they are non-enumerable so a spread
 * misses them, yet the reconciliation path depends on them.
 */
const deepCopyValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepCopyValue);
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    out[key] = deepCopyValue(src[key]);
  }
  return out;
};

export const captureElementBase = <T extends object>(
  elements: readonly T[],
): readonly T[] =>
  elements.map((element) => {
    const copy = deepCopyValue(element) as T;
    for (const sym of Object.getOwnPropertySymbols(element)) {
      const desc = Object.getOwnPropertyDescriptor(element, sym);
      if (desc) {
        Object.defineProperty(copy, sym, desc);
      }
    }
    return copy;
  });

/**
 * Declared write intent as SELECTORS ONLY (spec 002, FR-016 / T016b).
 *
 * It deliberately carries no records. Values are always read from the canonical
 * `result` record for that id, so there is exactly one source of truth and no
 * winner to invent when a caller's declaration and the result disagree.
 *
 * This is the channel an async action or a headless automation client uses to state
 * intent that a diff cannot see — most importantly "set this key to the value it
 * already had in base", which is invisible to any derived comparison yet must
 * still beat a value another writer put in the doc meanwhile.
 */

/**
 * Reject contradictions BEFORE any transaction is opened: every added or changed
 * id must exist in `result`, and a removed id must not. A contradiction is a
 * caller bug, and resolving it silently would mean inventing intent.
 */
export const assertIntentAgainstResult = (
  declared: DeclaredElementIntent,
  resultById: ReadonlyMap<string, ElementRecord>,
): void => {
  for (const id of declared.addedIds) {
    if (!resultById.has(id)) {
      throw new Error(`declared intent: added id ${id} is absent from result`);
    }
  }
  for (const id of declared.keysById.keys()) {
    if (!resultById.has(id)) {
      throw new Error(
        `declared intent: changed id ${id} is absent from result`,
      );
    }
  }
  for (const id of declared.removedIds) {
    if (resultById.has(id)) {
      throw new Error(`declared intent: removed id ${id} is present in result`);
    }
  }
};
