/* a segmented control whose thumb slides (docs/composer.md, the effort meter): equal segments on a pressed-in track, the chosen one
   lit in the place's light tone. the thumb is a clip: every segment is drawn twice, light on the track and dark on a lit layer,
   and the lit layer is clipped to the chosen segment, so the thumb and its dark label move together and nothing but clip-path
   animates (the motion law). what follows the segments, if anything, is plain pills in the same radiogroup.

   arrows move the thumb (and focus), home and end go to the ends, return or a tap picks. a pick can fold the control away
   (`onClose`) after the thumb has landed; without it the control stays and the thumb moves again on the next pick. */

import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { play, prefersReducedMotion } from "../../motion/animate";
import { FADE, SNAP } from "../../motion/springs";

/** how long the thumb is left to land before a control that folds away folds */
const LAND_MS = 240;
/** the track's height unless a control asks for its own: two rows (a glyph and its word) with eight pixels clear above and below */
const TALL = 48;
/** the track's own padding, which the lit layer's clip reads from */
const PAD = 3;
/** the clip that shows segment `at` of `count` equal columns, inside the track's padding */
const clipOf = (at: number, count: number, radius: number): string =>
  `inset(${PAD}px calc(${PAD}px + (100% - ${PAD * 2}px) * ${count - at - 1} / ${count}) ${PAD}px calc(${PAD}px + (100% - ${PAD * 2}px) * ${at} / ${count}) round ${radius}px)`;

type Segment = {
  value: string;
  /** what a segment shows, drawn once light for the track and once dark for the thumb */
  face: (tone: "track" | "lit") => JSX.Element;
  /** cannot be picked (it says why elsewhere); still reachable by keyboard, so it can be read */
  off?: boolean;
};

type Pill = { value: string; label: string };

type ThumbedProps = {
  /** the radiogroup's accessible name */
  name: string;
  segments: readonly Segment[];
  pills?: readonly Pill[];
  /** the value in force */
  current: string | null;
  /** opened from a keyboard: focus lands on the pick, so arrows work at once. a finger leaves focus where it was */
  keyboard?: boolean;
  onPick: (value: string) => void;
  /** the control folds away once the thumb has landed */
  onClose?: () => void;
  /** the segments' accessible names, by value, when the face is not enough */
  labelOf?: (value: string) => string | undefined;
  /** the track's own height, and the thumb's corner, for a control that is not the dial */
  tall?: number;
  /** "row" lays a segment's face out in a line (an icon and a word); the default stacks (a glyph over its word) */
  flow?: "stack" | "row";
  class?: string;
};

export function Thumbed(props: ThumbedProps) {
  const count = () => props.segments.length;
  const items = createMemo(() => [...props.segments.map((s) => s.value), ...(props.pills ?? []).map((p) => p.value)]);
  const radius = () => (props.tall ?? TALL) / 2 - PAD;
  const [at, setAt] = createSignal(Math.max(0, items().indexOf(props.current ?? "")));
  const [picked, setPicked] = createSignal(false);
  // the thumb rests on the pick, and is not drawn while there is none (the daemon chooses) or the pick is a pill, until the
  // person moves onto a segment
  const [engaged, setEngaged] = createSignal(items().indexOf(props.current ?? "") >= 0);
  const thumb = () => (engaged() && at() < count() ? at() : -1);
  const buttons: HTMLButtonElement[] = [];
  let root: HTMLDivElement | undefined;
  let lit: HTMLDivElement | undefined;
  let landing: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(landing));

  /* a row that cannot fit scrolls, and a fade at each end that has more beyond it says so. read when the row is made, on a scroll
     and when its size changes (events and an observer, never a frame loop) */
  const [fade, setFade] = createSignal("");
  const measure = () => {
    if (!root) return;
    const start = root.scrollLeft > 1;
    const end = root.scrollLeft + root.clientWidth < root.scrollWidth - 1;
    setFade(start && end ? "start end" : start ? "start" : end ? "end" : "");
  };

  /* brings a segment into view by scrolling this row only (an element's own scrollIntoView would scroll the sheet or the stage
     too): into the middle, or just far enough to clear the fades. one measure per call, from an event */
  const reveal = (el: HTMLElement | undefined, how: "center" | "nearest") => {
    if (!el || !root || root.scrollWidth <= root.clientWidth) return;
    const seg = el.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const clear = 30;
    if (how === "center") root.scrollLeft += seg.left + seg.width / 2 - (box.left + box.width / 2);
    else if (seg.left < box.left + clear) root.scrollLeft -= box.left + clear - seg.left;
    else if (seg.right > box.right - clear) root.scrollLeft += seg.right - (box.right - clear);
  };

  onMount(() => {
    if (props.keyboard) buttons[at()]?.focus({ preventScroll: true });
    // a long row (more segments than fit, pills after them) opens with the pick in the middle of what is shown
    reveal(buttons[at()], "center");
    measure();
    if (root) {
      const watch = new ResizeObserver(measure);
      watch.observe(root);
      if (root.firstElementChild) watch.observe(root.firstElementChild);
      onCleanup(() => watch.disconnect());
    }
    if (props.onClose && root) play(root, [{ opacity: 0, transform: "translateX(10px)" }, { opacity: 1, transform: "none" }], SNAP);
  });

  // the control follows the value when something else changes it (a model pick that took the effort away, a place that is not a repo)
  createEffect(
    on(
      () => props.current,
      (now) => {
        if (picked()) return;
        const index = items().indexOf(now ?? "");
        setEngaged(index >= 0);
        if (index >= 0) setAt(index);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      thumb,
      // the run at mount only records where the thumb is, so the first move has a place to slide from
      (now, before) => {
        if (!lit || before === undefined || now === before) return;
        if (now < 0 || before < 0) play(lit, [{ opacity: before < 0 ? 0 : 1 }, { opacity: now < 0 ? 0 : 1 }], FADE);
        else play(lit, [{ clipPath: clipOf(before, count(), radius()) }, { clipPath: clipOf(now, count(), radius()) }], SNAP);
      },
    ),
  );

  const off = (index: number) => index < count() && props.segments[index]?.off === true;
  /** the next place that can be picked from `from` in the direction of `step`, or none (the ends hold: a ladder does not wrap) */
  const reach = (from: number, step: 1 | -1): number => {
    for (let i = from; i >= 0 && i < items().length; i += step) if (!off(i)) return i;
    return -1;
  };
  const move = (to: number, step: 1 | -1) => {
    const next = reach(Math.max(0, Math.min(items().length - 1, to)), step);
    if (next < 0) return;
    setEngaged(true);
    setAt(next);
    buttons[next]?.focus({ preventScroll: true });
    reveal(buttons[next], "nearest");
    // a control that stays is a radio group: the arrow that lands on a choice makes it. one that folds away previews, and return picks
    const value = items()[next];
    if (!props.onClose && value !== undefined && value !== props.current) props.onPick(value);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === 1 || step === -1) {
      event.preventDefault();
      move(at() + step, step);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const down = event.key === "End";
      move(down ? items().length - 1 : 0, down ? -1 : 1);
    }
  };

  const pick = (value: string, index: number) => {
    // a control that folds away takes one pick and then waits to fold; one that stays takes every pick
    if (props.onClose && picked()) return;
    setEngaged(true);
    setAt(index);
    props.onPick(value);
    if (!props.onClose) return;
    setPicked(true);
    // the thumb is let land before the control folds; with reduced motion nothing moves, so nothing waits
    landing = setTimeout(props.onClose, prefersReducedMotion() ? 0 : LAND_MS);
  };
  const focused = (index: number) => () => {
    // a segment that cannot be picked is never where the thumb or the focus rests
    if (at() === index || off(index)) return;
    setEngaged(true);
    setAt(index);
  };

  return (
    <div class={props.class ? `cz-thumbed ${props.class}` : "cz-thumbed"} role="radiogroup" aria-label={props.name} data-flow={props.flow} data-fade={fade() || undefined} ref={root} onScroll={measure} onKeyDown={onKeyDown} onPointerDown={(e) => e.preventDefault()}>
      <Show when={count() > 0}>
        <div class="cz-thumbed-track" style={{ "--n": count(), "--tall": `${props.tall ?? TALL}px` }}>
          <For each={props.segments}>
            {(segment, i) => (
              <button
                type="button"
                role="radio"
                class="cz-seg"
                aria-checked={segment.value === props.current ? "true" : "false"}
                aria-disabled={segment.off ? "true" : undefined}
                aria-label={props.labelOf?.(segment.value)}
                tabindex={i() === at() ? 0 : -1}
                ref={(el) => (buttons[i()] = el)}
                onFocus={focused(i())}
                onClick={() => !segment.off && pick(segment.value, i())}
              >
                <span class="cz-seg-face" data-tone="track" data-off={segment.off ? "" : undefined}>{segment.face("track")}</span>
              </button>
            )}
          </For>
          <div class="cz-thumbed-lit" aria-hidden="true" ref={lit} style={{ "clip-path": clipOf(Math.max(0, thumb()), count(), radius()), opacity: thumb() < 0 ? 0 : 1 }}>
            <For each={props.segments}>{(segment) => <span class="cz-seg"><span class="cz-seg-face" data-tone="lit">{segment.face("lit")}</span></span>}</For>
          </div>
        </div>
      </Show>
      <For each={props.pills ?? []}>
        {(pill, i) => (
          <button
            type="button"
            role="radio"
            class="cz-variant"
            aria-checked={pill.value === props.current ? "true" : "false"}
            tabindex={count() + i() === at() ? 0 : -1}
            ref={(el) => (buttons[count() + i()] = el)}
            onFocus={focused(count() + i())}
            onClick={() => pick(pill.value, count() + i())}
          >
            {pill.label}
          </button>
        )}
      </For>
    </div>
  );
}
