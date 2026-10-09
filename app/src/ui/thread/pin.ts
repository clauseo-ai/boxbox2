/* whether the stage follows the end of the transcript (docs/thread.md, the scroll law). being pinned is a latch: only the
   reader's own scroll lets go of it, and nothing else does, however the geometry moves under it. a scroll event the reader
   did not make says nothing about whether they left. one that lands in the frames after the stage wrote the end or after the
   transcript or the scroller changed size is the browser clamping or snapping, and while pinned it is answered by putting
   the end back; any other (find in page, a focus moving into a row, voiceover's scroll, a key to a focused control) is read
   for where it left the view, as it always was. "in the frames after" is counted in frames, not milliseconds: a page that
   janks runs its frames late, and an event 100 ms after a write is still the next frame's. a flag set from whatever the last
   scroll event measured was the stage's old way, and one event that landed while the view was off the end kept it from
   following for good (docs/gotchas.md, the pin). */

import { type Accessor, createSignal } from "solid-js";

/** how close to the end still counts as at the end */
export const BOTTOM_SLACK = 48;
/** a scroll within this long of the reader's last input, or of their finger leaving the glass, is theirs: a fling goes on
    after the finger has left, and a smooth scroll they asked for runs a few hundred ms */
export const READER_MS = 900;
/** a scroll event in the first this many frames after the stage wrote the end, or after a size change, is the browser's answer
    to it (the event of a write comes in the very next frame, before that frame's callbacks) */
export const ECHO_FRAMES = 2;
/** a scroll event at the place the stage wrote, give or take this much, is the echo of that write and tells nothing; one at a
    place the view was left from is a restore of it (below) */
const ECHO_PX = 1;
/** webkit restores the place the view was before a write, some frames late, when the scroller's own box changed under the write
    (the dock took a card): the places the stage left are remembered this long, and an event landing on one is that restore */
const LEFT_MS = 1500;
const LEFT_KEPT = 6;

/** the part of a scroller the pin reads and writes */
export type Scroller = { scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number };

/** how far the view is above the end of the content, px */
export const gapOf = (s: Scroller): number => s.scrollHeight - s.scrollTop - s.clientHeight;

/** the room a settle leaves under the end so the view stays where it was (the scroller's `--hold`, its end padding): how far the foot of
    the view (`top` plus `view`) is past where the content ends now (`end` plus its own end padding `pad`). the end is only ever a row
    or two shorter, so room that would fill the view with the padding is not room to keep but content that is gone (the list was made
    again between the reading and the settle): none, and the view goes to the new end. it matters that it is bounded: padding is part of
    the scroller's box and a flex item is never smaller than its padding, so a hold of 100,000 px made the scroller 100,000 px tall in
    a 917 px stage with the view in the padding, blank, and nothing that could give it up (the release reads the scroller's height,
    which the padding was) */
export function endRoom(top: number, view: number, end: number, pad: number): number {
  const room = Math.ceil(top + view - (end + pad));
  return room > 0 && pad + room < view ? room : 0;
}

export type Pin = {
  pinned: Accessor<boolean>;
  /** the reader's hand is on the scroller (wheel, pointer, key), or they asked for a scroll the stage makes for them */
  input(): void;
  /** a finger is down: every scroll until it is lifted is theirs, however long it rests first */
  touch(down: boolean): void;
  /** the transcript or the scroller changed size */
  resized(): void;
  /** a scroll event arrived: whether it was the reader's (it then says where they are) */
  scrolled(): boolean;
  /** puts the end under the view, if pinned. the stage's one write for it */
  follow(): void;
  /** reads where the view is now: for a change the reader made, which is theirs to decide (a row opened at the end) */
  derive(): void;
  /** pinned, and at the end now: the reader sent a message, or asked for the end */
  pin(): void;
  /** the stage took the reader somewhere that is not the end (a link, a turn, a step), so it follows no more */
  leave(): void;
  /** the stage keeps what a reader not at the end is looking at where it was, by moving the view to `top` (a box above it filled
      in or changed height). the stage's own write, the one owner of the position with `follow`: its echo is neither the reader's
      nor a change, and a pinned view is not moved by it (the end is followed instead) */
  place(top: number): void;
};

export function createPin(scroller: Scroller, now: () => number = () => performance.now(), frame: (run: () => void) => void = (run) => { requestAnimationFrame(run); }): Pin {
  const [pinned, setPinned] = createSignal(true);
  let readerAt = Number.NEGATIVE_INFINITY;
  let touching = false;
  /** frames since the stage last wrote the end, and since the last size change; counted by the frames themselves */
  let sinceWrite = Number.POSITIVE_INFINITY;
  let sinceResize = Number.POSITIVE_INFINITY;
  let counting = false;
  /** where the stage's last write left the view, until anything else moves it */
  let wrote: number | null = null;
  /** where the view was just before each of the stage's recent writes, and when */
  let left: Array<{ top: number; at: number }> = [];
  const count = () => {
    sinceWrite++;
    sinceResize++;
    if (sinceWrite < ECHO_FRAMES || sinceResize < ECHO_FRAMES) frame(count);
    else counting = false;
  };
  const mark = (what: "write" | "resize") => {
    if (what === "write") sinceWrite = 0; else sinceResize = 0;
    if (!counting) { counting = true; frame(count); }
  };
  const atEnd = () => gapOf(scroller) < BOTTOM_SLACK;
  const toEnd = () => {
    if (gapOf(scroller) <= 0.5) return;
    left = [...left.filter((p) => now() - p.at < LEFT_MS), { top: scroller.scrollTop, at: now() }].slice(-LEFT_KEPT);
    scroller.scrollTop = scroller.scrollHeight;
    mark("write");
    wrote = scroller.scrollTop;
  };
  return {
    pinned,
    input() { readerAt = now(); },
    touch(down) {
      touching = down;
      if (!down) readerAt = now();
    },
    resized() { mark("resize"); },
    scrolled() {
      const at = now();
      /* the echo of the stage's own write is neither the reader's nor a change: if it refreshed their window, streaming that
         writes every few frames would keep the window open for good, and a snap a minute after their last touch would pass
         as theirs */
      if (!touching && wrote !== null && Math.abs(scroller.scrollTop - wrote) <= ECHO_PX) return false;
      wrote = null;
      /* a restore of the place the view was left from is answered before the reader's window is asked: any input in the last 900 ms
         (a tap on send, a wheel) would else make it theirs. a finger on the glass is theirs whatever lands, and a reader who has gone
         up is not pinned, so what they scroll through is never put back */
      const restored = !touching && pinned() && left.some((p) => at - p.at < LEFT_MS && Math.abs(scroller.scrollTop - p.top) <= ECHO_PX);
      if (restored) { toEnd(); return false; }
      if (touching || at - readerAt < READER_MS) {
        if (!touching) readerAt = at;
        setPinned(atEnd());
        return true;
      }
      if (pinned() && (sinceWrite < ECHO_FRAMES || sinceResize < ECHO_FRAMES)) toEnd();
      else setPinned(atEnd());
      return false;
    },
    follow() { if (pinned()) toEnd(); },
    derive() { setPinned(atEnd()); },
    pin() { setPinned(true); toEnd(); },
    leave() { setPinned(false); wrote = null; left = []; },
    place(top) {
      if (pinned() || Math.abs(scroller.scrollTop - top) < 0.5) return;
      /* a whole px, rounded to the nearest here: a browser given a fraction may cut it (webkit's does), and the view would be up to a pixel
         off its place by that, on top of the half it is off by whichever way it is rounded */
      scroller.scrollTop = Math.round(top);
      wrote = scroller.scrollTop;
    },
  };
}
