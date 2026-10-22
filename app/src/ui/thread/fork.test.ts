import { describe, expect, test } from "bun:test";
import { cutAfter, forkHeld, forkLabel, lineageOf, lineageWords, turnBeforeCut } from "./fork";
import type { Turn } from "./model";

type T = Pick<Turn, "id" | "by" | "status" | "items" | "answer">;
const turn = (id: string, over: Partial<T> = {}): T => ({ id, by: "you", status: "done", items: [], answer: { k: "say", id: `${id}_a`, text: "done", at: 1, streaming: false }, ...over });
/** a queued message that has not run: no rows, no answer */
const waiting = (id: string): T => ({ id, by: "queued", status: "done", items: [] });

describe("where a fork from a turn is cut", () => {
  const turns = [turn("msg_1"), turn("msg_4"), turn("msg_9")];

  test("before the first message of the turn after it, so the fork holds the turn through its end", () => {
    expect(cutAfter(turns, "msg_1")).toEqual({ before: "msg_4" });
    expect(cutAfter(turns, "msg_4")).toEqual({ before: "msg_9" });
  });

  test("the last turn forks the whole thread", () => {
    expect(cutAfter(turns, "msg_9")).toEqual({});
  });

  test("a turn that is running, or waits and has not run, has no end to fork at", () => {
    expect(cutAfter([turn("msg_1"), turn("msg_4", { status: "working" })], "msg_4")).toBeNull();
    expect(cutAfter([turn("msg_1"), waiting("msg_4")], "msg_4")).toBeNull();
  });

  test("a turn before a running one is cut before it: the running turn stays out of the fork", () => {
    expect(cutAfter([turn("msg_1"), turn("msg_4", { status: "working" })], "msg_1")).toEqual({ before: "msg_4" });
  });

  test("a turn before one that waits is cut before the waiting message", () => {
    expect(cutAfter([turn("msg_1"), waiting("msg_4")], "msg_1")).toEqual({ before: "msg_4" });
  });

  test("a turn the thread does not have is not forked at", () => {
    expect(cutAfter(turns, "msg_7")).toBeNull();
    expect(cutAfter([], "msg_1")).toBeNull();
  });
});

describe("when a fork is held", () => {
  test("never for a settled thread on a live stream", () => {
    expect(forkHeld({ streamDown: false, browseOnly: false, working: false })).toBeNull();
  });

  test("says why, imported history first, then the stream, then the turn", () => {
    expect(forkHeld({ streamDown: true, browseOnly: true, working: true })).toBe("imported history is browse only");
    expect(forkHeld({ streamDown: true, browseOnly: false, working: true })).toBe("offline");
    expect(forkHeld({ streamDown: false, browseOnly: false, working: true })).toBe("after this turn");
  });
});

describe("a turn's fork control", () => {
  test("is named apart by its clock and its prompt's first line, as the reply's copy control is", () => {
    expect(forkLabel("17:17", "\n\n  fix the retry\nand the log")).toBe("fork from here, 17:17, fix the retry");
    expect(forkLabel("09:02", "okay now go ahead and implement everything please")).toBe("fork from here, 09:02, okay now go ahead and implement everythi");
    expect(forkLabel("09:02", "")).toBe("fork from here, 09:02, an image");
  });
});

describe("the lineage line", () => {
  const titles: Record<string, string> = { "desk:ses_1": "fix the reducer" };
  const titleOf = (key: string) => titles[key];

  test("names the thread it was forked from on the same agent, and where it was cut", () => {
    const lineage = lineageOf({ thread: "ses_1", message: "msg_9" }, "desk", titleOf);
    expect(lineage).toEqual({ key: "desk:ses_1", title: "fix the reducer", cut: "msg_9" });
    expect(lineageWords(lineage!)).toBe("forked from fix the reducer");
  });

  test("a fork of the whole thread has no cut", () => {
    expect(lineageOf({ thread: "ses_1" }, "desk", titleOf)?.cut).toBeNull();
  });

  test("a thread the fleet does not hold (archived, never on home) is still named as a thread", () => {
    const lineage = lineageOf({ thread: "ses_gone", message: "msg_2" }, "desk", titleOf);
    expect(lineage?.title).toBeNull();
    expect(lineageWords(lineage!)).toBe("forked from another thread");
  });

  test("a thread that was not forked, or a server that does not say, has no line", () => {
    expect(lineageOf(undefined, "desk", titleOf)).toBeNull();
    expect(lineageOf(null, "desk", titleOf)).toBeNull();
  });

  test("its link lands on the turn just above the cut, which is the turn the fork was made from", () => {
    const turns = [{ id: "msg_1" }, { id: "msg_4" }, { id: "msg_9" }];
    expect(turnBeforeCut(turns, "msg_9")).toBe("msg_4");
    expect(turnBeforeCut(turns, "msg_4")).toBe("msg_1");
    // a cut at the first turn has nothing above it: that turn
    expect(turnBeforeCut(turns, "msg_1")).toBe("msg_1");
    expect(turnBeforeCut(turns, "msg_7")).toBeNull();
  });
});
