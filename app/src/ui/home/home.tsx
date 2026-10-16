/* home: the live windows (docs/design.md, the direction; one layout law
   for three devices; the laws that keep it calm; motion law).

   - the arrangement follows the window's size, never the device: the deck
     under 700 wide, the rail at 1000 and up in landscape, the strip
     between. the stage never empties at strip and rail sizes.
   - the order is the server's inbox. a reorder waits while a finger is on
     the deck and lands 1 s after it lets go, on the snap spring, with the
     window in view kept where it is.
   - motion is spent only on live events in view: a window animates only
     while it is in view, the stream is live and caught up, and nothing is
     replaying. everything else paints in place.
   - opening a window grows it into the thread and floods the ground with
     its colour; back shrinks it into its window. at strip and rail sizes a
     new thread pours out of its window onto the stage.
   - the side columns fold (design.md, one layout law): the rail of
     windows to a column of swatches, the strip's row to a bar of them, and
     the inspector beside the stage away. the stage card's edge glides over
     what leaves and uncovers what arrives (edge.ts); the person's choice is
     kept on this device (remembered.ts). */

import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { flip, insetOf, installMotionProperties, play, prefersReducedMotion, settle } from "../../motion/animate";
import { birth } from "../../motion/fly";
import { FADE, SHEET, SNAP } from "../../motion/springs";
import { openFocus, releaseFocus, setWindowsInView, state } from "../../store";
import { type ThreadPlace, closeThread, openThread, placeInUrl } from "../../sync/client";
import type { Ask } from "../../sync/protocol";
import { extraOf } from "../inbox/extra";
import type { DetailsRoom, InspectorLink, InspectorView } from "../thread/inspector";
import { RepoMark } from "../repo-mark/repo-mark";
import { colourStyle } from "../window/repo";
import { clockOf, type WindowView, windowView } from "../window/view";
import { type Arrangement, Window } from "../window/window";
import { sameOrder, windowKeys } from "./membership";
import { ClearDone, handCleared } from "../window/clear";
import { coveredBy, type StageLayer } from "./layers";
import { openVerdict } from "./stage-open";
import { createCaughtUp } from "../caught-up";
import { repoRootOf } from "../composer/place";
import { moveEdge } from "./edge";
import { Folded, FoldToggle, WINDOWS_ID } from "./fold";
import { strayView } from "./layers";
import { AskSheet, NewThreadSheet, warmOn, whenLoaded } from "../later";
import { arrive, leave, unveil, veil } from "./parts";
import { doing, launchPainted, startPerf, tapped, watchTransition } from "./perf";
import { type Beside, detailsPlace } from "./windows";
import { type FocusState, type InspectorState, type RailState, readFocus, readInspector, readStrip, rememberFocus, rememberInspector, rememberStrip } from "./remembered";
import { Layer } from "./stage";
import { NewThreadDock } from "../composer/dock";
import "../asks/sheet.css";
import "../window/window.css";
import "./home.css";

/** the stream may be down this long before home says so (design.md, honesty) */
const OFFLINE_AFTER_MS = 5000;
/** a reorder lands this long after the last touch or scroll */
const CALM_MS = 1000;
/** idle this long, a question that jumped the deck is glided to */
const GLIDE_IDLE_MS = 4000;
/** the capsule leaves after this */
const CAPSULE_MS = 6000;
/** a window counts as in view when this much of it shows */
const IN_VIEW = 0.35;
/** a layer that shrinks into its window is taken off the stage when its clip is nearly there */
const CLOSED_MS = SHEET.duration * 0.62;

export function arrangementOf(width: number, height: number): Arrangement {
  if (width < 700) return "deck";
  return width >= 1000 && width > height ? "rail" : "strip";
}

export type HomeProps = {
  onMachines: () => void;
  /** the history screen: what was done and cleared (the shell passes it) */
  onHistory?: () => void;
  /** a fixed clock, for the stories: clocks and the 12 hour rule read it instead of the time */
  at?: number;
  /** false in the stories, which have no server to send telemetry to */
  measure?: boolean;
  /** where the folds of the rail and the inspector are remembered: this device's storage, unless a story gives its own, so
      that no story remembers for another */
  memory?: Pick<Storage, "getItem" | "setItem">;
};

export function Home(props: HomeProps) {
  installMotionProperties();
  if (props.measure !== false) onCleanup(startPerf(() => (open() ? "thread" : "home")));

  /* —— the arrangement —— */
  const [size, setSize] = createSignal({ width: innerWidth, height: innerHeight });
  let resizeFrame: number | undefined;
  const onResize = () => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => setSize({ width: innerWidth, height: innerHeight }));
  };
  addEventListener("resize", onResize);
  onCleanup(() => removeEventListener("resize", onResize));
  const arrangement = createMemo(() => arrangementOf(size().width, size().height));
  const wide = () => arrangement() === "rail" && size().width >= 1400;

  /* —— time, the stream, and whether motion is honest —— */
  const [now, setNow] = createSignal(props.at ?? Date.now());
  const clock = setInterval(() => {
    if (!offline() && props.at === undefined) setNow(Date.now());
  }, 1000);
  onCleanup(() => clearInterval(clock));
  const [offline, setOffline] = createSignal(false);
  // the replay after a (re)connect has landed (ui/caught-up.ts, which the stage waits on too)
  const caughtUp = createCaughtUp();
  createEffect(() => {
    const { state: stream, since } = state.stream;
    setOffline(false);
    if (stream === "down") {
      const timer = setTimeout(() => setOffline(true), Math.max(0, since + OFFLINE_AFTER_MS - Date.now()));
      onCleanup(() => clearTimeout(timer));
    }
  });
  const [visible, setVisible] = createSignal(document.visibilityState === "visible");
  const onVisibility = () => setVisible(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
  const motion = () => caughtUp() && visible() && !offline();

  /* —— which windows, in which order; a reorder waits for calm —— */
  const target = createMemo(() => windowKeys(state.fleet, now()), [], { equals: sameOrder });
  const [order, setOrder] = createSignal<string[]>(untrack(target));
  /** which window the deck is on: the index the scroll settled at */
  const [pagerOn, setPagerOn] = createSignal(0);
  const elements = new Map<string, HTMLElement>();
  let touching = false;
  /** when a finger last let go or the deck last scrolled; nothing has yet */
  let lastCalm = Number.NEGATIVE_INFINITY;
  let reorderTimer: ReturnType<typeof setTimeout> | undefined;
  const applyOrder = () => {
    clearTimeout(reorderTimer);
    const next = target();
    if (sameOrder(next, order())) return;
    // the first windows (the cache, or the first snapshot) paint in place, at once
    if (order().length === 0) {
      setOrder(next);
      return;
    }
    // a window the person just cleared has played its own exit: the hole closes at once, not after the calm
    const held = new Set(order());
    const heldNow = (key: string) => state.fleet.sessions[key] !== undefined;
    const left = order().filter((key) => !next.includes(key));
    // a window the fleet no longer holds closes its hole at once too: there is nothing left to keep in place
    const handed = left.length > 0 && left.every((key) => handCleared(key) || !heldNow(key)) && next.every((key) => held.has(key));
    const wait = handed ? 0 : touching ? CALM_MS : lastCalm + CALM_MS - performance.now();
    if (wait > 0) {
      reorderTimer = setTimeout(applyOrder, wait);
      return;
    }
    const anchor = arrangement() === "deck" ? inView()[0] : undefined;
    const anchorEl = anchor ? elements.get(anchor) : undefined;
    const before = anchorEl?.getBoundingClientRect().left ?? 0;
    const born = next.filter((key) => !held.has(key));
    watchTransition("reorder", SNAP.duration, "home");
    // the swatches of a folded rail are windows too: they close up and make room on the same spring
    flip([...elements.values(), ...swatchEls.values()], () => {
      setOrder(next);
      // the window you are looking at never slides away
      if (anchorEl && winsEl && anchorEl.isConnected) winsEl.scrollLeft += anchorEl.getBoundingClientRect().left - before;
    }, SNAP, motion());
    // a thread started anywhere is born where the order puts it, in front of you; the others made room by flip
    for (const key of born) {
      const el = originOf(key);
      if (!el) continue;
      // offscreen windows do not animate; one read of the new window's box decides
      const box = el.getBoundingClientRect();
      birth(el, motion() && box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight);
    }
  };
  /* the target changes inside a reactive update, and solid holds back what a signal set there renders until the
     update ends: flip would read the old dom twice and the born window would not exist yet, so nothing moved. the
     order is applied in a microtask, after the update, where setOrder renders at once (docs/gotchas.md, home) */
  let disposed = false;
  createEffect(
    on(
      target,
      () =>
        queueMicrotask(() => {
          if (!disposed) applyOrder();
        }),
      { defer: true },
    ),
  );
  onCleanup(() => {
    disposed = true;
    clearTimeout(reorderTimer);
  });

  /* —— each window's view, reconciled so unchanged lines keep their identity —— */
  const asksBy = createMemo(() => {
    const by: Record<string, Ask[]> = {};
    for (const ask of Object.values(state.fleet.asks)) (by[ask.key] ??= []).push(ask);
    return by;
  });
  const hosts = createMemo(() => new Set(Object.values(state.fleet.sessions).map((s) => s.host)).size);

  /* —— in view: presence, and where motion is spent —— */
  let winsEl: HTMLDivElement | undefined;
  const [seen, setSeen] = createSignal<ReadonlySet<string>>(new Set());
  const inView = () => order().filter((key) => seen().has(key));
  let observer: IntersectionObserver | undefined;
  const observe = (el: HTMLElement) => observer?.observe(el);
  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        const next = new Set(seen());
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.key;
          if (!key) continue;
          if (entry.isIntersecting) next.add(key);
          else next.delete(key);
        }
        setSeen(next);
      },
      { root: arrangement() === "rail" ? (winsEl ?? null) : null, threshold: IN_VIEW },
    );
    for (const el of elements.values()) observer.observe(el);
  });
  onCleanup(() => observer?.disconnect());
  // behind the deck's stage, or folded to swatches, no window's tail is in view
  createEffect(() => setWindowsInView((open() && arrangement() === "deck") || folded() ? [] : inView()));

  /* —— the stage —— */
  const [open, setOpen] = createSignal<string | null>(null);
  /* the sheet holds the place it opened at: a fleet beat or a reorder while it is open must never rebuild it, or the
     words being typed lose their element and the phone's keyboard drops (the composer would remount) */
  type Place = { host: string; directory: string | null };
  const [sheet, setSheet] = createSignal<Place | null>(null);
  /* a new thread starts where you are looking: the thread on stage, else the window the deck is on (the dock, the
     ambient and the sheet all follow it as you scroll), else the first window, else the first host */
  const startPlace = createMemo<Place | null>(
    () => {
      const list = order();
      const key = open() ?? (arrangement() === "deck" ? list[Math.min(pagerOn(), list.length - 1)] : list[0]);
      const entry = key ? state.fleet.sessions[key] : undefined;
      if (entry) return { host: entry.host, directory: repoRootOf(entry.info) as string | null };
      const host = state.fleet.hostNames[0];
      return host ? { host, directory: null } : null;
    },
    null,
    { equals: (a, b) => a?.host === b?.host && a?.directory === b?.directory },
  );
  /* the sheet lets go of the screen once its first message goes (the native app's decision 21): it stays mounted, holding
     the send, while home is usable under it; the dock says the thread is being made, and a refusal or a tap on the dock
     (or the new thread pill, or ⌘n) brings the same sheet back. `making` is the words the dock shows meanwhile */
  const [away, setAway] = createSignal(false);
  const [making, setMaking] = createSignal<string | null>(null);
  /* the answer sheet over home: every pending ask of one thread, from its window's tray (asks/sheet.tsx) */
  const [askSheet, setAskSheet] = createSignal<{ key: string; from: HTMLElement } | null>(null);
  /** a sheet is on the screen (the new-thread one, mounted and not let go, or the answer sheet): home under it is inert */
  const sheetUp = (): boolean => (sheet() !== null && !away()) || askSheet() !== null;
  const openSheet = () => {
    if (untrack(sheet) && untrack(away)) {
      setAway(false);
      return;
    }
    // the sheet's chunk (ui/later.ts) is in by now unless the press beat the warming; then it opens when it lands
    whenLoaded("NewThreadSheet", () => setSheet(untrack(startPlace)));
  };
  const closeSheet = () => {
    setSheet(null);
    setAway(false);
    setMaking(null);
  };
  const [layers, setLayers] = createSignal<StageLayer[]>([]);
  let layerSerial = 0;
  let stageEl: HTMLElement | undefined;
  const layerEls = new Map<number, HTMLElement>();
  let receded: Animation[] = [];
  let busy = false;
  const [capsule, setCapsule] = createSignal<{ key: string; text: string } | null>(null);

  const behind = () => [barEl, pagerEl, ...[...elements.entries()].filter(([key]) => key !== open()).map(([, el]) => el)].filter((el): el is HTMLElement => el !== undefined);

  const recede = () => {
    receded = behind()
      .map((el) =>
        play(el, [{ transform: "none", opacity: 1 }, { transform: el.classList.contains("win") ? "translateX(40px) scale(.94)" : "scale(.98)", opacity: 0 }], SHEET, {
          fill: "forwards",
        }),
      )
      .filter((a): a is Animation => a !== null);
  };
  const unrecede = () => {
    for (const animation of receded) {
      const el = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      animation.cancel();
      if (el) play(el, [{ transform: el.classList.contains("win") ? "translateX(40px) scale(.94)" : "scale(.98)", opacity: 0 }, { transform: "none", opacity: 1 }], SHEET, { delay: 60, fill: "backwards" });
    }
    receded = [];
  };

  /** the fleet holds this thread: it has an entry to draw */
  const held = (key: string) => state.fleet.sessions[key] !== undefined;
  const pushLayer = (key: string) => {
    const id = ++layerSerial;
    setLayers((list) => [...list, { key, id }]);
    return id;
  };

  /** the deck: the window grows into the stage and its colour floods the screen */
  const growFrom = (key: string, from: HTMLElement, event: Event | null) => {
    if (busy || !stageEl || !held(key)) return;
    askFirst(key);
    busy = true;
    // whatever throws below, the flag lets go: a stuck one made every later tap, back and swap return early
    try {
      growWith(key, from, event);
    } finally {
      setTimeout(() => (busy = false), prefersReducedMotion() ? 0 : SHEET.duration * 0.6);
    }
  };
  const growWith = (key: string, from: HTMLElement, event: Event | null) => {
    if (!stageEl) return;
    batch(() => {
      setOpen(key);
      setLayers([]);
    });
    const id = pushLayer(key);
    openThread(key);
    const layer = layerEls.get(id);
    if (event) tapped(event, controlOf(event, from), "deck", "thread");
    if (layer) {
      const rect = from.getBoundingClientRect();
      from.style.visibility = from.classList.contains("win") ? "hidden" : "";
      play(layer, [{ clipPath: insetOf(rect, stageEl.getBoundingClientRect(), getComputedStyle(from).borderRadius) }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], SHEET, {
        live: true,
        fill: "backwards",
      });
      unveil(layer);
      arrive(layer, "translateY(22px) scale(.975)", 50);
      watchTransition("grow", SHEET.duration, "thread");
    }
    recede();
  };

  /** the deck: back shrinks the thread into its window, which by then shows the tail of what you did */
  const shrink = (event: Event | null, fromTransform?: string) => {
    const key = open();
    if (!key || busy || !stageEl) return;
    busy = true;
    const entry = layers().at(-1);
    const layer = entry ? layerEls.get(entry.id) : undefined;
    const win = elements.get(key);
    // the closing is scheduled whatever the animation does: a throw before it left the thread open and the flag set
    try {
      if (event) tapped(event, "back", "deck", "home");
      if (win) win.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
      if (layer && win) {
        const rect = win.getBoundingClientRect();
        const frames = [
          { clipPath: "inset(0px 0px 0px 0px round 0px)", ...(fromTransform ? { transform: fromTransform } : {}) },
          { clipPath: insetOf(rect, stageEl.getBoundingClientRect(), getComputedStyle(win).borderRadius), ...(fromTransform ? { transform: "none" } : {}) },
        ];
        layer.style.transform = "";
        play(layer, frames, SHEET, { fill: "forwards" });
        leave(layer);
        veil(layer, CLOSED_MS);
        watchTransition(fromTransform ? "back" : "shrink", SHEET.duration, "home");
      }
      unrecede();
    } finally {
      setTimeout(
        () => {
          if (win) win.style.visibility = "";
          batch(() => {
            setOpen(null);
            setLayers([]);
          });
          closeThread();
          busy = false;
          if (keyboard && win) win.querySelector<HTMLElement>(".win-open")?.focus({ preventScroll: true });
          applyOrder();
        },
        prefersReducedMotion() ? 0 : CLOSED_MS,
      );
    }
  };

  /** strip and rail: the thread pours out of its window onto the stage */
  const pour = (key: string, from: HTMLElement, event: Event | null) => {
    // a thread the fleet does not hold has nothing to draw: opening it made the effect that lets go of it open it again
    if (!stageEl || !held(key)) return;
    // the thread is already on the stage: the pill on its window is still a request to go to the ask
    askFirst(key);
    if (open() === key) return;
    const leaving = layers();
    setOpen(key);
    const id = pushLayer(key);
    openThread(key);
    if (event) tapped(event, controlOf(event, from), arrangement(), "thread");
    const layer = layerEls.get(id);
    if (layer) {
      const box = stageEl.getBoundingClientRect();
      const rect = from.getBoundingClientRect();
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      let start: string;
      let drift: string;
      if (arrangement() === "rail") {
        const top = clamp(rect.top - box.top, 0, box.height - 60);
        const bottom = clamp(box.bottom - rect.bottom, 0, box.height - top - 60);
        start = `inset(${top}px ${box.width - 4}px ${bottom}px 0px round 22px)`;
        drift = "translateX(-22px)";
      } else {
        const left = clamp(rect.left - box.left, 0, box.width - 60);
        const right = clamp(box.right - rect.right, 0, box.width - left - 60);
        start = `inset(0px ${right}px ${box.height - 4}px ${left}px round 22px)`;
        drift = "translateY(-22px)";
      }
      play(layer, [{ clipPath: start }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], SHEET, { fill: "backwards" });
      arrive(layer, drift, 60);
      watchTransition("pour", SHEET.duration, "thread");
    }
    for (const old of leaving) {
      const el = layerEls.get(old.id);
      if (el) play(el, [{ opacity: 1, transform: "none" }, { opacity: 0.35, transform: "scale(.985)" }], { duration: SHEET.duration, easing: "ease-out" }, { fill: "forwards" });
    }
    setTimeout(() => setLayers((list) => list.filter((l) => !leaving.includes(l))), prefersReducedMotion() ? 0 : SHEET.duration);
  };

  /** a thread that asks opens with its ask in front, as a push tap opens it: the stage goes to the card and focuses it
      (thread/stage.tsx, goToAsk). the window, its "answer" pill, the bar's "wants you" and the capsule all come through the
      transitions below, which call this once they have decided to go: a tap one of them refuses (a transition running) leaves
      no focus behind to send the stage somewhere at its next turn */
  const askFirst = (key: string) => {
    const ask = asksBy()[key]?.[0];
    if (ask) openFocus({ thread: key, ask: ask.id, push: null });
  };

  /** what was tapped, for perf.paint: the capsule, the window's "answer" pill, or the window */
  const controlOf = (event: Event, from: HTMLElement) =>
    from.classList.contains("capsule") ? "capsule" : event.target instanceof Element && event.target.closest(".wask, .asks-open") ? "answer" : "window";

  const activate = (key: string, from: HTMLElement, event: Event | null) => {
    setCapsule(null);
    if (arrangement() !== "deck") pour(key, from, event);
    else if (!open()) growFrom(key, from, event);
    else if (open() !== key) swap(key, from, event);
  };

  /** a thread just started from the sheet: the stage opens on it, growing from the sheet's window like a tap on a window */
  const openBorn = (key: string, from: HTMLElement) => {
    // a sheet that let go is off the screen: the thread grows from the dock that said it was being made, where there is one
    const dock = untrack(away) ? document.querySelector<HTMLElement>(".home-dock .cz-dock") : null;
    activate(key, dock ?? from, null);
    // a transition still running refuses the grow: the thread opens in place rather than not at all
    if (open() !== key) openThread(key);
  };

  /** the deck with a thread open: the capsule swaps the stage (the current thread shrinks away, the other grows in) */
  const swap = (key: string, from: HTMLElement, event: Event | null) => {
    if (busy || !stageEl || !held(key)) return;
    askFirst(key);
    const previous = open();
    const leaving = layers();
    if (previous) {
      const oldWin = elements.get(previous);
      if (oldWin) oldWin.style.visibility = "";
    }
    setOpen(key);
    const id = pushLayer(key);
    openThread(key);
    if (event) tapped(event, "capsule", "deck", "thread");
    const layer = layerEls.get(id);
    if (layer) {
      play(layer, [{ clipPath: insetOf(from.getBoundingClientRect(), stageEl.getBoundingClientRect(), "25px") }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], SHEET, { fill: "backwards" });
      unveil(layer);
      arrive(layer, "translateY(-14px)", 60);
      watchTransition("capsule", SHEET.duration, "thread");
    }
    for (const old of leaving) {
      const el = layerEls.get(old.id);
      if (el) play(el, [{ transform: "none", opacity: 1 }, { transform: "scale(.93)", opacity: 0 }], SHEET, { fill: "forwards" });
    }
    const win = elements.get(key);
    if (win) win.style.visibility = "hidden";
    setTimeout(() => setLayers((list) => list.filter((l) => !leaving.includes(l))), prefersReducedMotion() ? 0 : SHEET.duration * 0.7);
  };

  /* —— the side columns (design.md, one layout law): the strip's row folds to its bar of swatches, the rail folds to its
     column of them while the details need the room, either is put away for focus, the inspector folds away. what the person
     chose is kept on this device. the layout trails it while the stage card's edge glides over what leaves and uncovers
     what arrives (edge.ts), and a move is never started on another —— */
  const [stripChoice, setStripChoice] = createSignal<RailState>(readStrip(props.memory));
  const [focusChoice, setFocusChoice] = createSignal<FocusState>(readFocus(props.memory));
  /** the committed layout: the windows are put away and the card has the screen */
  const [windowsHidden, setWindowsHidden] = createSignal(untrack(focusChoice) === "hidden");
  /** the committed layout of the strip: its row is a bar of swatches */
  const [stripFolded, setStripFolded] = createSignal(untrack(stripChoice) === "folded");
  const [inspectorChoice, setInspectorChoice] = createSignal<InspectorState>(readInspector(props.memory));
  /** the committed layout: the rail is a column of swatches (only ever for the details' room), and the inspector's column is
      laid out beside the stage */
  const [railFolded, setRailFolded] = createSignal(false);
  const [inspectorShown, setInspectorShown] = createSignal(untrack(inspectorChoice) !== "folded");
  const inspectorViewOf = (choice: InspectorState): InspectorView | null => (choice === "folded" ? null : choice);
  /** what the inspector holds: it keeps its view until the card has covered it, and has its view before the card uncovers it */
  const [inspectorView, setInspectorView] = createSignal<InspectorView | null>(inspectorViewOf(untrack(inspectorChoice)));
  const [moving, setMoving] = createSignal<"rail" | "strip" | "windows" | "inspector" | null>(null);
  const [inspectorEl, setInspectorEl] = createSignal<HTMLElement>();
  let edgeMove: { stop: () => void } | null = null;
  let liftEl: HTMLElement | undefined;
  let rimEl: HTMLElement | undefined;
  let capEl: HTMLElement | undefined;
  let foldEl: HTMLElement | undefined;
  /** the swatches of the fold, by window */
  const swatchEls = new Map<string, HTMLElement>();
  /** the windows of this arrangement are folded to their swatches */
  const folded = () => (arrangement() === "rail" && railFolded()) || (arrangement() === "strip" && stripFolded());
  /** the open bar and windows cannot be reached: they are folded, or on their way to or from being */
  const railOff = () => arrangement() !== "deck" && (folded() || windowsHidden() || moving() === arrangement() || moving() === "windows");
  /** the arrangement that keeps the windows beside the stage, for the toggle's glyph */
  const beside = (): Beside => (arrangement() === "strip" ? "strip" : "rail");
  /** where a window is for the person: its swatch while the rail is folded */
  const originOf = (key: string) => (folded() ? swatchEls : elements).get(key);

  const glide = (kind: "rail" | "strip" | "windows" | "inspector", grow: boolean, layout: (end: boolean) => void, columns: { leaving: HTMLElement[]; arriving: HTMLElement[] }, after: () => void) => {
    if (!stageEl || !liftEl || !rimEl || !capEl) {
      layout(true);
      after();
      return;
    }
    setMoving(kind);
    const handle = moveEdge({
      card: stageEl,
      lift: liftEl,
      rim: { ring: rimEl, cap: capEl },
      side: kind === "rail" || (kind === "windows" && arrangement() === "rail") ? "left" : kind === "inspector" ? "right" : "top",
      grow,
      layout,
      ...columns,
      settled: () => {
        edgeMove = null;
        setMoving(null);
        after();
      },
    });
    // a move that finished before it returned (reduced motion) has nothing left to stop
    if (moving() !== null) edgeMove = handle;
  };
  /* —— the details below the inspector's width (windows.ts, detailsPlace): docked where the column keeps its least width, a
     sheet where it does not. the open rail gives way first: details that fit only beside the folded rail fold it while they
     are open, and give it back when they close; asking the windows back closes them —— */
  const place = createMemo(() => detailsPlace(arrangement(), size().width, windowsHidden()));
  const [detailsCloses, setDetailsCloses] = createSignal(0);
  /** folds or opens the rail; `after` once the card's edge has settled */
  const moveRail = (folding: boolean, after: () => void) => {
    const swatches = foldEl ? [foldEl] : [];
    const open = [barEl, winsEl].filter((el): el is HTMLElement => el !== undefined);
    const leaving = folding ? open : swatches;
    const focused = leaving.some((el) => el.contains(document.activeElement));
    glide("rail", folding, (end) => setRailFolded(folding ? end : !end), { leaving, arriving: folding ? swatches : open }, () => {
      if (focused) (folding ? foldEl : barEl)?.querySelector<HTMLElement>(".fold-toggle")?.focus({ preventScroll: true });
      after();
    });
  };
  const room: DetailsRoom = {
    docks: () => place().docks,
    make: (open, go) => {
      if (open && place().foldsRail && arrangement() === "rail" && !railFolded() && moving() === null) {
        moveRail(true, go);
        return;
      }
      go();
      if (!open && railFolded() && arrangement() === "rail" && moving() === null) moveRail(false, () => undefined);
    },
    closes: detailsCloses,
  };
  /** the rail's toggle: open, it puts the windows away (focus); folded for the details, it asks the windows back, which
      closes the details and opens the rail (the native app's stripux) */
  const toggleRail = () => {
    if (arrangement() !== "rail" || moving() !== null) return;
    if (!railFolded()) {
      toggleFocus();
      return;
    }
    setDetailsCloses((n) => n + 1);
    moveRail(false, () => undefined);
  };
  /** the windows put away, or brought back (focus, ⇧⌘F, the stage bar's own toggle while they are away): the card's edge
      on their side glides over all of them, open or folded, and the choice is kept on this device */
  const toggleFocus = () => {
    if (arrangement() === "deck" || moving() !== null) return;
    const hiding = focusChoice() === "shown";
    const choice: FocusState = hiding ? "hidden" : "shown";
    setFocusChoice(choice);
    rememberFocus(choice, props.memory);
    const shown = (folded() ? [foldEl] : [barEl, winsEl]).filter((el): el is HTMLElement => el !== undefined);
    // details that will not fit beside the windows coming back close, rather than turn into a sheet or crowd the column
    const beside = detailsPlace(arrangement(), size().width, false);
    if (!hiding && (!beside.docks || beside.foldsRail)) setDetailsCloses((n) => n + 1);
    const focused = document.activeElement?.closest(".stage-bar .windows-toggle") !== null || shown.some((el) => el.contains(document.activeElement));
    glide("windows", hiding, (end) => setWindowsHidden(hiding ? end : !end), { leaving: hiding ? shown : [], arriving: hiding ? [] : shown }, () => {
      if (!focused) return;
      const to = hiding ? stageEl?.querySelector<HTMLElement>(".stage-bar .windows-toggle") : (folded() ? foldEl : barEl)?.querySelector<HTMLElement>(".fold-toggle");
      to?.focus({ preventScroll: true });
    });
  };
  /** the strip's row folds to its bar of swatches and back: the card's top edge glides, and the bar takes the open bar's
      place, its toggle where the open one was */
  const toggleStrip = () => {
    if (arrangement() !== "strip" || moving() !== null) return;
    const folding = stripChoice() === "open";
    const choice: RailState = folding ? "folded" : "open";
    setStripChoice(choice);
    rememberStrip(choice, props.memory);
    const swatches = foldEl ? [foldEl] : [];
    const open = [barEl, winsEl].filter((el): el is HTMLElement => el !== undefined);
    const focused = (folding ? open : swatches).some((el) => el.contains(document.activeElement));
    glide("strip", folding, (end) => setStripFolded(folding ? end : !end), { leaving: folding ? open : swatches, arriving: folding ? swatches : open }, () => {
      if (focused) (folding ? foldEl : barEl)?.querySelector<HTMLElement>(".fold-toggle")?.focus({ preventScroll: true });
    });
  };
  /** the windows' one control, whichever arrangement has it: put away, they come back */
  const toggleWindows = () => (windowsHidden() ? toggleFocus() : arrangement() === "strip" ? toggleStrip() : toggleRail());
  /** shows a view, or folds the inspector away (null). a move to or from folded glides the card's right edge; a change of view
      only swaps what the inspector holds */
  const showInspector = (view: InspectorView | null) => {
    if (arrangement() !== "rail" || !wide() || moving() !== null) return;
    const choice: InspectorState = view ?? "folded";
    if (choice === inspectorChoice()) return;
    const opening = inspectorChoice() === "folded";
    setInspectorChoice(choice);
    rememberInspector(choice, props.memory);
    if (!opening && view !== null) {
      setInspectorView(view);
      return;
    }
    const aside = inspectorEl();
    const column = aside ? [aside] : [];
    if (opening) setInspectorView(view);
    glide("inspector", !opening, (end) => setInspectorShown(opening ? end : !end), { leaving: opening ? [] : column, arriving: opening ? column : [] }, () => {
      if (!opening) setInspectorView(null);
    });
  };
  const inspector: InspectorLink = { el: inspectorEl, view: inspectorView, show: showInspector };
  /* a resize across an arrangement or the 1400 line rebuilds the layout from the choice, in place */
  createEffect(
    on(
      [arrangement, wide],
      () => {
        edgeMove?.stop();
        setRailFolded(false);
        setWindowsHidden(focusChoice() === "hidden");
        setStripFolded(stripChoice() === "folded");
        setInspectorShown(inspectorChoice() !== "folded");
        setInspectorView(inspectorViewOf(inspectorChoice()));
      },
      { defer: true },
    ),
  );
  onCleanup(() => edgeMove?.stop());

  /** an agent's thread opens as its own stage over its parent's (design.md, the transcript): the new layer slides in
      from the right and the parent's recedes under it, still mounted, so back finds it exactly where it was */
  const parentOf = (key: string) => { const entry = state.fleet.sessions[key]; const parent = entry?.info.parentID; return parent ? `${entry.host}:${parent}` : null; };
  const stackedPlaces = new Map<string, ThreadPlace>();
  /* agents opened from their parent whose session the fleet does not hold (a spawn-only agent: the fleet holds each host's
     newest threads, and an agent can be older than them or never listed): their layer is drawn from the parent's view,
     named by the row that opened it, as the native app's ThreadAgentStack.introduce does, and the stage reads the thread by
     its key. the effect that lets go of a departed thread leaves them alone, since the fleet never held them */
  const [strays, setStrays] = createSignal<ReadonlyMap<string, { name: string | null; parent: string }>>(new Map());
  // a stray is kept while its layer is on the stage, and no longer
  createEffect(() => {
    const on = new Set(layers().map((l) => l.key));
    const all = untrack(strays);
    if ([...all.keys()].some((k) => !on.has(k))) setStrays(new Map([...all].filter(([k]) => on.has(k))));
  });
  const openAgent = (key: string, name?: string) => {
    const under = open();
    if (!under || under === key || !stageEl) return;
    if (!held(key)) {
      if (!held(under)) return;
      setStrays((all) => new Map(all).set(key, { name: name?.trim() || null, parent: under }));
    }
    stackedPlaces.set(under, placeInUrl());
    setOpen(key);
    const id = ++layerSerial;
    setLayers((list) => [...list, { key, id, over: under }]);
    openThread(key);
    const layer = layerEls.get(id);
    const beneath = layers().find((l) => l.key === under);
    const beneathEl = beneath ? layerEls.get(beneath.id) : undefined;
    if (layer) {
      play(layer, [{ transform: "translateX(100%)" }, { transform: "none" }], SHEET, { live: true, fill: "backwards" });
      watchTransition("agent", SHEET.duration, "thread");
    }
    if (beneathEl) play(beneathEl, [{ transform: "none", opacity: 1 }, { transform: "scale(.96)", opacity: 0.5 }], SHEET, { fill: "forwards" });
  };
  const backFromAgent = (event: Event | null, fromTransform?: string) => {
    const top = layers().at(-1);
    if (!top?.over || busy) return;
    busy = true;
    const under = top.over;
    const layer = layerEls.get(top.id);
    const beneath = layers().find((l) => l.key === under);
    const beneathEl = beneath ? layerEls.get(beneath.id) : undefined;
    if (event) tapped(event, "back", arrangement(), "thread");
    if (layer) {
      layer.style.transform = "";
      play(layer, [{ transform: fromTransform ?? "none" }, { transform: "translateX(100%)" }], SHEET, { fill: "forwards" });
      watchTransition("agent-back", SHEET.duration, "thread");
    }
    if (beneathEl) play(beneathEl, [{ transform: "scale(.96)", opacity: 0.5 }, { transform: "none", opacity: 1 }], SHEET, { fill: "forwards" });
    setOpen(under);
    openThread(under, stackedPlaces.get(under) ?? {});
    stackedPlaces.delete(under);
    setTimeout(() => {
      setLayers((list) => list.filter((l) => l.id !== top.id));
      busy = false;
    }, prefersReducedMotion() ? 0 : SHEET.duration * 0.7);
  };
  /** back from an agent's thread that was opened on its own (a link, a relaunch): its parent takes its place */
  const swapToParent = (key: string) => {
    const parent = parentOf(key);
    if (!parent || !held(parent)) return false;
    const leaving = layers();
    setOpen(parent);
    const id = ++layerSerial;
    setLayers((list) => [...list, { key: parent, id }]);
    openThread(parent);
    const layer = layerEls.get(id);
    if (layer) play(layer, [{ opacity: 0 }, { opacity: 1 }], FADE, { fill: "backwards" });
    for (const old of leaving) {
      const el = layerEls.get(old.id);
      if (el) play(el, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
    }
    setTimeout(() => setLayers((list) => list.filter((l) => !leaving.includes(l))), prefersReducedMotion() ? 0 : FADE.duration);
    return true;
  };
  const layerBack = (entry: { key: string; over?: string }, event: Event) => {
    if (entry.over) backFromAgent(event);
    else if (!swapToParent(entry.key)) shrink(event);
  };

  /* a thread opened from outside (a relaunch restoring the url, a push tap, the verification drive) paints in
     place: no motion for anything that did not happen in front of you */
  createEffect(() => {
    const key = state.openThread;
    if (!key || key === untrack(open)) return;
    // open() without a layer that renders leaves the windows and the dock inert on the deck and every tap dead: a
    // thread opens only once the fleet holds it, and one it never brings (archived, another install's url) is let go
    const verdict = openVerdict(state.fleet.sessions[key] !== undefined, caughtUp());
    if (verdict === "wait") return;
    if (verdict === "drop") {
      // no stage will come for it, so none will take the ask a push named there: it is let go, not left for a thread opened later
      if (state.focus?.thread === key) releaseFocus(state.focus);
      closeThread();
      return;
    }
    untrack(() => {
      const win = elements.get(key);
      if (arrangement() === "deck" && win) win.style.visibility = "hidden";
      batch(() => {
        setOpen(key);
        setLayers([{ key, id: ++layerSerial }]);
      });
    });
  });

  /* the thread on stage left the fleet (archived elsewhere, the host forgot it): its layer is gone with it, so the
     stage lets go and the windows come back, rather than staying inert under nothing */
  createEffect(() => {
    const key = open();
    if (!key || !caughtUp() || state.fleet.sessions[key] !== undefined || strays().has(key)) return;
    untrack(() => {
      // an agent's thread that left (archived under you) goes back to its parent, which is still on the stage under it,
      // not home: the parent is what you were reading
      const top = layers().at(-1);
      if (top?.over && top.key === key && held(top.over)) {
        busy = false;
        backFromAgent(null);
        return;
      }
      for (const el of elements.values()) el.style.visibility = "";
      for (const animation of receded) animation.cancel();
      receded = [];
      busy = false;
      batch(() => {
        setOpen(null);
        setLayers([]);
      });
      closeThread();
    });
  });

  /* strip and rail: the stage never empties */
  createEffect(() => {
    // the first window the fleet still holds: `order()` trails the fleet by the calm, so its first key can be a thread that
    // has just left, and pouring it was the loop that froze the page
    const first = order().find(held);
    if (arrangement() !== "deck" && open() === null && first) {
      const el = elements.get(first);
      if (el) untrack(() => pour(first, el, null));
    }
  });
  /* moving between arrangements rebuilds the stage for the new one, in place */
  createEffect(
    on(
      arrangement,
      (now, before) => {
        if (!before) return;
        for (const el of elements.values()) el.style.visibility = "";
        for (const animation of receded) animation.cancel();
        receded = [];
        busy = false;
        const key = open();
        if (now === "deck") {
          batch(() => {
            setOpen(null);
            setLayers([]);
          });
          closeThread();
        } else if (key) {
          setLayers([{ key, id: ++layerSerial }]);
        }
      },
      { defer: true },
    ),
  );

  /* —— the back gesture: follows the finger, can be abandoned, lands in the window —— */
  const wireGesture = (edge: HTMLElement | undefined, header: HTMLElement) => {
    type Drag = { axis: "x" | "y"; start: number; last: number; lastAt: number; velocity: number; moved: boolean; progress: number };
    let drag: Drag | null = null;
    const layer = () => {
      const entry = layers().at(-1);
      return entry ? layerEls.get(entry.id) : undefined;
    };
    const down = (event: PointerEvent, axis: "x" | "y") => {
      if (arrangement() !== "deck" || busy || event.button > 0) return;
      if (axis === "y" && (event.target as Element).closest("button")) return;
      const at = axis === "x" ? event.clientX : event.clientY;
      drag = { axis, start: at, last: at, lastAt: event.timeStamp, velocity: 0, moved: false, progress: 0 };
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      const el = layer();
      if (!drag || !el) return;
      const at = drag.axis === "x" ? event.clientX : event.clientY;
      drag.velocity = (at - drag.last) / Math.max(1, event.timeStamp - drag.lastAt);
      drag.last = at;
      drag.lastAt = event.timeStamp;
      const distance = Math.max(0, at - drag.start);
      if (distance > 4 && !drag.moved) {
        drag.moved = true;
        for (const animation of receded) animation.pause();
      }
      if (!drag.moved) return;
      const span = drag.axis === "x" ? innerWidth : innerHeight;
      drag.progress = Math.min(1, distance / span);
      el.style.transform = drag.axis === "x" ? `translateX(${distance * 0.8}px) scale(${1 - drag.progress * 0.14})` : `translateY(${distance * 0.7}px) scale(${1 - drag.progress * 0.14})`;
      for (const animation of receded) animation.currentTime = SHEET.duration * Math.max(0, 1 - drag.progress * 1.6);
    };
    const up = (event: PointerEvent) => {
      const el = layer();
      const was = drag;
      drag = null;
      if (!was?.moved || !el) return;
      const from = el.style.transform;
      if (was.progress > 0.28 || was.velocity > 0.55) {
        // an agent's layer slides back to its parent; a window's shrinks home
        if (layers().at(-1)?.over) backFromAgent(event, from);
        else shrink(event, from);
        return;
      }
      el.style.transform = "";
      play(el, [{ transform: from }, { transform: "none" }], SNAP);
      for (const animation of receded) animation.play();
    };
    for (const [el, axis] of [
      [edge, "x"],
      [header, "y"],
    ] as const) {
      if (!el) continue;
      el.addEventListener("pointerdown", (event) => down(event, axis));
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    }
  };

  /* —— a question arrives: the capsule, the cue, the glide —— */
  let lastInput = performance.now();
  let keyboard = false;
  const [cue, setCue] = createSignal<string | null>(null);
  let capsuleTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(capsuleTimer));
  /* the asks home has seen. `on` with `defer` hands its handler nothing as the value before the first change, so the first ask to
     arrive after home mounted had no capsule, no cue and no glide; the value before is kept here, from the first look */
  let askKeys = untrack(() => Object.keys(asksBy()));
  createEffect(
    on(
      () => Object.keys(asksBy()),
      (keys) => {
        const before = askKeys;
        askKeys = keys;
        if (!motion()) return;
        const fresh = keys.filter((key) => !before.includes(key));
        const key = fresh[0];
        if (!key) return;
        const view = viewOf(key);
        if (!view?.ask) return;
        if (arrangement() === "deck" && open() && open() !== key) {
          setCapsule({ key, text: view.ask.text });
          clearTimeout(capsuleTimer);
          capsuleTimer = setTimeout(() => setCapsule(null), CAPSULE_MS);
          return;
        }
        if (arrangement() === "deck" && !open() && !seen().has(key)) {
          // after the reorder lands: glide if you have been still, otherwise the edge glows and the top line says who
          setTimeout(() => {
            if (seen().has(key)) return;
            if (performance.now() - lastInput > GLIDE_IDLE_MS) elements.get(key)?.scrollIntoView({ inline: "center", block: "nearest", behavior: prefersReducedMotion() ? "instant" : "smooth" });
            else setCue(key);
          }, CALM_MS + 100);
        }
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    const key = cue();
    if (key && seen().has(key)) setCue(null);
  });

  /* —— input: calm, and who is driving —— */
  const onInput = (event: Event) => {
    lastInput = performance.now();
    if (event.type === "keydown") keyboard = true;
    else if (event.type === "pointerdown") keyboard = false;
  };
  const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  for (const name of inputs) addEventListener(name, onInput, { capture: true, passive: true });
  onCleanup(() => {
    for (const name of inputs) removeEventListener(name, onInput, { capture: true });
  });
  const release = () => {
    touching = false;
    lastCalm = performance.now();
  };
  addEventListener("pointerup", release);
  addEventListener("pointercancel", release);
  onCleanup(() => {
    removeEventListener("pointerup", release);
    removeEventListener("pointercancel", release);
  });
  const onKey = (event: KeyboardEvent) => {
    const typing = event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]");
    if (event.key === "Escape" && arrangement() === "deck" && open()) {
      // escape is back: from an agent's stage to its parent, from a window's stage home
      const top = layers().at(-1);
      if (top) layerBack(top, event);
      else shrink(event);
      return;
    }
    // ⌘n starts a thread from anywhere, typing included (a browser tab keeps it, the installed app does not). only the
    // command key: control-n is the emacs next-line in every text field on a mac, and a browser keeps it for a new window
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n" && startPlace() && !sheetUp()) {
      event.preventDefault();
      openSheet();
      return;
    }
    if (typing) return;
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "n" && startPlace() && !sheetUp()) {
      event.preventDefault();
      openSheet();
      return;
    }
    // ⇧⌘F puts the windows away and brings them back at the strip and the rail, typing or not (the native app's windows menu)
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && !event.repeat && event.key.toLowerCase() === "f" && arrangement() !== "deck" && !sheetUp()) {
      event.preventDefault();
      toggleFocus();
      return;
    }
    // `[` is the windows' toggle at the strip and the rail, `]` the inspector at the rail; a held key is one press
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat && arrangement() !== "deck" && !sheetUp()) {
      if (event.key === "[") {
        event.preventDefault();
        toggleWindows();
        return;
      }
      if (event.key === "]" && arrangement() === "rail" && wide()) {
        event.preventDefault();
        showInspector(inspectorChoice() === "folded" ? "details" : null);
        return;
      }
    }
    const position = /^Digit([1-9])$/.exec(event.code)?.[1];
    if (event.altKey && position) {
      const key = order()[Number(position) - 1];
      const el = key ? originOf(key) : undefined;
      if (key && el) {
        event.preventDefault();
        activate(key, el, event);
      }
      return;
    }
    if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const list = order();
      const at = list.indexOf(open() ?? "");
      const key = list[Math.max(0, Math.min(list.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
      const el = key ? originOf(key) : undefined;
      if (key && el) {
        event.preventDefault();
        activate(key, el, event);
      }
    }
  };
  addEventListener("keydown", onKey);
  onCleanup(() => removeEventListener("keydown", onKey));

  /* —— the bar's line —— */
  /** a thread is on the stage and its layer renders: only then is what is under it inert. `open()` alone is not enough
      (the thread may have left the fleet while the stream was down, and a layer is drawn only for an entry), or the deck
      is inert under nothing until the stream catches up */
  const staged = () => {
    const key = open();
    return key !== null && layers().some((layer) => layer.key === key) && viewOf(key) !== null;
  };
  const views = createMemo(() => order().map(viewOf).filter((v): v is WindowView => v !== null));
  const summary = createMemo(() => {
    const all = views();
    const wants = all.filter((v) => v.state === "wants");
    const working = all.filter((v) => v.state === "working" || v.state === "queued").length;
    // a count per word: done is a finished turn nobody has seen, idle one that has been seen (or never ran), and
    // "clear N" takes both, so N is the two added (clearing.ts, doneKeys)
    const done = all.filter((v) => v.state === "done").length;
    const idle = all.filter((v) => v.state === "idle").length;
    const rest = [working ? `${working} working` : "", done ? `${done} done` : "", idle ? `${idle} idle` : ""].filter(Boolean);
    return { wants, rest };
  });

  /* a count that changes in front of you settles in from the soft blur, as a streamed word does; the line as it was
     painted, or as the screen came up, does not move */
  const upAt = performance.now();
  const partIn = (el: HTMLElement) => settle(el, motion() && performance.now() - upAt > 800);

  /* —— updates: a new build waits for the next cold launch —— */
  const [updateReady, setUpdateReady] = createSignal(false);
  onMount(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistration("/").then((registration) => {
      if (!registration) return;
      const check = () => setUpdateReady(registration.waiting !== null && navigator.serviceWorker.controller !== null);
      check();
      registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", check));
    });
  });

  /* —— first paint —— */
  // the first frame that shows windows, or, with nothing running anywhere, the empty deck once the stream caught up
  createEffect(() => {
    const count = order().length;
    if (count > 0 || caughtUp()) launchPainted(state.stream.state !== "live", count);
  });
  createEffect(() => {
    if (Object.values(state.fleet.sessions).some((s) => s.status?.type === "busy")) doing("streaming", 2000);
  });

  let barEl: HTMLElement | undefined;
  let pagerEl: HTMLDivElement | undefined;
  const onScroll = () => {
    lastCalm = performance.now();
    doing("scrolling", 400);
    if (arrangement() !== "deck" || !winsEl) return;
    const mid = winsEl.scrollLeft + winsEl.clientWidth / 2;
    const list = order();
    const index = list.findIndex((key) => {
      const el = elements.get(key);
      return el ? Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid) < el.offsetWidth / 2 + 6 : false;
    });
    if (index >= 0) setPagerOn(index);
  };

  function viewOf(key: string): WindowView | null {
    const entry = state.fleet.sessions[key];
    return entry ? windowView(entry, asksBy()[key] ?? [], extraOf(entry)) : null;
  }
  /** what a stage layer draws: its window's view, or for an agent the fleet does not hold, its parent's view under the
      agent's key and the name of the row that opened it (its session id when the row had none) */
  function layerView(key: string): WindowView | null {
    const own = viewOf(key);
    if (own) return own;
    const stray = strays().get(key);
    const parent = stray ? viewOf(stray.parent) : null;
    if (!stray || !parent) return null;
    return strayView(parent, key, stray.name);
  }
  /** the repo's colours for what draws one on the ground itself (home.css, `--ink`); none for a window the fleet has let go */
  const colourOfKey = (key: string): Record<string, string> => {
    const view = viewOf(key);
    return view ? colourStyle(view.colour) : {};
  };
  const ambientColour = () => colourOfKey(order()[pagerOn()] ?? "");
  /** the card's own colour for its shadow and rim (home.css): the thread on top of the stage */
  const stageColour = (): Record<string, string> => {
    const view = layerView(layers().at(-1)?.key ?? "");
    return view ? colourStyle(view.colour) : {};
  };

  return (
    <div
      class="home"
      data-arrangement={arrangement()}
      data-rail={railFolded() ? "folded" : "open"}
      data-strip={stripFolded() ? "folded" : "open"}
      data-windows={windowsHidden() ? "hidden" : "shown"}
      data-inspector={wide() && inspectorShown() ? "shown" : "hidden"}
      data-moving={moving() ?? undefined}
      data-open={open() && arrangement() === "deck" ? "" : undefined}
    >
      <Show when={arrangement() === "deck"}>
        <div class="ambient" aria-hidden="true" style={ambientColour()} />
      </Show>
      <header class="bar" ref={barEl} inert={(arrangement() === "deck" && staged()) || sheetUp() || railOff()}>
        <span class="mark">boxbox</span>
        <span class="grow" />
        <p class="sum" aria-live="polite">
          <Show
            when={!offline()}
            fallback={
              <span class="off">
                offline
                <Show when={state.stream.lastEventAt}>{(at) => <>, last update {clockOf(at())}</>}</Show>
              </span>
            }
          >
            {/* one phrase: each part holds its words and its comma together and the parts are joined by spaces, so a
                narrow bar wraps between parts and no line starts with punctuation. a button is always a box of its
                own on the line, so a comma after it could be left alone on the next line when its text wraps: the
                comma is drawn inside the button, out of its name */}
            <Show when={summary().wants[0]}>
              {(first) => {
                const words = () => (summary().wants.length > 1 ? `${summary().wants.length} want you` : `${first().repo} wants you`);
                return (
                  <span class="part" ref={partIn}>
                    <button
                      class="call"
                      type="button"
                      aria-label={words()}
                      style={colourStyle(first().colour)}
                      onClick={(event) => {
                        const el = elements.get(first().key);
                        if (el) activate(first().key, el, event);
                      }}
                    >
                      {words()}
                      <Show when={summary().rest.length}>
                        <span class="comma" aria-hidden="true">,</span>
                      </Show>
                    </button>
                  </span>
                );
              }}
            </Show>
            <For each={summary().rest}>
              {(part, i) => (
                <>
                  {i() > 0 || summary().wants.length > 0 ? " " : ""}
                  <span class="part" ref={partIn}>{i() < summary().rest.length - 1 ? `${part},` : part}</span>
                </>
              )}
            </For>
            <Show when={!summary().wants.length && !summary().rest.length && order().length > 0}><span class="part">all quiet</span></Show>
          </Show>
          <Show when={updateReady()}>
            <span class="update">update ready. it applies the next time boxbox opens.</span>
          </Show>
        </p>
        {/* what you do, then where you go: the bar is three rows on the rail by rule (home.css), so a pill never wraps by
            chance at some count. the phone's deck has no row for what you do: new thread is a round plus beside history and
            machines, and clear N sits at the end of the line's row */}
        <div class="pills acts">
          <Show when={arrangement() !== "deck" && startPlace()}>
            <button class="pill new" type="button" aria-label="new thread" aria-keyshortcuts="Meta+N" onPointerDown={warmOn("NewThreadSheet")} onClick={openSheet}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span class="new-word" aria-hidden="true">new thread</span>
            </button>
          </Show>
          <ClearDone views={views()} />
        </div>
        <div class="pills nav">
          <Show when={props.onHistory}>
            {(history) => (
              <Show
                when={arrangement() === "deck"}
                fallback={
                  <button class="pill" type="button" data-opens={folded() ? undefined : "history"} onClick={() => history()()}>
                    history
                  </button>
                }
              >
                {/* the deck's row has no room for the word beside three marks: history is the clock, as on the folded rail */}
                <button class="pill icon" type="button" aria-label="history" data-opens={folded() ? undefined : "history"} onClick={() => history()()}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.8" />
                    <path d="M4.5 4.5v4.3h4.3" />
                    <path d="M12 8v4.3l2.7 1.7" />
                  </svg>
                </button>
              </Show>
            )}
          </Show>
          {/* data-opens: coming back from the machines, a keyboard's focus lands here again (app/src/shell) */}
          <button class="pill icon" type="button" aria-label="machines" data-opens={folded() ? undefined : "machines"} onClick={() => props.onMachines()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4.5" width="16" height="6.5" rx="2.2" />
              <rect x="4" y="13" width="16" height="6.5" rx="2.2" />
              <path d="M8 7.75h.01M8 16.25h.01" />
            </svg>
          </button>
          <Show when={arrangement() === "deck" && startPlace()}>
            <button class="pill icon new" type="button" aria-label="new thread" aria-keyshortcuts="Meta+N" onPointerDown={warmOn("NewThreadSheet")} onClick={openSheet}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </Show>
          <Show when={arrangement() !== "deck"}>
            <FoldToggle form={beside()} state="open" onToggle={toggleWindows} />
          </Show>
        </div>
      </header>
      <div
        class="wins"
        id={arrangement() !== "deck" ? WINDOWS_ID : undefined}
        ref={winsEl}
        aria-label="live threads"
        inert={(arrangement() === "deck" && staged()) || sheetUp() || railOff()}
        onPointerDown={() => (touching = true)}
        onScroll={onScroll}
      >
        <For each={order()} fallback={<Empty />}>
          {(key, index) => <Slot key={key} index={index()} />}
        </For>
      </div>
      <Show when={arrangement() === "deck" && order().length > 1}>
        <div class="pager" ref={pagerEl} aria-hidden="true" inert={staged() || sheetUp()}>
          <For each={order()}>{(key, index) => <i data-on={index() === pagerOn() ? "" : undefined} style={colourOfKey(key)} />}</For>
        </div>
      </Show>
      <Show when={arrangement() !== "deck"}>
        <Folded
          form={beside()}
          ref={(el) => (foldEl = el)}
          keys={order()}
          viewOf={viewOf}
          current={open()}
          onOpen={(key, el, event) => activate(key, el, event)}
          onUnfold={toggleWindows}
          onNew={startPlace() ? openSheet : undefined}
          onHistory={props.onHistory}
          onMachines={() => props.onMachines()}
          returns={folded()}
          inert={!folded() || windowsHidden() || moving() === arrangement() || moving() === "windows" || sheetUp()}
          swatchRef={(key, el) => (el ? swatchEls.set(key, el) : swatchEls.delete(key))}
        />
      </Show>
      <Show when={arrangement() === "deck" && startPlace()}>
        {(place) => (
          <div class="home-dock" inert={staged() || sheetUp()}>
            <NewThreadDock host={place().host} directory={place().directory} showHost={hosts() > 1} making={making()} onOpen={openSheet} />
          </div>
        )}
      </Show>
      <Show when={arrangement() !== "deck"}>
        <div class="lift" ref={(el) => (liftEl = el)} aria-hidden="true" style={stageColour()} />
      </Show>
      <main class="stage" ref={stageEl} data-open={open() ? "" : undefined} inert={sheetUp()}>
        <For each={layers()}>
          {(entry) => (
            <Show when={layerView(entry.key)}>
              {(view) => (
                <Layer
                  view={view()}
                  {...(entry.over ? { parent: entry.over } : {})}
                  deck={arrangement() === "deck"}
                  onBack={(event) => layerBack(entry, event)}
                  onOpenAgent={openAgent}
                  covered={coveredBy(layers(), entry)}
                  ref={(el) => {
                    layerEls.set(entry.id, el);
                    onCleanup(() => layerEls.delete(entry.id));
                  }}
                  gestureRefs={wireGesture}
                  {...(arrangement() === "rail" && wide() && layers().at(-1) === entry ? { inspector } : {})}
                  {...(arrangement() !== "deck" && !wide() && layers().at(-1) === entry ? { room } : {})}
                  {...(arrangement() !== "deck" && windowsHidden() && layers().at(-1) === entry ? { barStart: <FoldToggle form={beside()} state="hidden" round onToggle={toggleFocus} /> } : {})}
                />
              )}
            </Show>
          )}
        </For>
        <Show when={arrangement() !== "deck"}>
          <i class="rim" ref={(el) => (rimEl = el)} aria-hidden="true" style={stageColour()} />
          <i class="rim-cap" ref={(el) => (capEl = el)} aria-hidden="true" style={stageColour()} />
        </Show>
      </main>
      <Show when={arrangement() === "rail" && wide()}>
        <aside
          class="inspector"
          aria-label={inspectorView() === "turns" ? "turns" : "thread details"}
          inert={!inspectorShown() || moving() === "inspector"}
          ref={(el) => {
            setInspectorEl(el);
            onCleanup(() => setInspectorEl(undefined));
          }}
        />
      </Show>
      <Show when={sheet()}>
        {(at) => (
          <NewThreadSheet host={at().host} directory={at().directory} away={away()} onAway={setAway} onMaking={setMaking} onOpened={openBorn} onClose={closeSheet} />
        )}
      </Show>
      <Show when={askSheet()}>
        {(at) => (
          <AskSheet
            windowKey={at().key}
            from={at().from}
            arrangement={arrangement()}
            onClose={() => setAskSheet(null)}
            onOpenThread={(key, from, event) => activate(key, from, event)}
          />
        )}
      </Show>
      <Show when={viewOf(cue() ?? "")}>{(view) => <div class="cue" aria-hidden="true" style={colourStyle(view().colour)} />}</Show>
      <Show when={capsule()}>
        {(shown) => (
          <Show when={viewOf(shown().key)}>
            {(view) => (
              <button
                class="capsule"
                type="button"
                style={{ "--c1": view().colour.top, "--c2": view().colour.bottom, "--hi": view().colour.light }}
                aria-label={`open ${view().repo}, it wants you: ${shown().text}`}
                ref={(el) => play(el, [{ transform: "translateY(calc(-100% - 20px))", opacity: 0 }, { transform: "none", opacity: 1 }], SHEET)}
                onClick={(event) => {
                  // the key is read before the capsule goes (its accessor is stale once it has: the tap threw and swapped nothing), and
                  // the thread grows from the capsule's box, which is read before it is taken off
                  const key = shown().key;
                  swap(key, event.currentTarget, event);
                  setCapsule(null);
                }}
              >
                <RepoMark host={view().host} root={view().root} name={view().repo} colour={view().colour} size={34} />
                <span>
                  <b>{view().repo}</b> wants you: {shown().text}
                </span>
                <em>open</em>
              </button>
            )}
          </Show>
        )}
      </Show>
      <Show when={state.cacheBlocked && !state.needsReload}>
        {/* no button: reloading this tab cannot help, the other one is what holds the database. it goes by itself when that tab does */}
        <div class="reload" role="alert">
          <p>boxbox is open in another tab on an older version. close or reload that tab, and this one opens.</p>
        </div>
      </Show>
      <Show when={state.needsReload}>
        <div class="reload" role="alertdialog" aria-labelledby="reload-title">
          <p id="reload-title">boxbox was updated.</p>
          <button class="pill solid" type="button" onClick={() => location.reload()}>
            reload
          </button>
        </div>
      </Show>
    </div>
  );

  function Slot(slot: { key: string; index: number }) {
    const [view, setView] = createStore<WindowView>(viewOf(slot.key) as WindowView); // the For only renders keys the order holds
    createEffect(() => {
      const next = viewOf(slot.key);
      if (next) setView(reconcile(next, { key: "id", merge: true }));
    });
    return (
      <Window
        view={view}
        live={motion() && seen().has(slot.key) && !(arrangement() === "deck" && open() !== null) && !folded()}
        current={arrangement() !== "deck" && open() === slot.key}
        offline={offline()}
        showHost={hosts() > 1}
        now={now()}
        onOpen={(el, event) => activate(slot.key, el, event)}
        onOpenAsk={(el) => whenLoaded("AskSheet", () => setAskSheet({ key: slot.key, from: el }))}
        ref={(el) => {
          elements.set(slot.key, el);
          /* a thread opened from its url opens before its window is drawn, so the effect that hides the window under
             the deck's stage found nothing to hide: the window stayed visible beneath it, and its tail streaming there
             counted as layout shift the person could not see (perf.shift) */
          if (arrangement() === "deck" && open() === slot.key) el.style.visibility = "hidden";
          observe(el);
          onCleanup(() => {
            elements.delete(slot.key);
            observer?.unobserve(el);
          });
        }}
      />
    );
  }
}

/** first run's empty deck: one ghost window, no tour (design.md, first run) */
function Empty() {
  return (
    <article class="win ghost" data-state="idle">
      <h2>nothing is running</h2>
      <p class="win-note">a thread you start in cmx2 on any of your machines shows up here as a live window.</p>
    </article>
  );
}
