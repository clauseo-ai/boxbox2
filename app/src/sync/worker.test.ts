/* the worker's stream loop against a fetch that serves a stream the test
   writes, on fake timers: the stall timer drops a connection exactly
   STALL_MS after its last byte, and a frame past the parser's cap drops
   the connection, is logged, and is dialled again with a backoff that
   grows, not every half second. and the worker's side of protocol 3
   against a fake server (fixtures/server.ts): what the page shows becomes
   the stream's query and its interest posts, a hidden page asks for the
   overview only after 30 s, a catch-up ends at `caught`, ids the stream
   skipped are counted, and reads take the new routes and revalidate. */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { type FakeServer, fakeServer } from "./fixtures/server";
import { snapshot, thread } from "./fixtures/neutral";
import type { Message } from "./protocol";
import { PROTOCOL } from "./protocol";
import type { SyncState } from "./reducer";
import { HIDDEN_AFTER_MS, streamUrl, Sync } from "./worker";

type Dial = { at: number; signal: AbortSignal; push(text: string): void };

const encoder = new TextEncoder();
const hello = `data: ${JSON.stringify({ type: "hello", epoch: "e1", head: 0, build: "test", protocol: PROTOCOL, stream: "0".repeat(32), interest: { thread: null, under: [], holds: [] } })}\n\n`;

let dials: Dial[] = [];
let rows: { kind: string; props: Record<string, unknown> }[] = [];
let serve: (dial: Dial) => void = () => {};
const saved: { fetch: typeof fetch; postMessage: unknown; indexedDB: unknown } = { fetch: globalThis.fetch, postMessage: undefined, indexedDB: undefined };
const scope = globalThis as unknown as Record<string, unknown>;
let sync: Sync | null = null;

/** lets the loop's promises run between timer steps */
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** moves the fake clock in steps, letting the loop run after each */
async function advance(ms: number, step = 50) {
  for (let left = ms; left > 0; left -= step) {
    jest.advanceTimersByTime(Math.min(step, left));
    await settle();
  }
}

beforeEach(() => {
  dials = [];
  rows = [];
  saved.postMessage = scope["postMessage"];
  saved.indexedDB = scope["indexedDB"];
  // no indexeddb: the worker runs without a cache, so nothing here waits on one
  scope["indexedDB"] = undefined;
  scope["postMessage"] = () => {};
});

afterEach(() => {
  sync?.stop();
  sync = null;
  jest.useRealTimers();
  globalThis.fetch = saved.fetch;
  scope["postMessage"] = saved.postMessage;
  scope["indexedDB"] = saved.indexedDB;
});

describe("the worker's stream loop", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/telemetry")) {
        const body = JSON.parse(String(init?.body)) as { events: { kind: string; props: Record<string, unknown> }[] };
        rows.push(...body.events);
        return new Response(null, { status: 204 });
      }
      if (!url.startsWith("/api/stream")) return new Response(null, { status: 404 });
      const signal = init?.signal ?? new AbortController().signal;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      signal.addEventListener("abort", () => controller?.error(new DOMException("aborted", "AbortError")), { once: true });
      const dial: Dial = { at: performance.now(), signal, push: (text) => controller?.enqueue(encoder.encode(text)) };
      dials.push(dial);
      serve(dial);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });

  test("drops a connection STALL_MS after its last byte, however many bytes came before", async () => {
    serve = (dial) => dial.push(hello);
    sync = new Sync("device", "mac");
    await sync.boot(null);
    await settle();
    expect(dials.length).toBe(1);
    const first = dials[0];
    if (!first) throw new Error("no dial");
    await advance(30_000, 1_000);
    first.push(": hb\n\n");
    await settle();
    // 45 s after the hello would be 45 s; the heartbeat at 30 s moves the stall to 75 s
    await advance(44_900, 1_000);
    expect(first.signal.aborted).toBe(false);
    await advance(100, 10);
    expect(first.signal.aborted).toBe(true);
  });

  test("a frame past the cap drops the connection, is logged, and the dials back off as if it never went live", async () => {
    const cap = 1_000;
    serve = (dial) => {
      dial.push(hello);
      dial.push(`id: e1:1\ndata: ${"x".repeat(cap * 2)}`);
    };
    sync = new Sync("device", "mac", false, cap);
    await sync.boot(null);
    await advance(8_000, 10);
    expect(dials.length).toBeGreaterThanOrEqual(4);
    const gaps = dials.slice(1).map((dial, i) => dial.at - (dials[i]?.at ?? 0));
    // the backoff's ceiling doubles from 500 ms, each wait at least half of it: a loop that reset it would wait 500 ms at most
    expect(gaps[0]).toBeGreaterThanOrEqual(250);
    expect(gaps[1]).toBeGreaterThanOrEqual(500);
    expect(gaps[2]).toBeGreaterThanOrEqual(1_000);
    await advance(10_000, 1_000);
    const overflows = rows.filter((row) => row.kind === "perf.sync" && row.props["what"] === "overflow");
    expect(overflows.length).toBeGreaterThanOrEqual(4);
    expect(overflows.every((row) => Number(row.props["received"]) > cap)).toBe(true);
  });
});

/* —— protocol 3 —— */

const A = "bench:ses_a";
const B = "bench:ses_b";
const C = "bench:ses_c";
const message = (id: string): Message => ({ info: { id, role: "assistant", created: 1 }, parts: [{ type: "text", id: `prt_${id}`, messageID: id, text: `words of ${id}` }] });

let server: FakeServer;

async function until(what: string, ok: () => boolean, ms = 3_000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`waited for ${what}`);
    await Bun.sleep(2);
  }
}

const state = (): SyncState => (sync as unknown as { state: SyncState }).state;

/** a booted worker on a live stream: the hello, then a reset at seq 5 with three idle threads (or `keys`) */
async function live(board = false, keys = [A, B, C]): Promise<Sync> {
  const s = new Sync("device", "mac", board);
  sync = s;
  await s.boot(null);
  await until("the dial", () => server.dials.length === 1);
  server.head = 5;
  server.hello();
  server.push({ type: "reset", seq: 5, epoch: "j1", reason: "none", fleet: snapshot(keys.map((key) => thread(key))) }, "j1:5");
  await until("the reset", () => state().cursor?.seq === 5);
  return s;
}

/** the person opens a thread and the stage shows it, as client.ts says both */
async function openAndShow(key: string) {
  const s = sync as Sync;
  await s.open(key);
  s.show(key);
}

const settled = () => state().interest.posts.length === 0 && !state().interest.due;

describe("protocol 3: what the page shows", () => {
  beforeEach(() => {
    server = fakeServer();
    server.transcript = (key) => [message(`msg_${key.slice(10)}_1`)];
  });
  afterEach(() => server.restore());

  test("a stream's query names the stage, the layers, the holds and each one's left, keys encoded and lists joined by commas", () => {
    expect(streamUrl({ thread: null, under: [], holds: [], since: {} }, false)).toBe("/api/stream");
    expect(streamUrl({ thread: null, under: [], holds: [], since: {} }, true)).toBe("/api/stream?board=1");
    expect(streamUrl({ thread: B, under: [A], holds: [C, "h:x y"], since: { [B]: 12, [A]: 9 } }, true)).toBe(
      "/api/stream?thread=bench%3Ases_b&under=bench%3Ases_a&holds=bench%3Ases_c,h%3Ax%20y&since=bench%3Ases_b:12,bench%3Ases_a:9&board=1",
    );
  });

  test("the first dial asks for no colours flag; opening, layering and holding post the interest, once a turn; a pagehide and pageshow dial again with all of it in the query, each key with its left", async () => {
    const s = await live();
    expect(server.dials[0]?.url).toBe("/api/stream");
    await openAndShow(A);
    await until("a read", () => state().threads[A]?.status === "live");
    // an entry for the stage moves the cursor past the confirm
    server.push({ seq: 7, type: "message", key: A, upstream: 60, message: { id: "msg_a_2", role: "assistant", created: 2 } }, "j1:7");
    // B layered over A and C held for it in one turn: one post says both
    await openAndShow(B);
    await s.hold(C);
    await until("the confirms", () => settled() && state().threads[B]?.status === "live" && state().threads[C]?.status === "live");
    expect(server.posts.map((p) => [p.url, p.body])).toEqual([
      [`/api/stream/${server.stream}/interest`, { ask: 1, thread: A, under: [], holds: [] }],
      [`/api/stream/${server.stream}/interest`, { ask: 2, thread: B, under: [A], holds: [C] }],
    ]);
    // the reads waited for their confirm and took the new route
    expect(server.reads.map((r) => r.url)).toEqual(["/api/agents/bench/threads/ses_a/messages", "/api/agents/bench/threads/ses_b/messages", "/api/agents/bench/threads/ses_c/messages"]);
    const cursor = state().cursor?.seq ?? 0;
    expect(cursor).toBe(7);
    // pagehide: the stream closes and every key in interest keeps the cursor as its left; pageshow dials at once with them
    await s.pause();
    expect(server.dials[0]?.signal.aborted).toBe(true);
    s.resume();
    await until("the second dial", () => server.dials.length === 2);
    expect(server.dials[1]?.url).toBe(`/api/stream?thread=bench%3Ases_b&under=bench%3Ases_a&holds=bench%3Ases_c&since=bench%3Ases_b:7,bench%3Ases_a:7,bench%3Ases_c:7`);
    expect(server.dials[1]?.headers["last-event-id"]).toBe("j1:7");
  });

  test("a layer the page stops showing leaves the interest, keeps the confirm's seq as its left, and comes back with it as its since, read by no one", async () => {
    const s = await live();
    await openAndShow(A);
    await openAndShow(B);
    await until("both read", () => settled() && state().threads[B]?.status === "live" && state().threads[A]?.status === "live");
    server.push({ seq: 9, type: "thread.patch", key: A, set: { updated: 3 } }, "j1:9");
    // A and B opened in one turn went in one post
    expect(server.posts.map((p) => p.body)).toEqual([{ ask: 1, thread: B, under: [A], holds: [] }]);
    s.hide(A);
    await until("the confirm", () => settled() && server.posts.length === 2);
    expect(server.posts[1]?.body).toEqual({ ask: 2, thread: B, under: [], holds: [] });
    expect(state().threads[A]?.left).toBe(9);
    const reads = server.reads.length;
    // back on stage over B: it enters with its left, and the server's catch-up (none here) is all it needs
    await openAndShow(A);
    await until("the confirm", () => settled() && server.posts.length === 3);
    expect(server.posts[2]?.body).toEqual({ ask: 3, thread: A, under: [B], holds: [], since: { [A]: 9 } });
    await Bun.sleep(20);
    expect(server.reads.length).toBe(reads);
    expect(state().threads[A]?.left).toBeUndefined();
  });

  test("closing the stage over a layer makes the layer the stage: the post names it as the thread, with no since and no read", async () => {
    const s = await live();
    await openAndShow(A);
    await openAndShow(B);
    await until("both read", () => settled() && state().threads[B]?.status === "live" && state().threads[A]?.status === "live");
    const reads = server.reads.length;
    s.hide(B);
    await until("the confirm", () => settled() && server.posts.length === 2);
    expect(server.posts[1]?.body).toEqual({ ask: 2, thread: A, under: [], holds: [] });
    // and closing that one too goes home
    s.hide(A);
    await until("the confirm", () => settled() && server.posts.length === 3);
    expect(server.posts[2]?.body).toEqual({ ask: 3, thread: null, under: [], holds: [] });
    await Bun.sleep(20);
    expect(server.reads.length).toBe(reads);
  });

  test("a post the server answers 404 dials again at once with the interest in the query; one that fails otherwise dials again after the backoff, never posting it again", async () => {
    const s = await live();
    server.postStatus = 404;
    await openAndShow(A);
    await until("the second dial", () => server.dials.length === 2, 400);
    expect(server.dials[1]?.url).toBe("/api/stream?thread=bench%3Ases_a");
    expect(server.posts).toHaveLength(1);
    server.hello({ thread: A, under: [], holds: [] });
    await until("the hello's read", () => state().threads[A]?.status === "live");
    server.postStatus = 500;
    const started = Date.now();
    await s.hold(C);
    await until("the third dial", () => server.dials.length === 3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    // the stage was current when the stream dropped, so it goes with the cursor as its since; the child was never read
    expect(server.dials[2]?.url).toBe("/api/stream?thread=bench%3Ases_a&holds=bench%3Ases_c&since=bench%3Ases_a:5");
    expect(server.posts).toHaveLength(2);
  });

  test("a catch-up ends at caught: the stream says resumed and how many frames it replayed, the catch-up row says what it cost, and the ids it skipped are counted", async () => {
    const s = await live();
    await s.pause();
    s.resume();
    await until("the second dial", () => server.dials.length === 2);
    server.hello();
    server.push({ seq: 9, type: "thread.patch", key: A, set: { updated: 3 } }, "j1:9");
    server.push({ type: "catchup", entries: [] });
    // a type this client does not know moves the cursor past it
    server.push({ seq: 30, type: "thread.someday", key: A }, "j1:30");
    server.push({ type: "caught", seq: 40 }, "j1:40");
    await until("caught", () => state().cursor?.seq === 40);
    await s.pause();
    // the connection's minute row is written as its read ends, after the pause's own flush
    await Bun.sleep(10);
    await s.flush();
    await until("the rows", () => server.rows.filter((r) => r.kind === "perf.sync").length === 2);
    const streams = server.rows.filter((r) => r.kind === "app.stream");
    expect(streams.map((r) => r.props)).toEqual([
      { state: "open", resumed: 0, replayed: 0 },
      // a pagehide is not a drop: no time down is said
      { state: "reopen", resumed: 1, replayed: 3 },
    ]);
    const catchups = server.rows.filter((r) => r.kind === "sync.catchup").map((r) => r.props);
    expect(catchups[0]).toMatchObject({ how: "reset", reason: "none", frames: 1 });
    expect(catchups[1]).toMatchObject({ how: "caught", frames: 4, stale: 0, resets: 0 });
    expect(Number(catchups[1]?.["bytes"])).toBeGreaterThan(50);
    // ids 5, 9, 30, 40: 3 + 20 + 9 seqs skipped, on the second connection's minute row
    const minutes = server.rows.filter((r) => r.kind === "perf.sync" && r.props["what"] === "minute").map((r) => r.props);
    expect(minutes.at(-1)).toMatchObject({ view: "home", skipped: 32 });
  });

  test("reads revalidate with the etag they hold: a 304 keeps what the thread holds as the read, and a read without one sends no If-None-Match", async () => {
    server.etag = (key) => (key === A ? '"3.j1.5.q"' : undefined);
    await live();
    await openAndShow(A);
    await openAndShow(B);
    await until("both read", () => settled() && state().threads[A]?.status === "live" && state().threads[B]?.status === "live");
    expect(state().threads[A]?.etag).toBe('"3.j1.5.q"');
    expect(state().threads[B]).not.toHaveProperty("etag");
    const before = state().threads[A]?.messages;
    // the stream cannot vouch for both: each is read again, A by its etag
    server.push({ type: "thread.stale", key: A });
    server.push({ type: "thread.stale", key: B });
    await until("read again", () => server.reads.length === 4 && state().threads[A]?.status === "live" && state().threads[B]?.status === "live");
    expect(server.reads.slice(2).map((r) => [r.key, r.headers["if-none-match"]])).toEqual([
      [A, '"3.j1.5.q"'],
      [B, undefined],
    ]);
    expect(state().threads[A]?.messages).toEqual(before as Message[]);
    expect(state().threads[A]?.etag).toBe('"3.j1.5.q"');
  });
});

/* the page sends what it shows one message at a time, and each is its own task in the worker: opening a thread with five
   agent children is an open, a show and five holds. they reach the worker together, queued ahead of the timer the first one
   starts, so the interest they add up to goes in one post */
describe("protocol 3: one interest post a turn", () => {
  const P = "bench:ses_p";
  const kids = [1, 2, 3, 4, 5].map((n) => `bench:ses_k${n}`);

  beforeEach(() => {
    server = fakeServer();
    server.transcript = (key) => [message(`msg_${key.slice(10)}_1`)];
  });
  afterEach(() => server.restore());

  /** each call its own task, all queued at once, as the page's messages reach the worker */
  const messages = (...calls: (() => unknown)[]) => {
    for (const call of calls) setTimeout(() => void call(), 0);
  };

  test("opening a thread with five children posts once, with all of it; the reads wait for that confirm; closing it posts once", async () => {
    const s = await live(false, [P, ...kids]);
    // how many reads had gone out when each confirm was sent
    const readsAtConfirm: number[] = [];
    server.beforeConfirm = () => {
      readsAtConfirm.push(server.reads.length);
      return [];
    };
    messages(
      () => s.open(P),
      () => s.show(P),
      ...kids.map((kid) => () => s.hold(kid)),
    );
    await until("every read", () => settled() && [P, ...kids].every((key) => state().threads[key]?.status === "live"));
    expect(server.posts.map((p) => p.body)).toEqual([{ ask: 1, thread: P, under: [], holds: kids }]);
    // every key entered without since: none was read before the confirm said where it entered, each once after it
    expect(readsAtConfirm).toEqual([0]);
    expect(server.reads.map((r) => r.key).sort()).toEqual([P, ...kids].sort());
    messages(...kids.map((kid) => () => s.release(kid)), () => s.hide(P));
    await until("the confirm", () => settled() && server.posts.length === 2);
    await Bun.sleep(20);
    expect(server.posts.map((p) => p.body)).toEqual([
      { ask: 1, thread: P, under: [], holds: kids },
      { ask: 2, thread: null, under: [], holds: [] },
    ]);
    expect(state().interest.confirmed).toEqual({ thread: null, under: [], holds: [] });
  });

  test("a turn that opens a thread over the stage and closes it again posts nothing and leaves nothing waiting", async () => {
    const s = await live();
    await openAndShow(A);
    await until("read", () => settled() && state().threads[A]?.status === "live");
    expect(server.posts).toHaveLength(1);
    messages(
      () => s.open(B),
      () => s.show(B),
      () => s.hide(B),
    );
    await until("the turn", () => state().threads[B] !== undefined && !state().interest.due);
    await Bun.sleep(20);
    expect(server.posts).toHaveLength(1);
    expect(state().interest.posts).toEqual([]);
    expect(state().interest.confirmed).toEqual({ thread: A, under: [], holds: [] });
    // B was opened, so it is read all the same, and nothing holds that read back
    await until("B read", () => state().threads[B]?.status === "live");
  });
});

describe("protocol 3: a hidden page", () => {
  beforeEach(() => {
    server = fakeServer();
    server.transcript = (key) => [message(`msg_${key.slice(10)}_1`)];
  });
  afterEach(() => server.restore());

  test("asks for the overview only after 30 s hidden, keeps the confirm's seq as the stage's left, and on visible asks for it again with that left", async () => {
    const s = await live();
    await openAndShow(A);
    await until("read", () => settled() && state().threads[A]?.status === "live");
    server.push({ seq: 8, type: "thread.patch", key: A, set: { updated: 3 } }, "j1:8");
    jest.useFakeTimers();
    s.visibility(true);
    await advance(HIDDEN_AFTER_MS - 1_000, 1_000);
    expect(server.posts).toHaveLength(1);
    // the post goes on a turn of its own, after the timer that asked for it
    await advance(1_100, 100);
    expect(server.posts[1]?.body).toEqual({ ask: 2, thread: null, under: [], holds: [] });
    jest.useRealTimers();
    await until("the confirm", () => settled());
    expect(state().threads[A]?.left).toBe(8);
    s.visibility(false);
    await until("the confirm", () => settled() && server.posts.length === 3);
    expect(server.posts[2]?.body).toEqual({ ask: 3, thread: A, under: [], holds: [], since: { [A]: 8 } });
  });

  test("shown again before 30 s, it asks for nothing", async () => {
    const s = await live();
    await openAndShow(A);
    await until("read", () => settled());
    jest.useFakeTimers();
    s.visibility(true);
    await advance(HIDDEN_AFTER_MS - 1_000, 1_000);
    s.visibility(false);
    await advance(5_000, 1_000);
    jest.useRealTimers();
    expect(server.posts).toHaveLength(1);
  });
});
