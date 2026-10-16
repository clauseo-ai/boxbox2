import { describe, expect, test } from "bun:test";
import { inlineRuns, plainOf, withoutBlockMarks } from "./inline";

describe("the live line reads markdown inline", () => {
  test("strong is drawn strong, emphasis as emphasis, code in mono, and no mark is shown", () => {
    expect(inlineRuns("the **tests** pass")).toEqual([{ text: "the " }, { text: "tests", strong: true }, { text: " pass" }]);
    expect(inlineRuns("it is *not* the cache")).toEqual([{ text: "it is " }, { text: "not", em: true }, { text: " the cache" }]);
    expect(inlineRuns("ran `bun test` again")).toEqual([{ text: "ran " }, { text: "bun test", code: true }, { text: " again" }]);
    expect(inlineRuns("__both__ and _one_")).toEqual([{ text: "both", strong: true }, { text: " and " }, { text: "one", em: true }]);
  });

  test("a mark still being written is dropped, never drawn as a literal star", () => {
    expect(plainOf(inlineRuns("the change is **small"))).toBe("the change is small");
    expect(inlineRuns("the change is **small")).toEqual([{ text: "the change is small" }]);
    expect(plainOf(inlineRuns("look at `compaction"))).toBe("look at compaction");
  });

  test("an underscore inside a word and a star between spaces are the text's own", () => {
    expect(plainOf(inlineRuns("the snake_case_name stays"))).toBe("the snake_case_name stays");
    expect(plainOf(inlineRuns("2 * 3 is 6"))).toBe("2 * 3 is 6");
  });

  test("inside code nothing is a mark", () => {
    expect(inlineRuns("`a **b**`")).toEqual([{ text: "a **b**", code: true }]);
  });

  test("a link reads as its words", () => {
    expect(plainOf(inlineRuns("see [the notes](https://example.com/notes) first"))).toBe("see the notes first");
  });

  test("block marks go before the prose is cut", () => {
    expect(withoutBlockMarks("## the plan\n- read it\n1. fix it\n> quoted\n```ts")).toBe("the plan\nread it\nfix it\nquoted\n");
    expect(withoutBlockMarks("a #hashtag stays")).toBe("a #hashtag stays");
  });
});
