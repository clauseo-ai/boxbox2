/* the board's chunk (docs/board.md, the app; docs/design.md, the board): fetched on the first `board.here`, never on a
   device without a board. a window's digit set into its material, a swatch's, and pairing a thread with a digit key.

   the digit is a key set into the window like a key in its bed: a well pressed into the window's own material with the
   digit in its accent, at the end of the header row; a paired key is lit in the window's accent, as the board lights it.
   it sits out of the flow (board.css), so arriving, changing and leaving move nothing by layout: the chip beside it slides
   aside by its `translate`, the name gives up the room by its own end (its start never moves), and the key comes and goes
   by transform and opacity on the snap spring. nothing is measured but the host's box, once per transition, to tell
   whether it is in view; out of view, offline, replaying or hidden, the end state lands at once. */

import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js";
import { play } from "../motion/animate";
import { FADE, SNAP } from "../motion/springs";
import { setBoardPin, state } from "../store";
import type { RepoColour } from "../ui/window/repo";
import { armPin } from "./pin";
import "./board.css";

/** how far a window's chip moves aside for the key: the key's 26 px and the header's 6 px between them (board.css) */
const ASIDE = "-32px 0";
/** the chip makes room before the key comes into it, and the key is gone before the chip takes its place back */
const STAGGER_MS = 70;
/** a key that mounts within this long of the board arriving arrived with it, and says so; later, it paints in place */
const ARRIVING_MS = 900;

type Face = { digit: number; bound: boolean };
const sameFace = (a: Face | null, b: Face | null) => a?.digit === b?.digit && a?.bound === b?.bound;

export type BoardKeyProps = {
  thread: string;
  form: "window" | "swatch";
  /** the window's own say on motion (in view, live, caught up); a swatch has none and is judged here */
  live?: boolean;
};

export function BoardKey(props: BoardKeyProps) {
  let el!: HTMLSpanElement;
  let digitEl!: HTMLSpanElement;
  let litEl!: HTMLSpanElement;
  const seat = createMemo<Face | null>(
    () => {
      const digit = state.board.digits[props.thread];
      return digit === undefined ? null : { digit, bound: state.board.bound[props.thread] === true };
    },
    null,
    { equals: sameFace },
  );
  /** what the key shows: the seat, or the one it is leaving with until the leaving has played */
  const [face, setFace] = createSignal<Face | null>(untrack(seat));
  let leaving: Animation | null = null;

  const host = (): HTMLElement | null => el.closest<HTMLElement>(props.form === "window" ? ".win" : ".swatch");
  const moving = (): boolean => {
    if (props.live === false || state.stream.state !== "live" || document.visibilityState !== "visible") return false;
    const box = host()?.getBoundingClientRect();
    return box !== undefined && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
  };
  const chip = (): HTMLElement | null => (props.form === "window" ? (host()?.querySelector<HTMLElement>(".wh > .chip") ?? null) : null);
  /** `seated` slides the chip aside and keeps the name clear; `leaving` lets the chip back while the name still keeps clear
      of the fading key */
  const mark = (to: "seated" | "leaving" | null) => {
    const at = host();
    if (!at) return;
    if (to) at.dataset.board = to;
    else delete at.dataset.board;
  };

  /** the key's arrival: the chip slides aside, and the key rises into the room it made */
  const enter = () => {
    const at = chip();
    if (at) play(at, [{ translate: "0 0" }, { translate: ASIDE }], SNAP);
    play(el, [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }], SNAP, { delay: at ? STAGGER_MS : 0, fill: "backwards" });
  };
  const arrive = (next: Face, move: boolean) => {
    leaving?.cancel();
    leaving = null;
    setFace(next);
    mark("seated");
    if (!move) return;
    enter();
  };
  const change = (next: Face, before: Face, move: boolean) => {
    setFace(next);
    if (!move) return;
    // a new digit rises into the key; a key that became paired lights, its digit fading over to the lit ink with it
    if (next.digit !== before.digit) play(digitEl, [{ opacity: 0, transform: "translateY(70%)" }, { opacity: 1, transform: "none" }], SNAP);
    if (next.bound !== before.bound) {
      play(litEl, [{ opacity: before.bound ? 1 : 0 }, { opacity: next.bound ? 1 : 0 }], FADE);
      if (next.digit === before.digit) play(digitEl, [{ opacity: 0 }, { opacity: 1 }], FADE);
    }
  };
  const leave = (move: boolean) => {
    if (!move) {
      mark(null);
      setFace(null);
      return;
    }
    mark("leaving");
    const at = chip();
    if (at) play(at, [{ translate: ASIDE }, { translate: "0 0" }], SNAP, { delay: STAGGER_MS, fill: "backwards" });
    const out = play(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.6)" }], SNAP, { fill: "forwards" });
    if (!out) {
      mark(null);
      setFace(null);
      return;
    }
    leaving = out;
    void out.finished.then(
      () => {
        if (leaving !== out) return;
        leaving = null;
        mark(null);
        setFace(null);
        out.cancel();
      },
      () => undefined,
    );
  };

  createEffect(
    on(seat, (next, before) => {
      const was = before ?? untrack(face);
      if (next && !was) arrive(next, moving());
      else if (next && was && leaving) arrive(next, moving());
      else if (next && was) change(next, was, moving());
      else if (!next && was && !leaving) leave(moving());
    }, { defer: true }),
  );
  // a key that mounts seated: with the board arriving (the chunk lands on the first `board.here`) it arrives; a window born
  // or drawn again later paints its key in place
  queueMicrotask(() => {
    const now = untrack(face);
    if (!now || !el.isConnected) return;
    mark("seated");
    if (Date.now() - state.board.since < ARRIVING_MS && moving()) {
      enter();
    }
  });
  onCleanup(() => {
    leaving?.cancel();
    mark(null);
  });

  return (
    <span ref={el} class="bkey" data-form={props.form} data-bound={face()?.bound ? "" : undefined} hidden={face() === null} aria-hidden="true">
      <span ref={litEl} class="bkey-lit" />
      <span ref={digitEl} class="bkey-n">
        {face()?.digit ?? ""}
      </span>
    </span>
  );
}

/** a thread menu's item: arms the board so the next digit pressed takes this thread, in the window's own livery */
export function BoardPair(props: { thread: string; colour: RepoColour; onPick: () => void }) {
  // a thread already paired says with which key, and the item offers another
  const kept = () => (state.board.bound[props.thread] ? state.board.digits[props.thread] : undefined);
  const words = () => (kept() === undefined ? "pair with a board key" : "pair with another board key");
  return (
    <button
      role="menuitem"
      aria-label={kept() === undefined ? words() : `${words()}, paired with key ${kept()}`}
      onClick={() => {
        props.onPick();
        void armPin(props.thread, props.colour.light);
      }}
    >
      {words()}
      <Show when={kept()}>{(digit) => <em>paired with key {digit()}</em>}</Show>
    </button>
  );
}

/** how long a settled pairing's line stays */
const PAIRED_MS = 2400;
const NOTE_MS = 5000;

/** what the stage says about a pairing of its thread: calm while it waits for a digit, then what came of it */
export function BoardReceipt(props: { thread: string }) {
  const pin = () => {
    const now = state.board.pin;
    return now && now.key === props.thread ? now : null;
  };
  // each phase lasts as long as it means: an armed one until the server's 30 s are up, then it says nothing was pressed
  createEffect(() => {
    const now = pin();
    if (!now) return;
    const phase = now.phase;
    const wait = phase === "armed" ? Math.max(0, now.until - Date.now()) : phase === "paired" ? PAIRED_MS : NOTE_MS;
    const timer = setTimeout(() => {
      if (state.board.pin?.key !== props.thread || state.board.pin.phase !== phase) return;
      setBoardPin(phase === "armed" ? { key: props.thread, phase: "missed" } : null);
    }, wait);
    onCleanup(() => clearTimeout(timer));
  });
  const words = () => {
    const now = pin();
    switch (now?.phase) {
      case "armed":
        return "press a digit on the board";
      case "paired":
        return `paired with board key ${now.digit}`;
      case "missed":
        return "nothing was pressed. pair again from the thread menu.";
      case "refused":
        return now.why;
      case undefined:
        return "";
      default:
        return now satisfies never;
    }
  };
  return (
    <Show when={pin()}>
      <p class="stage-receipt board-receipt" role="status">
        {words()}
      </p>
    </Show>
  );
}
