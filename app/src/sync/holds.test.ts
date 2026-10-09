import { describe, expect, spyOn, test } from "bun:test";
import type { Entry, Message, Part } from "./protocol";
import { type Action, BYTE_CAP, type Cold, type Effect, HELD_CAP, INITIAL_STATE, PART_ENVELOPE, reduce, type Result, type SyncState, THREAD_CAP, UNFIT_CAP } from "./reducer";

/* what the cache keeps and what it lets go: the thread cap, the held reserve, the byte cap, and that a thread held for
   another is never bought with one the person opened (reducer.ts, `makeRoom`) */

const EPOCH = "j1";
const key = (n: number) => `bench:ses_${n}`;
const keys = (state: SyncState) => Object.keys(state.threads).sort();
const MB = 1024 * 1024;
/** a step is an action, or one made from the state it meets: an answer to a read carries the number the reducer gave the read */
type Step = Action | ((state: SyncState) => Action);

function run(state: SyncState, steps: Step[]): { state: SyncState; results: Result[] } {
  const results: Result[] = [];
  for (const step of steps) {
    const result = reduce(state, typeof step === "function" ? step(state) : step);
    results.push(result);
    state = result.state;
  }
  return { state, results };
}

const effects = (results: Result[]): Effect[] => results.flatMap((r) => r.effects);
const evictions = (results: Result[]) => effects(results).filter((e) => e.type === "evicted");
const reads = (results: Result[]) => effects(results).filter((e) => e.type === "hydrate");
/** the answer to the thread's latest read, as the worker would send it */
const hydrate =
  (n: number, bytes?: number, at = 5, messages: Message[] = []): Step =>
  (state) => ({ type: "hydrated", key: key(n), hydration: state.threads[key(n)]?.hydration ?? 0, upstreamEpoch: "u1", at, messages, ...(bytes === undefined ? {} : { bytes }) });
const hold = (n: number, at: number): Action => ({ type: "hold", key: key(n), at });
const textPart = (messageID: string, text = "hello"): Part => ({ id: "prt_1", sessionID: "ses_1", messageID, type: "text", text });
const open = (n: number, at: number): Action => ({ type: "open", key: key(n), at });
/** the holds of `count` threads from `from`, `step` ms apart */
const holds = (count: number, from: number, at: number, step: number): Action[] => Array.from({ length: count }, (_, i) => hold(from + i, at + i * step));

/** `n` threads the person opened, in order, each read (so each is live) */
function opened(n: number, from = 1): SyncState {
  const steps: Step[] = [];
  for (let i = from; i < from + n; i++) steps.push(open(i, i), hydrate(i, 1000));
  return run(INITIAL_STATE, steps).state;
}

describe("a hold is not an open", () => {
  test("held threads have a reserve of their own: past it a hold is refused, and no opened thread goes for it", () => {
    const base = opened(THREAD_CAP - 5);
    const held = run(base, holds(HELD_CAP + 4, 100, 1000, 1));
    expect(Object.keys(held.state.threads)).toHaveLength(THREAD_CAP - 5 + HELD_CAP);
    for (let i = 1; i <= THREAD_CAP - 5; i++) expect(held.state.threads[key(i)]?.openedAt).toBe(i);
    const heldKeys = keys(held.state).filter((k) => Number(k.split("_")[1]) >= 100);
    expect(heldKeys).toEqual(Array.from({ length: HELD_CAP }, (_, i) => key(100 + i)).sort());
    expect(evictions(held.results)).toEqual([]);
    expect(reads(held.results)).toHaveLength(HELD_CAP);
  });

  test("a hold is read even when the person has opened as many threads as the cache keeps", () => {
    const full = opened(THREAD_CAP);
    const { state, results } = run(full, [hold(900, 5000)]);
    expect(keys(state)).toEqual([...keys(full), key(900)].sort());
    expect(reads(results)).toEqual([{ type: "hydrate", key: key(900), hydration: state.threads[key(900)]?.hydration as number }]);
  });

  test("a hold does not refresh the recency of an opened thread", () => {
    const { state, results } = run(opened(3), [hold(2, 9999)]);
    expect(state.threads[key(2)]?.openedAt).toBe(2);
    expect(state.threads[key(2)]?.heldAt).toBe(0);
    expect(results[0]?.patches).toEqual([]);
    expect(results[0]?.effects).toEqual([]);
  });

  test("the person's open past the cap evicts the thread opened longest ago and leaves every held thread", () => {
    const full = run(opened(THREAD_CAP), holds(5, 500, 99_000, 1)).state;
    const { state, results } = run(full, [open(700, 100_000)]);
    expect(state.threads[key(1)]).toBeUndefined();
    expect(state.threads[key(2)]?.openedAt).toBe(2);
    expect(state.threads[key(700)]?.openedAt).toBe(100_000);
    for (let i = 0; i < 5; i++) expect(state.threads[key(500 + i)]).toBeDefined();
    expect(evictions(results)).toContainEqual({ type: "evicted", key: key(1), bytes: 1000, opened: true, cap: "opened" });
  });

  test("a held thread the person then opens is promoted: it keeps what it read, is read no second time, and now counts as theirs", () => {
    const held = run(INITIAL_STATE, [hold(1, 10), hydrate(1, 4000)]).state;
    expect(held.threads[key(1)]).toMatchObject({ openedAt: 0, leased: true });
    const { state, results } = run(held, [open(1, 20)]);
    expect(state.threads[key(1)]).toMatchObject({ status: "live", openedAt: 20, heldAt: 10, leased: false, bytes: 4000 });
    expect(reads(results)).toEqual([]);
    // and the reserve of held threads, filled and passed, does not touch it
    const crowded = run(state, holds(HELD_CAP + 3, 100, 100_000, 1)).state;
    expect(crowded.threads[key(1)]).toBeDefined();
    expect(Object.values(crowded.threads).filter((t) => t.openedAt === 0)).toHaveLength(HELD_CAP);
  });

  test("promoting a held thread to opened past the person's cap evicts the one opened longest ago", () => {
    const base = run(opened(THREAD_CAP), [hold(900, 1000), hydrate(900, 1000)]).state;
    const { state, results } = run(base, [open(900, 1001)]);
    expect(Object.values(state.threads).filter((t) => t.openedAt > 0)).toHaveLength(THREAD_CAP);
    expect(state.threads[key(1)]).toBeUndefined();
    expect(state.threads[key(900)]?.openedAt).toBe(1001);
    expect(evictions(results)).toContainEqual({ type: "evicted", key: key(1), bytes: 1000, opened: true, cap: "opened" });
  });
});

describe("a hold is a lease on one of the reserve's places", () => {
  const wanted = Array.from({ length: 66 }, (_, i) => 1000 + i);

  test("66 children: 16 are read once, and no round after it reads one again, however long after", () => {
    let state = run(INITIAL_STATE, [open(1, 1), hydrate(1, MB)]).state;
    let at = 10;
    const round = (gap: number) => {
      at += gap;
      const r = run(state, wanted.map((n) => hold(n, at++)));
      state = r.state;
      return { read: reads(r.results).length, evicted: evictions(r.results).length };
    };
    expect(round(0)).toEqual({ read: HELD_CAP, evicted: 0 });
    expect(round(0)).toEqual({ read: 0, evicted: 0 });
    expect(round(60_000)).toEqual({ read: 0, evicted: 0 });
    expect(round(24 * 60 * 60 * 1000)).toEqual({ read: 0, evicted: 0 });
    expect(Object.keys(state.threads)).toHaveLength(1 + HELD_CAP);
    expect(state.threads[key(1)]).toBeDefined();
    expect(Object.values(state.threads).filter((t) => t.openedAt === 0).every((t) => t.leased)).toBe(true);
  });

  test("an old lease is never taken by a new hold: it is refused, reads nothing, and evicts nothing", () => {
    const full = run(INITIAL_STATE, holds(HELD_CAP, 1000, 100, 1)).state;
    const refused = run(full, [hold(2000, 100 * 365 * 24 * 60 * 60 * 1000)]);
    expect(refused.state.threads[key(2000)]).toBeUndefined();
    expect(keys(refused.state)).toEqual(keys(full));
    expect(effects(refused.results)).toEqual([]);
    expect(refused.results[0]?.patches).toEqual([]);
  });

  test("a released lease frees its place at once: the thread stays cached, and is the first to go when the place is wanted", () => {
    const full = run(INITIAL_STATE, [...holds(HELD_CAP, 1000, 100, 1), { type: "release", key: key(1005) }, { type: "release", key: key(1002) }]).state;
    // released, still there
    expect(full.threads[key(1005)]).toMatchObject({ leased: false, heldAt: 105 });
    expect(Object.keys(full.threads)).toHaveLength(HELD_CAP);
    const taken = run(full, [hold(2000, 200)]);
    // the one held longest ago of the released goes, and the newcomer is read
    expect(evictions(taken.results).map((e) => e.type === "evicted" && [e.key, e.cap])).toEqual([[key(1002), "held"]]);
    expect(reads(taken.results)).toHaveLength(1);
    expect(taken.state.threads[key(1005)]).toBeDefined();
    expect(taken.state.threads[key(2000)]).toMatchObject({ leased: true, heldAt: 200 });
    // every leased place stays with its lane
    for (const n of [1000, 1001, 1003, 1004, 1006, 1015]) expect(taken.state.threads[key(n)]?.leased).toBe(true);
  });

  test("a released thread that is held again takes its lease back with no read and no eviction", () => {
    const full = run(INITIAL_STATE, [...holds(HELD_CAP, 1000, 100, 1), { type: "release", key: key(1005) }]).state;
    const again = run(full, [hold(1005, 500), hold(2000, 501)]);
    expect(again.state.threads[key(1005)]).toMatchObject({ leased: true, heldAt: 500 });
    expect(effects(again.results.slice(0, 1))).toEqual([{ type: "head", key: key(1005) }]);
    // the places are leased again, so the next new hold is refused
    expect(again.state.threads[key(2000)]).toBeUndefined();
    expect(effects(again.results.slice(1))).toEqual([]);
  });

  test("a place whose thread was evicted is free: the byte cap takes a lease, and the next hold is read", () => {
    const full = run(INITIAL_STATE, [open(1, 1), hydrate(1, 100 * MB), ...holds(HELD_CAP, 1000, 100, 1)]).state;
    // a child's read of 60 mb cannot fit beside the 100 mb stage: it is dropped, and its place is free
    const grown = run(full, [hydrate(1000, 60 * MB)]);
    expect(grown.state.threads[key(1000)]).toBeUndefined();
    expect(Object.keys(grown.state.threads)).toHaveLength(1 + HELD_CAP - 1);
    const next = run(grown.state, [hold(2000, 300)]);
    expect(reads(next.results)).toHaveLength(1);
    expect(next.state.threads[key(2000)]?.leased).toBe(true);
  });

  test("a release for a thread that is not held, or is opened, changes nothing", () => {
    const base = opened(2);
    for (const k of [key(1), key(77)]) {
      const r = run(base, [{ type: "release", key: k }]);
      expect(effects(r.results)).toEqual([]);
      expect(r.results[0]?.patches).toEqual([]);
      expect(r.state.threads).toEqual(base.threads);
    }
  });
});

describe("a child that does not fit", () => {
  /** a stage of `stage` bytes, and `count` children held and read at `each` bytes, in order */
  function stageAndChildren(stage: number, count: number, each: number, from = 100) {
    const steps: Step[] = [open(1, 1), hydrate(1, stage), ...holds(count, from, 2, 1), ...Array.from({ length: count }, (_, i) => hydrate(from + i, each))];
    return run(INITIAL_STATE, steps);
  }

  test("is read once and then refused without a read, as often as the lane asks, while the room it needs cannot exist", () => {
    let state = run(INITIAL_STATE, [open(1, 1), hydrate(1, 100 * MB)]).state;
    const first = run(state, [hold(9, 10), hydrate(9, 60 * MB)]);
    state = first.state;
    expect(reads(first.results)).toHaveLength(1);
    expect(evictions(first.results).map((e) => e.type === "evicted" && [e.key, e.cap])).toEqual([[key(9), "unfit"]]);
    expect(state.unfit).toEqual({ [key(9)]: 60 * MB });
    for (let i = 0; i < 5; i++) {
      const again = run(state, [hold(9, 20 + i)]);
      expect(effects(again.results)).toEqual([]);
      expect(again.results[0]?.patches).toEqual([]);
      expect(again.state.threads[key(9)]).toBeUndefined();
      expect(again.state).toEqual(state);
    }
  });

  test("is read again when a lease is released and the room could exist, and then it fits", () => {
    // stage 60 mb and 12 children of 8 mb is 156 mb: the twelfth does not fit beside the other eleven, which are not its to take
    const { state: full, results } = stageAndChildren(60 * MB, 12, 8 * MB);
    expect(evictions(results).map((e) => e.type === "evicted" && [e.key, e.cap])).toEqual([[key(111), "unfit"]]);
    expect(Object.values(full.threads).filter((t) => t.openedAt === 0 && t.leased)).toHaveLength(11);
    expect(effects(run(full, [hold(111, 100)]).results)).toEqual([]);
    const freed = run(full, [{ type: "release", key: key(100) }, hold(111, 101)]);
    expect(reads(freed.results)).toHaveLength(1);
    const fitted = run(freed.state, [hydrate(111, 8 * MB)]);
    // the released thread's place is the room it takes, and nothing else is touched
    expect(evictions(fitted.results).map((e) => e.type === "evicted" && [e.key, e.cap])).toEqual([[key(100), "bytes"]]);
    expect(fitted.state.threads[key(111)]).toMatchObject({ status: "live", leased: true });
    expect(fitted.state.unfit).toEqual({});
  });

  test("is read again when the stage changes and the room could exist: the thread that was the stage is one the person can lose", () => {
    let state = run(INITIAL_STATE, [open(1, 1), hydrate(1, 100 * MB), hold(9, 10), hydrate(9, 60 * MB)]).state;
    expect(state.unfit[key(9)]).toBe(60 * MB);
    expect(effects(run(state, [hold(9, 11)]).results)).toEqual([]);
    state = run(state, [open(2, 20), hydrate(2, 10 * MB)]).state;
    const again = run(state, [hold(9, 30)]);
    expect(reads(again.results)).toHaveLength(1);
    const fitted = run(again.state, [hydrate(9, 60 * MB)]);
    expect(evictions(fitted.results).map((e) => e.type === "evicted" && [e.key, e.cap, e.opened])).toEqual([[key(1), "bytes", true]]);
    expect(keys(fitted.state)).toEqual([key(2), key(9)]);
  });

  test("is noted by its size, at most UNFIT_CAP are kept, and the one noted longest ago is forgotten first", () => {
    const steps: Step[] = [open(1, 1), hydrate(1, 100 * MB)];
    for (let i = 0; i < UNFIT_CAP + 6; i++) steps.push(hold(1000 + i, 10 + i), hydrate(1000 + i, 60 * MB));
    const { state } = run(INITIAL_STATE, steps);
    expect(Object.keys(state.unfit)).toHaveLength(UNFIT_CAP);
    expect(state.unfit[key(1000)]).toBeUndefined();
    expect(state.unfit[key(1000 + UNFIT_CAP + 5)]).toBe(60 * MB);
    // a forgotten child is read again, a remembered one is not
    expect(reads(run(state, [hold(1000, 500)]).results)).toHaveLength(1);
    expect(effects(run(state, [hold(1000 + UNFIT_CAP + 5, 500)]).results)).toEqual([]);
  });

  test("the person's open of it is never refused, and forgets the note", () => {
    const base = run(INITIAL_STATE, [open(1, 1), hydrate(1, 100 * MB), hold(9, 10), hydrate(9, 60 * MB)]).state;
    expect(base.unfit[key(9)]).toBeDefined();
    const opened = run(base, [open(9, 20)]);
    expect(reads(opened.results)).toHaveLength(1);
    expect(opened.state.unfit).toEqual({});
    expect(opened.state.threads[key(9)]).toMatchObject({ openedAt: 20 });
  });

  test("a child the stream grows past what fits beside the stage is dropped alone and noted, and no lease goes with it", () => {
    const part = textPart("msg_1");
    const mine: Message = { info: message("msg_1").info, parts: [{ ...part, text: "" }] };
    const base = run({ ...INITIAL_STATE, cursor: { epoch: EPOCH, seq: 0 } }, [open(1, 1), hydrate(1, 100 * MB), hold(8, 2), hydrate(8, 5 * MB), hold(9, 3), hydrate(9, 40 * MB, 5, [mine])]).state;
    expect(keys(base)).toEqual([key(1), key(8), key(9)]);
    const delta: Entry = { type: "delta", seq: 1, key: key(9), messageID: "msg_1", partID: part.id, field: "text", delta: "x".repeat(25 * MB), offset: 0 };
    const { state, results } = run(base, [{ type: "frame", epoch: EPOCH, frame: delta }]);
    expect(keys(state)).toEqual([key(1), key(8)]);
    expect(state.threads[key(8)]?.leased).toBe(true);
    expect(evictions(results).map((e) => e.type === "evicted" && [e.key, e.cap])).toEqual([[key(9), "unfit"]]);
    expect(state.unfit[key(9)]).toBeGreaterThan(60 * MB);
  });
});

describe("what a child's read may take room from", () => {
  test("the released held threads, then the opened threads that are not on stage, and never a lease", () => {
    // 130 mb: thread 2 (30) opened before the stage (60), a lease (20) and a released place (20)
    const base = run(INITIAL_STATE, [open(2, 1), hydrate(2, 30 * MB), open(1, 2), hydrate(1, 60 * MB), hold(10, 3), hydrate(10, 20 * MB), hold(11, 4), hydrate(11, 20 * MB), { type: "release", key: key(11) }]).state;
    expect(keys(base)).toEqual([key(1), key(10), key(11), key(2)].sort());
    // a child of 50 mb: 180 mb. the released place goes, and then the opened thread off stage; the lease and the stage stay
    const { state, results } = run(base, [hold(12, 5), hydrate(12, 50 * MB)]);
    expect(evictions(results).map((e) => e.type === "evicted" && [e.key, e.cap])).toEqual([[key(11), "bytes"], [key(2), "bytes"]]);
    expect(keys(state)).toEqual([key(1), key(10), key(12)]);
    expect(state.threads[key(10)]?.leased).toBe(true);
  });

  test("an open the person makes takes leases when the bytes need them, the one held longest ago first", () => {
    // 124 mb: 60 on stage and 16 leases of 4. a thread of 40 opened is 164
    const base = run(INITIAL_STATE, [open(1, 1), hydrate(1, 60 * MB), ...holds(HELD_CAP, 100, 2, 1), ...Array.from({ length: HELD_CAP }, (_, i) => hydrate(100 + i, 4 * MB))]).state;
    expect(Object.keys(base.threads)).toHaveLength(1 + HELD_CAP);
    const { state, results } = run(base, [open(2, 50), hydrate(2, 40 * MB)]);
    expect(evictions(results).map((e) => e.type === "evicted" && [e.key, e.cap, e.opened])).toEqual([100, 101, 102, 103].map((n) => [key(n), "bytes", false]));
    expect(state.threads[key(1)]).toBeDefined();
    expect(state.threads[key(2)]).toBeDefined();
  });
});

describe("a read of a thread that was evicted", () => {
  test("is not the answer to the read of the thread held again after it: numbers are never used twice", () => {
    const X = 500;
    let state: SyncState = { ...INITIAL_STATE, cursor: { epoch: EPOCH, seq: 0 } };
    // the child is held and its read goes out; the lane stops wanting it, and later holds evict it while the read is in flight
    const first = run(state, [hold(X, 1), { type: "release", key: key(X) }]);
    state = first.state;
    const oldRead = reads(first.results)[0];
    state = run(state, holds(HELD_CAP, 600, 2, 1)).state;
    expect(state.threads[key(X)]).toBeUndefined();
    // the journal carries a message the daemon logged at upstream 20 while the thread is not held: it applies to nothing
    const frame: Entry = { type: "message", seq: 1, key: key(X), upstream: 20, info: message("msg_new").info };
    state = run(state, [{ type: "frame", epoch: EPOCH, frame }]).state;
    // the lane wants it again, and has a place for it: a new read with a new number
    const again = run(state, [{ type: "release", key: key(600) }, hold(X, 100)]);
    state = again.state;
    const newRead = reads(again.results)[0];
    expect(oldRead?.type === "hydrate" && newRead?.type === "hydrate" && newRead.hydration !== oldRead.hydration).toBe(true);
    // the first read answers late, taken at upstream 10, before the message: it is dropped
    const late = run(state, [{ type: "hydrated", key: key(X), hydration: oldRead?.type === "hydrate" ? oldRead.hydration : 0, upstreamEpoch: "u1", at: 10, messages: [], bytes: 100 }]);
    expect(late.state.threads[key(X)]?.status).toBe("hydrating");
    // the second answers, taken after the message: that is the thread
    const answered = run(late.state, [{ type: "hydrated", key: key(X), hydration: newRead?.type === "hydrate" ? newRead.hydration : 0, upstreamEpoch: "u1", at: 25, messages: [message("msg_new")], bytes: 100 }]);
    expect(answered.state.threads[key(X)]?.messages.map((m) => m.info.id)).toEqual(["msg_new"]);
  });

  test("a read started again for a thread that was read again (a reset, a host reset) has a number no other read had", () => {
    let state = run({ ...INITIAL_STATE, cursor: { epoch: EPOCH, seq: 0 } }, [open(1, 1), hydrate(1, 100), open(2, 2), hydrate(2, 100)]).state;
    const seen = new Set<number>();
    for (const result of [reduce(state, { type: "frame", epoch: "j2", frame: { type: "reset", seq: 1, epoch: "j2", reason: "epoch", fleet: { hosts: [], sessions: [], asks: [], order: [] } } })]) {
      state = result.state;
      for (const e of reads([result])) if (e.type === "hydrate") seen.add(e.hydration);
    }
    expect(seen.size).toBe(2);
    expect(state.reads).toBe(4);
  });

  test("a refetch is for the incarnation of the thread that asked: the answer for an evicted thread's refetch is not taken by the thread held again", () => {
    const X = 500;
    let state: SyncState = { ...INITIAL_STATE, cursor: { epoch: EPOCH, seq: 0 } };
    state = run(state, [hold(X, 1), hydrate(X, 100, 5, [message("msg_1")])]).state;
    const first = state.threads[key(X)]?.hydration ?? -1;
    // an entry for a message the thread lacks: it asks for that message, as the read it is
    const asked = run(state, [{ type: "frame", epoch: EPOCH, frame: { type: "part", seq: 1, key: key(X), upstream: 30, part: textPart("msg_2") } }]);
    expect(effects(asked.results)).toEqual([{ type: "refetch", key: key(X), messageID: "msg_2", hydration: first }]);
    // the lane lets it go and sixteen others take its place while that is in flight
    state = run(asked.state, [{ type: "release", key: key(X) }, ...holds(HELD_CAP, 600, 2, 1)]).state;
    expect(state.threads[key(X)]).toBeUndefined();
    // a place frees, the lane holds it again, it is read, and an entry for the same message makes it ask too
    state = run(state, [{ type: "release", key: key(600) }, hold(X, 100), hydrate(X, 100, 40, [message("msg_1")])]).state;
    const second = state.threads[key(X)]?.hydration ?? -1;
    expect(second).not.toBe(first);
    const askedAgain = run(state, [{ type: "frame", epoch: EPOCH, frame: { type: "part", seq: 2, key: key(X), upstream: 50, part: textPart("msg_2", "hello again") } }]);
    expect(effects(askedAgain.results)).toEqual([{ type: "refetch", key: key(X), messageID: "msg_2", hydration: second }]);
    // the first one's answer, a snapshot older than that entry, comes: it is not the answer to this thread's refetch
    const old = reduce(askedAgain.state, { type: "refetched", key: key(X), hydration: first, messageID: "msg_2", message: { ...message("msg_2"), parts: [textPart("msg_2", "hello")] } });
    expect(old.state.threads[key(X)]?.refetching.msg_2).toHaveLength(1);
    expect(old.state.threads[key(X)]?.messages.map((m) => m.info.id)).toEqual(["msg_1"]);
    // its own is
    const own = reduce(askedAgain.state, { type: "refetched", key: key(X), hydration: second, messageID: "msg_2", message: { ...message("msg_2"), parts: [textPart("msg_2", "hello")] } });
    expect(own.state.threads[key(X)]?.refetching).toEqual({});
    expect(own.state.threads[key(X)]?.messages.map((m) => m.info.id)).toEqual(["msg_1", "msg_2"]);
    expect(own.state.threads[key(X)]?.messages[1]?.parts[0]).toMatchObject({ text: "hello again" });
  });
});

describe("the byte cap", () => {
  test("a read that passes it evicts the held threads first, then the person's coldest not on stage, and keeps the thread it was for", () => {
    let state = run(INITIAL_STATE, [open(1, 1), hydrate(1, 60 * MB), hold(9, 2), hydrate(9, 40 * MB), open(2, 3), hydrate(2, 40 * MB)]).state;
    // 140 mb: under the cap
    expect(keys(state)).toEqual([key(1), key(2), key(9)].sort());
    const next = run(state, [open(3, 4), hydrate(3, 30 * MB)]);
    state = next.state;
    // 170 mb: the held one goes, which is enough
    expect(keys(state)).toEqual([key(1), key(2), key(3)]);
    expect(evictions(next.results)).toContainEqual({ type: "evicted", key: key(9), bytes: 40 * MB, opened: false, cap: "bytes" });
    const more = run(state, [open(4, 5), hydrate(4, 50 * MB)]).state;
    // 180 mb: the person's coldest goes
    expect(keys(more)).toEqual([key(2), key(3), key(4)]);
    expect(Object.values(more.threads).reduce((n, t) => n + t.bytes, 0)).toBeLessThanOrEqual(BYTE_CAP);
  });

  test("the byte cap takes released held threads before leased ones, whatever their age", () => {
    // 140 mb: 80 on stage, an older lease of 30 and a newer released thread of 30. a 20 mb thread opened passes the cap
    const base = run(INITIAL_STATE, [open(1, 1), hydrate(1, 80 * MB), hold(8, 2), hydrate(8, 30 * MB), hold(9, 3), hydrate(9, 30 * MB), { type: "release", key: key(9) }]).state;
    expect(keys(base)).toEqual([key(1), key(8), key(9)]);
    const { state, results } = run(base, [open(2, 10), hydrate(2, 20 * MB)]);
    expect(keys(state)).toEqual([key(1), key(2), key(8)]);
    expect(evictions(results)).toEqual([{ type: "evicted", key: key(9), bytes: 30 * MB, opened: false, cap: "bytes" }]);
  });

  test("a child's read that passes the cap with only opened threads to give takes the coldest one that is not on stage, never the stage", () => {
    const state = run(INITIAL_STATE, [open(1, 1), hydrate(1, 50 * MB), open(2, 2), hydrate(2, 50 * MB), open(3, 3), hydrate(3, 40 * MB)]).state;
    const { state: after, results } = run(state, [hold(9, 4), hydrate(9, 30 * MB)]);
    expect(keys(after)).toEqual([key(2), key(3), key(9)]);
    expect(evictions(results)).toContainEqual({ type: "evicted", key: key(1), bytes: 50 * MB, opened: true, cap: "bytes" });
  });

  test("a thread larger than the cap stays while the person has it open, and takes the others with it", () => {
    const { state } = run(opened(3), [open(50, 100), hydrate(50, BYTE_CAP + MB)]);
    expect(keys(state)).toEqual([key(50)]);
  });

  test("a held thread whose read passes the cap with only the stage to give is the one dropped", () => {
    // the one opened is on stage, so the child is the only thing that can go
    const base = run(INITIAL_STATE, [open(1, 1), hydrate(1, 100 * MB)]).state;
    const { state, results } = run(base, [hold(9, 2), hydrate(9, 60 * MB)]);
    expect(keys(state)).toEqual([key(1)]);
    expect(evictions(results)).toContainEqual({ type: "evicted", key: key(9), bytes: 60 * MB, opened: false, cap: "unfit" });
  });

  test("a held read that cannot fit beside the stage evicts nothing else for it, however many opened threads there are to give", () => {
    // four older opened threads of 15 mb and the stage at 60 mb: 120 mb. a child's read of 100 mb cannot fit beside the stage
    const steps: Step[] = [];
    for (let i = 1; i <= 4; i++) steps.push(open(i, i), hydrate(i, 15 * MB));
    steps.push(open(5, 5), hydrate(5, 60 * MB));
    const base = run(INITIAL_STATE, steps).state;
    const { state, results } = run(base, [hold(9, 10), hydrate(9, 100 * MB)]);
    expect(keys(state)).toEqual([key(1), key(2), key(3), key(4), key(5)]);
    expect(evictions(results).map((e) => e.type === "evicted" && [e.key, e.cap])).toEqual([[key(9), "unfit"]]);
  });

  test("growth by the stream past the cap evicts at once, held threads first, and never the thread on stage", () => {
    const part = (text: string): Part => ({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text });
    const read = run({ ...INITIAL_STATE, cursor: { epoch: EPOCH, seq: 0 } }, [
      open(1, 1),
      hydrate(1, BYTE_CAP - 3 * MB, 5, [{ info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } }, parts: [part("")] }]),
      hold(9, 2),
      hydrate(9, MB),
    ]).state;
    expect(keys(read)).toEqual([key(1), key(9)]);
    const delta: Entry = { type: "delta", seq: 1, key: key(1), messageID: "msg_1", partID: "prt_1", field: "text", delta: "x".repeat(2 * MB + 1), offset: 0 };
    const { state, results } = run(read, [{ type: "frame", epoch: EPOCH, frame: delta }]);
    expect(keys(state)).toEqual([key(1)]);
    expect(evictions(results)).toContainEqual({ type: "evicted", key: key(9), bytes: MB, opened: false, cap: "bytes" });
  });

  test("a part replaced or grown is counted from its words and its weight: nothing is stringified, however big its output", () => {
    const tool = (output: string): Part => ({
      id: "prt_tool",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "completed", input: { command: "cat big" }, output, title: "cat big", metadata: {}, time: { start: 1, end: 2 } },
    });
    const big = "y".repeat(6 * MB);
    const withTool: Message = { info: message("msg_1").info, parts: [tool(big), textPart("msg_1", "")] };
    const read = run({ ...INITIAL_STATE, cursor: { epoch: EPOCH, seq: 0 } }, [open(1, 1), hydrate(1, 7 * MB, 5, [withTool])]).state;
    const stringify = spyOn(JSON, "stringify");
    try {
      const frames: Entry[] = [
        { type: "part", seq: 1, key: key(1), upstream: 6, part: tool(big + "z".repeat(1000)) },
        { type: "delta", seq: 2, key: key(1), messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello", offset: 0 },
        { type: "part", seq: 3, key: key(1), upstream: 7, part: textPart("msg_1", "hello, and the whole of it") },
        { type: "message", seq: 4, key: key(1), upstream: 8, info: { ...message("msg_1").info, role: "user" } },
      ];
      const { state } = run(read, frames.map((frame) => ({ type: "frame", epoch: EPOCH, frame }) satisfies Action));
      expect(stringify).not.toHaveBeenCalled();
      // the tool part grew by the 1000 characters it gained, the text part from no words to 26 (its envelope was already counted),
      // and the info's role is "user" for "assistant"
      const grown = (state.threads[key(1)]?.bytes ?? 0) - (read.threads[key(1)]?.bytes ?? 0);
      expect(grown).toBe(1000 + "hello, and the whole of it".length + ("user".length - "assistant".length));
    } finally {
      stringify.mockRestore();
    }
  });

  test("bytes follow what the thread takes in: a read's size, then each part and delta, with no part stringified to be counted", () => {
    const part = (text: string): Part => ({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text });
    const message: Message = { info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } }, parts: [] };
    const read = run(INITIAL_STATE, [open(1, 1), { type: "hydrated", key: key(1), hydration: 1, upstreamEpoch: "u1", at: 5, messages: [message] }]).state;
    expect(read.threads[key(1)]?.bytes).toBe(JSON.stringify([message]).length);
    const before = read.threads[key(1)]?.bytes ?? 0;
    const journal: Entry[] = [
      { type: "part", seq: 1, key: key(1), upstream: 6, part: part("") },
      { type: "delta", seq: 2, key: key(1), messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello", offset: 0 },
      { type: "delta", seq: 3, key: key(1), messageID: "msg_1", partID: "prt_1", field: "text", delta: " world", offset: 5 },
    ];
    const after = run({ ...read, cursor: { epoch: EPOCH, seq: 0 } }, journal.map((frame) => ({ type: "frame", frame, epoch: EPOCH }) satisfies Action)).state;
    expect(after.threads[key(1)]?.bytes).toBe(before + PART_ENVELOPE + "hello world".length);
    // the part comes whole, replacing the one the deltas made: its size replaces theirs
    const whole: Entry = { type: "part", seq: 4, key: key(1), upstream: 7, part: part("hello world, and more") };
    const replaced = run(after, [{ type: "frame", epoch: EPOCH, frame: whole }]).state;
    expect(replaced.threads[key(1)]?.bytes).toBe(before + PART_ENVELOPE + "hello world, and more".length);
  });
});

/* —— threads that are only a head until their pages are read —— */

const head = (n: number, over: Partial<Cold> = {}): Cold => ({
  key: key(n),
  status: "live",
  hydration: 3,
  upstreamEpoch: "u1",
  hydratedAt: 10,
  lastUpstream: 12,
  baseline: {},
  refetching: [],
  openedAt: 7,
  heldAt: 0,
  leased: false,
  bytes: 5000,
  sized: true,
  pages: 1,
  stale: false,
  ...over,
});

const message = (id: string): Message => ({ info: { id, sessionID: "ses_1", role: "assistant", time: { created: 1 } }, parts: [] });
const coldState = (...heads: Cold[]): SyncState => ({ ...INITIAL_STATE, cursor: { epoch: EPOCH, seq: 100 }, cold: Object.fromEntries(heads.map((h) => [h.key, h])) });
const entryFor = (n: number, seq = 101): Action => ({ type: "frame", epoch: EPOCH, frame: { type: "message", seq, key: key(n), upstream: 20, info: message("msg_9").info } satisfies Entry });

describe("a cold thread", () => {
  test("restoring one the journal never touched is a live thread again, as saved, with nothing asked of the daemon", () => {
    const { state, results } = run(coldState(head(1)), [{ type: "restored", key: key(1), messages: [message("msg_1")] }]);
    expect(state.cold).toEqual({});
    // its read number is a new one, not the saved one: the saved one is from another life of the page
    expect(state.threads[key(1)]).toMatchObject({ status: "live", hydration: 1, hydratedAt: 10, lastUpstream: 12, openedAt: 7, bytes: 5000 });
    expect(results[0]?.patches).toEqual([{ path: ["threads", key(1)], value: { key: key(1), status: "live", messages: [message("msg_1")] } }]);
    expect(effects(results)).toEqual([]);
  });

  test("an entry for it cannot apply, so the thread is marked, once, and is read again when its pages come back", () => {
    const first = run(coldState(head(1)), [entryFor(1, 101), entryFor(1, 102)]);
    expect(first.state.cold[key(1)]?.stale).toBe(true);
    expect(first.state.cursor?.seq).toBe(102);
    expect(effects(first.results)).toEqual([{ type: "head", key: key(1) }]);
    const back = run(first.state, [{ type: "restored", key: key(1), messages: [message("msg_1")] }]);
    expect(back.state.threads[key(1)]).toMatchObject({ status: "hydrating", hydration: 1 });
    expect(back.state.threads[key(1)]?.messages).toEqual([message("msg_1")]);
    expect(effects(back.results)).toEqual([{ type: "hydrate", key: key(1), hydration: 1 }]);
  });

  test("an entry for another thread leaves it as it was", () => {
    const { state } = run(coldState(head(1), head(2)), [entryFor(2)]);
    expect(state.cold[key(1)]?.stale).toBe(false);
    expect(state.cold[key(2)]?.stale).toBe(true);
  });

  test("a reset marks every cold thread, and a host's reset marks that host's", () => {
    const base = coldState(head(1), { ...head(2), key: "other:ses_2" });
    const reset = run(base, [{ type: "frame", epoch: "j2", frame: { type: "reset", seq: 5, epoch: "j2", reason: "epoch", fleet: { hosts: [], sessions: [], asks: [], order: [] } } }]);
    expect(Object.values(reset.state.cold).map((h) => h.stale)).toEqual([true, true]);
    const hostReset = run(base, [{ type: "frame", epoch: EPOCH, frame: { type: "host.reset", seq: 101, host: "other", sessions: [], asks: [] } }]);
    expect(hostReset.state.cold[key(1)]?.stale).toBe(false);
    expect(hostReset.state.cold["other:ses_2"]?.stale).toBe(true);
  });

  test("a thread saved mid-read starts again when it is restored, and one saved mid-refetch asks for its message", () => {
    const reading = run(coldState(head(1, { status: "hydrating" }), head(2, { refetching: ["msg_4"] })), [
      { type: "restored", key: key(1), messages: [] },
      { type: "restored", key: key(2), messages: [] },
    ]);
    expect(effects(reading.results)).toEqual([
      { type: "hydrate", key: key(1), hydration: 1 },
      { type: "refetch", key: key(2), messageID: "msg_4", hydration: 2 },
    ]);
  });

  test("pages that could not be read start the thread over from the daemon", () => {
    const { state, results } = run(coldState(head(1)), [{ type: "restored", key: key(1), messages: null }]);
    expect(state.threads[key(1)]).toMatchObject({ status: "hydrating", messages: [], bytes: 0 });
    expect(effects(results)).toEqual([{ type: "hydrate", key: key(1), hydration: 1 }]);
  });

  test("restoring a thread twice, or one that was evicted meanwhile, changes nothing", () => {
    const once = run(coldState(head(1)), [{ type: "restored", key: key(1), messages: [] }]).state;
    expect(reduce(once, { type: "restored", key: key(1), messages: [message("x")] }).state).toEqual(once);
    expect(reduce(INITIAL_STATE, { type: "restored", key: key(1), messages: [] }).state).toEqual(INITIAL_STATE);
  });

  test("cold threads count toward their caps: opened ones toward the person's, held-only toward the reserve", () => {
    const cold = coldState(...Array.from({ length: THREAD_CAP }, (_, i) => head(i + 1, { openedAt: 10 + i })), ...Array.from({ length: HELD_CAP }, (_, i) => head(100 + i, { openedAt: 0, heldAt: 3 + i })));
    const opens = run(cold, [open(900, 9000)]);
    expect(opens.state.cold[key(1)]).toBeUndefined();
    expect(Object.keys(opens.state.cold)).toHaveLength(THREAD_CAP + HELD_CAP - 1);
    expect(Object.keys(opens.state.threads)).toEqual([key(900)]);
    expect(evictions(opens.results)).toContainEqual({ type: "evicted", key: key(1), bytes: 5000, opened: true, cap: "opened" });
    const holdsNew = run(cold, [hold(901, 20_000)]);
    expect(holdsNew.state.cold[key(100)]).toBeUndefined();
    expect(holdsNew.state.cold[key(1)]).toBeDefined();
    expect(evictions(holdsNew.results)).toContainEqual({ type: "evicted", key: key(100), bytes: 5000, opened: false, cap: "held" });
  });

  test("a page that was reloaded starts with no leases: held threads the cache kept are free places, the one held longest ago first", () => {
    const cold = coldState(...Array.from({ length: HELD_CAP }, (_, i) => head(100 + i, { openedAt: 0, heldAt: 3 + i, leased: false })));
    const { state, results } = run(cold, [hold(901, 4)]);
    expect(reads(results)).toHaveLength(1);
    expect(state.threads[key(901)]?.leased).toBe(true);
    expect(evictions(results).map((e) => e.type === "evicted" && e.key)).toEqual([key(100)]);
  });

  test("a hold on a cold thread leases its place, so a full reserve of such is refused", () => {
    const cold = coldState(...Array.from({ length: HELD_CAP }, (_, i) => head(100 + i, { openedAt: 0, heldAt: 3 + i })));
    const leased = run(cold, Array.from({ length: HELD_CAP }, (_, i) => hold(100 + i, 50 + i))).state;
    expect(Object.values(leased.cold).every((c) => c.leased)).toBe(true);
    const refused = run(leased, [hold(901, 60)]);
    expect(effects(refused.results)).toEqual([]);
    expect(refused.state.threads[key(901)]).toBeUndefined();
    // and the lease comes with the thread when its pages are read
    const back = run(leased, [{ type: "restored", key: key(100), messages: [message("m")] }]).state;
    expect(back.threads[key(100)]).toMatchObject({ leased: true, heldAt: 50 });
  });

  test("a held thread that was cold is promoted by an open, with the read it was saved with", () => {
    const restoredState = run(coldState(head(1, { openedAt: 0, heldAt: 5 })), [{ type: "restored", key: key(1), messages: [] }, open(1, 50)]);
    expect(restoredState.state.threads[key(1)]).toMatchObject({ openedAt: 50, heldAt: 5, status: "live" });
  });

  test("an open takes the cold thread where it is, so the read of its pages cannot race its eviction", () => {
    const cold = coldState(...Array.from({ length: THREAD_CAP }, (_, i) => head(i + 1, { openedAt: 10 + i })));
    // opening the coldest: it is promoted to the newest, and the next coldest is the one that goes for the cap's room
    const { state, results } = run(cold, [open(1, 9000), open(900, 9001)]);
    expect(state.cold[key(1)]).toMatchObject({ openedAt: 9000 });
    expect(state.cold[key(2)]).toBeUndefined();
    expect(evictions(results).map((e) => e.type === "evicted" && e.key)).toEqual([key(2)]);
    expect(reads(results).map((e) => e.type === "hydrate" && e.key)).toEqual([key(900)]);
    // and the pages that come back are the promoted thread's
    const back = run(state, [{ type: "restored", key: key(1), messages: [message("msg_1")] }]).state;
    expect(back.threads[key(1)]).toMatchObject({ openedAt: 9000, status: "live" });
  });

  test("a head with no size counts for nothing until its pages are measured, and then for what they are", () => {
    const unsized = (n: number) => head(n, { sized: false, bytes: 0, openedAt: n });
    const state = coldState(...Array.from({ length: 30 }, (_, i) => unsized(i + 1)));
    expect(Object.values(state.cold).reduce((n, c) => n + c.bytes, 0)).toBe(0);
    // an open of one of them is not over the byte cap for the others' unknown sizes
    const opened = run(state, [open(1, 9000)]);
    expect(evictions(opened.results)).toEqual([]);
    // restored with a measured size: that is the thread's size
    const back = run(opened.state, [{ type: "restored", key: key(1), messages: [message("m")], bytes: 7 * MB }]).state;
    expect(back.threads[key(1)]?.bytes).toBe(7 * MB);
  });
});
