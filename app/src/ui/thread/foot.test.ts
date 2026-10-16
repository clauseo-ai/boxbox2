/* the foot room (foot.ts): what a playing turn gives back above the end is kept under it, growth fills it first, and it goes when the
   end leaves the view or when keeping it would fill the view */

import { describe, expect, test } from "bun:test";
import { FootRoom } from "./foot";

const VIEW = 800;

describe("the foot room", () => {
  test("a run folding whole while the turn plays leaves its room under the end, and the words that follow fill it", () => {
    const foot = new FootRoom();
    expect(foot.read(2000, true, VIEW)).toBe(0);
    // the live row's open body (300 px) closes into the group's line
    expect(foot.read(1700, true, VIEW)).toBe(300);
    // the words rise into the room: it shrinks as they grow, and nothing above moves
    expect(foot.read(1850, true, VIEW)).toBe(150);
    expect(foot.read(2100, true, VIEW)).toBe(0);
    // once filled, the end is the new low mark: a later fold keeps from there
    expect(foot.read(2000, true, VIEW)).toBe(100);
  });

  test("with no turn playing nothing is kept, but the change that ends the play is", () => {
    const foot = new FootRoom();
    foot.read(2000, false, VIEW);
    expect(foot.read(1800, false, VIEW)).toBe(0);
    foot.read(2000, true, VIEW);
    // the settle: the turn has stopped playing, and its last fold is still kept
    expect(foot.read(1900, false, VIEW)).toBe(100);
    // and kept room stays until growth fills it
    expect(foot.read(1950, false, VIEW)).toBe(50);
    expect(foot.read(2000, false, VIEW)).toBe(0);
    expect(foot.read(1900, false, VIEW)).toBe(0);
  });

  test("off the screen the end keeps nothing, and its room goes; back on it keeps again", () => {
    const foot = new FootRoom();
    foot.read(2000, true, VIEW);
    expect(foot.read(1700, true, VIEW)).toBe(300);
    expect(foot.letGo(1700)).toBe(0);
    expect(foot.room).toBe(0);
    expect(foot.read(1500, true, VIEW)).toBe(0);
    foot.came();
    expect(foot.read(1400, true, VIEW)).toBe(100);
  });

  test("more than the view is content that went out of sight, not room to keep; up to the view it is kept", () => {
    const foot = new FootRoom();
    foot.read(9000, true, VIEW);
    expect(foot.read(8100, true, VIEW)).toBe(0);
    expect(foot.room).toBe(0);
    // and the low mark is where the end is now, so nothing of it is kept later either
    expect(foot.read(8060, true, VIEW)).toBe(40);
    // a fold of almost a whole view (an open run filling a phone's screen) is kept whole
    expect(foot.read(7320, true, VIEW)).toBe(780);
  });

  test("the settle's own room is kept as the foot's, and growth fills it", () => {
    const foot = new FootRoom();
    foot.keep(1500, 120);
    expect(foot.read(1500, false, VIEW)).toBe(120);
    expect(foot.read(1580, false, VIEW)).toBe(40);
  });

  test("a row the reader closes gives back room that is theirs: nothing more is kept for it", () => {
    const foot = new FootRoom();
    foot.read(2000, true, VIEW);
    foot.read(1900, true, VIEW);
    foot.moved(1600);
    expect(foot.read(1600, true, VIEW)).toBe(100);
  });

});
