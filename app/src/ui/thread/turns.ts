/* a thread's messages cut into turns, as memos (docs/thread.md, the stage as built): one memo for each turn, which reads only its
   own messages, so what changes wakes what it touched. reactive, no dom. */

import { type Accessor, createComputed, createMemo, createRoot, createSignal, getOwner, on, onCleanup, runWithOwner, untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import type { Message } from "../../sync/protocol";
import { type PartMemo, type Turn, shownCount, turnsOf } from "./model";
import { type Built, type ThreadCaches, cacheKey, weighTurn } from "./memo-cache";

/* a per-object id, so an object the store replaced can be told from the one before it */
const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(o: object): number {
  let id = ids.get(o);
  if (id === undefined) { id = nextId++; ids.set(o, id); }
  return id;
}

/** what about a turn's messages could change what it paints, by which objects the store holds: reading these tracks them. the store
    keeps an object while nothing in it changes and replaces it when it is sent again (a message's info, a tool's state), so a new
    object is a possible change, and the digest below says whether it is a real one */
export function printOf(messages: readonly Message[]): string {
  const out: Array<string | number> = [];
  for (const m of messages) {
    out.push(idOf(m), m.info.time.completed ?? 0, (m.info as { error?: unknown }).error ? 1 : 0, m.parts.length);
    for (const p of m.parts) {
      out.push(idOf(p));
      if (p.type === "text" || p.type === "reasoning") out.push(p.text.length, (p as { streaming?: boolean }).streaming ? 1 : 0);
      else if (p.type === "tool") out.push(idOf(p.state), p.state.status);
    }
  }
  return out.join(",");
}

/* ---------- what the messages say ---------- */

/** a 53-bit hash of a string (cyrb53): a digest is compared for equality and never read back, and two hashes of a thread's words
    colliding is not a thing to plan for */
function hash(text: string): string {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

/* a tool's state is replaced, never changed in place, when it is sent again, so its digest is read once per state object: the
   store's own object, not the proxy that tracks reads (reading every field of a command's output through it would track thousands) */
const states = new WeakMap<object, string>();
function stateDigest(state: object): string {
  const raw = unwrap(state);
  let held = states.get(raw);
  if (held === undefined) { held = hash(JSON.stringify(withoutPictureBytes(raw))); states.set(raw, held); }
  return held;
}

/** a tool's state with its attachments' data urls told by their length and their two ends, as a big text is (below): the images
    a tool returned are megabytes, and hashing every character of them would hold the frame the digest is read in */
export function withoutPictureBytes(state: object): object {
  const attachments = (state as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return state;
  const told = attachments.map((a: unknown) => {
    const url = a !== null && typeof a === "object" ? (a as { url?: unknown }).url : undefined;
    return typeof url === "string" && url.length > BIG_TEXT ? { ...(a as object), url: `${url.length}|${url.slice(0, 4096)}|${url.slice(-4096)}` } : a;
  });
  return { ...state, attachments: told };
}

/** a part whole, as a digest. a text of megabytes is told by its length and its two ends: hashing every character of it at every change
    would hold the frame, and a text of that length changed in its middle at the same length is not a thing a daemon sends */
const BIG_TEXT = 64 * 1024;
function partDigest(part: object): string {
  const { text, ...rest } = part as { text?: unknown };
  if (typeof text !== "string" || text.length <= BIG_TEXT) return hash(JSON.stringify(part));
  return hash(`${JSON.stringify(rest)}|${text.length}|${text.slice(0, 4096)}|${text.slice(-4096)}`);
}

/** everything `turnsOf` and the row models read of a turn's messages, as one digest: each message's info whole (cost, model, effort,
    finish, error, mail), each part whole (a tool's state included: its input, its metadata, its output, its title), so two
    messages that say the same thing have the same digest whichever objects hold them, and any change to what a turn shows is a
    different one. what a refetch of the same thread is told by */
export function digestOf(messages: readonly Message[], dir: string): string {
  const out: string[] = [dir];
  for (const m of messages) {
    out.push(hash(JSON.stringify(unwrap(m.info))));
    for (const p of m.parts) {
      if (p.type === "tool") out.push(`${p.id}|${p.tool}|${p.callID}|${p.state.status}|${stateDigest(p.state)}`);
      else out.push(partDigest(unwrap(p)));
    }
  }
  return hash(out.join(","));
}

/** one turn's place in the messages: the user message it starts at, up to the next one */
type Segment = { id: string; from: number; to: number };
const sameSegments = (a: readonly Segment[], b: readonly Segment[]): boolean => a.length === b.length && a.every((x, i) => x.id === (b[i] as Segment).id && x.from === (b[i] as Segment).from && x.to === (b[i] as Segment).to);

/** runs when the page is idle, or soon, in a task of its own */
function later(run: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 2000 }); else setTimeout(run, 50);
}

export const NO_MESSAGES: readonly Message[] = [];

/** the turns of a thread from the store's messages, each its own memo that reads only its own messages (the store tracks
    what is read, by index and by field), so a delta to the running turn wakes the running turn alone: the others are not
    read again, not fingerprinted, not rebuilt, and keep their objects and their dom. a turn that is rebuilt reads again only
    the parts that changed (its part memo), so its untouched items keep their objects too.
    the newest message waits, unshown, while it is a user message with no part yet (model.ts, shownMessages).
    what a finished turn came to is kept between stages (memo-cache.ts), under `thread` */
export type TurnsOptions = {
  /** a thread is opened with its newest `first` turns and the rest are made as `grow` is called (the stage does, a frame at a time): a
      thread of hundreds of turns made in one task is a long task. left out, every turn is made at once */
  first?: number;
  /** the calls of the tools that are asking (a pending ask's `callID`): the turn that holds one is shown, and the turns after it, whatever
      `first` says, so an ask is never in a turn that is not made. read from the messages without tracking their parts */
  need?: Accessor<ReadonlySet<string>>;
};
export type Turns = {
  turns: Accessor<Turn[]>;
  count: Accessor<number>;
  /** the ids of `turns`, which change only when a turn comes or goes, not when one changes */
  ids: Accessor<readonly string[]>;
  /** a turn by its id: its own memo, so a list keyed by id never makes a view again for a turn that changed */
  turnOf: (id: string) => Turn | undefined;
  /** turns older than the ones shown are still to be made */
  more: Accessor<boolean>;
  /** shows `n` older turns more */
  grow: (n: number) => void;
  /** shows every turn now */
  all: () => void;
};

export function createTurns(messages: Accessor<readonly Message[]>, root: Accessor<string>, thread: Accessor<string> = () => "", caches?: ThreadCaches, options: TurnsOptions = {}): Turns {
  const owner = getOwner();
  type Entry = { bounds: (s: Segment) => void; turn: Accessor<Turn | undefined>; dispose: () => void };
  const entries = new Map<string, Entry>();
  onCleanup(() => { for (const e of entries.values()) e.dispose(); entries.clear(); });

  const count = createMemo(() => shownCount(messages()));

  const entryFor = (seg: Segment): Entry => {
    const held = entries.get(seg.id);
    if (held) return held;
    const made = runWithOwner(owner, () => createRoot((dispose): Entry => {
      const [bounds, setBounds] = createSignal<Segment>(seg, { equals: (a, b) => a.from === b.from && a.to === b.to });
      const parts: PartMemo = new Map();
      /* the digest of what the turn was built from is read in idle time after its first paint (a thread's whole text hashed in the task that opens
         it was most of the time that task took), and until then it is not known: a turn whose objects change before that is built again */
      let last: { fast: string; digest: string | undefined; turn: Turn } | undefined;
      const turn = createMemo<Turn | undefined>(() => {
        const { from, to } = bounds();
        const all = messages();
        const dir = root();
        /* read by index: a slice would read the array's length, and every turn would wake at every message that arrives */
        const slice: Message[] = [];
        for (let i = from; i < to; i++) { const m = all[i]; if (!m) break; slice.push(m); }
        const fast = `${printOf(slice)}|${dir}`;
        if (last?.fast === fast) return last.turn;
        const key = cacheKey(untrack(thread), seg.id);
        const cached = untrack(() => caches?.turns.get(key));
        /* the store holds other objects than it did: a part sent again, or the thread fetched again, or a turn this stage has not built that
           an earlier stage did. whether they say something else is what the digest tells, so a refetch of the same words keeps the turn (and
           its dom), and a finished tool re-sent with another exit code does not */
        if (last?.digest !== undefined || cached) {
          const digest = digestOf(slice, dir);
          if (last?.digest === digest) { last = { fast, digest, turn: last.turn }; return last.turn; }
          if (cached && cached.digest === digest) { last = { fast, digest, turn: cached.turn }; return cached.turn; }
        }
        const built = turnsOf(slice, dir, undefined, parts)[0];
        if (!built) return undefined;
        const mine = { fast, digest: undefined as string | undefined, turn: built };
        last = mine;
        /* what is written for later is refused if the thread was let go or everything cleared in between (memo-cache.ts, stamp) */
        const owner = untrack(thread);
        const stamp = caches?.stamp(owner) ?? 0;
        if (caches) later(() => {
          // the messages are as they were when the turn was built, else this memo has run again and the digest would be of other words
          if (last !== mine || `${printOf(slice)}|${dir}` !== fast) return;
          mine.digest = digestOf(slice, dir);
          caches.keep(caches.turns, owner, stamp, key, { digest: mine.digest, turn: built }, weighTurn(built));
        });
        return built;
      });
      return { bounds: (s) => setBounds(s), turn, dispose };
    }));
    entries.set(seg.id, made as Entry);
    return made as Entry;
  };

  /* the cut is read from the roles of the messages, which is all it needs of them: a part arriving does not touch it */
  const cuts = createMemo<readonly Segment[]>(() => {
    const all = messages();
    const n = count();
    const out: Segment[] = [];
    for (let i = 0; i < n; i++) {
      const m = all[i] as Message;
      if (m.info.role !== "user") continue;
      const last = out[out.length - 1];
      if (last) last.to = i;
      out.push({ id: m.info.id, from: i, to: n });
    }
    return out;
  }, [], { equals: sameSegments });

  /* the turns shown are the ones from `oldest` on, so a message arriving does not take the oldest away; `first` of the newest, until it grows.
     a thread that is another one starts again */
  const first = options.first ?? Number.POSITIVE_INFINITY;
  let oldest: string | undefined;
  const [version, bump] = createSignal(0);
  /* through a memo: `thread` is read through whatever the caller has (the stage reads it from its window's view, which home makes again
     at every update of the session: a reply streaming makes it a few times a second), and `on` runs when what it reads notifies, not
     when the value is another. without the memo each of those took the list back to its newest few and regrew it: a stage that
     rebuilt its turns five times a second, with empty boxes between (thread.tsx has the same lesson at a row's key) */
  const threadKey = createMemo(thread);
  createComputed(on(threadKey, () => { oldest = undefined; bump((v) => v + 1); }, { defer: true }));

  /** the first turn, among `all`, that holds one of the calls (-1 when none does): the newest messages are read first, and the read stops when it has them all */
  const earliestWith = (all: readonly Segment[], calls: ReadonlySet<string>): number => {
    const list = untrack(messages);
    let left = calls.size;
    let found = -1;
    for (let i = untrack(count) - 1; i >= 0 && left > 0; i--) {
      for (const p of (list[i] as Message).parts) {
        if (p.type === "tool" && calls.has(p.callID)) { found = i; left--; }
      }
    }
    if (found < 0) return -1;
    let lo = 0, hi = all.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((all[mid] as Segment).from <= found) lo = mid; else hi = mid - 1; }
    return lo;
  };

  const segments = createMemo<readonly Segment[]>(() => {
    version();
    const all = cuts();
    const calls = options.need?.();
    const was = oldest === undefined ? -1 : all.findIndex((seg) => seg.id === oldest);
    let at = was >= 0 ? was : Math.max(0, all.length - first);
    if (calls && calls.size) { const needed = earliestWith(all, calls); if (needed >= 0 && needed < at) at = needed; }
    const out = all.slice(at);
    oldest = out[0]?.id;
    for (const seg of out) entryFor(seg).bounds(seg);
    const seen = new Set(all.map((seg) => seg.id));
    for (const [id, e] of [...entries]) if (!seen.has(id)) { e.dispose(); entries.delete(id); }
    return out;
  }, [], { equals: sameSegments });

  const turns = createMemo(() => {
    const out: Turn[] = [];
    for (const seg of segments()) {
      const turn = entryFor(seg).turn();
      if (turn) out.push(turn);
    }
    return out;
  });
  const ids = createMemo<readonly string[]>(() => turns().map((t) => t.id), [], { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) });
  return {
    turns,
    count,
    ids,
    turnOf: (id) => entries.get(id)?.turn(),
    more: () => segments().length < cuts().length,
    grow: (n) => {
      const all = untrack(cuts);
      const at = oldest === undefined ? all.length : all.findIndex((seg) => seg.id === oldest);
      oldest = all[Math.max(0, (at < 0 ? all.length : at) - n)]?.id;
      bump((v) => v + 1);
    },
    all: () => { oldest = untrack(cuts)[0]?.id; bump((v) => v + 1); },
  };
}

