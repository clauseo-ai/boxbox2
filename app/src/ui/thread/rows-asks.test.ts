/* what an ask's row says (docs/thread.md, asks): the question across its head with its own short label above it, or how many
   questions there are when there is more than one, and a block of the card for each */

import { describe, expect, test } from "bun:test";
import { turnsOf } from "./model";
import { type RowCtx, stepModel } from "./rows";
import type { AskReply } from "../../sync/replies";
import type { WireMessage, WirePart } from "./wire";
import { neutral } from "./fixtures/wire";
import { mailsOf } from "./rows";

const T0 = 1_790_000_000_000;
const user: WireMessage = neutral({ info: { id: "u", role: "user", time: { created: T0 } }, parts: [{ id: "u_p", type: "text", text: "go" } as WirePart] });
const asked = (questions: unknown[]): WireMessage => neutral({
  info: { id: "a", role: "assistant", time: { created: T0 + 100 } },
  parts: [{ id: "q", type: "tool", callID: "c", tool: "question", state: { status: "running", input: { questions }, time: { start: T0 + 200 } } } as unknown as WirePart],
});
const question = (header: string, text: string) => ({ header, question: text, options: [{ label: "a", description: "first" }, { label: "b", description: "second" }] });
const rowOf = (questions: unknown[]) => {
  const [turn] = turnsOf([user, asked(questions)], "/");
  const step = turn?.items.find((x) => x.k === "step");
  if (!step || step.k !== "step") throw new Error("no step");
  const ctx: RowCtx = { reports: (turn ? [turn] : []).flatMap(mailsOf), children: new Map(), thinking: "rows", now: T0 + 3000 };
  return stepModel(step, ctx);
};

describe("an ask's row", () => {
  test("a question has its own label above its words, and its words are the head", () => {
    const row = rowOf([question("message got cut off", "what can't we access?")]);
    expect(row.header).toBe("message got cut off");
    expect(row.content).toEqual([{ t: "prose", s: "what can't we access?" }]);
  });

  test("a question with no label has no label row", () => {
    expect("header" in rowOf([question("  ", "which greeting?")])).toBe(false);
  });

  test("several questions say how many in the head, and each one's label stays in its block of the card", () => {
    const row = rowOf([question("models", "which models?"), question("where it runs", "where?")]);
    expect("header" in row).toBe(false);
    expect(row.content).toEqual([{ t: "prose", s: "2 questions" }]);
    expect(row.body?.k === "ask" && row.body.questions.map((q) => q.header)).toEqual(["models", "where it runs"]);
  });
});

/* a settled ask's row reads this device's record of its reply (sync/replies.ts) from the context, by the step's call id */
describe("a settled ask's record", () => {
  const edited = (status: "completed" | "error"): WireMessage => neutral({
    info: { id: "a", role: "assistant", time: { created: T0 + 100 } },
    parts: [{ id: "e", type: "tool", callID: "c", tool: "edit", state: { status, input: { filePath: "/r/a.ts" }, ...(status === "error" ? { error: "the user rejected permission to use this tool" } : { output: "" }), time: { start: T0 + 200, end: T0 + 900 } } } as unknown as WirePart],
  });
  const reply = (r: Partial<AskReply>): AskReply => ({ thread: "desk:ses", callID: "c", askID: "per", kind: "permission", reply: { k: "permit", reply: "once" }, who: { here: true }, at: T0 + 800, ...r });
  const modelOf = (m: WireMessage, replies: Map<string, AskReply>) => {
    const [turn] = turnsOf([user, m], "/");
    const step = turn?.items.find((x) => x.k === "step");
    if (!step || step.k !== "step") throw new Error("no step");
    return stepModel(step, { reports: (turn ? [turn] : []).flatMap(mailsOf), children: new Map(), thinking: "rows", replies });
  };

  test("a permission this device answered carries its record, and the row opens on it", () => {
    const r = reply({ reply: { k: "permit", reply: "reject", message: "not now" } });
    const row = modelOf(edited("error"), new Map([["c", r]]));
    expect(row.permit).toBe(r);
    expect(row.open).toBe(true);
  });

  test("a row with no record of this device's says nothing of who answered", () => {
    const row = modelOf(edited("completed"), new Map());
    expect("permit" in row).toBe(false);
  });

  test("a question's record is not a permission's line: it is the who and when of the question's own record", () => {
    const q: WireMessage = neutral({ info: { id: "a", role: "assistant", time: { created: T0 + 100 } }, parts: [{ id: "q", type: "tool", callID: "c", tool: "question", state: { status: "completed", input: { questions: [question("", "which?")] }, metadata: { answers: [["a"]] }, output: "", time: { start: T0 + 200, end: T0 + 900 } } } as unknown as WirePart] });
    const row = modelOf(q, new Map([["c", reply({ kind: "question", reply: { k: "answers", answers: [["a"]] }, who: { by: "ipad" }, at: 5 })]]));
    expect("permit" in row).toBe(false);
    expect(row.body?.k === "ask" && row.body.record).toEqual({ who: { by: "ipad" }, at: 5 });
  });
});
