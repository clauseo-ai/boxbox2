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

import type { Fleet } from "../../sync/reducer";

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
