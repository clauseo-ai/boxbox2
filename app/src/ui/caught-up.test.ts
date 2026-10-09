import { describe, expect, test } from "bun:test";
import { CATCH_UP_MS, catchUpIn } from "./caught-up";

const NOW = 1_790_000_000_000;

describe("when the stream has caught up", () => {
  test("a stream that went live this instant has the whole second to wait", () => {
    expect(catchUpIn({ state: "live", since: NOW }, NOW)).toBe(CATCH_UP_MS);
  });

  test("it counts the second from when the stream went live", () => {
    expect(catchUpIn({ state: "live", since: NOW - 400 }, NOW)).toBe(CATCH_UP_MS - 400);
    expect(catchUpIn({ state: "live", since: NOW - CATCH_UP_MS }, NOW)).toBe(0);
  });

  test("a stream that has been live for a while has caught up: nothing to wait", () => {
    expect(catchUpIn({ state: "live", since: NOW - 60_000 }, NOW)).toBe(0);
  });

  test("a stream that is not live has not caught up, and has no time to say", () => {
    expect(catchUpIn({ state: "down", since: NOW - 60_000 }, NOW)).toBeNull();
    expect(catchUpIn({ state: "connecting", since: NOW }, NOW)).toBeNull();
  });

  test("the second is the one home has always waited for the replay", () => {
    expect(CATCH_UP_MS).toBe(1000);
  });
});
