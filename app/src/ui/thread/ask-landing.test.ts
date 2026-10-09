import { describe, expect, test } from "bun:test";
import { CLEAR_OF_BAR, askLanding, blockForKey, layoutTop } from "./ask-landing";
import { BOTTOM_SLACK } from "./pin";

type Box = { offsetTop: number; offsetParent: Box | null };
const scroller: Box = { offsetTop: 0, offsetParent: null };
const inside = (offsetTop: number, parent: Box): Box => ({ offsetTop, offsetParent: parent });

describe("where a row is in its scroller", () => {
  test("is the sum of the offsets from the row up to the scroller, and no further", () => {
    const stage: Box = { offsetTop: 500, offsetParent: null };
    const holder: Box = { offsetTop: 7, offsetParent: stage };
    const scrolled: Box = { offsetTop: 60, offsetParent: holder };
    const turn = inside(120, scrolled);
    const row = inside(48, turn);
    // the scroller's own place and everything beyond it say nothing of where a row is inside it
    expect(layoutTop(row, scrolled)).toBe(168);
    expect(layoutTop(turn, scrolled)).toBe(120);
  });

  test("a row with the scroller for its offset parent is where it says", () => {
    expect(layoutTop(inside(5400, scroller), scroller)).toBe(5400);
  });
});

describe("where the stage goes for an ask", () => {
  test("a row far from the end lands just below the bar and the pin lets go of the end", () => {
    const { top, leavesEnd, pad } = askLanding(5471, 60 + CLEAR_OF_BAR, 6443);
    expect(top).toBe(5375);
    expect(leavesEnd).toBe(true);
    expect(pad).toBe(0);
  });

  test("the bar's fade is whole 36 px under its foot, so a row lands there", () => {
    expect(CLEAR_OF_BAR).toBe(36);
    expect(askLanding(1000, 60 + CLEAR_OF_BAR, 9000).top).toBe(904);
  });

  test("a row the end stops short of keeps the pin: it is at the end, and sits lower, whole", () => {
    // the target is past what the scroller can reach: no room is added, the row is shown where the end puts it
    expect(askLanding(6600, 96, 6443)).toEqual({ top: 6504, leavesEnd: false, pad: 0 });
    expect(askLanding(6443 + 96, 96, 6443)).toEqual({ top: 6443, leavesEnd: false, pad: 0 });
  });

  test("a target the slack from the end is far enough that the pin does not take the view to it", () => {
    // pin.ts: the view is at the end when it is less than BOTTOM_SLACK from it
    expect(askLanding(6443 - BOTTOM_SLACK + 96, 96, 6443)).toEqual({ top: 6443 - BOTTOM_SLACK, leavesEnd: true, pad: 0 });
  });

  test("a row that nearly fills the room gets the end room that keeps the pin from dragging it up under the bar", () => {
    // 27 px from the end: the pin would follow the view there, and the row's top would sit 27 px higher than the fade clears
    const near = askLanding(6416 + 96, 96, 6443);
    expect(near).toEqual({ top: 6416, leavesEnd: true, pad: 21 });
    // with that room the target is exactly the slack from the end
    expect(6443 + near.pad - near.top).toBe(BOTTOM_SLACK);
    expect(askLanding(6443 - BOTTOM_SLACK + 1 + 96, 96, 6443).pad).toBe(1);
    expect(askLanding(6443 + 96, 96, 6443).pad).toBe(0);
  });
});

describe("the question a number key answers in", () => {
  const block = (focused: boolean, answered: boolean) => ({ focused, answered });

  test("the one holding focus", () => {
    expect(blockForKey([block(false, true), block(true, false), block(false, false)])).toBe(1);
  });

  test("with focus on the card alone, the first with no answer yet", () => {
    expect(blockForKey([block(false, true), block(false, false), block(false, false)])).toBe(1);
  });

  test("with every question answered, the first", () => {
    expect(blockForKey([block(false, true), block(false, true)])).toBe(0);
  });

  test("a card with a single block answers in it", () => {
    expect(blockForKey([block(false, false)])).toBe(0);
  });
});
