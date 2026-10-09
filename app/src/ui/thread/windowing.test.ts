/* the arithmetic of the progressive mounting (docs/thread.md, budgets): what an unmeasured turn is estimated at, which turns are
   always filled, which to fill next, and how a jump travels */

import { describe, expect, test } from "bun:test";
import type { Say, Step, Turn } from "./model";
import { ALWAYS_LAST, alwaysFilled, around, between, calibrate, estimateHeight, firstUnder, keepAt, nextFills, slotAtTop, travel, widthBucket } from "./windowing";

const T0 = 1_790_000_000_000;
const step = (i: number, over: Partial<Step> = {}): Step => ({ k: "step", id: `p${i}`, callID: `c${i}`, family: "read", tool: "read", status: "completed", object: `f${i}.ts`, result: "", add: 0, del: 0, ms: 100, at: T0 + i * 1000, ...over }) as Step;
const say = (id: string, chars: number): Say => ({ k: "say", id, text: "x".repeat(chars), at: T0, streaming: false });
const turn = (over: Partial<Turn> = {}): Turn => ({ id: "m1", by: "you", prompt: "go", at: T0, end: T0 + 5000, items: [], status: "done", cost: 0, files: new Map(), compacted: false, unknownParts: 0, ...over });

describe("what a turn is estimated at", () => {
  test("grows with its rows, its prose and its answer", () => {
    const bare = estimateHeight(turn(), 390);
    const rows = estimateHeight(turn({ items: [step(1, { family: "shell", tool: "shell" }), step(2, { family: "edit", tool: "edit" })] }), 390);
    const answered = estimateHeight(turn({ answer: say("a", 2000) }), 390);
    expect(rows).toBeGreaterThan(bare + 50);
    expect(answered).toBeGreaterThan(bare + 400);
  });

  test("a narrow measure wraps the same words onto more lines than a wide one", () => {
    const t = turn({ answer: say("a", 3000) });
    expect(estimateHeight(t, 390)).toBeGreaterThan(estimateHeight(t, 1512 - 600));
  });

  test("a bubble clamps at six lines however long the prompt", () => {
    const six = estimateHeight(turn({ prompt: "x".repeat(4000) }), 390);
    const more = estimateHeight(turn({ prompt: "x".repeat(40_000) }), 390);
    expect(more).toBe(six);
  });

  test("a heavy turn carries room for its tape", () => {
    const light = estimateHeight(turn({ items: Array.from({ length: 6 }, (_, i) => step(i)) }), 390);
    const heavy = estimateHeight(turn({ items: Array.from({ length: 7 }, (_, i) => step(i)) }), 390);
    expect(heavy - light).toBeGreaterThan(140);
  });

  test("a compaction is a mark line, not a turn of rows", () => {
    expect(estimateHeight(turn({ by: "compaction", prompt: "" }), 390)).toBeLessThan(80);
  });
});

describe("how far off the estimates ran", () => {
  test("the factor is what was measured over what was estimated", () => {
    expect(calibrate([{ estimated: 100, measured: 150 }, { estimated: 300, measured: 450 }])).toBeCloseTo(1.5);
  });
  test("one odd turn cannot move the thread more than a half or four times", () => {
    expect(calibrate([{ estimated: 100, measured: 9000 }])).toBe(4);
    expect(calibrate([{ estimated: 1000, measured: 10 }])).toBe(0.5);
  });
  test("nothing measured is no correction", () => {
    expect(calibrate([])).toBe(1);
  });
});

describe("widths a height is remembered for", () => {
  test("round to the nearest 8 px, so a scrollbar's width does not make a new measure", () => {
    expect(widthBucket(390)).toBe(392);
    expect(widthBucket(393)).toBe(392);
    expect(widthBucket(399)).toBe(400);
  });
});

describe("the turns that are always filled", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
  test("the newest few", () => {
    expect([...alwaysFilled(ids, undefined, new Set())]).toEqual(ids.slice(10 - ALWAYS_LAST));
  });
  test("the live turn, and any turn with a pending ask, wherever they are", () => {
    expect([...alwaysFilled(ids, "t2", new Set(["t5"]))].sort()).toEqual(["t2", "t5", "t7", "t8", "t9"]);
  });
  test("a thread of fewer turns than that fills them all", () => {
    expect(alwaysFilled(["a", "b"], undefined, new Set()).size).toBe(2);
  });
});

describe("a jump's neighbours", () => {
  const ids = ["a", "b", "c", "d", "e"];
  test("the turn and one either side", () => { expect(around(ids, "c")).toEqual(["b", "c", "d"]); });
  test("at the ends there is one side", () => { expect(around(ids, "a")).toEqual(["a", "b"]); expect(around(ids, "e")).toEqual(["d", "e"]); });
  test("a turn that is not there has none", () => { expect(around(ids, "z")).toEqual([]); });
});

describe("which turns fill next", () => {
  const near = (...spec: Array<[number, boolean]>) => spec.map(([index, filled]) => ({ index, filled }));
  test("the nearest to the view first, at most the budget", () => {
    expect(nextFills(near([1, false], [4, false], [5, false], [6, false]), [5], null, 2)).toEqual([5, 4]);
  });
  test("every turn on screen at once, whatever the budget, and before one beside it", () => {
    expect(nextFills(near([3, false], [4, false], [5, false], [6, false]), [4, 5], null, 1)).toEqual([4, 5]);
  });
  test("nothing is known to be on screen yet: nothing is filled, so the farthest never goes first", () => {
    expect(nextFills(near([1, false], [2, false]), [], null)).toEqual([]);
  });
  test("a filled turn is not filled again", () => {
    expect(nextFills(near([4, true], [5, true], [6, false]), [5], null)).toEqual([6]);
  });
  test("while a finger or a fling holds the view, a turn above the anchor waits and one below it does not", () => {
    expect(nextFills(near([2, false], [3, false], [7, false]), [5], 5)).toEqual([7]);
  });
  test("a turn on screen above the anchor waits too: filling it moves the anchor, and a write to the scroll position ends a fling", () => {
    expect(nextFills(near([4, false], [7, false]), [4, 5], 5)).toEqual([7]);
    expect(nextFills(near([4, false]), [4, 5], 5)).toEqual([]);
  });
  test("a turn on screen below the anchor is filled though the view is held: nothing above it moves", () => {
    expect(nextFills(near([5, false], [6, false]), [4, 5, 6], 4)).toEqual([5, 6]);
  });
  test("once the view is still, the ones above come too", () => {
    expect(nextFills(near([2, false], [3, false], [7, false]), [5], null, 3)).toEqual([3, 7, 2]);
  });
});

describe("the way between a view and where it is going", () => {
  test("the turns from one to the other, with one beyond each end, in order", () => {
    expect(between(10, 6, 3)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(between(10, 3, 6)).toEqual([2, 3, 4, 5, 6, 7]);
  });
  test("it stops at the ends of the thread", () => {
    expect(between(10, 0, 2)).toEqual([0, 1, 2, 3]);
    expect(between(10, 9, 8)).toEqual([7, 8, 9]);
    expect(between(0, 0, 0)).toEqual([]);
  });
});

describe("how a jump travels", () => {
  test("a short one is smooth and a far one is at once", () => {
    expect(travel(1500, 800)).toBe("smooth");
    expect(travel(-1500, 800)).toBe("smooth");
    expect(travel(9000, 800)).toBe("auto");
    expect(travel(-9000, 800)).toBe("auto");
  });
});

describe("the box that holds the reader's place", () => {
  const tops = [0, 400, 1000, 1800, 2500];
  const at = (scrollTop: number, filled: boolean[]) => slotAtTop(tops.length, (i) => tops[i] as number, (i) => filled[i] === true, scrollTop);

  test("is the turn that holds the top of the view", () => {
    expect(at(1100, [true, true, true, true, true])).toBe(2);
    expect(at(1000, [true, true, true, true, true])).toBe(2);
    expect(at(999, [true, true, true, true, true])).toBe(1);
  });
  test("is the first when the view is above them all", () => {
    expect(at(-50, [true, true, true, true, true])).toBe(0);
  });
  test("is never an empty box: the first turn with its rows below it is held instead", () => {
    expect(at(1100, [true, true, false, false, true])).toBe(4);
    expect(at(1100, [true, true, false, true, true])).toBe(3);
  });
  test("is the box itself when no turn below it has rows", () => {
    expect(at(1100, [true, true, false, false, false])).toBe(2);
  });
  test("a turn with rows that is out of the view is not held by: the empty box is, at the top of a thread not filled yet", () => {
    const filledLast = (i: number) => i === 4;
    expect(slotAtTop(tops.length, (i) => tops[i] as number, filledLast, 0, 800)).toBe(0);
    expect(slotAtTop(tops.length, (i) => tops[i] as number, filledLast, 1900, 2600)).toBe(4);
  });
  test("reads the tops of a few turns, not all of them", () => {
    let reads = 0;
    slotAtTop(300, (i) => { reads++; return i * 1000; }, () => true, 150_500);
    expect(reads).toBeLessThanOrEqual(10);
  });
  test("a box inside a turn is the first one still under the top", () => {
    const boxes = [{ top: 0, height: 100 }, { top: 100, height: 300 }, { top: 400, height: 50 }];
    expect(firstUnder(boxes, 50)).toBe(0);
    expect(firstUnder(boxes, 100)).toBe(1);
    expect(firstUnder(boxes, 449)).toBe(2);
    expect(firstUnder(boxes, 450)).toBe(-1);
  });
});

/* the drift the bench found, without a browser: a page of boxes, the view held by an anchor taken before a change and put back after it */
describe("a fill under or above the eye does not move what the reader looks at", () => {
  type Box = { height: number; filled: boolean; rows: number[] };
  const GAP = 16;
  const tops = (boxes: Box[]) => { let y = 0; return boxes.map((b) => { const top = y; y += b.height + GAP; return top; }); };
  /** the top of a row of a turn (the turn's own top for -1), as the page lays it out */
  const rowTop = (boxes: Box[], box: number, row: number): number => (tops(boxes)[box] as number) + (row < 0 ? 0 : (boxes[box] as Box).rows.slice(0, row).reduce((a, h) => a + h, 0));
  /** what is held at this place: the turn with rows at or under the top, and the first row under it, with how far it is from the top */
  const hold = (boxes: Box[], scrollTop: number) => {
    const t = tops(boxes);
    const box = slotAtTop(boxes.length, (i) => t[i] as number, (i) => (boxes[i] as Box).filled, scrollTop);
    const rows = (boxes[box] as Box).rows.map((height, i) => ({ top: rowTop(boxes, box, i), height }));
    const row = firstUnder(rows, scrollTop);
    return { box, row, offset: rowTop(boxes, box, row) - scrollTop };
  };
  /** the view after `change`, put where it keeps the held row where it was */
  const after = (boxes: Box[], scrollTop: number, change: (b: Box[]) => void): number => {
    const held = hold(boxes, scrollTop);
    change(boxes);
    return keepAt(rowTop(boxes, held.box, held.row), held.offset);
  };
  const turn = (rows: number): Box => ({ height: rows * 100, filled: true, rows: Array.from({ length: rows }, () => 100) });
  const empty = (): Box => ({ height: 387, filled: false, rows: [] });

  test("a turn above the eye fills in taller: the view goes down by what it grew", () => {
    const boxes = [empty(), turn(4), turn(5)];
    const at = 900;
    expect(after(boxes, at, (b) => { b[0] = turn(9); })).toBe(at + 9 * 100 - 387);
  });

  test("the empty box at the top of the view fills in shorter: the content below it keeps its place", () => {
    const boxes = [turn(6), empty(), turn(4)];
    const at = (tops(boxes)[1] as number) + 100;
    expect(hold(boxes, at).box).toBe(2);
    expect(after(boxes, at, (b) => { b[1] = { height: 375, filled: true, rows: [375] }; })).toBe(at - 12);
  });

  test("a block above the eye inside the held turn changes height: the view follows it", () => {
    const boxes = [turn(6)];
    const at = 250;
    expect(hold(boxes, at).row).toBe(2);
    expect(after(boxes, at, (b) => { (b[0] as Box).rows[0] = 130; (b[0] as Box).height += 30; })).toBe(at + 30);
  });

  test("nothing above changed: the view stays where it is", () => {
    const boxes = [turn(3), turn(4), empty()];
    expect(after(boxes, 700, () => undefined)).toBe(700);
  });

  test("fifty fills one after another, each held, add up to no drift", () => {
    const boxes: Box[] = Array.from({ length: 60 }, (_, i) => (i < 50 ? empty() : turn(3)));
    let at = (tops(boxes)[55] as number) + 120;
    const held = hold(boxes, at);
    for (let i = 49; i >= 0; i--) at = after(boxes, at, (b) => { b[i] = turn(2 + (i % 5)); });
    expect(rowTop(boxes, held.box, held.row) - at).toBe(held.offset);
  });
});
