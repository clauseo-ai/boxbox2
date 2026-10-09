/* the deck's edge swipe back, for the screens that cover their parent on
   the phone: the machines, settings and the terminal (a thread's swipe is
   home's own, ui/home/home.tsx). it feels the same as home's: the surface
   follows the finger 1:1 by transform, can be abandoned halfway and settles
   back on the snap spring, and lets go past 28% of the width or on a flick
   (design.md, motion law). letting go slides the surface away on the sheet
   spring, then the route goes to its parent, which arrives with the
   content fade. */

import { play } from "../motion/animate";
import { SHEET, SNAP } from "../motion/springs";

/** the share of the width, or the speed in px per ms, past which letting go goes back (home's own numbers) */
const LET_GO_PROGRESS = 0.28;
const LET_GO_VELOCITY = 0.55;
/** a press moves this far before it is a drag rather than a tap */
const SLOP_PX = 4;

type Drag = { pointer: number; start: number; last: number; lastAt: number; velocity: number; moved: boolean; progress: number; surface: HTMLElement };

/** wires an edge element: `surface` is what moves (read when the press starts), `back` goes to the parent and
    answers false when there was no back after all. returns the unwiring */
export function edgeSwipe(edge: HTMLElement, surface: () => HTMLElement | null, back: () => boolean): () => void {
  let drag: Drag | null = null;

  const down = (event: PointerEvent) => {
    const el = surface();
    if (drag || !el || event.button > 0) return;
    drag = { pointer: event.pointerId, start: event.clientX, last: event.clientX, lastAt: event.timeStamp, velocity: 0, moved: false, progress: 0, surface: el };
    edge.setPointerCapture(event.pointerId);
  };

  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.velocity = (event.clientX - drag.last) / Math.max(1, event.timeStamp - drag.lastAt);
    drag.last = event.clientX;
    drag.lastAt = event.timeStamp;
    const distance = Math.max(0, event.clientX - drag.start);
    if (!drag.moved && distance > SLOP_PX) drag.moved = true;
    if (!drag.moved) return;
    drag.progress = Math.min(1, distance / innerWidth);
    drag.surface.style.transform = `translateX(${distance}px)`;
    drag.surface.style.opacity = String(1 - drag.progress * 0.5);
  };

  const up = (event: PointerEvent) => {
    const was = drag;
    if (!was || event.pointerId !== was.pointer) return;
    drag = null;
    if (!was.moved) return;
    const el = was.surface;
    const from = { transform: el.style.transform, opacity: el.style.opacity };
    el.style.transform = "";
    el.style.opacity = "";
    const letGo = event.type === "pointerup" && (was.progress > LET_GO_PROGRESS || was.velocity > LET_GO_VELOCITY);
    if (!letGo) {
      play(el, [from, { transform: "none", opacity: 1 }], SNAP);
      return;
    }
    const away = play(el, [from, { transform: "translateX(100%)", opacity: 0 }], SHEET, { fill: "forwards" });
    const finish = () => {
      // the surface may stay mounted (settings back to the machines swaps what is inside it), so its end state goes
      if (!back()) play(el, [{ transform: "translateX(100%)", opacity: 0 }, { transform: "none", opacity: 1 }], SNAP);
      away?.cancel();
    };
    if (away) void away.finished.then(finish, finish);
    else finish();
  };

  edge.addEventListener("pointerdown", down);
  edge.addEventListener("pointermove", move);
  edge.addEventListener("pointerup", up);
  edge.addEventListener("pointercancel", up);
  return () => {
    edge.removeEventListener("pointerdown", down);
    edge.removeEventListener("pointermove", move);
    edge.removeEventListener("pointerup", up);
    edge.removeEventListener("pointercancel", up);
  };
}
