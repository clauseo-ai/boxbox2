import { describe, expect, test } from "bun:test";
import { clockOf } from "../window/view";
import { awayDetail, awaySubtitle, awayWords, hoursAfter } from "./away";

const H = 60 * 60 * 1000;
const done = Date.UTC(2026, 9, 26, 12, 0);

describe("the away line and sheet's words", () => {
  test("the line and the sheet's title", () => {
    expect(awayWords(6)).toBe("6 cleared while you were away");
    expect(awayWords(1)).toBe("1 cleared while you were away");
  });

  test("the subtitle follows the mode", () => {
    expect(awaySubtitle("seen1h")).toBe("each was done and seen more than an hour ago. they are still in history.");
    expect(awaySubtitle("any3h")).toBe("each was done more than 3 hours ago, seen or not. they are still in history.");
    expect(awaySubtitle("never")).toContain("still in history");
  });

  test("whole hours, never under one", () => {
    expect(hoursAfter(H + 4 * 60 * 1000)).toBe("an hour after");
    expect(hoursAfter(50 * 60 * 1000)).toBe("an hour after");
    expect(hoursAfter(3 * H + 60_000)).toBe("3 hours after");
  });

  test("an hour after seen counts from the seen", () => {
    const row = { doneAt: done, seenAt: done + 7 * 60 * 1000, clearedAt: done + 7 * 60 * 1000 + H + 120_000 };
    expect(awayDetail(row, "seen1h")).toBe(`done ${clockOf(row.doneAt)}, seen ${clockOf(row.seenAt)}, cleared an hour after`);
  });

  test("3 hours, seen or not, counts from the done, and says when it was not seen", () => {
    expect(awayDetail({ doneAt: done, seenAt: null, clearedAt: done + 3 * H + 60_000 }, "any3h")).toBe(`done ${clockOf(done)}, not seen, cleared 3 hours after`);
    expect(awayDetail({ doneAt: done, seenAt: done + H, clearedAt: done + 3 * H + 60_000 }, "any3h")).toBe(`done ${clockOf(done)}, seen ${clockOf(done + H)}, cleared 3 hours after`);
  });
});
