/* the thread as the store holds it, read into what the ledger paints
   (docs/thread.md, from the wire; live). the worker keeps
   `state.threads[key]` current; this turns its messages into turns, one
   turn recomputed when its own messages change, and gathers what a turn
   needs from around it: the pending asks by call id, the agents' child
   sessions for the tape, and the clock while a turn runs. */

import { type Accessor, createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup, runWithOwner, untrack } from "solid-js";
import type { Message } from "../../sync/protocol";
import type { ReadTrouble } from "../../sync/read";
import type { AskReply } from "../../sync/replies";
import { holdThread, releaseThread } from "../../sync/client";
import { state } from "../../store";
import { type Item, type Turn, projectRoot, spawnsOf } from "./model";
import { NO_MESSAGES, type TurnsOptions, createTurns } from "./turns";
import { type Wanted, createHolds, isRead } from "./holds";
import type { ThreadCaches } from "./memo-cache";
import type { Child, ChildState, PendingAsk, RowCtx } from "./rows";
import { number, record, string } from "./wire";
import type { Kin } from "./details-model";
import { repoRootOf } from "../composer/place";
import { type RepoColour, colourOf } from "../window/repo";

/** a repo palette as the stage reads it (design.md, colour): the same colour the window, the composer and the
    browser chrome take, from the one hash of host and project root (window/repo.ts) */
export type Tone = { name: string; top: string; bottom: string; tone: string };
export function toneOfColour(colour: RepoColour): Tone {
  return { name: colour.name, top: colour.top, bottom: colour.bottom, tone: colour.light };
}

export type ThreadData = {
  key: Accessor<string>;
  host: Accessor<string>;
  title: Accessor<string>;
  directory: Accessor<string>;
  /** the repo's project root, which its name and its mark are read from: not the directory, which may be a worktree's */
  repoRoot: Accessor<string>;
  tone: Accessor<Tone>;
  /** the worker has answered for it at least once (cached or hydrated) */
  held: Accessor<boolean>;
  hydrating: Accessor<boolean>;
  /** why its read is failing while the worker tries again (sync/read.ts), undefined while nothing failed */
  trouble: Accessor<ReadTrouble | undefined>;
  turns: Accessor<Turn[]>;
  /** the ids of `turns` (they change when a turn comes or goes), a turn by its id, and the rest of a long thread: shown a few turns at a time
      from the newest (turns.ts, `first`) */
  ids: Accessor<readonly string[]>;
  turnOf: (id: string) => Turn | undefined;
  more: Accessor<boolean>;
  grow: (n: number) => void;
  all: () => void;
  /** what a row is painted in: no clock (`now`), and only the mail turns in `turns` */
  ctx: Accessor<RowCtx>;
  /** how many messages the thread shows (the stage's scroll law counts them) */
  count: Accessor<number>;
  /** a child's row or lane is within a screen of the view, `distance` px from its middle, or has left it (null): its thread is held
      while it is (not held until something wants it) */
  seen: (child: string, distance: number | null) => void;
  /** a turn is running */
  working: Accessor<boolean>;
  now: Accessor<number>;
  /** the asks pending on this thread, by id */
  asks: Accessor<ReadonlyMap<string, PendingAsk & { callID: string }>>;
  /** the agents this thread started, by their session id: for the agents panel. read from the fleet; a child's steps and items
      are its own only once its thread is held (`Child.held`) */
  children: Accessor<ReadonlyMap<string, Child>>;
  /** every session under this thread at any depth, with what each cost: for the spend */
  kin: Accessor<readonly Kin[]>;
};

/* the agents a child's items started, by the items' array: a child that did not change is read once */
const spawned = new WeakMap<readonly Item[], readonly string[]>();
function spawnedIn(items: readonly Item[]): readonly string[] {
  let found = spawned.get(items);
  if (!found) { found = items.flatMap((it) => (it.k === "step" && it.family === "spawn" && it.agent?.child ? [it.agent.child] : [])); spawned.set(items, found); }
  return found;
}

const sameChild = (a: Child | undefined, b: Child | undefined): boolean => a === b || (a !== undefined && b !== undefined && a.steps === b.steps && a.ms === b.ms && a.items === b.items && a.held === b.held && a.state === b.state && a.since === b.since && a.created === b.created && a.title === b.title);

export function createThreadData(key: Accessor<string>, thinking: Accessor<"open" | "rows">, caches?: ThreadCaches, turnsOptions?: TurnsOptions): ThreadData {
  const host = () => key().split(":")[0] ?? "";
  const session = () => state.fleet.sessions[key()];
  const thread = () => state.threads[key()];
  const rawMessages = () => thread()?.messages ?? NO_MESSAGES;
  const directory = () => session()?.info.directory ?? "";
  const repoRoot = () => {
    const info = session()?.info;
    return info ? repoRootOf(info) : "";
  };
  const root = createMemo(() => projectRoot(directory(), rawMessages()));
  /* the asks on this thread: a new map only when one of them came or went, so the fleet answering for other threads wakes nothing here */
  const asks = createMemo(() => {
    const out = new Map<string, PendingAsk & { callID: string }>();
    for (const a of Object.values(state.fleet.asks)) {
      if (a.key !== key()) continue;
      const callID = string(record(a.request["tool"])?.["callID"]) ?? "";
      out.set(a.id, { id: a.id, kind: a.kind, request: a.request, callID });
    }
    return out;
  }, new Map(), { equals: (a, b) => a.size === b.size && [...a].every(([id, x]) => { const y = b.get(id); return y !== undefined && y.kind === x.kind && y.request === x.request && y.callID === x.callID; }) });
  const asksByCall = createMemo(() => {
    const out = new Map<string, PendingAsk>();
    for (const a of asks().values()) if (a.callID) out.set(a.callID, a);
    return out;
  });
  /* this device's replies to this thread's asks, by call id: a new map only when one of them came or went or changed, so a reply
     kept for another thread wakes nothing here */
  const replies = createMemo(() => {
    const out = new Map<string, AskReply>();
    for (const r of Object.values(state.replies)) if (r.thread === key()) out.set(r.callID, r);
    return out;
  }, new Map(), { equals: (a, b) => a.size === b.size && [...a].every(([call, r]) => b.get(call) === r) });
  const { turns, count, ids, turnOf, more, grow, all } = createTurns(rawMessages, root, key, caches, { ...turnsOptions, need: () => new Set(asksByCall().keys()) });
  const title = () => session()?.info.title || key().split(":")[1] || key();
  /* the project root, as the window hashes it (window/view.ts), so a worktree's stage keeps its repo's colour */
  const tone = createMemo(() => toneOfColour(colourOf({ host: host(), root: session()?.info.projectID || directory() || key() })));

  /* the agents' reports, which an agent row links to: the mail turns alone, which a delta to the running turn never changes */
  const reports = createMemo(() => turns().filter((t) => t.by === "mail" && !t.note), [], { equals: (a, b) => a.length === b.length && a.every((t, i) => t === b[i]) });

  /* the agents this thread started: every session the fleet holds with this one as its parent (however it was started:
     the spawn tool, or `agents.spawn` inside a run script, which leaves no spawn part), plus the children the spawn
     rows name, for a child the fleet has let go. each is summarised once, in a memo of its own, and only a child that
     changed hands out a new summary (docs/thread.md, agents). where each is now comes from the fleet (its status, and the
     asks pending on it); what it did, from its thread, which is held only when it is wanted (below) */
  const childKeys = createMemo(() => {
    const keys = new Set<string>();
    const me = key().slice(host().length + 1);
    for (const entry of Object.values(state.fleet.sessions)) if (entry.host === host() && entry.info.parentID === me) keys.add(entry.key);
    for (const t of turns()) for (const s of spawnsOf(t)) if (s.agent?.child) keys.add(`${host()}:${s.agent.child}`);
    return [...keys].sort();
  }, [], { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) });
  const owner = getOwner();
  const summaries = new Map<string, { summary: Accessor<Child | undefined>; dispose: () => void }>();
  onCleanup(() => { for (const c of summaries.values()) c.dispose(); summaries.clear(); });
  const summaryOf = (k: string): Accessor<Child | undefined> => {
    const held = summaries.get(k);
    if (held) return held.summary;
    const made = runWithOwner(owner, () => createRoot((dispose) => {
      const own = createTurns(() => state.threads[k]?.messages ?? NO_MESSAGES, root, () => k, caches);
      const items = createMemo(() => own.turns().flatMap((t) => t.items));
      const summary = createMemo<Child | undefined>(() => {
        const entry = state.fleet.sessions[k];
        /* the fleet knows the parent and not the child: the fleet holds only each host's newest 300 threads, so an agent's own
           session is often older than them, or it was archived. which is not known, so it is not called gone: its door opens it
           by its key (a thread the server cannot find says so, reading.ts), and its state is idle, as the ios app has it. the
           fleet not yet knowing either is a cold load, and the row waits */
        if (!entry && !session()) return undefined;
        /* a thread read into the store: one whose messages can be shown, live or restored from the cache and stale. one the worker has
           only started (hydrating, nothing in it yet) is not read, and says no step count, never "0 steps" */
        const there = state.threads[k];
        const loaded = isRead(there);
        const all = items();
        const first = loaded ? (state.threads[k]?.messages[0]?.info.time.created ?? entry?.info.time.created ?? 0) : entry?.info.time.created ?? 0;
        /* a thread not held says how long its session lasted from the fleet's own times: created to last updated */
        const end = loaded ? (state.threads[k]?.messages.at(-1)?.info.time.completed ?? first) : entry?.info.time.updated ?? first;
        const asked = Object.values(state.fleet.asks).some((a) => a.key === k);
        const status = entry?.status;
        const state_: ChildState = !entry ? "idle" : asked ? "wants" : status?.type === "busy" || status?.type === "retry" ? "working" : status?.type === "idle" && status.parked ? "parked" : "idle";
        return { steps: loaded ? all.reduce((n, x) => n + (x.k === "step" ? 1 : 0), 0) : 0, ms: Math.max(0, end - first), items: all, held: loaded, state: state_, since: status?.since ?? first, created: entry?.info.time.created ?? first, title: entry?.info.title ?? "" };
      }, undefined, { equals: sameChild });
      return { summary, dispose };
    }));
    summaries.set(k, made as { summary: Accessor<Child | undefined>; dispose: () => void });
    return (made as { summary: Accessor<Child | undefined> }).summary;
  };
  const children = createMemo(() => {
    const out = new Map<string, Child>();
    const keys = childKeys();
    for (const k of keys) {
      const child = summaryOf(k)();
      if (child) out.set(k.slice(host().length + 1), child);
    }
    const here = new Set(keys);
    for (const [k, c] of [...summaries]) if (!here.has(k)) { c.dispose(); summaries.delete(k); }
    return out;
  });

  /* a child's thread is held (read, kept current) only when it is wanted, never for the asking, and never more than the worker's
     reserve can keep (holds.ts): the ones that are live (working, parked on agents or jobs, or asking), then the ones whose row or
     lane is within a screen of the view, nearest first (`seen`, from the stage's observer). the panel and the tape read what is not
     held from the fleet's session info alone. one the worker evicted that is still wanted is held again; one no longer wanted, and
     all of them when the parent leaves the stage, are released (sync/client.ts) */
  const [onScreen, setOnScreen] = createSignal<readonly Wanted[]>([]);
  const seen = (child: string, distance: number | null): void => {
    const k = `${host()}:${child}`;
    const was = untrack(onScreen);
    const now = was.find((w) => w.key === k);
    if (distance === null ? now === undefined : now?.distance === distance) return;
    const rest = was.filter((w) => w.key !== k);
    setOnScreen(distance === null ? rest : [...rest, { key: k, distance }]);
  };
  const liveChildren = createMemo(() => childKeys().filter((k) => { const st = children().get(k.slice(host().length + 1))?.state; return st === "working" || st === "wants" || st === "parked"; }), [], { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) });
  createHolds({ live: liveChildren, visible: onScreen, present: (k) => state.threads[k] !== undefined, hold: holdThread, release: releaseThread });

  /* every session under this thread at any depth, for what its agents cost (details-model.ts, spendOf): the fleet's
     sessions by their parent, plus the agents the spawn rows name (this thread's, and its held children's) for one the
     fleet has let go. a session's cost is the daemon's account of it, which never counts its own children, so the sum
     counts each once; one the fleet let go is read from its held messages, else its cost is not known */
  const kin = createMemo<readonly Kin[]>(() => {
    const me = key().slice(host().length + 1);
    if (!session()) return [];
    const under = new Map<string, Set<string>>();
    const add = (parent: string, child: string) => { const set = under.get(parent) ?? new Set<string>(); set.add(child); under.set(parent, set); };
    for (const entry of Object.values(state.fleet.sessions)) { const p = entry.info.parentID; if (entry.host === host() && p) add(p, entry.key.slice(host().length + 1)); }
    for (const t of turns()) for (const s of spawnsOf(t)) if (s.agent?.child) add(me, s.agent.child);
    for (const [id, child] of children()) for (const grand of spawnedIn(child.items)) add(id, grand);
    const out: Kin[] = [];
    const seen = new Set<string>([me]);
    const queue: Array<[string, string]> = [...(under.get(me) ?? [])].map((id) => [me, id]);
    for (let i = 0; i < queue.length; i++) {
      const [parent, id] = queue[i] as [string, string]; // i < queue.length
      if (seen.has(id)) continue;
      seen.add(id);
      const k = `${host()}:${id}`;
      const entry = state.fleet.sessions[k];
      const held = state.threads[k];
      const cost = entry ? entry.info.cost : held ? held.messages.reduce((n, m) => n + (m.info.role === "assistant" ? (number((m.info as Record<string, unknown>)["cost"]) ?? 0) : 0), 0) : null;
      out.push({ id, parent, title: entry?.info.title ?? "", at: entry?.info.time.created ?? held?.messages[0]?.info.time.created ?? 0, cost, gone: !entry });
      for (const next of under.get(id) ?? []) queue.push([id, next]);
    }
    return out;
  });

  const working = createMemo(() => {
    const last = turns().at(-1);
    const status = session()?.status;
    return last?.status === "working" || status?.type === "busy" || status?.type === "retry";
  });
  /* agents at work under this thread: its held children in a turn, or the daemon's own count while it waits on them */
  const agentsWorking = createMemo(() => { const s = session()?.status; return (s?.type === "idle" && (s.parked?.agents ?? 0) > 0) || [...children().values()].some((c) => c.state === "working"); });
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!working() && !agentsWorking()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  /* the context a row is painted in, without the clock: it changes when a child, an ask, a report or the thinking setting does,
     never for a delta to the running turn nor for a second passing (the clock is `now`, handed to the turns that show it) */
  const ctx = createMemo<RowCtx>(() => ({ turns: reports(), children: children(), asks: asksByCall(), replies: replies(), thinking: thinking() }));
  return {
    key, host, title, directory, repoRoot, tone,
    held: () => thread() !== undefined,
    hydrating: () => thread()?.status === "hydrating",
    trouble: () => thread()?.trouble,
    count, turns, ids, turnOf, more, grow, all, ctx, working, now, asks, children, kin, seen,
  };
}
