/* a fake boxbox server for the worker's tests, behind a fetch it installs: `GET /api/stream` (a stream the test writes
   frames into, in the sse framing the server uses), the thread reads (`/api/agents/{agent}/threads/{thread}/messages`,
   with their seq, upstream and etag stamps and a 304 for a matching If-None-Match), and interest posts, answered 202 and
   confirmed in-band on the stream at the head, as the fleet actor does (docs/protocol.md, interest). wire fixtures only:
   the integration tests run against a real server.

   below it, `JournalServer`: a protocol 3 server simulated over a recorded journal, for the wire replays
   (fixtures/wire-replay.ts). it publishes the journal one entry at a time; each stream gets the overview entries and the
   transcript entries of its interest only (so its seqs skip); an interest post swaps the filter at the head and answers
   with the entering keys' catch-up and the confirm; a dial with a cursor gets the compact catch-up and `caught`, one
   without (or of another epoch) a reset; reads answer a thread as the journal built it, stamped with the head and the
   upstream it reflects; and it journals a settled text part whose text its deltas built as `textOf` (D7). */

import { placeBefore } from "../order";
import type { Agent, Ask, Entry, FleetSnapshot, Interest, InterestPost, Message, MessageInfo, Part, Thread, ThreadEntry } from "../protocol";
import { isTranscript, parseCursor, textOf } from "../protocol";

export type Dial = { url: string; headers: Record<string, string>; signal: AbortSignal; at: number; push(frame: unknown, id?: string): void; raw(text: string): void };

export type Post = { url: string; body: { ask: number; thread: string | null; under: string[]; holds: string[]; since?: Record<string, number> } };

export type Read = { url: string; key: string; headers: Record<string, string> };

export type FakeServer = {
  epoch: string;
  stream: string;
  /** the journal head: every id pushed with this epoch moves it, and reads and confirms are stamped with it */
  head: number;
  dials: Dial[];
  reads: Read[];
  posts: Post[];
  /** the telemetry rows the worker sent */
  rows: { kind: string; props: Record<string, unknown> }[];
  /** what a thread's read answers: its messages, null for a 404 */
  transcript: (key: string) => Message[] | null;
  /** the etag a thread's read carries, none by default */
  etag: (key: string) => string | undefined;
  /** the status an interest post answers; 202 confirms it on the stream */
  postStatus: number;
  /** extra frames before the confirm of a post (catch-up frames) */
  beforeConfirm: (post: Post["body"]) => unknown[];
  /** writes to the newest dial */
  push(frame: unknown, id?: string): void;
  hello(interest?: { thread: string | null; under: string[]; holds: string[] }): void;
  restore(): void;
};

const encoder = new TextEncoder();

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => (out[name] = value));
  return out;
}

export function fakeServer(onDial: (dial: Dial, server: FakeServer) => void = () => {}): FakeServer {
  const saved = globalThis.fetch;
  const server: FakeServer = {
    epoch: "j1",
    stream: "5c1f0e7a5b2d4c66a1e3f00b7d2c9a41",
    head: 0,
    dials: [],
    reads: [],
    posts: [],
    rows: [],
    transcript: () => [],
    etag: () => undefined,
    postStatus: 202,
    beforeConfirm: () => [],
    push: (frame, id) => server.dials.at(-1)?.push(frame, id),
    hello: (interest = { thread: null, under: [], holds: [] }) =>
      server.push({ type: "hello", protocol: 3, epoch: server.epoch, head: server.head, build: "test", stream: server.stream, interest }),
    restore: () => {
      globalThis.fetch = saved;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/telemetry")) {
      server.rows.push(...(JSON.parse(String(init?.body)) as { events: FakeServer["rows"] }).events);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("/api/stream/") && url.endsWith("/interest")) {
      const body = JSON.parse(String(init?.body)) as Post["body"];
      server.posts.push({ url, body });
      if (server.postStatus === 202) {
        // the confirm travels behind what is queued, at the head when the actor took the post
        queueMicrotask(() => {
          for (const frame of server.beforeConfirm(body)) server.push(frame);
          server.push({ type: "interest", ask: body.ask, thread: body.thread, under: body.under, holds: body.holds, seq: server.head }, `${server.epoch}:${server.head}`);
        });
      }
      return new Response(null, { status: server.postStatus });
    }
    if (url.startsWith("/api/stream")) {
      const signal = init?.signal ?? new AbortController().signal;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      signal.addEventListener("abort", () => controller?.error(new DOMException("aborted", "AbortError")), { once: true });
      const raw = (text: string) => {
        if (!signal.aborted) controller?.enqueue(encoder.encode(text));
      };
      const dial: Dial = {
        url,
        headers: headersOf(init),
        signal,
        at: performance.now(),
        raw,
        push: (frame, id) => {
          if (id?.startsWith(`${server.epoch}:`)) server.head = Math.max(server.head, Number(id.slice(server.epoch.length + 1)));
          raw(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(frame)}\n\n`);
        },
      };
      server.dials.push(dial);
      onDial(dial, server);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const read = /^\/api\/agents\/([^/]+)\/threads\/([^/]+)\/messages$/.exec(url);
    if (read) {
      const key = `${decodeURIComponent(read[1] ?? "")}:${decodeURIComponent(read[2] ?? "")}`;
      const headers = headersOf(init);
      server.reads.push({ url, key, headers });
      const messages = server.transcript(key);
      if (messages === null) return new Response(null, { status: 404 });
      const etag = server.etag(key);
      const stamps: Record<string, string> = { "x-boxbox-seq": `${server.epoch}:${server.head}`, "x-boxbox-upstream": "u1:50", "content-type": "application/json", ...(etag ? { etag } : {}) };
      if (etag && headers["if-none-match"] === etag) return new Response(null, { status: 304, headers: stamps });
      return new Response(JSON.stringify({ messages, older: null, total: messages.length, turns: 1 }), { status: 200, headers: stamps });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return server;
}

/* —— a protocol 3 server simulated over a journal (the wire replays) —— */

/** one frame a stream carries: its id line (null for none), its data line, and the journal head when it was queued (the
    position a client that has read it stands at) */
export type Queued = { id: string | null; data: string; at: number };

export type SimStream = { id: string; interest: Interest; ask: number; queue: Queued[]; open: boolean };

/** what a thread read answers: 304 when the etag sent is the thread's version at the read's position */
export type SimRead = { status: 200 | 304; seq: number; upstream: number; etag: string; at: number; messages: Message[] | null };

/** how a catch-up's transcript goes: `compact` by section 9's rule as the server's catchup.rs writes it (each message and
    part in the order it first appeared after `since`, a message's last `message` in its place), or `raw` (every entry
    after `since`, in seq order) */
export type Compaction = "compact" | "raw";

export type JournalOptions = {
  epoch?: string;
  /** how many seqs back the ring reaches: a `since` further behind the head comes back `thread.stale` */
  ring?: number;
  /** the raw bytes of catch-up one thread may take before it comes back `thread.stale` (1 MiB) */
  cap?: number;
  compaction?: Compaction;
};

/** the raw bytes of one `catchup` frame, at most (docs/protocol.md, section 3) */
const CATCHUP_FRAME = 256 * 1024;

const inSet = (interest: Interest, key: string) => interest.thread === key || interest.under.includes(key) || interest.holds.includes(key);
const keysIn = (interest: Interest) => [...(interest.thread === null ? [] : [interest.thread]), ...interest.under, ...interest.holds];

type Held = { info: MessageInfo; parts: Part[] };

const field = (value: unknown, name: string): unknown => (value as Record<string, unknown>)[name];
const isText = (part: Part) => part.type === "text" || part.type === "reasoning";

/** D7, as the server journals a part (docs/protocol.md, finished text sent once): per text or reasoning part the text its
    deltas built, from offset 0 or the last whole part; a part whose text is that text, after at least one delta, goes with
    `textOf` and no `text`. entries the source already sent that way stay as they are */
export function settleText(entries: readonly Entry[]): Entry[] {
  const built = new Map<string, { text: string; deltas: number }>();
  return entries.map((entry) => {
    if (entry.type === "delta") {
      const had = built.get(entry.partID) ?? { text: "", deltas: 0 };
      built.set(entry.partID, { text: had.text.slice(0, entry.offset) + entry.delta, deltas: had.deltas + 1 });
      return entry;
    }
    if (entry.type !== "part" || !isText(entry.part)) return entry;
    const text = field(entry.part, "text");
    if (typeof text !== "string") return entry;
    const had = built.get(entry.part.id);
    built.set(entry.part.id, { text, deltas: 0 });
    if (!had || had.deltas === 0 || had.text !== text) return entry;
    const { text: _text, ...rest } = entry.part as Record<string, unknown>;
    return { ...entry, part: { ...rest, textOf: textOf(text) } as Part };
  });
}

/** one transcript entry applied to a thread as the source holds it: a message's info replaces the one held, a part
    replaces its id's or takes its place (a settled one keeps the text its deltas built), a delta writes at its offset, a
    removal drops the message, reactions set on its info */
function applyTranscript(messages: Map<string, Held>, entry: ThreadEntry): void {
  switch (entry.type) {
    case "message": {
      const held = messages.get(entry.message.id);
      messages.set(entry.message.id, { info: entry.message, parts: held?.parts ?? [] });
      return;
    }
    case "part": {
      const held = messages.get(entry.part.messageID);
      if (!held) return;
      const parts = [...held.parts];
      const at = parts.findIndex((p) => p.id === entry.part.id);
      let part = entry.part;
      if (typeof field(part, "textOf") === "object" && typeof field(part, "text") !== "string") {
        const { textOf: _of, ...rest } = part as Record<string, unknown>;
        part = { ...rest, text: at >= 0 ? (field(parts[at], "text") ?? "") : "" } as Part;
      }
      if (at >= 0) parts[at] = part;
      else parts.splice(placeBefore(parts, part), 0, part);
      messages.set(held.info.id, { info: held.info, parts });
      return;
    }
    case "delta": {
      const held = messages.get(entry.messageID);
      if (!held) return;
      const parts = [...held.parts];
      const at = parts.findIndex((p) => p.id === entry.partID);
      if (at < 0) {
        if (entry.offset !== 0) return;
        const born = { id: entry.partID, messageID: entry.messageID, type: "text", text: entry.delta, streaming: true } as Part;
        parts.splice(placeBefore(parts, born), 0, born);
      } else {
        const had = field(parts[at], entry.field);
        parts[at] = { ...parts[at], [entry.field]: (typeof had === "string" ? had : "").slice(0, entry.offset) + entry.delta } as Part;
      }
      messages.set(held.info.id, { info: held.info, parts });
      return;
    }
    case "message.removed":
      messages.delete(entry.messageID);
      return;
    case "reactions": {
      const held = messages.get(entry.messageID);
      if (held) messages.set(held.info.id, { info: { ...held.info, reactions: entry.reactions }, parts: held.parts });
      return;
    }
  }
}

/** a thread's entries after a `since`, compacted (docs/protocol.md, section 9; server/src/fleet/catchup.rs): per message its
    last `message`, per part its newest text-carrying `part`, the deltas after it merged while they chain, then its last
    `part` when that one settles it, then the deltas after that merged; a removal drops every earlier entry of its
    message; reactions the last per message. slots go out in the order their message or part first appeared */
export function compactEntries(entries: readonly ThreadEntry[]): ThreadEntry[] {
  type Slot = { group: string; message: string; entries: ThreadEntry[] };
  const slots: (Slot | null)[] = [];
  const open = new Map<string, number>();
  for (const entry of entries) {
    let group: string;
    let message: string;
    switch (entry.type) {
      case "message":
        group = `m:${entry.message.id}`;
        message = entry.message.id;
        break;
      case "reactions":
        group = `r:${entry.messageID}`;
        message = entry.messageID;
        break;
      case "part":
        group = `p:${entry.part.id}`;
        message = entry.part.messageID;
        break;
      case "delta":
        group = `p:${entry.partID}`;
        message = entry.messageID;
        break;
      case "message.removed":
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          if (slot && slot.message === entry.messageID) {
            open.delete(slot.group);
            slots[i] = null;
          }
        }
        group = `x:${entry.messageID}`;
        message = entry.messageID;
        break;
    }
    const at = open.get(group);
    const slot = at === undefined ? null : slots[at];
    if (slot) {
      if (entry.type === "part" || entry.type === "delta") slot.entries.push(entry);
      else slot.entries = [entry];
    } else {
      open.set(group, slots.length);
      slots.push({ group, message, entries: [entry] });
    }
  }
  const out: ThreadEntry[] = [];
  for (const slot of slots) if (slot) out.push(...(slot.group.startsWith("p:") ? compactPart(slot.entries) : slot.entries));
  return out;
}

const carriesText = (entry: ThreadEntry) => entry.type === "part" && isText(entry.part) && typeof field(entry.part, "text") === "string";
const settles = (entry: ThreadEntry) => entry.type === "part" && isText(entry.part) && typeof field(entry.part, "text") !== "string" && typeof field(entry.part, "textOf") === "object";

function compactPart(entries: ThreadEntry[]): ThreadEntry[] {
  let last = -1;
  let text = -1;
  entries.forEach((e, i) => {
    if (e.type === "part") last = i;
    if (carriesText(e)) text = i;
  });
  if (last < 0) return mergeDeltas(entries);
  const deltas = (from: number, to: number) => mergeDeltas(entries.slice(from, to).filter((e) => e.type === "delta"));
  const end = entries.length;
  const settled = settles(entries[last] as ThreadEntry);
  if (text >= 0 && text !== last && settled) return [entries[text] as ThreadEntry, ...deltas(text + 1, last), entries[last] as ThreadEntry, ...deltas(last + 1, end)];
  if (text < 0 && settled) return [...deltas(0, last), entries[last] as ThreadEntry, ...deltas(last + 1, end)];
  return [entries[last] as ThreadEntry, ...deltas(last + 1, end)];
}

/** deltas merged while they chain (an offset at the run's end), each run keeping the seq of its last delta */
function mergeDeltas(entries: readonly ThreadEntry[]): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  for (const entry of entries) {
    const run = out.at(-1);
    if (run?.type === "delta" && entry.type === "delta" && run.partID === entry.partID && run.field === entry.field && entry.offset === run.offset + run.delta.length) {
      out[out.length - 1] = { ...run, delta: run.delta + entry.delta, seq: entry.seq };
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** a thread patch on the base the server journaled it against: set fields that have a value, unset the absent ones, the
    tail's drop then puts (docs/protocol.md, section 6) */
function patched(base: Thread, patch: Extract<Entry, { type: "thread.patch" }>): Thread {
  const next: Record<string, unknown> = { ...base };
  if (patch.tail) {
    const tail = base.tail.slice(patch.tail.drop);
    for (const [index, item] of patch.tail.put) tail[index] = item;
    next["tail"] = tail;
  }
  for (const [name, value] of Object.entries(patch.set ?? {})) if (value !== null && value !== undefined) next[name] = value;
  for (const name of patch.unset ?? []) delete next[name];
  return next as Thread;
}

function reordered(base: readonly string[], ops: Extract<Entry, { type: "order.patch" }>["ops"]): string[] {
  const next = [...base];
  for (const op of ops) {
    if (op[0] === "-") next.splice(op[1], op[2]);
    else next.splice(op[1], 0, ...op[2]);
  }
  return next;
}

/** per overview key, the newest entry for it: what a catch-up from a cursor sends whole, or its tombstone */
type Touched = { seq: number; gone: Entry | null; raised: number };

export class JournalServer {
  readonly epoch: string;
  readonly entries: Entry[];
  /** the seq of the last entry published */
  head = 0;
  readonly streams = new Map<string, SimStream>();
  private next = 0;
  private streamCount = 0;
  private readonly ring: number;
  private readonly cap: number;
  private readonly compaction: Compaction;
  private readonly agents = new Map<string, Agent>();
  private readonly threads = new Map<string, Thread>();
  private readonly asks = new Map<string, Ask>();
  private order: string[] = [];
  private readonly touched = new Map<string, Touched>();
  /** each thread's transcript entries, and the source's upstream seq reached by each journal position */
  private readonly transcripts = new Map<string, ThreadEntry[]>();
  private readonly upstreams: number[] = [];
  private readonly built = new Map<string, { pos: number; index: number; messages: Map<string, Held> }>();
  /** what each stream was sent, for the reports */
  readonly sent = { frames: 0, bytes: 0, catchups: 0, stale: 0, resets: 0, confirms: 0, skipped: 0 };

  constructor(entries: readonly Entry[], options: JournalOptions = {}) {
    this.epoch = options.epoch ?? "EPOCH";
    this.ring = options.ring ?? Number.POSITIVE_INFINITY;
    this.cap = options.cap ?? 1024 * 1024;
    this.compaction = options.compaction ?? "compact";
    this.entries = settleText(entries);
    let upstream = 0;
    for (const entry of this.entries) {
      const up = field(entry, "upstream");
      if (typeof up === "number") upstream = Math.max(upstream, up);
      this.upstreams[entry.seq] = upstream;
      if (isTranscript(entry)) {
        const list = this.transcripts.get(entry.key) ?? [];
        list.push(entry);
        this.transcripts.set(entry.key, list);
      }
    }
  }

  get done(): boolean {
    return this.next >= this.entries.length;
  }

  /** the next entry joins the journal: the fleet takes it, and every stream whose interest shows it queues it */
  publish(): Entry | null {
    const entry = this.entries[this.next++];
    if (!entry) return null;
    this.head = entry.seq;
    this.take(entry);
    const frame: Queued = { id: `${this.epoch}:${entry.seq}`, data: JSON.stringify(entry), at: entry.seq };
    for (const stream of this.streams.values()) {
      if (isTranscript(entry) && !inSet(stream.interest, entry.key)) {
        this.sent.skipped++;
        continue;
      }
      this.queue(stream, frame);
    }
    return entry;
  }

  private take(entry: Entry): void {
    const touch = (key: string, gone: Entry | null) => {
      const was = this.touched.get(key);
      this.touched.set(key, { seq: entry.seq, gone, raised: gone || !was || was.gone ? entry.seq : was.raised });
    };
    switch (entry.type) {
      case "agent":
        this.agents.set(entry.agent.key, entry.agent);
        return touch(`agent:${entry.agent.key}`, null);
      case "agent.removed":
        this.agents.delete(entry.agent);
        return touch(`agent:${entry.agent}`, entry);
      case "thread":
        this.threads.set(entry.thread.key, entry.thread);
        return touch(`thread:${entry.thread.key}`, null);
      case "thread.patch": {
        const base = this.threads.get(entry.key);
        if (!base) throw new Error(`the journal patches ${entry.key}, which it never sent whole`);
        this.threads.set(entry.key, patched(base, entry));
        return touch(`thread:${entry.key}`, null);
      }
      case "thread.removed":
        this.threads.delete(entry.key);
        return touch(`thread:${entry.key}`, entry);
      case "ask":
        this.asks.set(`${entry.ask.agent}:${entry.ask.id}`, entry.ask);
        return touch(`ask:${entry.ask.agent}:${entry.ask.id}`, null);
      case "ask.settled":
        this.asks.delete(`${entry.agent}:${entry.id}`);
        return touch(`ask:${entry.agent}:${entry.id}`, entry);
      case "order":
        this.order = entry.keys;
        return touch("order", null);
      case "order.patch":
        this.order = reordered(this.order, entry.ops);
        return touch("order", null);
      default:
        return;
    }
  }

  private queue(stream: SimStream, frame: Queued): void {
    stream.queue.push(frame);
    this.sent.frames++;
    this.sent.bytes += frame.data.length;
  }

  /** the fleet at the head, as a reset carries it */
  snapshot(): FleetSnapshot {
    return { agents: [...this.agents.values()], threads: [...this.threads.values()], asks: [...this.asks.values()], order: [...this.order] };
  }

  /** a thread as the source holds it once the journal reached `pos` (positions past the head are the source ahead of it) */
  readAt(key: string, pos: number): Message[] {
    const list = this.transcripts.get(key) ?? [];
    let memo = this.built.get(key);
    if (!memo || memo.pos > pos) memo = { pos: 0, index: 0, messages: new Map() };
    while (memo.index < list.length && (list[memo.index] as ThreadEntry).seq <= pos) applyTranscript(memo.messages, list[memo.index++] as ThreadEntry);
    memo.pos = pos;
    this.built.set(key, memo);
    return structuredClone([...memo.messages.values()].map((held) => ({ info: held.info, parts: held.parts })));
  }

  /** the thread's version at a position: the seq of its last transcript entry */
  private version(key: string, pos: number): number {
    let seq = 0;
    for (const entry of this.transcripts.get(key) ?? []) {
      if (entry.seq > pos) break;
      seq = entry.seq;
    }
    return seq;
  }

  private upstreamAt(pos: number): number {
    const last = this.entries.at(-1)?.seq ?? 0;
    return this.upstreams[Math.min(pos, last)] ?? 0;
  }

  private known(key: string): boolean {
    return this.touched.has(`thread:${key}`) || this.transcripts.has(key);
  }

  /** `GET .../messages`: the journal head S when it starts, the thread as the source answers it `ahead` entries later (the
      source may be ahead of the journal), the upstream that answer reflects, its version as an etag; null for a 404 */
  read(key: string, etag: string | undefined, ahead = 0): SimRead | null {
    if (!this.known(key)) return null;
    const seq = this.head;
    const at = Math.min(seq + ahead, this.entries.at(-1)?.seq ?? seq);
    const tag = `"${key}@${this.version(key, at)}"`;
    const upstream = this.upstreamAt(at);
    if (etag === tag) return { status: 304, seq, upstream, etag: tag, at, messages: null };
    return { status: 200, seq, upstream, etag: tag, at, messages: this.readAt(key, at) };
  }

  /** `GET .../messages/{message}`: one message as the source answers it, with the position it reflects */
  message(key: string, id: string, ahead = 0): { at: number; message: Message | null } {
    const at = Math.min(this.head + ahead, this.entries.at(-1)?.seq ?? this.head);
    return { at, message: this.readAt(key, at).find((m) => m.info.id === id) ?? null };
  }

  /** `GET /api/stream` with the interest in its query and the client's cursor (Last-Event-ID): hello, then a reset, or the
      compact catch-up from the cursor and `caught` (docs/protocol.md, section 9) */
  dial(query: Interest & { since: Record<string, number> }, lastEventId: string | null): SimStream {
    const id = (++this.streamCount).toString(16).padStart(32, "0");
    const interest: Interest = { thread: query.thread, under: [...query.under], holds: [...query.holds] };
    const stream: SimStream = { id, interest, ask: 0, queue: [], open: true };
    this.streams.set(id, stream);
    const head = this.head;
    this.queue(stream, { id: null, data: JSON.stringify({ type: "hello", protocol: 3, epoch: this.epoch, head, build: "replay", stream: id, interest }), at: head });
    const cursor = parseCursor(lastEventId);
    if (!cursor || cursor.epoch !== this.epoch || cursor.seq > head) {
      const reason = !cursor ? "none" : cursor.epoch !== this.epoch ? "epoch" : "invalid";
      this.sent.resets++;
      this.queue(stream, { id: `${this.epoch}:${head}`, data: JSON.stringify({ type: "reset", seq: head, epoch: this.epoch, reason, fleet: this.snapshot() }), at: head });
      return stream;
    }
    for (const frame of this.overviewSince(cursor.seq)) this.queue(stream, { id: `${this.epoch}:${frame.seq}`, data: JSON.stringify(frame), at: head });
    const stale: string[] = [];
    for (const key of keysIn(interest)) {
      const since = query.since[key];
      if (since === undefined) continue;
      const caught = this.catchup(key, since, head);
      if (caught === null) stale.push(key);
      else for (const data of caught) this.queue(stream, { id: null, data, at: head });
    }
    for (const key of stale) this.queue(stream, { id: null, data: JSON.stringify({ type: "thread.stale", key }), at: head });
    this.queue(stream, { id: `${this.epoch}:${head}`, data: JSON.stringify({ type: "caught", seq: head }), at: head });
    return stream;
  }

  /** every agent, thread and open ask changed after the cursor, whole, with its newest seq; the removed and settled ones'
      tombstones (an ask raised and settled since is not sent); the order once, whole, if it changed */
  private overviewSince(cursor: number): Entry[] {
    const out: Entry[] = [];
    for (const [name, touched] of this.touched) {
      if (touched.seq <= cursor) continue;
      if (touched.gone) {
        if (name.startsWith("ask:") && touched.raised > cursor) continue;
        out.push(touched.gone);
        continue;
      }
      const seq = touched.seq;
      const key = name.slice(name.indexOf(":") + 1);
      if (name === "order") out.push({ seq, type: "order", keys: [...this.order] });
      else if (name.startsWith("agent:")) out.push({ seq, type: "agent", agent: this.agents.get(key) as Agent });
      else if (name.startsWith("thread:")) out.push({ seq, type: "thread", thread: this.threads.get(key) as Thread });
      else out.push({ seq, type: "ask", ask: this.asks.get(key) as Ask });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** a thread's transcript after `since` up to `head`, as `catchup` frames; null when the ring no longer reaches `since` or
      it is past the cap (`thread.stale`) */
  private catchup(key: string, since: number, head: number): string[] | null {
    if (head - since > this.ring) {
      this.sent.stale++;
      return null;
    }
    const after = (this.transcripts.get(key) ?? []).filter((e) => e.seq > since && e.seq <= head);
    const entries = this.compaction === "compact" ? compactEntries(after) : after;
    const frames: string[] = [];
    let batch: string[] = [];
    let size = 0;
    let total = 0;
    for (const entry of entries) {
      const one = JSON.stringify(entry);
      total += one.length;
      if (total > this.cap) {
        this.sent.stale++;
        return null;
      }
      if (batch.length > 0 && size + one.length > CATCHUP_FRAME) {
        frames.push(`{"type":"catchup","entries":[${batch.join(",")}]}`);
        batch = [];
        size = 0;
      }
      batch.push(one);
      size += one.length;
    }
    if (batch.length > 0) frames.push(`{"type":"catchup","entries":[${batch.join(",")}]}`);
    this.sent.catchups += frames.length;
    return frames;
  }

  /** `POST /api/stream/{stream}/interest`: 404 for a stream that ended; an ask at or below the last applied is answered with
      no confirm; else the filter swaps at the head H and the stream queues the entering keys' catch-up (those sent with a
      `since`), then the confirm with id H, its stale keys named */
  post(streamId: string, body: InterestPost): 202 | 404 {
    const stream = this.streams.get(streamId);
    if (!stream?.open) return 404;
    if (body.ask <= stream.ask) return 202;
    stream.ask = body.ask;
    const before = stream.interest;
    const interest: Interest = { thread: body.thread, under: [...body.under], holds: [...body.holds] };
    stream.interest = interest;
    const head = this.head;
    const stale: string[] = [];
    for (const key of keysIn(interest)) {
      const since = body.since?.[key];
      if (inSet(before, key) || since === undefined) continue;
      const caught = this.catchup(key, since, head);
      if (caught === null) stale.push(key);
      else for (const data of caught) this.queue(stream, { id: null, data, at: head });
    }
    this.sent.confirms++;
    const confirm = { type: "interest", ask: body.ask, ...interest, seq: head, ...(stale.length > 0 ? { stale } : {}) };
    this.queue(stream, { id: `${this.epoch}:${head}`, data: JSON.stringify(confirm), at: head });
    return 202;
  }

  /** the connection ended: the stream map forgets it */
  close(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.open = false;
    stream.queue = [];
    this.streams.delete(streamId);
  }
}
