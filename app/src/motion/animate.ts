/* the motion helpers: every animation in the app goes through `play`, so
   the law's rules hold in one place (docs/design.md, motion law):

   - only transform (and its individual `scale`), opacity, clip-path and filter
     animate. `play` takes keyframes of those and nothing else, by type.
   - reduced motion: springs become instant, content swaps keep a 120 ms
     fade, the sweep and the word fade are off.
   - live motion only for live events: a caller passes `live: false` for
     anything painted from cache or replay, or offscreen, and gets the end
     state at once.
   - layout is measured once per transition (`flip` reads rects before and
     after one mutation), never inside a frame loop. */

import { type Accessor, createSignal } from "solid-js";
import { type Curve, FADE, REDUCED_FADE, SHEET, SNAP, type Spring, SWEEP, motionProperties } from "./springs";

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
    playing(
      el,
      reduced()
        ? // a content swap keeps a short fade; springs land at once; decoration (the sweep, the word fade) is off
          el.animate(onlyOpacity(frames), { duration: REDUCED_FADE.duration, easing: REDUCED_FADE.easing, fill })
        : el.animate(frames as Keyframe[], { duration: curve.duration, easing: curve.easing, delay, fill, ...(pseudoElement ? { pseudoElement } : {}) }),
    );
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

/* the animations `play` started that have not ended, so a page can ask whether something it sits in is moving without asking the
   browser (`getAnimations` brings the style up to date to answer, in the middle of a frame's callbacks). each one leaves when it
   finishes or is cancelled; every curve has an end, so the map holds the few that are running and no more */
const running = new Map<Animation, Element>();
function playing(el: Element, animation: Animation): Animation {
  running.set(animation, el);
  const gone = () => running.delete(animation);
  animation.finished.then(gone, gone);
  return animation;
}

/** the animations moving `el` from outside: running on it or on a box it sits in (a layer pouring onto the stage carries the whole
    thread in it). what moves inside it (a row rising, a word settling) is not counted */
function carrying(el: Element): Animation[] {
  const out: Animation[] = [];
  for (const [animation, target] of running) if (target.contains(el) && animation.playState !== "finished" && animation.playState !== "idle") out.push(animation);
  return out;
}

/** `el` is being carried by a transition (the stage's layer growing, pouring or sliding in): work it can leave until it lands waits */
export function carried(el: Element): boolean {
  return carrying(el).length > 0;
}

/** runs `then` once what carries `el` now has landed (at once when nothing does). answers a stop that cancels it */
export function whenLanded(el: Element, then: () => void): () => void {
  const moving = carrying(el);
  if (!moving.length) {
    then();
    return () => undefined;
  }
  let live = true;
  void Promise.allSettled(moving.map((a) => a.finished)).then(() => {
    if (live) then();
  });
  return () => {
    live = false;
  };
}

const onlyOpacity = (frames: Frame[]): Keyframe[] => frames.map((f) => (f.opacity === undefined ? {} : { opacity: f.opacity }));

/** records each element's box, runs one mutation, and plays every element from where it was to where it is.
    the only layout reads are the two passes over `elements` */
export function flip(elements: Iterable<Element>, mutate: () => void, curve: Spring = SNAP, live = true): void {
  const list = [...elements];
  const fades = settling(list);
  if (!live || reduced()) {
    mutate();
    resume(fades);
    return;
  }
  const before = new Map<Element, DOMRect>();
  for (const el of list) before.set(el, el.getBoundingClientRect());
  mutate();
  resume(fades);
  for (const [el, was] of before) {
    if (!el.isConnected) continue;
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    move(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: curve.duration, easing: curve.easing });
  }
}

/** a streamed word, or a count that changes in front of you, settles in by the css animation (styles.css, .settle-in). the
    class leaves once the fade has ended, so a span the page moves or shows again later does not fade in a second time
    (a css animation starts over whenever its element is put back in the page or shown) */
export function settleIn(el: Element): void {
  el.classList.add(SETTLE_IN);
  const ended = (event: Event) => {
    if (event.target !== el || (event as AnimationEvent).animationName !== SETTLE_IN) return;
    el.classList.remove(SETTLE_IN);
    el.removeEventListener("animationend", ended);
  };
  el.addEventListener("animationend", ended);
}

const SETTLE_IN = "settle-in";
type Fade = { el: Element; start: CSSNumberish | null; time: CSSNumberish | null };
/* a reorder moves windows in the page (the keyed <For> at home.tsx, inside flip's mutate), and a word still settling in one
   would start its fade over from opacity 0. its fade's place is read before the move and handed to the animation the move
   starts, so it carries on as one that was never moved. the read brings the style up to date, which flip's own read of the
   boxes does anyway */
function settling(elements: Element[]): Fade[] {
  if (typeof CSSAnimation === "undefined") return [];
  const out: Fade[] = [];
  for (const el of elements)
    for (const a of el.getAnimations({ subtree: true }))
      if (a instanceof CSSAnimation && a.animationName === SETTLE_IN && a.effect instanceof KeyframeEffect && a.effect.target)
        out.push({ el: a.effect.target, start: a.startTime, time: a.currentTime });
  return out;
}
function resume(fades: Fade[]): void {
  for (const { el, start, time } of fades) {
    if (!el.isConnected) continue;
    for (const a of el.getAnimations()) {
      if (!(a instanceof CSSAnimation) || a.animationName !== SETTLE_IN) continue;
      if (start !== null) a.startTime = start;
      else a.currentTime = time;
    }
  }
}

/* webkit keeps every animation an element was given alive for as long as the element lives, finished or cancelled
   (docs/gotchas.md, home): home's windows move at every reorder, a fleet streaming reorders them about every second, and
   each window held one animation, its keyframes and its spring's curve per move, twenty a second in all. an element moved
   again replays its own animation with the new keyframes instead */
const moves = new WeakMap<Element, Animation>();
function move(el: Element, frames: Keyframe[], timing: { duration: number; easing: string }): void {
  const was = moves.get(el);
  const effect = was?.effect;
  if (was && effect instanceof KeyframeEffect) {
    effect.setKeyframes(frames);
    effect.updateTiming(timing);
    // cancel then play: `currentTime = 0` starts it on the frame of the call in webkit, a frame before a fresh
    // Element.animate would (up to 8.8 px off); cancelled, it waits for the next frame as a new one does
    was.cancel();
    was.play();
    return;
  }
  moves.set(el, el.animate(frames, timing));
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
