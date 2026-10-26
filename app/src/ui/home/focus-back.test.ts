import { describe, expect, test } from "bun:test";
import { focusBack } from "./focus-back";

const el = (connected: boolean) => {
  const got: string[] = [];
  return { isConnected: connected, focus: () => void got.push("focus"), got };
};

describe("focus back after a list or the toast closes", () => {
  test("what opened it, while it is still on the page", () => {
    const back = el(true);
    const bar = el(true);
    expect(focusBack(back, () => bar)).toBe("back");
    expect(back.got).toEqual(["focus"]);
    expect(bar.got).toEqual([]);
  });

  test("the bar's first control when that went with the change (bring all back, a successful undo)", () => {
    const back = el(false);
    const bar = el(true);
    expect(focusBack(back, () => bar)).toBe("bar");
    expect(bar.got).toEqual(["focus"]);
    expect(focusBack(null, () => bar)).toBe("bar");
    expect(focusBack(null, () => null)).toBe("none");
  });

  test("the bar's first control when what opened it is still here but leaves on the next flip (the away line, seen)", () => {
    const back = el(true);
    const bar = el(true);
    expect(focusBack(back, () => bar, true)).toBe("bar");
    expect(back.got).toEqual([]);
    expect(bar.got).toEqual(["focus"]);
    expect(focusBack(back, () => null, true)).toBe("none");
    expect(back.got).toEqual([]);
  });
});
