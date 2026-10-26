/* protocol 3's rules in the reducer (docs/protocol.md, sections 3 to 9): each test here fails on the contract 1 reducer.
   the golden replay at the end is the first equivalence proof: the server's simulated encoder's home tape, replayed
   through the reducer, ends with the fleet the server's reset at the same head carries. */

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry, Frame, Hello, Message, Part, Reset, Thread as FleetThread } from "./protocol";
import { parseCursor, textOf } from "./protocol";
import { type Action, type Effect, fleetOf, INITIAL_STATE, reduce, type Result, streamQuery, type SyncState } from "./reducer";
import { snapshot, thread } from "./fixtures/neutral";

const EPOCH = "e1";
const A = "bench:ses_a";
const B = "bench:ses_b";
const C = "bench:ses_c";
const D = "bench:ses_d";

function run(state: SyncState, actions: Action[]): { state: SyncState; results: Result[]; effects: Effect[] } {
  const results: Result[] = [];
  for (const action of actions) {
    const result = reduce(state, action);
    results.push(result);
    state = result.state;
  }
  return { state, results, effects: results.flatMap((r) => r.effects) };
}

/** a frame with the id line the server writes for it */
const frame = (f: Frame, epoch = EPOCH): Action => {
  const seq = f.type === "hello" || f.type === "catchup" || f.type === "thread.stale" ? null : f.seq;
  return { type: "frame", frame: f, id: seq === null ? null : { epoch, seq } };
};

const hello = (interest: { thread?: string | null; under?: string[]; holds?: string[] } = {}, head = 0): Action =>
  frame({ type: "hello", protocol: 3, epoch: EPOCH, head, build: "b", stream: "s1", interest: { thread: interest.thread ?? null, under: interest.under ?? [], holds: interest.holds ?? [] } } satisfies Hello);

const resetTo = (seq = 0, threads: FleetThread[] = [thread(A), thread(B), thread(C), thread(D)]): Action =>
  frame({ type: "reset", seq, epoch: EPOCH, reason: "none", fleet: snapshot(threads) } satisfies Reset);

const text = (id: string, value: string, messageID = "msg_1"): Part => ({ id, messageID, type: "text", text: value });
const message = (id: string, parts: Part[] = []): Message => ({ info: { id, role: "assistant", created: 1 }, parts });

const hydrated = (key: string, hydration: number, messages: Message[] = [], seq = 0, at = 5): Action => ({ type: "hydrated", key, hydration, upstreamEpoch: "u1", at, seq, messages });

/** the hydration number of the last hydrate effect for a key */
const readOf = (effects: readonly Effect[], key: string): number | undefined => effects.filter((e) => e.type === "hydrate" && e.key === key).map((e) => (e as { hydration: number }).hydration).at(-1);

/** a live thread `key` holding `messages`, after a reset at seq 0, with `interest` declared by the hello */
function live(keys: string[], interest: Parameters<typeof hello>[0] = {}, messages: Message[] = []): SyncState {
  // the page shows the interest before the stream opens, so the hello confirms what it wants
  const wanted: Action = { type: "want", thread: interest.thread ?? null, under: interest.under ?? [], holds: interest.holds ?? [] };
  let { state } = run(INITIAL_STATE, [wanted, hello(interest), resetTo()]);
  for (const key of keys) {
    const opened = run(state, [{ type: "open", key, at: keys.indexOf(key) + 1 }]);
    const n = readOf(opened.effects, key) ?? opened.state.threads[key]?.hydration ?? 0;
    state = run(opened.state, [hydrated(key, n, messages)]).state;
  }
  return state;
}

const settle = (n: number): Entry => ({ seq: n, type: "order", keys: [] });

describe("the cursor on a filtered stream", () => {
  test("a skipped seq is never a gap: every higher seq applies and moves the cursor", () => {
    const { state, effects } = run(INITIAL_STATE, [resetTo(0), frame(settle(1)), frame(settle(3)), frame(settle(40))]);
    expect(state.cursor).toEqual({ epoch: EPOCH, seq: 40 });
    expect(state.counters.applied).toBe(3);
    expect(effects).toEqual([]);
  });

  test("an entry at or below the cursor is a duplicate", () => {
    const { state } = run(INITIAL_STATE, [resetTo(0), frame(settle(5)), frame(settle(5)), frame(settle(2))]);
    expect(state.cursor?.seq).toBe(5);
    expect(state.counters.duplicates).toBe(2);
  });

  test("a frame of a type this client does not know moves the cursor by its id and changes nothing else", () => {
    const before = run(INITIAL_STATE, [resetTo(0), frame(settle(1))]).state;
    const after = run(before, [{ type: "skipped", id: { epoch: EPOCH, seq: 9 } }]);
    expect(after.state).toEqual({ ...before, cursor: { epoch: EPOCH, seq: 9 } });
    expect(after.effects).toEqual([]);
    // one behind the cursor, or of another epoch, moves nothing
    expect(run(after.state, [{ type: "skipped", id: { epoch: EPOCH, seq: 3 } }]).state).toEqual(after.state);
    expect(run(after.state, [{ type: "skipped", id: { epoch: "e0", seq: 30 } }]).state).toEqual(after.state);
  });

  test("caught and a confirm carry the head as their id, which becomes the cursor", () => {
    const { state } = run(INITIAL_STATE, [hello({}, 50), resetTo(10), frame(settle(12)), frame({ type: "caught", seq: 50 })]);
    expect(state.cursor).toEqual({ epoch: EPOCH, seq: 50 });
  });
});

describe("a frame that cannot apply", () => {
  const base = () =>
    run(INITIAL_STATE, [resetTo(0, [thread(A, { tail: [tailItem("p1", "one"), tailItem("p2", "two")] }), thread(B)]), frame({ seq: 1, type: "order", keys: [A, B] })]).state;

  const cases: Array<[string, Entry | "broken"]> = [
    ["a thread patch for a key the client does not hold", { seq: 2, type: "thread.patch", key: "bench:ses_x", set: { title: "x" } }],
    ["a tail put past the tail's length", { seq: 2, type: "thread.patch", key: A, set: { title: "x" }, tail: { drop: 0, put: [[3, tailItem("p3", "three")]] } }],
    ["a tail drop past the tail", { seq: 2, type: "thread.patch", key: A, tail: { drop: 3, put: [] } }],
    ["a tail longer than 12", { seq: 2, type: "thread.patch", key: A, tail: { drop: 0, put: Array.from({ length: 11 }, (_, i) => [i + 2, tailItem(`q${i}`, "x")] as [number, ReturnType<typeof tailItem>]) } }],
    ["an order remove out of range", { seq: 2, type: "order.patch", ops: [["+", 0, ["bench:ses_z"]], ["-", 2, 2]] }],
    ["an order insert out of range", { seq: 2, type: "order.patch", ops: [["+", 3, ["bench:ses_z"]]] }],
    ["a catch-up that does not parse", "broken"],
  ];

  for (const [name, bad] of cases) {
    test(`${name}: nothing of it applies, the cursor goes, a fault is counted and the worker reconnects`, () => {
      const before = base();
      const action: Action = bad === "broken" ? { type: "broken", what: "catchup-error" } : frame(bad);
      const { state, effects, results } = run(before, [action]);
      expect(state).toEqual({ ...before, cursor: null });
      expect(results[0]?.patches).toEqual([]);
      expect(effects).toEqual([{ type: "fault", what: bad === "broken" ? "catchup-error" : "patch-error" }, { type: "reconnect" }]);
    });
  }

  test("entries after it on the same stream apply nothing until the reset", () => {
    const failed = run(base(), [frame({ seq: 2, type: "thread.patch", key: "bench:ses_x", set: { title: "x" } })]).state;
    const after = run(failed, [frame(settle(3))]);
    expect(after.state.fleet).toEqual(failed.fleet);
    expect(after.effects).toEqual([{ type: "reconnect" }]);
    const reset = run(after.state, [resetTo(5)]);
    expect(reset.state.cursor).toEqual({ epoch: EPOCH, seq: 5 });
  });
});

function tailItem(partID: string, words: string) {
  return { partID, messageID: "msg_1", kind: "text" as const, role: "assistant", text: words };
}

describe("thread and order patches", () => {
  test("a thread patch sets what changed, unsets what went, and drops and puts tail items", () => {
    const start = thread(A, { cost: 3, tail: [tailItem("p1", "one"), tailItem("p2", "two"), tailItem("p3", "three")] });
    const { state, results } = run(INITIAL_STATE, [
      resetTo(0, [start]),
      frame({ seq: 1, type: "thread.patch", key: A, set: { activity: { state: "busy", since: 9 }, updated: 9, title: null }, unset: ["cost"], tail: { drop: 1, put: [[1, tailItem("p3", "three and more")], [2, tailItem("p4", "four")]] } }),
    ]);
    const { cost: _, ...rest } = start;
    expect(state.fleet.threads[A]).toEqual({ ...rest, activity: { state: "busy", since: 9 }, updated: 9, tail: [tailItem("p2", "two"), tailItem("p3", "three and more"), tailItem("p4", "four")] });
    // the ui gets what changed, not the thread whole
    expect(results[1]?.patches.some((p) => p.path.length === 3 && p.path[2] === A)).toBe(false);
    expect(results[1]?.patches.some((p) => p.path.join("/") === `fleet/threads/${A}/cost` && "value" in p && p.value === undefined)).toBe(true);
  });

  test("order ops apply in turn against the list as it is edited", () => {
    const { state } = run(INITIAL_STATE, [resetTo(0), frame({ seq: 1, type: "order", keys: ["a", "b", "c", "d"] }), frame({ seq: 2, type: "order.patch", ops: [["-", 1, 2], ["+", 0, ["c"]], ["+", 3, ["e", "f"]]] })]);
    expect(state.fleet.order).toEqual(["c", "a", "d", "e", "f"]);
  });

  test("agents, threads and asks follow their entries, asks keyed by agent and id", () => {
    const agent = { key: "bench" } as unknown as import("./protocol").Agent;
    const ask = { key: A, agent: "bench", id: "per_1", thread: A, kind: "permission" as const };
    const { state } = run(INITIAL_STATE, [
      resetTo(0, []),
      frame({ seq: 1, type: "agent", agent }),
      frame({ seq: 2, type: "thread", thread: thread(A) }),
      frame({ seq: 3, type: "ask", ask }),
    ]);
    expect(state.fleet.agentNames).toEqual(["bench"]);
    expect(state.fleet.asks).toEqual({ "bench:per_1": ask });
    const gone = run(state, [frame({ seq: 4, type: "ask.settled", agent: "bench", id: "per_1", outcome: "answered", at: 1 }), frame({ seq: 5, type: "thread.removed", key: A }), frame({ seq: 6, type: "agent.removed", agent: "bench" })]).state;
    expect(gone.fleet).toEqual({ agentNames: [], agents: {}, threads: {}, asks: {}, order: [], colours: {} });
  });
});

describe("a catch-up", () => {
  test("applies its transcript entries by the transcript rules and never moves the cursor, whatever their seqs", () => {
    const state = live([A], { thread: A }, [message("msg_1", [text("p1", "hello")])]);
    const at = run(state, [frame(settle(20))]).state;
    const { state: after, effects } = run(at, [
      frame({
        type: "catchup",
        entries: [
          { seq: 7, type: "delta", key: A, messageID: "msg_1", partID: "p1", field: "text", delta: " there", offset: 5 },
          { seq: 25, type: "message", key: A, upstream: 9, message: { id: "msg_2", role: "user", created: 2 } },
        ],
      }),
    ]);
    expect(after.cursor).toEqual({ epoch: EPOCH, seq: 20 });
    expect(after.threads[A]?.messages.map((m) => m.info.id)).toEqual(["msg_1", "msg_2"]);
    expect((after.threads[A]?.messages[0]?.parts[0] as { text: string }).text).toBe("hello there");
    expect(after.counters.applied).toBe(at.counters.applied);
    expect(effects).toEqual([]);
  });
});

describe("interest", () => {
  test("what the page shows is posted with the next ask, with each held key's left as its since", () => {
    let state = live([A, B], { thread: A, holds: [B] });
    state = run(state, [frame(settle(30)), { type: "want", thread: C, under: [A], holds: [] }, { type: "post-interest" }]).state;
    expect(state.interest.ask).toBe(1);
    // B left at the confirm; until then it is still in interest
    const posted = run(state, [{ type: "want", thread: C, under: [A], holds: [B] }, { type: "post-interest" }]);
    expect(posted.effects).toEqual([{ type: "interest-due" }, { type: "interest-changed", stream: "s1", post: { ask: 2, thread: C, under: [A], holds: [B] } }]);
  });

  test("the confirm moves the cursor to its seq, gives left to the keys that leave, and reads the keys that enter without since", () => {
    const state = run(live([A, B], { thread: A, holds: [B] }), [frame(settle(30)), { type: "want", thread: C, under: [A], holds: [] }, { type: "post-interest" }]).state;
    const opened = run(state, [{ type: "open", key: C, at: 10 }]);
    // C's read waits for the confirm: it must start at or after the seq the confirm names
    expect(readOf(opened.effects, C)).toBeUndefined();
    const confirmed = run(opened.state, [frame({ type: "interest", ask: 1, thread: C, under: [A], holds: [], seq: 44 })]);
    expect(confirmed.state.cursor).toEqual({ epoch: EPOCH, seq: 44 });
    expect(confirmed.state.threads[B]?.left).toBe(44);
    expect(confirmed.state.threads[A]?.left).toBeUndefined();
    expect(confirmed.state.interest.entered).toEqual({ [C]: 44, [A]: 0 });
    expect(readOf(confirmed.effects, C)).toBe(confirmed.state.threads[C]?.hydration);
    expect(confirmed.effects).toContainEqual({ type: "confirmed", ask: 1, entering: 1, stale: 0, reset: 0 });
    // B comes back with its left as since: its catch-up came ahead of the confirm, so it is current with no read
    const back = run(confirmed.state, [{ type: "want", thread: C, under: [A], holds: [B] }, { type: "post-interest" }]);
    expect(back.effects).toEqual([{ type: "interest-due" }, { type: "interest-changed", stream: "s1", post: { ask: 2, thread: C, under: [A], holds: [B], since: { [B]: 44 } } }]);
    const again = run(back.state, [frame({ type: "interest", ask: 2, thread: C, under: [A], holds: [B], seq: 50 })]);
    expect(readOf(again.effects, B)).toBeUndefined();
    expect(again.state.threads[B]?.left).toBeUndefined();
    expect(again.state.interest.entered[B]).toBe(50);
  });

  test("a key the confirm names stale is read with its pages kept; one it names reset drops its messages and is read", () => {
    const held = [message("msg_1", [text("p1", "kept")])];
    let state = live([A, B, C], { thread: A, holds: [B, C] }, held);
    state = run(state, [frame(settle(30)), { type: "want", thread: A, under: [], holds: [] }, { type: "post-interest" }]).state;
    state = run(state, [frame({ type: "interest", ask: 1, thread: A, under: [], holds: [], seq: 31 })]).state;
    state = run(state, [{ type: "want", thread: A, under: [], holds: [B, C] }, { type: "post-interest" }]).state;
    const { state: after, effects } = run(state, [frame({ type: "interest", ask: 2, thread: A, under: [], holds: [B, C], seq: 40, stale: [B], reset: [C] })]);
    expect(readOf(effects, B)).toBeDefined();
    expect(readOf(effects, C)).toBeDefined();
    expect(after.threads[B]?.messages).toEqual(held);
    expect(after.threads[C]?.messages).toEqual([]);
    expect(effects).toContainEqual({ type: "confirmed", ask: 2, entering: 2, stale: 1, reset: 1 });
  });

  test("a turn's wants post once, the last of them: one that ends where the server is, or will be, posts nothing", () => {
    const base = run(live([A, B, C], { thread: A, holds: [B, C] }), [frame(settle(30))]).state;
    const post = { type: "post-interest" } as const;
    const posts = (effects: readonly Effect[]) => effects.filter((e) => e.type === "interest-changed");
    // A to D and back to A in one turn: due once, and nothing to post, nothing waiting
    const back = run(base, [{ type: "want", thread: D, under: [A], holds: [] }, { type: "want", thread: A, under: [], holds: [B, C] }, post]);
    expect(back.effects.filter((e) => e.type === "interest-due")).toHaveLength(1);
    expect(posts(back.effects)).toEqual([]);
    expect(back.state.interest.posts).toEqual([]);
    expect(back.state.interest.due).toBe(false);
    // a child released and held again comes back last: the same set, so no post
    const again = run(base, [{ type: "want", thread: A, under: [], holds: [C] }, { type: "want", thread: A, under: [], holds: [C, B] }, post]);
    expect(posts(again.effects)).toEqual([]);
    // with D out and not yet confirmed: a turn that goes back to A and on to D again posts nothing, D's confirm settles it
    const out = run(base, [{ type: "want", thread: D, under: [A], holds: [] }, post]);
    expect(posts(out.effects)).toEqual([{ type: "interest-changed", stream: "s1", post: { ask: 1, thread: D, under: [A], holds: [] } }]);
    const round = run(out.state, [{ type: "want", thread: A, under: [], holds: [B, C] }, { type: "want", thread: D, under: [A], holds: [] }, post]);
    expect(posts(round.effects)).toEqual([]);
    const settled = run(round.state, [frame({ type: "interest", ask: 1, thread: D, under: [A], holds: [], seq: 40 })]).state;
    expect(settled.interest.posts).toEqual([]);
    // with D out: a turn that goes back to A posts A under the next ask, and its confirm settles both, whichever lands first
    const undo = run(out.state, [{ type: "want", thread: A, under: [], holds: [B, C] }, post]);
    expect(posts(undo.effects)).toEqual([{ type: "interest-changed", stream: "s1", post: { ask: 2, thread: A, under: [], holds: [B, C] } }]);
    const both = run(undo.state, [frame({ type: "interest", ask: 1, thread: D, under: [A], holds: [], seq: 40 }), frame({ type: "interest", ask: 2, thread: A, under: [], holds: [B, C], seq: 41 })]).state;
    expect(both.interest.posts).toEqual([]);
    expect(both.interest.confirmed).toEqual({ thread: A, under: [], holds: [B, C] });
  });

  test("the stream dropping gives each current key in interest the cursor as its left, and the next connect sends it", () => {
    const state = run(live([A, B], { thread: A }), [frame(settle(33)), { type: "dropped" }]).state;
    expect(state.threads[A]?.left).toBe(33);
    expect(state.threads[B]?.left).toBeUndefined();
    expect(state.interest.stream).toBeNull();
    const query = streamQuery(run(state, [{ type: "want", thread: A, under: [], holds: [B] }]).state);
    expect(query).toEqual({ thread: A, under: [], holds: [B], since: { [A]: 33 } });
  });

  test("a hello reads the keys it declares without since; the ones with since are current once caught, with no read", () => {
    const dropped = run(live([A, B], { thread: A }), [frame(settle(33)), { type: "dropped" }, { type: "want", thread: A, under: [], holds: [B] }]).state;
    const again = run(dropped, [hello({ thread: A, holds: [B] }, 60)]);
    expect(readOf(again.effects, A)).toBeUndefined();
    expect(readOf(again.effects, B)).toBeDefined();
    expect(again.state.interest.entered).toEqual({ [A]: 60, [B]: 60 });
    const caught = run(again.state, [frame({ type: "caught", seq: 60 })]).state;
    expect(caught.threads[A]?.left).toBeUndefined();
    expect(caught.cursor?.seq).toBe(60);
  });

  test("a read that lands between the dial and the hello: the hello goes by the dial's since, so the key is not read again while its catch-up comes", () => {
    // A is being read (stale) when the stream drops: it keeps the cursor as its left, and the dial sends it
    const reading = run(live([A], { thread: A }), [frame(settle(33)), frame({ type: "thread.stale", key: A }), { type: "dropped" }]).state;
    const query = streamQuery(reading);
    expect(query.since).toEqual({ [A]: 33 });
    // the read lands before the hello, and clears left
    const landed = run(reading, [hydrated(A, reading.threads[A]?.hydration ?? 0, [message("msg_1")], 33)]).state;
    expect(landed.threads[A]?.status).toBe("live");
    expect(landed.threads[A]?.left).toBeUndefined();
    const helloed = { ...(hello({ thread: A }, 60) as Extract<Action, { type: "frame" }>), since: Object.keys(query.since) };
    const again = run(landed, [helloed]);
    expect(readOf(again.effects, A)).toBeUndefined();
    expect(again.state.threads[A]?.status).toBe("live");
  });
});

describe("no gap at a switch", () => {
  test("a read that started before the key entered is taken again and counted read-late; one from the entry on lands", () => {
    let state = run(live([A], { thread: A }), [frame(settle(30)), { type: "want", thread: B, under: [A], holds: [] }, { type: "open", key: B, at: 5 }, { type: "post-interest" }]).state;
    state = run(state, [frame({ type: "interest", ask: 1, thread: B, under: [A], holds: [], seq: 40 })]).state;
    const first = state.threads[B]?.hydration ?? 0;
    const late = run(state, [hydrated(B, first, [message("msg_1")], 39)]);
    expect(late.effects).toContainEqual({ type: "fault", what: "read-late" });
    expect(late.state.threads[B]?.status).toBe("hydrating");
    const second = readOf(late.effects, B) ?? 0;
    expect(second).toBeGreaterThan(first);
    const landed = run(late.state, [hydrated(B, second, [message("msg_1")], 40)]);
    expect(landed.state.threads[B]?.status).toBe("live");
    expect(landed.effects.some((e) => e.type === "fault")).toBe(false);
  });
});

describe("a settled text sent once", () => {
  const settledPart = (value: string, extra: Record<string, unknown> = {}): Part => ({ id: "p1", messageID: "msg_1", type: "text", textOf: textOf(value), time: { start: 1, end: 2 }, ...extra }) as Part;

  test("with the held text's length and hash, every other field is replaced and the text kept", () => {
    const state = live([A], { thread: A }, [message("msg_1", [{ ...text("p1", "hello wörld 🙂"), streaming: true } as Part])]);
    const { state: after, effects } = run(state, [frame({ seq: 1, type: "part", key: A, upstream: 9, part: settledPart("hello wörld 🙂") })]);
    expect(after.threads[A]?.messages[0]?.parts).toEqual([{ id: "p1", messageID: "msg_1", type: "text", time: { start: 1, end: 2 }, text: "hello wörld 🙂" }]);
    expect(effects).toEqual([]);
  });

  test("a miss, or a part not held, fetches the message again and counts hash-miss", () => {
    const state = live([A], { thread: A }, [message("msg_1", [text("p1", "hello wörld")])]);
    const miss = run(state, [frame({ seq: 1, type: "part", key: A, upstream: 9, part: settledPart("hello world") })]);
    expect(miss.effects).toEqual([{ type: "fault", what: "hash-miss" }, { type: "refetch", key: A, messageID: "msg_1", hydration: state.threads[A]?.hydration ?? 0 }]);
    expect(miss.state.threads[A]?.messages[0]?.parts[0]).toEqual(text("p1", "hello wörld"));
    const absent = run(live([A], { thread: A }, [message("msg_1")]), [frame({ seq: 1, type: "part", key: A, upstream: 9, part: settledPart("hello") })]);
    expect(absent.effects.map((e) => e.type)).toEqual(["fault", "refetch"]);
  });
});

describe("thread.stale and thread.reset", () => {
  test("thread.stale keeps a thread's pages and reads it at once when it is in interest; a cold one is marked stale", () => {
    const held = [message("msg_1", [text("p1", "kept")])];
    const state = live([A], { thread: A }, held);
    const stale = run(state, [frame({ type: "thread.stale", key: A })]);
    expect(readOf(stale.effects, A)).toBeDefined();
    expect(stale.state.threads[A]?.messages).toEqual(held);
    expect(stale.state.threads[A]?.status).toBe("hydrating");
    const cooled = run(live([B], {}, held), [{ type: "cool", threads: { [B]: 1 } }, frame({ type: "thread.stale", key: B })]).state;
    expect(cooled.cold[B]?.stale).toBe(true);
  });

  test("thread.reset drops what is held of the thread and reads it; a cold copy is marked stale", () => {
    const held = [message("msg_1", [text("p1", "gone")])];
    const state = live([A], { thread: A }, held);
    const reset = run(state, [frame({ seq: 4, type: "thread.reset", key: A })]);
    expect(reset.state.threads[A]?.messages).toEqual([]);
    expect(readOf(reset.effects, A)).toBeDefined();
    expect(reset.state.cursor?.seq).toBe(4);
    const cooled = run(live([B], {}, held), [{ type: "cool", threads: { [B]: 1 } }, frame({ seq: 5, type: "thread.reset", key: B })]).state;
    expect(cooled.cold[B]?.stale).toBe(true);
  });
});

describe("a reset", () => {
  test("re-reads only the stage, its layers and its holds; the rest go cold and stale or stay as they are, and every left goes", () => {
    let state = live([A, B, C, D], { thread: A, holds: [B] });
    state = run(state, [frame(settle(20)), { type: "dropped" }]).state;
    expect(state.threads[A]?.left).toBe(20);
    const { state: after, effects } = run(state, [hello({ thread: A, holds: [B] }, 30), { ...resetTo(30), cool: { [C]: 2 } } as Action]);
    expect([A, B, C, D].filter((k) => readOf(effects, k) !== undefined)).toEqual([A, B]);
    expect(after.cold[C]?.stale).toBe(true);
    expect(after.threads[D]?.status).toBe("live");
    expect(after.threads[A]?.left).toBeUndefined();
  });
});

describe("reactions", () => {
  test("set the message's reactions on its info", () => {
    const state = live([A], { thread: A }, [message("msg_1")]);
    const { state: after } = run(state, [frame({ seq: 1, type: "reactions", key: A, messageID: "msg_1", reactions: [{ emoji: "👍", by: "ana" }] })]);
    expect(after.threads[A]?.messages[0]?.info.reactions).toEqual([{ emoji: "👍", by: "ana" }]);
  });
});

/* —— the server's tapes —— */

type Sse = { id: string | null; data: string };

function tape(name: string): Sse[] {
  const text = gunzipSync(readFileSync(join(import.meta.dir, "../../../server/goldens/protocol3", name))).toString("utf8");
  const frames: Sse[] = [];
  for (const block of text.split("\n\n")) {
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length > 0) frames.push({ id, data: data.join("\n") });
  }
  return frames;
}

describe("the server's protocol 3 tapes", () => {
  test("the home tape, replayed, ends with the fleet of the server's reset at the same head, deep equal", () => {
    let state = INITIAL_STATE;
    let faults = 0;
    let patches = 0;
    const frames = tape("home.sse.gz");
    for (const sse of frames) {
      // the worker routes a colours frame and the away list to the reducer as actions of their own (routeFrame), never as
      // journal frames
      const raw = JSON.parse(sse.data) as Frame | { type: "colours" } | { type: "away" };
      if (raw.type === "colours" || raw.type === "away") {
        state = reduce(state, raw as Action).state;
        continue;
      }
      const result = reduce(state, { type: "frame", frame: JSON.parse(sse.data) as Frame, id: parseCursor(sse.id) });
      faults += result.effects.filter((e) => e.type === "fault" || e.type === "reconnect").length;
      patches += result.patches.length;
      state = result.state;
    }
    // the reset follows the hello and, since every stream but the board's gets them, the colours
    const end = tape("hello-reset.sse.gz").find((sse) => (JSON.parse(sse.data) as { type: string }).type === "reset");
    const reset = JSON.parse(end?.data ?? "{}") as Reset;
    expect(faults).toBe(0);
    expect(state.cursor?.seq).toBeLessThanOrEqual(reset.seq);
    // the away list comes after every hello, empty on this tape: the rest is the reset's fleet
    const { away, ...fleet } = state.fleet;
    expect(away).toEqual([]);
    expect(fleet).toEqual(fleetOf(reset.fleet));
    // the numbers the report quotes
    console.log(
      `home tape: ${frames.length} frames, ${state.counters.applied} entries applied, cursor ${state.cursor?.seq}, head ${reset.seq}, ` +
        `${Object.keys(state.fleet.threads).length} threads, ${state.fleet.order.length} in order, ${Object.keys(state.fleet.asks).length} asks, ${patches} ui patches`,
    );
  });

  test("the thread tape, its stage opened at the hello and read empty, applies every transcript entry with no refetch or fault", () => {
    let state = INITIAL_STATE;
    const effects: Effect[] = [];
    const ids = new Set<string>();
    for (const sse of tape("thread.sse.gz")) {
      const raw = JSON.parse(sse.data) as Frame | { type: "colours" } | { type: "away" };
      if (raw.type === "colours" || raw.type === "away") {
        state = reduce(state, raw as Action).state;
        continue;
      }
      const parsed = raw;
      if (parsed.type === "message") ids.add(parsed.message.id);
      let result = reduce(state, { type: "frame", frame: parsed, id: parseCursor(sse.id) });
      if (parsed.type === "hello" && parsed.interest.thread) result = { ...result, ...reduce(result.state, { type: "open", key: parsed.interest.thread, at: 1 }) };
      effects.push(...result.effects);
      state = result.state;
      // every read answers at once, empty (the thread had nothing before the tape), at the journal's head
      for (const effect of result.effects) {
        if (effect.type !== "hydrate") continue;
        const read = reduce(state, hydrated(effect.key, effect.hydration, [], state.head, 0));
        effects.push(...read.effects);
        state = read.state;
      }
    }
    const key = state.interest.confirmed.thread ?? "";
    expect(effects.filter((e) => e.type === "fault" || e.type === "reconnect" || e.type === "refetch")).toEqual([]);
    expect(state.threads[key]?.messages.map((m) => m.info.id)).toEqual([...ids]);
    expect(state.counters.refetches).toBe(0);
  });
});
