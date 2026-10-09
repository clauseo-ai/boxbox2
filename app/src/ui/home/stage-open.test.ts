import { describe, expect, test } from "bun:test";
import { openVerdict } from "./stage-open";

describe("a thread the store names opens only when it can be drawn", () => {
  test("a session the fleet holds opens, caught up or not", () => {
    expect(openVerdict(true, false)).toBe("open");
    expect(openVerdict(true, true)).toBe("open");
  });

  test("a session the fleet has not brought yet is waited for, never opened blank", () => {
    expect(openVerdict(false, false)).toBe("wait");
  });

  test("a session still missing once the stream caught up is dropped, so the windows are not left inert under nothing", () => {
    expect(openVerdict(false, true)).toBe("drop");
  });
});
