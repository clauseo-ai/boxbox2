/* the view the reader reads in: the scroller less the dock that floats over its foot (docs/thread.md, the dock). the transcript
   runs on under the composer's glass to the stage's foot, as the ios app's does, so the scroller's box is taller than what can be
   read: the dock's own height is a spacer under the transcript (`--dock`, `.stage-dock-room`), and every question of the scroll
   law (is the end in view, how far is it, how tall is the view, where does the view stop) is asked of the box above the dock.
   the stage reads only this, never the scroller's clientHeight or scrollHeight, so "at the end" still means the last row stands
   clear above the glass. the farthest the view goes is the same either way: the dock is taken off both heights */

import type { Scroller } from "./pin";

/** the scroller as the reader sees it: `dock` is the height of what floats over its foot, px */
export function viewOf(scroller: () => HTMLElement, dock: () => number): Scroller {
  return {
    get scrollTop() { return scroller().scrollTop; },
    set scrollTop(v: number) { scroller().scrollTop = v; },
    get scrollHeight() { return Math.max(0, scroller().scrollHeight - dock()); },
    get clientHeight() { return Math.max(0, scroller().clientHeight - dock()); },
  };
}
