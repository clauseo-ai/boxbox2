/* the motion law as code (docs/design.md, motion law): two springs as css
   linear() curves, and flip, so only transform, opacity and clip-path
   animate and layout is measured once per transition. */

import { prefersReducedMotion } from "../../motion/animate";

export type Spring = { ease: string; dur: number };

/** a spring sampled into a css linear() curve, with how long it takes to settle */
export function spring(stiffness: number, damping: number): Spring {
  const pts: Array<[number, number]> = [];
  let x = 0, v = 0, t = 0, last = 0;
  const dt = 1 / 240;
  while (t < 2) {
    const a = stiffness * (1 - x) - damping * v;
    v += a * dt;
    x += v * dt;
    t += dt;
    if (Math.abs(1 - x) > 0.001 || Math.abs(v) > 0.01) last = t;
    pts.push([t, x]);
  }
  const n = 40;
  const out: string[] = [];
  for (let i = 0; i <= n; i++) {
    const target = (i / n) * last;
    const p = pts.find((q) => q[0] >= target) ?? pts[pts.length - 1];
    out.push((p?.[1] ?? 1).toFixed(4));
  }
  return { ease: `linear(${out.join(",")})`, dur: Math.ceil(last * 1000) };
}

export const SNAP = spring(380, 32);
export const SHEET = spring(250, 27);

let installed = false;
/** writes the springs onto the document once, as --snap, --snapd, --sheet and --sheetd */
export function installMotion(doc: Document = document): void {
  if (installed) return;
  installed = true;
  const s = doc.documentElement.style;
  s.setProperty("--snap", SNAP.ease);
  s.setProperty("--snapd", `${SNAP.dur}ms`);
  s.setProperty("--sheet", SHEET.ease);
  s.setProperty("--sheetd", `${SHEET.dur}ms`);
}

/** the device's choice in settings, or the system's when it left it there (app/src/motion/animate.ts) */
export const reducedMotion = (): boolean => prefersReducedMotion();

const FLIPPED = ".row, .you, .answer, .tape, .turn-mark, .report, .sumcard, .fl, .fdiff, .gap";

/** measures what is near the view, applies the change, and slides everything that moved from where it was;
    the revealed element, if any, opens under a clip. nothing reads layout inside a frame loop. */
export function flip(root: HTMLElement, mutate: () => void, reveal?: HTMLElement | null): void {
  if (reducedMotion()) { mutate(); return; }
  const top = root.getBoundingClientRect().top, h = root.clientHeight || innerHeight;
  const els = [...root.querySelectorAll<HTMLElement>(FLIPPED)].filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > top - h && r.top < top + 2 * h; });
  const before = new Map(els.map((e) => [e, e.getBoundingClientRect().top]));
  mutate();
  for (const e of els) {
    if (!e.isConnected) continue;
    const was = before.get(e);
    if (was === undefined) continue;
    const dy = was - e.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) e.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: SNAP.dur, easing: SNAP.ease });
  }
  if (reveal) reveal.animate([{ clipPath: "inset(0 0 100% 0)", opacity: 0 }, { clipPath: "inset(0 0 0 0)", opacity: 1 }], { duration: SNAP.dur, easing: SNAP.ease });
}

/** a new element rising into place, the snap spring */
export function rise(el: HTMLElement, px = 18): void {
  if (reducedMotion()) return;
  el.animate([{ opacity: 0, transform: `translateY(${px}px)` }, { opacity: 1, transform: "none" }], { duration: SNAP.dur, easing: SNAP.ease });
}
