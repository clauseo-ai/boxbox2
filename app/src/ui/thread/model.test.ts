/* what a running turn shows (docs/thread.md, live): the reply and the thoughts stream into the ledger from the moment
   a part is announced, and the answer is what the turn came to only once it has settled. */

import { describe, expect, test } from "bun:test";
import { ledgerOf } from "./ledger";
import { liveItemsOf, shownMessages, turnsOf } from "./model";
import type { RowCtx } from "./rows";
import type { WireMessage, WirePart } from "./wire";

const T0 = 1_790_000_000_000;
const user = (id: string, parts: WirePart[] = [{ id: `${id}_p`, type: "text", text: "go" } as WirePart]): WireMessage => ({ info: { id, role: "user", time: { created: T0 } } as WireMessage["info"], parts });
const assistant = (id: string, parts: WirePart[], completed = false): WireMessage => ({ info: { id, role: "assistant", time: { created: T0 + 100, ...(completed ? { completed: T0 + 5000 } : {}) } } as WireMessage["info"], parts });
const text = (id: string, body: string, extra: Record<string, unknown> = {}): WirePart => ({ id, type: "text", text: body, ...extra }) as WirePart;
const reasoning = (id: string, body: string, extra: Record<string, unknown> = {}): WirePart => ({ id, type: "reasoning", text: body, ...extra }) as WirePart;
const ctx = (turn: ReturnType<typeof turnsOf>[number]): RowCtx => ({ turns: [turn], children: new Map(), thinking: "rows", now: T0 + 3000 });

describe("a part announced and still empty", () => {
  test("a streaming reply with no words yet is an item, so its row opens at the announcement", () => {
    const [turn] = turnsOf([user("u"), assistant("a", [text("t", "", { streaming: true, time: { start: T0 + 200 } })])], "/");
    expect(turn?.answer?.streaming).toBe(true);
    expect(turn?.answer?.text).toBe("");
  });

  test("a streaming thought with no words yet is a thought that is thinking, its clock from its start", () => {
    const [turn] = turnsOf([user("u"), assistant("a", [reasoning("r", "", { streaming: true, time: { start: T0 + 200 } })])], "/");
    const thought = turn?.items[0];
    expect(thought).toMatchObject({ k: "think", streaming: true, at: T0 + 200, ms: 0, text: "" });
  });

  test("an empty part that is not streaming is nothing to show", () => {
    const [turn] = turnsOf([user("u"), assistant("a", [text("t", ""), reasoning("r", "  ")], true)], "/");
    expect(turn?.items).toEqual([]);
    expect(turn?.answer).toBeUndefined();
  });
});

describe("parts only imported history carries (cmx2 a15, contract 6)", () => {
  test("are skipped quietly: no row, no answer, and not counted as parts the contract does not name", () => {
    const imported = [
      { id: "s0", type: "step-start", snapshot: "abc" },
      { id: "s1", type: "step-finish", reason: "stop", cost: 0.01, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
      { id: "s2", type: "patch", hash: "abc", files: ["/repo/a.ts"] },
      { id: "s3", type: "subtask", agent: "helper", description: "look", prompt: "look around" },
    ] as unknown as WirePart[];
    const [turn] = turnsOf([user("u"), assistant("a", [...imported, text("t", "done")], true)], "/");
    expect(turn?.items).toEqual([]);
    expect(turn?.answer?.text).toBe("done");
    expect(turn?.unknownParts).toBe(0);
  });

  test("a part type the contract does not name is still counted", () => {
    const [turn] = turnsOf([user("u"), assistant("a", [{ id: "x", type: "hologram" } as unknown as WirePart, text("t", "done")], true)], "/");
    expect(turn?.unknownParts).toBe(1);
  });
});

describe("a thought's duration", () => {
  test("comes from its time when the part carries start and end, and is none for a thought that arrives whole without them", () => {
    const [turn] = turnsOf([user("u"), assistant("a", [reasoning("r1", "timed", { time: { start: T0 + 200, end: T0 + 4200 } }), reasoning("r2", "whole")], true)], "/");
    expect(turn?.items.map((x) => (x.k === "think" ? x.ms : -1))).toEqual([4000, 0]);
  });
});

describe("the ledger of a running turn", () => {
  const running = () => turnsOf([user("u"), assistant("a", [reasoning("r", "first", { time: { start: T0 + 200, end: T0 + 900 } }), text("t", "the reply so", { streaming: true, time: { start: T0 + 1000 } })])], "/")[0]!;

  test("holds the reply as its newest row while the turn is not settled, though the model calls it the answer", () => {
    const turn = running();
    expect(turn.answer?.text).toBe("the reply so");
    expect(liveItemsOf(turn).at(-1)).toBe(turn.answer);
    const rows = ledgerOf()(turn, ctx(turn), true);
    const newest = rows.at(-1);
    expect(newest?.say?.text).toBe("the reply so");
    expect(newest?.cur).toBe(true);
  });

  test("shows a streaming thought as the open, live row with its words and its clock", () => {
    const turn = turnsOf([user("u"), assistant("a", [reasoning("r", "weighing", { streaming: true, time: { start: T0 + 1000 } })])], "/")[0]!;
    const newest = ledgerOf()(turn, ctx(turn), true).at(-1);
    expect(newest?.live).toEqual({ text: "weighing", streaming: true });
    expect(newest?.model?.running).toBe(true);
    expect(newest?.model?.result.clockFrom).toBe(T0 + 1000);
  });

  test("a thought that arrived whole is open in the ledger with no caret", () => {
    const turn = turnsOf([user("u"), assistant("a", [reasoning("r", "all at once")])], "/")[0]!;
    const newest = ledgerOf()(turn, ctx(turn), true).at(-1);
    expect(newest?.live).toEqual({ text: "all at once", streaming: false });
  });
});

describe("a thought whose block has ended while the reply streams (a26)", () => {
  /** the daemon publishes a part's final when its block ends: the thought is whole, with time {start, end} and no
      streaming flag, while the reply that follows it is still being written */
  const replying = () =>
    turnsOf([user("u"), assistant("a", [reasoning("r", "weighed the options", { time: { start: T0 + 200, end: T0 + 4200 } }), text("t", "the reply so", { streaming: true, time: { start: T0 + 4300 } })])], "/")[0]!;

  test("is a thought that has stopped streaming, with its duration, beside a reply that has not", () => {
    const turn = replying();
    expect(turn.items[0]).toMatchObject({ k: "think", streaming: false, ms: 4000, at: T0 + 200, text: "weighed the options" });
    expect(turn.answer).toMatchObject({ streaming: true, text: "the reply so" });
  });

  test("closes its row: no clock running, and the reply is the newest, current row", () => {
    const turn = replying();
    const rows = ledgerOf()(turn, ctx(turn), true);
    const thought = rows.find((row) => row.model?.kind === "thought");
    expect(thought?.model?.running).toBe(false);
    expect(thought?.cur).toBeUndefined();
    expect(rows.at(-1)).toMatchObject({ cur: true, say: { text: "the reply so", streaming: true } });
  });

  test("before it, the same thought with its flag still up is the live row, so the final is what stops it", () => {
    const [turn] = turnsOf([user("u"), assistant("a", [reasoning("r", "weighed the options", { streaming: true, time: { start: T0 + 200 } }), text("t", "the reply so", { streaming: true, time: { start: T0 + 4300 } })])], "/");
    expect(turn?.items[0]).toMatchObject({ k: "think", streaming: true });
  });
});

describe("a prompt that has no text yet", () => {
  test("waits: the newest message is not shown until it has a part, so the turn appears whole", () => {
    const messages = [user("u1"), assistant("a1", [text("t", "hi")], true), user("u2", [])];
    expect(shownMessages(messages)).toHaveLength(2);
    expect(shownMessages([...messages.slice(0, 2), user("u2")])).toHaveLength(3);
  });

  test("an empty message in the middle of a thread stays", () => {
    const messages = [user("u1", []), assistant("a1", [text("t", "hi")], true)];
    expect(shownMessages(messages)).toBe(messages);
  });
});
