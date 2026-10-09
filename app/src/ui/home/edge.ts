/* the stage card's edge moving: the rail folds and opens, the inspector folds and opens (design.md, motion
   law; docs/home.md, the folds). one calm, physical move on the sheet spring, made of transform, opacity and
   clip-path only, with the layout committed once:

   - the card's edge glides by clip-path on the card. it never resizes in a frame.
   - what is inside the card is laid out where it ends up, and carried to look as it did by a translate, so
     nothing reflows in the move (glide.ts decides which boxes are carried, from two measurements). where a
     paragraph would reflow (a window so narrow that the stage's width changes the prose's), a carry cannot follow
     it, so the content swaps instead, at the moment the layout changes: it fades in on the law's content fade where the
     layout changes first, and where it changes last it goes out in the last 100 ms of the move and comes back after it.
   - the shadow under the card follows the edge by scaling from the edge that stays. the rim on the card cannot: a scale
     would turn its rounded corners into ellipses, and the corners are what it is for. so the rim is cut in two, a rigid
     cap that is the card's end (its corner arcs and the line between them), carried with the edge, and the rest of the
     ring, clipped to begin where the cap ends. at rest only the whole ring shows.
   - the column that leaves, or arrives, does it by opacity and a short drift in the direction the edge travels.
   - a card that grows commits its layout first. a card that shrinks commits it last: it stays as big as it was
     while its clip recedes and uncovers the column beneath it, and in the frame the move ends the layout, the
     transforms and the clip all let go at once, which paints exactly the frame before. the layout it will end
     in is measured once up front, by committing it and putting it back before anything is painted. */

import { play, prefersReducedMotion } from "../../motion/animate";
import { FADE, ROLL_OUT, SHEET } from "../../motion/springs";
import { type Align, type Boxed, carriers, type Span } from "./glide";

/** how far a column's content drifts as it arrives or leaves, along the way the edge travels */
const DRIFT_PX = 16;
/** a column that arrives beside a card that grows (the folded rail) waits this long, for the one it replaces to fade out of
    the same place. one a shrinking card uncovers is there as soon as the ground is: it fades in under the receding edge */
const ARRIVE_AFTER_MS = 110;
/** how deep, and how many boxes, are looked at inside the card: the cells of a transcript row are nine levels down, and a box
    carried as one piece is carried by one edge, which a row of cells hung from both can not be */
const MAX_DEPTH = 12;
const MAX_BOXES = 500;

export type EdgeMove = {
  /** the stage: the card whose edge moves, clipped by it */
  card: HTMLElement;
  /** the shadow beneath the card, which the clip would take with it: scaled from the edge that stays */
  lift: HTMLElement;
  /** the card's lit edge, drawn above its content: the whole ring, and the end of it that travels (shown only while moving) */
  rim: { ring: HTMLElement; cap: HTMLElement };
  /** the edge of the card that travels */
  side: "left" | "right";
  /** the card gets bigger: its edge travels outward */
  grow: boolean;
  /** lays the stage out for where the edge ends (true) or where it began (false), at once and synchronously */
  layout: (end: boolean) => void;
  /** the columns that leave, and the ones that arrive, as the edge moves */
  leaving: readonly HTMLElement[];
  arriving: readonly HTMLElement[];
  /** the move is over and the layout is final: called before the move's animations are let go, in the same task */
  settled: () => void;
};

type Gathered = { el: Element; at: Span; text: Align | null; wraps: boolean; paint: boolean; inside: Gathered[] };

const span = (rect: DOMRect): Span => ({ left: rect.left, right: rect.right });

/** where the box's own words sit, or null when it has none: its own text, or text set in inline elements (a streamed paragraph is
    words in spans), and not the text of boxes inside it */
function textOf(el: Element): Align | null {
  const own = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  const inline = el.childElementCount > 0 && Boolean(el.textContent?.trim()) && [...el.children].every((child) => getComputedStyle(child).display.startsWith("inline"));
  if (!own && !inline) return null;
  const align = getComputedStyle(el).textAlign;
  return align === "right" || align === "end" ? "right" : align === "center" ? "center" : "left";
}

/** a box's own words run over more than one line: what is in its content box is taller than a line and a half */
function runsOver(el: Element, rect: DOMRect): boolean {
  const style = getComputedStyle(el);
  const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3;
  const around = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const;
  return rect.height - around.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0) > line * 1.5;
}

/** a box that only paints: nothing in it (no box inside, no words, no image) and no rounded corners, border or shadow of its own,
    which stretching it would distort. a box whose insides were not looked at (too deep, or past the budget) is not one */
function paintsOnly(el: Element): boolean {
  if (el.childElementCount > 0 || el.textContent?.trim() || el instanceof SVGElement || el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement) return false;
  const style = getComputedStyle(el);
  const none = (...values: string[]) => values.every((value) => value === "0px" || value === "none");
  return none(style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius, style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRightWidth, style.boxShadow);
}

/** the boxes inside `root` as they are now, a level at a time so the shallow ones are never cut for the deep ones. a box above or
    below the card is not on screen and is clipped away: carrying it would spend the budget on rows nobody sees, and in a long
    thread leave the ones on screen out of it */
function gather(root: Element, skip: ReadonlySet<Element>): Gathered[] {
  const view = root.getBoundingClientRect();
  const top: Gathered[] = [];
  let budget = MAX_BOXES;
  let level: Array<{ el: Element; into: Gathered[] }> = [{ el: root, into: top }];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: typeof level = [];
    for (const { el, into } of level) {
      for (const child of el.children) {
        if (budget <= 0) return top;
        if (skip.has(child)) continue;
        const rect = child.getBoundingClientRect();
        // not drawn, or not on screen: nothing to carry
        if ((rect.width === 0 && rect.height === 0) || rect.bottom < view.top || rect.top > view.bottom) continue;
        budget--;
        const text = textOf(child);
        const box: Gathered = { el: child, at: span(rect), text, wraps: text !== null && runsOver(child, rect), paint: paintsOnly(child), inside: [] };
        into.push(box);
        next.push({ el: child, into: box.inside });
      }
    }
    level = next;
  }
  return top;
}

/** the same boxes read again after the layout changed: where each is now against where it was */
function pair(boxes: readonly Gathered[], grow: boolean): Boxed<Element>[] {
  return boxes.map((box) => {
    const rect = box.el.getBoundingClientRect();
    const now = span(rect);
    // a card that grows is laid out at its end and must look as it was; one that shrinks is laid out as it was and must end where it will be
    return {
      el: box.el,
      layout: grow ? now : box.at,
      visual: grow ? box.at : now,
      text: box.text,
      wraps: box.wraps || (box.text !== null && runsOver(box.el, rect)),
      paint: box.paint,
      inside: pair(box.inside, grow),
    };
  });
}

const rounded = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** moves the card's edge. `stop` finishes it at once (a resize, or the page leaving); the move is never abandoned half way */
export function moveEdge(move: EdgeMove): { stop: () => void } {
  const { card, lift, rim, side, grow } = move;
  if (prefersReducedMotion()) {
    move.layout(true);
    move.settled();
    return { stop: () => undefined };
  }
  const was = card.getBoundingClientRect();
  const tree = gather(card, new Set([lift, rim.ring, rim.cap]));
  move.layout(true);
  const will = card.getBoundingClientRect();
  const boxes = pair(tree, grow);
  if (!grow) move.layout(false);

  const [small, big] = grow ? [was, will] : [will, was];
  const by = big.width - small.width;
  const animations: Animation[] = [];
  const run = (animation: Animation | null) => {
    if (animation) animations.push(animation);
  };
  const { carried, reflows } = carriers(boxes, side);
  /** what swaps when a paragraph would reflow: everything carried, but the paint that is stretched (the flood stays) */
  const swapped = by >= 1 && reflows ? carried.filter((c) => c.sx === undefined).map((c) => c.el) : [];
  // a card that shrinks holds its end until the layout catches up with it
  const fill: FillMode = grow ? "none" : "forwards";

  if (by >= 1) {
    // everything read first, then everything written: an animation made between two reads would make the next read recalculate style
    const radius = getComputedStyle(card).borderTopLeftRadius;
    const bases = carried.map(({ el }) => getComputedStyle(el).transform);
    const whole = `inset(0px 0px 0px 0px round ${radius})`;
    const cut = side === "left" ? `inset(0px 0px 0px ${rounded(by)}px round ${radius})` : `inset(0px ${rounded(by)}px 0px 0px round ${radius})`;
    run(play(card, grow ? [{ clipPath: cut }, { clipPath: whole }] : [{ clipPath: whole }, { clipPath: cut }], SHEET, { fill }));

    const squeeze = `scaleX(${rounded(small.width / big.width, 4)})`;
    lift.style.transformOrigin = side === "left" ? "100% 50%" : "0% 50%";
    run(play(lift, grow ? [{ transform: squeeze }, { transform: "none" }] : [{ transform: "none" }, { transform: squeeze }], SHEET, { fill }));

    // the ring begins where the cap, one corner radius wide, ends
    const reach = Number.parseFloat(radius);
    const ringFrom = (inset: number) => (side === "left" ? `inset(0px 0px 0px ${rounded(inset)}px)` : `inset(0px ${rounded(inset)}px 0px 0px)`);
    const apart = `translateX(${rounded(side === "left" ? by : -by)}px)`;
    // held to the end of the move, however long the columns take: with the cap on show and the ring whole, the corner would be drawn twice
    run(play(rim.ring, grow ? [{ clipPath: ringFrom(by + reach) }, { clipPath: ringFrom(reach) }] : [{ clipPath: ringFrom(reach) }, { clipPath: ringFrom(by + reach) }], SHEET, { fill: "forwards" }));
    run(play(rim.cap, grow ? [{ transform: apart }, { transform: "none" }] : [{ transform: "none" }, { transform: apart }], SHEET, { fill: "forwards" }));

    carried.forEach(({ el, dx, sx }, i) => {
      // a box with a transform of its own keeps it: the carry is added in front of it
      const base = bases[i] ?? "none";
      const away = `translate(${rounded(dx)}px, 0px)${sx === undefined ? "" : ` scaleX(${rounded(sx, 5)})`}${base === "none" ? "" : ` ${base}`}`;
      run(play(el, grow ? [{ transform: away }, { transform: base }] : [{ transform: base }, { transform: away }], SHEET, { fill }));
    });
    // the layout changes where the card grows at its start, and where it shrinks at its end: the content dissolves around that moment
    for (const el of swapped) {
      if (grow) run(play(el, [{ opacity: 0 }, { opacity: 1 }], FADE, { fill: "backwards" }));
      else run(play(el, [{ opacity: 1 }, { opacity: 0 }], ROLL_OUT, { delay: SHEET.duration - ROLL_OUT.duration, fill: "forwards" }));
    }
  }

  // the way the edge travels: a column that leaves is carried along it, one that arrives has come along it
  const way = (side === "left" ? -1 : 1) * (grow ? 1 : -1);
  for (const el of move.leaving) {
    run(play(el, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" }));
    run(play(el, [{ transform: "none" }, { transform: `translateX(${way * DRIFT_PX}px)` }], SHEET, { fill: "forwards" }));
  }
  const arriveAfter = grow ? ARRIVE_AFTER_MS : 0;
  for (const el of move.arriving) {
    run(play(el, [{ opacity: 0 }, { opacity: 1 }], FADE, { delay: arriveAfter, fill: "backwards" }));
    run(play(el, [{ transform: `translateX(${-way * DRIFT_PX}px)` }, { transform: "none" }], SHEET, { delay: arriveAfter, fill: "backwards" }));
  }

  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    if (!grow) move.layout(true);
    move.settled();
    for (const animation of animations) animation.cancel();
    // created before the next frame is painted, so the dissolved content is never seen whole in its new layout
    if (!grow) for (const el of swapped) play(el, [{ opacity: 0 }, { opacity: 1 }], FADE, { fill: "backwards" });
    lift.style.transformOrigin = "";
  };
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
  return { stop: finish };
}
