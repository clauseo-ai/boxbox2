/* the foot room (foot.ts): what a playing turn gives back under the top of the view is kept under the end, growth fills it first, and it
   goes when the end leaves the view, when what the reader saw at the top went, or when keeping it would fill the view; it never takes
   more than half of it */

import { describe, expect, test } from "bun:test";
import { type Boxes, FootRoom, MOST_OF_VIEW, roseSince, seenAt } from "./foot";

const VIEW = 800;

/** a foot whose end the stage has seen on screen */
const shown = (): FootRoom => { const foot = new FootRoom(); foot.came(); return foot; };

describe("the foot room", () => {
  test("a run folding whole while the turn plays leaves its room under the end, and the words that follow fill it", () => {
    const foot = shown();
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
    const foot = shown();
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

  test("nothing is kept until the stage has seen the end on screen: a thread opening at its top gives back nothing that is the reader's", () => {
    const foot = new FootRoom();
    // the stage opened at the top of a long working thread, and the window filled the newest turns shorter than its guesses
    foot.read(21_000, true, VIEW);
    expect(foot.read(20_600, true, VIEW)).toBe(0);
    // it lands at the end, which is on screen from now on: then what is given back under the top of the view is kept
    foot.came();
    expect(foot.read(20_600, true, VIEW)).toBe(0);
    expect(foot.read(20_400, true, VIEW)).toBe(200);
  });

  test("off the screen the end keeps nothing, and its room goes; back on it keeps again", () => {
    const foot = shown();
    foot.read(2000, true, VIEW);
    expect(foot.read(1700, true, VIEW)).toBe(300);
    expect(foot.letGo(1700)).toBe(0);
    expect(foot.room).toBe(0);
    expect(foot.read(1500, true, VIEW)).toBe(0);
    foot.came();
    expect(foot.read(1400, true, VIEW)).toBe(100);
  });

  test("what is given back above the top of the view is no room of the reader's: the end is followed and nothing they see moves", () => {
    const foot = shown();
    foot.read(2000, true, VIEW);
    // a turn above the view filled 250 px shorter than its guess: everything in view rose with the end
    expect(foot.read(1750, true, VIEW, 250)).toBe(0);
    // a fold under the top of the view (120 px) with a fill above it (80 px): only the fold's room is kept
    expect(foot.read(1550, true, VIEW, 80)).toBe(120);
    // what grows above the view, followed, leaves the room as it was
    expect(foot.read(1650, true, VIEW, -100)).toBe(120);
  });

  test("what the reader saw at the top that went leaves nothing to keep still: the room goes and the end is followed", () => {
    const foot = shown();
    foot.read(2000, true, VIEW);
    expect(foot.read(1900, true, VIEW)).toBe(100);
    // the read's open body that filled the view closed to its opening lines
    expect(foot.read(1300, true, VIEW, null)).toBe(0);
    expect(foot.room).toBe(0);
    // and the end there is the new low mark
    expect(foot.read(1250, true, VIEW)).toBe(50);
  });

  test("the view is never left to the room: at most half of it is kept, and more than the view is content that went", () => {
    const foot = shown();
    foot.read(9000, true, VIEW);
    expect(foot.read(8100, true, VIEW)).toBe(0);
    expect(foot.room).toBe(0);
    // and the low mark is where the end is now, so nothing of it is kept later either
    expect(foot.read(8060, true, VIEW)).toBe(40);
    // a fold of almost a whole view keeps half the view: what was above it comes down to where half the view still shows the thread
    expect(foot.read(7320, true, VIEW)).toBe(VIEW * MOST_OF_VIEW);
    // and growth fills what was kept
    expect(foot.read(7520, true, VIEW)).toBe(VIEW * MOST_OF_VIEW - 200);
  });

  test("the settle's own room is kept as the foot's, and growth fills it", () => {
    const foot = shown();
    foot.keep(1500, 120);
    expect(foot.read(1500, false, VIEW)).toBe(120);
    expect(foot.read(1580, false, VIEW)).toBe(40);
  });

  test("a row the reader closes gives back room that is theirs: nothing more is kept for it", () => {
    const foot = shown();
    foot.read(2000, true, VIEW);
    foot.read(1900, true, VIEW);
    foot.moved(1600);
    expect(foot.read(1600, true, VIEW)).toBe(100);
  });
});

/** a box as the tests lay it out: where it begins, how tall it is, its children, and whether it is on the page */
type Box = { top: number; height: number; kids: Box[]; here: boolean };
const box = (top: number, height: number, kids: Box[] = []): Box => ({ top, height, kids, here: true });
const boxes: Boxes<Box> = { kids: (b) => b.kids, top: (b) => b.top, height: (b) => b.height, here: (b) => b.here && b.height > 0 };

describe("what the reader sees at the top of the view", () => {
  /* a transcript: the title, an older turn, and the live turn with a said row, the run's open read (a body of 700 px) and its line */
  const layout = () => {
    const body = box(1000, 700);
    const read = box(960, 740, [box(960, 40), body]);
    const said = box(900, 60);
    const live = box(880, 840, [said, read]);
    const root = box(0, 1720, [box(0, 300), box(316, 548), live]);
    return { root, live, said, read, body };
  };

  test("the chain runs from the turn down to the deepest box under the line, and ends at the first box that begins in view", () => {
    const { root, live, read, body } = layout();
    const seen = seenAt(root, 1100, boxes);
    expect(seen.chain.map((c) => c.el)).toEqual([live, read, body]);
    // a line in the gap above a box: that box is the first the reader sees whole
    const atSaid = seenAt(root, 890, boxes);
    expect(atSaid.chain.map((c) => c.top)).toEqual([880, 900]);
    // past the transcript (the view's top in the room kept under it): nothing
    expect(seenAt(root, 1800, boxes).chain).toEqual([]);
  });

  test("a fold under the box at the top moves nothing the reader sees; a fill above it moves everything by what it gave back", () => {
    const { root, live, said } = layout();
    const seen = seenAt(root, 890, boxes);
    // the read below the said row closes: the said row is where it was
    expect(roseSince(seen, boxes)).toBe(0);
    // the older turn above filled 120 px shorter than its guess: the live turn and its rows rose by that
    live.top -= 120;
    said.top -= 120;
    expect(roseSince(seen, boxes)).toBe(120);
  });

  test("a box that began above the line and lost some of what the reader saw leaves nothing to keep still", () => {
    const { root, read, body } = layout();
    const seen = seenAt(root, 1100, boxes);
    // the read's body clamps to its opening lines
    body.height = 120;
    read.height = 160;
    expect(roseSince(seen, boxes)).toBeNull();
    // gone from the page altogether, its row says the same
    body.here = false;
    expect(roseSince(seen, boxes)).toBeNull();
  });

  test("a box that is still whole under the line says how far it moved, and a box the page made again hands over to its parent", () => {
    const { root, read, body } = layout();
    const seen = seenAt(root, 1100, boxes);
    body.height = 760;
    read.height = 800;
    expect(roseSince(seen, boxes)).toBe(0);
    body.here = false;
    read.top -= 30;
    expect(roseSince(seen, boxes)).toBe(30);
    // before anything was read there is nothing to say, and a view in the room says nothing is seen
    expect(roseSince(null, boxes)).toBe(0);
    expect(roseSince(seenAt(root, 1800, boxes), boxes)).toBeNull();
  });
});
