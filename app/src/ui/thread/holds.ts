/* which of a thread's agents the stage holds (docs/thread.md, the stage as built: agents, held when wanted). the worker keeps a
   reserve of 16 places for threads that are only held (sync/client.ts, holdThread), and evicts the oldest held when it is full, so
   asking for more than it has would hold, evict and hold again for as long as the screen stayed as it was. this keeps the number
   wanted under the reserve: the agents that are live first, then the ones nearest the view; the rest are read from the fleet.
   what is wanted and no longer there (the worker evicted it) is held again, a few times, and what is no longer wanted is released.
   reactive, no dom. */

import { type Accessor, createEffect, createMemo, onCleanup, untrack } from "solid-js";

/** the most agents wanted at once: under the worker's reserve of 16, so a pack of spawns on one screen never churns it */
export const HOLD_CAP = 12;
/** a held thread that was evicted is held again at most this many times in this long, so a worker that keeps evicting it (another stage's
    holds filling the reserve) is not asked in a loop */
export const REHOLDS = 3;
export const REHOLD_WINDOW_MS = 30_000;
/** a thread asked for this recently is not absent for want of being evicted: its place in the store comes a moment after the ask */
const SETTLING_MS = 1500;

/** a thread in the store whose messages can be shown: live, or restored from the cache and stale. one the worker has only started
    (hydrating, nothing in it yet) is not read, and a count of its steps would say zero */
export const isRead = (thread: { status: string; messages: { length: number } } | undefined): boolean => thread !== undefined && (thread.status === "live" || thread.messages.length > 0);

export type Wanted = { key: string; /** how far from the middle of the view it is, in px */ distance: number };

/** the agents to hold: the live ones first (in the order given), then the ones on screen by how near the view, at most `cap` */
export function chooseHolds(live: readonly string[], visible: readonly Wanted[], cap = HOLD_CAP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => { if (out.length < cap && !seen.has(key)) { seen.add(key); out.push(key); } };
  for (const key of live) add(key);
  for (const w of [...visible].sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : 1))) add(w.key);
  return out;
}

export type HoldOptions = {
  live: Accessor<readonly string[]>;
  visible: Accessor<readonly Wanted[]>;
  /** the thread is in the store (reactive): when a held one is not, it was evicted, or the worker refused the hold */
  present: (key: string) => boolean;
  hold: (key: string) => void;
  release: (key: string) => void;
  cap?: number;
};

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

/** holds what is wanted, holds it again when it was evicted or refused, releases what stops being wanted and all of it when the owner goes.
    asking again is the holds' own timer's: nothing a reactive read could say tells that time has passed (a wall clock is not a signal), so a
    hold the worker refused (its reserve was full) would never be asked for again while what is wanted stayed as it was */
export function createHolds(options: HoldOptions): Accessor<readonly string[]> {
  const target = createMemo(() => chooseHolds(options.live(), options.visible(), options.cap ?? HOLD_CAP), [], { equals: sameList });
  const holding = new Map<string, { at: number; again: number[] }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stop = (key: string): void => { const t = timers.get(key); if (t !== undefined) { clearTimeout(t); timers.delete(key); } };
  /** looks at a held thread once its time to settle has gone by: still not in the store, it is asked for again if the budget allows, and
      looked at again after another such time, or when the budget lets its oldest ask go */
  const arm = (key: string, after: number): void => {
    stop(key);
    timers.set(key, setTimeout(() => look(key), Math.max(0, after)));
  };
  const look = (key: string): void => {
    timers.delete(key);
    const was = holding.get(key);
    if (!was || options.present(key)) return;
    const t = Date.now();
    was.again = was.again.filter((x) => t - x < REHOLD_WINDOW_MS);
    if (was.again.length >= REHOLDS) { arm(key, (was.again[0] as number) + REHOLD_WINDOW_MS - t + 1); return; }
    was.again.push(t);
    was.at = t;
    options.hold(key);
    arm(key, SETTLING_MS);
  };
  createEffect(() => {
    const wanted = target();
    const have = new Set(wanted);
    for (const key of wanted) {
      const was = holding.get(key);
      const absent = !options.present(key);
      if (!was) { holding.set(key, { at: Date.now(), again: [] }); untrack(() => options.hold(key)); if (absent) arm(key, SETTLING_MS); continue; }
      if (!absent) { stop(key); continue; }
      /* evicted, or refused: looked at once it has had its time to settle (a thread asked for is in the store a moment after) */
      if (timers.has(key)) continue;
      const wait = was.at + SETTLING_MS - Date.now();
      untrack(() => (wait <= 0 ? look(key) : arm(key, wait)));
    }
    for (const key of [...holding.keys()]) if (!have.has(key)) { holding.delete(key); stop(key); untrack(() => options.release(key)); }
  });
  onCleanup(() => { for (const key of holding.keys()) options.release(key); holding.clear(); for (const t of timers.values()) clearTimeout(t); timers.clear(); });
  return target;
}
