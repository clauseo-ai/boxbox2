import { describe, expect, test } from "bun:test";
import type { Ask } from "../../sync/protocol";
import { needOf } from "./need";

type Asked = { header?: string; question: string; options: { label: string; description?: string }[] };

/* the server's ask as translate.rs makes it of cmx2's: a question it sent without a header has an empty one, and cmx2
   always takes a typed answer */
const q = (id: string, questions: Asked[]): Ask => ({
  agent: "bench",
  id,
  key: "bench:ses_1",
  thread: "bench:ses_1",
  kind: "question",
  questions: questions.map((item) => ({ header: item.header ?? "", question: item.question, options: item.options, multiple: false, custom: true })),
});
const p = (id: string, permission: string, patterns: string[]): Ask => ({
  agent: "bench",
  id,
  key: "bench:ses_1",
  thread: "bench:ses_1",
  kind: "permission",
  permission: { title: permission, patterns, always: [], options: [] },
});

const one = q("que_1", [{ header: "greeting", question: "which greeting should the notes use?", options: [{ label: "hello" }, { label: "hi" }] }]);

describe("what a window that wants you needs, in one line", () => {
  test("nothing waits: no need", () => {
    expect(needOf([])).toBeNull();
  });

  test("one question is its own words, its header above and what answering takes below", () => {
    expect(needOf([one])).toEqual({ eyebrow: "greeting", line: "which greeting should the notes use?", detail: "2 options", questions: 1, permissions: 0, asks: 1 });
  });

  test("several questions, in one ask or across asks, are counted and named by their headers", () => {
    const two = q("que_2", [{ header: "models", question: "which models stay?", options: [] }, { header: "where it runs", question: "here or a worktree?", options: [] }]);
    expect(needOf([one, two])).toMatchObject({ eyebrow: null, line: "asks 3 questions", detail: "greeting, models, where it runs", questions: 3, asks: 2 });
  });

  test("a header missing among several: the first question's words instead", () => {
    const two = q("que_2", [{ question: "which models stay?", options: [] }]);
    expect(needOf([one, two])?.detail).toBe("which greeting should the notes use?");
  });

  test("one permission says what it wants to do", () => {
    expect(needOf([p("per_1", "bash", ["bun test"])])).toEqual({ eyebrow: "permission", line: "wants permission to run bun test", detail: "allow once, always allow or deny", questions: 0, permissions: 1, asks: 1 });
  });

  test("several permissions are counted, and what they want listed", () => {
    expect(needOf([p("per_1", "bash", ["bun test"]), p("per_2", "edit", ["src/app.ts"])])).toMatchObject({ eyebrow: null, line: "wants 2 permissions", detail: "run bun test, edit src/app.ts" });
  });

  test("a thread that asks both says both halves", () => {
    expect(needOf([one, p("per_1", "bash", ["bun test"])])).toMatchObject({ eyebrow: null, line: "asks a question and wants permission to run bun test", detail: "2 asks waiting" });
    expect(needOf([one, one, p("per_1", "bash", []), p("per_2", "webfetch", [])])?.line).toBe("asks 2 questions and wants 2 permissions");
  });

  test("a question whose request does not parse still counts as one question waiting", () => {
    expect(needOf([q("que_9", [])])).toMatchObject({ line: "the agent has a question", questions: 1 });
  });
});
