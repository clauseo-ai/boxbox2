import { describe, expect, test } from "bun:test";
import { DEFAULT_LEVELS, effortRange, meterOf, scaleOf } from "./effort";

describe("the effort ladder", () => {
  test("a model's efforts split into levels in ladder order and named variants as listed", () => {
    expect(scaleOf(["max", "low", "high", "thorough", "medium", "fast"])).toEqual({ levels: ["low", "medium", "high", "max"], named: ["thorough", "fast"] });
  });

  test("a repeated level is kept once", () => {
    expect(scaleOf(["low", "low", "high"]).levels).toEqual(["low", "high"]);
  });

  test("a model that takes no effort has an empty scale", () => {
    expect(scaleOf([])).toEqual({ levels: [], named: [] });
  });
});

describe("the meter", () => {
  const four = ["low", "medium", "high", "max"];

  test("one bar per level, and an effort lights the bars up to its rung", () => {
    expect(meterOf(four, "low")).toEqual({ bars: 4, filled: 1, variant: false });
    expect(meterOf(four, "high")).toEqual({ bars: 4, filled: 3, variant: false });
    expect(meterOf(four, "max")).toEqual({ bars: 4, filled: 4, variant: false });
  });

  test("no pick lights nothing, and none is not a bar", () => {
    expect(meterOf(four, null)).toEqual({ bars: 4, filled: 0, variant: false });
    expect(meterOf(["none", ...four], "none")).toEqual({ bars: 4, filled: 0, variant: false });
    expect(meterOf(["none", ...four], "low").filled).toBe(1);
  });

  test("an effort the model does not list reads as the nearest rung below it", () => {
    expect(meterOf(["low", "medium", "high"], "max")).toEqual({ bars: 3, filled: 3, variant: false });
    expect(meterOf(["low", "high", "max"], "xhigh")).toEqual({ bars: 3, filled: 2, variant: false });
  });

  test("a named variant is not a step: no bars lit, marked as a variant", () => {
    expect(meterOf(four, "thorough")).toEqual({ bars: 4, filled: 0, variant: true });
  });

  test("without the model's scale the meter draws the five levels every reasoning model takes", () => {
    expect(meterOf([], "xhigh")).toEqual({ bars: DEFAULT_LEVELS.length, filled: 4, variant: false });
  });
});

describe("a row's words for a model's efforts", () => {
  test("the range, the single level, the named ones, and none at all", () => {
    expect(effortRange(["low", "medium", "high", "max"])).toBe("low to max");
    expect(effortRange(["high"])).toBe("high");
    expect(effortRange(["low", "max", "careful", "quick"])).toBe("low to max, 2 named");
    expect(effortRange(["careful"])).toBe("1 named");
    expect(effortRange([])).toBe("no effort");
  });
});
