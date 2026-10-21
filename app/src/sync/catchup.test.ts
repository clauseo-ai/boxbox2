/* catch-ups as the server compacts them (docs/protocol.md, section 9; server/src/fleet/catchup.rs, mirrored by
   fixtures/server.ts `compactEntries`): a message's last `message` goes in its place ahead of its parts, so the newest
   upstream of a message can come before the older upstreams of its parts. the reducer gates catch-up entries by the read
   alone (an entry the read covers is skipped), never by the newest upstream it applied: the client holds nothing of the
   thread after its `since`, and compaction keeps one newest entry per message and part, so nothing in a catch-up was
   applied before. live entries keep the thread-wide gate. */

import { describe, expect, test } from "bun:test";
import { compactEntries, settleText } from "./fixtures/server";
import { snapshot, thread } from "./fixtures/neutral";
import type { Entry, Frame, Message, ThreadEntry } from "./protocol";
import { textOf } from "./protocol";
import { type Action, INITIAL_STATE, reduce, type SyncState } from "./reducer";

const EPOCH = "e1";
const A = "bench:ses_a";

function run(state: SyncState, actions: Action[]): SyncState {
  for (const action of actions) state = reduce(state, action).state;
  return state;
}

const frame = (f: Frame): Action => ({ type: "frame", frame: f, id: f.type === "hello" || f.type === "catchup" || f.type === "thread.stale" ? null : { epoch: EPOCH, seq: f.seq } });

/** A live and in interest, read at upstream `at` holding `messages`, the cursor at 10 */
function live(messages: Message[] = [], at = 5): SyncState {
  let state = run(INITIAL_STATE, [
    { type: "want", thread: A, under: [], holds: [] },
    frame({ type: "hello", protocol: 3, epoch: EPOCH, head: 0, build: "b", stream: "s1", interest: { thread: A, under: [], holds: [] } }),
    frame({ type: "reset", seq: 0, epoch: EPOCH, reason: "none", fleet: snapshot([thread(A)]) }),
    { type: "open", key: A, at: 1 },
  ]);
  const hydration = state.threads[A]?.hydration ?? 0;
  state = run(state, [{ type: "hydrated", key: A, hydration, upstreamEpoch: "u1", at, seq: 0, messages }, frame({ seq: 10, type: "order", keys: [A] })]);
  return state;
}

/** a message created after the client's `since`, its parts streamed and settled, and its info updated last */
const missed: ThreadEntry[] = [
  { seq: 11, type: "message", key: A, upstream: 21, message: { id: "msg_2", role: "assistant", created: 2 } },
  { seq: 12, type: "part", key: A, upstream: 22, part: { type: "text", id: "prt_a_2_0", messageID: "msg_2", at: { step: 2, index: 0 }, text: "", streaming: true } },
  { seq: 13, type: "delta", key: A, messageID: "msg_2", partID: "prt_a_2_0", field: "text", delta: "reading the ", offset: 0 },
  { seq: 14, type: "delta", key: A, messageID: "msg_2", partID: "prt_a_2_0", field: "text", delta: "notes first.", offset: 12 },
  { seq: 15, type: "part", key: A, upstream: 23, part: { type: "text", id: "prt_a_2_0", messageID: "msg_2", at: { step: 2, index: 0 }, text: "reading the notes first.", time: { start: 2, end: 3 } } },
  { seq: 16, type: "part", key: A, upstream: 24, part: { type: "tool", id: "prt_a_2_1", messageID: "msg_2", at: { step: 2, index: 1 }, callID: "c1", tool: "read", family: "read", state: { status: "running", input: {} } } as unknown as Extract<ThreadEntry, { type: "part" }>["part"] },
  { seq: 17, type: "message", key: A, upstream: 25, message: { id: "msg_2", role: "assistant", created: 2, completed: 4, finish: "tool-calls" } },
];

describe("a compacted catch-up", () => {
  test("the server's compaction puts a message's last info ahead of its parts, and settles the text part as textOf", () => {
    const entries = compactEntries(settleText(missed as Entry[]) as ThreadEntry[]);
    expect(entries.map((e) => [e.seq, e.type])).toEqual([
      [17, "message"],
      [12, "part"],
      [14, "delta"],
      [15, "part"],
      [16, "part"],
    ]);
    const settled = entries[3] as Extract<ThreadEntry, { type: "part" }>;
    expect((settled.part as Record<string, unknown>)["textOf"]).toEqual(textOf("reading the notes first."));
    expect((entries[2] as Extract<ThreadEntry, { type: "delta" }>).delta).toBe("reading the notes first.");
  });

  test("lands every part of a message it carries whole, though the message's upstream is newer than its parts'", () => {
    const entries = compactEntries(settleText(missed as Entry[]) as ThreadEntry[]);
    const state = run(live(), [frame({ type: "catchup", entries })]);
    const held = state.threads[A]?.messages ?? [];
    expect(held.map((m) => m.info.id)).toEqual(["msg_2"]);
    expect(held[0]?.info.completed).toBe(4);
    expect(held[0]?.parts.map((p) => p.id)).toEqual(["prt_a_2_0", "prt_a_2_1"]);
    expect(held[0]?.parts[0]).toEqual({ type: "text", id: "prt_a_2_0", messageID: "msg_2", at: { step: 2, index: 0 }, time: { start: 2, end: 3 }, text: "reading the notes first." });
    expect(state.threads[A]?.lastUpstream).toBe(25);
    expect(Object.keys(state.threads[A]?.refetching ?? {})).toEqual([]);
  });

  test("still skips what the read covers, and the live gate after it is the thread's newest upstream", () => {
    const read: Message = { info: { id: "msg_2", role: "assistant", created: 2 }, parts: [{ type: "text", id: "prt_a_2_0", messageID: "msg_2", at: { step: 2, index: 0 }, text: "reading the notes first.", time: { start: 2, end: 3 } }] };
    const state = run(live([read], 23), [frame({ type: "catchup", entries: compactEntries(missed) })]);
    const parts = state.threads[A]?.messages[0]?.parts ?? [];
    // the settled part at upstream 23 is the read's; the tool after it applies
    expect(parts.map((p) => (p as { text?: string }).text ?? p.type)).toEqual(["reading the notes first.", "tool"]);
    expect(state.counters.covered).toBeGreaterThanOrEqual(1);
    // a live entry at an upstream the catch-up passed is a duplicate
    const after = run(state, [frame({ seq: 30, type: "message", key: A, upstream: 24, message: { id: "msg_2", role: "assistant", created: 9 } })]);
    expect(after.threads[A]?.messages[0]?.info.created).toBe(2);
    expect(after.counters.duplicates).toBe(state.counters.duplicates + 1);
  });
});
