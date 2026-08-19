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
export type ElementIntent = {
  /** ids present in the result but not in the base */
  readonly added: readonly ElementRecord[];
  /** ids present in the base but not in the result */
  readonly deleted: readonly string[];
  /** id → the result record plus the exact keys to write from it */
  readonly changed: ReadonlyMap<
    string,
    { readonly record: ElementRecord; readonly keys: ReadonlySet<string> }
  >;
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

export const computeElementIntent = (
  base: readonly ElementRecord[],
  result: readonly ElementRecord[],
): ElementIntent => {
  const baseById = new Map<string, ElementRecord>();
  for (const el of base) {
    baseById.set(el.id as string, el);
  }
  const resultIds = new Set<string>();

  const added: ElementRecord[] = [];
  const changed = new Map<
    string,
    { record: ElementRecord; keys: ReadonlySet<string> }
  >();

  for (const record of result) {
    const id = record.id as string;
    resultIds.add(id);
    const prior = baseById.get(id);
    if (!prior) {
      added.push(record);
      continue;
    }
    const keys = diffElementKeys(prior, record);
    if (keys.size > 0) {
      changed.set(id, { record, keys });
    }
  }

  const deleted: string[] = [];
  for (const id of baseById.keys()) {
    if (!resultIds.has(id)) {
      deleted.push(id);
    }
  }

  return { added, deleted, changed };
};
