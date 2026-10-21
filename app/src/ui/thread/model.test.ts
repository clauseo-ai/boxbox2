/* what a running turn shows (docs/thread.md, live): the reply and the thoughts stream into the ledger from the moment
   a part is announced, and the answer is what the turn came to only once it has settled. */

import { describe, expect, test } from "bun:test";
import { ledgerOf } from "./ledger";
import { liveItemsOf, shownMessages, turnsOf } from "./model";
import type { RowCtx } from "./rows";
import type { WireMessage, WirePart } from "./wire";
import { neutralMessage } from "../../sync/fixtures/neutral";

/** a message written in cmx2's shapes, as the server's translate makes it neutral */
const wire = (info: Record<string, unknown>, parts: readonly WirePart[]): WireMessage => neutralMessage({ info, parts: parts as unknown as Record<string, unknown>[] });

const T0 = 1_790_000_000_000;
const user = (id: string, parts: WirePart[] = [{ id: `${id}_p`, type: "text", text: "go" } as WirePart]): WireMessage => wire({ id, role: "user", time: { created: T0 } }, parts);
const assistant = (id: string, parts: WirePart[], completed = false): WireMessage => wire({ id, role: "assistant", time: { created: T0 + 100, ...(completed ? { completed: T0 + 5000 } : {}) } }, parts);
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

  test("a part of white space alone is nothing to show, by the white space trim takes, and one with a word in it is shown whole", () => {
    const space = " \t\n\r\u00a0\u2028\ufeff\u3000";
    const [none] = turnsOf([user("u"), assistant("a", [text("t", space), reasoning("r", space)], true)], "/");
    expect(none?.items).toEqual([]);
    expect(none?.answer).toBeUndefined();
    const [some] = turnsOf([user("u"), assistant("a", [reasoning("r", `${space}x${space}`), text("t", `${space}y\n`)], true)], "/");
    expect(some?.items.map((it) => (it.k === "think" ? it.text : ""))).toEqual([`${space}x${space}`]);
    expect(some?.answer?.text).toBe(`${space}y\n`);
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

describe("a compaction turn (docs/thread.md, what started the turn)", () => {
  const compaction = (id: string): WireMessage => user(id, [{ id: `${id}_c`, type: "compaction", auto: true } as unknown as WirePart]);
  const summaryOf = (id: string, body: string): WireMessage => wire({ id, role: "assistant", summary: true, time: { created: T0 + 50, completed: T0 + 60 } }, [text(`${id}_t`, body)]);

  test("the message marked summary is the card's, and what follows it reads as any turn: its steps and its answer", () => {
    const [turn] = turnsOf([compaction("u"), summaryOf("s", "## the summary\nwhere things stand"), assistant("a", [reasoning("r", "next i will run the tests"), text("t", "the tests pass.")], true)], "/");
    expect(turn?.by).toBe("compaction");
    expect(turn?.summary).toBe("## the summary\nwhere things stand");
    expect(turn?.items.map((x) => x.k)).toEqual(["think"]);
    expect(turn?.answer?.text).toBe("the tests pass.");
  });

  test("a compaction with no message marked summary keeps the old reading: no summary, its last words are the summary", () => {
    const [turn] = turnsOf([compaction("u"), assistant("a", [text("t", "the old summary")], true)], "/");
    expect(turn?.summary).toBeUndefined();
    expect(turn?.answer?.text).toBe("the old summary");
  });
});

describe("photos a person sent (docs/thread.md, every state: file)", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  test("an image file part on your message is a photo on its turn; a document or an undrawable image is not", () => {
    const parts = [{ id: "f1", type: "file", mime: "image/png", filename: "shot.png", url: png }, { id: "f2", type: "file", mime: "application/pdf", filename: "a.pdf", url: "data:application/pdf;base64,AA" }, { id: "f3", type: "file", mime: "image/heic", filename: "b.heic", url: "data:image/heic;base64,AA" }, { id: "t", type: "text", text: "look" }] as unknown as WirePart[];
    const [turn] = turnsOf([user("u", parts)], "/");
    expect(turn?.photos).toEqual([{ mime: "image/png", filename: "shot.png", url: png }]);
    expect(turn?.prompt).toBe("look");
  });

  test("a pdf and a text file the host put in the message are files sent with it; a mention's file is left to the words", () => {
    const parts = [
      { id: "t", type: "text", text: "read these and @src/a.ts and @notes.md" },
      { id: "f1", type: "file", mime: "application/pdf", filename: "brief.pdf", url: "data:application/pdf;base64,AA" },
      { id: "s1", type: "text", synthetic: true, text: '<file path="plan.md">\n# plan\n</file>' },
      { id: "s2", type: "text", synthetic: true, text: '<file path="src/a.ts">\nexport {}\n</file>' },
      { id: "s3", type: "text", synthetic: true, text: '<file path="notes.md">\nhi\n</file>' },
      { id: "s4", type: "text", synthetic: true, text: "turn context: cwd: /repo" },
      { id: "f2", type: "file", mime: "image/heic", filename: "b.heic", url: "data:image/heic;base64,AA" },
    ] as unknown as WirePart[];
    const [turn] = turnsOf([user("u", parts)], "/");
    expect(turn?.sentFiles).toEqual([{ filename: "brief.pdf", mime: "application/pdf" }, { filename: "plan.md", mime: "text/plain" }]);
    expect(turn?.prompt).toBe("read these and @src/a.ts and @notes.md");
  });

  test("a photo sent alone is a turn with no words", () => {
    const [turn] = turnsOf([user("u", [{ id: "f1", type: "file", mime: "image/jpeg", filename: "", url: "data:image/jpeg;base64,AA" } as unknown as WirePart])], "/");
    expect(turn?.photos).toHaveLength(1);
    expect(turn?.prompt).toBe("");
  });
});

describe("a failed turn's words", () => {
  /* the neutral message as the server sends it: `message` absent when the source had none */
  const failed = (error: Record<string, unknown>): WireMessage => ({ info: { id: "a", role: "assistant", created: T0 + 100, completed: T0 + 5000, error } as WireMessage["info"], parts: [] });
  const words = (error: Record<string, unknown>) => turnsOf([user("u"), failed(error)], "/")[0]?.error;

  test("the message when there is one, even beside a name", () => expect(words({ message: "boom", name: "APIError" })).toBe("boom"));
  test("an empty message stays empty, as cmx2's data.message did", () => expect(words({ message: "", name: "APIError" })).toBe(""));
  test("no message gives the name", () => expect(words({ name: "APIError" })).toBe("APIError"));
  test("neither says failed", () => expect(words({})).toBe("failed"));
});
