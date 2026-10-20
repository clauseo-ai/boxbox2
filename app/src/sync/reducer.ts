/* the sync reducer: one pure function from (state, action) to (state,
   patches, effects), exhaustive over the journal's frame union. the
   worker owns the state; the ui receives the patches; the effects are
   work the worker does next (reconnect, hydrate, refetch). nothing here
   does io, reads a clock or mutates what it was given, so every rule is a
   unit test (reducer.test.ts).

   exactly once, in two layers (docs/architecture.md, the sync model):

   - the journal: entries are numbered contiguously within an epoch. one at
     or below the cursor was already applied (a duplicate, skipped and
     counted); one past cursor + 1 means entries were lost, so the worker
     reconnects from the cursor and the server replays the gap.
   - a transcript: a thread is hydrated from cmx2's message list at the
     upstream seq R its `x-cmx2-seq` names. sequenced transcript entries at
     or below R are already in it (covered); above R they apply once, in
     order. deltas carry no seq, only their utf-16 offset into the part's
     text, so offsets decide: at the end it appends, inside it is covered,
     past it is a gap that refetches that one message. a delta at offset 0
     for a part the thread does not hold is that part's birth (the daemon
     announces a streamed text part by nothing else), so it creates it.

   a message's parts are held in the daemon's order (order.ts), whatever
   order they arrive in. while a message is fetched again every entry for it
   waits, and the answer is merged under them: the snapshot fills in what
   the thread lacks, and what waited applies on top, in order.

   what the worker holds in memory and what the cache holds are two sets. a
   thread in `threads` has its messages in memory; one in `cold` is only
   its head (where its read stood), with its pages in the cache until the
   worker reads them back (`restored`). an entry for a cold thread cannot
   be applied, so it marks the thread stale: when its pages come back it is
   read again from the daemon, the same as after a reset. that is what keeps
   the cursor honest for a thread nobody had open.

   a thread is held for the person (opened: `openedAt` is the time) or only
   held for another thread, a child's lane under its parent (`openedAt` 0).
   a hold never refreshes an opened thread's recency, and held-only threads
   have a reserve of places of their own beside the opened ones. a hold is a
   lease on one of those places for as long as the thread is held and not
   released, however old: with every place leased a new hold is refused and
   reads nothing, and a released place (or one whose thread was evicted) is
   free at once. a hold never evicts a lease for the count, and never an
   opened thread. over the byte cap, held-only threads go first (released
   ones, then the longest held), and only then the opened ones, never the
   one on stage. a child's own read takes room only from released held
   threads and opened threads off stage, never from another lease: one that
   cannot fit that way is dropped alone and its size noted (`unfit`), so a
   hold for it is refused without a read until the room could exist. */

import type {
  Ask,
  Cursor,
  DeltaEntry,
  Entry,
  FleetSnapshot,
  Frame,
  Hello,
  HostState,
  Message,
  MessageInfo,
  Part,
  RepoColourEntry,
  SessionEntry,
  ThreadEntry,
} from "./protocol";
import { type ColourAssignment, repoKey } from "../ui/window/repo";
import { placeBefore } from "./order";
import type { ReadTrouble } from "./read";

export type Counters = {
  /** journal entries applied, each exactly once */
  applied: number;
  /** entries delivered again and refused: a journal entry at or below the cursor, a transcript entry at or
      below the last one applied, a delta inside text that did not come from hydration */
  duplicates: number;
  /** transcript entries already contained in a hydration or refetch, skipped as expected */
  covered: number;
  /** journal entries that arrived past cursor + 1 */
  gaps: number;
  /** resets received: the server could not replay from the cursor */
  resets: number;
  /** messages fetched again because an entry found one the thread lacks, or a delta found a hole */
  refetches: number;
};

export const ZERO_COUNTERS: Counters = { applied: 0, duplicates: 0, covered: 0, gaps: 0, resets: 0, refetches: 0 };

export type Fleet = {
  /** host names in the server's order */
  hostNames: string[];
  hosts: Record<string, HostState>;
  sessions: Record<string, SessionEntry>;
  /** keyed `<host>:<ask id>` */
  asks: Record<string, Ask>;
  /** session keys in the server's window order */
  order: string[];
  /** each repo's colour as the server gave it and the person chose it, by `repoKey` (`host:root`) */
  colours: Record<string, ColourAssignment>;
};

export const EMPTY_FLEET: Fleet = { hostNames: [], hosts: {}, sessions: {}, asks: {}, order: [], colours: {} };

export type ThreadStatus = "hydrating" | "live";

/** what a message that is being fetched again keeps for its answer, in arrival order */
export type Held =
  | { kind: "info"; info: MessageInfo }
  | { kind: "part"; part: Part; resumed: boolean }
  | { kind: "delta"; frame: DeltaEntry };

export type Thread = {
  key: string;
  status: ThreadStatus;
  /** the number of the latest read of this thread (`SyncState.reads`), so only the answer to that one is taken */
  hydration: number;
  /** the upstream store the hydration read came from */
  upstreamEpoch: string | null;
  /** R: the upstream seq the hydration read reflects */
  hydratedAt: number;
  /** the highest upstream seq applied to this thread */
  lastUpstream: number;
  messages: Message[];
  /** per part, how much of its text (utf-16 units) came from a hydration or refetch */
  baseline: Record<string, number>;
  /** entries that arrived while a hydration was in flight */
  buffer: ThreadEntry[];
  /** what `buffer` holds, as `entryBytes` counts it, for its byte cap (BUFFER_BYTES). absent is none: a thread made
      outside the reducer holds nothing waiting */
  bufferBytes?: number;
  /** message id to the entries held while that message is fetched again */
  refetching: Record<string, Held[]>;
  /** what `refetching` holds across its messages, counted the same way, for its byte cap (HELD_BYTES); absent is none */
  heldBytes?: number;
  /** when the person last opened it (ms), for eviction; 0 for a thread that is only held for another (`hold`) */
  openedAt: number;
  /** when it was last held for another thread (ms): orders the held-only threads for eviction, released ones first */
  heldAt: number;
  /** a held-only thread's place in the reserve is leased while it is held and not released, whatever its age; a
      released one is free to be taken. in memory only: the cache does not keep it, so a page that was reloaded starts
      with every place free and a release that was missed cannot outlive the page */
  leased: boolean;
  /** an estimate of what it holds, in the size of its json (the wire's and the cache's measure): the read's bytes,
      then every change the reducer applies. the byte cap counts it (`BYTE_CAP`) */
  bytes: number;
  /** why its read is failing while it waits to try again (read.ts), null while nothing failed: set by each failed try,
      cleared by the read that lands. in memory only, like the lease: a reload reads afresh and says what it finds */
  trouble: ReadTrouble | null;
};

/** a thread whose pages are in the cache and not in memory: its head, as the cache saved it */
export type Cold = {
  key: string;
  status: ThreadStatus;
  hydration: number;
  upstreamEpoch: string | null;
  hydratedAt: number;
  lastUpstream: number;
  baseline: Record<string, number>;
  /** messages being fetched again when the head was saved; fetched again once the thread is restored */
  refetching: string[];
  openedAt: number;
  heldAt: number;
  /** as `Thread.leased`: false from the cache, true once the thread is held while it is cold */
  leased: boolean;
  /** the size of its json when the head was written; 0 with `sized` false for a head written before heads carried one:
      its size is not known until its pages are read, so it counts for nothing until then (an estimate would evict
      threads the person has open, on the first launch after an upgrade) */
  bytes: number;
  sized: boolean;
  pages: number;
  /** an entry for the thread came while it was cold, so its pages are behind the cursor: it is read again on restore */
  stale: boolean;
};

export type SyncState = {
  cursor: Cursor | null;
  /** the journal head the last hello announced */
  head: number;
  fleet: Fleet;
  threads: Record<string, Thread>;
  /** the cached threads whose pages are not in memory, by key */
  cold: Record<string, Cold>;
  /** held-only threads that were read and did not fit, by key, with the size they measured: a hold for one is refused
      without a read for as long as the room it needs cannot exist (`holdFor`). at most UNFIT_CAP, the one remembered
      longest ago forgotten first; in memory only, so a reload tries each child once */
  unfit: Record<string, number>;
  /** reads of a whole transcript started so far. every read takes the next number, so a number is never used twice for
      a key, whichever incarnation of the thread asked: an answer to a read of a thread that was evicted since is not
      the answer to the read of the thread held again after it */
  reads: number;
  counters: Counters;
};

export const INITIAL_STATE: SyncState = { cursor: null, head: 0, fleet: EMPTY_FLEET, threads: {}, cold: {}, unfit: {}, reads: 0, counters: ZERO_COUNTERS };

/** the ui's view of a thread: the part it renders */
export type ThreadView = { key: string; status: ThreadStatus; messages: Message[]; /** set while its read is failing */ trouble?: ReadTrouble };

export function viewOf(thread: Thread): ThreadView {
  return { key: thread.key, status: thread.status, messages: thread.messages, ...(thread.trouble ? { trouble: thread.trouble } : {}) };
}

export type PathSegment = string | number;

/** one change for the ui's store: set `value` at `path` (undefined deletes the key), or, for text that grew at its end
    (a streamed part), `append` what came after the string's first `from` characters. an append carries the new words and
    not the whole text, so a long answer costs the wire and the ui's store what each delta added, not what it has grown to */
export type Patch = SetPatch | AppendPatch;
export type SetPatch = { path: readonly PathSegment[]; value: unknown };
export type AppendPatch = { path: readonly PathSegment[]; append: string; from: number };

export const isAppend = (patch: Patch): patch is AppendPatch => "append" in patch;

/** the string an append makes of what is at its path: the first `from` characters, then the words it adds. the worker sends
    it only where the text is exactly `from` long, so the ui joins two strings and slices nothing */
export function appended(current: unknown, patch: AppendPatch): string {
  if (typeof current !== "string") return patch.append;
  return (current.length === patch.from ? current : current.slice(0, patch.from)) + patch.append;
}

export type Effect =
  | { type: "reconnect" }
  | { type: "hydrate"; key: string; hydration: number }
  /** `hydration` is the number of the thread's read when it asked: the answer is for that incarnation of the thread only */
  | { type: "refetch"; key: string; messageID: string; hydration: number }
  /** a thread left the cache's set: its records are deleted; `opened` says the person had it open once, `cap` which
      limit it was over: the person's thread cap, the held reserve, the byte cap, or (`unfit`) a held read that could
      not fit beside the thread on stage whatever else went */
  | { type: "evicted"; key: string; bytes: number; opened: boolean; cap: Cap }
  /** a thread's head changed (recency, staleness) and is written with the next save */
  | { type: "head"; key: string };

export type Action =
  | { type: "frame"; frame: Frame; epoch: string | undefined }
  /** the person opened a thread: it joins the set, or is promoted to opened if it was only held */
  | { type: "open"; key: string; at: number }
  /** a thread is held for another (a child under its parent on stage): read and kept current, never at an opened
      thread's cost. the hold leases one of the reserve's places for as long as the thread is held and not released */
  | { type: "hold"; key: string; at: number }
  /** a held thread is no longer needed: its place is free at once, and the thread stays cached, first to be evicted. an
      opened thread is not changed */
  | { type: "release"; key: string }
  /** the pages of a cold thread, read back from the cache (null: a page was missing, so the thread starts over from the
      daemon). `bytes` is their size where the worker measured it, which it does for a head with none (`Cold.sized`). a
      thread that is no longer cold is left alone */
  | { type: "restored"; key: string; messages: Message[] | null; bytes?: number }
  /** `bytes` is the read's size where the worker measured it, else it is measured here */
  | { type: "hydrated"; key: string; hydration: number; upstreamEpoch: string; at: number; messages: Message[]; bytes?: number }
  | { type: "refetched"; key: string; hydration: number; messageID: string; message: Message | null }
  /** a try of read `hydration` failed and waits its backoff to try again: why, for a stage with nothing to show */
  | { type: "read-failed"; key: string; hydration: number; trouble: ReadTrouble }
  /** the person asked for a thread that is waiting on its read again (a stage's retry): the read starts over now, under a
      new number and without the backoff the old one was sitting out. a thread that is live, or not held, is left alone */
  | { type: "reread"; key: string }
  /** the server's whole map of repo colours, outside the journal: it replaces what the fleet holds */
  | { type: "colours"; colours: RepoColourEntry[] }
  /** one repo's colour changed, outside the journal */
  | { type: "colour"; colour: RepoColourEntry };

export type Result = { state: SyncState; patches: Patch[]; effects: Effect[] };

export type Cap = "opened" | "held" | "bytes" | "unfit";

/** threads the person opened that are kept, in memory and cold together (docs/architecture.md, indexeddb layout) */
export const THREAD_CAP = 40;
/** threads held only for another, kept beside the opened ones: the stage's live children and the rows on screen */
export const HELD_CAP = 16;
/** how many unfit children are remembered */
export const UNFIT_CAP = 64;
/** the cache's byte cap, counted in `Thread.bytes` */
export const BYTE_CAP = 150 * 1024 * 1024;
/** entries one thread may hold while hydrating; past it the hydration starts over from a newer read */
export const BUFFER_CAP = 20_000;
/** the largest frame the server passes on (`FRAME_CAP`, server/src/upstream/watcher.rs): a tool part with 4 mb of image
    attachments, whole */
export const SERVER_FRAME_BYTES = 8 * 1024 * 1024;
/** the bytes those entries may hold beside their count: sixteen frames at the server's largest, so no read a stream can
    outlast in seconds comes near it, only one that hangs while images keep arriving. past it the hydration starts over
    from a newer read, as at the count */
export const BUFFER_BYTES = 16 * SERVER_FRAME_BYTES;
/** the bytes one thread may hold for its messages being fetched again (`Thread.refetching`), sixteen of the server's
    largest frames: a refetch answers in about a second, but one that keeps coming back short while its message streams
    would hold every delta for as long as it streams. past it the held entries and the refetches are dropped and the
    thread is read again whole, which is what a reset does and covers everything they held */
export const HELD_BYTES = 16 * SERVER_FRAME_BYTES;

/** the mutable working set of one reduction; the inputs are never touched */
class Work {
  readonly patches: Patch[] = [];
  readonly effects: Effect[] = [];
  counters: Counters;
  reads: number;
  constructor(readonly state: SyncState) {
    this.counters = state.counters;
    this.reads = state.reads;
  }
  /** the number of a read about to start */
  nextRead(): number {
    return ++this.reads;
  }
  count(name: keyof Counters, by = 1) {
    this.counters = { ...this.counters, [name]: this.counters[name] + by };
  }
  patch(path: readonly PathSegment[], value: unknown) {
    this.patches.push({ path, value });
  }
}

export function reduce(state: SyncState, action: Action): Result {
  const work = new Work(state);
  let next: SyncState;
  switch (action.type) {
    case "frame":
      next = applyFrame(work, state, action.frame, action.epoch);
      break;
    case "open":
      next = open(work, state, action.key, action.at);
      break;
    case "hold":
      next = holdFor(work, state, action.key, action.at);
      break;
    case "release":
      next = release(work, state, action.key);
      break;
    case "restored":
      next = restored(work, state, action);
      break;
    case "hydrated":
      next = hydrated(work, state, { ...action, messages: action.messages.map(slimMessage) });
      break;
    case "refetched":
      next = refetched(work, state, { ...action, message: action.message && slimMessage(action.message) });
      break;
    case "read-failed":
      next = readFailed(work, state, action);
      break;
    case "reread":
      next = reread(work, state, action.key);
      break;
    case "colours":
      next = colours(work, state, action.colours);
      break;
    case "colour":
      next = colour(work, state, action.colour);
      break;
    default:
      return unreachable(action);
  }
  return { state: { ...next, counters: work.counters, reads: work.reads }, patches: work.patches, effects: work.effects };
}

function unreachable(value: never): never {
  throw new Error(`the reducer met ${JSON.stringify(value)}, which its union does not declare`);
}

function applyFrame(work: Work, state: SyncState, frame: Frame, epoch: string | undefined): SyncState {
  switch (frame.type) {
    case "hello":
      return hello(state, frame);
    case "reset":
      return reset(work, state, frame.fleet, { epoch: frame.epoch, seq: frame.seq });
    default:
      return entry(work, state, frame, epoch);
  }
}

function hello(state: SyncState, frame: Hello): SyncState {
  return { ...state, head: frame.head };
}

function reset(work: Work, state: SyncState, snapshot: FleetSnapshot, cursor: Cursor): SyncState {
  work.count("resets");
  // the colours travel outside the journal and arrive ahead of the reset on the same connection, so the snapshot has
  // none and the map stays as it is
  const fleet = { ...fleetOf(snapshot), colours: state.fleet.colours };
  work.patch(["fleet"], fleet);
  // the transcripts may have missed anything; each is read again, and shows what it had meanwhile
  const threads: Record<string, Thread> = {};
  for (const [key, thread] of Object.entries(state.threads)) threads[key] = rehydrate(work, thread);
  return { ...state, cursor, head: Math.max(state.head, cursor.seq), fleet, threads, cold: staleAll(work, state.cold, () => true) };
}

export function fleetOf(snapshot: FleetSnapshot): Fleet {
  const hosts: Record<string, HostState> = {};
  for (const host of snapshot.hosts) hosts[host.name] = host;
  const sessions: Record<string, SessionEntry> = {};
  for (const session of snapshot.sessions) sessions[session.key] = session;
  const asks: Record<string, Ask> = {};
  for (const ask of snapshot.asks) asks[askKey(ask.host, ask.id)] = ask;
  // a snapshot carries no colours: they come in frames of their own (protocol.ts, `ColourFrame`)
  return { hostNames: snapshot.hosts.map((h) => h.name), hosts, sessions, asks, order: snapshot.order, colours: {} };
}

/** the whole map, which replaces the one the fleet holds */
function colours(work: Work, state: SyncState, list: readonly RepoColourEntry[]): SyncState {
  const map: Record<string, ColourAssignment> = {};
  for (const one of list) map[repoKey(one)] = assignmentOf(one);
  work.patch(["fleet", "colours"], map);
  return { ...state, fleet: { ...state.fleet, colours: map } };
}

function colour(work: Work, state: SyncState, one: RepoColourEntry): SyncState {
  const key = repoKey(one);
  const assignment = assignmentOf(one);
  work.patch(["fleet", "colours", key], assignment);
  return { ...state, fleet: { ...state.fleet, colours: { ...state.fleet.colours, [key]: assignment } } };
}

/** what the fleet keeps of a repo's colour: its key already names the host and root */
const assignmentOf = (colour: RepoColourEntry): ColourAssignment => ({ auto: colour.auto, chosen: colour.chosen ?? null });

const askKey = (host: string, id: string) => `${host}:${id}`;

function rehydrate(work: Work, thread: Thread): Thread {
  const next: Thread = { ...thread, status: "hydrating", hydration: work.nextRead(), buffer: [], bufferBytes: 0, refetching: {}, heldBytes: 0 };
  work.effects.push({ type: "hydrate", key: thread.key, hydration: next.hydration });
  work.patch(["threads", thread.key, "status"], "hydrating");
  return next;
}

function entry(work: Work, state: SyncState, frame: Entry, epoch: string | undefined): SyncState {
  const cursor = state.cursor;
  if (cursor === null || epoch !== cursor.epoch || frame.seq > cursor.seq + 1) {
    // a reset comes first on any connection the server cannot replay, so this is a lost entry
    work.count("gaps");
    work.effects.push({ type: "reconnect" });
    return state;
  }
  if (frame.seq <= cursor.seq) {
    work.count("duplicates");
    return state;
  }
  work.count("applied");
  const next = { ...state, cursor: { epoch: cursor.epoch, seq: frame.seq } };
  switch (frame.type) {
    case "host":
      return { ...next, fleet: host(work, next.fleet, frame.host) };
    case "host.removed":
      return { ...next, fleet: hostRemoved(work, next.fleet, frame.host) };
    case "host.reset":
      return hostReset(work, next, frame.host, frame.sessions, frame.asks);
    case "session": {
      const before = next.fleet.sessions[frame.session.key];
      if (before) changed(work, ["fleet", "sessions", frame.session.key], before, frame.session);
      else work.patch(["fleet", "sessions", frame.session.key], frame.session);
      return { ...next, fleet: { ...next.fleet, sessions: { ...next.fleet.sessions, [frame.session.key]: frame.session } } };
    }
    case "session.removed": {
      const { [frame.key]: _removed, ...sessions } = next.fleet.sessions;
      work.patch(["fleet", "sessions", frame.key], undefined);
      return { ...next, fleet: { ...next.fleet, sessions } };
    }
    case "ask": {
      const key = askKey(frame.ask.host, frame.ask.id);
      work.patch(["fleet", "asks", key], frame.ask);
      return { ...next, fleet: { ...next.fleet, asks: { ...next.fleet.asks, [key]: frame.ask } } };
    }
    case "ask.settled": {
      const key = askKey(frame.host, frame.id);
      const { [key]: _settled, ...asks } = next.fleet.asks;
      work.patch(["fleet", "asks", key], undefined);
      return { ...next, fleet: { ...next.fleet, asks } };
    }
    case "order":
      work.patch(["fleet", "order"], frame.keys);
      return { ...next, fleet: { ...next.fleet, order: frame.keys } };
    case "message":
    case "part":
    case "delta":
    case "message.removed": {
      const thread = next.threads[frame.key];
      if (!thread) return { ...next, cold: staleAll(work, next.cold, (key) => key === frame.key) };
      const grown = threadEntry(work, thread, frame);
      const threads = { ...next.threads, [frame.key]: grown };
      // a thread that the stream grows past the byte cap is evicted for it now, not at the next open or read
      if (grown.bytes <= thread.bytes || totalBytes({ threads, cold: next.cold }) <= BYTE_CAP) return { ...next, threads };
      return { ...next, ...makeRoom(work, next, threads, next.cold, frame.key) };
    }
    default:
      return unreachable(frame);
  }
}

function host(work: Work, fleet: Fleet, state: HostState): Fleet {
  const known = state.name in fleet.hosts;
  work.patch(["fleet", "hosts", state.name], state);
  const hostNames = known ? fleet.hostNames : [...fleet.hostNames, state.name];
  if (!known) work.patch(["fleet", "hostNames"], hostNames);
  return { ...fleet, hostNames, hosts: { ...fleet.hosts, [state.name]: state } };
}

function hostRemoved(work: Work, fleet: Fleet, name: string): Fleet {
  const { [name]: _removed, ...hosts } = fleet.hosts;
  const hostNames = fleet.hostNames.filter((n) => n !== name);
  work.patch(["fleet", "hosts", name], undefined);
  work.patch(["fleet", "hostNames"], hostNames);
  return { ...fleet, hostNames, hosts };
}

/** a host's upstream stream was reset: its part of the fleet is replaced and its open transcripts read again */
function hostReset(work: Work, state: SyncState, name: string, entries: SessionEntry[], pending: Ask[]): SyncState {
  const sessions: Record<string, SessionEntry> = {};
  for (const [key, session] of Object.entries(state.fleet.sessions)) if (session.host !== name) sessions[key] = session;
  for (const session of entries) sessions[session.key] = session;
  const asks: Record<string, Ask> = {};
  for (const [key, ask] of Object.entries(state.fleet.asks)) if (ask.host !== name) asks[key] = ask;
  for (const ask of pending) asks[askKey(ask.host, ask.id)] = ask;
  work.patch(["fleet", "sessions"], sessions);
  work.patch(["fleet", "asks"], asks);
  const threads = { ...state.threads };
  for (const [key, thread] of Object.entries(state.threads)) {
    if (key.startsWith(`${name}:`)) threads[key] = rehydrate(work, thread);
  }
  const cold = staleAll(work, state.cold, (key) => key.startsWith(`${name}:`));
  return { ...state, fleet: { ...state.fleet, sessions, asks }, threads, cold };
}

/** marks the cold threads `which` names as behind the journal. their head is written, so a reload does not take
    their pages for current */
function staleAll(work: Work, cold: Record<string, Cold>, which: (key: string) => boolean): Record<string, Cold> {
  let next = cold;
  for (const [key, head] of Object.entries(cold)) {
    if (head.stale || !which(key)) continue;
    if (next === cold) next = { ...cold };
    next[key] = { ...head, stale: true };
    work.effects.push({ type: "head", key });
  }
  return next;
}

/* —— a session entry, sent whole again —— */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** two parsed json values are the same, keys in the same order */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  const keys = Object.keys(a);
  const others = Object.keys(b);
  if (keys.length !== others.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string; // i is inside keys
    if (key !== others[i] || !sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** changing `before` into `after` in place keeps `after`'s key order: the keys they share come first, in the same order,
    and the new ones after them (a deleted key leaves the rest where they were, an added one goes to the end) */
function keepsOrder(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const order = Object.keys(after);
  let at = 0;
  for (const key of Object.keys(before)) {
    if (!(key in after)) continue;
    if (order[at] !== key) return false;
    at++;
  }
  return true;
}

/** the patches that make the ui's copy of `before` into `after`, touching only what differs. the server sends a busy
    session's whole entry up to five times a second (its info, status, needs and a tail of twelve items) when one tail
    item grew, so a reader of anything else would wake for nothing. an object changes key by key where that leaves its
    keys in `after`'s order, else it is set whole; an array is set whole when its length changed or most of its items did
    (a tail that moved on), else each changed item is set whole: an item the ui holds on to (the stage's review need) is
    never changed under it, a changed one is a new one, as when the whole entry was replaced. the ui ends deep-equal to
    `after`, key order included */
function changed(work: Work, path: readonly PathSegment[], before: unknown, after: unknown): void {
  if (isRecord(before) && isRecord(after) && keepsOrder(before, after)) {
    for (const key of Object.keys(before)) if (!(key in after)) work.patch([...path, key], undefined);
    for (const key of Object.keys(after)) {
      const was = before[key];
      const now = after[key];
      // most of an entry is numbers and strings as they were: the path is built only for what differs or nests
      if (Object.is(was, now)) continue;
      if (typeof now !== "object" || now === null || typeof was !== "object" || was === null) work.patch([...path, key], now);
      else changed(work, [...path, key], was, now);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    const differ: number[] = [];
    for (let i = 0; i < after.length; i++) if (!sameJson(before[i], after[i])) differ.push(i);
    if (differ.length * 2 <= after.length) {
      for (const i of differ) work.patch([...path, i], after[i]);
      return;
    }
  }
  if (!sameJson(before, after)) work.patch(path, after);
}

/* —— transcripts —— */

function threadEntry(work: Work, thread: Thread, frame: ThreadEntry): Thread {
  if (thread.status === "hydrating") {
    const bufferBytes = (thread.bufferBytes ?? 0) + entryBytes(frame);
    if (thread.buffer.length >= BUFFER_CAP || bufferBytes > BUFFER_BYTES) return rehydrate(work, thread);
    return { ...thread, buffer: [...thread.buffer, frame], bufferBytes };
  }
  switch (frame.type) {
    case "message":
      return upstreamGate(work, thread, frame.upstream, (t) => applyInfo(work, t, frame.info));
    case "part":
      if (frame.upstream === null) return applyPart(work, thread, frame.part, true);
      return upstreamGate(work, thread, frame.upstream, (t) => applyPart(work, t, frame.part, false));
    case "message.removed":
      return upstreamGate(work, thread, frame.upstream, (t) => removeMessage(work, t, frame.messageID));
    case "delta":
      if (holding(thread, frame.messageID)) return hold(work, thread, frame.messageID, { kind: "delta", frame });
      return delta(work, thread, frame);
    default:
      return unreachable(frame);
  }
}

/** a sequenced transcript entry applies once, and only past the read the thread was hydrated from;
    null means the daemon did not log it, so it is newer than any read and carries nothing to dedupe on */
function upstreamGate(work: Work, thread: Thread, upstream: number | null, apply: (t: Thread) => Thread): Thread {
  if (upstream === null) return apply(thread);
  if (upstream <= thread.hydratedAt) {
    work.count("covered");
    return thread;
  }
  if (upstream <= thread.lastUpstream) {
    work.count("duplicates");
    return thread;
  }
  return apply({ ...thread, lastUpstream: upstream });
}

/** the size of a value's json, made: for a read nobody measured (the worker always does, from the body's length) */
const sizeOf = (value: unknown): number => JSON.stringify(value).length;

/** what a value's json would weigh, counted without making it: a string is its length and quotes, a key its length with
    quotes, colon and comma, a number, boolean or null a few characters. changes to a thread are counted with it, the same
    function on both sides of a replacement, so only the difference matters; a string, however long, costs nothing to
    count. nesting past a depth no part has is not followed */
function jsonWeight(value: unknown, depth = 0): number {
  switch (typeof value) {
    case "string":
      return value.length + 2;
    case "number":
      return 8;
    case "boolean":
      return 5;
    case "object": {
      if (value === null) return 4;
      if (depth >= 8) return 16;
      if (Array.isArray(value)) return value.reduce((n: number, item) => n + jsonWeight(item, depth + 1) + 1, 2);
      return Object.entries(value).reduce((n, [name, item]) => n + name.length + 4 + jsonWeight(item, depth + 1), 2);
    }
    default:
      return 0;
  }
}

/** what a text or reasoning part's json holds besides its words (ids, type, times): measured on recorded parts at 120 to
    200 characters, so a streaming part's size is its text and this */
export const PART_ENVELOPE = 160;

/** the size a part adds to its thread: its words and an envelope for a text or reasoning part, its weight for any other */
function partBytes(part: Part): number {
  const words = part.type === "text" || part.type === "reasoning" ? part["text"] : undefined;
  return typeof words === "string" ? words.length + PART_ENVELOPE : jsonWeight(part);
}

const messageBytes = (message: Message): number => message.parts.reduce((n, part) => n + partBytes(part), jsonWeight(message.info) + 20);

/** the thread with `by` more bytes held (or fewer, when negative) */
const grown = (thread: Thread, by: number): Thread => (by === 0 ? thread : { ...thread, bytes: Math.max(0, thread.bytes + by) });

const messageIndex = (thread: Thread, id: string) => thread.messages.findIndex((m) => m.info.id === id);

const holding = (thread: Thread, messageID: string) => thread.refetching[messageID] !== undefined;

/** what a delta, an info or a message's removal weighs beside the words it carries: its ids, field and offset */
const ENTRY_ENVELOPE = 160;

/** a transcript entry's size as the caps on what waits count it: a delta its words, a part as the thread counts it */
function entryBytes(frame: ThreadEntry): number {
  switch (frame.type) {
    case "delta":
      return frame.delta.length + ENTRY_ENVELOPE;
    case "part":
      return partBytes(frame.part);
    case "message":
      return jsonWeight(frame.info);
    case "message.removed":
      return ENTRY_ENVELOPE;
    default:
      return unreachable(frame);
  }
}

function heldBytes(entry: Held): number {
  switch (entry.kind) {
    case "info":
      return jsonWeight(entry.info);
    case "part":
      return partBytes(entry.part);
    case "delta":
      return entryBytes(entry.frame);
    default:
      return unreachable(entry);
  }
}

const listBytes = (entries: readonly Held[]): number => entries.reduce((n, entry) => n + heldBytes(entry), 0);

/** keeps an entry for a message being fetched again; past the byte cap the thread is read again instead (HELD_BYTES) */
function hold(work: Work, thread: Thread, messageID: string, entry: Held): Thread {
  const held = thread.refetching[messageID] ?? [];
  const bytes = (thread.heldBytes ?? 0) + heldBytes(entry);
  if (bytes > HELD_BYTES) return rehydrate(work, thread);
  return { ...thread, refetching: { ...thread.refetching, [messageID]: [...held, entry] }, heldBytes: bytes };
}

function applyInfo(work: Work, thread: Thread, info: MessageInfo): Thread {
  if (holding(thread, info.id)) return hold(work, thread, info.id, { kind: "info", info });
  return upsertInfo(work, thread, info);
}

/** a message's info replaces the one held (its parts stay), or the message joins the end */
function upsertInfo(work: Work, thread: Thread, info: MessageInfo): Thread {
  const at = messageIndex(thread, info.id);
  const messages = [...thread.messages];
  if (at < 0) {
    const added: Message = { info, parts: [] };
    messages.push(added);
    work.patch(["threads", thread.key, "messages", messages.length - 1], added);
    return grown({ ...thread, messages }, messageBytes(added));
  }
  const before = messages[at] as Message; // at came from findIndex on this array
  const next: Message = { info, parts: before.parts };
  messages[at] = next;
  work.patch(["threads", thread.key, "messages", at], next);
  return grown({ ...thread, messages }, jsonWeight(info) - jsonWeight(before.info));
}

function removeMessage(work: Work, thread: Thread, id: string): Thread {
  const messages = thread.messages.filter((m) => m.info.id !== id);
  if (messages.length === thread.messages.length && !holding(thread, id)) return thread;
  const gone = thread.messages.find((m) => m.info.id === id);
  // a refetch still in flight for it finds nothing waiting and is dropped
  const { [id]: dropped, ...refetching } = thread.refetching;
  const heldBytes = (thread.heldBytes ?? 0) - (dropped ? listBytes(dropped) : 0);
  if (messages.length === thread.messages.length) return { ...thread, refetching, heldBytes };
  work.patch(["threads", thread.key, "messages"], messages);
  return grown({ ...thread, messages, refetching, heldBytes }, gone ? -messageBytes(gone) : 0);
}

/** a file part that is not an image, held without its bytes (docs/composer.md, attachments: any file): a pdf a person sent
    comes back whole from the daemon, up to 12 mb of data url, and the thread draws only its name and kind (model.ts,
    `sentFilesOf`), so the url is emptied and the file's size kept. an image keeps its url: the thread draws it, and an
    original it cannot draw (a heic) is left as it came, as before */
export function slimPart(part: Part): Part {
  if (part.type !== "file" || part.mime.startsWith("image/") || !part.url.startsWith("data:")) return part;
  const data = part.url.length - part.url.indexOf(",") - 1;
  const size = typeof part["size"] === "number" ? part["size"] : Math.floor((data * 3) / 4);
  return { ...part, url: "", size };
}

const slimMessage = (message: Message): Message => (message.parts.some((p) => p.type === "file") ? { info: message.info, parts: message.parts.map(slimPart) } : message);

/** a part sets its place by its id (order.ts); one that was streaming when the server's upstream stream resumed
    (`resumed`: cmx2 sends it once, whole, with no seq) replaces what is held unless it would shorten text
    already applied, which only a snapshot taken before a later hydration could do */
function applyPart(work: Work, thread: Thread, sent: Part, resumed: boolean): Thread {
  const part = slimPart(sent);
  const entry: Held = { kind: "part", part, resumed };
  if (holding(thread, part.messageID)) return hold(work, thread, part.messageID, entry);
  const at = messageIndex(thread, part.messageID);
  if (at < 0) return startRefetch(work, thread, part.messageID, [entry]);
  const held = (thread.messages[at] as Message).parts.find((p) => p.id === part.id); // at came from findIndex
  if (resumed && held && textLength(held, "text") > textLength(part, "text")) {
    work.count("covered");
    return thread;
  }
  return putPart(work, thread, at, part);
}

/** sets a part in message `at`: over the one with its id, else into its place. an insert before the end moves
    the parts after it, so the ui is told the whole list */
function putPart(work: Work, thread: Thread, at: number, part: Part): Thread {
  const message = thread.messages[at] as Message; // the callers found at in this thread
  const index = message.parts.findIndex((p) => p.id === part.id);
  const parts = [...message.parts];
  const base = ["threads", thread.key, "messages", at, "parts"] as const;
  const by = partBytes(part) - (index >= 0 ? partBytes(message.parts[index] as Part) : 0); // index is inside the parts
  if (index >= 0) {
    parts[index] = part;
    work.patch([...base, index], part);
  } else {
    const place = placeBefore(parts, part.id);
    parts.splice(place, 0, part);
    if (place === parts.length - 1) work.patch([...base, place], part);
    else work.patch(base, parts);
  }
  const messages = [...thread.messages];
  messages[at] = { info: message.info, parts };
  return grown({ ...thread, messages }, by);
}

function textLength(part: Part, field: string): number {
  const value = part[field];
  return typeof value === "string" ? value.length : 0;
}

function delta(work: Work, thread: Thread, frame: DeltaEntry): Thread {
  const held: Held = { kind: "delta", frame };
  const at = messageIndex(thread, frame.messageID);
  if (at < 0) return startRefetch(work, thread, frame.messageID, [held]);
  const message = thread.messages[at] as Message; // at came from findIndex on this array
  const index = message.parts.findIndex((p) => p.id === frame.partID);
  if (index < 0) {
    // offset 0 is the part's birth; anywhere past it the start of the text was missed
    if (frame.offset === 0 && frame.field === "text") return putPart(work, thread, at, bornText(message, frame));
    return startRefetch(work, thread, frame.messageID, [held]);
  }
  const part = message.parts[index] as Part; // index came from findIndex on these parts
  const text = part[frame.field];
  if (text !== undefined && typeof text !== "string") return thread;
  const had = text ?? "";
  const end = frame.offset + frame.delta.length;
  let added: string;
  if (frame.offset === had.length) {
    added = frame.delta;
  } else if (end <= had.length) {
    work.count(end <= (thread.baseline[frame.partID] ?? 0) ? "covered" : "duplicates");
    return thread;
  } else if (frame.offset < had.length) {
    added = frame.delta.slice(had.length - frame.offset);
  } else {
    return startRefetch(work, thread, frame.messageID, [held]);
  }
  const next = had + added;
  const parts = [...message.parts];
  parts[index] = { ...part, [frame.field]: next } as Part;
  const messages = [...thread.messages];
  messages[at] = { info: message.info, parts };
  // only the words past the end go to the ui, so a delta costs what it adds however long the text has grown
  work.patches.push({ path: ["threads", thread.key, "messages", at, "parts", index, frame.field], append: added, from: had.length });
  return grown({ ...thread, messages }, added.length);
}

/** the part a first delta creates: text, still streaming, until the whole part arrives and replaces it */
function bornText(message: Message, frame: DeltaEntry): Part {
  return { id: frame.partID, sessionID: message.info.sessionID, messageID: frame.messageID, type: "text", text: frame.delta, streaming: true };
}

/** asks the worker for a message, with what waits for it. one already being fetched takes the entry too: its
    answer is merged under everything held, and a gap that is still open then asks again */
function startRefetch(work: Work, thread: Thread, messageID: string, entries: Held[]): Thread {
  const pending = thread.refetching[messageID];
  const heldBytes = (thread.heldBytes ?? 0) + listBytes(entries);
  if (heldBytes > HELD_BYTES) return rehydrate(work, thread);
  if (pending) return { ...thread, refetching: { ...thread.refetching, [messageID]: [...pending, ...entries] }, heldBytes };
  work.count("refetches");
  work.effects.push({ type: "refetch", key: thread.key, messageID, hydration: thread.hydration });
  return { ...thread, refetching: { ...thread.refetching, [messageID]: entries }, heldBytes };
}

function baselineOf(messages: readonly Message[], into: Record<string, number> = {}): Record<string, number> {
  const baseline = { ...into };
  for (const message of messages) for (const part of message.parts) baseline[part.id] = textLength(part, "text");
  return baseline;
}

/* —— the worker's own actions —— */

function fresh(work: Work, key: string, openedAt: number, heldAt: number, leased: boolean): Thread {
  return {
    key,
    status: "hydrating",
    hydration: work.nextRead(),
    upstreamEpoch: null,
    hydratedAt: 0,
    lastUpstream: 0,
    messages: [],
    baseline: {},
    buffer: [],
    bufferBytes: 0,
    refetching: {},
    heldBytes: 0,
    openedAt,
    heldAt,
    leased,
    bytes: 0,
    trouble: null,
  };
}

/** the person opens a thread. one already held (for another thread, or cached) is promoted: the read it has stays,
    and from here it is an opened thread, the newest of them, so a promotion can pass the person's cap like any open. a
    size a child once measured is forgotten: the person's open is not refused for it */
function open(work: Work, state: SyncState, key: string, at: number): SyncState {
  const roomy: SyncState = { ...state, unfit: forget(state.unfit, key) };
  const held = state.threads[key];
  if (held) {
    work.effects.push({ type: "head", key });
    return { ...roomy, ...makeRoom(work, roomy, { ...state.threads, [key]: { ...held, openedAt: at, leased: false } }, state.cold, key) };
  }
  // a cold thread is promoted where it is, before its pages are read, so the eviction that its read can race with takes
  // another: the worker restores it right after
  const head = state.cold[key];
  if (head) {
    work.effects.push({ type: "head", key });
    return { ...roomy, ...makeRoom(work, roomy, state.threads, { ...state.cold, [key]: { ...head, openedAt: at, leased: false } }, key) };
  }
  const thread = fresh(work, key, at, 0, false);
  work.effects.push({ type: "hydrate", key, hydration: thread.hydration });
  work.patch(["threads", key], viewOf(thread));
  return { ...roomy, ...makeRoom(work, roomy, { ...state.threads, [key]: thread }, state.cold, key) };
}

/** a thread held for another: a child's lane under its parent on stage. it is read and kept current like any, and
    leases one of a reserve of places of its own (HELD_CAP) beside the opened threads, so it never costs one a place; only
    the byte cap can take an opened thread's room for it, and then never the one on stage. a lease lasts while the thread
    is held and not released, however old it is: with all the places leased the hold is refused, nothing is read and no
    other lease is touched, and a lane that asks again is let in when a place has been released or its thread evicted.
    a child that was read and did not fit is refused too, without a read, until the room it needs could exist: what the
    stage and the leases leave of the byte cap, which grows when a lease is released, an opened thread is evicted, or
    the stage changes */
function holdFor(work: Work, state: SyncState, key: string, at: number): SyncState {
  const held = state.threads[key];
  if (held) return held.openedAt > 0 ? state : lease(work, state, key, true, at);
  if (state.cold[key]) return lease(work, state, key, true, at);
  const all = placedOf(state.threads, state.cold);
  const heldOnly = all.filter((t) => t.openedAt === 0);
  if (heldOnly.length >= HELD_CAP && heldOnly.every((t) => t.leased)) return state;
  const measured = state.unfit[key];
  if (measured !== undefined && immovableBytes(all, key) + measured > BYTE_CAP) return state;
  const thread = fresh(work, key, 0, at, true);
  const room = makeRoom(work, state, { ...state.threads, [key]: thread }, state.cold, key);
  if (room.threads[key]) {
    work.effects.push({ type: "hydrate", key, hydration: thread.hydration });
    work.patch(["threads", key], viewOf(thread));
  }
  return { ...state, ...room };
}

function release(work: Work, state: SyncState, key: string): SyncState {
  return lease(work, state, key, false, 0);
}

/** leases a held-only thread's place (a hold: `at` is when it was held), or frees it (a release: the thread stays, and
    is first to be evicted). an opened thread keeps its recency whatever is held or released */
function lease(work: Work, state: SyncState, key: string, leased: boolean, at: number): SyncState {
  const thread = state.threads[key];
  const head = state.cold[key];
  const holder = thread ?? head;
  if (!holder || holder.openedAt > 0) return state;
  const heldAt = leased ? at : holder.heldAt;
  if (holder.leased === leased && holder.heldAt === heldAt) return state;
  // the time is saved with the head; the lease is not
  if (holder.heldAt !== heldAt) work.effects.push({ type: "head", key });
  if (thread) return { ...state, threads: { ...state.threads, [key]: { ...thread, leased, heldAt } } };
  return { ...state, cold: { ...state.cold, [key]: { ...(head as Cold), leased, heldAt } } }; // holder was the head
}

/** a cold thread's pages came back: it is a thread in memory again, as the cache saved it. one the journal passed while it
    was cold, or that was mid-read when it was saved, is read again, showing what it had meanwhile. its read number is a
    new one either way: the saved one is from another life of the page, and a number is never used twice for a key */
function restored(work: Work, state: SyncState, action: Extract<Action, { type: "restored" }>): SyncState {
  const head = state.cold[action.key];
  if (!head || state.threads[action.key]) return state;
  const { [action.key]: _restored, ...cold } = state.cold;
  const again = !action.messages || head.stale || head.status === "hydrating";
  let thread: Thread = {
    key: head.key,
    status: head.status,
    hydration: again ? head.hydration : work.nextRead(),
    upstreamEpoch: head.upstreamEpoch,
    hydratedAt: head.hydratedAt,
    lastUpstream: head.lastUpstream,
    messages: action.messages ?? [],
    baseline: action.messages ? head.baseline : {},
    buffer: [],
    bufferBytes: 0,
    refetching: Object.fromEntries(head.refetching.map((id) => [id, []])),
    heldBytes: 0,
    openedAt: head.openedAt,
    heldAt: head.heldAt,
    leased: head.leased,
    bytes: action.messages ? (action.bytes ?? head.bytes) : 0,
    trouble: null,
  };
  if (again) {
    thread = rehydrate(work, thread);
  } else {
    for (const messageID of head.refetching) work.effects.push({ type: "refetch", key: head.key, messageID, hydration: thread.hydration });
  }
  work.patch(["threads", head.key], viewOf(thread));
  // a head with no size counted for nothing until now, so its pages may be what passes a cap
  return { ...state, ...makeRoom(work, state, { ...state.threads, [head.key]: thread }, cold, head.key) };
}

type Placed = { key: string; openedAt: number; heldAt: number; leased: boolean; bytes: number; cold: boolean };

const placedOf = (threads: Record<string, Thread>, cold: Record<string, Cold>): Placed[] => [
  ...Object.values(threads).map((t) => ({ key: t.key, openedAt: t.openedAt, heldAt: t.heldAt, leased: t.leased, bytes: t.bytes, cold: false })),
  ...Object.values(cold).map((c) => ({ key: c.key, openedAt: c.openedAt, heldAt: c.heldAt, leased: c.leased, bytes: c.bytes, cold: true })),
];

const totalBytes = (state: Pick<SyncState, "threads" | "cold">): number =>
  Object.values(state.threads).reduce((n, t) => n + t.bytes, 0) + Object.values(state.cold).reduce((n, c) => n + c.bytes, 0);

/** the thread on stage: the one the person opened last */
const stageOf = (all: readonly Placed[]): Placed | undefined => all.reduce<Placed | undefined>((best, t) => (t.openedAt > (best?.openedAt ?? 0) ? t : best), undefined);

/** the bytes a held-only thread cannot take room from: the thread on stage and every lease that is not `except` */
function immovableBytes(all: readonly Placed[], except: string | null): number {
  const stage = stageOf(all);
  return all.reduce((n, t) => (t.key !== except && (t.key === stage?.key || (t.openedAt === 0 && t.leased)) ? n + t.bytes : n), 0);
}

const forget = (unfit: Record<string, number>, key: string): Record<string, number> => {
  if (!(key in unfit)) return unfit;
  const { [key]: _gone, ...rest } = unfit;
  return rest;
};

/** notes the size a held-only thread measured when it did not fit; at most UNFIT_CAP are kept, the oldest note first to go */
function remember(unfit: Record<string, number>, key: string, bytes: number): Record<string, number> {
  const next = { ...forget(unfit, key), [key]: bytes };
  for (const old of Object.keys(next)) {
    if (Object.keys(next).length <= UNFIT_CAP) break;
    delete next[old];
  }
  return next;
}

/** evicts until the set fits its caps (reducer.ts header, and architecture.md's indexeddb layout):
    - opened threads: at most THREAD_CAP, the one opened longest ago first;
    - held-only threads: at most HELD_CAP beside them, released ones first, then the one held longest ago (a hold that
      would pass the cap with every place leased is refused before it gets here, so this only ever takes released ones);
    - everything: at most BYTE_CAP. held-only threads go first (released ones, then the longest held), then opened ones,
      longest ago first, except the thread the open or read is for (`keep`) and the one opened last, which is the one on
      stage.
    when `keep` is a held-only thread (a child's read, or its growth) it may take room from released held threads and
    from opened threads that are not on stage, never from another lease, and if that is not enough it is the one that
    goes (`unfit`), alone and before anything is evicted for it, with its size noted so a hold for it is not read again
    until the room could exist. an opened thread is never evicted for a hold's count, only for the bytes a hold that can
    fit needs; a lease is taken by the bytes only for an open the person made, or the stage's own growth */
function makeRoom(
  work: Work,
  state: SyncState,
  threads: Record<string, Thread>,
  cold: Record<string, Cold>,
  keep: string | null,
): Pick<SyncState, "threads" | "cold" | "unfit"> {
  const all = placedOf(threads, cold);
  let bytes = all.reduce((sum, t) => sum + t.bytes, 0);
  // released places before leased ones, the held longest ago first among each
  const heldOnly = all.filter((t) => t.openedAt === 0).sort((a, b) => Number(a.leased) - Number(b.leased) || a.heldAt - b.heldAt);
  const opened = all.filter((t) => t.openedAt > 0).sort((a, b) => a.openedAt - b.openedAt);
  if (opened.length <= THREAD_CAP && heldOnly.length <= HELD_CAP && bytes <= BYTE_CAP) return { threads, cold, unfit: state.unfit };
  const nextThreads = { ...threads };
  const nextCold = { ...cold };
  let unfit = state.unfit;
  const gone = new Set<string>();
  const evict = (victim: Placed, cap: Cap) => {
    gone.add(victim.key);
    bytes -= victim.bytes;
    if (victim.cold) {
      delete nextCold[victim.key];
    } else {
      delete nextThreads[victim.key];
      work.patch(["threads", victim.key], undefined);
    }
    work.effects.push({ type: "evicted", key: victim.key, bytes: victim.bytes, opened: victim.openedAt > 0, cap });
  };
  const evictable = (list: Placed[], protectedKeys: readonly (string | null | undefined)[] = [keep]) => list.filter((t) => !gone.has(t.key) && !protectedKeys.includes(t.key));
  const kept = all.find((t) => t.key === keep);
  const child = kept !== undefined && kept.openedAt === 0;
  if (kept && child && immovableBytes(all, keep) + kept.bytes > BYTE_CAP) {
    evict(kept, "unfit");
    return { threads: nextThreads, cold: nextCold, unfit: remember(unfit, kept.key, kept.bytes) };
  }
  let heldCount = heldOnly.length;
  for (const victim of evictable(heldOnly)) {
    if (heldCount <= HELD_CAP) break;
    evict(victim, "held");
    heldCount--;
  }
  let openedCount = opened.length;
  for (const victim of evictable(opened)) {
    if (openedCount <= THREAD_CAP) break;
    evict(victim, "opened");
    openedCount--;
  }
  const stage = stageOf(all)?.key;
  // a child's room is the released held threads and the opened ones off stage: the check above made sure that is enough
  const heldPool = evictable(heldOnly).filter((t) => !child || !t.leased);
  for (const victim of [...heldPool, ...evictable(opened, [keep, stage])]) {
    if (bytes <= BYTE_CAP) break;
    evict(victim, "bytes");
  }
  return { threads: nextThreads, cold: nextCold, unfit };
}

function hydrated(work: Work, state: SyncState, action: Extract<Action, { type: "hydrated" }>): SyncState {
  const held = state.threads[action.key];
  if (!held || held.status !== "hydrating" || held.hydration !== action.hydration) return state;
  let thread: Thread = {
    ...held,
    status: "live",
    upstreamEpoch: action.upstreamEpoch,
    hydratedAt: action.at,
    lastUpstream: action.at,
    messages: action.messages,
    baseline: baselineOf(action.messages),
    buffer: [],
    bufferBytes: 0,
    refetching: {},
    heldBytes: 0,
    bytes: action.bytes ?? sizeOf(action.messages),
    trouble: null,
  };
  work.patch(["threads", action.key], viewOf(thread));
  for (const buffered of held.buffer) thread = threadEntry(work, thread, buffered);
  // the read may be what passes the byte cap
  const room = makeRoom(work, state, { ...state.threads, [action.key]: thread }, state.cold, action.key);
  // a child that fit now has no size to be refused for
  return { ...state, ...room, unfit: room.threads[action.key] ? forget(room.unfit, action.key) : room.unfit };
}

/** a try of the thread's current read failed: it is said once per change, so a read failing the same way each try sends
    nothing new. an answer for a read that is no longer the thread's is ignored */
function readFailed(work: Work, state: SyncState, action: Extract<Action, { type: "read-failed" }>): SyncState {
  const held = state.threads[action.key];
  if (!held || held.status !== "hydrating" || held.hydration !== action.hydration) return state;
  if (held.trouble?.gone === action.trouble.gone && held.trouble.problem === action.trouble.problem) return state;
  work.patch(["threads", action.key, "trouble"], action.trouble);
  return { ...state, threads: { ...state.threads, [action.key]: { ...held, trouble: action.trouble } } };
}

/** the read starts over now: the one out is dropped (its number is no longer the thread's), and what it buffered with it,
    since the new read is newer than all of it. the trouble stays until a read lands */
function reread(work: Work, state: SyncState, key: string): SyncState {
  const held = state.threads[key];
  if (held?.status !== "hydrating") return state;
  return { ...state, threads: { ...state.threads, [key]: rehydrate(work, held) } };
}

function refetched(work: Work, state: SyncState, action: Extract<Action, { type: "refetched" }>): SyncState {
  const held = state.threads[action.key];
  // an answer for a thread that was evicted since, or read again since, is not the answer to a refetch of this one
  if (held?.hydration !== action.hydration) return state;
  const waiting = held.refetching[action.messageID];
  if (!waiting) return state;
  const { [action.messageID]: _done, ...refetching } = held.refetching;
  let thread: Thread = { ...held, refetching, heldBytes: (held.heldBytes ?? 0) - listBytes(waiting) };
  if (action.message !== null) {
    thread = mergeMessage(work, thread, action.message);
    thread = { ...thread, baseline: baselineOf([action.message], thread.baseline) };
    // a thread that passed the held cap meanwhile is being read again whole, which covers what is left
    for (const entry of waiting) if (thread.hydration === held.hydration) thread = reapply(work, thread, action.messageID, entry);
  }
  return { ...state, threads: { ...state.threads, [action.key]: thread } };
}

/** the snapshot over what the thread holds: its parts replace the held ones with their ids (unless that would
    shorten text already applied), and parts it lacks, which cmx2 0.8.3's in-flight read does for reasoning and
    tools, stay where they are */
function mergeMessage(work: Work, thread: Thread, snapshot: Message): Thread {
  const at = messageIndex(thread, snapshot.info.id);
  const messages = [...thread.messages];
  if (at < 0) {
    messages.push(snapshot);
    work.patch(["threads", thread.key, "messages", messages.length - 1], snapshot);
    return grown({ ...thread, messages }, messageBytes(snapshot));
  }
  const before = messages[at] as Message; // at came from findIndex on this array
  const parts = [...before.parts];
  let by = jsonWeight(snapshot.info) - jsonWeight(before.info);
  for (const part of snapshot.parts) {
    const index = parts.findIndex((p) => p.id === part.id);
    if (index < 0) {
      parts.splice(placeBefore(parts, part.id), 0, part);
      by += partBytes(part);
    } else if (textLength(parts[index] as Part, "text") <= textLength(part, "text")) {
      by += partBytes(part) - partBytes(parts[index] as Part);
      parts[index] = part;
    }
  }
  const next: Message = { info: snapshot.info, parts };
  messages[at] = next;
  work.patch(["threads", thread.key, "messages", at], next);
  return grown({ ...thread, messages }, by);
}

/** one entry that waited for a snapshot. a gap that reopens the refetch holds everything after it for the next answer */
function reapply(work: Work, thread: Thread, messageID: string, entry: Held): Thread {
  if (holding(thread, messageID)) return hold(work, thread, messageID, entry);
  switch (entry.kind) {
    case "info":
      return upsertInfo(work, thread, entry.info);
    case "part":
      return applyPart(work, thread, entry.part, entry.resumed);
    case "delta":
      return delta(work, thread, entry.frame);
    default:
      return unreachable(entry);
  }
}

/* —— the patch queue —— */

/** the paths a backwards pass has met, one level per segment. `set`: a later patch set the value here, so earlier ones
    here and below are overwritten; `revived` when that set gave it a value; `slot`: where in the output that value is;
    `settled` once nothing earlier at this path can matter (a delete before the set was kept); `run`: the place of a later
    append at this path still open to merge */
type Seen = { set: boolean; revived: boolean; settled: boolean; slot: number; run: number; next: Map<string, Seen> | null };

const seen = (): Seen => ({ set: false, revived: false, settled: false, slot: -1, run: -1, next: null });

/** where a key sits in its object is decided when it is created: a set alone leaves it where it is, a delete and a set
    move it to the end. inside a session entry (`changed` adds and deletes keys there) a value set twice lands where the
    first set put the key, and the last delete before a set is kept, so the ui's keys read in the worker's order.
    shallower paths (a session, an ask, a thread) coalesce as they always did: the ui drops a thread's caches on its
    delete, and the fleet's maps keep the order they had */
const KEEPS_ORDER = 4;

/** drops every patch a later set overwrites (the same path or a prefix of it), keeping order, and joins the appends to one
    path into one, or into the set before them. the worker calls it once per frame, so a burst of deltas becomes one append;
    the ui calls it again over what waits for its frame. a segment is matched by its string, so 3 and "3" are one */
export function coalesce(patches: readonly Patch[]): Patch[] {
  const root = seen();
  const kept: Array<Patch | null> = [];
  for (let i = patches.length - 1; i >= 0; i--) {
    const patch = patches[i] as Patch; // i is inside the array
    let node = root;
    let overwritten = false;
    let depth = 0;
    for (const segment of patch.path) {
      const name = String(segment);
      let child = node.next?.get(name);
      if (!child) {
        child = seen();
        (node.next ??= new Map()).set(name, child);
      }
      node = child;
      depth++;
      if (node.set) {
        overwritten = true;
        break;
      }
    }
    if (overwritten) {
      if (depth === patch.path.length && patch.path.length >= KEEPS_ORDER && node.revived && !node.settled) settle(kept, node, patch);
      continue;
    }
    const later = node.run >= 0 ? (kept[node.run] as AppendPatch) : null; // a run is only ever an append's place
    if (isAppend(patch)) {
      if (!later) {
        node.run = kept.length;
        kept.push(patch);
      } else if (later.from < patch.from) {
        // the later one rewrote from before this one began: this one changes nothing it leaves
      } else {
        // each append starts where the text ends (the worker sends no other), so the later one starts where this one ends
        const keep = later.from - patch.from;
        const head = keep >= patch.append.length ? patch.append : patch.append.slice(0, Math.max(0, keep));
        // the joined append takes the earlier one's place, which is where a missing text would have been created
        kept[node.run] = null;
        node.run = kept.length;
        kept.push({ path: patch.path, append: head + later.append, from: patch.from });
      }
      continue;
    }
    // an empty path is a no-op for the store, and overwrites nothing
    if (patch.path.length === 0) {
      kept.push(patch);
      continue;
    }
    node.set = true;
    if (later) {
      // the set and the appends after it become one set in the set's place, where it may have created the key; after a
      // delete the key is created by the first append, so the set stays in that append's place
      const value: Patch = { path: patch.path, value: appended(patch.value, later) };
      if (patch.value === undefined) {
        kept[node.run] = value;
        node.slot = node.run;
      } else {
        kept[node.run] = null;
        node.slot = kept.length;
        kept.push(value);
      }
      node.revived = true;
      if (patch.value === undefined && patch.path.length >= KEEPS_ORDER) settle(kept, node, patch);
    } else {
      node.slot = kept.length;
      kept.push(patch);
      node.revived = patch.value !== undefined;
    }
  }
  const out: Patch[] = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    const patch = kept[i];
    if (patch) out.push(patch);
  }
  return out;
}

/** an earlier patch at a path whose value a later set gives: a delete is kept (the key moves to the end, as applying each
    in turn moves it) and nothing before it matters; a set or an append may be what created the key, so the value moves
    back to its place */
function settle(kept: Array<Patch | null>, node: Seen, earlier: Patch): void {
  if (!isAppend(earlier) && earlier.value === undefined) {
    kept.push(earlier);
    node.settled = true;
    return;
  }
  const value = kept[node.slot] ?? null;
  kept[node.slot] = null;
  node.slot = kept.length;
  kept.push(value);
}
