/* the thread's motion helpers. the numbers are the law's (motion/springs.ts), the same two springs as home and the
   composer; this file only adds what a long transcript needs: a flip that measures what is near the view and nothing
   else, and a row rising into place. */

import { installMotionProperties, play, prefersReducedMotion } from "../../motion/animate";
import { SNAP } from "../../motion/springs";

export { SNAP };

/** writes the law's curves onto the root (the stage and the thread mount it; home and the shell already have) */
export function installMotion(): void {
  installMotionProperties();
}

/** the device's choice in settings, or the system's when it left it there (motion/animate.ts) */
export const reducedMotion = (): boolean => prefersReducedMotion();

const FLIPPED = ".row, .you, .answer, .turn-mark, .report, .sumcard, .fl, .fdiff, .gap";

/** measures what is near the view, applies the change, and slides everything that moved from where it was;
    the revealed element, if any, opens under a clip. nothing reads layout inside a frame loop. */
export function flip(root: HTMLElement, mutate: () => void, reveal?: HTMLElement | null): void {
  if (reducedMotion()) {
    mutate();
    return;
  }
  const top = root.getBoundingClientRect().top;
  const h = root.clientHeight || innerHeight;
  const els = [...root.querySelectorAll<HTMLElement>(FLIPPED)].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.bottom > top - h && r.top < top + 2 * h;
  });
  const before = new Map(els.map((e) => [e, e.getBoundingClientRect().top]));
  mutate();
  for (const e of els) {
    if (!e.isConnected) continue;
    const was = before.get(e);
    if (was === undefined) continue;
    const dy = was - e.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) play(e, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], SNAP);
  }
  if (reveal) play(reveal, [{ clipPath: "inset(0 0 100% 0)", opacity: 0 }, { clipPath: "inset(0 0 0 0)", opacity: 1 }], SNAP);
}

/** a new element rising into place, the snap spring */
export function rise(el: HTMLElement, px = 18): void {
  play(el, [{ opacity: 0, transform: `translateY(${px}px)` }, { opacity: 1, transform: "none" }], SNAP);
}
