/* where the stage goes for an ask, and which of its questions a number key answers. pure, so it is tested without a
   browser: the stage (stage.tsx, goToAsk) and the card (thread.tsx, pressOption) read the dom and hand these the numbers. */

import { BOTTOM_SLACK } from "./pin";

/** how far under the bar's foot a row brought to the top lands: the bar's fade is whole 36 px below its foot (stage.css, the dissolve) */
export const CLEAR_OF_BAR = 36;

/** what a box says of where it is laid out: an html element, or what stands in for one */
export type Offsets = { offsetTop: number; offsetParent: unknown };

/** where an element's top is in its scroller's content, as laid out. the layer a thread opens in arrives drawn smaller and each
    of its parts moves on its own, so rects read then are not in the px the scroller counts in; offsets are */
export function layoutTop(el: Offsets, within: object): number {
  let top = 0;
  for (let at: Offsets | null = el; at && at !== within; at = at.offsetParent as Offsets | null) top += at.offsetTop;
  return top;
}

/** the scroll that puts a row's top `below` px under the scroller's top, whether that leaves the end, and the end room it needs:
    `reach` is the farthest the scroller can go. a row near the end cannot reach that high and sits lower, whole, where the end stops
    it, so the end's pin keeps following. a target within BOTTOM_SLACK of the end (the row nearly fills the room under the bar) is
    where the pin takes a view to be at the end and follows it there, dragging the row up under the bar's fade by what is left: the end
    gains `pad` px, which keeps the target the slack away, below the view. a target at the end itself needs none: the row is where it was
    put. any other target leaves the end, and the pin lets go of it */
export function askLanding(rowTop: number, below: number, reach: number): { top: number; leavesEnd: boolean; pad: number } {
  const top = rowTop - below;
  const pad = top > reach - BOTTOM_SLACK && top < reach ? Math.ceil(top + BOTTOM_SLACK - reach) : 0;
  return { top, leavesEnd: top <= reach - BOTTOM_SLACK || pad > 0, pad };
}

/** the question block a number key answers in: the one holding focus, else the first with no answer yet, else the first */
export function blockForKey(blocks: ReadonlyArray<{ focused: boolean; answered: boolean }>): number {
  const focused = blocks.findIndex((b) => b.focused);
  if (focused >= 0) return focused;
  const open = blocks.findIndex((b) => !b.answered);
  return open >= 0 ? open : 0;
}
