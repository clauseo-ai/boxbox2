import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BTW_CAP, mergeBtw } from "./btw";
import { Cache, cleanDirty, markPatches } from "./cache";
import { Cooldown } from "./cooldown";
import type { FromWorker } from "./messages";
import { snapshot, thread } from "./fixtures/neutral";
import type { Btw, Entry, Frame } from "./protocol";
import { routeFrame } from "./protocol";
import { type Action, appended, INITIAL_STATE, isAppend, type Patch, type PathSegment, reduce, type Result, type SyncState, viewOf } from "./reducer";
import { Sender } from "./sender";

const EPOCH = "j1";
const KEY = "bench:ses_1";

const btw = (id: string, over: Partial<Btw> = {}): Btw => ({ id, question: `why ${id}`, answer: "", status: "running", created: 100, ...over });

function run(state: SyncState, actions: Action[]): { state: SyncState; results: Result[] } {
  const results: Result[] = [];
  for (const action of actions) {
    const result = reduce(state, action);
    results.push(result);
    state = result.state;
  }
  return { state, results };
}

const frame = (f: Frame): Action => ({ type: "frame", frame: f, id: "seq" in f ? { epoch: EPOCH, seq: f.seq } : null });

let seq = 0;
const record = (b: Btw, key = KEY): Action => frame({ type: "btw", seq: ++seq, key, upstream: null, btw: b } as Entry);
const delta = (btwID: string, text: string, offset: number | undefined, key = KEY): Action =>
  frame({ type: "btw.delta", seq: ++seq, key, btwID, delta: text, ...(offset === undefined ? {} : { offset }) } as Entry);

/** an open thread, read with `btws` (absent: a source that keeps none) */
function opened(btws?: Btw[]): SyncState {
  seq = 0;
  const reset = frame({ type: "reset", seq: 0, epoch: EPOCH, reason: "none", fleet: snapshot([thread(KEY)]) });
  const open = run(INITIAL_STATE, [reset, { type: "open", key: KEY, at: 1 }]);
  return run(open.state, [{ type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at: 5, seq: 0, messages: [], ...(btws ? { btws } : {}) }]).state;
}

/** the ui's copy of the thread views after `patches`, as the store applies them */
function mirrored(before: SyncState, patches: readonly Patch[]): string {
  const root: Record<string, unknown> = structuredClone({ threads: Object.fromEntries(Object.entries(before.threads).map(([k, t]) => [k, viewOf(t)])) });
  for (const patch of patches) {
    let node = root as Record<string | number, unknown>;
    for (const segment of patch.path.slice(0, -1)) {
      if (typeof node[segment] !== "object" || node[segment] === null) node[segment] = {};
      node = node[segment] as Record<string | number, unknown>;
    }
    const last = patch.path[patch.path.length - 1] as PathSegment;
    if (isAppend(patch)) node[last] = appended(node[last], patch);
    else if (patch.value === undefined) delete node[last];
    else node[last] = structuredClone(patch.value);
  }
  return JSON.stringify(root);
}
const mirrorOf = (state: SyncState) => JSON.stringify({ threads: Object.fromEntries(Object.entries(state.threads).map(([k, t]) => [k, viewOf(t)])) });

/** runs `actions` and checks the ui, patched, ends where the worker did */
function applied(state: SyncState, actions: Action[]) {
  const out = run(state, actions);
  expect(mirrored(state, out.results.flatMap((r) => r.patches))).toBe(mirrorOf(out.state));
  return out;
}

const held = (state: SyncState, id: string) => state.threads[KEY]?.btws?.[id];
const effects = (results: Result[]) => results.flatMap((r) => r.effects);

describe("a btw record from the stream", () => {
  test("joins the thread whole, then each one by its id, and counts toward the thread's bytes", () => {
    const start = opened();
    const { state, results } = applied(start, [record(btw("b1")), record(btw("b2"))]);
    expect(results[0]?.patches).toEqual([{ path: ["threads", KEY, "btws"], value: { b1: btw("b1") } }]);
    expect(results[1]?.patches).toEqual([{ path: ["threads", KEY, "btws", "b2"], value: btw("b2") }]);
    expect(Object.keys(state.threads[KEY]?.btws ?? {})).toEqual(["b1", "b2"]);
    expect(state.threads[KEY]?.bytes).toBeGreaterThan(start.threads[KEY]?.bytes ?? 0);
  });

  test("the same record again sends nothing", () => {
    const first = run(opened(), [record(btw("b1"))]);
    const again = run(first.state, [record(btw("b1"))]);
    expect(again.results[0]?.patches).toEqual([]);
  });

  test("for a cold or unknown thread changes nothing in memory", () => {
    const { state } = run(opened(), [record(btw("b1"), "bench:other")]);
    expect(state.threads["bench:other"]).toBeUndefined();
  });
});

describe("a btw's answer streaming", () => {
  test("in-order deltas append onto the answer, each patch carrying only its words", () => {
    const start = run(opened(), [record(btw("b1"))]).state;
    const { state, results } = applied(start, [delta("b1", "the cache ", 0), delta("b1", "is 50 mb 🙂", 10)]);
    expect(held(state, "b1")?.answer).toBe("the cache is 50 mb 🙂");
    expect(results[1]?.patches).toEqual([{ path: ["threads", KEY, "btws", "b1", "answer"], append: "is 50 mb 🙂", from: 10 }]);
    expect(state.threads[KEY]?.bytes).toBe((start.threads[KEY]?.bytes ?? 0) + "the cache is 50 mb 🙂".length);
  });

  test("a delta inside the answer is covered, and one that overlaps its end adds only what is new", () => {
    const start = run(opened(), [record(btw("b1")), delta("b1", "abc", 0)]).state;
    const covered = run(start, [delta("b1", "ab", 0)]);
    expect(covered.results[0]?.patches).toEqual([]);
    expect(covered.state.counters.duplicates).toBe(start.counters.duplicates + 1);
    const { state } = applied(start, [delta("b1", "bcde", 1)]);
    expect(held(state, "b1")?.answer).toBe("abcde");
  });

  test("a gap, a delta with no offset and one for a btw the thread lacks each read the btws again and change nothing", () => {
    const start = run(opened(), [record(btw("b1")), delta("b1", "abc", 0)]).state;
    for (const action of [delta("b1", "xyz", 7), delta("b1", "xyz", undefined), delta("b9", "hi", 0)]) {
      const { state, results } = run(start, [action]);
      expect(results[0]?.patches).toEqual([]);
      expect(effects(results)).toEqual([{ type: "btws-reread", key: KEY }]);
      expect(held(state, "b1")?.answer).toBe("abc");
    }
  });

  test("the reread's records fill the gap", () => {
    const start = run(opened(), [record(btw("b1")), delta("b1", "abc", 0), delta("b1", "ghi", 6)]).state;
    const { state } = applied(start, [{ type: "btws", key: KEY, btws: [btw("b1", { answer: "abcdefghi" })] }]);
    expect(held(state, "b1")?.answer).toBe("abcdefghi");
  });

  test("a delta after the btw settled is ignored", () => {
    const start = run(opened(), [record(btw("b1")), record(btw("b1", { status: "done", answer: "whole", completed: 200 }))]).state;
    const { state, results } = run(start, [delta("b1", " more", 5)]);
    expect(results[0]?.patches).toEqual([]);
    expect(effects(results)).toEqual([]);
    expect(held(state, "b1")?.answer).toBe("whole");
  });
});

describe("the monotonic merge", () => {
  test("running moves to done or error and never back", () => {
    const done = btw("b1", { status: "done", answer: "whole", completed: 200 });
    const { state } = applied(opened(), [record(done), record(btw("b1", { answer: "who" }))]);
    expect(held(state, "b1")).toEqual(done);
    expect(mergeBtw(btw("b1", { status: "error", error: "the model refused" }), btw("b1")).status).toBe("error");
  });

  test("while both run, the longer answer stands", () => {
    const { state } = applied(opened(), [record(btw("b1")), delta("b1", "abcdef", 0), record(btw("b1", { answer: "abc" }))]);
    expect(held(state, "b1")?.answer).toBe("abcdef");
  });

  test("a dismissal and a promotion stick through records that lack them", () => {
    const { state } = applied(opened(), [
      record(btw("b1", { status: "done", answer: "a", dismissed: 300 })),
      record(btw("b1", { status: "done", answer: "a" })),
      record(btw("b2", { status: "done", answer: "b", promotedMessageID: "msg_9" })),
      record(btw("b2", { status: "done", answer: "b", promotedMessageID: null })),
    ]);
    expect(held(state, "b1")?.dismissed).toBe(300);
    expect(held(state, "b2")?.promotedMessageID).toBe("msg_9");
  });
});

describe("the cap of btws per thread", () => {
  test(`past ${BTW_CAP} the oldest settled goes first, before an older one still running`, () => {
    const running = btw("b_run", { created: 1 });
    const settledOld = btw("b_old", { created: 2, status: "done", answer: "x" });
    const rest = Array.from({ length: BTW_CAP - 2 }, (_, i) => btw(`b${i}`, { created: 10 + i, status: "done", answer: "y" }));
    const start = run(opened([running, settledOld, ...rest]), []).state;
    expect(Object.keys(start.threads[KEY]?.btws ?? {})).toHaveLength(BTW_CAP);
    const { state, results } = applied(start, [record(btw("b_new", { created: 999 }))]);
    const ids = Object.keys(state.threads[KEY]?.btws ?? {});
    expect(ids).toHaveLength(BTW_CAP);
    expect(ids).toContain("b_run");
    expect(ids).toContain("b_new");
    expect(ids).not.toContain("b_old");
    expect(results[0]?.patches).toContainEqual({ path: ["threads", KEY, "btws", "b_old"], value: undefined });
  });
});

describe("btws from the thread read", () => {
  test("seed the store with the thread's view", () => {
    const state = opened([btw("b1", { status: "done", answer: "a" }), btw("b2")]);
    expect(viewOf(state.threads[KEY] as NonNullable<SyncState["threads"][string]>).btws).toEqual({ b1: btw("b1", { status: "done", answer: "a" }), b2: btw("b2") });
  });

  test("merge over what the stream gave meanwhile, and a read without btws leaves the held ones", () => {
    seq = 0;
    const reset = frame({ type: "reset", seq: 0, epoch: EPOCH, reason: "none", fleet: snapshot([thread(KEY)]) });
    const reading = run(INITIAL_STATE, [reset, { type: "open", key: KEY, at: 1 }, record(btw("b1", { dismissed: 300 })), delta("b1", "abcdef", 0)]).state;
    const read = (btws?: Btw[]): Action => ({ type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at: 5, seq: 0, messages: [], ...(btws ? { btws } : {}) });
    const merged = applied(reading, [read([btw("b1", { answer: "abc" }), btw("b2")])]).state;
    expect(held(merged, "b1")).toEqual(btw("b1", { answer: "abcdef", dismissed: 300 }));
    expect(held(merged, "b2")).toEqual(btw("b2"));
    const kept = applied(reading, [read()]).state;
    expect(held(kept, "b1")?.answer).toBe("abcdef");
  });

  test("a verb's own record folds in by the same rule, and none lands for a thread not held", () => {
    const start = run(opened(), [record(btw("b1", { status: "done", answer: "a" }))]).state;
    const { state } = applied(start, [{ type: "btws", key: KEY, btws: [btw("b1", { status: "done", answer: "a", dismissed: 5 })] }]);
    expect(held(state, "b1")?.dismissed).toBe(5);
    const gone = run(start, [{ type: "btws", key: "bench:gone", btws: [btw("b1")] }]);
    expect(gone.state.threads).toBe(start.threads);
    expect(gone.results[0]?.patches).toEqual([]);
  });
});

describe("btws on the wire", () => {
  test("both entries route to the journal, alone or in a catch-up", () => {
    expect(routeFrame(JSON.stringify({ type: "btw", seq: 3, key: KEY, upstream: null, btw: btw("b1") }), false)?.to).toBe("journal");
    expect(routeFrame(JSON.stringify({ type: "btw.delta", seq: 4, key: KEY, btwID: "b1", delta: "a", offset: 0 }), false)?.to).toBe("journal");
    const catchup = { type: "catchup", entries: [{ type: "btw.delta", seq: 4, key: KEY, btwID: "b1", delta: "a", offset: 0 }] };
    expect(routeFrame(JSON.stringify(catchup), false)?.to).toBe("journal");
  });
});

describe("btws in the cache", () => {
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

  test("a btw patch marks the thread's btws, which are written as one record and read back with its pages", async () => {
    const state = run(opened(), [record(btw("b2", { created: 200 })), record(btw("b1", { created: 100, status: "done", answer: "a" }))]);
    const dirty = cleanDirty();
    markPatches(dirty, state.results.flatMap((r) => r.patches));
    expect([...dirty.btws]).toEqual([KEY]);
    dirty.threads.set(KEY, 0);
    const c = cache as Cache;
    await c.save({ ...state.state, cursor: { epoch: EPOCH, seq: 9 } }, dirty);
    const head = (await c.loadBoot()).heads.find((h) => h.key === KEY);
    if (!head) throw new Error("no head was saved");
    const back = await c.loadThread(head);
    expect(back?.btws.map((b) => b.id)).toEqual(["b1", "b2"]);
    // a thread restored from the cache shows its btws before its read lands
    const cold = { ...INITIAL_STATE, cold: { [KEY]: { ...head, stale: false } } };
    const restored = reduce(cold, { type: "restored", key: KEY, messages: back?.messages ?? [], btws: back?.btws ?? [] });
    expect(Object.keys(restored.state.threads[KEY]?.btws ?? {}).sort()).toEqual(["b1", "b2"]);
  });
});

describe("the btw verbs", () => {
  async function withAnswers(answer: (path: string, init?: RequestInit) => Response | Promise<Response>, go: () => Promise<void>) {
    const real = globalThis.fetch;
    globalThis.fetch = ((path: string, init?: RequestInit) => Promise.resolve(answer(path, init))) as unknown as typeof fetch;
    try {
      await go();
    } finally {
      globalThis.fetch = real;
    }
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const sender = () => new Sender(() => null, { device: "d", deviceClass: "phone" }, { emit: () => undefined }, (_: FromWorker) => undefined, new AbortController().signal);

  test("an ask posts the question with a client id and the device, and answers with the agent's record", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    let done: unknown;
    await withAnswers(
      (path, init) => {
        calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json(200, btw("b1"));
      },
      async () => void (done = await sender().btw({ verb: "ask", key: "bench:ses_1", question: "what is the cap?", clientID: "btw_c1" })),
    );
    expect(done).toEqual({ ok: true, btw: btw("b1") });
    expect(calls[0]?.path).toBe("/api/agents/bench/threads/ses_1/btw");
    expect(calls[0]?.body).toEqual(expect.objectContaining({ device: "d", deviceClass: "phone", question: "what is the cap?", clientID: "btw_c1" }));
  });

  test("a dismiss answers with the dismissed record, a promote with its message id", async () => {
    const paths: string[] = [];
    let dismissed: unknown;
    let promoted: unknown;
    await withAnswers(
      (path) => {
        paths.push(path);
        return path.endsWith("/promote") ? json(200, { messageID: "msg_7" }) : json(200, btw("b1", { dismissed: 5 }));
      },
      async () => {
        dismissed = await sender().btw({ verb: "dismiss", key: KEY, btwID: "b1" });
        promoted = await sender().btw({ verb: "promote", key: KEY, btwID: "b1" });
      },
    );
    expect(paths).toEqual(["/api/agents/bench/threads/ses_1/btw/b1/dismiss", "/api/agents/bench/threads/ses_1/btw/b1/promote"]);
    expect(dismissed).toEqual({ ok: true, btw: btw("b1", { dismissed: 5 }) });
    expect(promoted).toEqual({ ok: true, messageID: "msg_7" });
  });

  test("a refusal says what happened and what to do, lowercase", async () => {
    const answers: unknown[] = [];
    await withAnswers(
      (path) => (path.endsWith("/btw") ? json(422, { error: { message: "this agent does not answer btw questions. ask in the thread instead" } }) : json(404, { error: { message: "no such btw" } })),
      async () => {
        answers.push(await sender().btw({ verb: "ask", key: KEY, question: "q", clientID: "btw_c1" }));
        answers.push(await sender().btw({ verb: "dismiss", key: KEY, btwID: "b1" }));
        answers.push(await sender().btw({ verb: "promote", key: "nokey", btwID: "b1" }));
      },
    );
    expect(answers).toEqual([
      { ok: false, message: "this agent does not answer btw questions. ask in the thread instead" },
      { ok: false, message: "this btw is not on the agent anymore. another device may have removed it, so there is nothing to do" },
      { ok: false, message: "this is not a thread an agent holds, so nothing was added to the thread. open the thread and try again" },
    ]);
  });

  test("a post with no answer goes once more with the same client id, and the second answer stands", async () => {
    const ids: unknown[] = [];
    let done: unknown;
    await withAnswers(
      (_, init) => {
        ids.push((JSON.parse(String(init?.body)) as { clientID?: unknown }).clientID);
        if (ids.length === 1) throw new TypeError("network");
        return json(200, btw("b1"));
      },
      async () => void (done = await sender().btw({ verb: "ask", key: KEY, question: "q", clientID: "btw_c1" })),
    );
    expect(ids).toEqual(["btw_c1", "btw_c1"]);
    expect(done).toEqual({ ok: true, btw: btw("b1") });
  });

  test("no answer at all, and a bare status, still say what did not happen and what to do", async () => {
    const answers: unknown[] = [];
    let posts = 0;
    await withAnswers(
      () => {
        posts++;
        throw new TypeError("network");
      },
      async () => void answers.push(await sender().btw({ verb: "ask", key: KEY, question: "q", clientID: "btw_c1" })),
    );
    expect(posts).toBe(2);
    await withAnswers(
      () => new Response("", { status: 500 }),
      async () => void answers.push(await sender().btw({ verb: "dismiss", key: KEY, btwID: "b1" })),
    );
    expect(answers).toEqual([
      { ok: false, message: "the boxbox server is not answering, so the question was not asked. check the connection and ask again" },
      { ok: false, message: "the server answered 500, so the btw is still here. dismiss it again" },
    ]);
    for (const answer of answers as { message: string }[]) expect(answer.message).toBe(answer.message.toLowerCase());
  });
});


describe("the btws' reread pacing", () => {
  /** timers run by hand, and a job whose reads are answered by hand */
  function paced() {
    const timers: { run: () => void; ms: number; live: boolean }[] = [];
    const reads: { key: string; answer: () => void }[] = [];
    const cooldown = new Cooldown(1500, (key) => new Promise<void>((resolve) => void reads.push({ key, answer: resolve })), {
      set: (run, ms) => timers.push({ run, ms, live: true }) - 1,
      clear: (handle) => void ((timers[handle as number] as { live: boolean }).live = false),
    });
    const tick = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const fire = async () => {
      const due = timers.filter((t) => t.live);
      for (const t of due) {
        t.live = false;
        t.run();
      }
      await tick();
    };
    return { cooldown, timers, reads, tick, fire };
  }

  test("a burst of holes reads once, and the holes found while it was out read once more after the cooldown", async () => {
    const { cooldown, reads, timers, tick, fire } = paced();
    for (let i = 0; i < 20; i++) cooldown.ask(KEY);
    expect(reads.map((r) => r.key)).toEqual([KEY]);
    reads[0]?.answer();
    await tick();
    expect(timers.filter((t) => t.live).map((t) => t.ms)).toEqual([1500]);
    expect(reads).toHaveLength(1);
    await fire();
    expect(reads).toHaveLength(2);
  });

  test("a hole in the cooldown waits for its end; with none the thread is let go, and the next hole reads at once", async () => {
    const { cooldown, reads, tick, fire } = paced();
    cooldown.ask(KEY);
    reads[0]?.answer();
    await tick();
    cooldown.ask(KEY);
    expect(reads).toHaveLength(1);
    await fire();
    expect(reads).toHaveLength(2);
    reads[1]?.answer();
    await tick();
    await fire();
    cooldown.ask(KEY);
    expect(reads).toHaveLength(3);
  });

  test("threads are paced apart", () => {
    const { cooldown, reads } = paced();
    cooldown.ask(KEY);
    cooldown.ask("bench:ses_2");
    expect(reads.map((r) => r.key)).toEqual([KEY, "bench:ses_2"]);
  });
});
