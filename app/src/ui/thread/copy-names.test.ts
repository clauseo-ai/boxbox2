import { describe, expect, test } from "bun:test";
import { commandLabel, nameOf, outputLabel, replyLabel, reportLabel } from "./copy-names";
import { languageOf } from "./languages";

describe("the base name of a code block's control", () => {
  test("a labelled fence names its language as hljs does", () => {
    expect(nameOf(languageOf("ts").label)).toBe("copy the typescript code");
    expect(nameOf(languageOf("sh").label)).toBe("copy the bash code");
  });
  test("an unknown word is the author's, a fence with no word has none", () => {
    expect(nameOf(languageOf("Elixir").label)).toBe("copy the elixir code");
    expect(nameOf(languageOf(undefined).label)).toBe("copy the code");
    expect(nameOf(languageOf("").label)).toBe("copy the code");
  });
});

describe("the names that come from the page", () => {
  test("a command's and an output's take their row's name, which already tells it from every other row's", () => {
    expect(commandLabel("run bun test, 54 passed")).toBe("copy the command, run bun test, 54 passed");
    expect(outputLabel("run bun test, 54 passed, again")).toBe("copy the output, run bun test, 54 passed, again");
  });
  test("a reply is named by its turn: its clock and the first line of the prompt, cut", () => {
    expect(replyLabel("17:17", "okay now go ahead and implement everything")).toBe("copy the reply, 17:17, okay now go ahead and implement everythi");
    expect(replyLabel("17:17", "\n\n  fix the retry\nand the log")).toBe("copy the reply, 17:17, fix the retry");
    expect(replyLabel("17:17", "")).toBe("copy the reply, 17:17, an image");
  });
  test("a report is named for its agent, a note as a note", () => {
    expect(reportLabel("helper", false)).toBe("copy helper's report");
    expect(reportLabel("helper", true)).toBe("copy helper's note");
  });
});
