import { describe, expect, test } from "bun:test";
import type { TailItem } from "../../sync/protocol";
import { growth, lastSentences, TAIL_LINES, tailLines } from "./tail";

let serial = 0;
const tool = (name: string, text: string, state = "completed"): TailItem => ({
  kind: "tool",
  tool: name,
  state,
  text,
  role: "assistant",
  messageID: "msg_1",
  partID: `prt_${++serial}`,
});
const prose = (text: string, kind: TailItem["kind"] = "text"): TailItem => ({ kind, text, role: "assistant", messageID: "msg_1", partID: `prt_${++serial}` });
const prompt = (text: string): TailItem => ({ kind: "text", text, role: "user", messageID: "msg_0", partID: `prt_${++serial}` });

describe("the tail's grammar", () => {
  test("consecutive reads fold into one line with the count", () => {
    const lines = tailLines([tool("read", "src/a.rs"), tool("read", "src/b.rs"), tool("grep", "limit"), tool("edit", "src/a.rs")]);
    expect(lines).toMatchObject([
      { kind: "reads", count: 3, status: "done" },
      { kind: "tool", verb: "edit", object: "a.rs" },
    ]);
  });

  test("a single read names its file", () => {
    expect(tailLines([tool("read", "/work/notes.md")])).toMatchObject([{ kind: "reads", count: 1, object: "notes.md" }]);
  });

  test("a picture or a voice note reads as the file contract 1 sent it as", () => {
    for (const kind of ["file", "image", "audio"] as const) expect(tailLines([prose("/work/shots/screen.png", kind)])).toMatchObject([{ kind: "file", name: "screen.png" }]);
    expect(tailLines([prose("", "image")])).toEqual([]);
  });

  test("a folded read is running while its newest read runs", () => {
    expect(tailLines([tool("read", "a"), tool("read", "b", "running")])).toMatchObject([{ kind: "reads", count: 2, status: "running" }]);
  });

  test("a command is its short form, and says so when it failed", () => {
    const long = `cargo test --workspace --all-features -- --nocapture --test-threads 1\necho done`;
    const [line] = tailLines([tool("shell", long, "error")]);
    expect(line).toMatchObject({ kind: "tool", verb: "run", result: "failed", status: "failed" });
    expect(line?.kind === "tool" && line.object.length).toBeLessThanOrEqual(48);
    expect(line?.kind === "tool" && line.object.includes("\n")).toBe(false);
  });

  test("questions, todos and thinking stay out of the tail", () => {
    expect(tailLines([tool("question", "which greeting?"), tool("todowrite", "plan"), prose("hmm", "reasoning")])).toEqual([]);
  });

  test("starting an agent reads agent, never spawn spawn: the daemon's title names the tool, not the agent (ask a24)", () => {
    expect(tailLines([tool("spawn", "spawn", "running")])).toMatchObject([{ kind: "tool", verb: "agent", object: "", status: "running" }]);
    expect(tailLines([tool("spawn", "helper")])).toMatchObject([{ kind: "tool", verb: "agent", object: "helper" }]);
    expect(tailLines([tool("wait", "wait", "running")])).toMatchObject([{ kind: "tool", verb: "wait", object: "", status: "running" }]);
  });

  test("another agent's report is named by its sender, not shown as your prompt", () => {
    const report: TailItem = { kind: "text", text: "agent /root/helper reached status: parked\n\nall green", role: "user", from: "helper", messageID: "msg_2", partID: "prt_r" };
    expect(tailLines([report])).toMatchObject([{ kind: "report", from: "helper" }]);
  });

  test("prose shows its last two sentences", () => {
    const [line] = tailLines([prose("one. two. three is here. four is the last")]);
    expect(line).toMatchObject({ kind: "prose", text: "three is here. four is the last" });
  });

  test("your prompt is its own line, whole and flattened, while the agent's prose keeps two sentences", () => {
    const lines = tailLines([prompt("add a per-customer limit.\n\n100 a minute. and log it."), prose("one. two. three.")]);
    expect(lines).toEqual([
      { kind: "prompt", id: expect.any(String), text: "add a per-customer limit. 100 a minute. and log it." },
      { kind: "prose", id: expect.any(String), text: "two. three." },
    ]);
  });

  test("an empty prompt shows nothing", () => {
    expect(tailLines([prompt("  \n ")])).toEqual([]);
  });

  test("the tail never holds more than the window can show", () => {
    const many = Array.from({ length: 30 }, (_, i) => (i % 2 ? tool("edit", `f${i}`) : prose(`line ${i}.`)));
    expect(tailLines(many).length).toBe(TAIL_LINES);
    expect(tailLines(many).at(-1)).toMatchObject({ kind: "tool", object: "f29" });
  });
});

describe("the last sentences of prose", () => {
  test("a sentence ends at . ! or ? followed by a space", () => {
    expect(lastSentences("first! second? third.", 2)).toBe("second? third.");
  });
  test("a number or a path is not the end of a sentence", () => {
    expect(lastSentences("version 1.2 is out. see ./docs/a.md for more", 1)).toBe("see ./docs/a.md for more");
  });
  test("whitespace collapses and empty prose is nothing", () => {
    expect(lastSentences("  a.\n\n b.  ", 2)).toBe("a. b.");
    expect(lastSentences("   ", 2)).toBe("");
  });
});

describe("how streamed prose grows", () => {
  test("words added at the end are what settles in", () => {
    expect(growth("the limiter is", "the limiter is a token")).toEqual({ dropped: 0, added: " a token" });
  });
  test("when a third sentence pushes the first out, what stays keeps its place", () => {
    expect(growth("one. two is", "two is here. three")).toEqual({ dropped: 5, added: " here. three" });
  });
  test("a rewrite, a shorter text or the same text paints in place", () => {
    expect(growth("the limiter", "a different answer")).toBeNull();
    expect(growth("the limiter", "the limit")).toBeNull();
    expect(growth("the limiter", "the limiter")).toBeNull();
  });
});
