/* the screen change (docs/design.md, motion law): going into the machines, history or settings, the screen
   arrives from the right on the sheet spring while the one under it sinks and dims; going back is the same motion
   in reverse. one view transition, named `surface`, over the shell's one surface (shell.css draws the pseudo
   elements, so the numbers sit with the law's springs). under reduced motion it is the 120 ms content fade, and a
   browser without view transitions keeps the shell's own fade on arrival.

   what it does not do: a thread, which is home's own morph; the terminal, which has its own; and a back swipe,
   whose surface already left with the finger. */

import { prefersReducedMotion } from "./animate";

export type Travel = "forward" | "back";

type Documentish = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

let ran = false;

/** runs `change` under the screen transition when it can, else plainly. true when a transition took it */
export function travel(direction: Travel, change: () => void): boolean {
  const doc = document as Documentish;
  if (typeof doc.startViewTransition !== "function") {
    change();
    return false;
  }
  const root = document.documentElement;
  root.dataset.travel = prefersReducedMotion() ? "fade" : direction;
  ran = true;
  const transition = doc.startViewTransition(change);
  const done = () => {
    delete root.dataset.travel;
  };
  transition.finished.then(done, done);
  return true;
}

/** whether the last screen change was a view transition, asked once: the shell's own arrival fade stands down for it */
export function takeTransitioned(): boolean {
  const was = ran;
  ran = false;
  return was;
}
