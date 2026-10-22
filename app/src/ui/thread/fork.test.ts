import { describe, expect, test } from "bun:test";
import { forkBoundary, forkLabel, lineageOf, turnBeforeCut } from "./fork";
import { boundaryWords, forkHeld, lineageWords } from "./fork-words";
import { cutAfter } from "./fork-cut";
import { type Turn, turnsOf } from "./model";
import { neutralMessage } from "../../sync/fixtures/neutral";

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

  test("a turn's reports and notices are its own: a fork through its end is cut before the person's next message, so it holds them", () => {
    const at = 1_790_000_000_000;
    const msg = (info: Record<string, unknown>, parts: Record<string, unknown>[]) => neutralMessage({ info, parts: parts.map((p) => ({ ...p, messageID: info["id"] })) });
    const built = turnsOf([
      msg({ id: "msg_1", role: "user", time: { created: at } }, [{ id: "p1", type: "text", text: "go" }]),
      msg({ id: "msg_2", role: "assistant", time: { created: at + 1, completed: at + 2 } }, [{ id: "p2", type: "text", text: "waiting." }]),
      msg({ id: "msg_3", role: "user", time: { created: at + 3 }, mail: { kind: "report", from: "/root/a" } }, [{ id: "p3", type: "text", text: "ready", mail: { kind: "report", from: "/root/a" } }]),
      msg({ id: "msg_4", role: "user", time: { created: at + 4 }, notice: true }, [{ id: "p4", type: "text", text: "job j: exited with code 0; no output", notice: true }]),
      msg({ id: "msg_5", role: "assistant", time: { created: at + 5, completed: at + 6 } }, [{ id: "p5", type: "text", text: "done." }]),
      msg({ id: "msg_7", role: "user", time: { created: at + 7 } }, [{ id: "p7", type: "text", text: "next" }]),
    ], "/");
    expect(built.map((t) => t.id)).toEqual(["msg_1", "msg_7"]);
    expect(cutAfter(built, "msg_1")).toEqual({ before: "msg_7" });
    expect(cutAfter(built, "msg_7")).toEqual({});
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

describe("where a fork's copied history ends", () => {
  const MADE = 5000;
  const at = (id: string, time: number) => ({ id, at: time });

  test("after the last turn that began before the fork was made: the copies keep the parent's times", () => {
    expect(forkBoundary([at("msg_f_1", 1000), at("msg_f_2", 2000), at("msg_f_3", 6000), at("msg_f_4", 7000)], MADE)).toBe("msg_f_2");
  });

  test("a whole fork with no turns of its own yet ends with its last turn", () => {
    expect(forkBoundary([at("msg_f_1", 1000), at("msg_f_2", 2000)], MADE)).toBe("msg_f_2");
  });

  test("a fork with no copied turn shown has no boundary", () => {
    expect(forkBoundary([at("msg_f_3", 6000)], MADE)).toBeNull();
    expect(forkBoundary([], MADE)).toBeNull();
  });

  test("a turn begun in the same millisecond the fork was made is the fork's own", () => {
    expect(forkBoundary([at("msg_f_1", 1000), at("msg_f_2", MADE)], MADE)).toBe("msg_f_1");
  });

  test("its words name the thread, say what is above, and name the link apart from the title block's", () => {
    const named = boundaryWords({ key: "desk:ses_1", title: "fix the reducer", cut: "msg_9" }, true);
    expect(`${named.before}${named.link}${named.stop}${named.after}`).toBe("forked from fix the reducer. everything above came from it; this thread's own turns start here.");
    expect(named.name).toBe("open fix the reducer where this fork was cut");
    expect(named.name).not.toBe(lineageWords({ key: "desk:ses_1", title: "fix the reducer", cut: "msg_9" }));
    const waiting = boundaryWords({ key: "desk:ses_1", title: null, cut: null }, false);
    expect(`${waiting.before}${waiting.link}${waiting.stop}${waiting.after}`).toBe("forked from another thread. everything above came from it; this thread's own turns will start here.");
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
    const turns = [{ id: "msg_1", items: [] }, { id: "msg_4", items: [] }, { id: "msg_9", items: [] }];
    expect(turnBeforeCut(turns, "msg_9")).toBe("msg_4");
    expect(turnBeforeCut(turns, "msg_4")).toBe("msg_1");
    // a cut at the first turn has nothing above it: that turn
    expect(turnBeforeCut(turns, "msg_1")).toBe("msg_1");
    expect(turnBeforeCut(turns, "msg_7")).toBeNull();
  });

  test("a cut before a report that arrived inside a turn (a fork made when reports were turns) lands on the turn it arrived in", () => {
    const turns = [{ id: "msg_1", items: [] }, { id: "msg_4", items: [{ k: "arrive" as const, id: "msg_6", kind: "report" as const, text: "ready", at: 6 }] }, { id: "msg_9", items: [] }];
    expect(turnBeforeCut(turns, "msg_6")).toBe("msg_4");
  });
});
