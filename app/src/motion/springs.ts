/* the motion law's numbers (docs/design.md, motion law), in one place.

   two springs used everywhere, sampled once into css `linear()` curves, and
   two short curves. nothing else in the app picks a duration or an easing:
   a component asks for `SNAP`, `SHEET`, `FADE` or `SETTLE` and gets the
   law, already adjusted for reduced motion by `timing()` (animate.ts). */

export type Spring = {
  /** a css `linear()` easing that traces the spring from 0 to 1 */
  easing: string;
  /** when it has settled, ms */
  duration: number;
};

export type Curve = { easing: string; duration: number };

/** the simulation step: 120 hz, finer than any display the app runs on */
const STEP_S = 1 / 120;
/** settled means within this of the target, moving slower than `REST_V` */
const REST_X = 8e-4;
const REST_V = 8e-3;
/** a spring that has not settled by then is a mistake in its constants */
const LIMIT_S = 3;
/** points in the `linear()` curve: enough to trace the overshoot, few enough to parse cheaply */
const POINTS = 64;

/** a unit-mass spring from rest at 0 to 1, sampled into a `linear()` curve */
export function spring(stiffness: number, damping: number): Spring {
  const positions: number[] = [];
  let x = 0;
  let v = 0;
  let t = 0;
  while (t < LIMIT_S) {
    const a = -stiffness * (x - 1) - damping * v;
    v += a * STEP_S;
    x += v * STEP_S;
    t += STEP_S;
    positions.push(x);
    if (Math.abs(x - 1) < REST_X && Math.abs(v) < REST_V) break;
  }
  const stride = Math.max(1, Math.floor(positions.length / POINTS));
  const samples = [0];
  for (let i = stride; i < positions.length; i += stride) samples.push(round(positions[i] as number)); // i < length
  samples.push(1);
  return { easing: `linear(${samples.join(", ")})`, duration: Math.round(t * 1000) };
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** position: reorders, chips, the tail pushing up, an option flying into place, pager dots */
export const SNAP: Spring = spring(380, 32);
/** surfaces: a window growing into the stage and back, sheets, the capsule, the rail making room for an ask */
export const SHEET: Spring = spring(250, 27);
/** content swaps */
export const FADE: Curve = { easing: "cubic-bezier(.2, .8, .2, 1)", duration: 160 };
/** a streamed word settling from a 5 px blur */
export const SETTLE: Curve = { easing: "cubic-bezier(.2, .7, .2, 1)", duration: 360 };
/** the blur a streamed word settles from */
export const SETTLE_BLUR_PX = 5;
/** under reduced motion, content swaps keep a short fade and nothing else moves */
export const REDUCED_FADE: Curve = { easing: "linear", duration: 120 };
/** the one sweep of light an earned moment makes across a window */
export const SWEEP: Curve = { easing: "cubic-bezier(.3, .1, .2, 1)", duration: 1100 };
/** the one ring a status dot lets go when its state changes in front of you: a ring of the dot's own colour, out and gone.
    it is an event, never a loop (docs/design.md, never animates: anything forever) */
export const PING: Curve = { easing: "cubic-bezier(.2, .7, .2, 1)", duration: 760 };
export const PING_SCALE = 3.6;
/** the tick that draws itself in a chip, after the sweep has started */
export const TICK_DRAW: Curve & { delay: number } = { easing: "cubic-bezier(.4, 0, .2, 1)", duration: 420, delay: 120 };
/** a changed number: the old one leaves upwards, the new one rises in */
export const ROLL_OUT: Curve = { easing: "ease-in", duration: 100 };
export const ROLL_IN: Curve = { easing: "cubic-bezier(.2, .8, .2, 1)", duration: 170 };

/** a finger going down: quick and without overshoot, so the control answers inside one frame. letting go is the
    snap spring, which gives the release its small rebound */
export const PRESS: Curve = { easing: "cubic-bezier(.3, 0, .2, 1)", duration: 90 };
/** how far a small control sinks under a finger; a window or a card takes `PRESS_SCALE_LARGE` */
export const PRESS_SCALE = 0.96;
export const PRESS_SCALE_LARGE = 0.985;
/** under reduced motion a press dims instead of moving */
export const PRESS_DIM = 0.7;
/** a menu or popover leaving: quicker than it came */
export const LEAVE: Curve = { easing: "cubic-bezier(.4, 0, 1, 1)", duration: 110 };

/** the css custom properties the stylesheets read, so css transitions obey the same law. each curve comes as a
    pair (`--snap`, `--snap-ms`) and as the shorthand a `transition` takes (`--snap-t`: duration then easing). a
    css `transition: x var(--snap)` has no duration and does nothing, so write `var(--snap-t)` */
export function motionProperties(reduced: boolean): Record<string, string> {
  const snapMs = `${reduced ? 0 : SNAP.duration}ms`;
  const sheetMs = `${reduced ? 0 : SHEET.duration}ms`;
  const fadeMs = `${reduced ? REDUCED_FADE.duration : FADE.duration}ms`;
  const pressMs = `${reduced ? 0 : PRESS.duration}ms`;
  const leaveMs = `${reduced ? REDUCED_FADE.duration : LEAVE.duration}ms`;
  return {
    "--snap": SNAP.easing,
    "--snap-ms": snapMs,
    "--snap-t": `${snapMs} ${SNAP.easing}`,
    "--sheet": SHEET.easing,
    "--sheet-ms": sheetMs,
    "--sheet-t": `${sheetMs} ${SHEET.easing}`,
    "--fade": FADE.easing,
    "--fade-ms": fadeMs,
    "--fade-t": `${fadeMs} ${FADE.easing}`,
    "--press": PRESS.easing,
    "--press-ms": pressMs,
    "--press-t": `${pressMs} ${PRESS.easing}`,
    "--leave-ms": leaveMs,
    "--leave-t": `${leaveMs} ${LEAVE.easing}`,
    "--press-scale": String(reduced ? 1 : PRESS_SCALE),
    "--press-scale-large": String(reduced ? 1 : PRESS_SCALE_LARGE),
    "--press-dim": String(reduced ? PRESS_DIM : 1),
  };
}
