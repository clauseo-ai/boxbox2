/* what is expensive to make for a finished part of a thread and is kept between stages (docs/thread.md, the stage as built: what is
   remembered). four caches, each a byte-capped least-recently-used map (lru.ts, AGENTS.md, memory and latency), made once and owned by the store
   (store.ts), which empties them at sign-out and drops a thread's when the worker lets the thread go:

   - the turns `createTurns` built, by thread and turn. a hit needs the digest of the turn's messages to be the one it was built from
     (turns.ts), so a thread the worker fetched again with the same words keeps its turns, and one that changed does not
   - the ledgers (the row models and entries of one settled turn), by thread and turn: a reopened thread paints its rows from the
     models it already had. a view takes a ledger out while it paints and puts it back when it goes, so two views never share one
   - the sanitised html of settled markdown, by its text (markdown.ts)
   - how tall each turn measured, by the width it wrapped at, for the empty box that stands in for it (windowing.ts)

   a size is what the cache alone keeps alive: the derived words and every string a step holds (a command's whole output included,
   which the store may have let go), never the store's own objects, which no cache holds (turns.ts keeps no part memo here). pure; no dom. */

import type { Ledgerer } from "./ledger";
import { Lru } from "./lru";
import type { Item, Turn } from "./model";

export { Lru };

const PER_ITEM = 240;

/** about what a turn's items keep alive, in bytes: their words (two bytes a character) and a fixed cost for the object */
export function weighItems(items: readonly Item[]): number {
  let chars = 0;
  for (const it of items) {
    if (it.k !== "step") { chars += it.text.length; continue; }
    chars += it.object.length + it.result.length + (it.diff?.length ?? 0) + (it.command?.length ?? 0) + (it.error?.length ?? 0) + (it.polls?.length ?? 0) + (it.typed?.length ?? 0) + (it.cwd?.length ?? 0);
    if (it.output) { for (const line of it.output.lines) chars += line.length; chars += it.output.raw?.length ?? 0; }
    if (it.hits) for (const hit of it.hits) chars += hit.length;
    if (it.spread) for (const s of it.spread) chars += s.name.length + 8;
    if (it.agent) chars += it.agent.brief.length + it.agent.name.length;
    if (it.todos) for (const t of it.todos) chars += t.content.length + t.status.length;
    if (it.questions) for (const q of it.questions) chars += q.question.length + q.header.length + q.options.reduce((n, o) => n + o.label.length + o.description.length, 0);
    if (it.hunks) chars += it.hunks.length * 24;
    if (it.images) for (const p of it.images) chars += p.url.length + p.filename.length + p.mime.length;
  }
  return chars * 2 + items.length * PER_ITEM;
}

export function weighTurn(turn: Turn): number {
  return weighItems(turn.items) + (turn.answer ? turn.answer.text.length * 2 : 0) + turn.prompt.length * 2 + turn.files.size * 80 + 400;
}

/** a turn as `createTurns` built it, and the digest of the messages it was built from. no part memo: that holds the store's own part
    states, which would keep a thread alive after the worker evicted it */
export type Built = { digest: string; turn: Turn };

export const TURN_CACHE_BYTES = 32 * 1024 * 1024;
export const LEDGER_CACHE_BYTES = 32 * 1024 * 1024;
export const HTML_CACHE_BYTES = 8 * 1024 * 1024;
export const HEIGHT_CACHE_BYTES = 1024 * 1024;
/** what one remembered height costs: its key and a number */
export const HEIGHT_BYTES = 96;

/** one turn of one thread, as the caches key it. the key starts with the thread and a NUL, so a thread's entries are found by
    that prefix and never another thread's whose key begins the same */
export const cacheKey = (thread: string, turn: string): string => `${thread}\u0000${turn}`;
const belongs = (thread: string) => { const prefix = `${thread}\u0000`; return (key: string): boolean => key.startsWith(prefix); };

/** the part of a cache a painter reads and writes: the html of settled markdown, by its text */
export type HtmlMemo = Pick<Lru<string>, "get" | "set">;

/** how many dropped threads are remembered. past it the oldest is forgotten and every write begun before it is refused, which only costs a
    cache write */
const DROPS_KEPT = 512;

export type ThreadCaches = {
  turns: Lru<Built>;
  ledgers: Lru<Ledgerer>;
  html: Lru<string>;
  heights: Lru<number>;
  /** a thread left the worker's memory: what is kept for it goes too (the html is by text, shared by whatever says the same) */
  dropThread(thread: string): void;
  /** signed out: everything goes */
  clear(): void;
  /** a mark a writer takes when it begins what it will write for `thread` (a turn built, a view made), and carries to `keep`. a view that
      goes after the sign-out, and an idle digest that lands after a drop, would put back what was just let go: a write whose mark is older
      than the last clear, or than the thread's last drop, is refused */
  stamp(thread: string): number;
  /** writes `value` into `cache` unless the mark is old */
  keep<T>(cache: Lru<T>, thread: string, stamp: number, key: string, value: T, bytes?: number): void;
  /** the html cache, for a painter that lives a while: its writes are refused once the caches were cleared since it was made */
  htmlFor(): HtmlMemo;
};

export function createThreadCaches(): ThreadCaches {
  const turns = new Lru<Built>(TURN_CACHE_BYTES);
  const ledgers = new Lru<Ledgerer>(LEDGER_CACHE_BYTES);
  const html = new Lru<string>(HTML_CACHE_BYTES);
  const heights = new Lru<number>(HEIGHT_CACHE_BYTES);
  /* a clock that counts clears and drops: a mark is the clock when it was taken, a clear or a drop sets its own tick, and a mark older than
     the tick that concerns it is old */
  let clock = 0;
  let clearedAt = 0;
  let floor = 0;
  const droppedAt = new Map<string, number>();
  const fresh = (thread: string, stamp: number): boolean => stamp >= clearedAt && stamp >= floor && stamp >= (droppedAt.get(thread) ?? 0);
  return {
    turns, ledgers, html, heights,
    dropThread(thread) {
      const mine = belongs(thread);
      for (const cache of [turns, ledgers, heights] as Array<Lru<unknown>>) cache.dropWhere(mine);
      droppedAt.delete(thread);
      droppedAt.set(thread, ++clock);
      if (droppedAt.size > DROPS_KEPT) {
        const [oldest, at] = droppedAt.entries().next().value as [string, number];
        droppedAt.delete(oldest);
        floor = Math.max(floor, at);
      }
    },
    clear() {
      for (const cache of [turns, ledgers, html, heights] as Array<Lru<unknown>>) cache.clear();
      clearedAt = ++clock;
      droppedAt.clear();
      floor = 0;
    },
    stamp: () => clock,
    keep(cache, thread, stamp, key, value, bytes) { if (fresh(thread, stamp)) cache.set(key, value, bytes); },
    htmlFor() {
      const stamp = clock;
      return { get: (key) => html.get(key), set: (key, value, bytes) => { if (fresh("", stamp)) html.set(key, value, bytes); } };
    },
  };
}
