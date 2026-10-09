/* what of a thread's stage comes and goes with the layer it is on (docs/design.md, the stage: a window grows into the thread).
   the layer's clip opens the flood from the window, and the stage's parts, its bar, its transcript and the composer's dock (the
   prototype's `.th, .scroll, .dz`), rise into it a moment later and fade out of it first when it closes. the flood and the card's
   edge are the layer's own and move with the clip. the stage paints a just-opened thread with no motion of its own, so these
   are the only ones. */

import { play } from "../../motion/animate";
import type { Curve } from "../../motion/springs";
import { FADE, SHEET } from "../../motion/springs";

const PARTS = ".stage-bar, .stage-scroll, .stage-dock";

const partsOf = (layer: HTMLElement) => [...layer.querySelectorAll<HTMLElement>(PARTS)];

/** the parts rise from `from` (a transform) to rest, after `delay` ms */
export function arrive(layer: HTMLElement, from: string, delay: number): void {
  for (const part of partsOf(layer)) play(part, [{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], SHEET, { delay, fill: "backwards" });
}

/** the parts fade where they are, and stay gone until the layer is */
export function leave(layer: HTMLElement): void {
  for (const part of partsOf(layer)) play(part, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
}

/* a layer that grows out of a window (or the capsule) starts as the colour of what it grew from. the window is deep in both
   appearances and the flood is pale in the light one, so a card that took the flood's colour in its first frame would flash; the
   veil is the window's own gradient over the stage (home.css, `.veil`), clear at rest. it clears as the card opens and comes
   back as it closes into its window, so the card that lands is the colour of the window under it. FADE's numbers, but not FADE
   itself: the reduced-motion rule keeps a fade where there is no clip to hide a veil, and a veil that fades over a layer that
   appeared at once would be the screen going deep for 120 ms */
const VEIL: Curve = { easing: FADE.easing, duration: FADE.duration };

export function unveil(layer: HTMLElement): void {
  const veil = layer.querySelector<HTMLElement>(".veil");
  if (veil) play(veil, [{ opacity: 1 }, { opacity: 0 }], VEIL);
}

/** `goneAt`: when the layer is taken off the stage, in ms. the veil is whole by then */
export function veil(layer: HTMLElement, goneAt: number): void {
  const element = layer.querySelector<HTMLElement>(".veil");
  if (element) play(element, [{ opacity: 0 }, { opacity: 1 }], VEIL, { delay: Math.max(0, goneAt - VEIL.duration), fill: "forwards" });
}
