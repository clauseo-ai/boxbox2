/* home: the live windows (docs/design.md, the direction; one layout law
   for three devices; the laws that keep it calm; motion law).

   - the arrangement follows the window's size, never the device: the deck
     under 700 wide, the rail at 1000 and up in landscape, the strip
     between. at strip and rail sizes the stage shows home's field and
     what to do next when no thread is chosen (ui/next, design.md, home:
     what next); on the deck the field leads the windows.
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
import { flip, insetOf, installMotionProperties, play, prefersReducedMotion, settleIn } from "../../motion/animate";
import { birth } from "../../motion/fly";
import { FADE, SHEET, SNAP } from "../../motion/springs";
import { composeHost, focusPlan, holdsWords, type Over } from "../../board/requests";
import { boardCompose, boardFocus, homePrefs, liveUndo, openFocus, releaseFocus, sessionsBeat, setWindowsInView, state } from "../../store";
import { APPLE } from "../apple";
import { toastAnnouncement } from "./offers";
import { type ThreadPlace, closeThread, openThread, placeInUrl } from "../../sync/client";
import type { Ask } from "../../sync/protocol";
import { extraOf } from "../inbox/extra";
import type { DetailsRoom, InspectorLink, InspectorView } from "../thread/inspector";
import { RepoMark } from "../repo-mark/repo-mark";
import { colourMap } from "../window/colours";
import { colourStyle } from "../window/repo";
import { clockOf, type WindowView, windowView } from "../window/view";
import { type Arrangement, Window } from "../window/window";
import { createWindowKeys, sameOrder } from "./membership";
import { createClock } from "../clock";
import { keyed, sessionKeys } from "../fleet-index";
import { createViews } from "./views";
import { watchStreaming } from "./streaming";
import { ClearDone, handCleared } from "../window/clear";
import { coveredBy, type StageLayer } from "./layers";
import { openVerdict } from "./stage-open";
import { createCaughtUp } from "../caught-up";
import type { EdgeMove } from "./edge";
import { Folded, FoldToggle, WINDOWS_ID } from "./fold";
import { strayView } from "./layers";
import { AskSheet, AwaySheet, type Edge, edgeIfLoaded, FoldList, NextUp, settling, UndoToast, warm, warmEdge, whenLoaded } from "../later";
import type { NextApi } from "../next/next-up";
import { broughtBack } from "../window/clearing";
import type { AwayThread } from "../../sync/protocol";
import { type FoldKind, foldOf, leaverOf } from "./working-fold";
import { WorkingFold } from "./fold-capsule";
import { AwayLine } from "./away-line";
import { barControl, focusBack } from "./focus-back";
import { arrive, leave, unveil, veil } from "./parts";
import { doing, launchPainted, startPerf, tapped, watchTransition } from "./perf";
import { type Beside, detailsPlace } from "./windows";
import { type FocusState, type InspectorState, type RailState, readFocus, readInspector, readStrip, rememberFocus, rememberInspector, rememberStrip } from "./remembered";
import { Layer } from "./stage";
import "../asks/sheet.css";
import "../window/window.css";
import "./home.css";
import "./settle.css";
import "../next/next.css";

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
  const [offline, setOffline] = createSignal(false);
  /* the footers' clock and the 12 hour rule's: it holds while offline, and stops while the page is hidden except to reach
     the moment a window's 12 hours run out (ui/clock.ts). the rule reads the clock, so it is made after it and handed back
     here: until it is, there is no moment to reach */
  let windowWake: () => number | undefined = () => undefined;
  const at = props.at;
  const now = at !== undefined ? () => at : createClock({ held: offline, wake: () => windowWake() });
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
  const membership = createWindowKeys(() => state.fleet, now);
  windowWake = membership.wake;
  /** the thread on the stage. declared here because the fold reads it: the thread on the stage never folds */
  const [open, setOpen] = createSignal<string | null>(null);
  const asksBy = createMemo(() => {
    const by: Record<string, Ask[]> = {};
    for (const ask of Object.values(state.fleet.asks)) (by[ask.key] ??= []).push(ask);
    return by;
  });
  /* the working fold (working-fold.ts): of home's threads, those at work with nothing wrong, or parked on jobs alone, fold
     into the capsule and have no window. each thread's standing is a memo of its own, as membership's is */
  const kinds = keyed<FoldKind | null>(membership.keys, (key) => {
    const thread = state.fleet.threads[key];
    const prefs = homePrefs();
    if (!thread || !prefs.foldWorking || open() === key) return null;
    return foldOf(thread, asksBy()[key]?.length ?? 0, prefs.jobsAsNeeds);
  });
  const foldKinds = createMemo(() => {
    const list = membership.keys();
    const map = new Map<string, FoldKind>();
    kinds().forEach((kind, i) => {
      const key = list[i];
      if (kind && key !== undefined) map.set(key, kind);
    });
    return map;
  });
  const foldKeys = createMemo(() => membership.keys().filter((key) => foldKinds().has(key)), [], { equals: sameOrder });
  const kindOf = (key: string): FoldKind => foldKinds().get(key) ?? "working";
  const target = createMemo(() => membership.keys().filter((key) => !foldKinds().has(key)), [], { equals: sameOrder });
  /* the away list (the server's `away` frames): the line shows while the list holds threads this device has not seen yet,
     and while its sheet is open. `acked` is the list this device saw, held until the server's empty list comes */
  const awayRows = (): readonly AwayThread[] => state.fleet.away ?? [];
  const awaySig = createMemo(() => awayRows().map((row) => `${row.key}@${row.clearedAt}`).join(" "));
  const [acked, setAcked] = createSignal("");
  const [awayOpen, setAwayOpen] = createSignal<{ from: HTMLElement; rows: readonly AwayThread[] } | null>(null);
  // the sheet open holds the line even after the server's empty list (seeing it empties the list): it hangs from the line
  const awayLive = createMemo(() => awayOpen() !== null || (awayRows().length > 0 && awaySig() !== acked()));
  const [order, setOrder] = createSignal<string[]>(untrack(target));
  /* the capsule and the away line as drawn: they come and go only with the order, in its flip, so neither moves the
     windows at a moment of its own (perf.shift); a change to the fold that leaves the capsule where it is lands at once */
  const [foldShown, setFoldShown] = createSignal<string[]>(untrack(foldKeys));
  const [awayShown, setAwayShown] = createSignal(untrack(awayLive));
  /** the thread that just left the fold, while still on home: the capsule's second line names it */
  const [leaver, setLeaver] = createSignal<{ repo: string } | null>(null);
  const takeFold = (next: string[]) => {
    const onHome = new Set(membership.keys());
    const repo = leaverOf(foldShown(), next, (key) => (onHome.has(key) ? (state.fleet.threads[key]?.place?.name ?? null) : null));
    if (repo !== null) setLeaver({ repo });
    setFoldShown(next);
  };
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
    const nextFold = foldKeys();
    const nextAway = awayLive();
    // the capsule or the away line coming or going moves the windows below them: that waits for calm and flips like a reorder
    const chrome = nextFold.length > 0 !== foldShown().length > 0 || nextAway !== awayShown();
    if (sameOrder(next, order()) && !chrome) {
      if (!sameOrder(nextFold, foldShown())) takeFold(nextFold);
      return;
    }
    // the first windows (the cache, or the first snapshot) paint in place, at once
    if (order().length === 0 && foldShown().length === 0 && !awayShown()) {
      batch(() => {
        setOrder(next);
        takeFold(nextFold);
        setAwayShown(nextAway);
      });
      return;
    }
    // a window the person just cleared has played its own exit: the hole closes at once, not after the calm
    const held = new Set(order());
    const heldNow = (key: string) => state.fleet.threads[key] !== undefined;
    const left = order().filter((key) => !next.includes(key));
    // a window the fleet no longer holds closes its hole at once too: there is nothing left to keep in place
    // and so does one the person just brought back (undo, bring back): it was asked for, and is born at once
    const arriving = next.filter((key) => !held.has(key));
    const handed = left.length + arriving.length > 0 && left.every((key) => handCleared(key) || !heldNow(key)) && arriving.every(broughtBack);
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
      takeFold(nextFold);
      setAwayShown(nextAway);
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
      [target, foldKeys, awayLive],
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
  /* each window's view in a memo of its own (views.ts): the slot's reconcile, the summary and the stage read it, and a frame
     of one thread makes that thread's view alone. the folded threads have views too: the capsule, its list and the bar's
     line read them */
  const viewKeys = createMemo(() => {
    const keys = order();
    const held = new Set(keys);
    return [...keys, ...foldKeys().filter((key) => !held.has(key))];
  }, [], { equals: sameOrder });
  const viewsOf = createViews(viewKeys, asksBy, (key, asks) => {
    const thread = state.fleet.threads[key];
    return thread ? windowView(thread, asks, colourMap(), extraOf(thread, homePrefs().jobsAsNeeds)) : null;
  });
  const fleetKeys = sessionKeys(() => state.fleet);
  const sessionHosts = keyed(fleetKeys, (key) => state.fleet.threads[key]?.agent);
  const hosts = createMemo(() => new Set(sessionHosts().filter((host) => host !== undefined)).size);

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
  type Place = { host: string; directory: string | null };
  /* a new thread starts where you are looking: the thread on stage, else the window the deck is on, else the first window,
     else the first host. the field takes it once, as it comes up, and keeps what is picked in it after that */
  const startPlace = createMemo<Place | null>(
    () => {
      const list = order();
      const key = open() ?? (arrangement() === "deck" ? list[Math.min(pagerOn(), list.length - 1)] : list[0]);
      const thread = key ? state.fleet.threads[key] : undefined;
      if (thread) return { host: thread.agent, directory: thread.place?.root ?? null };
      const host = state.fleet.agentNames[0];
      return host ? { host, directory: null } : null;
    },
    null,
    { equals: (a, b) => a?.host === b?.host && a?.directory === b?.directory },
  );
  /* home's field (ui/next, a chunk warmed as home mounts): its verbs once it has drawn, and a press that beat it waits for
     it. `cameFrom` is the thread home was reached from, which escape on the empty field goes back to */
  let next: NextApi | undefined;
  let nextWaiting: ((api: NextApi) => void) | null = null;
  const withNext = (run: (api: NextApi) => void) => {
    if (next) run(next);
    else nextWaiting = run;
  };
  const takeNext = (api: NextApi) => {
    next = api;
    const run = nextWaiting;
    nextWaiting = null;
    run?.(api);
  };
  void warm("NextUp").catch(() => undefined);
  const [cameFrom, setCameFrom] = createSignal<string | null>(null);
  /* the answer sheet over home: every pending ask of one thread, from its window's tray (asks/sheet.tsx) */
  const [askSheet, setAskSheet] = createSignal<{ key: string; from: HTMLElement } | null>(null);
  /** a sheet is on the screen (the answer sheet, a list): home under it is inert */
  /* the working fold opened (lists.tsx): the capsule it hangs from */
  const [foldOpen, setFoldOpen] = createSignal<HTMLElement | null>(null);
  const sheetUp = (): boolean => askSheet() !== null || foldOpen() !== null || awayOpen() !== null;
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
  const held = (key: string) => state.fleet.threads[key] !== undefined;
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
    from.classList.contains("capsule") ? "capsule" : from.classList.contains("wrow") ? "fold" : event.target instanceof Element && event.target.closest(".wask, .asks-open") ? "answer" : "window";

  const activate = (key: string, from: HTMLElement, event: Event | null) => {
    setCapsule(null);
    if (arrangement() !== "deck") pour(key, from, event);
    else if (!open()) growFrom(key, from, event);
    else if (open() !== key) swap(key, from, event);
  };

  /** a thread just started from the field: the stage opens on it, out of the field's window as a tap opens a window */
  const openBorn = (key: string, from: HTMLElement) => {
    activate(key, from, null);
    // a transition still running refuses the grow: the thread opens in place rather than not at all
    if (open() !== key) openThread(key);
  };

  /* —— home, what next (design.md): at strip and rail the thread steps back and the field drops out of its bar; on the deck
     the thread shrinks into its window and the field leads the deck. escape on the empty field goes back —— */
  let nxStageEl: HTMLDivElement | undefined;
  const goHome = (event: Event | null) => {
    const key = open();
    if (!key || busy || !stageEl || arrangement() === "deck") return;
    busy = true;
    const top = layers().at(-1);
    // an agent's stage steps back to its parent first, as the back on its bar does
    if (top?.over) {
      busy = false;
      backFromAgent(event);
      return;
    }
    if (event) tapped(event, "home", arrangement(), "home");
    const leaving = layers();
    // the card's shadow and rim, and the thread's details in the inspector's column, go with it
    const card = [liftEl, rimEl, capEl, wide() ? inspectorEl() : undefined].filter((el): el is HTMLElement => el !== undefined);
    const faded: Animation[] = [];
    for (const entry of leaving) {
      const el = layerEls.get(entry.id);
      if (!el) continue;
      el.inert = true;
      // the card steps back on the sheet spring while its words go quickly, so the thread and home are never two pages of
      // words over each other
      const back = play(el, [{ transform: "none" }, { transform: "scale(.96)" }], SHEET, { fill: "forwards" });
      const gone = play(el, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
      for (const a of [back, gone]) if (a) faded.push(a);
    }
    for (const el of card) {
      const a = play(el, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
      if (a) faded.push(a);
    }
    setCameFrom(key);
    batch(() => setOpen(null));
    closeThread();
    // the field comes down out of the bar where its collapsed form was, the list settles in under it (next-up.tsx)
    watchTransition("home", SHEET.duration, "home");
    withNext((api) => {
      api.arrive();
      api.focus();
    });
    setTimeout(
      () => {
        setLayers((list) => list.filter((l) => !leaving.includes(l)));
        for (const a of faded) a.cancel();
        busy = false;
        applyOrder();
      },
      prefersReducedMotion() ? 0 : SHEET.duration,
    );
  };
  /** escape on the empty field: the thread home was reached from pours back onto the stage */
  const backToThread = () => {
    const key = cameFrom();
    if (!key || !held(key)) return;
    const from = originOf(key) ?? nxStageEl?.querySelector<HTMLElement>(".nx-field .cz-window") ?? null;
    if (from) pour(key, from, null);
  };
  /** ⌘n, n, the new thread pill, the fold's plus, a board's machine key: the field, with the caret in it */
  const startHere = (event?: Event) => {
    if (arrangement() !== "deck") {
      if (open()) goHome(event ?? null);
      else withNext((api) => api.focus());
      return;
    }
    if (!open()) return withNext((api) => api.focus());
    shrink(event ?? null);
    setTimeout(() => withNext((api) => api.focus()), prefersReducedMotion() ? 0 : CLOSED_MS + 20);
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
    const settled = () => {
      edgeMove = null;
      setMoving(null);
      after();
    };
    const move: EdgeMove = {
      card: stageEl,
      lift: liftEl,
      rim: { ring: rimEl, cap: capEl },
      side: kind === "rail" || (kind === "windows" && arrangement() === "rail") ? "left" : kind === "inspector" ? "right" : "top",
      grow,
      layout,
      ...columns,
      settled,
    };
    const start = (edge: Edge) => {
      const handle = edge.moveEdge(move);
      // a move that finished before it returned (reduced motion) has nothing left to stop
      if (moving() !== null) edgeMove = handle;
    };
    /* the motion is a chunk of its own (later.ts), warmed when the page is idle and at the toggle's pointerdown, so it
       starts in this task as it always did; a fold that beat the warming starts the moment the chunk lands, already
       marked as moving so no other move starts on it. stopped while it loads, it finishes at once, as a move does; a
       chunk that does not come lays the stage out where the move would have ended */
    const loaded = edgeIfLoaded();
    if (loaded) return start(loaded);
    let stopped = false;
    edgeMove = { stop: () => ((stopped = true), layout(true), settled()) };
    warmEdge().then(
      (edge) => !stopped && start(edge),
      () => !stopped && (layout(true), settled()),
    );
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
  const parentOf = (key: string) => { const thread = state.fleet.threads[key]; const parent = thread?.parent; return parent ? `${thread.agent}:${parent}` : null; };
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
    const verdict = openVerdict(state.fleet.threads[key] !== undefined, caughtUp());
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
    if (!key || !caughtUp() || state.fleet.threads[key] !== undefined || strays().has(key)) return;
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

  /* strip and rail: with no thread chosen the stage is home, what next (design.md). it no longer pours the first window on
     its own: a launch, a thread that left, or escape all land on the field */
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
    // escape at the strip and the rail is home, what next: from a thread, with no field focused and nothing open over it (a
    // sheet, a dialog, the thread's menu, which take their own escape first). ⌘k stays the jump (design.md, input)
    if (event.key === "Escape" && arrangement() !== "deck" && open() && !typing && !sheetUp() && !event.defaultPrevented && !document.querySelector("[aria-modal='true'], .menu.on")) {
      event.preventDefault();
      startHere(event);
      return;
    }
    // ⌘n starts a thread from anywhere, typing included (a browser tab keeps it, the installed app does not): the field, with
    // the caret in it. only the command key: control-n is the emacs next-line in every text field on a mac
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n" && !sheetUp()) {
      event.preventDefault();
      startHere(event);
      return;
    }
    if (typing) return;
    // ⌘z undoes the clear the toast offers (not ⇧⌘z, the browser's redo), from anywhere but a text field, which keeps its own;
    // an offer whose time ran out is no offer, and ⌘z does nothing
    if (event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "z" && liveUndo()?.busy === false && !sheetUp()) {
      event.preventDefault();
      void settling().then((m) => m.undoLast());
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "n" && !sheetUp()) {
      event.preventDefault();
      startHere(event);
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

  /* —— the board (docs/board.md, the app; the rules in board/requests.ts): a digit key opens its thread through the tap's own
     path, with the tap's motion, and puts the caret in its composer without a scroll, so the dictation the keypad types next
     lands there; a sheet holding words keeps the screen and its caret, and the thread opens behind it. a machine key opens
     the new-thread sheet on that machine. each request is taken once, by whichever home is up: the shell brings home up for
     one that comes while the app is elsewhere —— */
  let boardFrame: number | undefined;
  onCleanup(() => cancelAnimationFrame(boardFrame ?? 0));
  const caret = (key: string, tries: number) => {
    const field = stageEl?.querySelector<HTMLTextAreaElement>(`.thread-stage[data-thread="${CSS.escape(key)}"] .cz-body textarea`);
    if (!field) {
      if (tries > 0) boardFrame = requestAnimationFrame(() => caret(key, tries - 1));
      return;
    }
    field.focus({ preventScroll: true });
    // a screen coming back hands a keyboard's focus to the control that went in, a moment later (app/src/shell): for the first
    // frames that hand-off is undone, and nothing a person chose is
    const hold = (left: number) => {
      const now = document.activeElement;
      if (now !== field && (now === document.body || now?.matches("[data-opens], [data-screen-title]"))) field.focus({ preventScroll: true });
      if (left > 0) boardFrame = requestAnimationFrame(() => hold(left - 1));
    };
    boardFrame = requestAnimationFrame(() => hold(20));
  };
  createEffect(
    on(
      () => state.board.focus,
      (focus) => {
        if (!focus) return;
        boardFocus(null);
        // a frame on, so a home the request just brought up has drawn its windows
        cancelAnimationFrame(boardFrame ?? 0);
        boardFrame = requestAnimationFrame(() => {
          const el = originOf(focus.key);
          if (!el || !held(focus.key)) return;
          const over = (up: boolean, selector: string): Over => (!up ? "none" : holdsWords(document.querySelector(selector)) ? "words" : "empty");
          // the field is never over the stage: its words stay in it, as every draft does, while the thread opens
          const plan = focusPlan(over(askSheet() !== null, ".asks-sheet"));
          if (plan.closeAnswer) setAskSheet(null);
          activate(focus.key, el, null);
          // a tap a running transition refused opened nothing: the caret stays where it was
          if (plan.caret && open() === focus.key) caret(focus.key, 30);
        });
      },
    ),
  );
  createEffect(
    on(
      () => state.board.compose,
      (compose) => {
        if (!compose) return;
        boardCompose(null);
        // the field on that machine, with the caret in it: words already there go with it, as a pick in the field moves them
        const host = composeHost(state.fleet.agentNames, compose.machine);
        if (host === null) return;
        setAskSheet(null);
        startHere();
        withNext((api) => api.startOn(host));
      },
    ),
  );

  /* —— the bar's line —— */
  /** a thread is on the stage and its layer renders: only then is what is under it inert. `open()` alone is not enough
      (the thread may have left the fleet while the stream was down, and a layer is drawn only for an entry), or the deck
      is inert under nothing until the stream catches up. a memo, so the inert it sets is written when it flips and not
      again on every new view of the thread on the stage */
  const staged = createMemo(() => {
    const key = open();
    return key !== null && layers().some((layer) => layer.key === key) && viewOf(key) !== null;
  });
  // the line counts every thread on home, the folded ones too: "4 working" in the line, and the capsule saying which
  const views = createMemo(() => viewKeys().map(viewOf).filter((v): v is WindowView => v !== null));
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

  /* a count that changes in front of you fades in, as a streamed word does; the line as it was
     painted, or as the screen came up, does not move */
  const upAt = performance.now();
  const partIn = (el: HTMLElement) => { if (motion() && performance.now() - upAt > 800) settleIn(el); };

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
  /* long tasks are filed as streaming for 2 s after any write to the threads while one of them works (streaming.ts) */
  watchStreaming(() => state.fleet, sessionsBeat, fleetKeys, () => doing("streaming", 2000));

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
    return viewsOf(key);
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

  /* —— the fold, the away line, and the toast (docs/home.md, settle) —— */
  /** an apple desktop's keyboard and pointer: the toast shows its ⌘z, and names it */
  const fineKeys = APPLE && matchMedia("(hover: hover) and (pointer: fine)").matches;
  // an offer whose time ran out while home was away is gone now, so coming back shows no toast (store.ts, `liveUndo`)
  liveUndo();
  const acknowledge = () => {
    const seen = awaySig();
    setAcked(seen);
    // a call that did not land puts the line back: the list is still unseen on every device
    void settling()
      .then((m) => m.awaySeen())
      .catch(() => "unreachable")
      .then((failed) => {
        if (failed !== null && acked() === seen) setAcked("");
      });
  };
  /* the dismiss is seen too: the line goes with the next flip, so focus on its dismiss moves now to the bar's first control,
     where it will still be after that flip (focus-back.ts) */
  const dismissAway = () => {
    acknowledge();
    if (!awayLive()) focusBack(null, barControl);
  };
  const showAway = (from: HTMLElement) => {
    const rows = awayRows();
    // seen once the sheet is up: the line stays while it is open, so the sheet hangs from it and focus comes back to it
    whenLoaded("AwaySheet", () => {
      setAwayOpen({ from, rows });
      acknowledge();
    });
  };
  /* the count the line says: the sheet's while it is open, else the list's, else the last it had while the line waits for
     the flip that takes it away (the list empties the moment it is seen) */
  const awayCount = createMemo<number>((was) => awayOpen()?.rows.length ?? (awayRows().length || was), 0);
  const settle = () => (
    <>
      <Show when={awayShown()}>
        <AwayLine count={awayCount()} open={awayOpen() !== null} onShow={showAway} onDismiss={dismissAway} />
      </Show>
      <Show when={foldShown().length > 0}>
        <WorkingFold keys={foldShown()} kindOf={kindOf} viewOf={viewOf} left={leaver()} open={foldOpen() !== null} onOpen={(from) => whenLoaded("FoldList", () => setFoldOpen(from))} />
      </Show>
    </>
  );

  /** how many repos the list has room for under what needs you: the stage's height less the field and the rows above */
  const repoRoom = () => Math.max(2, Math.min(8, Math.floor((size().height - 470) / 64)));
  /** home, what next (ui/next): the field alone on the deck, the field and the list on the stage at strip and rail */
  const nextUp = (deck: boolean) => (
    <NextUp
      deck={deck}
      asideRepos={!deck && wide() && inspectorShown()}
      aside={!open() && layers().length === 0 ? inspectorEl() : undefined}
      start={startPlace()}
      order={order()}
      viewOf={viewOf}
      foldKeys={foldKeys()}
      kindOf={kindOf}
      now={now()}
      repoRoom={repoRoom()}
      onOpen={(key, from) => activate(key, from, null)}
      onAnswer={(key, from) => whenLoaded("AskSheet", () => setAskSheet({ key, from }))}
      onFold={(from) => whenLoaded("FoldList", () => setFoldOpen(from))}
      onBorn={openBorn}
      onEscape={!deck && cameFrom() !== null ? backToThread : undefined}
      api={takeNext}
    />
  );

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
        <Show when={arrangement() !== "strip"}>{settle()}</Show>
        {/* what you do, then where you go: the bar is three rows on the rail by rule (home.css), so a pill never wraps by
            chance at some count. the phone's deck has no row for what you do: new thread is a round plus beside history and
            machines, and clear N sits at the end of the line's row */}
        <div class="pills acts">
          <Show when={arrangement() !== "deck" && startPlace()}>
            <button class="pill new" type="button" aria-label="new thread" aria-keyshortcuts="Meta+N" onClick={(event) => startHere(event)}>
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
            <button class="pill icon new" type="button" aria-label="new thread" aria-keyshortcuts="Meta+N" onClick={(event) => startHere(event)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </Show>
          <Show when={arrangement() !== "deck"}>
            <FoldToggle form={beside()} state="open" onToggle={toggleWindows} />
          </Show>
        </div>
      </header>
      <Show when={arrangement() === "deck"}>
        <div class="nx-deck" inert={staged() || sheetUp()}>
          {nextUp(true)}
        </div>
      </Show>
      <div
        class="wins"
        id={arrangement() !== "deck" ? WINDOWS_ID : undefined}
        ref={winsEl}
        aria-label="live threads"
        inert={(arrangement() === "deck" && staged()) || sheetUp() || railOff()}
        onPointerDown={() => (touching = true)}
        onScroll={onScroll}
      >
        {/* the strip's bar is one row and the stage starts under the row of windows: the fold and the away line lead the row */}
        <Show when={arrangement() === "strip" && (foldShown().length > 0 || awayShown())}>
          <div class="wlead">{settle()}</div>
        </Show>
        <For each={order()} fallback={<Show when={foldShown().length === 0}><Empty /></Show>}>
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
          onNew={() => startHere()}
          onHistory={props.onHistory}
          onMachines={() => props.onMachines()}
          returns={folded()}
          inert={!folded() || windowsHidden() || moving() === arrangement() || moving() === "windows" || sheetUp()}
          swatchRef={(key, el) => (el ? swatchEls.set(key, el) : swatchEls.delete(key))}
        />
      </Show>
      <Show when={arrangement() !== "deck"}>
        <div class="lift" ref={(el) => (liftEl = el)} aria-hidden="true" style={stageColour()} />
      </Show>
      <main class="stage" ref={stageEl} data-open={open() ? "" : undefined} inert={sheetUp()}>
        <Show when={arrangement() !== "deck"}>
          {/* home, what next: under the thread's layer, there while a thread is on the stage (its words and its place kept),
              faded out and out of the tree; a thread stepping back uncovers it (goHome) */}
          <div class="nx-stage" ref={nxStageEl} data-away={open() ? "" : undefined} inert={open() !== null}>
            {nextUp(false)}
          </div>
        </Show>
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
                  {...(arrangement() !== "deck" && layers().at(-1) === entry ? { barEnd: <WhatNext onPress={startHere} /> } : {})}
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
      {/* keyed, as the toast's: what opened a list is a value its sheet holds, never an accessor that goes stale as it closes */}
      <Show when={foldOpen()} keyed>
        {(from) => (
          <FoldList
            keys={foldKeys()}
            kindOf={kindOf}
            viewOf={viewOf}
            now={now()}
            showHost={hosts() > 1}
            arrangement={arrangement()}
            from={from}
            onClose={() => setFoldOpen(null)}
            onOpenThread={(key, el, event) => activate(key, el, event)}
          />
        )}
      </Show>
      <Show when={awayOpen()} keyed>
        {(at) => <AwaySheet rows={at.rows} mode={homePrefs().autoClear} arrangement={arrangement()} from={at.from} onClose={() => setAwayOpen(null)} lineStays={awayLive} />}
      </Show>
      {/* keyed: the toast holds the offer itself, so its time and its cleanup never read a stale accessor once an undo or the
          time lets go of it (a newer offer merges into the same store object, so the toast stays mounted through it) */}
      <Show when={state.undo} keyed>
        {(undo) => <UndoToast undo={undo} arrangement={arrangement()} keys={arrangement() !== "deck" && fineKeys} />}
      </Show>
      {/* the toast's words, announced: this region is there from the first paint, empty, and takes them as a toast shows */}
      <p class="toast-live" role="status">{toastAnnouncement(state.undo)}</p>
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
      <p class="win-note">a thread you start above, or in cmx2 on any of your machines, shows up here as a live window.</p>
    </article>
  );
}

/** the way home from a thread at strip and rail (design.md, home: what next): the field, collapsed in the thread's bar. a
    press, or escape with no field focused, and the thread steps back while the field drops out of the bar */
function WhatNext(props: { onPress: (event: Event) => void }) {
  return (
    <button class="bar-next" type="button" aria-label="what next? go home" aria-keyshortcuts="Escape" onClick={(event) => props.onPress(event)}>
      <span class="bar-next-words">what next?</span>
      <kbd class="bar-next-key" aria-hidden="true">esc</kbd>
    </button>
  );
}
