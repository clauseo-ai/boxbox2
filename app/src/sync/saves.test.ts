/* the worker's save path (cache.ts, `Saver` and `Cache.save`) against what
   it saves: a recorded stream is replayed through the reducer, marked and
   saved as the worker does, and at every save the database read back the
   way a reload reads it holds exactly the state that was saved, down to the
   order of every object's keys; with long answers streamed into it, a save
   that dies between any two of its writes leaves the save before. a
   database written by the builds before v6 (fixtures/cache-v3.json,
   cache-v4.json and cache-v5.json, captured from those builds' cache.ts)
   opens with its fleet, threads and cursor gone and its drafts, photos,
   outbox and prefs kept byte for byte, and saves asked for while one
   commits are merged into one, losing nothing. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Cache, CHUNKS, cleanDirty, layout, markPatches, PAGE, Saver } from "./cache";
import { OPENED, recordedSteps, type Recording, type Step } from "./fixtures/saves";
import type { Message } from "./protocol";
import { type Effect, INITIAL_STATE, type Patch, type SyncState, type Thread } from "./reducer";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const messagesOf = (path: string) => (JSON.parse(read(path)) as { messages: unknown[] }).messages;
const recording: Recording = {
  tape: gunzipSync(readFileSync(join(import.meta.dir, "../../../server/goldens/protocol3/journal.sse.gz"))).toString("utf8"),
  deploy: messagesOf("../ui/thread/fixtures/cmx-deploy.json"),
  notes: messagesOf("../ui/thread/fixtures/notes-asks.json"),
};

async function wipe() {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("boxbox");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function openCache(): Promise<Cache> {
  const cache = await Cache.open();
  if (!cache) throw new Error("the cache did not open");
  return cache;
}

let opened: Cache[] = [];
const track = (cache: Cache) => {
  opened.push(cache);
  return cache;
};

beforeEach(wipe);
afterEach(() => {
  for (const cache of opened) cache.close();
  opened = [];
});

/** the head a held thread's record reads back as */
const headOf = (thread: Thread) => ({
  key: thread.key,
  status: thread.status,
  hydration: thread.hydration,
  upstreamEpoch: thread.upstreamEpoch,
  hydratedAt: thread.hydratedAt,
  lastUpstream: thread.lastUpstream,
  baseline: thread.baseline,
  refetching: Object.keys(thread.refetching),
  openedAt: thread.openedAt,
  heldAt: thread.heldAt,
  leased: false,
  bytes: thread.bytes,
  sized: true,
  pages: layout(thread.messages.length).length - 1,
  stale: false,
  ...(thread.left === undefined ? {} : { left: thread.left }),
  ...(thread.etag === undefined ? {} : { etag: thread.etag }),
});

/** a value as the order of its keys and its leaves, all the way down: two values alike here are alike down to the order
    `Object.keys` gives, which `toStrictEqual` does not compare */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") return Object.keys(value).map((key) => [key, ordered((value as Record<string, unknown>)[key])]);
  return value;
}

/** what a reload reads, from a connection of its own, is the state saved: the cursor, the counters, the fleet down to the
    order of its keys, every head, and every page with the chunks streamed onto it, down to the order of every key */
async function expectLoads(state: SyncState) {
  const reader = await openCache();
  try {
    const booted = await reader.loadBoot();
    expect(booted.cursor).toStrictEqual(state.cursor);
    expect(booted.counters).toStrictEqual(state.counters);
    expect(booted.fleet).toStrictEqual(state.fleet);
    expect(ordered(booted.fleet)).toStrictEqual(ordered(state.fleet));
    const fleet = booted.fleet ?? INITIAL_STATE.fleet;
    expect(Object.keys(fleet)).toEqual(Object.keys(state.fleet));
    expect(Object.keys(fleet.threads)).toEqual(Object.keys(state.fleet.threads));
    expect(Object.keys(fleet.asks)).toEqual(Object.keys(state.fleet.asks));
    expect(Object.keys(fleet.agents)).toEqual(Object.keys(state.fleet.agents));
    expect(booted.heads.map((h) => h.key).sort()).toEqual([...Object.keys(state.threads), ...Object.keys(state.cold)].sort());
    for (const head of booted.heads) {
      const thread = state.threads[head.key];
      if (!thread) {
        expect(head).toMatchObject({ ...state.cold[head.key], leased: false });
        continue;
      }
      expect(head).toStrictEqual(headOf(thread));
      expect(ordered(head.baseline)).toStrictEqual(ordered(thread.baseline));
      const messages = await reader.loadPages(head);
      expect(messages).toStrictEqual(thread.messages);
      expect(ordered(messages)).toStrictEqual(ordered(thread.messages));
    }
  } finally {
    reader.close();
  }
}

/** what the worker does with a step: its patches and effects mark what changed (worker.ts, `dispatch` and `run`) */
function markStep(saver: Saver, step: Step) {
  if (step.action.type === "restored") {
    if (step.action.messages === null) saver.markThread(step.action.key, 0);
    else if (step.effects.length > 0) saver.markThread(step.action.key, Number.POSITIVE_INFINITY);
  } else saver.mark(step.patches);
  for (const effect of step.effects as Effect[]) {
    if (effect.type === "evicted") saver.markThread(effect.key, 0);
    if (effect.type === "head") saver.markThread(effect.key, Number.POSITIVE_INFINITY);
  }
}

describe("the save path replays a recorded stream", () => {
  test("at every save, what loads is what was saved, across a reload of the writer halfway", async () => {
    let cache = track(await openCache());
    let state = INITIAL_STATE;
    const saver = new Saver(() => cache, () => state, 200);
    const steps = [...recordedSteps(recording)];
    let saves = 0;
    for (const step of steps) {
      state = step.state;
      markStep(saver, step);
      // a save every few actions, as the 200 ms timer lands under a steady stream; an odd period moves the save points
      // across messages and pages
      if (step.index % 29 !== 28) continue;
      await saver.save();
      saves++;
      await expectLoads(state);
      if (step.index === Math.floor(steps.length / 2) - (Math.floor(steps.length / 2) % 29) + 28) {
        // the page reloads: a new connection that knows the disk only from what it reads
        cache.close();
        cache = track(await openCache());
        const booted = await cache.loadBoot();
        for (const head of booted.heads) await cache.loadPages(head);
      }
    }
    await saver.save();
    await expectLoads(state);
    expect(saves).toBeGreaterThan(80);
    expect(Object.keys(state.threads).length).toBe(3);
  }, 60_000);

  test("a fleet the size of a real one saves and loads the same", async () => {
    const cache = track(await openCache());
    let state = INITIAL_STATE;
    const saver = new Saver(() => cache, () => state, 200);
    let n = 0;
    for (const step of recordedSteps(recording, { pad: 300 })) {
      state = step.state;
      markStep(saver, step);
      if (++n % 120 !== 0) continue;
      await saver.save();
      await expectLoads(state);
    }
    await saver.save();
    await expectLoads(state);
    // the tape's thousand threads and the three hundred it was padded with
    expect(Object.keys(state.fleet.threads).length).toBe(1300);
  }, 60_000);
});

/** the puts indexeddb was asked for, by store and key */
function watchPuts() {
  const puts: { store: string; key: string; value: unknown }[] = [];
  const proto = IDBObjectStore.prototype;
  const original = proto.put;
  proto.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    puts.push({ store: this.name, key: String(key), value });
    return original.call(this, value, key);
  };
  return { puts, stop: () => void (proto.put = original) };
}

const message = (n: number, text = ""): Message => ({
  info: { id: `msg_${String(n).padStart(4, "0")}`, role: "assistant", created: n },
  parts: text ? [{ id: `prt_${n}`, messageID: `msg_${String(n).padStart(4, "0")}`, type: "text", text }] : [],
});

const thread = (key: string, messages: Message[]): Thread => ({
  key,
  status: "live",
  hydration: 1,
  upstreamEpoch: "u1",
  hydratedAt: 10,
  lastUpstream: 10,
  messages,
  baseline: {},
  buffer: [],
  refetching: {},
  openedAt: 5,
  heldAt: 0,
  leased: false,
  bytes: 1234,
  trouble: null,
});

const withThread = (t: Thread, seq: number): SyncState => ({ ...INITIAL_STATE, cursor: { epoch: "j1", seq }, threads: { [t.key]: t } });

describe("a streaming thread's pages", () => {
  test("the layout covers every message once, the last alone, and a message joining the end rewrites a few others at most", () => {
    let rewritten = 0;
    let old = layout(0);
    for (let count = 1; count <= 500; count++) {
      const starts = layout(count);
      expect(starts[0]).toBe(0);
      expect(starts[starts.length - 1]).toBe(count);
      expect(starts[starts.length - 2]).toBe(count - 1);
      for (let page = 0; page + 1 < starts.length; page++) {
        const start = starts[page] ?? 0;
        const end = starts[page + 1] ?? 0;
        expect(end - start).toBeGreaterThan(0);
        expect(end - start).toBeLessThanOrEqual(PAGE);
        // what a save after the new message rewrites besides it: every page that is not the same page as before
        if (old[page] !== start || old[page + 1] !== end) rewritten += Math.min(end, count - 1) - start;
      }
      expect(starts.length - 1).toBeLessThanOrEqual(Math.ceil(count / PAGE) + 7);
      old = starts;
    }
    // with fifty to the end, each new message rewrote the 24 before it on average; here each is rewritten a few times in all
    expect(rewritten / 500).toBeLessThan(4);
  });

  test("a change to the last message writes that message alone, not its page", async () => {
    const cache = track(await openCache());
    let t = thread("bench:a", Array.from({ length: 120 }, (_, i) => message(i, `words ${i}`)));
    let state = withThread(t, 1);
    const saver = new Saver(() => cache, () => state, 200);
    saver.markThread(t.key, 0);
    await saver.save();
    const watch = watchPuts();
    for (let tick = 0; tick < 5; tick++) {
      const last = t.messages.length - 1;
      t = { ...t, messages: [...t.messages.slice(0, last), message(last, `words ${last} and more ${tick}`)] };
      state = withThread(t, 2 + tick);
      saver.mark([{ path: ["threads", t.key, "messages", last, "parts", 0, "text"], value: "" }]);
      await saver.save();
    }
    watch.stop();
    const pages = watch.puts.filter((p) => p.store === "threads" && !p.key.endsWith("#head"));
    // the last page is the last message's alone (cache.ts, `layout`)
    expect(pages.map((p) => p.key)).toEqual(Array(5).fill(`bench:a#${layout(120).length - 2}`));
    expect(pages.every((p) => Array.isArray(p.value) && p.value.length === 1)).toBe(true);
    await expectLoads(state);
  });

  test("pages laid fifty to the end (the layout before v4) read as they are, and a save after them rewrites only what moved", async () => {
    // pages of fifty to the end, which `loadPages` reads as it reads any layout
    const before = Array.from({ length: 120 }, (_, i) => message(i, `w${i}`));
    (await openCache()).close();
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("boxbox");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction("threads", "readwrite");
      const store = tx.objectStore("threads");
      for (let page = 0; page < 3; page++) store.put(before.slice(page * 50, (page + 1) * 50), `bench:a#${page}`);
      const { baseline, ...head } = headOf(thread("bench:a", before));
      store.put({ ...head, pages: 3 }, "bench:a#head");
      store.put(baseline, "bench:a#base");
      tx.oncomplete = () => resolve();
    });
    raw.close();
    const cache = track(await openCache());
    const [head] = (await cache.loadBoot()).heads;
    if (!head) throw new Error("no head");
    expect(head.pages).toBe(3);
    expect(await cache.loadPages(head)).toStrictEqual(before);
    let t = thread("bench:a", [...before, message(120, "new")]);
    let state = withThread(t, 3);
    const saver = new Saver(() => cache, () => state, 200);
    const watch = watchPuts();
    saver.markThread(t.key, 120);
    await saver.save();
    // pages 0 and 1 hold what they held; the old last page [100, 120) becomes [100, 116) and [116, 120), and the new
    // message has a page of its own
    expect(layout(121)).toEqual([0, 50, 100, 116, 120, 121]);
    expect(watch.puts.filter((p) => p.store === "threads" && !p.key.endsWith("#head")).map((p) => p.key)).toEqual(["bench:a#2", "bench:a#3", "bench:a#4"]);
    await expectLoads(state);
    t = { ...t, messages: [...t.messages, message(121, "newer")] };
    state = withThread(t, 4);
    saver.markThread(t.key, 121);
    watch.puts.length = 0;
    await saver.save();
    // message 120 keeps its page, now one of the small ones before the last, and 121 has the next page alone
    expect(layout(122)).toEqual([0, 50, 100, 116, 120, 121, 122]);
    expect(watch.puts.filter((p) => p.store === "threads" && !p.key.endsWith("#head")).map((p) => p.key)).toEqual(["bench:a#5"]);
    watch.stop();
    await expectLoads(state);
    t = { ...t, messages: t.messages.slice(0, 30) };
    state = withThread(t, 5);
    saver.markThread(t.key, 0);
    await saver.save();
    await expectLoads(state);
  });
});

describe("the fleet's records", () => {
  test("a changed thread writes that thread alone, and a thread that goes and comes back keeps its new place", async () => {
    const cache = track(await openCache());
    const steps = [...recordedSteps(recording, { histories: false, pad: 50 })];
    let state: SyncState = { ...(steps[steps.length - 1]?.state ?? INITIAL_STATE), threads: {}, cold: {} };
    const saver = new Saver(() => cache, () => state, 200);
    saver.mark([{ path: ["fleet"], value: null }]);
    await saver.save();
    const keys = Object.keys(state.fleet.threads);
    const first = keys[0] ?? "";
    const entry = state.fleet.threads[first];
    if (!entry) throw new Error("no thread");
    const watch = watchPuts();
    state = { ...state, cursor: { epoch: "j1", seq: 900 }, fleet: { ...state.fleet, threads: { ...state.fleet.threads, [first]: { ...entry, agents: 3 } } } };
    // a patch at any depth names the same record
    saver.mark([{ path: ["fleet", "threads", first, "agents"], value: 3 }]);
    await saver.save();
    expect(watch.puts.filter((p) => p.store === "fleet").map((p) => p.key)).toEqual([`threads:${first}`]);
    await expectLoads(state);
    // gone and back within one save: same keys, another order
    const { [first]: _gone, ...rest } = state.fleet.threads;
    state = { ...state, cursor: { epoch: "j1", seq: 901 }, fleet: { ...state.fleet, threads: { ...rest, [first]: entry } } };
    saver.mark([{ path: ["fleet", "threads", first], value: undefined }, { path: ["fleet", "threads", first], value: entry }]);
    watch.puts.length = 0;
    await saver.save();
    expect(watch.puts.filter((p) => p.store === "fleet").map((p) => p.key).sort()).toEqual(["index", `threads:${first}`]);
    await expectLoads(state);
    // gone for good, an ask raised, the order and the colours changed
    const second = keys[1] ?? "";
    const { [second]: _left, ...remaining } = state.fleet.threads;
    const ask = Object.values(steps.find((s) => Object.keys(s.state.fleet.asks).length > 0)?.state.fleet.asks ?? {})[0];
    if (!ask) throw new Error("the journal raised no ask");
    state = {
      ...state,
      cursor: { epoch: "j1", seq: 902 },
      fleet: { ...state.fleet, threads: remaining, asks: { ...state.fleet.asks, "bench:ask_new": ask }, order: [...state.fleet.order].reverse(), colours: {} },
    };
    saver.mark([
      { path: ["fleet", "threads", second], value: undefined },
      { path: ["fleet", "asks", "bench:ask_new"], value: ask },
      { path: ["fleet", "order"], value: state.fleet.order },
      { path: ["fleet", "colours"], value: {} },
    ]);
    watch.puts.length = 0;
    await saver.save();
    watch.stop();
    expect(watch.puts.filter((p) => p.store === "fleet").map((p) => p.key).sort()).toEqual(["asks:bench:ask_new", "field:colours", "field:order", "index"]);
    await expectLoads(state);
  });

  test("patches name the records they change at any depth", () => {
    const dirty = cleanDirty();
    markPatches(dirty, [
      { path: ["fleet", "threads", "h:a"], value: null },
      { path: ["fleet", "threads", "h:b", "tail"], value: [] },
      { path: ["fleet", "asks", "h:q"], value: undefined },
      { path: ["fleet", "agents", "h"], value: null },
      { path: ["fleet", "colours", "h:/r"], value: null },
      { path: ["fleet", "order"], value: [] },
      { path: ["threads", "h:a", "messages", 7, "parts", 0, "text"], value: "x" },
      { path: ["threads", "h:a", "messages", 9], value: null },
      { path: ["threads", "h:b", "status"], value: "hydrating" },
      { path: ["threads", "h:c", "trouble"], value: null },
      { path: ["threads", "h:d"], value: null },
      { path: ["threads", "h:e", "messages"], value: [] },
    ]);
    expect(dirty.fleet).toBe(false);
    expect([...dirty.entries.threads]).toEqual(["h:a", "h:b"]);
    expect([...dirty.entries.asks]).toEqual(["h:q"]);
    expect([...dirty.entries.agents]).toEqual(["h"]);
    expect([...dirty.fields]).toEqual(["colours", "order"]);
    expect(Object.fromEntries(dirty.threads)).toEqual({ "h:a": 7, "h:b": Number.POSITIVE_INFINITY, "h:c": Number.POSITIVE_INFINITY, "h:d": 0, "h:e": 0 });
    markPatches(dirty, [{ path: ["fleet", "threads"], value: {} }]);
    expect(dirty.fleet).toBe(true);
  });

  test("an append to a part's text marks that text from where the disk has it, and the head, not the message", () => {
    const dirty = cleanDirty();
    markPatches(dirty, [
      { path: ["threads", "h:a", "messages", 7, "parts", 0, "text"], append: "more", from: 10 },
      { path: ["threads", "h:a", "messages", 7, "parts", 0, "text"], append: " again", from: 14 },
      { path: ["threads", "h:a", "messages", 7, "parts", 1, "text"], append: "x", from: 0 },
      // an append at another depth is a change to its message, as a set there is
      { path: ["threads", "h:b", "messages", 3, "text"], append: "y", from: 2 },
    ]);
    expect(Object.fromEntries(dirty.threads)).toEqual({ "h:a": Number.POSITIVE_INFINITY, "h:b": 3 });
    expect([...(dirty.appends.get("h:a")?.values() ?? [])]).toEqual([
      { at: 7, part: 0, field: "text", from: 10 },
      { at: 7, part: 1, field: "text", from: 0 },
    ]);
    expect(dirty.appends.has("h:b")).toBe(false);
  });
});

type Dump = { version: number; stores: Record<string, [string, unknown][]>; loaded: { boot: unknown; pages: Record<string, unknown> } };

/** a database as an earlier build left it: its stores at its version, every record as the dump holds it */
async function install(path: string, version: number): Promise<Dump> {
  const dump = JSON.parse(read(path)) as Dump;
  expect(dump.version).toBe(version);
  const raw = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("boxbox", dump.version);
    request.onupgradeneeded = () => {
      for (const store of ["meta", "fleet", "threads", "drafts", "draftPhotos", "outbox", "prefs"]) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve) => {
    const tx = raw.transaction(Object.keys(dump.stores), "readwrite");
    for (const [name, records] of Object.entries(dump.stores)) for (const [key, value] of records) tx.objectStore(name).put(value, key);
    tx.oncomplete = () => resolve();
  });
  raw.close();
  return dump;
}

/** a store's records as they lie, read from a connection of its own */
async function records(store: string): Promise<Map<string, unknown>> {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("boxbox");
    request.onsuccess = () => resolve(request.result);
  });
  const tx = db.transaction(store, "readonly");
  const [keys, values] = await Promise.all([
    new Promise<IDBValidKey[]>((resolve) => {
      const all = tx.objectStore(store).getAllKeys();
      all.onsuccess = () => resolve(all.result);
    }),
    new Promise<unknown[]>((resolve) => {
      const all = tx.objectStore(store).getAll();
      all.onsuccess = () => resolve(all.result);
    }),
  ]);
  db.close();
  return new Map(keys.map((key, i) => [String(key), values[i]]));
}

/** the stores an upgrade to v6 keeps, record for record */
const KEPT = ["drafts", "draftPhotos", "outbox", "prefs"] as const;

describe("the upgrade to v6 (docs/protocol.md, the app's indexeddb)", () => {
  for (const [path, version] of [
    ["fixtures/cache-v3.json", 3],
    ["fixtures/cache-v4.json", 4],
    ["fixtures/cache-v5.json", 5],
  ] as const) {
    test(`a database v${version} wrote opens with its fleet, threads and cursor gone, its drafts, photos, outbox and prefs as they were, and an empty media store`, async () => {
      const dump = await install(path, version);
      // what goes was there: contract 1's fleet, cmx2's transcripts, and a cursor into the old journal
      expect(dump.stores.fleet?.length).toBeGreaterThan(0);
      expect(dump.stores.threads?.length).toBeGreaterThan(0);
      expect(new Map(dump.stores.meta ?? []).has("sync")).toBe(true);
      const cache = track(await openCache());
      expect(await cache.loadBoot()).toStrictEqual({ cursor: null, counters: null, fleet: null, heads: [] });
      for (const store of ["fleet", "threads", "media"]) expect((await records(store)).size).toBe(0);
      expect((await records("meta")).has("sync")).toBe(false);
      for (const store of KEPT) expect([...(await records(store))]).toStrictEqual(dump.stores[store] ?? []);
      // the first connect's reset and reads save on from an empty cache, in the new shapes
      const t = { ...thread("bench:ses_new", [message(0, "the first words")]), left: 12, etag: '"3.e1.12.q"' };
      const state: SyncState = { ...withThread(t, 12), fleet: { ...INITIAL_STATE.fleet, agentNames: ["bench"], order: [t.key] } };
      const saver = new Saver(() => cache, () => state, 200);
      saver.mark([{ path: ["fleet"], value: null }]);
      saver.markThread(t.key, 0);
      await saver.save();
      await expectLoads(state);
    });
  }

  test("v5's drafts, outbox, telemetry rows and replies read back as that build read them", async () => {
    const dump = await install("fixtures/cache-v5.json", 5);
    const cache = track(await openCache());
    const composer = await cache.loadComposer("bench:ses_draft");
    expect(composer.drafts["bench:ses_draft"]).toMatchObject({ text: "half a thought", photos: [{ filename: "a.jpg" }] });
    const outbox = new Map(dump.stores.outbox ?? []);
    expect(composer.outbox as unknown[]).toStrictEqual([outbox.get("c0ffee00-0000-4000-8000-000000000001")]);
    expect(composer.rows as unknown[]).toStrictEqual([outbox.get("row:row_1")]);
    expect(composer.replies).toStrictEqual([outbox.get("ask:bench:ses_draft toolu_1")]);
  });
});

describe("the save's wait", () => {
  test("is the short one until a save takes streamed words, and the streaming one while they keep coming", async () => {
    const cache = track(await openCache());
    let t = thread("bench:s", [message(0, "the answer")]);
    let state = withThread(t, 1);
    let saves = 0;
    const saver = new Saver(() => cache, () => state, 10, () => saves++, 400);
    const settled = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    saver.markThread(t.key, 0);
    saver.schedule();
    await settled(100);
    expect(saves).toBe(1);
    const grown = grow(t, 0, " more");
    t = grown.thread;
    state = withThread(t, 2);
    saver.mark([grown.patch]);
    saver.schedule();
    await settled(100);
    expect(saves).toBe(1);
    await settled(400);
    expect(saves).toBe(2);
    // a session tick after streamed words waits as long: the part is still streaming
    state = withThread(t, 3);
    saver.markThread(t.key, Number.POSITIVE_INFINITY);
    saver.schedule();
    await settled(100);
    expect(saves).toBe(2);
    await settled(400);
    expect(saves).toBe(3);
    // the save before took no words: the short wait again
    saver.markThread(t.key, Number.POSITIVE_INFINITY);
    saver.schedule();
    await settled(100);
    expect(saves).toBe(4);
    saver.stop();
  });
});

describe("saves asked for while one commits", () => {
  test("are merged into one save after it, which writes all they marked from the state as it is then", async () => {
    const cache = track(await openCache());
    const real = cache.save.bind(cache);
    const calls: { seq: number | undefined; threads: string[] }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    cache.save = async (state, dirty) => {
      calls.push({ seq: state.cursor?.seq, threads: [...dirty.threads.keys()] });
      if (calls.length === 1) await gate;
      return real(state, dirty);
    };
    let state: SyncState = { ...INITIAL_STATE, cursor: { epoch: "j1", seq: 1 } };
    const saver = new Saver(() => cache, () => state, 200);
    const add = (n: number) => {
      const t = thread(`bench:t${n}`, [message(n, `t${n}`)]);
      state = { ...state, cursor: { epoch: "j1", seq: n }, threads: { ...state.threads, [t.key]: t } };
      saver.mark([{ path: ["threads", t.key], value: null }]);
    };
    add(1);
    const first = saver.save();
    expect(saver.pending).toBe(1);
    const later: Promise<void>[] = [];
    for (let n = 2; n <= 6; n++) {
      add(n);
      later.push(saver.save());
    }
    expect(saver.pending).toBe(2);
    // every save asked for meanwhile is the one that follows
    expect(new Set(later).size).toBe(1);
    release();
    await first;
    await Promise.all(later);
    expect(saver.pending).toBe(0);
    expect(calls).toEqual([
      { seq: 1, threads: ["bench:t1"] },
      { seq: 6, threads: ["bench:t2", "bench:t3", "bench:t4", "bench:t5", "bench:t6"] },
    ]);
    await expectLoads(state);
  });

  test("a save that fails leaves what it held marked, and the next writes it", async () => {
    const cache = track(await openCache());
    const real = cache.save.bind(cache);
    let fail = true;
    cache.save = async (state, dirty) => {
      if (fail) throw new Error("the disk is full");
      return real(state, dirty);
    };
    const t = thread("bench:a", [message(0, "a")]);
    const state: SyncState = { ...withThread(t, 3), fleet: { ...INITIAL_STATE.fleet, order: ["bench:a"] } };
    const saver = new Saver(() => cache, () => state, 10_000);
    saver.mark([{ path: ["threads", t.key], value: null }, { path: ["fleet"], value: null }]);
    await saver.save();
    fail = false;
    await saver.save();
    saver.stop();
    await expectLoads(state);
  });

  test("a save with nothing marked and the cursor where it was writes nothing", async () => {
    const cache = track(await openCache());
    const state = withThread(thread("bench:a", [message(0)]), 3);
    const saver = new Saver(() => cache, () => state, 200);
    saver.markThread("bench:a", 0);
    await saver.save();
    const watch = watchPuts();
    await saver.save();
    watch.stop();
    expect(watch.puts).toEqual([]);
  });

  test("a listener that throws loses its count, not the saves after it", async () => {
    const cache = track(await openCache());
    let state = withThread(thread("bench:a", [message(0)]), 3);
    const saver = new Saver(() => cache, () => state, 200, () => {
      throw new Error("the tally broke");
    });
    saver.markThread("bench:a", 0);
    await saver.save();
    state = withThread(thread("bench:a", [message(0), message(1)]), 4);
    saver.markThread("bench:a", 1);
    await saver.save();
    expect(saver.pending).toBe(0);
    await expectLoads(state);
  });

  test("a save that throws part way keeps nothing, the cursor least of all", async () => {
    const cache = track(await openCache());
    const before = withThread(thread("bench:a", [message(0, "kept")]), 3);
    let state = before;
    const saver = new Saver(() => cache, () => state, 10_000);
    saver.markThread("bench:a", 0);
    await saver.save();
    // a value structured clone refuses, after the fleet's change was put in the same transaction
    const bad = { ...message(1), info: { ...message(1).info, clone: () => undefined } } as unknown as Message;
    state = { ...withThread(thread("bench:a", [message(0, "kept"), bad]), 4), fleet: { ...INITIAL_STATE.fleet, order: ["bench:a"] } };
    saver.mark([{ path: ["fleet", "order"], value: ["bench:a"] }, { path: ["threads", "bench:a", "messages", 1], value: null }]);
    await saver.save();
    saver.stop();
    await expectLoads(before);
  });
});

/** two writers on one database: two tabs, or a page reloading while the last save of the one before commits. each has its
    own memory of the disk, and a save must not trust it once the other wrote */
describe("two writers on one database", () => {
  test("a stale writer's save to its last message leaves its thread whole, not one message twice", async () => {
    const a = track(await openCache());
    const b = track(await openCache());
    const sixty = Array.from({ length: 60 }, (_, i) => message(i, `m${i}`));
    let stateA = withThread(thread("bench:x", sixty), 1);
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.markThread("bench:x", 0);
    await saverA.save();
    // b loaded the same disk: it knows the thread's pages as a wrote them
    const [head] = (await b.loadBoot()).heads;
    if (!head) throw new Error("no head");
    expect(await b.loadPages(head)).toStrictEqual(sixty);
    // a gets message 61
    stateA = withThread(thread("bench:x", [...sixty, message(60, "m60")]), 2);
    saverA.markThread("bench:x", 60);
    await saverA.save();
    // b, still at 60, gets a delta to its last message
    const stateB = withThread(thread("bench:x", [...sixty.slice(0, 59), message(59, "m59 and more")]), 2);
    const saverB = new Saver(() => b, () => stateB, 200);
    saverB.markThread("bench:x", 59);
    await saverB.save();
    await expectLoads(stateB);
    // and a, writing again over b, leaves its own whole
    stateA = withThread(thread("bench:x", [...sixty, message(60, "m60 and more")]), 3);
    saverA.markThread("bench:x", 60);
    await saverA.save();
    await expectLoads(stateA);
  });

  test("a thread one writer added and the other added and removed in one save is gone, not undefined", async () => {
    const steps = [...recordedSteps(recording, { histories: false })];
    const base: SyncState = { ...(steps[steps.length - 1]?.state ?? INITIAL_STATE), threads: {}, cold: {}, cursor: { epoch: "j1", seq: 1 } };
    const a = track(await openCache());
    const b = track(await openCache());
    let stateA = base;
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.mark([{ path: ["fleet"], value: null }]);
    await saverA.save();
    await b.loadBoot();
    const entry = Object.values(base.fleet.threads)[0];
    if (!entry) throw new Error("no thread");
    const k = { ...entry, key: "h:k", id: "k" };
    stateA = { ...base, cursor: { epoch: "j1", seq: 2 }, fleet: { ...base.fleet, threads: { ...base.fleet.threads, "h:k": k } } };
    saverA.mark([{ path: ["fleet", "threads", "h:k"], value: k }]);
    await saverA.save();
    // b applies the add and the removal inside one window
    const stateB: SyncState = { ...base, cursor: { epoch: "j1", seq: 3 } };
    const saverB = new Saver(() => b, () => stateB, 200);
    saverB.mark([
      { path: ["fleet", "threads", "h:k"], value: k },
      { path: ["fleet", "threads", "h:k"], value: undefined },
    ]);
    await saverB.save();
    await expectLoads(stateB);
    // the other way: a drops a thread b still has and changes; b's save brings it back whole, with b's cursor
    const gone = Object.keys(base.fleet.threads)[0] ?? "";
    const { [gone]: _dropped, ...rest } = base.fleet.threads;
    stateA = { ...base, cursor: { epoch: "j1", seq: 4 }, fleet: { ...base.fleet, threads: rest } };
    saverA.mark([{ path: ["fleet", "threads", gone], value: undefined }]);
    await saverA.save();
    const changed: SyncState = { ...stateB, cursor: { epoch: "j1", seq: 4 }, fleet: { ...base.fleet, threads: { ...base.fleet.threads, [gone]: { ...entry, agents: 9 } } } };
    const saverB2 = new Saver(() => b, () => changed, 200);
    saverB2.mark([{ path: ["fleet", "threads", gone, "agents"], value: 9 }]);
    await saverB2.save();
    await expectLoads(changed);
  });

  test("a cold thread's head written after another writer counts the pages on disk, and is read again when opened", async () => {
    const a = track(await openCache());
    const b = track(await openCache());
    const messages = (count: number) => Array.from({ length: count }, (_, i) => message(i, `m${i}`));
    let stateA = withThread(thread("bench:x", messages(60)), 1);
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.markThread("bench:x", 0);
    await saverA.save();
    // b has the thread cold, as a's save left it
    const [cold] = (await b.loadBoot()).heads;
    if (!cold) throw new Error("no head");
    // a grows it to 62 messages, which lays out one page more
    stateA = withThread(thread("bench:x", messages(62)), 3);
    saverA.markThread("bench:x", 60);
    await saverA.save();
    expect(layout(62).length).toBeGreaterThan(layout(60).length);
    // b holds it again: only its head's recency changed
    const stateB: SyncState = { ...INITIAL_STATE, cursor: { epoch: "j1", seq: 2 }, cold: { "bench:x": { ...cold, heldAt: 99 } } };
    const saverB = new Saver(() => b, () => stateB, 200);
    saverB.markThread("bench:x", Number.POSITIVE_INFINITY);
    await saverB.save();
    const reader = track(await openCache());
    const [head] = (await reader.loadBoot()).heads;
    if (!head) throw new Error("no head");
    expect(head).toMatchObject({ key: "bench:x", pages: layout(62).length - 1, heldAt: 99, stale: true });
    // the pages are a's, whole and in order; stale, the thread is read from the daemon again when it is opened
    expect(await reader.loadPages(head)).toStrictEqual(messages(62));
  });

  test("a cold head written saves after another writer was seen still counts that writer's pages, and is read again", async () => {
    const a = track(await openCache());
    const b = track(await openCache());
    const messages = (count: number) => Array.from({ length: count }, (_, i) => message(i, `m${i}`));
    let stateA = withThread(thread("bench:x", messages(60)), 1);
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.markThread("bench:x", 0);
    await saverA.save();
    // b boots with x cold, as a left it
    const [cold] = (await b.loadBoot()).heads;
    if (!cold) throw new Error("no head");
    // a grows x to 62 messages, one page more
    stateA = withThread(thread("bench:x", messages(62)), 3);
    saverA.markThread("bench:x", 60);
    await saverA.save();
    expect(layout(62).length).toBeGreaterThan(layout(60).length);
    // b's first save touches another thread only: it sees a's save there
    const y = thread("bench:y", [message(0, "y")]);
    let stateB: SyncState = { ...INITIAL_STATE, cursor: { epoch: "j1", seq: 4 }, threads: { [y.key]: y }, cold: { "bench:x": cold } };
    const saverB = new Saver(() => b, () => stateB, 200);
    saverB.markThread(y.key, 0);
    await saverB.save();
    // b, in a later save of its own, writes x's cold head for its hold time alone
    stateB = { ...stateB, cursor: { epoch: "j1", seq: 5 }, cold: { "bench:x": { ...cold, heldAt: 99 } } };
    saverB.markThread("bench:x", Number.POSITIVE_INFINITY);
    await saverB.save();
    // nor does b read x's pages by the count it holds: it is read from the daemon
    expect(await b.loadPages(cold)).toBeNull();
    const reader = track(await openCache());
    const head = (await reader.loadBoot()).heads.find((h) => h.key === "bench:x");
    if (!head) throw new Error("no head");
    expect(head).toMatchObject({ pages: layout(62).length - 1, heldAt: 99, stale: true });
    expect(await reader.loadPages(head)).toStrictEqual(messages(62));
    // once b writes x whole (its read from the daemon), x is b's own again: its head is b's and its pages read as b wrote them
    const x = thread("bench:x", messages(61));
    stateB = { ...stateB, cursor: { epoch: "j1", seq: 6 }, threads: { [y.key]: y, [x.key]: x }, cold: {} };
    saverB.markThread(x.key, 0);
    await saverB.save();
    await expectLoads(stateB);
  });

  test("a cold head written after another writer leaves that writer's baseline with its pages", async () => {
    const a = track(await openCache());
    const b = track(await openCache());
    const messages = Array.from({ length: 3 }, (_, i) => message(i, `m${i}`));
    let stateA = withThread({ ...thread("bench:x", messages), baseline: { prt_1: 2 } }, 1);
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.markThread("bench:x", 0);
    await saverA.save();
    const [cold] = (await b.loadBoot()).heads;
    if (!cold) throw new Error("no head");
    stateA = withThread({ ...thread("bench:x", messages), baseline: { prt_1: 2, prt_2: 9 } }, 2);
    saverA.markThread("bench:x", 0);
    await saverA.save();
    const stateB: SyncState = { ...INITIAL_STATE, cursor: { epoch: "j1", seq: 3 }, cold: { "bench:x": { ...cold, heldAt: 99 } } };
    const saverB = new Saver(() => b, () => stateB, 200);
    saverB.markThread("bench:x", Number.POSITIVE_INFINITY);
    await saverB.save();
    const reader = track(await openCache());
    const [head] = (await reader.loadBoot()).heads;
    expect(head).toMatchObject({ heldAt: 99, stale: true, baseline: { prt_1: 2, prt_2: 9 } });
  });

  test("pages read while the disk holds a save this cache has not seen are not trusted", async () => {
    const a = track(await openCache());
    const b = track(await openCache());
    const messages = (count: number) => Array.from({ length: count }, (_, i) => message(i, `m${i}`));
    let stateA = withThread(thread("bench:x", messages(60)), 1);
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.markThread("bench:x", 0);
    await saverA.save();
    const [cold] = (await b.loadBoot()).heads;
    if (!cold) throw new Error("no head");
    // a writes again before b has saved at all: b's count of x's pages may be stale, so b reads none of them
    stateA = withThread(thread("bench:x", messages(62)), 2);
    saverA.markThread("bench:x", 60);
    await saverA.save();
    expect(await b.loadPages(cold)).toBeNull();
    expect(await a.loadPages({ key: "bench:x", pages: layout(62).length - 1 })).toStrictEqual(messages(62));
  });

  test("a writer that wrote last keeps writing only what changed", async () => {
    const a = track(await openCache());
    const b = track(await openCache());
    let stateA = withThread(thread("bench:x", Array.from({ length: 60 }, (_, i) => message(i, `m${i}`))), 1);
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.markThread("bench:x", 0);
    await saverA.save();
    const stateB = withThread(thread("bench:y", [message(0, "y")]), 2);
    const saverB = new Saver(() => b, () => stateB, 200);
    saverB.markThread("bench:y", 0);
    await saverB.save();
    // a's first save after b's is whole; the one after that is a's own again, and writes one page
    stateA = withThread(thread("bench:x", stateA.threads["bench:x"]?.messages.map((m, i) => (i === 59 ? message(59, "m59+") : m)) ?? []), 3);
    saverA.markThread("bench:x", 59);
    await saverA.save();
    stateA = withThread(thread("bench:x", stateA.threads["bench:x"]?.messages.map((m, i) => (i === 59 ? message(59, "m59++") : m)) ?? []), 4);
    saverA.markThread("bench:x", 59);
    const watch = watchPuts();
    await saverA.save();
    watch.stop();
    expect(watch.puts.filter((p) => p.store === "threads" && !p.key.endsWith("#head")).map((p) => p.key)).toEqual([`bench:x#${layout(60).length - 2}`]);
    const reader = track(await openCache());
    const head = (await reader.loadBoot()).heads.find((h) => h.key === "bench:x");
    if (!head) throw new Error("no head");
    expect(await reader.loadPages(head)).toStrictEqual(stateA.threads["bench:x"]?.messages ?? null);
  });
});

/** the puts and deletes the next saves ask for fail from the `at`th on, as a page that dies between two writes leaves a
    transaction that never commits */
function crashAt(at: number) {
  const proto = IDBObjectStore.prototype;
  const { put, delete: remove } = proto;
  let writes = 0;
  let crashed = false;
  const hit = () => {
    if (writes++ < at) return;
    crashed = true;
    throw new Error("the page died");
  };
  proto.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    hit();
    return put.call(this, value, key);
  };
  proto.delete = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
    hit();
    return remove.call(this, query);
  };
  return {
    crashed: () => crashed,
    stop: () => {
      proto.put = put;
      proto.delete = remove;
    },
  };
}

/** the keys the threads store holds, read from a connection of its own */
async function threadKeys(): Promise<string[]> {
  const reader = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("boxbox");
    request.onsuccess = () => resolve(request.result);
  });
  const keys = await new Promise<IDBValidKey[]>((resolve) => {
    const all = reader.transaction("threads", "readonly").objectStore("threads").getAllKeys();
    all.onsuccess = () => resolve(all.result);
  });
  reader.close();
  return keys.map(String);
}

const isChunk = (key: string) => key.includes("#+");
const isPage = (key: string) => /#\d+$/.test(key);

describe("a long answer streamed and saved at many points", () => {
  test("loads as saved at every save, and a save that dies between any two writes loads as the save before it", async () => {
    let cache = track(await openCache());
    let state = INITIAL_STATE;
    let saved = INITIAL_STATE;
    const answer = { from: Number.POSITIVE_INFINITY, saves: 0, bytes: 0, chunks: 0, pages: 0 };
    const saver = new Saver(() => cache, () => state, 200, (stats) => {
      if (state.counters.applied < answer.from) return;
      answer.saves++;
      answer.bytes += stats.bytes;
    });
    // the threads hold what streamed, so a load at every save reads the answers and not the recorded transcripts again
    // the tape's first frames only: a fleet of some sixty threads, so the loads at every save weigh the answers
    const steps = [...recordedSteps(recording, { histories: false, answer: 80_000, answers: 2, frames: 60 })];
    const last = steps[steps.length - 1];
    const watch = watchPuts();
    let saves = 0;
    let crashes = 0;
    try {
      for (const step of steps) {
        state = step.state;
        markStep(saver, step);
        if (step.action.type === "frame" && step.action.frame.type === "message" && step.action.frame.message.id.includes("_long0")) answer.from = state.counters.applied;
        if (step.index % 3 !== 2 && step !== last) continue;
        // the write a save dies at moves with each save, so the crashes land on chunks, pages, heads, deletes and the cursor
        const crash = crashAt(saves % 7);
        await saver.save();
        crash.stop();
        saver.stop();
        if (crash.crashed()) {
          crashes++;
          // before the first save there is nothing to load
          if (saves > 0) await expectLoads(saved);
          await saver.save();
        }
        saved = state;
        saves++;
        await expectLoads(state);
        if (saves === 400) {
          // the page reloads mid-answer: a new connection that knows the disk, chunks and all, only from what it reads
          cache.close();
          cache = track(await openCache());
          for (const head of (await cache.loadBoot()).heads) await cache.loadPages(head);
        }
      }
    } finally {
      watch.stop();
    }
    const streamed = state.threads[OPENED[0]]?.messages.filter((m) => m.info.id.includes("_long")) ?? [];
    expect(streamed.map((m) => (m.parts[0] as { text: string }).text.length).every((length) => length >= 24_000)).toBe(true);
    for (const { key } of watch.puts) {
      if (!key.startsWith(OPENED[0])) continue;
      if (isChunk(key)) answer.chunks++;
      else if (isPage(key)) answer.pages++;
    }
    expect(saves).toBeGreaterThan(600);
    expect(crashes).toBeGreaterThan(200);
    // the answers went to disk as chunks, past the fold floor, so each folded into its page mid-stream, and the thread's
    // pages were written a few times
    expect(answer.chunks).toBeGreaterThan(2 * CHUNKS);
    // what the saves of the two answers stored, all of it: a head and a cursor of a few hundred bytes each, and a few times
    // what streamed, where rewriting the growing message stored half an answer per save, some 12 kb
    expect(answer.saves).toBeGreaterThan(500);
    expect(answer.bytes).toBeLessThan(answer.saves * 600 + 4 * 2 * 24_000);
    await expectLoads(state);
  }, 60_000);
});

/** message `at` of `t` with `words` added at the end of its part `part`'s `field`, and the append the reducer sends for it */
function grow(t: Thread, at: number, words: string, part = 0, field = "text"): { thread: Thread; patch: Patch } {
  const target = t.messages[at];
  const held = target?.parts[part] as Record<string, unknown> | undefined;
  if (!target || !held) throw new Error("no such part");
  const had = typeof held[field] === "string" ? (held[field] as string) : "";
  const parts = [...target.parts];
  parts[part] = { ...held, [field]: had + words } as Message["parts"][number];
  const messages = [...t.messages];
  messages[at] = { info: target.info, parts };
  return { thread: { ...t, messages, bytes: t.bytes + words.length }, patch: { path: ["threads", t.key, "messages", at, "parts", part, field], append: words, from: had.length } };
}

/** each change in turn, saved: first dying at its first write, then its second, and so on until a save commits. after each
    death the disk holds the save before; after the commit, the change */
async function saveThroughCrashes(cache: Cache, changes: readonly { state: SyncState; patches: readonly Patch[] }[], first: SyncState) {
  let state = first;
  const saver = new Saver(() => cache, () => state, 200);
  let crashes = 0;
  for (const change of changes) {
    const before = state;
    state = change.state;
    saver.mark(change.patches);
    for (let at = 0; ; at++) {
      const crash = crashAt(at);
      await saver.save();
      crash.stop();
      saver.stop();
      if (!crash.crashed()) break;
      crashes++;
      await expectLoads(before);
    }
    await expectLoads(state);
  }
  return crashes;
}

describe("a streamed text's chunks", () => {
  const base = () => thread("bench:s", [...Array.from({ length: 59 }, (_, i) => message(i, `words ${i}`)), message(59, "the answer")]);

  async function seeded(cache: Cache, t: Thread) {
    const state = withThread(t, 1);
    const saver = new Saver(() => cache, () => state, 200);
    saver.markThread(t.key, 0);
    await saver.save();
    return state;
  }

  test("an append writes the words it added and the head, nothing of the message it grows", async () => {
    const cache = track(await openCache());
    let t = base();
    let state = await seeded(cache, t);
    const saver = new Saver(() => cache, () => state, 200);
    const watch = watchPuts();
    for (let tick = 0; tick < 5; tick++) {
      watch.puts.length = 0;
      const grown = grow(t, 59, ` and more ${tick}`);
      t = grown.thread;
      state = withThread(t, 2 + tick);
      saver.mark([grown.patch]);
      await saver.save();
      expect(watch.puts.filter((p) => p.store === "threads").map((p) => [p.key, p.value])).toEqual([
        [`bench:s#+${String(tick).padStart(6, "0")}`, { at: 59, part: 0, field: "text", from: "the answer".length + (tick > 0 ? " and more 0".length * tick : 0), text: ` and more ${tick}` }],
        ["bench:s#head", expect.objectContaining({ bytes: t.bytes })],
      ]);
      await expectLoads(state);
    }
    watch.stop();
    expect((await threadKeys()).filter(isChunk)).toHaveLength(5);
  });

  test("the whole part arriving folds the chunks into its page, and they go", async () => {
    const cache = track(await openCache());
    let t = base();
    const first = await seeded(cache, t);
    const changes: { state: SyncState; patches: Patch[] }[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const grown = grow(t, 59, ` more ${tick}`);
      t = grown.thread;
      changes.push({ state: withThread(t, 2 + tick), patches: [grown.patch] });
    }
    // the daemon's whole part: the same text, settled, with its times
    const part = { ...(t.messages[59]?.parts[0] as Record<string, unknown>), time: { start: 1, end: 2 } } as Message["parts"][number];
    t = { ...t, messages: [...t.messages.slice(0, 59), { info: (t.messages[59] as Message).info, parts: [part] }] };
    changes.push({ state: withThread(t, 9), patches: [{ path: ["threads", t.key, "messages", 59, "parts", 0], value: part }] });
    expect(await saveThroughCrashes(cache, changes, first)).toBeGreaterThan(10);
    expect((await threadKeys()).filter(isChunk)).toEqual([]);
  });

  test("a message joining the end folds the chunks of the one before it, and they go", async () => {
    const cache = track(await openCache());
    let t = base();
    const first = await seeded(cache, t);
    const changes: { state: SyncState; patches: Patch[] }[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const grown = grow(t, 59, ` more ${tick}`);
      t = grown.thread;
      changes.push({ state: withThread(t, 2 + tick), patches: [grown.patch] });
    }
    // the next message joins in the same save as a last few words of the one before
    const grown = grow(t, 59, " last");
    t = { ...grown.thread, messages: [...grown.thread.messages, message(60, "next")] };
    changes.push({ state: withThread(t, 9), patches: [grown.patch, { path: ["threads", t.key, "messages", 60], value: t.messages[60] }] });
    const watch = watchPuts();
    expect(await saveThroughCrashes(cache, changes, first)).toBeGreaterThan(8);
    watch.stop();
    expect((await threadKeys()).filter(isChunk)).toEqual([]);
    // the join's commit rewrote the page of message 59 and wrote 60's
    const pages = layout(61);
    expect(watch.puts.slice(-4).filter((p) => isPage(p.key)).map((p) => p.key)).toEqual([`bench:s#${pageOfTest(pages, 59)}`, `bench:s#${pages.length - 2}`]);
  });

  test("a message joining the end without moving the page of the one before still folds that one's chunks", async () => {
    const cache = track(await openCache());
    let t = thread("bench:s", Array.from({ length: 61 }, (_, i) => message(i, `w${i}`)));
    const first = await seeded(cache, t);
    const changes: { state: SyncState; patches: Patch[] }[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const grown = grow(t, 60, ` more ${tick}`);
      t = grown.thread;
      changes.push({ state: withThread(t, 2 + tick), patches: [grown.patch] });
    }
    t = { ...t, messages: [...t.messages, message(61, "next")] };
    changes.push({ state: withThread(t, 9), patches: [{ path: ["threads", t.key, "messages", 61], value: t.messages[61] }] });
    // message 60's page is the same page before and after the join: only its chunks make it written
    const before = layout(61);
    const after = layout(62);
    const page = pageOfTest(after, 60);
    expect([after[page], after[page + 1]]).toEqual([before[page], before[page + 1]]);
    await saveThroughCrashes(cache, changes, first);
    expect((await threadKeys()).filter(isChunk)).toEqual([]);
  });

  test("a save that fails while more is marked writes the fields it creates in the order they were marked", async () => {
    const cache = track(await openCache());
    const tool = { id: "prt_t", messageID: "msg_0001", type: "tool" };
    let t = thread("bench:s", [message(0, "a"), { info: message(1).info, parts: [tool] as unknown as Message["parts"] }]);
    let state = await seeded(cache, t);
    const saver = new Saver(() => cache, () => state, 10_000);
    const real = cache.save.bind(cache);
    let fail = true;
    cache.save = async (s, dirty) => {
      if (fail) throw new Error("the disk is full");
      return real(s, dirty);
    };
    let grown = grow(t, 1, "{}", 0, "input");
    t = grown.thread;
    state = withThread(t, 2);
    saver.mark([grown.patch]);
    const failing = saver.save();
    // marked while the failing save is in flight
    grown = grow(t, 1, "done", 0, "output");
    t = grown.thread;
    state = withThread(t, 3);
    saver.mark([grown.patch]);
    await failing;
    fail = false;
    await saver.save();
    saver.stop();
    expect(Object.keys(t.messages[1]?.parts[0] ?? {})).toEqual(["id", "messageID", "type", "input", "output"]);
    await expectLoads(state);
  });

  test("chunks past the cap fold into the page, so a stream that never settles keeps a bounded few", async () => {
    const cache = track(await openCache());
    let t = base();
    let state = await seeded(cache, t);
    const saver = new Saver(() => cache, () => state, 200);
    const watch = watchPuts();
    const folds: number[] = [];
    for (let tick = 0; tick < CHUNKS * 2 + 10; tick++) {
      watch.puts.length = 0;
      const grown = grow(t, 59, ` w${tick}`);
      t = grown.thread;
      state = withThread(t, 2 + tick);
      saver.mark([grown.patch]);
      await saver.save();
      if (watch.puts.some((p) => isPage(p.key))) folds.push(tick);
      if (tick % 64 === 0 || tick === CHUNKS || tick === CHUNKS + 1) {
        expect((await threadKeys()).filter(isChunk).length).toBeLessThanOrEqual(CHUNKS);
        await expectLoads(state);
      }
    }
    watch.stop();
    expect(folds).toEqual([CHUNKS, CHUNKS * 2 + 1]);
    await expectLoads(state);
  });

  test("a long stream writes its words a few times over, not its length once per fold: the writes grow with it in a line", async () => {
    const cache = track(await openCache());
    let t = base();
    let state = await seeded(cache, t);
    let written = 0;
    const saver = new Saver(() => cache, () => state, 200, (stats) => (written += stats.bytes));
    const watch = watchPuts();
    const folds: number[] = [];
    const words = "w".repeat(2_000);
    // a second of a fast answer per save (436 kb a minute), for 2,000 saves: 4 mb, which folds by its words only
    for (let tick = 0; tick < 2_000; tick++) {
      watch.puts.length = 0;
      const grown = grow(t, 59, words);
      t = grown.thread;
      state = withThread(t, 2 + tick);
      saver.mark([grown.patch]);
      await saver.save();
      if (watch.puts.some((p) => isPage(p.key))) folds.push(tick);
    }
    watch.stop();
    const streamed = 2_000 * words.length;
    // the folds come when the chunks hold what the page held: each one at least doubles the wait for the next
    for (let i = 1; i < folds.length; i++) expect((folds[i] as number) + 1).toBeGreaterThanOrEqual(2 * ((folds[i - 1] as number) + 1));
    expect(folds.length).toBeLessThan(12);
    // the words once as chunks and at most about twice more in folds, plus a head and a cursor per save
    expect(written).toBeLessThan(3 * streamed + 2_000 * 600);
    await expectLoads(state);
  }, 30_000);

  test("a text that was not there is created where the reducer puts it, and one that stood undefined keeps its place", async () => {
    const cache = track(await openCache());
    const reasoning = { id: "prt_r", messageID: "msg_0001", type: "reasoning", time: { start: 1 } };
    const undefinedFirst = { text: undefined, id: "prt_u", messageID: "msg_0001", type: "text" };
    let t = thread("bench:s", [message(0, "a"), { info: message(1).info, parts: [reasoning, undefinedFirst] as unknown as Message["parts"] }]);
    const first = await seeded(cache, t);
    const changes: { state: SyncState; patches: Patch[] }[] = [];
    for (const [part, words] of [
      [0, "thinking"],
      [1, "said"],
      [0, " more"],
      [1, " too"],
    ] as const) {
      const grown = grow(t, 1, words, part);
      t = grown.thread;
      changes.push({ state: withThread(t, 2 + changes.length), patches: [grown.patch] });
    }
    await saveThroughCrashes(cache, changes, first);
    expect(Object.keys(t.messages[1]?.parts[0] ?? {})).toEqual(["id", "messageID", "type", "time", "text"]);
    expect(Object.keys(t.messages[1]?.parts[1] ?? {})[0]).toBe("text");
    expect((await threadKeys()).filter(isChunk)).toHaveLength(4);
  });

  test("a chunk that does not fit its text reads the thread as missing, so it is read from the daemon", async () => {
    const cache = track(await openCache());
    let t = base();
    let state = await seeded(cache, t);
    const saver = new Saver(() => cache, () => state, 200);
    const grown = grow(t, 59, " more");
    t = grown.thread;
    state = withThread(t, 2);
    saver.mark([grown.patch]);
    await saver.save();
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("boxbox");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction("threads", "readwrite");
      tx.objectStore("threads").put({ at: 59, part: 0, field: "text", from: 3, text: "x" }, "bench:s#+000001");
      tx.oncomplete = () => resolve();
    });
    raw.close();
    const reader = track(await openCache());
    const [head] = (await reader.loadBoot()).heads;
    if (!head) throw new Error("no head");
    expect(await reader.loadPages(head)).toBeNull();
  });
});

/** the page of `starts` that holds message `at` */
function pageOfTest(starts: readonly number[], at: number): number {
  return starts.findIndex((start, page) => start <= at && at < (starts[page + 1] ?? 0));
}

describe("two writers streaming into one thread", () => {
  test("appends interleaved with the other's appends and a whole rewrite leave each save's thread whole", async () => {
    const a = track(await openCache());
    const b = track(await openCache());
    let tA = thread("bench:x", [...Array.from({ length: 59 }, (_, i) => message(i, `m${i}`)), message(59, "answer")]);
    let stateA = withThread(tA, 1);
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.markThread(tA.key, 0);
    await saverA.save();
    const appendA = async (words: string, seq: number) => {
      const grown = grow(tA, 59, words);
      tA = grown.thread;
      stateA = withThread(tA, seq);
      saverA.mark([grown.patch]);
      await saverA.save();
    };
    await appendA(" one", 2);
    await appendA(" two", 3);
    // b reloads over it: it reads the pages and the chunks
    const [head] = (await b.loadBoot()).heads;
    if (!head) throw new Error("no head");
    const loaded = await b.loadPages(head);
    expect(loaded).toStrictEqual(tA.messages);
    let tB = { ...tA, messages: loaded ?? [] };
    let stateB = withThread(tB, 3);
    const saverB = new Saver(() => b, () => stateB, 200);
    const appendB = async (words: string, seq: number) => {
      const grown = grow(tB, 59, words);
      tB = grown.thread;
      stateB = withThread(tB, seq);
      saverB.mark([grown.patch]);
      await saverB.save();
    };
    // a streams on, chunks after the ones b read
    await appendA(" three", 4);
    // b's stream is behind a's: its append, on a disk a wrote since, rewrites the thread whole
    const watch = watchPuts();
    await appendB(" three!", 4);
    expect(watch.puts.some((p) => isPage(p.key))).toBe(true);
    await expectLoads(stateB);
    expect((await threadKeys()).filter(isChunk)).toEqual([]);
    // a, stale in turn, does the same
    watch.puts.length = 0;
    await appendA(" four", 5);
    expect(watch.puts.some((p) => isPage(p.key))).toBe(true);
    await expectLoads(stateA);
    // and a, writing last, chunks again
    watch.puts.length = 0;
    await appendA(" five", 6);
    expect(watch.puts.filter((p) => p.store === "threads").map((p) => p.key)).toEqual(["bench:x#+000000", "bench:x#head"]);
    await expectLoads(stateA);
    // b rewrites the thread whole (a read that started over) while a chunks on: a's next append is whole again
    tB = { ...tB, messages: tB.messages.slice(0, 40) };
    stateB = withThread(tB, 7);
    saverB.markThread(tB.key, 0);
    await saverB.save();
    await expectLoads(stateB);
    await appendA(" six", 8);
    await expectLoads(stateA);
    await appendA(" seven", 9);
    watch.stop();
    await expectLoads(stateA);
  });
});
