/* the motion helpers: every animation in the app goes through `play`, so
   the law's rules hold in one place (docs/design.md, motion law):

   - only transform (and its individual `scale`), opacity, clip-path and filter
     animate. `play` takes keyframes of those and nothing else, by type.
   - reduced motion: springs become instant, content swaps keep a 120 ms
     fade, the sweep and the blur are off.
   - live motion only for live events: a caller passes `live: false` for
     anything painted from cache or replay, or offscreen, and gets the end
     state at once.
   - layout is measured once per transition (`flip` reads rects before and
     after one mutation), never inside a frame loop. */

import { type Accessor, createSignal } from "solid-js";
import { type Curve, FADE, REDUCED_FADE, SETTLE, SETTLE_BLUR_PX, SHEET, SNAP, type Spring, SWEEP, motionProperties } from "./springs";

/** what a keyframe may touch */
export type Frame = {
  transform?: string;
  /** the individual scale property: a transform that composes with the element's own `transform`, so a press
      never fights a spring that is moving the same element */
  scale?: string;
  /** the individual translate property, for the same reason: a board key slides a window's chip aside while the chip's own
      settle plays on its `transform` */
  translate?: string;
  opacity?: number | string;
  clipPath?: string;
  filter?: string;
  offset?: number;
};

/** how a curve behaves under reduced motion */
type Kind = "spring" | "fade" | "decor";

const REDUCED = "(prefers-reduced-motion: reduce)";
const reducedQuery = typeof matchMedia === "function" ? matchMedia(REDUCED) : null;
const [systemReduced, setSystemReduced] = createSignal(reducedQuery?.matches ?? false);
/** this device's own choice in settings (styles.css reads the same choice as `data-motion` on the root) */
export type MotionChoice = "system" | "reduced" | "full";
const [choice, setChoice] = createSignal<MotionChoice>("system");
const reduced = (): boolean => choice() === "reduced" || (choice() === "system" && systemReduced());
reducedQuery?.addEventListener("change", (event) => {
  setSystemReduced(event.matches);
  installMotionProperties();
});

/** true while motion should be reduced: this device chose it in settings, or left it to a system that asks for it.
    follows both live */
export const prefersReducedMotion: Accessor<boolean> = reduced;

/** the device's choice, from settings (app/src/ui/settings/appearance.ts), so the springs obey it as the css does */
export function setMotionChoice(next: MotionChoice): void {
  setChoice(next);
  installMotionProperties();
}

/** writes the law's curves onto the root, for the few css transitions (pager dots, chevrons) */
export function installMotionProperties(): void {
  if (typeof document === "undefined") return;
  for (const [name, value] of Object.entries(motionProperties(reduced()))) document.documentElement.style.setProperty(name, value);
}

const kindOf = (curve: Spring | Curve): Kind => (curve === SNAP || curve === SHEET ? "spring" : curve === FADE ? "fade" : "decor");

export type PlayOptions = {
  /** false for anything painted from cache or replay, or out of view: the end state lands at once */
  live?: boolean;
  delay?: number;
  fill?: FillMode;
  /** animate a pseudo-element of `el` (a ring drawn by `::after`) */
  pseudoElement?: string;
};

/** plays keyframes on the law's curve, or lands the end state at once when motion is not wanted. returns the
    animation, or null when nothing moved (or when it starts a moment later, below) */
export function play(el: Element, frames: Frame[], curve: Spring | Curve, options: PlayOptions = {}): Animation | null {
  const { live = true, delay = 0, fill = "none", pseudoElement } = options;
  const kind = kindOf(curve);
  if (!live) return null;
  if (reduced() && kind !== "fade") return null;
  const start = (): Animation =>
    reduced()
      ? // a content swap keeps a short fade; springs land at once; decoration (the sweep, the blur) is off
        el.animate(onlyOpacity(frames), { duration: REDUCED_FADE.duration, easing: REDUCED_FADE.easing, fill })
      : el.animate(frames as Keyframe[], { duration: curve.duration, easing: curve.easing, delay, fill, ...(pseudoElement ? { pseudoElement } : {}) });
  /* an element solid has just made (a `ref`) is not in the page yet: it belongs to the inert document of the template it
     was cloned from, and an animation started on it never runs. chromium takes that document's timeline, which never
     ticks; webkit leaves it pending even when handed the page's. both held the first frame for good: a queued card sat at
     opacity 0 until a reload (docs/gotchas.md). solid puts the element in the page before its update returns, so the
     animation starts a microtask later, before the frame; one still not in the page by then simply shows */
  if (!el.isConnected) {
    queueMicrotask(() => {
      if (el.isConnected) start();
    });
    return null;
  }
  return start();
}

const onlyOpacity = (frames: Frame[]): Keyframe[] => frames.map((f) => (f.opacity === undefined ? {} : { opacity: f.opacity }));

/** records each element's box, runs one mutation, and plays every element from where it was to where it is.
    the only layout reads are the two passes over `elements` */
export function flip(elements: Iterable<Element>, mutate: () => void, curve: Spring = SNAP, live = true): void {
  if (!live || reduced()) {
    mutate();
    return;
  }
  const before = new Map<Element, DOMRect>();
  for (const el of elements) before.set(el, el.getBoundingClientRect());
  mutate();
  for (const [el, was] of before) {
    if (!el.isConnected) continue;
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: curve.duration, easing: curve.easing });
  }
}

/** a streamed word (or run of words) settling in from a soft blur. words are inline, so they wrap with the
    prose; transform does not apply to inline boxes, so the settle is the blur and the opacity alone */
export function settle(el: Element, live: boolean): void {
  play(
    el,
    [
      { opacity: 0, filter: `blur(${SETTLE_BLUR_PX}px)` },
      { opacity: 1, filter: "blur(0)" },
    ],
    SETTLE,
    { live, fill: "backwards" },
  );
}

/** the one sweep of light an earned moment makes across a window */
export function sweep(sheen: Element, live: boolean): void {
  play(sheen, [{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], SWEEP, { live });
}

/** a clip-path inset that covers `rect` inside `box`, rounded like the thing it came from */
export function insetOf(rect: DOMRect, box: DOMRect, radius: string): string {
  const top = rect.top - box.top;
  const left = rect.left - box.left;
  const right = box.right - rect.right;
  const bottom = box.bottom - rect.bottom;
  return `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${radius})`;
}

const px = (n: number) => `${Math.round(n * 10) / 10}px`;

/** resolves when every animation on `el` and its subtree has finished or been cancelled */
export async function settled(el: Element): Promise<void> {
  await Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished));
}
