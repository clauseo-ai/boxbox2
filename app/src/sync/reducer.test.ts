import { describe, expect, test } from "bun:test";
import type { Entry, FleetSnapshot, Frame, Message, Part, SessionEntry } from "./protocol";
import think from "./fixtures/think-turn.json";
import { inDaemonOrder, inDaemonOrderAll, placeBefore, positionOf } from "./order";
import { type Action, coalesce, INITIAL_STATE, reduce, type Result, type SyncState } from "./reducer";

const EPOCH = "j1";
const KEY = "bench:ses_1";

const session = (key = KEY): SessionEntry => ({
  key,
  host: key.split(":")[0] ?? "bench",
  id: key.split(":")[1] ?? "ses_1",
  info: {
    id: "ses_1",
    slug: "s1",
    projectID: "/w",
    directory: "/w",
    title: "a thread",
    version: "0.0.0-m6",
    time: { created: 1, updated: 2 },
    source: "cmx2",
    cost: 0,
    tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  },
  status: null,
  agents: 0,
  processes: 0,
  tail: [], needs: [], read: null,
});

const snapshot = (sessions: SessionEntry[] = [session()]): FleetSnapshot => ({ hosts: [], sessions, asks: [], order: sessions.map((s) => s.key) });

const text = (id: string, value: string, messageID = "msg_2"): Part => ({ id, sessionID: "ses_1", messageID, type: "text", text: value });
const message = (id: string, parts: Part[] = []): Message => ({ info: { id, sessionID: "ses_1", role: "assistant", time: { created: 1 } }, parts });

/** runs actions in order from a state, collecting every result */
function run(state: SyncState, actions: Action[]): { state: SyncState; results: Result[] } {
  const results: Result[] = [];
  for (const action of actions) {
    const result = reduce(state, action);
    results.push(result);
    state = result.state;
  }
  return { state, results };
}

const frame = (f: Frame, epoch: string | undefined = EPOCH): Action => ({ type: "frame", frame: f, epoch });
const reset = (seq = 0, fleet = snapshot()): Action => frame({ type: "reset", seq, epoch: EPOCH, reason: "none", fleet });

/** a journal as the server writes one while cmx2 streams a reply: the message, its part, then deltas */
function streamingJournal(from: number): Entry[] {
  let seq = from;
  return [
    { type: "message", seq: ++seq, key: KEY, upstream: 10, info: message("msg_2").info },
    { type: "part", seq: ++seq, key: KEY, upstream: 11, part: text("prt_1", "") },
    { type: "delta", seq: ++seq, key: KEY, messageID: "msg_2", partID: "prt_1", field: "text", delta: "hello ", offset: 0 },
    { type: "delta", seq: ++seq, key: KEY, messageID: "msg_2", partID: "prt_1", field: "text", delta: "wörld 🙂", offset: 6 },
    { type: "delta", seq: ++seq, key: KEY, messageID: "msg_2", partID: "prt_1", field: "text", delta: " again", offset: 14 },
  ];
}

/** an open, hydrated thread holding nothing yet, as of upstream seq `at` */
function openThread(at = 5, messages: Message[] = []): SyncState {
  const opened = run(INITIAL_STATE, [reset(), { type: "open", key: KEY, at: 1 }]);
  return run(opened.state, [{ type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at, messages }]).state;
}

const partText = (state: SyncState, messageIndex = 0, partIndex = 0) => {
  const part = state.threads[KEY]?.messages[messageIndex]?.parts[partIndex];
  return part && "text" in part ? part.text : undefined;
};

describe("the journal cursor", () => {
  test("applies each entry once and moves the cursor", () => {
    const journal = streamingJournal(0);
    const { state } = run(openThread(), journal.map((e) => frame(e)));
    expect(state.cursor).toEqual({ epoch: EPOCH, seq: 5 });
    expect(partText(state)).toBe("hello wörld 🙂 again");
    expect(state.counters.applied).toBe(5);
    expect(state.counters.duplicates).toBe(0);
  });

  test("a replay after a dropped connection applies nothing twice", () => {
    const journal = streamingJournal(0);
    const first = run(openThread(), journal.slice(0, 3).map((e) => frame(e)));
    // the connection dropped after entry 3; a replay that starts two entries early repeats 2 and 3
    const again = run(first.state, journal.slice(1).map((e) => frame(e)));
    expect(partText(again.state)).toBe("hello wörld 🙂 again");
    expect(again.state.counters.duplicates).toBe(2);
    expect(again.state.counters.applied).toBe(5);
  });

  test("an entry past cursor + 1 is a gap: nothing applies and the worker reconnects", () => {
    const journal = streamingJournal(0);
    const { state, results } = run(openThread(), [frame(journal[0] as Entry), frame(journal[2] as Entry)]);
    expect(state.cursor?.seq).toBe(1);
    expect(state.counters.gaps).toBe(1);
    expect(results[1]?.effects).toEqual([{ type: "reconnect" }]);
  });

  test("an entry from another epoch is a gap, since the server resets first", () => {
    const { state, results } = run(openThread(), [frame(streamingJournal(0)[0] as Entry, "j0")]);
    expect(state.counters.gaps).toBe(1);
    expect(results[0]?.effects).toEqual([{ type: "reconnect" }]);
  });
});

describe("a reset", () => {
  test("replaces the fleet whole and reads every held transcript again", () => {
    const before = run(openThread(), streamingJournal(0).map((e) => frame(e))).state;
    const other = session("bench:ses_9");
    const { state, results } = run(before, [frame({ type: "reset", seq: 40, epoch: "j2", reason: "epoch", fleet: snapshot([other]) })]);
    expect(Object.keys(state.fleet.sessions)).toEqual(["bench:ses_9"]);
    expect(state.cursor).toEqual({ epoch: "j2", seq: 40 });
    expect(state.threads[KEY]?.status).toBe("hydrating");
    expect(partText(state)).toBe("hello wörld 🙂 again");
    expect(results[0]?.effects).toEqual([{ type: "hydrate", key: KEY, hydration: 2 }]);
    expect(results[0]?.patches[0]).toEqual({ path: ["fleet"], value: state.fleet });
    expect(state.counters.resets).toBe(2);
  });
});

describe("hydration", () => {
  test("entries at or below the read's seq are covered, later ones apply", () => {
    // the read at upstream 11 already holds the message and the first delta's text
    const read = [message("msg_2", [text("prt_1", "hello ")])];
    const { state } = run(openThread(11, read), streamingJournal(0).map((e) => frame(e)));
    expect(partText(state)).toBe("hello wörld 🙂 again");
    expect(state.counters.covered).toBe(3);
    expect(state.counters.duplicates).toBe(0);
  });

  test("entries arriving while the read is in flight wait, then pass the same filter", () => {
    const opened = run(INITIAL_STATE, [reset(), { type: "open", key: KEY, at: 1 }]).state;
    const during = run(opened, streamingJournal(0).map((e) => frame(e))).state;
    expect(during.threads[KEY]?.buffer.length).toBe(5);
    const read = [message("msg_2", [text("prt_1", "hello wörld")])];
    const { state } = run(during, [{ type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at: 11, messages: read }]);
    expect(partText(state)).toBe("hello wörld 🙂 again");
    expect(state.threads[KEY]?.buffer).toEqual([]);
    expect(state.counters.duplicates).toBe(0);
  });

  test("an answer to an older hydration request is ignored", () => {
    const opened = run(INITIAL_STATE, [reset(), { type: "open", key: KEY, at: 1 }, reset(0)]).state;
    const stale = reduce(opened, { type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at: 3, messages: [] });
    expect(stale.state.threads[KEY]?.status).toBe("hydrating");
  });

  test("a sequenced entry at or below the last one applied is a duplicate", () => {
    const journal = streamingJournal(0);
    const replayed: Entry = { ...(journal[0] as Extract<Entry, { type: "message" }>), seq: 6 };
    const { state } = run(openThread(), [...journal, replayed].map((e) => frame(e)));
    expect(state.counters.duplicates).toBe(1);
  });
});

describe("a read that fails", () => {
  const opened = () => run(INITIAL_STATE, [reset(), { type: "open", key: KEY, at: 1 }]).state;
  const failing = (gone = false, problem: string | null = "vm-a is not answering"): Action => ({ type: "read-failed", key: KEY, hydration: 1, trouble: { gone, problem } });

  test("says why on the thread and in a patch, once per change", () => {
    const first = reduce(opened(), failing());
    expect(first.state.threads[KEY]?.trouble).toEqual({ gone: false, problem: "vm-a is not answering" });
    expect(first.patches).toEqual([{ path: ["threads", KEY, "trouble"], value: { gone: false, problem: "vm-a is not answering" } }]);
    expect(reduce(first.state, failing()).patches).toEqual([]);
    expect(reduce(first.state, failing(true, null)).state.threads[KEY]?.trouble).toEqual({ gone: true, problem: null });
  });

  test("a failure of a read that is no longer the thread's says nothing", () => {
    const again = run(opened(), [reset(0)]).state;
    expect(reduce(again, failing()).patches).toEqual([]);
  });

  test("the read that lands clears it, in the view it patches", () => {
    const { state, results } = run(opened(), [failing(), { type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at: 3, messages: [] }]);
    expect(state.threads[KEY]?.trouble).toBeNull();
    const view = results[1]?.patches.find((p) => p.path.length === 2)?.value as Record<string, unknown>;
    expect("trouble" in view).toBe(false);
  });

  test("a reread starts the read over under a new number, keeps the trouble until it lands, and leaves a live thread alone", () => {
    const failed = reduce(opened(), failing()).state;
    const { state, effects } = reduce(failed, { type: "reread", key: KEY });
    expect(effects).toEqual([{ type: "hydrate", key: KEY, hydration: 2 }]);
    expect(state.threads[KEY]?.trouble).toEqual({ gone: false, problem: "vm-a is not answering" });
    // the old read's answer is no longer the thread's
    expect(reduce(state, { type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at: 3, messages: [] }).state.threads[KEY]?.status).toBe("hydrating");
    expect(reduce(openThread(), { type: "reread", key: KEY }).effects).toEqual([]);
    expect(reduce(INITIAL_STATE, { type: "reread", key: KEY }).effects).toEqual([]);
  });
});

describe("deltas", () => {
  test("a hole in the text refetches that message, holds later deltas, then applies them", () => {
    const journal = streamingJournal(0);
    const holed = [journal[0], journal[1], journal[2], journal[4]].map((e, i) => ({ ...(e as Entry), seq: i + 1 }));
    const { state, results } = run(openThread(), holed.map((e) => frame(e)));
    expect(state.counters.refetches).toBe(1);
    expect(results[3]?.effects).toEqual([{ type: "refetch", key: KEY, messageID: "msg_2", hydration: 1 }]);
    expect(state.threads[KEY]?.refetching.msg_2?.length).toBe(1);
    const fetched = reduce(state, { type: "refetched", key: KEY, hydration: 1, messageID: "msg_2", message: message("msg_2", [text("prt_1", "hello wörld 🙂")]) });
    expect(partText(fetched.state)).toBe("hello wörld 🙂 again");
    expect(fetched.state.threads[KEY]?.refetching).toEqual({});
  });

  test("offsets count utf-16 units, so an emoji is two", () => {
    const journal = streamingJournal(0);
    const { state } = run(openThread(), journal.map((e) => frame(e)));
    expect("hello wörld 🙂".length).toBe(14);
    expect(state.counters.refetches).toBe(0);
  });

  test("a resumed part replaces the one held unless it would shorten it", () => {
    const journal = streamingJournal(0);
    const live = run(openThread(), journal.map((e) => frame(e))).state;
    const shorter: Entry = { type: "part", seq: 6, key: KEY, upstream: null, part: { ...text("prt_1", "hello"), streaming: true } };
    const longer: Entry = { type: "part", seq: 7, key: KEY, upstream: null, part: { ...text("prt_1", "hello wörld 🙂 again and more"), streaming: true } };
    const { state } = run(live, [frame(shorter), frame(longer)]);
    expect(partText(state)).toBe("hello wörld 🙂 again and more");
    expect(state.counters.covered).toBe(1);
  });
});

describe("the patch queue", () => {
  test("a burst of deltas becomes one text patch, and order survives", () => {
    const { results } = run(openThread(), streamingJournal(0).map((e) => frame(e)));
    const patches = coalesce(results.flatMap((r) => r.patches));
    expect(patches.map((p) => p.path.join("/"))).toEqual([
      `threads/${KEY}/messages/0`,
      `threads/${KEY}/messages/0/parts/0`,
      `threads/${KEY}/messages/0/parts/0/text`,
    ]);
    expect(patches[2]?.value).toBe("hello wörld 🙂 again");
  });

  test("a later write to a prefix drops the earlier deeper ones", () => {
    const kept = coalesce([
      { path: ["fleet", "sessions", "a"], value: 1 },
      { path: ["fleet"], value: 2 },
      { path: ["fleet", "order"], value: 3 },
    ]);
    expect(kept).toEqual([
      { path: ["fleet"], value: 2 },
      { path: ["fleet", "order"], value: 3 },
    ]);
  });
});

describe("the fleet", () => {
  test("sessions, asks and order follow their entries", () => {
    const added = session("bench:ses_2");
    const { state } = run(run(INITIAL_STATE, [reset()]).state, [
      frame({ type: "session", seq: 1, session: added }),
      frame({ type: "ask", seq: 2, ask: { key: added.key, host: "bench", id: "per_1", kind: "permission", request: {} } }),
      frame({ type: "order", seq: 3, keys: ["bench:ses_2", KEY] }),
      frame({ type: "ask.settled", seq: 4, host: "bench", id: "per_1" }),
      frame({ type: "session.removed", seq: 5, key: KEY }),
    ]);
    expect(Object.keys(state.fleet.sessions)).toEqual(["bench:ses_2"]);
    expect(state.fleet.asks).toEqual({});
    expect(state.fleet.order).toEqual(["bench:ses_2", KEY]);
  });

  test("a host reset replaces that host's sessions and reads its transcripts again", () => {
    const opened = run(openThread(), [frame({ type: "session", seq: 1, session: session("desk:ses_7") })]).state;
    const replacement = session("bench:ses_3");
    const { state, results } = run(opened, [frame({ type: "host.reset", seq: 2, host: "bench", sessions: [replacement], asks: [] })]);
    expect(Object.keys(state.fleet.sessions).sort()).toEqual(["bench:ses_3", "desk:ses_7"]);
    expect(results[0]?.effects).toEqual([{ type: "hydrate", key: KEY, hydration: 2 }]);
  });
});

/* —— the daemon's order of parts —— */

const SES = "s";
const partId = (seq: number, index: number, width = 5) => `prt_${SES}_${String(seq).padStart(width, "0")}_${index}`;
const msgId = (seq: number) => `msg_${SES}_${String(seq).padStart(5, "0")}`;
const typed = (id: string, type: "text" | "reasoning", value: string, messageID: string, extra: Record<string, unknown> = {}): Part =>
  ({ id, sessionID: "ses_1", messageID, type, text: value, ...extra }) as Part;
const tool = (id: string, messageID: string, status: string): Part => ({ id, sessionID: "ses_1", messageID, type: "tool", callID: "c1", tool: "shell", state: { status } }) as unknown as Part;

/** entries numbered from the cursor on, with upstream seqs above any read */
function journalOf(state: SyncState, makers: Array<(seq: number) => Entry>): Action[] {
  const from = state.cursor?.seq ?? 0;
  return makers.map((make, i) => frame(make(from + i + 1)));
}
const info = (seq: number, id: string) => (n: number): Entry => ({ type: "message", seq: n, key: KEY, upstream: 1000 + seq, info: message(id).info });
const partE = (seq: number, part: Part) => (n: number): Entry => ({ type: "part", seq: n, key: KEY, upstream: 1000 + seq, part });
const deltaE = (messageID: string, partID: string, value: string, offset: number, field = "text") => (n: number): Entry =>
  ({ type: "delta", seq: n, key: KEY, messageID, partID, field, delta: value, offset });

const orderOf = (state: SyncState, messageIndex = 0) => state.threads[KEY]?.messages[messageIndex]?.parts.map((p) => p.id.split("_").slice(-2).join(":"));
const refetchesIn = (results: Result[]) => results.flatMap((r) => r.effects).filter((e) => e.type === "refetch");

describe("a part's position", () => {
  test("reads the seq and the index as numbers, whatever the padding", () => {
    expect(positionOf("prt_9997e94bc310453e869b_00004_1")).toEqual({ seq: 4, index: 1 });
    expect(positionOf("prt_abc_100000_12")).toEqual({ seq: 100000, index: 12 });
    expect(positionOf("prt_abc_7_0")).toEqual({ seq: 7, index: 0 });
  });

  test("an id that is not the daemon's shape has none", () => {
    for (const id of ["prt_c1a2b3d4e5f6", "prt_a_b_1_2", "part_s_00001_0", "prt_s_00001", "prt_s_00001_0x"]) expect(positionOf(id)).toBeNull();
  });

  test("a part goes before the first held part that follows it, comparing numbers", () => {
    const held = [partId(9, 0), partId(100000, 2), partId(100000, 10)].map((id) => typed(id, "text", "", "m"));
    expect(placeBefore(held, partId(9, 1))).toBe(1);
    expect(placeBefore(held, partId(100000, 9))).toBe(2);
    expect(placeBefore(held, partId(100001, 0))).toBe(3);
    expect(placeBefore(held, partId(1, 0, 1))).toBe(0);
    expect(placeBefore(held, "prt_imported")).toBe(3);
  });

  test("parts out of order are put in order, in order ones are returned as they are, imported ones keep arrival order", () => {
    const parts = (ids: string[]) => ids.map((id) => typed(id, "text", "", "m"));
    const ordered = parts([partId(4, 0), partId(4, 1)]);
    expect(inDaemonOrder(ordered)).toBe(ordered);
    const crooked = parts([partId(6, 1), partId(6, 0), "prt_old_b", partId(4, 3), "prt_old_a"]);
    expect(inDaemonOrder(crooked).map((p) => p.id)).toEqual([partId(4, 3), partId(6, 0), partId(6, 1), "prt_old_b", "prt_old_a"]);
    const imported = parts(["prt_z", "prt_a", "prt_m"]);
    expect(inDaemonOrder(imported)).toBe(imported);
  });

  test("a cache with some messages crooked fixes those and says where the first one is", () => {
    const fine = message(msgId(2), [typed(partId(2, 0), "text", "a", msgId(2))]);
    const crooked = message(msgId(4), [typed(partId(4, 1), "text", "b", msgId(4)), typed(partId(4, 0), "reasoning", "c", msgId(4))]);
    const fixed = inDaemonOrderAll([fine, crooked]);
    expect(fixed.from).toBe(1);
    expect(fixed.messages[0]).toBe(fine);
    expect(fixed.messages[1]?.parts.map((p) => p.type)).toEqual(["reasoning", "text"]);
    const clean = [fine];
    expect(inDaemonOrderAll(clean)).toEqual({ messages: clean, from: null });
  });
});

describe("parts held in the daemon's order", () => {
  const m = msgId(6);

  test("a reasoning part that lands after the text streamed goes before it", () => {
    const { state, results } = run(
      openThread(),
      journalOf(INITIAL_STATE, [
        info(1, m),
        deltaE(m, partId(6, 1), "the answer", 0),
        partE(2, typed(partId(6, 0), "reasoning", "thinking", m)),
        partE(3, typed(partId(6, 1), "text", "the answer", m)),
      ]),
    );
    expect(orderOf(state)).toEqual(["00006:0", "00006:1"]);
    expect(refetchesIn(results)).toEqual([]);
    expect(state.threads[KEY]?.messages[0]?.parts.map((p) => p.type)).toEqual(["reasoning", "text"]);
  });

  test("an insert before the end tells the ui the whole list, an append only the new slot", () => {
    const first = run(openThread(), journalOf(INITIAL_STATE, [info(1, m), partE(2, typed(partId(6, 1), "text", "b", m))]));
    const path = (n: number) => `threads/${KEY}/messages/0/parts${n < 0 ? "" : `/${n}`}`;
    const [reasoning] = journalOf(first.state, [partE(3, typed(partId(6, 0), "reasoning", "a", m))]);
    const before = reduce(first.state, reasoning as Action);
    expect(before.patches.map((p) => p.path.join("/"))).toEqual([path(-1)]);
    expect((before.patches[0]?.value as Part[]).map((p) => p.type)).toEqual(["reasoning", "text"]);
    const [running] = journalOf(before.state, [partE(4, tool(partId(6, 2), m, "running"))]);
    const after = reduce(before.state, running as Action);
    expect(after.patches.map((p) => p.path.join("/"))).toEqual([path(2)]);
  });

  test("a user message holding a part of a later seq keeps the daemon's order", () => {
    const user = msgId(312);
    const { state } = run(
      openThread(),
      journalOf(INITIAL_STATE, [info(1, user), partE(2, typed(partId(313, 0), "text", "routing note", user)), partE(3, typed(partId(312, 0), "text", "the prompt", user))]),
    );
    expect(orderOf(state)).toEqual(["00312:0", "00313:0"]);
  });

  test("parts of an imported history keep the order they arrive in", () => {
    const old = "msg_import";
    const { state } = run(
      openThread(),
      journalOf(INITIAL_STATE, [info(1, old), partE(2, typed("prt_zz", "text", "1", old)), partE(3, typed("prt_aa", "text", "2", old)), partE(4, typed(partId(6, 0), "text", "3", old))]),
    );
    expect(state.threads[KEY]?.messages[0]?.parts.map((p) => p.id)).toEqual(["prt_zz", "prt_aa", partId(6, 0)]);
  });

  test("a resumed part, which has no seq, is placed by its id too", () => {
    const live = run(openThread(), journalOf(INITIAL_STATE, [info(1, m), deltaE(m, partId(6, 1), "streaming", 0)])).state;
    const resumed: Entry = { type: "part", seq: 3, key: KEY, upstream: null, part: typed(partId(6, 0), "reasoning", "thought", m, { streaming: true }) };
    const { state } = run(live, [frame(resumed)]);
    expect(orderOf(state)).toEqual(["00006:0", "00006:1"]);
  });

  test("entries that waited for hydration are placed the same way", () => {
    const opened = run(INITIAL_STATE, [reset(), { type: "open", key: KEY, at: 1 }]).state;
    const during = run(opened, journalOf(opened, [info(1, m), deltaE(m, partId(6, 1), "late", 0), partE(2, typed(partId(6, 0), "reasoning", "t", m))])).state;
    const { state, results } = run(during, [{ type: "hydrated", key: KEY, hydration: 1, upstreamEpoch: "u1", at: 5, messages: [] }]);
    expect(orderOf(state)).toEqual(["00006:0", "00006:1"]);
    expect(refetchesIn(results)).toEqual([]);
  });
});

describe("a delta at offset 0 for a part not held", () => {
  const m = msgId(6);

  test("creates it as streaming text at its place, with no refetch", () => {
    const base = run(openThread(), journalOf(INITIAL_STATE, [info(1, m)]));
    const { state, results } = run(base.state, journalOf(base.state, [deltaE(m, partId(6, 1), "the", 0), deltaE(m, partId(6, 1), " notes", 3)]));
    expect(state.threads[KEY]?.messages[0]?.parts[0]).toEqual({ id: partId(6, 1), sessionID: "ses_1", messageID: m, type: "text", text: "the notes", streaming: true });
    expect(state.counters.refetches).toBe(0);
    expect(results.flatMap((r) => r.effects)).toEqual([]);
  });

  test("a delta past what is held, or for a field other than text, still refetches the message", () => {
    const base = run(openThread(), journalOf(INITIAL_STATE, [info(1, m)]));
    const past = reduce(base.state, journalOf(base.state, [deltaE(m, partId(6, 1), "x", 4)])[0] as Action);
    expect(past.effects).toEqual([{ type: "refetch", key: KEY, messageID: m, hydration: 1 }]);
    expect(past.state.threads[KEY]?.messages[0]?.parts).toEqual([]);
    const other = reduce(base.state, journalOf(base.state, [deltaE(m, partId(6, 1), "x", 0, "summary")])[0] as Action);
    expect(other.effects).toEqual([{ type: "refetch", key: KEY, messageID: m, hydration: 1 }]);
  });
});

describe("a message fetched again", () => {
  const m = msgId(6);
  const refetching = (state: SyncState) => state.threads[KEY]?.refetching[m];

  /** reasoning held, the text streamed to "the notes now", then a hole: " in the voice" (offset 13) never came, " greet" did */
  function holed() {
    const base = run(openThread(), journalOf(INITIAL_STATE, [info(1, m), partE(2, typed(partId(6, 0), "reasoning", "thought", m)), deltaE(m, partId(6, 1), "the notes now", 0)]));
    return run(base.state, journalOf(base.state, [deltaE(m, partId(6, 1), " greet", 26)]));
  }
  const voice = (value: string) => message(m, [typed(partId(6, 1), "text", value, m)]);
  const answered = (state: SyncState, snapshot: Message) => run(state, [{ type: "refetched", key: KEY, hydration: 1, messageID: m, message: snapshot }]);

  test("holds every entry for it, whatever kind, until the answer", () => {
    const { state } = holed();
    expect(state.counters.refetches).toBe(1);
    const more = run(state, journalOf(state, [deltaE(m, partId(6, 1), " in", 32), partE(10, tool(partId(6, 2), m, "running")), info(11, m)]));
    expect(refetching(more.state)?.map((h) => h.kind)).toEqual(["delta", "delta", "part", "info"]);
    expect(more.state.counters.refetches).toBe(1);
    expect(refetchesIn(more.results)).toEqual([]);
    expect(orderOf(more.state)).toEqual(["00006:0", "00006:1"]);
  });

  test("a snapshot that closes the hole is continued by what waited, in order", () => {
    const more = run(holed().state, journalOf(holed().state, [deltaE(m, partId(6, 1), " in", 32)])).state;
    const { state: done, results } = answered(more, voice("the notes now in the voice"));
    expect(partText(done, 0, 1)).toBe("the notes now in the voice greet in");
    expect(done.threads[KEY]?.refetching).toEqual({});
    expect(refetchesIn(results)).toEqual([]);
  });

  test("a snapshot that lacks parts keeps them at their place", () => {
    const { state: done } = answered(holed().state, voice("the notes now in the voice"));
    expect(orderOf(done)).toEqual(["00006:0", "00006:1"]);
    expect(done.threads[KEY]?.messages[0]?.parts[0]).toMatchObject({ type: "reasoning", text: "thought" });
    expect(partText(done, 0, 1)).toBe("the notes now in the voice greet");
  });

  test("a snapshot older than the text applied does not cut it back", () => {
    const { state: done } = answered(holed().state, voice("the"));
    expect(partText(done, 0, 1)).toBe("the notes now");
    expect(done.threads[KEY]?.refetching[m]?.length).toBe(1);
  });

  test("a part applied after the snapshot was read is not undone by it", () => {
    const during = run(holed().state, journalOf(holed().state, [partE(10, tool(partId(6, 2), m, "completed"))])).state;
    const snapshot = message(m, [typed(partId(6, 1), "text", "the notes now in the voice", m), tool(partId(6, 2), m, "running")]);
    const { state: done } = answered(during, snapshot);
    expect(orderOf(done)).toEqual(["00006:0", "00006:1", "00006:2"]);
    expect(done.threads[KEY]?.messages[0]?.parts[2]).toMatchObject({ state: { status: "completed" } });
  });

  test("held deltas the snapshot did not reach all wait for the next answer, none is lost", () => {
    const more = run(holed().state, journalOf(holed().state, [deltaE(m, partId(6, 1), " in", 32), deltaE(m, partId(6, 1), " the", 35)])).state;
    // the snapshot still ends at 13: the held delta at 26 is a hole again
    const { state: done, results } = answered(more, voice("the notes now"));
    expect(refetchesIn(results)).toEqual([{ type: "refetch", key: KEY, messageID: m, hydration: 1 }]);
    expect(refetching(done)?.map((h) => (h.kind === "delta" ? h.frame.offset : -1))).toEqual([26, 32, 35]);
    const { state: whole } = answered(done, voice("the notes now in the voice"));
    expect(partText(whole, 0, 1)).toBe("the notes now in the voice greet in the");
    expect(whole.threads[KEY]?.refetching).toEqual({});
  });

  test("a refetch asked for while one is in flight asks the worker nothing more", () => {
    const { state } = holed();
    const [again] = journalOf(state, [deltaE(m, partId(6, 2), "x", 5)]);
    const result = reduce(state, again as Action);
    expect(result.effects).toEqual([]);
    expect(result.state.counters.refetches).toBe(1);
  });

  test("a message the thread lacks is added by the answer, and what waited applies to it", () => {
    const other = msgId(9);
    const base = openThread();
    const asked = run(base, journalOf(INITIAL_STATE, [deltaE(other, partId(9, 1), "late", 0)]));
    expect(asked.state.threads[KEY]?.refetching[other]?.length).toBe(1);
    const answered = run(asked.state, [{ type: "refetched", key: KEY, hydration: 1, messageID: other, message: message(other, [typed(partId(9, 0), "reasoning", "t", other)]) }]);
    expect(orderOf(answered.state)).toEqual(["00009:0", "00009:1"]);
    expect(partText(answered.state, 0, 1)).toBe("late");
  });

  test("a message removed meanwhile ignores the answer", () => {
    const { state } = holed();
    const gone = run(state, journalOf(state, [(n) => ({ type: "message.removed", seq: n, key: KEY, upstream: 2000, messageID: m })])).state;
    expect(gone.threads[KEY]?.messages).toEqual([]);
    const { state: done } = run(gone, [{ type: "refetched", key: KEY, hydration: 1, messageID: m, message: message(m, [typed(partId(6, 1), "text", "back", m)]) }]);
    expect(done.threads[KEY]?.messages).toEqual([]);
  });
});

/* —— replays —— */

type Recorded = { id: string; type: string; seq?: number; properties: Record<string, unknown> };

/** the journal entries the server writes for a recorded daemon event: message and part events carry the daemon's seq as upstream */
function entriesOf(events: Recorded[]): Array<(seq: number) => Entry> {
  return events.map((event): ((seq: number) => Entry) => {
    const upstream = event.seq ?? null;
    switch (event.type) {
      case "message.updated":
        return (seq) => ({ type: "message", seq, key: KEY, upstream, info: event.properties.info as Message["info"] });
      case "message.part.updated":
        return (seq) => ({ type: "part", seq, key: KEY, upstream, part: event.properties.part as Part });
      case "message.part.delta": {
        const p = event.properties as { messageID: string; partID: string; field: string; delta: string; offset: number };
        return (seq) => ({ type: "delta", seq, key: KEY, messageID: p.messageID, partID: p.partID, field: p.field, delta: p.delta, offset: p.offset });
      }
      default:
        throw new Error(`the fixture holds an event this test does not know: ${event.type}`);
    }
  });
}

/** the daemon's order, worked out apart from the app's code: by the two numbers at the end of each id */
function daemonOrder(events: Recorded[]): Record<string, string[]> {
  const ids: Record<string, Set<string>> = {};
  for (const event of events) {
    const part = event.properties.part as Part | undefined;
    if (part) (ids[part.messageID] ??= new Set()).add(part.id);
  }
  const numbers = (id: string) => id.split("_").slice(-2).map(Number) as [number, number];
  return Object.fromEntries(
    Object.entries(ids).map(([id, set]) => [id, [...set].sort((a, b) => numbers(a)[0] - numbers(b)[0] || numbers(a)[1] - numbers(b)[1])]),
  );
}

describe("a recorded cmx2 0.8.3 thinking turn", () => {
  const events = think as Recorded[];

  test("ends with every message's parts in the daemon's order and no refetch", () => {
    const { state, results } = run(openThread(0), journalOf(INITIAL_STATE, entriesOf(events)));
    const held = Object.fromEntries((state.threads[KEY]?.messages ?? []).map((m) => [m.info.id, m.parts.map((p) => p.id)]));
    const expected = daemonOrder(events);
    for (const [id, order] of Object.entries(expected)) expect(held[id]).toEqual(order);
    expect(state.counters.refetches).toBe(0);
    expect(refetchesIn(results)).toEqual([]);
    expect(state.counters.duplicates).toBe(0);
    // both assistant messages think first; the second streamed its text before its thought landed
    const thinking = (state.threads[KEY]?.messages ?? []).filter((m) => m.parts.some((p) => p.type === "reasoning"));
    expect(thinking.length).toBe(2);
    for (const m of thinking) expect(m.parts[0]?.type).toBe("reasoning");
  });

  test("the answer streams from its first delta, and the part the step ends with replaces it whole", () => {
    const deltas = events.filter((e) => e.type === "message.part.delta");
    const first = deltas[0] as Recorded;
    const firstIndex = events.indexOf(first);
    const before = run(openThread(0), journalOf(INITIAL_STATE, entriesOf(events.slice(0, firstIndex + 1))));
    const born = before.state.threads[KEY]?.messages.flatMap((m) => m.parts).find((p) => p.id === (first.properties as { partID: string }).partID);
    expect(born).toMatchObject({ type: "text", text: (first.properties as { delta: string }).delta, streaming: true });
    const whole = run(openThread(0), journalOf(INITIAL_STATE, entriesOf(events))).state.threads[KEY]?.messages.flatMap((m) => m.parts);
    const final = events.filter((e) => e.type === "message.part.updated" && (e.properties.part as Part).id === (first.properties as { partID: string }).partID).at(-1);
    expect(whole?.find((p) => p.id === born?.id)).toEqual((final?.properties as { part: Part }).part);
  });
});

describe("cmx2's announced parts (contract v5)", () => {
  const m = msgId(6);
  const announce = (index: number, type: "text" | "reasoning", seq: number) =>
    partE(seq, typed(partId(6, index), type, "", m, { streaming: true, time: { start: 1000 + index } }));

  /** announce each part at its start, stream both by delta, then the final parts with time start and end */
  const sequence = () => [
    info(1, m),
    announce(0, "reasoning", 2),
    deltaE(m, partId(6, 0), "weighing ", 0),
    deltaE(m, partId(6, 0), "the options", 9),
    announce(1, "text", 3),
    deltaE(m, partId(6, 1), "the answer", 0),
    partE(4, typed(partId(6, 0), "reasoning", "weighing the options", m, { time: { start: 1000, end: 1500 } })),
    partE(5, typed(partId(6, 1), "text", "the answer", m, { time: { start: 1001, end: 1600 } })),
  ];

  test("a reasoning part streams by delta exactly as text does, and its final part replaces it", () => {
    const steps = run(openThread(), journalOf(INITIAL_STATE, sequence()));
    const at = (n: number) => run(openThread(), journalOf(INITIAL_STATE, sequence().slice(0, n))).state;
    expect(partText(at(4), 0, 0)).toBe("weighing the options");
    expect(at(4).threads[KEY]?.messages[0]?.parts[0]).toMatchObject({ type: "reasoning", streaming: true });
    expect(orderOf(at(6))).toEqual(["00006:0", "00006:1"]);
    expect(steps.state.threads[KEY]?.messages[0]?.parts).toEqual([
      typed(partId(6, 0), "reasoning", "weighing the options", m, { time: { start: 1000, end: 1500 } }),
      typed(partId(6, 1), "text", "the answer", m, { time: { start: 1001, end: 1600 } }),
    ]);
    expect(steps.state.counters.refetches).toBe(0);
    expect(steps.state.counters.duplicates).toBe(0);
  });

  test("an announce that lands out of order is still placed by its id", () => {
    const out = [info(1, m), announce(1, "text", 2), announce(0, "reasoning", 3), deltaE(m, partId(6, 0), "t", 0), deltaE(m, partId(6, 1), "a", 0)];
    const { state, results } = run(openThread(), journalOf(INITIAL_STATE, out));
    expect(orderOf(state)).toEqual(["00006:0", "00006:1"]);
    expect(state.threads[KEY]?.messages[0]?.parts.map((p) => [p.type, partText(state, 0, state.threads[KEY]?.messages[0]?.parts.indexOf(p))])).toEqual([["reasoning", "t"], ["text", "a"]]);
    expect(refetchesIn(results)).toEqual([]);
  });

  /** a26: the thought's final is published when its block ends, between the text's announcement and its deltas, and
      the step's end publishes it again, identical */
  const early = (): Array<(seq: number) => Entry> => {
    const thought = typed(partId(6, 0), "reasoning", "weighing the options", m, { time: { start: 1000, end: 1500 } });
    return [
      info(1, m),
      announce(0, "reasoning", 2),
      deltaE(m, partId(6, 0), "weighing ", 0),
      deltaE(m, partId(6, 0), "the options", 9),
      partE(3, thought),
      announce(1, "text", 4),
      deltaE(m, partId(6, 1), "the ", 0),
      deltaE(m, partId(6, 1), "answer", 4),
      partE(5, thought),
      partE(6, typed(partId(6, 1), "text", "the answer", m, { time: { start: 1501, end: 1600 } })),
    ];
  };

  test("an early final for the thought, while the reply streams, settles the thought and leaves the reply streaming", () => {
    const state = run(openThread(), journalOf(INITIAL_STATE, early().slice(0, 7))).state;
    const parts = state.threads[KEY]?.messages[0]?.parts;
    expect(parts?.map((p) => [p.type, p.streaming === true])).toEqual([["reasoning", false], ["text", true]]);
    expect(parts?.[0]).toMatchObject({ text: "weighing the options", time: { start: 1000, end: 1500 } });
    expect(partText(state, 0, 1)).toBe("the ");
  });

  test("the reply goes on growing past it, and the step's end publishes both finals over what is held", () => {
    const { state, results } = run(openThread(), journalOf(INITIAL_STATE, early()));
    expect(orderOf(state)).toEqual(["00006:0", "00006:1"]);
    expect(state.threads[KEY]?.messages[0]?.parts).toEqual([
      typed(partId(6, 0), "reasoning", "weighing the options", m, { time: { start: 1000, end: 1500 } }),
      typed(partId(6, 1), "text", "the answer", m, { time: { start: 1501, end: 1600 } }),
    ]);
    expect(state.counters.refetches).toBe(0);
    expect(state.counters.duplicates).toBe(0);
    expect(refetchesIn(results)).toEqual([]);
  });

  test("a thread opened between the thought's final and the reply's first word hydrates the settled thought and continues the reply", () => {
    const read = message(m, [typed(partId(6, 0), "reasoning", "weighing the options", m, { time: { start: 1000, end: 1500 } }), typed(partId(6, 1), "text", "", m, { streaming: true, time: { start: 1501 } })]);
    const { state } = run(openThread(1004, [read]), journalOf(INITIAL_STATE, early().slice(5)));
    expect(orderOf(state)).toEqual(["00006:0", "00006:1"]);
    expect(state.threads[KEY]?.messages[0]?.parts[0]?.streaming).not.toBe(true);
    expect(state.counters.refetches).toBe(0);
  });

  test("a replay of the sequence after a drop applies nothing twice", () => {
    const journal = journalOf(INITIAL_STATE, sequence());
    const first = run(openThread(), journal.slice(0, 5));
    const again = run(first.state, journal.slice(2));
    expect(again.state.threads[KEY]?.messages[0]?.parts.map((p) => p.type)).toEqual(["reasoning", "text"]);
    expect(partText(again.state, 0, 1)).toBe("the answer");
    expect(again.state.counters.refetches).toBe(0);
  });
});
