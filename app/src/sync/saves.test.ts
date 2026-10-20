/* the worker's save path (cache.ts, `Saver` and `Cache.save`) against what
   it saves: a recorded stream is replayed through the reducer, marked and
   saved as the worker does, and at every save the database read back the
   way a reload reads it holds exactly the state that was saved. a database
   written by the build before v4 (fixtures/cache-v3.json, captured from
   that build's cache.ts) opens with every byte of it, and saves asked for
   while one commits are merged into one, losing nothing. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cache, cleanDirty, layout, markPatches, PAGE, Saver } from "./cache";
import { recordedSteps, type Recording, type Step } from "./fixtures/saves";
import type { Message } from "./protocol";
import { type Effect, INITIAL_STATE, type SyncState, type Thread } from "./reducer";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const messagesOf = (path: string) => (JSON.parse(read(path)) as { messages: Message[] }).messages;
const recording: Recording = {
  journal: read("../ui/home/fixtures/journal.ndjson"),
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
});

/** what a reload reads, from a connection of its own, is the state saved: the cursor, the counters, the fleet down to the
    order of its keys, every head, and every page */
async function expectLoads(state: SyncState) {
  const reader = await openCache();
  try {
    const booted = await reader.loadBoot();
    expect(booted.cursor).toStrictEqual(state.cursor);
    expect(booted.counters).toStrictEqual(state.counters);
    expect(booted.fleet).toStrictEqual(state.fleet);
    const fleet = booted.fleet ?? INITIAL_STATE.fleet;
    expect(Object.keys(fleet)).toEqual(Object.keys(state.fleet));
    expect(Object.keys(fleet.sessions)).toEqual(Object.keys(state.fleet.sessions));
    expect(Object.keys(fleet.asks)).toEqual(Object.keys(state.fleet.asks));
    expect(Object.keys(fleet.hosts)).toEqual(Object.keys(state.fleet.hosts));
    expect(booted.heads.map((h) => h.key).sort()).toEqual([...Object.keys(state.threads), ...Object.keys(state.cold)].sort());
    for (const head of booted.heads) {
      const thread = state.threads[head.key];
      if (!thread) {
        expect(head).toMatchObject({ ...state.cold[head.key], leased: false });
        continue;
      }
      expect(head).toStrictEqual(headOf(thread));
      expect(await reader.loadPages(head)).toStrictEqual(thread.messages);
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
      if (step.index % 7 !== 6) continue;
      await saver.save();
      saves++;
      await expectLoads(state);
      if (step.index === Math.floor(steps.length / 2) - (Math.floor(steps.length / 2) % 7) + 6) {
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
  });

  test("a fleet the size of a real one saves and loads the same", async () => {
    const cache = track(await openCache());
    let state = INITIAL_STATE;
    const saver = new Saver(() => cache, () => state, 200);
    let n = 0;
    for (const step of recordedSteps(recording, { pad: 300 })) {
      state = step.state;
      markStep(saver, step);
      if (++n % 40 !== 0) continue;
      await saver.save();
      await expectLoads(state);
    }
    await saver.save();
    await expectLoads(state);
    expect(Object.keys(state.fleet.sessions).length).toBe(305);
  });
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
  info: { id: `msg_${String(n).padStart(4, "0")}`, sessionID: "ses_1", role: "assistant", time: { created: n } },
  parts: text ? [{ id: `prt_${n}`, sessionID: "ses_1", messageID: `msg_${String(n).padStart(4, "0")}`, type: "text", text } as Message["parts"][number]] : [],
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

  test("pages written fifty to the end before v4 read as they are, and a save after them rewrites only what moved", async () => {
    // the layout of the build before v4: pages of fifty to the end
    const before = Array.from({ length: 120 }, (_, i) => message(i, `w${i}`));
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("boxbox", 3);
      request.onupgradeneeded = () => {
        for (const store of ["meta", "fleet", "threads", "drafts", "draftPhotos", "outbox", "prefs"]) request.result.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction("threads", "readwrite");
      const store = tx.objectStore("threads");
      for (let page = 0; page < 3; page++) store.put(before.slice(page * 50, (page + 1) * 50), `bench:a#${page}`);
      store.put({ ...headOf(thread("bench:a", before)), pages: 3 }, "bench:a#head");
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
  test("a changed session writes that session alone, and a session that goes and comes back keeps its new place", async () => {
    const cache = track(await openCache());
    const steps = [...recordedSteps(recording, { histories: false, pad: 50 })];
    let state: SyncState = { ...(steps[steps.length - 1]?.state ?? INITIAL_STATE), threads: {}, cold: {} };
    const saver = new Saver(() => cache, () => state, 200);
    saver.mark([{ path: ["fleet"], value: null }]);
    await saver.save();
    const keys = Object.keys(state.fleet.sessions);
    const first = keys[0] ?? "";
    const entry = state.fleet.sessions[first];
    if (!entry) throw new Error("no session");
    const watch = watchPuts();
    state = { ...state, cursor: { epoch: "j1", seq: 900 }, fleet: { ...state.fleet, sessions: { ...state.fleet.sessions, [first]: { ...entry, agents: 3 } } } };
    // a finer patch than today's reducer sends names the same record
    saver.mark([{ path: ["fleet", "sessions", first, "agents"], value: 3 }]);
    await saver.save();
    expect(watch.puts.filter((p) => p.store === "fleet").map((p) => p.key)).toEqual([`sessions:${first}`]);
    await expectLoads(state);
    // gone and back within one save: same keys, another order
    const { [first]: _gone, ...rest } = state.fleet.sessions;
    state = { ...state, cursor: { epoch: "j1", seq: 901 }, fleet: { ...state.fleet, sessions: { ...rest, [first]: entry } } };
    saver.mark([{ path: ["fleet", "sessions", first], value: undefined }, { path: ["fleet", "sessions", first], value: entry }]);
    watch.puts.length = 0;
    await saver.save();
    expect(watch.puts.filter((p) => p.store === "fleet").map((p) => p.key).sort()).toEqual(["index", `sessions:${first}`]);
    await expectLoads(state);
    // gone for good, an ask raised, the order and the colours changed
    const second = keys[1] ?? "";
    const { [second]: _left, ...remaining } = state.fleet.sessions;
    const ask = Object.values(steps.find((s) => Object.keys(s.state.fleet.asks).length > 0)?.state.fleet.asks ?? {})[0];
    if (!ask) throw new Error("the journal raised no ask");
    state = {
      ...state,
      cursor: { epoch: "j1", seq: 902 },
      fleet: { ...state.fleet, sessions: remaining, asks: { ...state.fleet.asks, "bench:ask_new": ask }, order: [...state.fleet.order].reverse(), colours: {} },
    };
    saver.mark([
      { path: ["fleet", "sessions", second], value: undefined },
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
      { path: ["fleet", "sessions", "h:a"], value: null },
      { path: ["fleet", "sessions", "h:b", "tail"], value: [] },
      { path: ["fleet", "asks", "h:q"], value: undefined },
      { path: ["fleet", "hosts", "h"], value: null },
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
    expect([...dirty.entries.sessions]).toEqual(["h:a", "h:b"]);
    expect([...dirty.entries.asks]).toEqual(["h:q"]);
    expect([...dirty.entries.hosts]).toEqual(["h"]);
    expect([...dirty.fields]).toEqual(["colours", "order"]);
    expect(Object.fromEntries(dirty.threads)).toEqual({ "h:a": 7, "h:b": Number.POSITIVE_INFINITY, "h:c": Number.POSITIVE_INFINITY, "h:d": 0, "h:e": 0 });
    markPatches(dirty, [{ path: ["fleet", "sessions"], value: {} }]);
    expect(dirty.fleet).toBe(true);
  });
});

type Dump = { version: number; stores: Record<string, [string, unknown][]>; loaded: { boot: unknown; pages: Record<string, unknown> } };

describe("the upgrade to v4", () => {
  test("a database the build before wrote opens with the same fleet, heads and pages, and saves on from there", async () => {
    const dump = JSON.parse(read("fixtures/cache-v3.json")) as Dump;
    expect(dump.version).toBe(3);
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

    const cache = track(await openCache());
    const booted = await cache.loadBoot();
    const expected = dump.loaded.boot as typeof booted;
    expect({ ...booted, heads: [...booted.heads].sort((a, b) => a.key.localeCompare(b.key)) }).toStrictEqual({
      ...expected,
      heads: [...expected.heads].sort((a, b) => a.key.localeCompare(b.key)),
    });
    expect(Object.keys(booted.fleet?.sessions ?? {})).toEqual(Object.keys(expected.fleet?.sessions ?? {}));
    expect(Object.keys(booted.fleet ?? {})).toEqual(Object.keys(expected.fleet ?? {}));
    for (const head of booted.heads) expect(await cache.loadPages(head)).toStrictEqual(dump.loaded.pages[head.key] as Message[]);

    // the whole record is gone, split into its entries
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const request = indexedDB.open("boxbox");
      request.onsuccess = () => {
        const db = request.result;
        const all = db.transaction("fleet", "readonly").objectStore("fleet").getAllKeys();
        all.onsuccess = () => {
          resolve(all.result);
          db.close();
        };
      };
    });
    expect(keys.map(String)).not.toContain("fleet");
    expect(keys.map(String)).toContain("index");

    // one session changes after the upgrade: it alone is written, and what loads is the fleet with it
    const fleet = booted.fleet;
    const key = Object.keys(fleet?.sessions ?? {})[0];
    const entry = key ? fleet?.sessions[key] : undefined;
    if (!fleet || !key || !entry) throw new Error("the dump has no session");
    let state: SyncState = { ...INITIAL_STATE, cursor: booted.cursor, counters: booted.counters ?? INITIAL_STATE.counters, fleet, cold: Object.fromEntries(booted.heads.map((h) => [h.key, h])) };
    state = { ...state, cursor: { epoch: state.cursor?.epoch ?? "j1", seq: (state.cursor?.seq ?? 0) + 1 }, fleet: { ...fleet, sessions: { ...fleet.sessions, [key]: { ...entry, processes: 2 } } } };
    const saver = new Saver(() => cache, () => state, 200);
    const watch = watchPuts();
    saver.mark([{ path: ["fleet", "sessions", key], value: null }]);
    await saver.save();
    watch.stop();
    expect(watch.puts.map((p) => `${p.store}/${p.key}`)).toEqual([`fleet/sessions:${key}`, "meta/sync"]);
    await expectLoads(state);
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

  test("a session one writer added and the other added and removed in one save is gone, not undefined", async () => {
    const steps = [...recordedSteps(recording, { histories: false })];
    const base: SyncState = { ...(steps[steps.length - 1]?.state ?? INITIAL_STATE), threads: {}, cold: {}, cursor: { epoch: "j1", seq: 1 } };
    const a = track(await openCache());
    const b = track(await openCache());
    let stateA = base;
    const saverA = new Saver(() => a, () => stateA, 200);
    saverA.mark([{ path: ["fleet"], value: null }]);
    await saverA.save();
    await b.loadBoot();
    const entry = Object.values(base.fleet.sessions)[0];
    if (!entry) throw new Error("no session");
    const k = { ...entry, key: "h:k", id: "k" };
    stateA = { ...base, cursor: { epoch: "j1", seq: 2 }, fleet: { ...base.fleet, sessions: { ...base.fleet.sessions, "h:k": k } } };
    saverA.mark([{ path: ["fleet", "sessions", "h:k"], value: k }]);
    await saverA.save();
    // b applies the add and the removal inside one window
    const stateB: SyncState = { ...base, cursor: { epoch: "j1", seq: 3 } };
    const saverB = new Saver(() => b, () => stateB, 200);
    saverB.mark([
      { path: ["fleet", "sessions", "h:k"], value: k },
      { path: ["fleet", "sessions", "h:k"], value: undefined },
    ]);
    await saverB.save();
    await expectLoads(stateB);
    // the other way: a drops a session b still has and changes; b's save brings it back whole, with b's cursor
    const gone = Object.keys(base.fleet.sessions)[0] ?? "";
    const { [gone]: _dropped, ...rest } = base.fleet.sessions;
    stateA = { ...base, cursor: { epoch: "j1", seq: 4 }, fleet: { ...base.fleet, sessions: rest } };
    saverA.mark([{ path: ["fleet", "sessions", gone], value: undefined }]);
    await saverA.save();
    const changed: SyncState = { ...stateB, cursor: { epoch: "j1", seq: 4 }, fleet: { ...base.fleet, sessions: { ...base.fleet.sessions, [gone]: { ...entry, agents: 9 } } } };
    const saverB2 = new Saver(() => b, () => changed, 200);
    saverB2.mark([{ path: ["fleet", "sessions", gone, "agents"], value: 9 }]);
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
