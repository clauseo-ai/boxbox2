/* the worker's stream loop against a fetch that serves a stream the test
   writes, on fake timers: the stall timer drops a connection exactly
   STALL_MS after its last byte, and a frame past the parser's cap drops
   the connection, is logged, and is dialled again with a backoff that
   grows, not every half second. */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { PROTOCOL } from "./protocol";
import { Sync } from "./worker";

type Dial = { at: number; signal: AbortSignal; push(text: string): void };

const encoder = new TextEncoder();
const hello = `data: ${JSON.stringify({ type: "hello", epoch: "e1", head: 0, build: "test", protocol: PROTOCOL })}\n\n`;

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

afterEach(() => {
  sync?.stop();
  sync = null;
  jest.useRealTimers();
  globalThis.fetch = saved.fetch;
  scope["postMessage"] = saved.postMessage;
  scope["indexedDB"] = saved.indexedDB;
});

describe("the worker's stream loop", () => {
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
