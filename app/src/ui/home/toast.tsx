/* the undo toast (docs/home.md, undo; undo.ts has its words, its sweep and its time): after a clear from this device (one
   window, or "clear N") and after the server auto-cleared threads while this page was in front, a glass pill says
   "cleared N" and offers "undo" for 6 s, a ring draining as the time runs out. the time stops while a pointer is over it,
   while focus is in it and while its undo is out, so a person reaching for it never loses it. undo (here, or ⌘z on home,
   home.tsx) brings back exactly the keys the clear cleared (settle-api.ts, `undoLast`); a newer clear replaces the toast
   and its time, except that an auto-clear waits for a hand clear's toast to end (offers.ts). its words are announced by
   home's live region, there before the toast (home.tsx), not by the toast, which would arrive already holding them. a
   chunk of its own (ui/later.ts); home's css holds its look (settle.css).

   the ring drains by clip-path, a wedge of its box swept clockwise from twelve: a stroke's dash offset is not a property
   the motion law lets move. under reduced motion the ring stays full and the 6 s still run. */

import { createEffect, on, onCleanup, Show, untrack } from "solid-js";
import { play } from "../../motion/animate";
import { dropUndo, type Undo, undoUntil } from "../../store";
import { barControl, focusBack } from "./focus-back";
import { undoLast } from "./settle-api";
import { DRAIN_FRAMES, Lifetime, TOAST_MS, toastWords, undoName } from "./undo";

/** the deck's toast height (settle.css): the page dots' row is 44, and the toast stands 2 px past it each way */
const DECK_HEIGHT = 48;

const clock = { now: () => performance.now(), after: (ms: number, run: () => void) => setTimeout(run, ms), cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function UndoToast(props: {
  undo: Undo;
  arrangement: "deck" | "strip" | "rail";
  /** an apple desktop's keyboard: the button shows ⌘z */
  keys: boolean;
}) {
  let ringEl: SVGSVGElement | undefined;
  let drain: Animation | null = null;
  // the offer carries when it runs out, so home coming back after it shows nothing (store.ts, `liveUndo`)
  const time = new Lifetime(TOAST_MS, () => dropUndo(props.undo.serial), clock, (at) => undoUntil(props.undo.serial, at));
  /* each source of a hold is held once: a pointer over the toast, focus in it, its undo out */
  const held = { pointer: false, focus: false, busy: false };
  const set = (source: keyof typeof held, on: boolean) => {
    if (held[source] === on) return;
    held[source] = on;
    if (on) {
      time.hold();
      drain?.pause();
    } else {
      time.release();
      if (!held.pointer && !held.focus && !held.busy) drain?.play();
    }
  };
  /* each clear (a new serial) and each failed undo starts the time the store gives it (the full time for a new one; what is
     left of it when home comes back while it still runs), and the ring from the same point */
  createEffect(
    on(
      () => [props.undo.serial, props.undo.error] as const,
      () => {
        const until = untrack(() => props.undo.until);
        const left = Number.isFinite(until) ? Math.min(TOAST_MS, Math.max(0, until - clock.now())) : TOAST_MS;
        drain?.cancel();
        drain = ringEl ? play(ringEl, DRAIN_FRAMES, { easing: "linear", duration: TOAST_MS }, { fill: "forwards" }) : null;
        if (drain) drain.currentTime = TOAST_MS - left;
        if (held.pointer || held.focus || held.busy) drain?.pause();
        time.restart(left);
      },
    ),
  );
  createEffect(() => set("busy", props.undo.busy));
  onCleanup(() => {
    const focused = held.focus;
    time.stop();
    drain?.cancel();
    // focus was in the toast (its undo, done): it goes to the bar's first control, not the body
    if (focused) queueMicrotask(() => document.activeElement === null || document.activeElement === document.body || !document.activeElement.isConnected ? focusBack(null, barControl) : undefined);
  });
  /* on the deck it sits in the row of the page dots, between the window in view and the dock, so it never covers a window's
     clear or the dock; measured once as it mounts (the dots row is there with two windows or more, else above the dock) */
  const placed = ((): Record<string, string> => {
    if (props.arrangement !== "deck") return {};
    const dots = document.querySelector(".home .pager")?.getBoundingClientRect();
    if (dots && dots.height > 0) return { bottom: `${Math.round(innerHeight - dots.bottom + (dots.height - DECK_HEIGHT) / 2)}px` };
    const dock = document.querySelector(".home .home-dock")?.getBoundingClientRect();
    return dock ? { bottom: `${Math.round(innerHeight - dock.top + 8)}px` } : {};
  })();
  const one = () => props.undo.keys.length === 1 && props.undo.title !== null && props.arrangement === "rail";
  return (
    <div
      class="undo-toast"
      data-arrangement={props.arrangement}
      style={placed}
      onPointerEnter={() => set("pointer", true)}
      onPointerLeave={() => set("pointer", false)}
      onFocusIn={() => set("focus", true)}
      onFocusOut={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) set("focus", false);
      }}
    >
      {/* the time left is a ring of its own over the track, clipped by its box: an svg's own box is what clip-path's
          percentages measure, which a circle inside one has not */}
      <span class="undo-ring" aria-hidden="true">
        <svg viewBox="0 0 20 20">
          <circle class="undo-track" cx="10" cy="10" r="8" />
        </svg>
        <svg class="undo-left" viewBox="0 0 20 20" ref={ringEl}>
          <circle cx="10" cy="10" r="8" />
        </svg>
      </span>
      <span class="undo-words">
        <Show when={props.undo.error} fallback={toastWords(props.undo.keys.length)}>
          {(error) => <span class="undo-error">{error()}</span>}
        </Show>
        <Show when={one() && !props.undo.error}>
          <span class="undo-title">{props.undo.title}</span>
        </Show>
      </span>
      <button
        class="undo-act"
        type="button"
        aria-label={props.undo.error ? `try again: ${undoName(props.undo)}` : undoName(props.undo)}
        aria-keyshortcuts={props.keys ? "Meta+Z" : undefined}
        disabled={props.undo.busy}
        onClick={() => void undoLast()}
      >
        {props.undo.error ? "try again" : "undo"}
        <Show when={props.keys}>
          <kbd aria-hidden="true">⌘z</kbd>
        </Show>
      </button>
    </div>
  );
}
