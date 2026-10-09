/* the width the stylesheet reads from the scroller (measure.ts): the edges are the container queries it replaced, inclusive */

import { describe, expect, test } from "bun:test";
import { CLOCK_FROM, TIGHT_TO, measureOf } from "./measure";

describe("the scroller's width, said to the stylesheet", () => {
  test("the clock hangs in the margin from 720 px of content box and not a pixel before", () => {
    expect(measureOf(CLOCK_FROM - 1).clock).toBe(false);
    expect(measureOf(CLOCK_FROM).clock).toBe(true);
  });

  test("the stuck tape drops its scale up to and including 600 px", () => {
    expect(measureOf(TIGHT_TO).tight).toBe(true);
    expect(measureOf(TIGHT_TO + 1).tight).toBe(false);
  });

  test("a phone is tight with no clock, an ipad has the clock, and nothing is both", () => {
    expect(measureOf(342)).toEqual({ clock: false, tight: true });
    expect(measureOf(756)).toEqual({ clock: true, tight: false });
    expect(measureOf(660)).toEqual({ clock: false, tight: false });
  });
});
