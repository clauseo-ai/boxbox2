import { describe, expect, test } from "bun:test";
import { FRESH_OFFLINE, FRESH_READING, FRESH_UNFOLLOWED, type FreshnessInput, freshnessOf, type ReadingInput, readingOf, readingWords } from "./reading";

const base: ReadingInput = { empty: true, stalled: true, streamDown: false, held: true, hydrating: true, trouble: undefined };

describe("a stage that shows nothing", () => {
  test("says nothing before its patience runs out, nor once it shows rows, nor for a thread that is read and empty", () => {
    expect(readingOf({ ...base, stalled: false })).toBeNull();
    expect(readingOf({ ...base, empty: false, trouble: { gone: true, problem: null } })).toBeNull();
    expect(readingOf({ ...base, hydrating: false })).toBeNull();
  });

  test("a thread the server cannot find is said at once, before the patience", () => {
    expect(readingOf({ ...base, stalled: false, trouble: { gone: true, problem: null } })).toEqual({ kind: "gone" });
  });

  test("once stalled: offline first, then not held, then the read's failure, then a read still out", () => {
    const failing = { gone: false, problem: "vm-a is not answering" };
    expect(readingOf({ ...base, streamDown: true, held: false, trouble: failing })).toEqual({ kind: "offline" });
    expect(readingOf({ ...base, held: false, trouble: failing })).toEqual({ kind: "undrawn" });
    expect(readingOf({ ...base, trouble: failing })).toEqual({ kind: "failed", problem: "vm-a is not answering" });
    expect(readingOf({ ...base, trouble: { gone: false, problem: null } })).toEqual({ kind: "failed", problem: "the server did not answer" });
    expect(readingOf(base)).toEqual({ kind: "waiting" });
  });

  test("the words: the ios copy, a failure as one sentence, and what happens next", () => {
    expect(readingWords({ kind: "gone" })).toEqual({ line: "the server cannot find this thread.", next: "it is asked for again on its own, in case it comes.", status: "not found on the server" });
    expect(readingWords({ kind: "failed", problem: "vm-a is not answering." })).toEqual({ line: "vm-a is not answering.", next: "it is asked for again on its own. retry asks now.", status: "did not load" });
    expect(readingWords({ kind: "offline" }).line).toBe("offline. the thread loads once the server answers.");
    expect(readingWords({ kind: "waiting" }).status).toBe("still reading");
    expect(readingWords({ kind: "undrawn" }).line).toBe("the thread came, but this screen did not draw it.");
  });
});

describe("the freshness line", () => {
  const fresh: FreshnessInput = { turns: 3, offline: false, live: true, failing: false, followed: true, caughtUp: true };

  test("says nothing while the stage shows the server's truth, or has no turns", () => {
    expect(freshnessOf(fresh)).toBeNull();
    expect(freshnessOf({ ...fresh, turns: 0, offline: true })).toBeNull();
  });

  test("offline outranks a failing read, which outranks a thread the fleet does not follow", () => {
    expect(freshnessOf({ ...fresh, offline: true, live: false, failing: true, followed: false })).toBe(FRESH_OFFLINE);
    expect(freshnessOf({ ...fresh, failing: true, followed: false })).toBe(FRESH_READING);
    expect(freshnessOf({ ...fresh, followed: false })).toBe(FRESH_UNFOLLOWED);
  });

  test("a failing read or an unfollowed thread is said only while the stream is live, the second only once it has caught up", () => {
    expect(freshnessOf({ ...fresh, live: false, failing: true })).toBeNull();
    expect(freshnessOf({ ...fresh, followed: false, caughtUp: false })).toBeNull();
  });
});
