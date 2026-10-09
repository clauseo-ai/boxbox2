/* the earned flights (docs/design.md, the earned moments): an option flies
   into place as your message, a queued card slides up into the thread, the
   new-thread sheet closes into its window. one shared-element morph for all
   of them, made of transform and opacity only (the motion law): the thing
   you touched and the thing it becomes are both drawn, each mapped onto the
   other's box, and they cross over on the snap spring. the destination is
   hidden for the flight and shown, in place, when it lands. */

import { play, prefersReducedMotion } from "./animate";
import { SNAP } from "./springs";

/** the transform that lays a box of `from`'s size and place over `to` */
function mapping(from: DOMRect, to: DOMRect): string {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})`;
}

/** a still copy of `el` fixed over its own box, outside the layout, for the length of a flight */
function ghostOf(el: Element, box: DOMRect): HTMLElement {
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: "0",
    zIndex: "90",
    pointerEvents: "none",
    transformOrigin: "0 0",
    boxSizing: "border-box",
  });
  return ghost;
}

/** flies `from` into `to`, which must already be laid out where it lands. resolves when it has landed. with
    reduced motion, a replay, or either box empty, `to` simply shows */
export async function flyInto(from: Element, to: HTMLElement, live = true): Promise<void> {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (!live || prefersReducedMotion() || a.width === 0 || b.width === 0) return;
  const source = ghostOf(from, a);
  const landing = ghostOf(to, b);
  document.body.append(source, landing);
  to.style.visibility = "hidden";
  const out = play(source, [{ transform: "none", opacity: 1 }, { transform: mapping(a, b), opacity: 0 }], SNAP, { fill: "forwards" });
  const into = play(landing, [{ transform: mapping(b, a), opacity: 0 }, { transform: "none", opacity: 1 }], SNAP, { fill: "forwards" });
  try {
    await Promise.allSettled([out?.finished, into?.finished]);
  } finally {
    to.style.visibility = "";
    source.remove();
    landing.remove();
  }
}

/** a window, card or row born in front of you: it settles in from slightly small, on the snap spring */
export function birth(el: Element, live = true, delay = 90): void {
  play(el, [{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], SNAP, { live, delay, fill: "backwards" });
}

/** the properties the motion law lets animate; anything else in a keyframe is a bug the budget run reports */
export const ANIMATABLE: ReadonlySet<string> = new Set(["transform", "opacity", "clipPath", "filter"]);
