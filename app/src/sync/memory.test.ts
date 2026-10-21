/* what the worker keeps in memory and what the ui's store holds (docs/architecture.md, what the cache keeps and lets
   go): the real worker, its cache on fake-indexeddb and a fetch that serves the stream and the transcripts, with every
   post applied to the real store as the ui applies it. the store holds only the threads the ui shows, and a thread shown
   again is what it was; a thread nobody shows is cooled in time to its pages, the last three closed, the busy and the
   held excepted, and comes back from them as it was, reading nothing from the daemon; a reset reads again only what is
   shown, and the rest go cold and stale. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unwrap } from "solid-js/store";
import { applyPatches, bootSync, setStream, state as ui } from "../store";
import type { FromWorker } from "./messages";
import { type FleetSnapshot, type Message, PROTOCOL, type SessionEntry } from "./protocol";
import { type SyncState, viewOf } from "./reducer";
import { COOL_AFTER_MS, Sync } from "./worker";

const read = (name: string) => (JSON.parse(readFileSync(join(import.meta.dir, `../ui/thread/fixtures/${name}.json`), "utf8")) as { messages: Message[] }).messages;
const FIXTURES = [read("cmx-deploy"), read("notes-asks"), read("northstar-heavy")];
const KEYS = ["bench:ses_a", "bench:ses_b", "bench:ses_c", "bench:ses_d", "bench:ses_e", "bench:ses_f"] as const;
const transcriptOf = (key: string) => FIXTURES[(KEYS as readonly string[]).indexOf(key) % FIXTURES.length] ?? [];

const session = (key: string, busy = false): SessionEntry => ({
  key,
  host: "bench",
  id: key.slice(6),
  info: { id: key.slice(6), slug: "s", projectID: "/w", directory: "/w", title: key, version: "0", time: { created: 1, updated: 2 }, source: "cmx2", cost: 0, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
  status: (busy ? { type: "busy" } : null) as SessionEntry["status"],
  agents: 0,
  processes: 0,
  tail: [],
  needs: [],
  read: null,
});
const snapshot = (busy: readonly string[] = []): FleetSnapshot => ({ hosts: [], sessions: KEYS.map((k) => session(k, busy.includes(k))), asks: [], order: [...KEYS] });

const encoder = new TextEncoder();
const scope = globalThis as unknown as Record<string, unknown>;
const saved = { fetch: globalThis.fetch, postMessage: scope["postMessage"] };
let push: (frame: unknown, id?: string) => void = () => {};
let reads: string[] = [];
let sync: Sync | null = null;
let clock = 1_000_000;

async function until(what: string, ok: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`waited for ${what}`);
    await Bun.sleep(2);
  }
}

async function wipe() {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("boxbox");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await wipe();
  reads = [];
  clock = 1_000_000;
  applyPatches([{ path: ["threads"], value: {} }]);
  // every post lands in the store at once, as on a hidden page: the order and content are the ui's, the frame is not
  scope["postMessage"] = (message: FromWorker) => {
    if (message.type === "patches") applyPatches(structuredClone(message.patches));
    else if (message.type === "boot") bootSync(structuredClone(message.sync));
    else if (message.type === "stream") setStream(message.stream);
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
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
      const key = `bench:${decodeURIComponent(transcript[1] ?? "")}`;
      reads.push(key);
      return new Response(JSON.stringify(transcriptOf(key)), { status: 200, headers: { "x-cmx2-seq": "u1:50", "content-type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});

afterEach(async () => {
  sync?.stop();
  sync = null;
  globalThis.fetch = saved.fetch;
  scope["postMessage"] = saved.postMessage;
  await Bun.sleep(5);
});

const worker = (): SyncState => (sync as unknown as { state: SyncState }).state;
const held = (key: string) => JSON.stringify(unwrap(ui.threads)[key] ?? null);
const mirror = (key: string) => {
  const thread = worker().threads[key];
  return JSON.stringify(thread ? viewOf(thread) : null);
};

async function start(busy: readonly string[] = []) {
  sync = new Sync("device", "mac", false, undefined, () => clock);
  await sync.boot(null);
  await until("the stream", () => push !== undefined);
  push({ type: "hello", epoch: "j1", head: 1, build: "test", protocol: PROTOCOL });
  push({ type: "reset", epoch: "j1", seq: 1, reason: "none", fleet: snapshot(busy) }, "j1:1");
  await until("the fleet", () => Object.keys(ui.fleet.sessions).length === KEYS.length);
}

/** the person opens a thread and the stage shows it, as client.ts says both */
async function openAndShow(key: string) {
  const s = sync as Sync;
  s.show(key);
  await s.open(key);
  await until(`${key} read`, () => worker().threads[key]?.status === "live" && held(key) === mirror(key));
}

describe("the ui's store holds what is on screen", () => {
  test("a thread let go of leaves the store and the worker keeps it; shown again it is what it was", async () => {
    await start();
    await openAndShow(KEYS[0]);
    const first = held(KEYS[0]);
    expect(JSON.parse(first).messages).toHaveLength(transcriptOf(KEYS[0]).length);
    (sync as Sync).hide(KEYS[0]);
    await until("the store lets go", () => held(KEYS[0]) === "null");
    expect(worker().threads[KEYS[0]]?.status).toBe("live");
    (sync as Sync).show(KEYS[0]);
    await until("shown again", () => held(KEYS[0]) !== "null");
    expect(held(KEYS[0])).toBe(first);
    expect(reads).toEqual([KEYS[0]]);
  });

  test("a held thread's patches do not reach the store, and its read lands there only once it is shown", async () => {
    await start();
    await (sync as Sync).hold(KEYS[1]);
    await until("read", () => worker().threads[KEYS[1]]?.status === "live");
    await Bun.sleep(80);
    expect(held(KEYS[1])).toBe("null");
    (sync as Sync).show(KEYS[1]);
    await until("shown", () => held(KEYS[1]) === mirror(KEYS[1]));
  });
});

describe("the worker cools what nobody shows", () => {
  test("after five minutes closed, the three closed last stay; a cooled thread comes back from its pages as it was", async () => {
    await start();
    const before: Record<string, string> = {};
    const messages: Record<string, string> = {};
    for (const key of KEYS.slice(0, 5)) {
      await openAndShow(key);
      before[key] = held(key);
      messages[key] = JSON.stringify(worker().threads[key]?.messages);
      clock += 1_000;
      (sync as Sync).hide(key);
    }
    // under five minutes nothing goes
    clock += COOL_AFTER_MS - 10_000;
    await (sync as Sync).sweep();
    expect(Object.keys(worker().threads).sort()).toEqual(KEYS.slice(0, 5).sort());
    clock += 20_000;
    await (sync as Sync).sweep();
    expect(Object.keys(worker().threads).sort()).toEqual(KEYS.slice(2, 5).sort());
    expect(worker().cold[KEYS[0]]).toMatchObject({ stale: false, status: "live" });
    // back from the cache, with nothing read from the daemon, and the store and the worker are what they were
    const readsBefore = reads.length;
    for (const key of KEYS.slice(0, 2)) {
      await openAndShow(key);
      expect(held(key)).toBe(before[key] as string);
      expect(JSON.stringify(worker().threads[key]?.messages)).toBe(messages[key] as string);
    }
    expect(reads.length).toBe(readsBefore);
  });

  test("a busy thread stays warm; a released child stays in the store while its parent is drawn, and goes in time after", async () => {
    await start([KEYS[0]]);
    await openAndShow(KEYS[0]);
    (sync as Sync).hide(KEYS[0]);
    await (sync as Sync).hold(KEYS[5]);
    (sync as Sync).show(KEYS[5]);
    await until("child read", () => worker().threads[KEYS[5]]?.status === "live" && held(KEYS[5]) === mirror(KEYS[5]));
    const child = held(KEYS[5]);
    // the three closed last would stay anyway: four more closed push the busy one out of them
    for (const key of KEYS.slice(1, 5)) {
      await openAndShow(key);
      clock += 1_000;
      (sync as Sync).hide(key);
    }
    // the lane lets go of it and its parent is still drawn (live.ts keeps showing it): the store holds it as it was
    (sync as Sync).release(KEYS[5]);
    clock += COOL_AFTER_MS + 1_000;
    await (sync as Sync).sweep();
    await Bun.sleep(80);
    expect(held(KEYS[5])).toBe(child);
    expect(worker().threads[KEYS[0]]?.status).toBe("live");
    expect(worker().threads[KEYS[1]]).toBeUndefined();
    // the parent leaves the stage: the child goes from the store at once and from memory in time
    (sync as Sync).hide(KEYS[5]);
    await until("the store lets go", () => held(KEYS[5]) === "null");
    await (sync as Sync).sweep();
    expect(worker().threads[KEYS[5]]?.status).toBe("live");
    clock += COOL_AFTER_MS + 1_000;
    await (sync as Sync).sweep();
    expect(worker().cold[KEYS[5]]).toMatchObject({ stale: false });
  });
});

describe("a sweep asked for while one saves", () => {
  test("runs when that one ends, so a thread a hide pushed past the three kept is cooled in time", async () => {
    await start();
    const s = sync as Sync;
    for (const key of KEYS.slice(0, 4)) {
      await openAndShow(key);
      clock += 1_000;
      s.hide(key);
    }
    await openAndShow(KEYS[4]);
    clock += COOL_AFTER_MS + 1_000;
    // the oldest of four closed is due, so this sweep waits on a save; a fifth hide comes in the middle of it and pushes the
    // next oldest out of the three kept
    const first = s.sweep();
    s.hide(KEYS[4]);
    await first;
    await until("both cooled", () => worker().cold[KEYS[0]] !== undefined && worker().cold[KEYS[1]] !== undefined, 2_000);
    expect(Object.keys(worker().threads).sort()).toEqual(KEYS.slice(2, 5).sort());
  });
});

describe("a reset", () => {
  test("reads again only what is shown; a warm thread nobody shows goes cold and stale and is read again when it is opened", async () => {
    await start();
    await openAndShow(KEYS[0]);
    await openAndShow(KEYS[1]);
    const shown = held(KEYS[1]);
    (sync as Sync).hide(KEYS[0]);
    // the reset lands at once, so only a thread already on disk as memory holds it goes cold
    await (sync as Sync).save();
    reads = [];
    push({ type: "reset", epoch: "j2", seq: 9, reason: "epoch", fleet: snapshot() }, "j2:9");
    await until("the reset", () => worker().cursor?.epoch === "j2");
    expect(worker().cold[KEYS[0]]).toMatchObject({ stale: true });
    expect(worker().threads[KEYS[0]]).toBeUndefined();
    await until("the shown one read again", () => worker().threads[KEYS[1]]?.status === "live");
    expect(reads).toEqual([KEYS[1]]);
    // read again and the same: the ui's store is as it was, key order and all
    await until("its store", () => held(KEYS[1]) === shown);
    await openAndShow(KEYS[0]);
    expect(reads).toEqual([KEYS[1], KEYS[0]]);
  });

  test("lands at once, with no save first: a thread nobody shows that is not yet on disk is read again, as every thread was", async () => {
    await start();
    await openAndShow(KEYS[0]);
    await openAndShow(KEYS[1]);
    (sync as Sync).hide(KEYS[0]);
    await (sync as Sync).save();
    // a message joins the hidden thread, and the reset follows before any save could write it
    push({ type: "message", seq: 2, key: KEYS[0], upstream: 60, info: { id: "msg_zz_new", sessionID: "ses_a", role: "assistant", time: { created: 9 } } }, "j1:2");
    reads = [];
    push({ type: "reset", epoch: "j2", seq: 9, reason: "epoch", fleet: snapshot([KEYS[2]]) }, "j2:9");
    // the snapshot's fleet reaches the store with the worker's next frame, waiting on no save
    await until("the reset", () => worker().cursor?.epoch === "j2");
    await until("the snapshot in the store", () => ui.fleet.sessions[KEYS[2]]?.status?.type === "busy", 200);
    expect(worker().cold[KEYS[0]]).toBeUndefined();
    await until("both read again", () => reads.length === 2);
    expect([...reads].sort()).toEqual([KEYS[0], KEYS[1]]);
  });
});
