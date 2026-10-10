/* press feedback: a control sinks under a finger and rebounds on the snap spring when it lets go. one delegated
   listener for the whole app, so every button, link and window answers the same way (docs/design.md, motion law).

   why script and not `:active`: ios only paints `:active` on pages that hold a touch listener, a stylesheet's
   `transition` rule on one button clobbers the spring on it, and a window's hit area is a button inside it, not the
   window. a press moves `scale`, the individual transform property, so it composes with whatever is moving the same
   element. under reduced motion nothing moves and the control dims instead.

   a finger that lands to scroll or swipe the deck must not make every window flinch, so a touch press starts after
   `TOUCH_HOLD_MS`, and a touch that is over or taken by a scroll before then does nothing; a quick tap gets one small
   blip instead. a mouse press starts at once. */

import { PRESS, PRESS_DIM, PRESS_SCALE, PRESS_SCALE_LARGE, REDUCED_FADE, SNAP } from "./springs";
import { prefersReducedMotion } from "./animate";

/** what answers a press */
const PRESSABLE = 'button, [role="button"], a[href], summary, [data-press]';
/** what keeps its own press (the composer's keys sink inside their own face) or must not move (a text field's caret) */
const OWN = ".cz-send, .cz-key, input, textarea, select, [contenteditable], [data-press='off']";
/** a window's title is the button, its hit area is the whole window, and the window is what sinks */
const WINDOW = ".win";
const WINDOW_OPEN = ".win-open";
/** a control bigger than this sinks less: a card sinking 4% would move by many pixels */
const LARGE_AREA = 24_000;
/** a touch this short is a tap, and gets the blip */
export const TOUCH_HOLD_MS = 70;

type Held = { el: HTMLElement; pointer: number; large: boolean; down: Animation | null; timer: number | undefined; started: boolean };

let held: Held | null = null;

/** what sinks for a press that began on `from`, or null for none */
export function pressTarget(from: EventTarget | null): HTMLElement | null {
  if (!(from instanceof Element)) return null;
  const control = from.closest<HTMLElement>(PRESSABLE);
  if (!control || control.closest(OWN)) return null;
  if ((control as HTMLButtonElement).disabled || control.getAttribute("aria-disabled") === "true") return null;
  if (control.matches(WINDOW_OPEN)) return control.closest<HTMLElement>(WINDOW) ?? control;
  return control;
}

const scaleOf = (large: boolean) => (large ? PRESS_SCALE_LARGE : PRESS_SCALE);

function sink(h: Held): void {
  h.started = true;
  if (prefersReducedMotion()) {
    h.down = h.el.animate([{ opacity: 1 }, { opacity: PRESS_DIM }], { duration: REDUCED_FADE.duration, easing: REDUCED_FADE.easing, fill: "forwards" });
    return;
  }
  h.down = h.el.animate([{ scale: "1" }, { scale: String(scaleOf(h.large)) }], { duration: PRESS.duration, easing: PRESS.easing, fill: "forwards" });
}

/** lets go: from wherever the sink has got to, back to rest on the snap spring */
function rise(h: Held): void {
  if (!h.started) return;
  const el = h.el;
  if (prefersReducedMotion()) {
    h.down?.cancel();
    el.animate([{ opacity: PRESS_DIM }, { opacity: 1 }], { duration: REDUCED_FADE.duration, easing: REDUCED_FADE.easing });
    return;
  }
  const now = h.down ? getComputedStyle(el).scale : "1";
  h.down?.cancel();
  if (now === "none" || now === "1") return;
  el.animate([{ scale: now }, { scale: "1" }], { duration: SNAP.duration, easing: SNAP.easing });
}

/** a tap that ended before the hold: down and back in one move */
function blip(el: HTMLElement, large: boolean): void {
  if (prefersReducedMotion()) {
    el.animate([{ opacity: PRESS_DIM }, { opacity: 1 }], { duration: REDUCED_FADE.duration, easing: REDUCED_FADE.easing });
    return;
  }
  el.animate([{ scale: "1" }, { scale: String(scaleOf(large)), offset: 0.25 }, { scale: "1" }], { duration: SNAP.duration, easing: SNAP.easing });
}

function onDown(event: PointerEvent): void {
  if (held || (event.pointerType === "mouse" && event.button !== 0)) return;
  const el = pressTarget(event.target);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const h: Held = { el, pointer: event.pointerId, large: rect.width * rect.height > LARGE_AREA, down: null, timer: undefined, started: false };
  held = h;
  if (event.pointerType === "mouse") sink(h);
  else h.timer = window.setTimeout(() => sink(h), TOUCH_HOLD_MS);
}

function onEnd(event: PointerEvent): void {
  const h = held;
  if (!h || event.pointerId !== h.pointer) return;
  held = null;
  clearTimeout(h.timer);
  // a window that is let go of is opening: its grow measures the window where it stands, so it stands at rest
  if (event.type === "pointerup" && h.el.matches(WINDOW)) {
    h.down?.cancel();
    return;
  }
  if (h.started) rise(h);
  else if (event.type === "pointerup") blip(h.el, h.large);
}

/** starts the one listener; returns what stops it */
export function installPress(target: Document = document): () => void {
  target.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  target.addEventListener("pointerup", onEnd, { capture: true, passive: true });
  target.addEventListener("pointercancel", onEnd, { capture: true, passive: true });
  return () => {
    target.removeEventListener("pointerdown", onDown, { capture: true });
    target.removeEventListener("pointerup", onEnd, { capture: true });
    target.removeEventListener("pointercancel", onEnd, { capture: true });
  };
}
