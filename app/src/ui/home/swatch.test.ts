import { describe, expect, test } from "bun:test";
import { clockOf } from "../window/view";
import { initialsOf, markOf, stateWords } from "./swatch";

describe("a swatch's letters", () => {
  test("are the first two of the repo, lowercase", () => {
    expect(initialsOf("ledger")).toBe("le");
    expect(initialsOf("BoxBox")).toBe("bo");
  });

  test("skip the punctuation a folder name starts with", () => {
    expect(initialsOf(".github")).toBe("gi");
    expect(initialsOf("-a-b")).toBe("ab");
  });

  test("keep what a short name has", () => {
    expect(initialsOf("a")).toBe("a");
    expect(initialsOf("")).toBe("");
  });

  test("fall back to the characters when a name has no letters or digits", () => {
    expect(initialsOf("--")).toBe("--");
  });

  test("never cut a character in half", () => {
    expect(initialsOf("éclair")).toBe("éc");
    expect(initialsOf("日本語")).toBe("日本");
  });
});

describe("a swatch's mark", () => {
  test("is a badge for a window that wants you, a tick for one that finished, a dot for one at work, a cross for one that stopped", () => {
    expect(markOf("wants")).toBe("badge");
    expect(markOf("done")).toBe("tick");
    expect(markOf("working")).toBe("dot");
    expect(markOf("queued")).toBe("dot");
    expect(markOf("failed")).toBe("cross");
  });

  test("is nothing for a window that is parked or seen", () => {
    expect(markOf("parked")).toBeNull();
    expect(markOf("idle")).toBeNull();
  });
});

describe("a swatch's state in words", () => {
  const view = (over: Partial<Parameters<typeof stateWords>[0]>) => ({ state: "working" as const, chip: { text: "working", tone: "plain" as const }, since: null, failure: null, review: null, ...over });

  test("is the chip's own words", () => {
    expect(stateWords(view({}))).toBe("working");
    expect(stateWords(view({ state: "wants", chip: { text: "wants you", tone: "lit" } }))).toBe("wants you");
    expect(stateWords(view({ state: "queued", chip: { text: "working, 2 next", tone: "plain" } }))).toBe("working, 2 next");
  });

  test("says when a finished turn ended", () => {
    const at = Date.UTC(2026, 9, 2, 13, 20);
    expect(stateWords(view({ state: "done", chip: { text: "done", tone: "plain" }, since: at }))).toBe(`done at ${clockOf(at)}`);
  });

  test("says a finished turn is ready to merge when a review waits, not when it ended", () => {
    const at = Date.UTC(2026, 9, 2, 13, 20);
    expect(stateWords(view({ state: "done", chip: { text: "ready to merge", tone: "plain" }, since: at, review: "the toggle is in" }))).toBe("ready to merge");
  });

  test("says why a turn stopped", () => {
    expect(stateWords(view({ state: "failed", chip: { text: "stopped", tone: "fail" }, failure: "the key has no credit left" }))).toBe("stopped: the key has no credit left");
    expect(stateWords(view({ state: "failed", chip: { text: "stopped", tone: "fail" } }))).toBe("stopped");
  });

  test("says seen for a window the chip is silent about", () => {
    expect(stateWords(view({ state: "idle", chip: null }))).toBe("seen");
  });
});
