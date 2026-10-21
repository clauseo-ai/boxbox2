/* a press on a thread's window takes the thread ahead of its click (client.ts, pressThread): the real ui side (client.ts and
   the store, frames run by hand) and the real worker (its cache on fake-indexeddb, a fetch that serves the stream and the
   transcripts), wired as the browser wires them. a thread the store let go is back in it before the click that follows a
   press, so the stage the click mounts holds it and paints it in the click's frame; a press no open follows lets it go and
   leaves the worker as it was; one press holds at a time; a cooled thread comes back from its pages on the press. */

import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unwrap } from "solid-js/store";
import type { FromWorker, ToWorker } from "./messages";
import type { FleetSnapshot, Message, SessionEntry } from "./protocol";
import type { SyncState } from "./reducer";

const read = (name: string) => (JSON.parse(readFileSync(join(import.meta.dir, `../ui/thread/fixtures/${name}.json`), "utf8")) as { messages: Message[] }).messages;
const TRANSCRIPT = read("notes-asks");
const KEYS = ["bench:ses_a", "bench:ses_b", "bench:ses_c", "bench:ses_d", "bench:ses_e", "bench:ses_f"] as const;
const [A, B, C] = KEYS;

const session = (key: string): SessionEntry => ({
  key,
  host: "bench",
  id: key.slice(6),
  info: { id: key.slice(6), slug: "s", projectID: "/w", directory: "/w", title: key, version: "0", time: { created: 1, updated: 2 }, source: "cmx2", cost: 0, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
  status: null,
  agents: 0,
  processes: 0,
  tail: [],
  needs: [],
  read: null,
});
const snapshot: FleetSnapshot = { hosts: [], sessions: KEYS.map(session), asks: [], order: [...KEYS] };

type Listener = (event: { data: FromWorker }) => void;
type SyncLike = {
  boot(open: string | null): Promise<void>;
  show(key: string, press?: boolean): void;
  hide(key: string, press?: boolean): void;
  open(key: string): Promise<void>;
  sweep(): Promise<void>;
  stop(): void;
};
let listener: Listener | null = null;
let sync: SyncLike | null = null;
let clock = 1_000_000;
let reads: string[] = [];
let push: (frame: unknown, id?: string) => void = () => {};
const frames = new Map<number, () => void>();
let next = 1;
const encoder = new TextEncoder();
const saved: Record<string, unknown> = {};
const stubs: Record<string, unknown> = {
  window: { addEventListener: () => undefined, removeEventListener: () => undefined },
  document: { visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined },
  location: { href: "https://boxbox.test/", search: "" },
  history: { state: null, replaceState: () => undefined },
  localStorage: { getItem: () => "device", setItem: () => undefined },
  // the page's worker: what the page sends reaches the real worker a task later, as it does in a browser
  Worker: class {
    addEventListener(_name: string, fn: Listener) {
      listener = fn;
    }
    postMessage(message: ToWorker) {
      setTimeout(() => {
        const s = sync;
        if (!s) return;
        if (message.type === "show") s.show(message.key, message.press === true);
        else if (message.type === "hide") s.hide(message.key, message.press === true);
        else if (message.type === "open") void s.open(message.key);
      }, 0);
    }
    terminate() {}
  },
  // the worker's posts reach the page copied, as postMessage copies them
  postMessage: (message: FromWorker) => listener?.({ data: structuredClone(message) }),
  // one frame clock for both sides, run by hand
  requestAnimationFrame: (fn: () => void) => {
    frames.set(next, fn);
    return next++;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/stream")) {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      init?.signal?.addEventListener("abort", () => controller?.error(new DOMException("aborted", "AbortError")), { once: true });
      push = (frame, id) => controller?.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(frame)}\n\n`));
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const transcript = /^\/api\/hosts\/bench\/sessions\/([^/]+)\/messages$/.exec(url);
    if (transcript) {
      reads.push(`bench:${transcript[1] ?? ""}`);
      return new Response(JSON.stringify(TRANSCRIPT), { status: 200, headers: { "x-cmx2-seq": "u1:50", "content-type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  },
};

let client: typeof import("./client");
let store: typeof import("../store");
let COOL_AFTER_MS = 0;

/** one frame: every callback asked for so far runs */
const frame = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const fn of due) fn();
};
async function until(what: string, ok: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`waited for ${what}`);
    await Bun.sleep(2);
    frame();
  }
}
/** frames run, with the tasks between them, until `ok`: how many it took */
async function framesUntil(what: string, ok: () => boolean, most = 10): Promise<number> {
  for (let n = 0; n <= most; n++) {
    // the tasks between two frames: the page's message reaching the worker, the worker's post reaching the page
    for (let i = 0; i < 20 && !ok(); i++) await Bun.sleep(1);
    if (ok()) return n;
    frame();
  }
  throw new Error(`${what}: not in ${most} frames`);
}
const held = (key: string) => unwrap(store.state.threads)[key];
const inner = () => sync as unknown as { state: SyncState; shown: Set<string>; closedAt: Map<string, number> };

beforeAll(async () => {
  for (const [name, value] of Object.entries(stubs)) {
    saved[name] = (globalThis as Record<string, unknown>)[name];
    (globalThis as Record<string, unknown>)[name] = value;
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("boxbox");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  client = await import("./client");
  store = await import("../store");
  const worker = await import("./worker");
  COOL_AFTER_MS = worker.COOL_AFTER_MS;
  client.startSync();
  sync = new worker.Sync("device", "mac", false, undefined, () => clock) as unknown as SyncLike;
  await sync.boot(null);
  await until("the stream", () => push !== undefined);
  push({ type: "hello", epoch: "j1", head: 1, build: "test", protocol: 1 });
  push({ type: "reset", epoch: "j1", seq: 1, reason: "none", fleet: snapshot }, "j1:1");
  await until("the fleet", () => Object.keys(store.state.fleet.sessions).length === KEYS.length);
});

afterAll(async () => {
  sync?.stop();
  sync = null;
  client.stopSync();
  await Bun.sleep(5);
  for (const [name, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[name] = value;
});

/** the person opens a thread and waits for it */
async function openAndWait(key: string) {
  client.openThread(key);
  await until(`${key} held`, () => held(key)?.status === "live" && inner().state.threads[key]?.status === "live");
}

describe("a press takes the thread ahead of its click", () => {
  test("a closed thread is back in the store within two frames of the press, so the click's stage mounts with it", async () => {
    await openAndWait(A);
    await openAndWait(B);
    await until("the store lets A go", () => held(A) === undefined);
    const shown = JSON.stringify(inner().state.threads[A]?.messages);
    client.pressThread(A);
    // the worker's frame posts it, the landing's frame lands it: a press a little before the click is enough
    expect(await framesUntil("the press brings A back", () => held(A) !== undefined)).toBeLessThanOrEqual(2);
    client.openThread(A);
    // the click: the stage that mounts now reads the thread from the store, so its first frame has the rows
    expect(JSON.stringify(held(A)?.messages)).toBe(shown);
    // the open holds it now, not the press: it stays through the press's time and goes when the stage leaves it
    await Bun.sleep(client.PRESS_HOLD_MS + 50);
    frame();
    expect(held(A)).toBeDefined();
    expect(inner().shown.has(A)).toBe(true);
    await openAndWait(B);
    await until("A closed again", () => held(A) === undefined && !inner().shown.has(A));
  });

  test("a press no open follows lets the thread go after its time, and the worker keeps it where it was among the closed", async () => {
    const closedAt = inner().closedAt.get(A);
    expect(closedAt).toBeDefined();
    clock += 60_000;
    client.pressThread(A);
    await framesUntil("the press brings A back", () => held(A) !== undefined);
    expect(inner().closedAt.has(A)).toBe(false);
    await Bun.sleep(client.PRESS_HOLD_MS + 50);
    await until("the press lets A go", () => held(A) === undefined && !inner().shown.has(A));
    // not a close: the person never saw it, so it does not take a place among the last closed from one they did
    expect(inner().closedAt.get(A)).toBe(closedAt as number);
  });

  test("one press holds at a time: a second press lets the first go", async () => {
    await openAndWait(C);
    await openAndWait(B);
    await until("the store lets C go", () => held(C) === undefined);
    client.pressThread(A);
    await framesUntil("A pressed", () => held(A) !== undefined);
    client.pressThread(C);
    await until("C pressed and A let go", () => held(C) !== undefined && held(A) === undefined);
    expect(inner().shown.has(A)).toBe(false);
    expect(inner().shown.has(C)).toBe(true);
    // a press on what is on screen takes nothing: B is on stage
    client.pressThread(B);
    await until("C let go", () => held(C) === undefined && !inner().shown.has(C));
    expect(held(B)).toBeDefined();
  });

  test("a cooled thread comes back from its pages on the press, reading nothing from the daemon", async () => {
    for (const key of KEYS.slice(2, 6)) {
      await openAndWait(key);
      clock += 1_000;
    }
    await openAndWait(B);
    clock += COOL_AFTER_MS + 10_000;
    await (sync as SyncLike).sweep();
    await until("A cooled", () => inner().state.threads[A] === undefined && inner().state.cold[A] !== undefined);
    const readsBefore = reads.length;
    client.pressThread(A);
    await until("A restored by the press", () => held(A)?.status === "live");
    expect(held(A)?.messages).toHaveLength(TRANSCRIPT.length);
    client.openThread(A);
    expect(held(A)?.messages).toHaveLength(TRANSCRIPT.length);
    expect(reads.length).toBe(readsBefore);
  });
});
