/* the wire between the server, the worker and the ui, replayed on protocol 3 (docs/protocol.md, section 16): the recorded
   journal (server/goldens/protocol3/journal.sse.gz, every entry, overview and transcript), then what it lacks (a field
   unset and set again in thread patches, a thread removed with the order patched past it, a message removed, and a long
   streamed answer settled by its whole part, which the server journals as `textOf`), published by a simulated protocol
   3 server (fixtures/server.ts, `JournalServer`) and read through the real reducer the way the worker runs it
   (sync/worker.ts: what the page shows becomes the interest, posted and confirmed in-band; reads go out with the confirm
   and are answered as the journal built the thread, stamped with the head and the upstream; patches for the threads the
   ui shows pile up, are coalesced and posted, held by the page gate while the page is hidden, and land through the
   landing and the store's own apply).

   a seeded schedule mixes, on one clock: reads and refetches answered at once or late, from a source at or ahead of the
   journal; switches home, A, B over A (holding C), home, A, B, home, A, entering with and without `since`; a hidden
   spell past 30 s and its return; connections lost and dialled again from the cursor; protocol errors injected (a patch
   for a thread nobody holds, an order patch out of range) and the reset that recovers them; a delta lost on the wire
   (its settled part's hash misses and the message is read again).

   what it checks, every tick: the ui's store equals the worker's state it mirrors at every apply; every thread in the
   confirmed interest whose read or catch-up has landed holds exactly the server's whole read at the journal position
   the client has reached (nothing doubled, nothing missing); and at the end, the fleet equals the server's and every
   thread in interest equals the server's thread. the schedule is fixed by the seed, so two builds see the same apply
   points and compare by a digest. */

import { unwrap } from "solid-js/store";
import { applyPatches, setStream, state as ui } from "../../store";
import { CATCH_UP_MS } from "../../ui/caught-up";
import { PageGate } from "../gate";
import { Landing } from "../landing";
import type { FromWorker, StreamStatus } from "../messages";
import type { Entry, Fault, Frame, FleetSnapshot, Message, Reset } from "../protocol";
import { formatCursor, parseCursor, routeFrame } from "../protocol";
import { PatchQueue } from "../queue";
import { type Action, coalesce, type Fleet, fleetOf, INITIAL_STATE, type Patch, reduce, streamQuery, type SyncState, type Thread, viewOf } from "../reducer";
import { type Compaction, JournalServer, type Queued, type SimStream } from "./server";
import { parseTape } from "./saves";

/** one frame of a tape: its sse id (null when it had none) and its data */
export type Recorded = { id: string | null; frame: Frame };
/** one entry of the replay's journal, with its id */
export type Step = { id: string; frame: Entry };

export type Faults = Record<Fault, number>;

export type Replay = {
  /** the ui's store matched the worker at every apply, or the first apply where it did not */
  mismatch: string | null;
  /** every thread in interest whose read or catch-up had landed held the server's read at the client's position, or the
      first time one did not */
  exact: string | null;
  applies: number;
  /** posts from the worker and the patches and json characters they carried */
  posts: number;
  patches: number;
  bytes: number;
  /** time spent in the ui's apply, ms */
  applyMs: number;
  /** what the run went through, so a test can say it covered it */
  seen: {
    ticks: number;
    /** frames the client read, and the stream's bytes */
    frames: number;
    streamBytes: number;
    /** entries the server skipped for a stream (other threads' transcripts) */
    skipped: number;
    switches: number;
    dials: number;
    drops: number;
    resets: number;
    caughts: number;
    posts: number;
    confirms: number;
    catchups: number;
    stale: number;
    reads: number;
    notModified: number;
    refetches: number;
    hidden: number;
    cooled: number;
    restored: number;
    injected: number;
    recovered: number;
    lost: number;
    /** exactly-once comparisons made */
    checks: number;
    /** interest keys entered with a `since` and without one */
    sinceKeys: number;
    readKeys: number;
  };
  /** `sync.fault` by what */
  faults: Faults;
  /** the end: the client's fleet and the server's, and each thread in interest, the client's messages and the server's */
  fleet: { client: Omit<Fleet, "colours">; server: Omit<Fleet, "colours"> };
  threads: Record<string, { client: Message[]; server: Message[] }>;
  /** a digest of the ui's fleet and threads at every apply, chained */
  uiDigest: string;
  /** a digest of the worker's final state */
  workerDigest: string;
  /** how many times the ui's caught-up second ran out, and the first time it did with the store behind */
  caughtUps: number;
  behind: string | null;
  /** the ui's store equals the worker's state at the end */
  endsEqual: boolean;
};

/** how the run lands what the worker posts while the page is hidden:
    - `gate`: the worker holds it and posts it in one message when the page is shown (gate.ts), landed in one go (landing.ts);
    - `separate`: held the same, but posted one message at a time when the page is shown (the status after the patches);
    - `naive`: posted as always, and the ui holds a hidden page's patches for a second while the status lands at once (the
      queue that was reverted for racing the caught-up second) */
export type Mode = "gate" | "separate" | "naive";

export type Options = {
  mode?: Mode;
  /** how the server's catch-ups carry a thread's transcript */
  compaction?: Compaction;
  /** how far back the server's ring reaches, in seqs */
  ring?: number;
  /** inject the protocol errors, lose a delta, lose connections, hide the page past 30 s (all on by default) */
  faults?: boolean;
  lose?: boolean;
  drops?: boolean;
  hidden?: boolean;
  /** reads and refetches may be answered by a source ahead of the journal */
  ahead?: boolean;
  /** B's first read is started at once and answered only once B has left interest and come back with its `since` (or
      after this many ticks): its answer began before B entered again, and is refused (read-late) */
  slow?: number;
};

/** each tick of the replay is this long on the run's clock */
const TICK_MS = 20;
/** the furthest behind the worker the store may be when the caught-up second runs out: a post waits up to six ticks and
    the ui's frame up to three posts, so what the worker made by this long before the deadline has landed */
const SLACK_MS = 18 * TICK_MS + 40;
/** the reverted ui's wait for a hidden page's patches */
const NAIVE_HOLD_MS = 1000;
/** the worker's wait before a hidden page asks for the overview only (worker.ts, HIDDEN_AFTER_MS) */
const HIDDEN_AFTER_MS = 30_000;

/** a chained digest, which the caller supplies (node's crypto in the tests): this file is built with the app */
export type Hasher = { update(text: string): void; digest(): string };

/** a small seeded generator, so every run of a seed sees the same schedule */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** the frames of a protocol 3 tape's text (server/goldens/protocol3/*.sse, unzipped by the caller) */
export function journal(text: string): Recorded[] {
  return parseTape(text);
}

const isEntry = (frame: Frame): frame is Entry => "seq" in frame && frame.type !== "reset" && frame.type !== "caught" && frame.type !== "interest";

/** the threads with the most transcript entries in the journal, busiest first: the replay's A, B and C */
export function cast(steps: readonly Recorded[]): [string, string, string] {
  const counts = new Map<string, number>();
  for (const { frame } of steps) if (frame.type === "message" || frame.type === "part" || frame.type === "delta") counts.set(frame.key, (counts.get(frame.key) ?? 0) + 1);
  const busiest = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  if (busiest.length < 3) throw new Error("the journal has fewer than three threads with transcripts");
  return busiest.slice(0, 3) as [string, string, string];
}

/** the journal's entries, then the cases it lacks, then a long answer of `length` characters in A (deltas of 8 to 40
    characters, a tail put every eighth carrying its last 280, settled by its whole part), numbered as one journal */
export function scenario(recorded: readonly Recorded[], length: number): Step[] {
  const entries: Entry[] = recorded.map((r) => r.frame).filter(isEntry);
  const epoch = parseCursor([...recorded].reverse().find((r) => r.id !== null)?.id)?.epoch;
  if (!epoch) throw new Error("the journal ends without a cursor");
  const [A, B] = cast(recorded);
  let upstream = 0;
  const threads = new Map<string, Extract<Entry, { type: "thread" }>["thread"]>();
  let order: string[] = [];
  const firstOf = new Map<string, string>();
  for (const entry of entries) {
    if ("upstream" in entry && typeof entry.upstream === "number") upstream = Math.max(upstream, entry.upstream);
    if (entry.type === "thread") threads.set(entry.thread.key, entry.thread);
    if (entry.type === "thread.removed") threads.delete(entry.key);
    if (entry.type === "thread.patch") {
      const base = threads.get(entry.key);
      if (base) {
        const tail = entry.tail ? base.tail.slice(entry.tail.drop) : base.tail;
        if (entry.tail) for (const [i, item] of entry.tail.put) tail[i] = item;
        const next: Record<string, unknown> = { ...base, tail };
        for (const [name, value] of Object.entries(entry.set ?? {})) if (value !== null && value !== undefined) next[name] = value;
        for (const name of entry.unset ?? []) delete next[name];
        threads.set(entry.key, next as typeof base);
      }
    }
    if (entry.type === "order") order = entry.keys;
    if (entry.type === "order.patch") {
      for (const op of entry.ops) {
        if (op[0] === "-") order.splice(op[1], op[2]);
        else order.splice(op[1], 0, ...op[2]);
      }
      order = [...order];
    }
    if (entry.type === "message" && !firstOf.has(entry.key)) firstOf.set(entry.key, entry.message.id);
  }
  const added: Record<string, unknown>[] = [];
  const push = (frame: Record<string, unknown>) => added.push(frame);
  const working = threads.get(A);
  if (!working) throw new Error(`the journal does not hold ${A}`);

  // a field unset and set again, three times: the client's copy loses the key and gets it back at the end of the object
  const effort = working.effort ?? "medium";
  for (let round = 0; round < 3; round++) {
    push({ type: "thread.patch", key: A, unset: ["effort"] });
    push({ type: "thread.patch", key: A, set: { effort } });
  }
  // a thread removed, and the order patched past it
  const gone = order.find((k) => k !== A && k !== B && threads.has(k) && !firstOf.has(k));
  if (!gone) throw new Error("the order holds no idle thread to remove");
  push({ type: "thread.removed", key: gone });
  push({ type: "order.patch", ops: [["-", order.indexOf(gone), 1]] });
  // a message removed from B
  const first = firstOf.get(B);
  if (!first) throw new Error(`${B} has no message`);
  push({ type: "message.removed", key: B, upstream: ++upstream, messageID: first });

  // the long answer in A, streamed and settled
  const id = working.id;
  const messageID = `msg_${id.slice(4)}_long`;
  const partID = `prt_${id.slice(4)}_long_0`;
  const created = working.updated + 1000;
  const info = { id: messageID, role: "assistant", created, model: working.model ?? null, effort };
  push({ type: "thread.patch", key: A, set: { activity: { state: "busy", since: created } } });
  push({ type: "message", key: A, upstream: ++upstream, message: info });
  push({ type: "part", key: A, upstream: ++upstream, part: { type: "text", id: partID, messageID, at: { step: 99, index: 0 }, text: "", streaming: true, time: { start: created } } });
  const random = seeded(7);
  const words = "the ledger keeps every invoice by its number and the migration moves them in order, checking each total twice ";
  let text = "";
  let deltas = 0;
  let tail = [...working.tail];
  while (text.length < length) {
    const size = 8 + Math.floor(random() * 33);
    const start = text.length % words.length;
    const piece = (words + words).slice(start, start + size);
    push({ type: "delta", key: A, messageID, partID, field: "text", delta: piece, offset: text.length });
    text += piece;
    if (++deltas % 8 === 0) {
      const item = { partID, messageID, kind: "text", role: "assistant", text: text.slice(-280) } as (typeof tail)[number];
      const at = tail.findIndex((t) => t.partID === partID);
      if (at >= 0) {
        tail[at] = item;
        push({ type: "thread.patch", key: A, tail: { drop: 0, put: [[at, item]] } });
      } else {
        const drop = tail.length >= 12 ? 1 : 0;
        tail = tail.slice(drop);
        tail.push(item);
        push({ type: "thread.patch", key: A, tail: { drop, put: [[tail.length - 1, item]] } });
      }
    }
  }
  const end = created + 60_000;
  push({ type: "part", key: A, upstream: ++upstream, part: { type: "text", id: partID, messageID, at: { step: 99, index: 0 }, text, time: { start: created, end } } });
  push({ type: "message", key: A, upstream: ++upstream, message: { ...info, completed: end, finish: "stop" } });
  push({ type: "thread.patch", key: A, set: { activity: { state: "idle" }, updated: end } });

  // one numbering for all of it, as the server's journal
  let seq = 0;
  return [...entries, ...(added as unknown as Entry[])].map((entry) => {
    seq++;
    const { seq: _old, ...rest } = entry as Entry & { seq?: number };
    return { id: `${epoch}:${seq}`, frame: { seq, ...rest } as Entry };
  });
}

/* —— the schedule —— */

type View = { thread: string | null; under: string[]; holds: string[] };

const HOME: View = { thread: null, under: [], holds: [] };

type Event =
  | { kind: "view"; view: View }
  | { kind: "drop"; redial: number }
  | { kind: "hide"; long: boolean; ticks: number }
  | { kind: "fault"; what: "thread.patch" | "order.patch" }
  | { kind: "cool"; key: string };

/** the seeded schedule: views at anchors through the journal (by its seqs), jittered; the hidden spell inside the long
    answer; drops and the protocol errors at random */
function schedule(steps: readonly Step[], random: () => number, options: Required<Pick<Options, "faults" | "drops" | "hidden">>): Map<number, Event[]> {
  const [A, B, C] = cast(steps);
  const last = steps.length;
  const tape = steps.findIndex((s) => s.frame.type === "thread.patch" && s.frame.unset !== undefined);
  const at = (from: number, to: number) => Math.round(from + random() * (to - from));
  const events = new Map<number, Event[]>();
  const add = (tick: number, event: Event) => events.set(tick, [...(events.get(tick) ?? []), event]);
  const views: Array<[number, View]> = [
    [at(150, 260), { thread: A, under: [], holds: [] }],
    [at(330, 380), { thread: B, under: [A], holds: [C] }],
    [at(430, 500), HOME],
    [at(520, 590), { thread: A, under: [], holds: [] }],
    [at(620, 700), { thread: B, under: [A], holds: [C] }],
    [at(720, 900), HOME],
    [at(1000, 1400), { thread: A, under: [], holds: [] }],
    [at(1500, 1900), { thread: B, under: [], holds: [C] }],
    [at(2000, 2400), HOME],
    [at(tape - 120, tape - 20), { thread: A, under: [], holds: [] }],
  ];
  for (const [tick, view] of views) add(tick, { kind: "view", view });
  // C goes cold while nobody shows it, between B's two spells
  add(at(1420, 1480), { kind: "cool", key: C });
  if (options.hidden) {
    // past 30 s inside the long answer, and a short one somewhere before it
    add(at(tape + 150, tape + 300), { kind: "hide", long: true, ticks: at(120, 300) });
    add(at(1000, 2400), { kind: "hide", long: false, ticks: at(5, 40) });
  }
  if (options.drops) for (let i = 0; i < 4; i++) add(at(200, last - 50), { kind: "drop", redial: at(1, 25) });
  if (options.faults) {
    add(at(2000, tape - 150), { kind: "fault", what: random() < 0.5 ? "thread.patch" : "order.patch" });
    add(at(700, 1900), { kind: "fault", what: random() < 0.5 ? "order.patch" : "thread.patch" });
  }
  return events;
}

/** a value's json with its object keys sorted, for a comparison where key order is not the point */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_name, v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

/** the worker's count of the changes it had made when it posted: a patch at its own path, which a coalesce keeps the last
    of, so the store holds the newest count it was given */
const PROBE = "probe";
const probeOf = (): number => Number((unwrap(ui) as unknown as Record<string, unknown>)[PROBE] ?? 0);

/** the fleet's json for the comparison: each thread, ask and agent with its keys in order (a key unset and set again goes to
    the end, as the store does it), the maps by key (the store keeps a map's keys where they were when a coalesce joins a
    delete and a set of one entry, reducer.ts `KEEPS_ORDER`), the lists as they are */
function fleetJson(fleet: Fleet): string {
  const byKey = (map: Record<string, unknown>) => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([fleet.agentNames, fleet.order, byKey(fleet.agents), byKey(fleet.threads), byKey(fleet.asks), byKey(fleet.colours)]);
}

const withoutColours = ({ colours: _, ...rest }: Fleet): Omit<Fleet, "colours"> => rest;

const keysOf = (view: { thread: string | null; under: readonly string[]; holds: readonly string[] }): string[] => [...(view.thread === null ? [] : [view.thread]), ...view.under, ...view.holds];

export function replayWire(steps: readonly Step[], hasher: () => Hasher, seed = 1, options: Options = {}): Replay {
  const mode = options.mode ?? "gate";
  const flags = { faults: options.faults ?? true, lose: options.lose ?? true, drops: options.drops ?? true, hidden: options.hidden ?? true, ahead: options.ahead ?? true };
  applyPatches([{ path: ["fleet"], value: structuredClone(INITIAL_STATE.fleet) }, { path: ["threads"], value: {} }, { path: [PROBE], value: undefined }]);
  setStream({ state: "connecting", since: 0, lastEventAt: null });
  const random = seeded(seed);
  const server = new JournalServer(
    steps.map((s) => s.frame),
    { epoch: parseCursor(steps[0]?.id)?.epoch ?? "EPOCH", compaction: options.compaction ?? "compact", ...(options.ring === undefined ? {} : { ring: options.ring }) },
  );
  const events = schedule(steps, random, flags);
  const [A, B] = cast(steps);
  let slowed = false;
  const result: Replay = {
    mismatch: null,
    exact: null,
    applies: 0,
    posts: 0,
    patches: 0,
    bytes: 0,
    applyMs: 0,
    seen: { ticks: 0, frames: 0, streamBytes: 0, skipped: 0, switches: 0, dials: 0, drops: 0, resets: 0, caughts: 0, posts: 0, confirms: 0, catchups: 0, stale: 0, reads: 0, notModified: 0, refetches: 0, hidden: 0, cooled: 0, restored: 0, injected: 0, recovered: 0, lost: 0, checks: 0, sinceKeys: 0, readKeys: 0 },
    faults: { "patch-error": 0, "read-late": 0, "hash-miss": 0, "catchup-error": 0 },
    fleet: { client: withoutColours(INITIAL_STATE.fleet), server: withoutColours(INITIAL_STATE.fleet) },
    threads: {},
    uiDigest: "",
    workerDigest: "",
    caughtUps: 0,
    behind: null,
    endsEqual: false,
  };
  const chain = hasher();

  /* —— the worker: its state, what the page shows, its reads, its connection —— */
  let worker: SyncState = INITIAL_STATE;
  let tick = 0;
  let now = 0;
  let clock = 0;
  let stage: string | null = null;
  const held = new Set<string>();
  const shown = new Set<string>();
  const openedAt = new Map<string, number>();
  let away = false;
  /** the cache's copy of a cooled thread's pages */
  const cache = new Map<string, Message[]>();
  const fetching = new Set<string>();
  /** requests on their way: each runs at its tick */
  const later: Array<{ due: number; run: () => void }> = [];
  /** the journal position each thread's newest landed answer reflects: it is exact only once the stream has passed it */
  const answeredAt = new Map<string, number>();
  /** a thread whose delta was lost, until a read or refetch of the message lands */
  const suspect = new Map<string, { messageID: string; seq: number }>();
  let conn = null as { stream: SimStream; caught: boolean } | null;
  const queuedFrames = () => conn?.stream.queue.length ?? 0;
  /** the position the client has read the journal to: the head when the last frame it read was queued */
  let position = 0;
  let redialAt: number | null = 0;
  let reconnectNow = false;
  let faulted = 0;
  let pending: Patch[] = [];
  /** the delta the wire loses: the long answer's last, which only its settled part's hash can tell is missing */
  const lostSeq = flags.lose ? [...steps].reverse().find((s) => s.frame.type === "delta" && s.frame.key === A)?.frame.seq : undefined;

  const later_ = (delay: number, run: () => void) => later.push({ due: tick + delay, run });
  const delay = () => (random() < 0.15 ? 20 + Math.floor(random() * 40) : Math.floor(random() * 8));
  const ahead = () => (flags.ahead && random() < 0.3 ? 1 + Math.floor(random() * 3) : 0);

  /* —— the page, its clock, the channel, its frames and its timers —— */
  let pageHidden = false;
  const made: number[] = [];
  const channel: FromWorker[] = [];
  const frames: Array<{ handle: number; run: () => void }> = [];
  let handles = 0;
  let caughtUpAt = null as { due: number; since: number } | null;
  let naive = null as { queue: PatchQueue; due: number } | null;
  let taking = false;
  const gate = new PageGate((message) => {
    if (mode === "separate" && message.type === "held") channel.push(...message.messages);
    else channel.push(message);
  });
  const status = (stream: StreamStatus) => {
    setStream(stream);
    caughtUpAt = stream.state === "live" ? { due: Math.max(now, stream.since + CATCH_UP_MS), since: stream.since } : null;
  };
  const landing = new Landing({
    hidden: () => pageHidden,
    frame: (run) => {
      frames.push({ handle: ++handles, run });
      return handles;
    },
    cancel: (handle) => {
      const at = frames.findIndex((f) => f.handle === handle);
      if (at >= 0) frames.splice(at, 1);
    },
    apply: (patches) => applyAndCheck(patches),
    stream: status,
  });
  const timers = () => {
    if (naive && naive.due <= now) {
      const queued = naive.queue.take();
      naive = null;
      applyAndCheck(queued);
    }
    const timer = caughtUpAt;
    if (!timer || timer.due > now) return;
    caughtUpAt = null;
    result.caughtUps++;
    const deadline = timer.since + CATCH_UP_MS - SLACK_MS;
    let needed = 0;
    while (needed < made.length && (made[needed] as number) <= deadline) needed++;
    if (result.behind === null && probeOf() < needed) result.behind = `caught up at ${now} ms with the store at change ${probeOf()} of the ${needed} made by ${deadline} ms`;
  };
  const deliver = () => {
    timers();
    while (channel.length > 0) {
      const message = channel.shift() as FromWorker; // the channel is not empty
      if (message.type === "patches" && mode === "naive" && pageHidden) {
        naive ??= { queue: new PatchQueue(), due: now + NAIVE_HOLD_MS };
        naive.queue.push(message.patches);
      } else if (message.type === "patches" || message.type === "stream" || message.type === "held") {
        taking = true;
        landing.take(message);
        taking = false;
        if (message.type === "held") compare();
      }
      timers();
    }
  };
  const runFrames = () => {
    for (const frame of frames.splice(0)) frame.run();
  };
  const uiJson = (): string => fleetJson(unwrap(ui.fleet));
  const uiThreads = (): string => canonical(unwrap(ui.threads));
  const mirrorThreads = (): string => {
    const threads: Record<string, unknown> = {};
    for (const key of shown) {
      const thread = worker.threads[key];
      if (thread) threads[key] = viewOf(thread);
    }
    return canonical(threads);
  };
  const applyAndCheck = (patches: Patch[]) => {
    if (patches.length === 0) return;
    const started = performance.now();
    applyPatches(patches);
    result.applyMs += performance.now() - started;
    result.applies++;
    const fleet = uiJson();
    const threads = uiThreads();
    chain.update(fleet);
    chain.update(threads);
    // inside one landing of held messages the first applies are not yet everything (landing.ts, `held`)
    if (!taking) compare(fleet, threads);
  };
  /** the ui's store against the worker, once everything posted has landed */
  const compare = (fleet = uiJson(), threads = uiThreads()) => {
    const settled = pending.length === 0 && channel.length === 0 && !gate.waiting && !landing.waiting && naive === null;
    if (result.mismatch !== null || !settled) return;
    if (fleet !== fleetJson(worker.fleet)) result.mismatch = `apply ${result.applies}, tick ${tick}: the fleet, ${fleetDiffer(unwrap(ui.fleet), worker.fleet)}`;
    else if (threads !== mirrorThreads()) result.mismatch = `apply ${result.applies}, tick ${tick}: the threads`;
  };
  const post = () => {
    if (pending.length === 0) return;
    const patches = coalesce(pending);
    pending = [];
    result.posts++;
    result.patches += patches.length;
    result.bytes += JSON.stringify(patches).length;
    // postMessage hands the ui a copy: the store mutates what it is given in place, never the worker's state
    gate.send({ type: "patches", patches: [...structuredClone(patches), { path: [PROBE], value: made.length }] });
  };

  /* —— the worker's dispatch and effects (worker.ts `dispatch`, `run`, `toUi`) —— */
  const toUi = (patches: readonly Patch[]) => {
    for (const patch of patches) {
      const [top, key] = patch.path;
      if (top === "threads" && typeof key === "string" && !shown.has(key)) continue;
      pending.push(patch);
    }
  };
  const dispatch = (action: Action) => {
    const reduced = reduce(worker, action);
    worker = reduced.state;
    toUi(reduced.patches);
    if (reduced.patches.length > 0) made.push(now);
    for (const effect of reduced.effects) {
      switch (effect.type) {
        case "reconnect":
          reconnectNow = true;
          break;
        case "hydrate":
          read(effect.key, effect.hydration);
          break;
        case "refetch":
          refetch(effect.key, effect.messageID, effect.hydration);
          break;
        case "fault":
          result.faults[effect.what]++;
          break;
        case "interest-changed": {
          const { stream, post: body } = effect;
          result.seen.posts++;
          for (const key of keysOf(body)) if (!keysOf(worker.interest.confirmed).includes(key)) result.seen[body.since?.[key] === undefined ? "readKeys" : "sinceKeys"]++;
          later_(Math.floor(random() * 4), () => {
            if (server.post(stream, body) === 404 && worker.interest.stream === stream) {
              reconnectNow = true;
              hangUp();
            }
          });
          break;
        }
        case "confirmed":
          result.seen.confirms++;
          break;
        default:
          break;
      }
    }
  };

  /** worker.ts `hydrate`: the read goes out, reaches the server some ticks later (which starts it at its head), and its answer
      lands some ticks after that; an answer for a read that is no longer the thread's is dropped */
  const read = (key: string, hydration: number) => {
    const job = `hydrate ${key} ${hydration}`;
    if (fetching.has(job)) return;
    fetching.add(job);
    const etag = worker.threads[key]?.etag;
    const wanted = () => worker.threads[key]?.hydration === hydration;
    const slow = options.slow !== undefined && key === B && !slowed;
    if (slow) slowed = true;
    later_(slow ? 0 : delay(), () => {
      if (!wanted()) return void fetching.delete(job);
      const answer = server.read(key, etag, ahead());
      result.seen.reads++;
      const until = tick + (options.slow ?? 0);
      const land = () => {
        if (slow && tick < until && wanted() && answer !== null && (worker.interest.entered[key] ?? 0) <= answer.seq) return later_(1, land);
        fetching.delete(job);
        const thread = worker.threads[key];
        if (!thread || thread.hydration !== hydration) return;
        if (answer === null) return dispatch({ type: "read-failed", key, hydration, trouble: { gone: true, problem: null } });
        if (answer.status === 304) result.seen.notModified++;
        const messages = answer.messages === null ? thread.messages : structuredClone(answer.messages);
        answeredAt.set(key, Math.max(answeredAt.get(key) ?? 0, answer.at));
        dispatch({ type: "hydrated", key, hydration, upstreamEpoch: "u1", at: answer.upstream, seq: answer.seq, messages, etag: answer.etag });
        const lost = suspect.get(key);
        if (lost && worker.threads[key]?.status === "live" && answer.at >= lost.seq) suspect.delete(key);
      };
      later_(slow ? 1 : delay(), land);
    });
  };

  /** worker.ts `refetch`: one message, asked while the thread still waits on it */
  const refetch = (key: string, messageID: string, hydration: number) => {
    const job = `refetch ${key} ${hydration} ${messageID}`;
    if (fetching.has(job)) return;
    fetching.add(job);
    result.seen.refetches++;
    const wanted = () => worker.threads[key]?.hydration === hydration && worker.threads[key]?.refetching[messageID] !== undefined;
    later_(delay(), () => {
      if (!wanted()) return void fetching.delete(job);
      const answer = server.message(key, messageID, ahead());
      later_(delay(), () => {
        fetching.delete(job);
        if (!wanted()) return;
        answeredAt.set(key, Math.max(answeredAt.get(key) ?? 0, answer.at));
        dispatch({ type: "refetched", key, hydration, messageID, message: structuredClone(answer.message) });
        if (suspect.get(key)?.messageID === messageID) suspect.delete(key);
      });
    });
  };

  /* —— what the page shows (worker.ts `view`, `want`, `open`, `hold`, `release`, `show`, `hide`) —— */
  const viewNow = (): View => {
    if (away) return HOME;
    const holds = [...held].filter((key) => key !== stage);
    const opened = (key: string) => openedAt.get(key) ?? 0;
    const under = [...shown].filter((key) => key !== stage && !held.has(key) && openedAt.has(key)).sort((a, b) => opened(a) - opened(b));
    return { thread: stage, under, holds };
  };
  const want = () => dispatch({ type: "want", ...viewNow() });
  const restore = (key: string) => {
    const copy = cache.get(key);
    if (!worker.cold[key]) return;
    result.seen.restored++;
    dispatch({ type: "restored", key, messages: copy ? structuredClone(copy) : null });
  };
  const open = (key: string) => {
    stage = key;
    const at = ++clock;
    openedAt.set(key, at);
    want();
    dispatch({ type: "open", key, at });
    restore(key);
  };
  const hold = (key: string) => {
    held.add(key);
    want();
    dispatch({ type: "hold", key, at: ++clock });
    restore(key);
  };
  const release = (key: string) => {
    held.delete(key);
    dispatch({ type: "release", key });
    want();
  };
  const show = (key: string) => {
    if (shown.has(key)) return;
    shown.add(key);
    want();
    const thread = worker.threads[key];
    if (thread) pending.push({ path: ["threads", key], value: viewOf(thread) });
    else restore(key);
  };
  const hide = (key: string) => {
    if (!shown.delete(key)) return;
    if (stage === key) stage = null;
    want();
    pending.push({ path: ["threads", key], value: undefined, closed: true });
  };
  /** the page goes to `view`: what it no longer shows is let go of (holds released, layers hidden from the top), then the
      stage opens and shows, then its children are held and shown */
  const switchTo = (view: View) => {
    result.seen.switches++;
    const keep = new Set(keysOf(view));
    for (const key of [...held]) if (!view.holds.includes(key)) release(key);
    for (const key of [...shown].reverse()) if (!keep.has(key)) hide(key);
    for (const key of view.under) if (!shown.has(key)) {
      open(key);
      show(key);
    }
    if (view.thread !== null && (stage !== view.thread || !shown.has(view.thread))) {
      open(view.thread);
      show(view.thread);
    }
    for (const key of view.holds) {
      if (!held.has(key)) hold(key);
      show(key);
    }
  };
  /** the worker's sweep for one thread nobody shows: its pages saved as memory holds them, it goes cold */
  const coolOne = (key: string) => {
    const thread = worker.threads[key];
    if (!thread || shown.has(key) || thread.status !== "live" || Object.keys(thread.refetching).length > 0 || thread.leased) return;
    cache.set(key, structuredClone(thread.messages));
    result.seen.cooled++;
    dispatch({ type: "cool", threads: { [key]: 1 } });
  };

  /* —— the connection (worker.ts `streamLoop`, `onFrame`, `reset`, `ended`) —— */
  const dial = () => {
    redialAt = null;
    result.seen.dials++;
    const stream = server.dial(streamQuery(worker), worker.cursor ? formatCursor(worker.cursor) : null);
    conn = { stream, caught: false };
  };
  const hangUp = () => {
    if (!conn) return;
    server.close(conn.stream.id);
    conn = null;
    dispatch({ type: "dropped" });
    gate.send({ type: "stream", stream: { state: "down", since: now, lastEventAt: null } });
    redialAt = tick + (reconnectNow ? 0 : 1 + Math.floor(random() * 20));
    reconnectNow = false;
  };
  const onFrame = (queued: Queued) => {
    result.seen.frames++;
    result.seen.streamBytes += queued.data.length;
    const routed = routeFrame(queued.data, false);
    if (!routed) return;
    const id = parseCursor(queued.id);
    if (routed.to === "skip") {
      if (id) dispatch({ type: "skipped", id });
      return;
    }
    if (routed.to === "broken") return dispatch({ type: "broken", what: routed.what });
    if (routed.to !== "journal") return;
    const frame = routed.frame;
    if (frame.type === "hello") gate.send({ type: "stream", stream: { state: "live", since: now, lastEventAt: null } });
    if (frame.type === "reset") return resetFrame(frame, id);
    dispatch({ type: "frame", frame, id });
    if (frame.type === "caught" && conn) {
      conn.caught = true;
      result.seen.caughts++;
    }
  };
  const resetFrame = (frame: Reset, id: ReturnType<typeof parseCursor>) => {
    // the threads nobody shows whose pages the cache would hold as memory does go cold and stale
    const cool: Record<string, number> = {};
    for (const [key, thread] of Object.entries(worker.threads)) {
      if (shown.has(key) || thread.status !== "live" || Object.keys(thread.refetching).length > 0) continue;
      cache.set(key, structuredClone(thread.messages));
      cool[key] = 1;
    }
    result.seen.resets++;
    dispatch({ type: "frame", frame, id, cool });
    if (conn) conn.caught = true;
    if (faulted > 0 && worker.cursor !== null) {
      result.seen.recovered += faulted;
      faulted = 0;
    }
  };
  /** reads up to `count` frames of the connection; the lost delta is not among them */
  const read_ = (count: number) => {
    for (let i = 0; i < count && conn; i++) {
      const queued = conn.stream.queue.shift();
      if (!queued) return;
      position = Math.max(position, queued.at);
      if (lostSeq !== undefined && queued.id === `${server.epoch}:${lostSeq}`) {
        const entry = JSON.parse(queued.data) as Entry;
        if (entry.type === "delta" && !suspect.has(entry.key)) {
          result.seen.lost++;
          suspect.set(entry.key, { messageID: entry.messageID, seq: entry.seq });
          continue;
        }
      }
      onFrame(queued);
      if (reconnectNow) return;
    }
  };
  /** a frame that cannot apply, as a broken server would send it next */
  const inject = (what: "thread.patch" | "order.patch") => {
    if (!conn?.caught || worker.cursor === null) return;
    const seq = worker.cursor.seq + 1;
    const bad = what === "thread.patch" ? { seq, type: "thread.patch", key: "bench:ses_nobody_holds", set: { title: "never" } } : { seq, type: "order.patch", ops: [["-", worker.fleet.order.length + 5, 1]] };
    result.seen.injected++;
    faulted++;
    onFrame({ id: `${server.epoch}:${seq}`, data: JSON.stringify(bad), at: position });
  };

  /** the exactly-once check: with the stream caught up and no post unconfirmed, every thread in the confirmed interest whose
      read or catch-up has landed (live, nothing fetched again, no `left`) holds the server's read at the client's position */
  const check = () => {
    if (!conn?.caught || worker.interest.posts.length > 0 || worker.cursor === null) return;
    for (const key of keysOf(worker.interest.confirmed)) {
      const thread = worker.threads[key];
      if (!current(key, thread) || (answeredAt.get(key) ?? 0) > position) continue;
      result.seen.checks++;
      if (result.exact !== null) continue;
      const expected = server.readAt(key, position);
      if (canonical(thread.messages) !== canonical(expected)) result.exact = `tick ${tick}, ${key} at ${position}: ${differ(thread.messages, expected)}`;
    }
  };
  const current = (key: string, thread: Thread | undefined): thread is Thread => !!thread && thread.status === "live" && Object.keys(thread.refetching).length === 0 && thread.left === undefined && !suspect.has(key);

  /* —— the run —— */
  let untilPost = 1;
  let untilApply = 1;
  let hiddenUntil = -1;
  let longHidden = false;
  const end = steps.length + 400;
  for (tick = 1; tick <= end || later.length > 0 || queuedFrames() > 0; tick++) {
    if (tick > end + 5000) throw new Error("the replay does not settle");
    now += TICK_MS;
    // the journal moves on, one entry a tick, so the schedule's ticks are the journal's seqs
    if (!server.done) server.publish();
    // the schedule
    for (const event of events.get(tick) ?? []) {
      switch (event.kind) {
        case "view":
          switchTo(event.view);
          break;
        case "drop":
          if (conn) {
            result.seen.drops++;
            hangUp();
            redialAt = tick + event.redial;
          }
          break;
        case "hide":
          if (pageHidden) break;
          result.seen.hidden++;
          pageHidden = true;
          if (mode !== "naive") gate.setHidden(true);
          hiddenUntil = tick + event.ticks;
          longHidden = event.long;
          if (event.long) {
            // the worker's 30 s timer: the clock jumps past it, and the stream asks for the overview only
            now += HIDDEN_AFTER_MS;
            away = true;
            want();
            // and the connection drops while it is hidden: the stream goes live again and its catch-up follows, held
            events.set(tick + 20, [...(events.get(tick + 20) ?? []), { kind: "drop", redial: 3 }]);
          }
          break;
        case "fault":
          inject(event.what);
          break;
        case "cool":
          coolOne(event.key);
          break;
      }
    }
    if (tick === hiddenUntil) {
      pageHidden = false;
      if (mode !== "naive") gate.setHidden(false);
      if (naive) naive.due = now;
      if (longHidden) {
        away = false;
        want();
      }
    }
    // requests that are due
    for (const one of later.filter((l) => l.due <= tick)) {
      later.splice(later.indexOf(one), 1);
      one.run();
    }
    // the connection
    if (!conn && redialAt !== null && tick >= redialAt) dial();
    if (conn) read_(random() < 0.2 ? Number.POSITIVE_INFINITY : Math.floor(random() * 5));
    if (reconnectNow) {
      hangUp();
      if (redialAt !== null && redialAt <= tick) dial();
    }
    check();
    deliver();
    if (--untilPost > 0) continue;
    untilPost = 1 + Math.floor(random() * 6);
    post();
    deliver();
    if (pageHidden || --untilApply > 0) continue;
    untilApply = 1 + Math.floor(random() * 3);
    runFrames();
  }
  result.seen.ticks = tick;
  post();
  pageHidden = false;
  gate.setHidden(false);
  now += NAIVE_HOLD_MS + CATCH_UP_MS;
  deliver();
  runFrames();
  landing.now();

  result.endsEqual = uiJson() === fleetJson(worker.fleet) && uiThreads() === mirrorThreads();
  result.seen.catchups = server.sent.catchups;
  result.seen.stale = server.sent.stale;
  result.seen.skipped = server.sent.skipped;
  result.fleet = { client: withoutColours(worker.fleet), server: withoutColours(fleetOf(server.snapshot() as FleetSnapshot)) };
  for (const key of keysOf(worker.interest.confirmed)) {
    result.threads[key] = { client: worker.threads[key]?.messages ?? [], server: server.readAt(key, server.head) };
  }
  result.uiDigest = chain.digest();
  const final = hasher();
  final.update(JSON.stringify(worker, (name, value: unknown) => (name === "bufferBytes" || name === "heldBytes" ? undefined : value)));
  result.workerDigest = final.digest();
  return result;
}

/** where the ui's fleet first differs from the worker's, briefly */
function fleetDiffer(ui: Fleet, worker: Fleet): string {
  for (const name of Object.keys(worker) as (keyof Fleet)[]) {
    const a = ui[name] as unknown;
    const b = worker[name] as unknown;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (typeof b !== "object" || b === null || Array.isArray(b)) return `${name}: ${JSON.stringify(a).slice(0, 300)} / ${JSON.stringify(b).slice(0, 300)}`;
    const ak = Object.keys(a as object);
    const bk = Object.keys(b);
    if ([...ak].sort().join() !== [...bk].sort().join()) return `${name}: keys differ ${ak.length} / ${bk.length}, first at ${ak.findIndex((k, i) => bk[i] !== k)}: ${ak.find((k, i) => bk[i] !== k)} / ${bk.find((k, i) => ak[i] !== k)}`;
    for (const key of bk) {
      const x = JSON.stringify((a as Record<string, unknown>)[key]);
      const y = JSON.stringify((b as Record<string, unknown>)[key]);
      if (x !== y) {
        let at = 0;
        while (at < x.length && x[at] === y[at]) at++;
        return `${name}.${key} from ${at}: ${x.slice(Math.max(0, at - 80), at + 200)} / ${y.slice(Math.max(0, at - 80), at + 200)}`;
      }
    }
  }
  return "(order of the fleet's own keys)";
}

/** where two transcripts first differ, briefly */
function differ(held: readonly Message[], server: readonly Message[]): string {
  if (held.length !== server.length) return `${held.length} messages held, the server has ${server.length} (${held.map((m) => m.info.id.slice(-6)).join(",")} / ${server.map((m) => m.info.id.slice(-6)).join(",")})`;
  for (let i = 0; i < held.length; i++) {
    const a = held[i] as Message;
    const b = server[i] as Message;
    if (canonical(a.info) !== canonical(b.info)) return `message ${i} (${a.info.id}) info differs`;
    if (a.parts.length !== b.parts.length) return `message ${i} (${a.info.id}) holds ${a.parts.length} parts, the server ${b.parts.length}`;
    for (let j = 0; j < a.parts.length; j++) if (canonical(a.parts[j]) !== canonical(b.parts[j])) return `message ${i} part ${j} (${(a.parts[j] as { id: string }).id}): ${canonical(a.parts[j]).slice(0, 200)} / ${canonical(b.parts[j]).slice(0, 200)}`;
  }
  return "the same";
}
