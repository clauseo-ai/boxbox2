import { describe, expect, test } from "bun:test";
import { refusalOf, rgbOf } from "./pin";

describe("arming a pairing", () => {
  test("a window's light tone goes as the wire's three bytes", () => {
    expect(rgbOf("#8fe6a5")).toEqual([143, 230, 165]);
    expect(rgbOf("#000000")).toEqual([0, 0, 0]);
    expect(rgbOf("#ffffff")).toEqual([255, 255, 255]);
  });

  test("a refusal says what happened and what to do, in lowercase with no dash", () => {
    for (const status of [401, 409, 500, 503]) {
      const words = refusalOf(status);
      expect(words).toBe(words.toLowerCase());
      expect(words).not.toMatch(/[\u2013\u2014]/);
      expect(words.endsWith(".")).toBe(true);
    }
    expect(refusalOf(409)).toContain("plug it in");
  });
});
