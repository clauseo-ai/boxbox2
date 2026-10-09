/* what an ask's row says (docs/thread.md, asks): the question across its head with its own short label above it, or how many
   questions there are when there is more than one, and a block of the card for each */

import { describe, expect, test } from "bun:test";
import { turnsOf } from "./model";
import { type RowCtx, stepModel } from "./rows";
import type { WireMessage, WirePart } from "./wire";

const T0 = 1_790_000_000_000;
const user: WireMessage = { info: { id: "u", role: "user", time: { created: T0 } } as WireMessage["info"], parts: [{ id: "u_p", type: "text", text: "go" } as WirePart] };
const asked = (questions: unknown[]): WireMessage => ({
  info: { id: "a", role: "assistant", time: { created: T0 + 100 } } as WireMessage["info"],
  parts: [{ id: "q", type: "tool", callID: "c", tool: "question", state: { status: "running", input: { questions }, time: { start: T0 + 200 } } } as unknown as WirePart],
});
const question = (header: string, text: string) => ({ header, question: text, options: [{ label: "a", description: "first" }, { label: "b", description: "second" }] });
const rowOf = (questions: unknown[]) => {
  const [turn] = turnsOf([user, asked(questions)], "/");
  const step = turn?.items.find((x) => x.k === "step");
  if (!step || step.k !== "step") throw new Error("no step");
  const ctx: RowCtx = { turns: turn ? [turn] : [], children: new Map(), thinking: "rows", now: T0 + 3000 };
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
