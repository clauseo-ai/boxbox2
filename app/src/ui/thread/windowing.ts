/* the log is mounted progressively (docs/thread.md, budgets): an older turn is an empty box of a remembered or estimated height and
   is filled in when it comes near the view; once filled it stays filled, so nothing in it (focus, selection, an open row, a code
   block's scroll, typed words) is ever lost to the window. this file is the arithmetic of that: what a turn is estimated to
   measure, which turns are always there, which to fill next, and how a jump travels. pure; no dom. */

import { type Turn } from "./model";
import { rowsOf } from "./rows";

/** the newest turns are always filled: the end of the thread is where the reader lands, and a reply arrives */
export const ALWAYS_LAST = 3;
/** a turn this many screens from the view, above or below, is filled in (the margin the observer watches) */
export const REACH_SCREENS = 2.5;
/** most turns filled in one frame by the loop that fills them, so a thread painting its way up never holds a frame long */
export const FILL_PER_FRAME = 1;
/** the view is still after this long without a scroll event, and with no finger on the glass: fills above it wait for that */
export const SETTLE_MS = 140;
/** a jump farther than this many screens lands at once; nearer, it is the smooth scroll the law asks for */
export const SMOOTH_SCREENS = 2.5;

/** the width a remembered height is for: a turn's height is a function of the measure it wraps in, to the nearest 8 px */
export const widthBucket = (width: number): number => Math.round(width / 8) * 8;

/* ---------- what a turn that has never been measured is estimated at ---------- */

const GUTTERS = 40;
const SAID_PX = 7.8;
const ANSWER_PX = 8.4;
const LINE_SAID = 24;
const LINE_ANSWER = 27;
const ROW = 32;
const BUBBLE = 44;
const TURN_GAP = 16;
/** a folded step group: its line and the strip under it (thread.css, `.row.group`, `.group-band`) */
const GROUP = 60;

const lines = (chars: number, perLine: number): number => Math.max(1, Math.ceil(chars / Math.max(10, perLine)));

/** about how tall a turn is at a measure `width` px wide, from what it holds: its prompt (a bubble clamps at six lines), its rows
    (a said row by its words, each run of steps between them one folded group: groups.ts), its answer. a first guess, which `calibrate` scales by what the turns already measured
    came to; it only has to be near, since a turn that fills in is measured and the view is kept where it was */
export function estimateHeight(turn: Turn, width: number): number {
  const measure = Math.max(200, width - GUTTERS);
  const said = measure / SAID_PX, answer = measure / ANSWER_PX;
  let px = 0;
  if (turn.by === "you" || turn.by === "queued" || turn.by === "steer" || turn.by === "brief") px += BUBBLE + Math.min(6, lines(turn.prompt.length, said)) * 22;
  else if (turn.by === "mail") px += 96 + Math.min(8, lines(turn.prompt.length, said)) * LINE_SAID;
  else px += 40;
  if (turn.by !== "compaction") {
    let run = false;
    for (const row of rowsOf(turn.items)) {
      if (row.k === "say") { px += lines(row.say.text.length, said) * LINE_SAID + 12; run = false; }
      else if (!run) { px += GROUP; run = true; }
    }
    if (turn.answer) px += lines(turn.answer.text.length, answer) * LINE_ANSWER + 56;
    if (turn.files.size) px += ROW;
    if (turn.status === "aborted" || turn.status === "failed") px += ROW;
  }
  return Math.round(px + TURN_GAP);
}

/** how much taller or shorter the turns measured so far came out than they were estimated, as the factor to scale an estimate by:
    held between a half and four times, so one odd turn does not move every box in the thread */
export function calibrate(samples: ReadonlyArray<{ estimated: number; measured: number }>): number {
  let estimated = 0, measured = 0;
  for (const s of samples) { estimated += s.estimated; measured += s.measured; }
  return estimated > 0 ? Math.min(4, Math.max(0.5, measured / estimated)) : 1;
}

/* ---------- which turns are filled ---------- */

/** the turns that are filled whatever the view does: the newest few, the live turn, and any turn that holds a pending ask */
export function alwaysFilled(ids: readonly string[], live: string | undefined, asking: ReadonlySet<string>, last = ALWAYS_LAST): Set<string> {
  const out = new Set(ids.slice(Math.max(0, ids.length - last)));
  if (live !== undefined) out.add(live);
  for (const id of ids) if (asking.has(id)) out.add(id);
  return out;
}

/** a turn and the `n` before and after it, in order: what a jump to it fills, so what it lands beside is there too */
export function around(ids: readonly string[], id: string, n = 1): string[] {
  const at = ids.indexOf(id);
  return at < 0 ? [] : ids.slice(Math.max(0, at - n), at + n + 1);
}

/** a turn the observer says is near the view, as the loop sees it */
export type Near = { index: number; filled: boolean };

/** the turns to fill in this frame, nearest the view first, at most `budget`. `seeing` are the indexes of the turns on screen. a turn on
    screen is filled whatever the budget (it is an empty box the reader is looking at). `holdAbove` is the index of the turn the view is held by
    while a finger is down, a fling runs or the page is moving the view itself (null when it is not): a turn above it waits, on screen or not,
    since filling it moves the anchor and putting the anchor back is a write to the scroll position, which ends a fling and a smooth scroll; a
    turn below it moves nothing above itself and never waits */
export function nextFills(near: readonly Near[], seeing: readonly number[], holdAbove: number | null, budget = FILL_PER_FRAME): number[] {
  // the observers report in their own time: with nothing known to be on screen there is no nearest, and the farthest must not go first
  if (!seeing.length) return [];
  const on = new Set(seeing);
  const distance = (i: number): number => Math.min(...seeing.map((s) => Math.abs(s - i)));
  return near
    .filter((n) => !n.filled && (holdAbove === null || n.index > holdAbove))
    .sort((a, b) => Number(on.has(b.index)) - Number(on.has(a.index)) || distance(a.index) - distance(b.index) || a.index - b.index)
    .slice(0, Math.max(on.size, budget))
    .map((n) => n.index);
}

/** the turns a move between two turns (indexes among `count`) goes past, and one beyond each end: what it fills before it starts, so the
    heights it lands by are real and nothing fills under it */
export function between(count: number, from: number, to: number): number[] {
  if (count <= 0) return [];
  const lo = Math.max(0, Math.min(from, to) - 1);
  const hi = Math.min(count - 1, Math.max(from, to) + 1);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** how a jump of `distance` px travels in a view `view` px tall: smooth when it is short, else at once, since a smooth scroll
    across a hundred turns would fly past boxes that are not filled */
export const travel = (distance: number, view: number): "smooth" | "auto" => (Math.abs(distance) <= SMOOTH_SCREENS * view ? "smooth" : "auto");

/* ---------- the reader's place ---------- */

/** the turn that holds the top of the view, as an index among `count` turns in order (`topOf` reads one's top in the scroller's content,
    which costs a layout read, so it is asked of a handful by bisection): the last whose top is at or above it, the first when the view
    is above them all. an empty box holds nothing the reader looks at, and its own fill changes its height under the top of the view, so
    the first turn with its rows at or below that one is held instead, when it is on screen (the box itself, when none is: `bottom` is the foot of the view) */
export function slotAtTop(count: number, topOf: (i: number) => number, filled: (i: number) => boolean, scrollTop: number, bottom = Number.POSITIVE_INFINITY): number {
  if (count <= 0) return -1;
  let lo = 0, hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (topOf(mid) <= scrollTop + 0.5) lo = mid; else hi = mid - 1;
  }
  let at = lo;
  while (at < count - 1 && !filled(at)) {
    at++;
    // a turn with rows that is not on screen is no place to hold the view by: the empty box itself is (the top of a thread whose first turns are not filled yet)
    if (topOf(at) > bottom) return lo;
  }
  return filled(at) ? at : lo;
}

/** the first box that is still under the top of the view, of boxes in order with their tops and heights: what is held inside a turn,
    so a block above the eye that changes height inside the turn is put back too. -1 when none is */
export function firstUnder(boxes: ReadonlyArray<{ top: number; height: number }>, scrollTop: number): number {
  return boxes.findIndex((b) => b.top + b.height > scrollTop + 0.5);
}

/** where the view goes to keep a held box where it was on screen: its top now, less how far it was from the top of the view */
export const keepAt = (topNow: number, offset: number): number => topNow - offset;
