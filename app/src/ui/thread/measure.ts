/* the scroller's width, said to the stylesheet as attributes (docs/gotchas.md, containment). the clock in the margin and the
   narrow stage's stuck tape used to ask the scroller's width with container queries, which needs the scroller to be a size
   container. webkit's scrolling does not agree with the layout under a containing ancestor: the scroller's offset snapped
   back to a place about half a screen above the end, over and over, whenever the stage wrote the end to it. so no ancestor of
   the transcript is a container, and its width is measured here, once per change, the way a container would have read it:
   the scroller's content box. */

/** the clock hangs in the margin beside the measure from this width of the scroller's content box */
export const CLOCK_FROM = 720;
/** up to this width the stuck tape is drawn without its scale */
export const TIGHT_TO = 600;

export type Measure = { clock: boolean; tight: boolean };

/** what the stylesheet is told about a scroller whose content box is `width` px wide */
export function measureOf(width: number): Measure {
  return { clock: width >= CLOCK_FROM, tight: width <= TIGHT_TO };
}

/** keeps `data-clock`, `data-tight` and `--scroll-w` on a scroller current: the stage's, or a story's sample. the first
    reading is taken now, so what paints first is already laid out for its width. returns what stops it. */
export function watchMeasure(scroller: HTMLElement): () => void {
  let last = Number.NaN;
  const say = (width: number) => {
    if (width === last) return;
    last = width;
    const { clock, tight } = measureOf(width);
    scroller.toggleAttribute("data-clock", clock);
    scroller.toggleAttribute("data-tight", tight);
    scroller.style.setProperty("--scroll-w", `${width}px`);
  };
  const style = getComputedStyle(scroller);
  say(scroller.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight));
  /* the content box, which is what a container reads; a change of the attributes moves what is inside the scroller and never
     the scroller's own box, so this cannot notify itself */
  const watch = new ResizeObserver(([entry]) => { if (entry) say(entry.contentRect.width); });
  watch.observe(scroller);
  return () => watch.disconnect();
}
