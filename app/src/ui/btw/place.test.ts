import { describe, expect, test } from "bun:test";
import { boundedQuestion, btwNames, placeBtws } from "./place";
import type { Btw } from "./types";

const btw = (id: string, over: Partial<Btw> = {}): Btw => ({ id, question: `q ${id}`, answer: "", status: "done", created: 0, ...over });

/* two turns: u1 (with its replies a1, a2) and u2 (with a3) */
const MESSAGES = [
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant" },
  { id: "a2", role: "assistant" },
  { id: "u2", role: "user" },
  { id: "a3", role: "assistant" },
];

describe("where a btw is drawn", () => {
  test("in the turn that holds its message, whether that is the prompt or a reply", () => {
    const placed = placeBtws(MESSAGES, [btw("b1", { afterMessageID: "a2" }), btw("b2", { afterMessageID: "u1" }), btw("b3", { afterMessageID: "a3" })]);
    expect(placed.get("u1")?.map((b) => b.id)).toEqual(["b1", "b2"].sort());
    expect(placed.get("u2")?.map((b) => b.id)).toEqual(["b3"]);
  });

  test("with no afterMessageID, or one the thread does not show, in the last turn", () => {
    const placed = placeBtws(MESSAGES, [btw("b1"), btw("b2", { afterMessageID: "gone", created: 1 })]);
    expect(placed.get("u2")?.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(placed.has("u1")).toBe(false);
  });

  test("a message before the first prompt holds no turn: its btw goes to the last", () => {
    const placed = placeBtws([{ id: "s0", role: "assistant" }, ...MESSAGES], [btw("b1", { afterMessageID: "s0" })]);
    expect(placed.get("u2")?.map((b) => b.id)).toEqual(["b1"]);
  });

  test("within a turn, in the order they were asked, the id breaking a tie", () => {
    const placed = placeBtws(MESSAGES, [btw("c", { created: 30, afterMessageID: "a1" }), btw("b", { created: 10, afterMessageID: "u1" }), btw("a", { created: 30, afterMessageID: "a2" })]);
    expect(placed.get("u1")?.map((b) => b.id)).toEqual(["b", "a", "c"]);
  });

  test("a thread with no turn yet places nothing, and no btws costs no walk", () => {
    expect(placeBtws([], [btw("b1")]).size).toBe(0);
    expect(placeBtws(MESSAGES, []).size).toBe(0);
  });
});

describe("how a btw's controls are named", () => {
  test("by the question in one bounded line", () => {
    expect(boundedQuestion("why  is\nthe deploy slow?")).toBe("why is the deploy slow?");
    const long = "why does the deploy script wait for the health check on every machine before it moves on to the next one";
    const cut = boundedQuestion(long);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  });

  test("a namesake asked later reads again, then third time, so every name is unique", () => {
    const names = btwNames([btw("b3", { question: "why?", created: 3 }), btw("b1", { question: "why?", created: 1 }), btw("b2", { question: "why?", created: 2 }), btw("b4", { question: "how?", created: 4 })]);
    expect([names.get("b1"), names.get("b2"), names.get("b3"), names.get("b4")]).toEqual(["why?", "why?, again", "why?, third time", "how?"]);
    expect(new Set(names.values()).size).toBe(4);
  });
});
