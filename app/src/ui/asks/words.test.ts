import { describe, expect, test } from "bun:test";
import type { Ask } from "../../sync/protocol";
import { goneLine, headerWords, questionsOf, settledLine, shortWords, waitingWords } from "./words";

const ask = (kind: "permission" | "question", fields: Partial<Pick<Ask, "questions" | "permission">> = {}): Ask => ({
  key: "desk:ses_1",
  agent: "desk",
  thread: "desk:ses_1",
  id: "a1",
  kind,
  ...fields,
});

const permission = (title: string, patterns: string[]) => ({ title, patterns, always: [], options: [] });
const option = (label: string) => ({ label, description: `what ${label} means` });
const question = (options: number, extra: Record<string, unknown> = {}) => ({
  header: "greeting",
  question: "which greeting?",
  options: Array.from({ length: options }, (_, i) => option(`option ${i + 1}`)),
  multiple: false,
  custom: true,
  ...extra,
});

describe("reading an ask", () => {
  test("a question keeps its options and whether a typed answer is taken", () => {
    const [q] = questionsOf(
      ask("question", {
        questions: [{ header: "greeting", question: "which greeting?", options: [{ label: "hello", description: "plain" }, { label: "hi" }], multiple: false, custom: true }],
      }),
    );
    expect(q?.options).toEqual([
      { label: "hello", description: "plain" },
      { label: "hi", description: null },
    ]);
    expect(q?.custom).toBe(true);
    expect(q?.multiple).toBe(false);
  });

  test("an ask with no questions reads as none rather than throwing", () => {
    expect(questionsOf(ask("question", { questions: null }))).toEqual([]);
  });
});

describe("what a window's preview says is waiting", () => {
  test("one question counts its options", () => {
    expect(waitingWords(ask("question", { questions: [question(3)] }))).toBe("3 options");
    expect(waitingWords(ask("question", { questions: [question(1)] }))).toBe("1 option");
  });

  test("a question that takes any number of options says so", () => {
    expect(waitingWords(ask("question", { questions: [question(4, { multiple: true })] }))).toBe("4 options, pick any");
  });

  test("more than one question counts the questions, not the options", () => {
    expect(waitingWords(ask("question", { questions: [question(3), question(2)] }))).toBe("2 questions");
  });

  test("a question with no options, or no questions, asks for words", () => {
    expect(waitingWords(ask("question", { questions: [question(0)] }))).toBe("type an answer");
    expect(waitingWords(ask("question", {}))).toBe("type an answer");
  });

  test("a permission names its three replies in the card's own words", () => {
    expect(waitingWords(ask("permission", { permission: permission("shell", ["rm -rf build"]) }))).toBe("allow once, always allow or deny");
  });

  test("the header is the first question's own label, and a permission's is its kind", () => {
    expect(headerWords(ask("question", { questions: [question(2, { header: "  message got cut off " })] }))).toBe("message got cut off");
    expect(headerWords(ask("question", { questions: [question(2, { header: "" })] }))).toBeNull();
    expect(headerWords(ask("permission", { permission: permission("shell", []) }))).toBe("permission");
  });
});

describe("a short name for a long question", () => {
  test("words that fit are kept whole, with their lines folded to spaces", () => {
    expect(shortWords("which greeting\nshould the notes use?", 60)).toBe("which greeting should the notes use?");
  });

  test("words that do not fit stop at a whole word and say so", () => {
    expect(shortWords("Your message stopped at the point where we do not have access to the thing", 40)).toBe("Your message stopped at the point where...");
  });

  test("a single word longer than the limit is cut where it stands", () => {
    expect(shortWords("a".repeat(100), 20)).toBe(`${"a".repeat(20)}...`);
  });
});

describe("an answer that lost the race", () => {
  test("a settled line names where and when", () => {
    expect(settledLine("iphone", null)).toBe("answered on iphone");
    expect(settledLine("mac", new Date(2026, 9, 1, 23, 49).getTime())).toBe("answered on mac at 23:49");
  });

  test("an ask that is gone says why, with a full stop", () => {
    expect(goneLine()).toBe("this is gone: it was answered, or its turn ended.");
  });
});
