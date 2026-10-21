import { describe, expect, test } from "bun:test";
import { type ThreadCaches, cacheKey, createThreadCaches, weighItems, Lru } from "./memo-cache";
import type { Say, Step, Turn } from "./model";

describe("the caches' eviction", () => {
  const sized = (cap: number) => new Lru<string>(cap, () => 0);
  test("the oldest entry leaves when the bytes pass the cap", () => {
    const lru = sized(100);
    lru.set("a", "a", 40);
    lru.set("b", "b", 40);
    lru.set("c", "c", 40);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe("b");
    expect(lru.weight).toBe(80);
    expect(lru.evicted).toBe(1);
  });

  test("a read makes an entry the newest, so the one left unread is the one that goes", () => {
    const lru = sized(100);
    lru.set("a", "a", 40);
    lru.set("b", "b", 40);
    lru.get("a");
    lru.set("c", "c", 40);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe("a");
  });

  test("an entry bigger than the whole cap is not kept and evicts nothing", () => {
    const lru = sized(100);
    lru.set("a", "a", 40);
    lru.set("huge", "x", 101);
    expect(lru.get("huge")).toBeUndefined();
    expect(lru.get("a")).toBe("a");
  });

  test("replacing a key does not count its old bytes twice", () => {
    const lru = sized(100);
    lru.set("a", "1", 60);
    lru.set("a", "2", 60);
    expect(lru.weight).toBe(60);
    expect(lru.size).toBe(1);
  });

  test("counts what it was asked and what it found, for the telemetry row", () => {
    const lru = sized(100);
    lru.set("a", "a", 10);
    lru.get("a");
    lru.get("b");
    expect([lru.hits, lru.misses]).toEqual([1, 1]);
  });
});

describe("what the store's caches forget", () => {
  const put = (c: ThreadCaches, thread: string, turn: string) => {
    c.turns.set(cacheKey(thread, turn), { digest: "d", turn: {} as Turn }, 10);
    c.heights.set(cacheKey(thread, `${turn}\u0000392`), 300, 96);
  };
  test("a thread that left takes its entries and no other thread's, though its key begins another's", () => {
    const c = createThreadCaches();
    put(c, "desk:ses_1", "m1");
    put(c, "desk:ses_10", "m1");
    c.dropThread("desk:ses_1");
    expect(c.turns.get(cacheKey("desk:ses_1", "m1"))).toBeUndefined();
    expect(c.heights.size).toBe(1);
    expect(c.turns.get(cacheKey("desk:ses_10", "m1"))).toBeDefined();
  });
  test("a thread that left the screen takes its turn models and keeps its heights", () => {
    const c = createThreadCaches();
    put(c, "desk:ses_1", "m1");
    c.ledgers.set(cacheKey("desk:ses_1", "m1"), {} as never, 10);
    c.dropModels("desk:ses_1");
    expect([c.turns.size, c.ledgers.size, c.heights.size]).toEqual([0, 0, 1]);
  });
  test("signing out empties every cache", () => {
    const c = createThreadCaches();
    put(c, "desk:ses_1", "m1");
    c.html.set("# hi", "<h1>hi</h1>");
    c.clear();
    expect([c.turns.size, c.heights.size, c.html.size, c.ledgers.size]).toEqual([0, 0, 0, 0]);
  });
});

describe("a write made after what it writes for was cleared or dropped", () => {
  test("is refused: a view that goes after the sign-out does not put its ledger back", () => {
    const caches = createThreadCaches();
    const stamp = caches.stamp("desk:a");
    caches.clear();
    caches.keep(caches.turns, "desk:a", stamp, cacheKey("desk:a", "t1"), { digest: "d", turn: {} as Turn }, 10);
    expect(caches.turns.size).toBe(0);
  });
  test("is refused for the thread that was dropped and not for another", () => {
    const caches = createThreadCaches();
    const a = caches.stamp("desk:a");
    const b = caches.stamp("desk:b");
    caches.dropThread("desk:a");
    caches.keep(caches.heights, "desk:a", a, cacheKey("desk:a", "t1"), 100, 96);
    caches.keep(caches.heights, "desk:b", b, cacheKey("desk:b", "t1"), 200, 96);
    expect(caches.heights.get(cacheKey("desk:a", "t1"))).toBeUndefined();
    expect(caches.heights.get(cacheKey("desk:b", "t1"))).toBe(200);
  });
  test("is allowed again for a writer that began after the drop", () => {
    const caches = createThreadCaches();
    caches.dropThread("desk:a");
    caches.clear();
    const stamp = caches.stamp("desk:a");
    caches.keep(caches.heights, "desk:a", stamp, cacheKey("desk:a", "t1"), 100, 96);
    expect(caches.heights.get(cacheKey("desk:a", "t1"))).toBe(100);
  });
  test("a writer of the html, which is by text and belongs to no thread, is refused after a clear and kept before", () => {
    const caches = createThreadCaches();
    const before = caches.htmlFor();
    before.set("same words", "<p>same words</p>");
    expect(caches.html.get("same words")).toBe("<p>same words</p>");
    caches.clear();
    before.set("other words", "<p>other words</p>");
    expect(caches.html.size).toBe(0);
    caches.htmlFor().set("later words", "<p>later words</p>");
    expect(caches.html.size).toBe(1);
  });
  test("what is remembered of drops is bounded, and a thread whose drop was forgotten is refused rather than let through", () => {
    const caches = createThreadCaches();
    const stamps = Array.from({ length: 1200 }, (_, i) => caches.stamp(`desk:t${i}`));
    for (let i = 0; i < 1200; i++) caches.dropThread(`desk:t${i}`);
    for (let i = 0; i < 1200; i++) caches.keep(caches.heights, `desk:t${i}`, stamps[i] as number, cacheKey(`desk:t${i}`, "x"), 1, 96);
    expect(caches.heights.size).toBe(0);
  });
});

describe("what a turn weighs", () => {
  const say = (text: string): Say => ({ k: "say", id: "s", text, at: 0, streaming: false });
  test("grows with its words, and has a floor per item", () => {
    expect(weighItems([say("a".repeat(1000))])).toBeGreaterThan(weighItems([say("a")]) + 1900);
    expect(weighItems([say(""), say("")])).toBe(480);
  });
  test("counts a step's diff, command and output lines", () => {
    const step = { k: "step", id: "p", callID: "c", family: "shell", tool: "shell", status: "completed", object: "ls", result: "", add: 0, del: 0, ms: 0, at: 0, command: "ls -la", output: { lines: ["a", "bb"], cut: 0, cutAt: -1 } } as Step;
    expect(weighItems([step])).toBe((2 + 6 + 3) * 2 + 240);
  });
  test("counts the whole output a step keeps, which the store may have let go", () => {
    const step = { k: "step", id: "p", callID: "c", family: "shell", tool: "shell", status: "completed", object: "ls", result: "", add: 0, del: 0, ms: 0, at: 0, output: { lines: ["a"], cut: 0, cutAt: -1, raw: "x".repeat(5000) } } as Step;
    expect(weighItems([step])).toBeGreaterThan(10_000);
  });
});
