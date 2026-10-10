import { describe, expect, test } from "bun:test";
import { FADE, motionProperties, PRESS, PRESS_DIM, REDUCED_FADE, SETTLE, SHEET, SNAP, spring } from "./springs";

const points = (easing: string) =>
  easing
    .replace(/^linear\(|\)$/g, "")
    .split(",")
    .map((p) => Number(p.trim()));

describe("the two springs", () => {
  test("snap (380, 32) settles in about 420 ms", () => {
    expect(SNAP.duration).toBeGreaterThan(380);
    expect(SNAP.duration).toBeLessThan(470);
  });

  test("sheet (250, 27) settles in about 560 ms (508 ms to the 8e-4 rest the prototype also uses)", () => {
    expect(SHEET.duration).toBeGreaterThan(480);
    expect(SHEET.duration).toBeLessThan(620);
  });

  test("each curve starts at 0, ends exactly at 1 and overshoots a little on the way", () => {
    for (const curve of [SNAP, SHEET]) {
      const p = points(curve.easing);
      expect(p[0]).toBe(0);
      expect(p[p.length - 1]).toBe(1);
      expect(p.every(Number.isFinite)).toBe(true);
      const peak = Math.max(...p);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThan(1.08);
    }
  });

  test("a curve carries few enough points to parse cheaply", () => {
    expect(points(SNAP.easing).length).toBeLessThanOrEqual(80);
    expect(points(SHEET.easing).length).toBeLessThanOrEqual(80);
  });

  test("sampling is deterministic: the same constants give the same curve", () => {
    expect(spring(380, 32)).toEqual(SNAP);
  });
});

describe("the short curves", () => {
  test("content swaps fade in 160 ms, streamed words settle in 360 ms", () => {
    expect(FADE).toEqual({ easing: "cubic-bezier(.2, .8, .2, 1)", duration: 160 });
    expect(SETTLE.duration).toBe(360);
  });
});

describe("the css properties", () => {
  test("reduced motion makes the springs instant and keeps a 120 ms fade", () => {
    const reduced = motionProperties(true);
    expect(reduced["--snap-ms"]).toBe("0ms");
    expect(reduced["--sheet-ms"]).toBe("0ms");
    expect(reduced["--fade-ms"]).toBe(`${REDUCED_FADE.duration}ms`);
    expect(REDUCED_FADE.duration).toBe(120);
  });

  test("full motion carries the springs' own durations", () => {
    const full = motionProperties(false);
    expect(full["--snap-ms"]).toBe(`${SNAP.duration}ms`);
    expect(full["--sheet"]).toBe(SHEET.easing);
  });
});

describe("the press and the shorthands", () => {
  test("every curve has a shorthand a transition can take, with its duration first", () => {
    const full = motionProperties(false);
    expect(full["--snap-t"]).toBe(`${SNAP.duration}ms ${SNAP.easing}`);
    expect(full["--sheet-t"]).toBe(`${SHEET.duration}ms ${SHEET.easing}`);
    expect(full["--fade-t"]).toBe(`${FADE.duration}ms ${FADE.easing}`);
    expect(full["--press-t"]).toBe(`${PRESS.duration}ms ${PRESS.easing}`);
  });

  test("a press is quicker than a frame budget of two", () => {
    expect(PRESS.duration).toBeLessThanOrEqual(100);
  });

  test("reduced motion presses dim instead of sinking", () => {
    const reduced = motionProperties(true);
    expect(reduced["--press-scale"]).toBe("1");
    expect(reduced["--press-scale-large"]).toBe("1");
    expect(reduced["--press-dim"]).toBe(String(PRESS_DIM));
    expect(reduced["--snap-t"]?.startsWith("0ms ")).toBe(true);
    const full = motionProperties(false);
    expect(full["--press-scale"]).toBe("0.96");
    expect(full["--press-dim"]).toBe("1");
  });
});
