/* fleet-wide readings that cost what changed, not what the fleet holds
   (docs/architecture.md, the main thread). a memo that walks
   `Object.values(state.fleet.threads)` reads every session through the
   store, so any one session's frame (five a second while it streams)
   re-ran it over all of them. here each session is read in a memo of its
   own, and what gathers them re-runs only when one of those answers
   changed: a frame costs the session it names. */

import { type Accessor, createMemo, mapArray } from "solid-js";
import type { Fleet } from "../sync/reducer";

/** two lists hold the same keys in the same order */
export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/** the keys of the fleet's sessions, in its own order: a new list only when one came or went. the store wakes it on every
    write to the sessions (solid's self signal), so it costs a walk of the keys and no read of a session */
export function sessionKeys(fleet: () => Fleet): Accessor<readonly string[]> {
  return createMemo(() => Object.keys(fleet().threads), [], { equals: sameKeys });
}

/** `read` for each key, in a memo of its own: the list is new only when a key came or went or one answer changed */
export function keyed<T>(keys: Accessor<readonly string[]>, read: (key: string) => T, equals: (a: T, b: T) => boolean = Object.is): Accessor<readonly T[]> {
  const memos = createMemo(mapArray(keys, (key) => createMemo(() => read(key), undefined, { equals })));
  return createMemo(() => memos().map((memo) => memo()));
}

/** the sessions the fleet holds under each parent: `<host>\0<parent id>` to their keys, in the fleet's order. new only when a
    session came or went or changed parents */
export function parentIndex(fleet: () => Fleet, keys: Accessor<readonly string[]> = sessionKeys(fleet)): Accessor<ReadonlyMap<string, readonly string[]>> {
  type Tie = { key: string; under: string } | null;
  const ties = keyed<Tie>(
    keys,
    (key) => {
      const entry = fleet().threads[key];
      const parent = entry?.parent;
      return entry && parent ? { key: entry.key, under: `${entry.agent}\0${parent}` } : null;
    },
    (a, b) => a === b || (a !== null && b !== null && a.key === b.key && a.under === b.under),
  );
  return createMemo(() => {
    const by = new Map<string, string[]>();
    for (const tie of ties()) {
      if (!tie) continue;
      const list = by.get(tie.under);
      if (list) list.push(tie.key);
      else by.set(tie.under, [tie.key]);
    }
    return by;
  });
}
