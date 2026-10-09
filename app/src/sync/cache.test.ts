import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache, cleanDirty, PAGE } from "./cache";
import type { Message } from "./protocol";
import { INITIAL_STATE, type SyncState, type Thread } from "./reducer";

const message = (n: number): Message => ({ info: { id: `msg_${n}`, sessionID: "ses_1", role: "assistant", time: { created: n } }, parts: [] });
const messages = (count: number, from = 0) => Array.from({ length: count }, (_, i) => message(from + i));

const thread = (key: string, count: number, over: Partial<Thread> = {}): Thread => ({
  key,
  status: "live",
  hydration: 1,
  upstreamEpoch: "u1",
  hydratedAt: 10,
  lastUpstream: 10,
  messages: messages(count),
  baseline: {},
  buffer: [],
  refetching: {},
  openedAt: 5,
  heldAt: 0,
  leased: false,
  bytes: 1234,
  ...over,
});

const stateOf = (...threads: Thread[]): SyncState => ({
  ...INITIAL_STATE,
  cursor: { epoch: "j1", seq: 7 },
  threads: Object.fromEntries(threads.map((t) => [t.key, t])),
});

/** the keys the cache asked indexeddb for, by call */
function watchReads() {
  const reads: { call: string; key: string }[] = [];
  const proto = IDBObjectStore.prototype;
  const originals = { get: proto.get, getAll: proto.getAll, getAllKeys: proto.getAllKeys };
  proto.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
    reads.push({ call: `${this.name}.get`, key: String(query) });
    return originals.get.call(this, query);
  };
  proto.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
    reads.push({ call: `${this.name}.getAll`, key: "" });
    return originals.getAll.apply(this, args);
  };
  proto.getAllKeys = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAllKeys"]>) {
    reads.push({ call: `${this.name}.getAllKeys`, key: "" });
    return originals.getAllKeys.apply(this, args);
  };
  return {
    reads,
    stop: () => Object.assign(proto, originals),
  };
}

let cache: Cache | null = null;

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("boxbox");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  cache = await Cache.open();
});

afterEach(() => cache?.close());

const open = () => {
  if (!cache) throw new Error("the cache did not open");
  return cache;
};

async function saveAll(...threads: Thread[]) {
  const dirty = cleanDirty();
  dirty.fleet = true;
  for (const t of threads) dirty.threads.set(t.key, 0);
  await open().save(stateOf(...threads), dirty);
}

describe("the cache at boot", () => {
  test("reads the heads of every thread and none of their pages", async () => {
    await saveAll(thread("bench:a", PAGE * 3), thread("bench:b", PAGE * 2 + 1), thread("bench:c", 4));
    open().close();
    cache = await Cache.open();
    const watch = watchReads();
    const booted = await open().loadBoot();
    watch.stop();
    expect(booted.cursor).toEqual({ epoch: "j1", seq: 7 });
    expect(booted.heads.map((h) => [h.key, h.pages]).sort()).toEqual([["bench:a", 3], ["bench:b", 3], ["bench:c", 1]]);
    const pageReads = watch.reads.filter((r) => r.call === "threads.get" && !r.key.endsWith("#head"));
    expect(pageReads).toEqual([]);
    expect(watch.reads.some((r) => r.call === "threads.getAll")).toBe(false);
  });

  test("a thread's pages are read when it is wanted, only its own, and come back as saved", async () => {
    const a = thread("bench:a", PAGE * 2 + 3);
    await saveAll(a, thread("bench:b", PAGE * 4));
    const booted = await open().loadBoot();
    const watch = watchReads();
    const back = await open().loadPages(booted.heads.find((h) => h.key === "bench:a") as NonNullable<(typeof booted.heads)[number]>);
    watch.stop();
    expect(back).toEqual(a.messages);
    expect(watch.reads.map((r) => r.key).sort()).toEqual(["bench:a#0", "bench:a#1", "bench:a#2"]);
  });

  test("a page the head counts but the cache lacks reads as null, so the thread is read from the daemon", async () => {
    await saveAll(thread("bench:a", PAGE * 2));
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("boxbox");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction("threads", "readwrite");
      tx.objectStore("threads").delete("bench:a#1");
      tx.oncomplete = () => resolve();
    });
    raw.close();
    expect(await open().loadPages({ key: "bench:a", pages: 2 })).toBeNull();
  });

  test("a head written before heads carried recency and size reads with defaults, and no size: it counts for nothing until its pages are measured", async () => {
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("boxbox");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction("threads", "readwrite");
      tx.objectStore("threads").put({ key: "bench:old", status: "live", hydration: 2, upstreamEpoch: "u1", hydratedAt: 3, lastUpstream: 4, baseline: {}, refetching: [], openedAt: 9, pages: 2 }, "bench:old#head");
      tx.oncomplete = () => resolve();
    });
    raw.close();
    const [head] = (await open().loadBoot()).heads;
    expect(head).toMatchObject({ key: "bench:old", openedAt: 9, heldAt: 0, stale: false, bytes: 0, sized: false, pages: 2 });
  });
});

describe("the cache's writes", () => {
  test("a cold thread's head is written alone: its pages stay, and it reads back marked stale", async () => {
    const a = thread("bench:a", PAGE + 1);
    await saveAll(a);
    const booted = await open().loadBoot();
    const head = booted.heads[0];
    if (!head) throw new Error("no head");
    const dirty = cleanDirty();
    dirty.threads.set("bench:a", Number.POSITIVE_INFINITY);
    await open().save({ ...INITIAL_STATE, cursor: { epoch: "j1", seq: 9 }, cold: { "bench:a": { ...head, stale: true } } }, dirty);
    const again = await open().loadBoot();
    expect(again.heads[0]).toMatchObject({ stale: true, pages: 2 });
    expect(await open().loadPages(head)).toEqual(a.messages);
  });

  test("an evicted thread's head and pages are deleted, cold or not", async () => {
    await saveAll(thread("bench:a", PAGE + 1), thread("bench:b", 3));
    const dirty = cleanDirty();
    dirty.threads.set("bench:a", 0);
    dirty.threads.set("bench:b", 0);
    await open().save(INITIAL_STATE, dirty);
    expect((await open().loadBoot()).heads).toEqual([]);
    expect(await open().loadPages({ key: "bench:a", pages: 2 })).toBeNull();
  });

  test("a thread's size and recency survive a reload", async () => {
    await saveAll(thread("bench:a", 3, { openedAt: 0, heldAt: 44, bytes: 777 }));
    const [head] = (await open().loadBoot()).heads;
    expect(head).toMatchObject({ openedAt: 0, heldAt: 44, bytes: 777, sized: true, stale: false });
  });

  test("a head with no size is still written without one when only its head changes, so it reads as unsized again", async () => {
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("boxbox");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction("threads", "readwrite");
      tx.objectStore("threads").put({ key: "bench:old", status: "live", hydration: 2, upstreamEpoch: "u1", hydratedAt: 3, lastUpstream: 4, baseline: {}, refetching: [], openedAt: 9, pages: 1 }, "bench:old#head");
      tx.oncomplete = () => resolve();
    });
    raw.close();
    const [head] = (await open().loadBoot()).heads;
    if (!head) throw new Error("no head");
    const dirty = cleanDirty();
    dirty.threads.set("bench:old", Number.POSITIVE_INFINITY);
    await open().save({ ...INITIAL_STATE, cold: { "bench:old": { ...head, stale: true } } }, dirty);
    expect((await open().loadBoot()).heads[0]).toMatchObject({ stale: true, bytes: 0, sized: false });
  });
});
