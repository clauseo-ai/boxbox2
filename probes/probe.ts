/* what every probe gets: http against the bench daemon, sse streams that
   keep every frame, assertions that name what failed, and a few session
   helpers. a probe asserts the contract as ASKS.md states it; it never
   bends to what the pinned daemon happens to do. */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, type Bench } from "./bench";
import { type Frame, parseFrames } from "./wire";

/** "contract": the daemon does not do what the ask says. "setup": the bench
    did not get the probe to the point of asking, which is a probe or bench
    bug whatever has landed */
export type FailureKind = "contract" | "setup";

export class Failure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly assertion: string,
    readonly detail: string,
  ) {
    super(`${assertion}: ${detail}`);
  }
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  /** the body as json, or undefined when it is empty or not json */
  json: unknown;
}

export interface Event {
  frame: Frame;
  /** what the data line decoded to: `{directory, project, payload}` on /global/event, the bare payload on /event */
  body: unknown;
  type: string;
  properties: Record<string, unknown>;
  at: number;
}

export type Match = (e: Event) => boolean;

export interface WaitOptions {
  timeoutMs?: number;
  kind?: FailureKind;
}

export type Json = Record<string, unknown>;

export function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function decode(frame: Frame): Event {
  let body: unknown;
  try {
    body = JSON.parse(frame.data);
  } catch {
    body = undefined;
  }
  const payload = record(record(body).payload ?? body);
  return {
    frame,
    body,
    type: typeof payload.type === "string" ? payload.type : "(undecodable)",
    properties: record(payload.properties),
    at: performance.now(),
  };
}

/** events that carry no seq under a1: the connection's own frames and
    deltas, which cmx2 does not log */
export const UNSEQUENCED = new Set(["server.connected", "server.heartbeat", "global.disposed", "message.part.delta"]);

export const sequenced: Match = (e) => !UNSEQUENCED.has(e.type);

interface Waiter {
  from: number;
  match: Match;
  resolve: (e: Event) => void;
}

/** reopens a stream from a cursor: how a following stream resumes after the daemon closes it */
export type Reopen = (lastEventId: string | undefined, signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | undefined>;

/** one sse connection, or with `reopen` a follower that resumes from its last id whenever the daemon
    closes it (a3 closes a reader that falls 1 mib behind; a1 is how it comes back). it keeps every
    event it read, in order, and counts the bytes it received */
export class Stream {
  readonly events: Event[] = [];
  bytes = 0;
  ended = false;
  /** how many times the daemon closed a follower and it resumed */
  resumes = 0;
  private lastEventId: string | undefined;
  private waiters: Waiter[] = [];
  private closedWaiters: (() => void)[] = [];

  constructor(
    readonly label: string,
    private readonly controller: AbortController,
    private readonly reopen?: Reopen,
  ) {}

  async read(first: ReadableStream<Uint8Array>) {
    try {
      for (let body: ReadableStream<Uint8Array> | undefined = first; body; ) {
        await this.readOne(body);
        if (!this.reopen || this.controller.signal.aborted) break;
        body = await this.reopen(this.lastEventId, this.controller.signal).catch(() => undefined);
        if (body) this.resumes++;
      }
    } finally {
      this.ended = true;
      for (const done of this.closedWaiters.splice(0)) done();
    }
  }

  private async readOne(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    // a reader, not `for await`: the installed bun types do not give ReadableStream an async iterator
    const reader = body.getReader();
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const chunk = next.value;
        this.bytes += chunk.byteLength;
        buffer += decoder.decode(chunk, { stream: true });
        const { frames, rest } = parseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.id !== undefined) this.lastEventId = frame.id;
          this.push(decode(frame));
        }
      }
    } catch {
      /* aborted by close(), or the daemon closed or dropped the connection: this connection has ended */
    }
  }

  private push(e: Event) {
    const index = this.events.push(e) - 1;
    for (const w of [...this.waiters]) {
      if (index >= w.from && w.match(e)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  }

  /** the next event matching `match` that arrives after this call; arm it before the call that causes it */
  wait(match: Match, what: string, options: WaitOptions = {}): Promise<Event> {
    return this.waitFrom(this.events.length, match, what, options);
  }

  /** the first matching event at or after `from`, already read or still to come */
  waitFrom(from: number, match: Match, what: string, options: WaitOptions = {}): Promise<Event> {
    const found = this.events.slice(from).find(match);
    if (found) return Promise.resolve(found);
    const timeoutMs = options.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { from, match, resolve: () => undefined };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Failure(options.kind ?? "contract", what, `nothing on ${this.label} within ${timeoutMs} ms`));
      }, timeoutMs);
      waiter.resolve = (e) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push(waiter);
    });
  }

  /** waits until `count` events at or after `from` match, and returns them */
  async collect(from: number, match: Match, count: number, what: string, options: WaitOptions = {}): Promise<Event[]> {
    let seen = 0;
    await this.waitFrom(from, (e) => match(e) && ++seen >= count, what, options).catch((e: unknown) => {
      if (this.events.slice(from).filter(match).length < count) throw e;
    });
    return this.events.slice(from).filter(match).slice(0, count);
  }

  /** resolves true when the stream ends within `timeoutMs` */
  endsWithin(timeoutMs: number): Promise<boolean> {
    if (this.ended) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closedWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close() {
    this.controller.abort();
  }
}

export const forSession =
  (id: string): Match =>
  (e) =>
    e.properties.sessionID === id;

/** a finished turn ends in `session.idle`, an aborted one in `session.status` of type idle */
export const idleOf =
  (id: string): Match =>
  (e) =>
    forSession(id)(e) && (e.type === "session.idle" || (e.type === "session.status" && record(e.properties.status).type === "idle"));

export const deltaOf =
  (id: string): Match =>
  (e) =>
    e.type === "message.part.delta" && forSession(id)(e);

export type AskType = "permission.asked" | "question.asked";

/** the id of the `n`th ask of `type` in `session` (1-based), counting from `from` on the stream. a
    turn's asks come one at a time as each settles (pi gates tool calls in order) or several at once
    (parallel questions); counting from a fixed start finds the nth either way */
export async function nthAsk(stream: Stream, from: number, session: string, type: AskType, n: number, what: string): Promise<string> {
  const match: Match = (e) => e.type === type && e.properties.sessionID === session;
  const asks = await stream.collect(from, match, n, what, { timeoutMs: 15_000, kind: "setup" });
  return String(asks[n - 1]?.properties.id);
}

/** the text of a message from GET /session/:id/message: its text parts joined */
export function textOf(message: unknown): string {
  return list(record(message).parts)
    .map(record)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => String(p.text))
    .join("");
}

export class Context {
  private streams: Stream[] = [];
  readonly passed: string[] = [];
  private readonly requestLog = join(BASE, "requests.log");

  constructor(
    readonly bench: Bench,
    readonly ask: string,
    private readonly print: (line: string) => void,
  ) {}

  note(line: string) {
    this.print(`        ${line}`);
  }

  /** passes quietly into the transcript, or throws the failure the run table names */
  check(assertion: string, ok: boolean, detail: string): asserts ok {
    if (!ok) throw new Failure("contract", assertion, detail);
    this.passed.push(assertion);
    this.print(`  ok    ${assertion}`);
  }

  /** a precondition the probe needs before it can ask anything; failing it is a probe or bench bug */
  need(assertion: string, ok: boolean, detail: string): asserts ok {
    if (!ok) throw new Failure("setup", assertion, detail);
  }

  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const started = performance.now();
    const res = await fetch(`${this.bench.url}${path}`, {
      method,
      headers: { authorization: this.bench.auth, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const ms = (performance.now() - started).toFixed(0);
    appendFileSync(this.requestLog, `${this.ask} ${method} ${path} -> ${res.status} ${ms}ms ${text.slice(0, 200)}\n`);
    return { status: res.status, headers: res.headers, text, json };
  }

  /** opens an sse stream and resolves once the daemon has answered with headers */
  async watch(path = "/global/event", headers: Record<string, string> = {}): Promise<Stream> {
    return this.open(path, headers, false);
  }

  /** a stream that reads like a client of a1 and a3: when the daemon closes it, it resumes with
      Last-Event-ID from the last id it read, so a burst past the cap does not end it */
  async follow(path = "/global/event"): Promise<Stream> {
    return this.open(path, {}, true);
  }

  private async open(path: string, headers: Record<string, string>, resume: boolean): Promise<Stream> {
    const controller = new AbortController();
    const connect = (extra: Record<string, string>, signal: AbortSignal) =>
      fetch(`${this.bench.url}${path}`, { headers: { authorization: this.bench.auth, accept: "text/event-stream", ...headers, ...extra }, signal });
    const res = await connect({}, controller.signal);
    this.need(`GET ${path} opens an event stream`, res.ok && res.body !== null, `answered ${res.status}`);
    const reopen: Reopen = async (lastEventId, signal) => {
      const again = await connect(lastEventId === undefined ? {} : { "last-event-id": lastEventId }, signal);
      return again.ok && again.body !== null ? again.body : undefined;
    };
    const label = `${path}${headers["last-event-id"] ? ` (Last-Event-ID ${headers["last-event-id"]})` : ""}`;
    const stream = new Stream(label, controller, resume ? reopen : undefined);
    void stream.read(res.body);
    this.streams.push(stream);
    return stream;
  }

  async session(title: string): Promise<string> {
    const reply = await this.api("POST", "/session", { title: `${this.ask} ${title}` });
    const id = record(reply.json).id;
    this.need("POST /session creates a session", reply.status === 201 && typeof id === "string", `answered ${reply.status} ${reply.text.slice(0, 120)}`);
    return id;
  }

  async prompt(session: string, text: string, extra: Json = {}): Promise<Reply> {
    const reply = await this.api("POST", `/session/${session}/prompt`, { text, ...extra });
    this.need(`POST /session/:id/prompt starts "${text.slice(0, 40)}"`, reply.status === 202, `answered ${reply.status} ${reply.text.slice(0, 120)}`);
    return reply;
  }

  /** runs one prompt to the end of its turn */
  async turn(stream: Stream, session: string, text: string, timeoutMs = 20_000) {
    const idle = stream.wait(idleOf(session), `the turn "${text.slice(0, 40)}" ends`, { timeoutMs, kind: "setup" });
    await this.prompt(session, text);
    await idle;
  }

  async messages(session: string): Promise<unknown[]> {
    const reply = await this.api("GET", `/session/${session}/message`);
    this.need("GET /session/:id/message answers", reply.status === 200 && Array.isArray(reply.json), `answered ${reply.status}`);
    return list(reply.json);
  }

  close() {
    for (const stream of this.streams) stream.close();
  }
}

export interface Probe {
  ask: string;
  title: string;
  run(ctx: Context): Promise<void>;
}
