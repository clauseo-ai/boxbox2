import { describe, expect, test } from "bun:test";
import type { TailItem } from "../../sync/protocol";
import { cutToEnd, RUN_LINES, RUN_SLOTS, runOf, stripOf, WORDS_CHARS, wordsOf } from "./run";

let n = 0;
const item = (kind: TailItem["kind"], role: TailItem["role"], text: string, over: Partial<TailItem> = {}): TailItem => ({ kind, role, text, messageID: "m", partID: `p${++n}`, ...over });
const you = (text: string) => item("text", "user", text);
const says = (text: string) => item("text", "assistant", text);
const thinks = () => item("reasoning", "assistant", "hm");
const tool = (name: string, title: string, state = "completed") => item("tool", "assistant", title, { tool: name, state });

describe("a working window's run", () => {
  const tail = [you("old ask"), says("done before."), you("move the invoices"), thinks(), tool("read", "a.md"), tool("edit", "b.ts"), says("changing b."), tool("bash", "bun test", "running")];

  test("what you asked, then the turn's lines, and nothing from before it", () => {
    const run = runOf(tail, "working");
    expect(run.lines.map((l) => l.kind)).toEqual(["prompt", "reads", "tool", "prose", "tool"]);
    expect(run.lines[0]).toMatchObject({ text: "move the invoices" });
  });

  test("its strip: a slot a step in order, a thought a span, the running step live", () => {
    const strip = runOf(tail, "working").strip;
    expect(strip).toMatchObject({ ordered: true, live: true, end: RUN_SLOTS * 1000 });
    expect(strip?.thoughts).toEqual([{ at: 150, ms: 700, streaming: false }]);
    expect(strip?.marks.map((m) => [m.kind, m.at, m.running])).toEqual([["read", 1500, false], ["edit", 2500, false], ["run", 3500, true]]);
  });

  test("the strip keeps the newest twelve steps, the lines the newest eight", () => {
    const many = [you("go"), ...Array.from({ length: 20 }, (_, i) => tool("bash", `step ${i}`))];
    const run = runOf(many, "working");
    expect(run.strip?.marks).toHaveLength(RUN_SLOTS);
    expect(run.lines).toHaveLength(RUN_LINES + 1);
    expect(run.lines.at(-1)).toMatchObject({ object: "step 19" });
  });

  test("the agent's questions and notes are no step of the run", () => {
    expect(runOf([you("go"), tool("question", "which?"), tool("todowrite", "plan")], "working").strip).toBeNull();
  });

  test("a queued window shows its run too", () => {
    expect(runOf(tail, "queued").strip).not.toBeNull();
  });
});

describe("a done window shows only the agent's words", () => {
  test("its words since your message, oldest first", () => {
    const run = runOf([you("go"), says("first."), tool("bash", "ls"), says("second.")], "done");
    expect(run).toEqual({ lines: [{ kind: "prose", id: "words-0", text: "first." }, { kind: "prose", id: "words-1", text: "second." }], strip: null });
  });

  test("its last words anywhere when it said nothing since", () => {
    expect(wordsOf([says("before."), you("go"), tool("bash", "ls")])).toEqual(["before."]);
  });

  test("kept to their end, cut at a word", () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const words = wordsOf([you("go"), says(long)]);
    expect(words[0]?.length).toBeLessThanOrEqual(WORDS_CHARS);
    expect(words[0]?.startsWith("…w")).toBe(true);
    expect(words[0]?.endsWith("w199")).toBe(true);
    expect(cutToEnd("one two three", 8)).toBe("…three");
  });

  test("no words at all: the run, settled, with nothing running", () => {
    const run = runOf([you("go"), thinks(), tool("bash", "bun test", "running")], "failed");
    expect(run.strip).toMatchObject({ live: false });
    expect(run.strip?.marks.every((m) => !m.running)).toBe(true);
    expect(run.strip?.thoughts.every((t) => !t.streaming)).toBe(true);
  });

  test("nothing in the tail: nothing drawn", () => {
    expect(runOf([], "idle")).toEqual({ lines: [], strip: null });
  });
});

test("an asking window keeps its tail as it was", () => {
  const tail = [you("go"), says("one choice is yours.")];
  expect(runOf(tail, "wants")).toEqual({ lines: [{ kind: "prompt", id: tail[0]?.partID ?? "", text: "go" }, { kind: "prose", id: tail[1]?.partID ?? "", text: "one choice is yours." }], strip: null });
});

test("a failed step is red on the strip", () => {
  expect(stripOf([tool("bash", "x", "error")], true).marks[0]).toMatchObject({ bad: true, running: false });
});
