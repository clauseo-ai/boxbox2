/* which threads have a window, in which order (docs/design.md, the model:
   windows). the order is the server's (decision 16): the inbox, computed
   once for every surface. this only decides membership, by the law's
   rule: a thread has a window while it works, wants you, waits parked or
   queued, or was touched in the last 12 hours. a subagent never gets its
   own window; it is a tile in its parent's footer.

   a thread the person cleared has no window until it comes back on its own:
   the server holds the mark and carries it on the entry as `cleared`, and
   spends it when the thread works again, asks, or is updated past the clear
   (server/src/fleet/model.rs). it is never a device's clock or a device's
   list, so every device agrees. the mark is checked first: it only ever
   sits on a thread that was neither working nor asking. */

import { type Accessor, createMemo, untrack } from "solid-js";
import type { Fleet } from "../../sync/reducer";
import { keyed } from "../fleet-index";

/** a thread touched this recently keeps its window */
export const RECENT_MS = 12 * 60 * 60 * 1000;

export function windowKeys(fleet: Fleet, now: number): string[] {
  const asking = new Set(Object.values(fleet.asks).map((ask) => ask.key));
  const keys: string[] = [];
  for (const key of fleet.order) {
    const entry = fleet.sessions[key];
    if (!entry || entry.info.parentID) continue;
    if (entry.cleared != null) continue;
    const active = entry.status !== null || asking.has(key);
    if (active || now - entry.info.time.updated < RECENT_MS) keys.push(key);
  }
  return keys;
}

/** a list reorders only when its members or their order changed */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/** what the rule needs of one thread: no window, a window while it works or asks, or its last touch, which the clock decides */
type Standing = "out" | "active" | number;

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((key) => b.has(key));

/** `windowKeys`, kept current at the cost of what changed: each thread's standing is a memo of its own, so a frame re-reads the
    thread it names, and the clock costs a walk of plain numbers (no store read) that wakes the list only when a thread's 12
    hours run out. `wake` is that moment, for a clock that stops while the page is hidden (ui/clock.ts) */
export function createWindowKeys(fleet: () => Fleet, now: Accessor<number>): { keys: Accessor<string[]>; wake: () => number | undefined } {
  const asking = createMemo(() => new Set(Object.values(fleet().asks).map((ask) => ask.key)), new Set<string>(), { equals: sameSet });
  const order = () => fleet().order;
  const standings = keyed<Standing>(order, (key) => {
    const entry = fleet().sessions[key];
    if (!entry || entry.info.parentID) return "out";
    if (entry.cleared != null) return "out";
    if (entry.status !== null || asking().has(key)) return "active";
    return entry.info.time.updated;
  });
  /* the oldest touch still inside its 12 hours: it changes exactly when a thread's window comes or goes by the clock */
  const oldest = createMemo(() => {
    const at = now();
    let found = Number.POSITIVE_INFINITY;
    for (const s of standings()) if (typeof s === "number" && at - s < RECENT_MS && s < found) found = s;
    return found;
  });
  const keys = createMemo(
    () => {
      oldest();
      const at = untrack(now);
      const list = order();
      const keys: string[] = [];
      standings().forEach((s, i) => {
        const key = list[i];
        if (key !== undefined && (s === "active" || (typeof s === "number" && at - s < RECENT_MS))) keys.push(key);
      });
      return keys;
    },
    [],
    { equals: sameOrder },
  );
  const wake = () => {
    const at = oldest();
    return at === Number.POSITIVE_INFINITY ? undefined : at + RECENT_MS;
  };
  return { keys, wake };
}