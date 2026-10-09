/* the stage: a thread on screen (docs/thread.md, navigation; docs/design.md,
   the stage). the bar that condenses, the big title that scrolls away, the
   ledger of turns from the store, the ruler, the panel for its turns and details, the menu, the
   scroll law, links in and out, and the perf rows. the composer is another
   session's; the dock leaves it a slot. */

import { For, Index, Show, createEffect, createMemo, createSignal, createUniqueId, lazy, on, onCleanup, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../../api/client";
import { play } from "../../motion/animate";
import { FADE, TICK_DRAW } from "../../motion/springs";
import { FOCUS_FOR_MS, type Focus, openFocus, releaseFocus, state, threadCaches } from "../../store";
import { type ThreadPlace, closeThread, deviceIdentity, emit, markPlace, openThread, placeInUrl } from "../../sync/client";
import { splitKey } from "../../sync/protocol";
import { Composer } from "../composer/composer";
import { RepoMark } from "../repo-mark/repo-mark";
import { openReview, reviewLine } from "../review/open";
import { ReviewSlot } from "../review/slot";
import { type RepoColour, repoName } from "../window/repo";
import { createKeyboardInset } from "../term/keyboard";
import { holdChrome } from "../settings/appearance";
import { floodTop } from "../settings/chrome";
import { DetailsToggle, type DetailsData, FactsButton, Panel, type TurnsData } from "./details";
import { factsOf, filesChanged, rosterOf, spendOf, summaryOf } from "./details-model";
import type { InspectorLink } from "./inspector";
import { askActions, replies, settled } from "./asks";
import { type ThreadData, createThreadData, toneOfColour } from "./live";
import { watchMeasure } from "./measure";
import { createPin, endRoom } from "./pin";
import { CLEAR_OF_BAR, askLanding, layoutTop } from "./ask-landing";
import { createLapse } from "./focus-lapse";
import { createCaughtUp } from "../caught-up";
import type { Turn } from "./model";
import { flip, installMotion, reducedMotion } from "./motion";
import { clock, clockDur, dur, plural } from "./rows";
import { AskContext, CachesContext, ChildWatchContext, FollowContext, LandingContext, LiveTapeContext, MeasureContext, NamesContext, OpenAgentContext, READING, type Settle, SettleContext, ThreadKeyContext, TurnView, WindowContext, bring, light } from "./thread";
import { createStageWindow } from "./stage-window";
import { paintSource } from "./paint-source";
import { createNames } from "./names";
import "./stage.css";

/* the review is a chunk of its own: most threads never have one, so its card, controller and words stay out of the first
   load's script budget (docs/architecture.md). the stage keeps only the question of when one is wanted (review/open.ts) */
const ReviewLayer = lazy(() => import("../review/layer").then((m) => ({ default: m.ReviewLayer })));

const THINKING_KEY = "boxbox.thinking";
/** the turns a long thread is opened with, and how many more come in each frame after it (turns.ts) */
const FIRST_TURNS = 8;
const GROW_TURNS = 32;
/** the stream may be down this long before the line says so (design.md, honesty) */
const OFFLINE_AFTER_MS = 5000;
/** the ruler hides this long after the last scroll */
const RULER_HIDE_MS = 1200;
/** a turn that ended this long before its session's busy time began is not part of that run */
const RUN_SLACK_MS = 1500;
/** the keys that scroll the page when focus is not in a field */
const SCROLL_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
/** the status line says "done just now" this long after a turn the reader watched end */
const FRESH_MS = 60_000;

const prefs = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage refused: the setting lasts for this visit */ } },
};

const clockFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export type StageProps = {
  threadKey: string;
  /** the window's colour, when the stage is a layer on home: the thread keeps the hue the window had */
  colour?: RepoColour;
  /** the deck's full-screen layer: the bar is the handle for the pull-down back gesture. false is home's strip or
      rail, where the stage has no back; left out (a story) it keeps one */
  deck?: boolean;
  /** home's back (the shrink or the fade); without it the thread just closes */
  onBack?: (event: Event) => void;
  /** the bar, for home's back gesture */
  headerRef?: (header: HTMLElement) => void;
  /** opens an agent's own thread over this one (home stacks a layer and brings this one back on its back); without it
      the agent's thread takes this one's place */
  onOpenAgent?: (key: string) => void;
  /** home's inspector column beside the stage (the rail, 1400 wide and up): the stage shows its details or its turns
      there instead of docking them inside itself. only the layer on top gets it */
  inspector?: InspectorLink;
};

export function Stage(props: StageProps) {
  /* the thread's key through a memo: home's layer hands it over through a view it makes again at each update of the session (a reply
     streaming), so the prop notifies a few times a second with the same string, and whatever runs on a notification and not on a
     change (an `on`) would run at each */
  const key = createMemo(() => props.threadKey);
  const [thinking, setThinking] = createSignal<"open" | "rows">(prefs.get(THINKING_KEY) === "open" ? "open" : "rows");
  /* a thread opens with its newest turns and the rest follow a few at a time (turns.ts): a thread of hundreds of turns made in one task is
     a long task. one that was opened to a turn, a row or an ask is opened whole, since what it goes to may be any of them */
  const placeHere = (): ThreadPlace => (new URLSearchParams(location.search).get("thread") === props.threadKey ? placeInUrl() : { at: null, part: null });
  const aimed = Boolean(placeHere().at || placeHere().part || (state.focus && state.focus.thread === props.threadKey));
  const data = createThreadData(key, thinking, threadCaches, aimed ? {} : { first: FIRST_TURNS });
  const inset = createKeyboardInset();
  const mountedAt = performance.now();
  let scroller!: HTMLDivElement;
  let titleBlock!: HTMLDivElement;
  // bound by its ref in the transcript, which renders before the composer that reads it
  let transcriptEnd!: HTMLDivElement;
  let stageEl!: HTMLElement;
  let barEl!: HTMLElement;
  let threadEl!: HTMLDivElement;
  /* whether the stage follows the end, and the reader's hand on the scroller (pin.ts): only their scroll lets go of the end */
  const pin = createPin({ get scrollTop() { return scroller.scrollTop; }, set scrollTop(v) { scroller.scrollTop = v; }, get scrollHeight() { return scroller.scrollHeight; }, get clientHeight() { return scroller.clientHeight; } });
  const [condensed, setCondensed] = createSignal(false);
  /* the bar takes its state without a transition until the opened thread has landed and been seen (docs/thread.md): a
     thread opened with history lands at its end, the title has gone by, and the bar's own title would fade in */
  const [still, setStill] = createSignal(true);
  const [wide, setWide] = createSignal(false);
  /** the panel on the right (a sheet on the phone): the turns, or the details. it is docked only when home has no
      inspector for it; with one, home's column shows them and this stays null */
  const [panel, setPanel] = createSignal<"turns" | "details" | null>(null);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [rulerShown, setRulerShown] = createSignal(false);
  const [rulerDrag, setRulerDrag] = createSignal<number | null>(null);
  const [newBelow, setNewBelow] = createSignal(0);
  const [offline, setOffline] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  /* the menu's archive: a tap asks in words first (what leaves, what stays), a second tap does it */
  const [confirming, setConfirming] = createSignal(false);
  const [archiving, setArchiving] = createSignal(false);
  const [archiveNote, setArchiveNote] = createSignal<string | null>(null);
  let archiveItem: HTMLButtonElement | undefined;
  let keepButton: HTMLButtonElement | undefined;
  /** the question replaces the item, so focus goes with it: to "keep it" when asked, back to "archive" when declined */
  const ask = (asking: boolean) => {
    setConfirming(asking);
    queueMicrotask(() => (asking ? keepButton : archiveItem)?.focus());
  };

  onMount(() => installMotion());

  /* ---------- what the lines say ---------- */
  const session = () => state.fleet.sessions[key()];
  /* a subagent's stage knows its parent (`parentID`): the back returns there, the title says whose agent it is */
  const parentKey = () => { const p = session()?.info.parentID; return p ? `${data.host()}:${p}` : null; };
  const parentTitle = () => { const k = parentKey(); return k ? state.fleet.sessions[k]?.info.title || k.slice(data.host().length + 1) : ""; };
  const lastTurn = () => data.turns().at(-1);
  const stepsOfLast = () => lastTurn()?.items.filter((x) => x.k === "step").length ?? 0;
  /* the agents this thread started: the fleet's children, named by the rows that started them where a spawn row did,
     else by the daemon's title "name (seat)" (an agent started from a run script leaves no spawn row, cmx2 ask a27)
     (details-model.ts, rosterOf; docs/thread.md, agents) */
  const agents = createMemo(() => rosterOf(data.turns(), data.children()));
  const agentsWorking = () => agents().filter((a) => a.child.state === "working").length;
  createEffect(() => {
    const { state: now, since } = state.stream;
    setOffline(false);
    if (now !== "down") return;
    const timer = setTimeout(() => setOffline(true), Math.max(0, since + OFFLINE_AFTER_MS - Date.now()));
    onCleanup(() => clearTimeout(timer));
  });
  /* the line says "done just now" for a minute after a turn the reader watched end (docs/thread.md, live), then the time it ended */
  const [fresh, setFresh] = createSignal(false);
  createEffect((was: boolean) => {
    const working = data.working();
    if (was && !working) {
      setFresh(true);
      const timer = setTimeout(() => setFresh(false), FRESH_MS);
      onCleanup(() => clearTimeout(timer));
    }
    return working;
  }, data.working());
  const status = createMemo(() => {
    const s = session()?.status;
    const asks = data.asks().size;
    const last = lastTurn();
    if (offline()) return { text: `offline, last update ${state.stream.lastEventAt ? clockFmt.format(state.stream.lastEventAt) : "unknown"}`, live: false, agents: false };
    if (asks) return { text: asks === 1 ? "wants you" : `wants you, ${asks} asks`, live: true, agents: false };
    if (s?.type === "retry") return { text: `retrying, attempt ${s.attempt}: ${s.message}`, live: true, agents: false };
    if (data.working() && last) {
      /* a turn sitting in a wait for its agents is not working: it says what it waits on (design.md, the live line) */
      const cur = last.items.at(-1);
      const waiting = cur?.k === "step" && cur.family === "wait" && cur.status === "running";
      const n = agentsWorking();
      if (waiting) return { text: `waiting on ${n ? plural(n, "agent") : "agents"} for ${clockDur(Math.max(0, data.now() - cur.at))}`, live: true, agents: true };
      return { text: `working ${clockDur(Math.max(0, data.now() - last.at))}, ${plural(stepsOfLast(), "step")}`, live: true, agents: false };
    }
    if (s?.type === "idle" && s.parked) {
      /* a thread whose agents are at work is working, whatever the daemon calls its own turn (design.md, the window) */
      if (s.parked.agents > 0) return { text: `working ${clockDur(Math.max(0, data.now() - (s.since ?? data.now())))}, ${plural(s.parked.agents, "agent")}`, live: true, agents: true };
      return { text: `parked, waiting on ${plural(s.parked.jobs, "job")}`, live: false, agents: false };
    }
    if (data.hydrating() && !data.turns().length) return { text: "reading the thread", live: false, agents: false };
    const turns = data.turns().length;
    if (last && fresh() && last.status === "done") return { text: `done just now, worked ${dur(Math.max(0, last.end - last.at))}`, live: false, agents: false };
    return { text: last ? `done ${clock(last.end)}, ${plural(turns, "turn")}` : "no turns yet", live: false, agents: false };
  });
  const stop = async () => {
    if (stopping()) return;
    setStopping(true);
    try {
      await api.POST("/api/hosts/{host}/sessions/{session}/abort", { params: { path: { host: data.host(), session: key().slice(data.host().length + 1) } }, body: { ...deviceIdentity(), clientID: crypto.randomUUID() } });
    } finally {
      setStopping(false);
    }
  };

  // the menu closing takes its question with it
  createEffect(on(menuOpen, (open) => { if (!open) { setConfirming(false); setArchiveNote(null); } }, { defer: true }));
  /** archives the thread through its daemon (POST .../archive: cmx2's time.archived). it leaves every listing, its
      history stays on disk. on the deck the stage shrinks back into home; beside the windows (strip, rail) home lets
      go of it when the fleet drops it, a beat later. a refusal (the daemon says no: an imported thread is read only) is
      said in the menu, in words; a turn that is running is stopped by the daemon, not refused */
  const archive = async (event: Event) => {
    if (archiving()) return;
    setArchiving(true);
    setArchiveNote(null);
    try {
      const { error, response } = await api.POST("/api/hosts/{host}/sessions/{session}/archive", { params: { path: { host: data.host(), session: key().slice(data.host().length + 1) } } });
      if (!response.ok) {
        const said = (error as { error?: { message?: unknown } } | undefined)?.error?.message;
        setArchiveNote(typeof said === "string" ? said : `the server answered ${response.status}. try again.`);
        return;
      }
      setMenuOpen(false);
      if (props.deck !== false) {
        if (props.onBack) props.onBack(event);
        else closeThread();
      }
    } catch {
      setArchiveNote("the boxbox server is not answering. check it is running, then try again.");
    } finally {
      setArchiving(false);
    }
  };

  /* ---------- the bar condenses once the big title has gone by ---------- */
  createEffect(() => {
    /* the newest report: a first look and the scroll that follows it can arrive together, and the first is stale */
    const io = new IntersectionObserver((entries) => setCondensed(!(entries.at(-1)?.isIntersecting ?? true)), { root: scroller, rootMargin: "-60px 0px 0px 0px", threshold: 0 });
    io.observe(titleBlock);
    onCleanup(() => io.disconnect());
  });
  onMount(() => {
    /* wide is read from the stage itself, whose box `wide` does not change; the scroller's does (the gutter, the docked
       turns), and observing it looped the observer once per resize. the width comes from the entry, so the callback
       forces no layout of its own */
    const ro = new ResizeObserver(([entry]) => { if (entry) setWide(entry.contentRect.width >= 660); });
    ro.observe(stageEl);
    setWide(stageEl.clientWidth >= 660);
    onCleanup(() => ro.disconnect());
  });

  /* ---------- the scroll law: pinned at the bottom while there; nothing moves once you scroll up ---------- */
  // where an element sits below the scroller's visible top
  const topOf = (el: Element) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const messagesCount = data.count;
  /* what the reader has seen: the thread as it stands when the stage mounts, which may already be all of it (a thread restored from the
     cache is there before the stage is), else the pill would count the whole thread as new when the reader scrolls up from it */
  let seenCount = untrack(messagesCount);
  /* the time of the reader's last touch: none yet. a scroll the stage makes itself (landing at the end when it opens) is not
     the reader's, and must not show the ruler; 0 would read as a touch in the page's first 900 ms */
  let touchedAt = -Infinity;
  const markTouched = () => { touchedAt = performance.now(); pin.input(); win.interrupt(); };
  /* the room a settled turn leaves under its end so nothing above it drops (docs/thread.md, live): a turn that settles
     shorter (its open row closed, no files row to arrive) would let the browser pull the view down to the new end. it is
     the scroller's end padding (`--hold`), given up as soon as the view no longer shows it and when the next message
     comes, so nothing is ever left between two turns */
  let hold = 0;
  const setHold = (px: number) => { hold = px; scroller.style.setProperty("--hold", `${px}px`); };
  /* the end room an ask's landing asked for (ask-landing.ts, `pad`), for the ask that is pending: the thread ends that far below its last
     row, out of the view. it goes with the ask, once answered or gone (the effect at the ask's landing) */
  let askPad = 0;
  let askPadFor: string | null = null;
  /* at the end the pill has nothing to count */
  createEffect(on(pin.pinned, (at) => { if (at) { setNewBelow(0); seenCount = messagesCount(); } }, { defer: true }));
  const onScroll = () => {
    if (hold > 0 && scroller.scrollTop + scroller.clientHeight <= scroller.scrollHeight - hold) setHold(0);
    /* the window keeps the reader's place and holds its fills above the view while the reader's own scroll runs (stage-window.ts) */
    win.scrolled(pin.scrolled());
    if (performance.now() - touchedAt < 900) showRuler();
    placeChanged();
  };
  /* a turn ends and the end of the thread changes in place: its newest row closes, its reply becomes the answer, its files row
     arrives. the view's place is taken before and given back after. a reader at the end stays there, however the end moved
     (the answer and the tape hold still on screen and the rows above them make room); a reader further up keeps exactly the
     view they had. where the settled end is shorter than the view, the room it leaves is end padding (`--hold`), so nothing
     above it drops */
  const settle: Settle = {
    begin() {
      const top = scroller.scrollTop;
      const atEnd = pin.pinned();
      return () => {
        /* where the content now ends, not scrollHeight: a view that has become shorter than its box reports the box */
        const end = threadEl.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
        const pad = parseFloat(getComputedStyle(scroller).paddingBottom) - hold - askPad;
        const room = endRoom(top, scroller.clientHeight, end, pad);
        setHold(room);
        scroller.scrollTop = atEnd && room === 0 ? scroller.scrollHeight : top;
        pin.derive();
      };
    },
  };
  /* the end is followed (docs/thread.md, live): while the reader is pinned to the end the scroller stays at it however the
     transcript grows, a new message, a row filling in, the reply streaming, and however its own box changes (the dock
     taller, the keyboard up). a resize observer reports a change after layout and before paint, so the one scroll it makes
     lands in the frame that paints it and a new row is never seen below the fold first. only the reader's own scroll lets
     go of the end (pin.ts); once they have, nothing moves and the pill counts what arrives */
  let held = false;
  onMount(() => {
    /* a change a row the reader toggled makes is theirs, and is not told to the pin as a size change (it is held, below) */
    const ro = new ResizeObserver(() => { if (held) return; pin.resized(); pin.follow(); });
    ro.observe(threadEl);
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    onCleanup(watchMeasure(scroller));
    /* the reader's hand, wherever focus is. a finger is down from its first touch to its last lift, however long it rests before
       it drags; its target may be a row that is replaced under it, so these listen on the document. the scroll keys are the
       reader's when focus is on the page and not in a field they are typing in (after a tap on the transcript's text it is on
       the body, where the scroller's own keydown never hears it). find, a focus moving into a row and voiceover's scroll send
       no input at all: those scrolls are read for where they leave the view (pin.ts) */
    /* only a touch that began on the scroller is the reader's scroll: the lift of a tap on send, queue or hold-to-steer must not open the
       reader's window, in which the browser's own restore after the dock grows would pass as theirs */
    let began = false;
    const touches = (e: TouchEvent) => {
      if (e.type === "touchstart") { if (e.target instanceof Node && scroller.contains(e.target)) { began = true; pin.touch(true); win.touch(true); } }
      else if (e.touches.length === 0 && began) { began = false; pin.touch(false); win.touch(false); }
    };
    const keys = (e: KeyboardEvent) => { if (SCROLL_KEYS.has(e.key) && !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]"))) { pin.input(); win.interrupt(); } };
    for (const type of ["touchstart", "touchend", "touchcancel"]) document.addEventListener(type, touches as EventListener, { capture: true, passive: true });
    document.addEventListener("keydown", keys, { capture: true, passive: true });
    onCleanup(() => {
      for (const type of ["touchstart", "touchend", "touchcancel"]) document.removeEventListener(type, touches as EventListener, { capture: true });
      document.removeEventListener("keydown", keys, { capture: true });
    });
    /* a scroll the stage makes for the reader's tap (a link to a row, a step on the tape) says so first (thread.tsx, light and landOn) */
    scroller.addEventListener(READING, pin.input);
    onCleanup(() => scroller.removeEventListener(READING, pin.input));
  });
  createEffect(on(messagesCount, (count) => {
    if (count === seenCount) return;
    if (pin.pinned()) { seenCount = count; setHold(0); } else setNewBelow(count - seenCount);
  }, { defer: true }));
  /* the reader's own send is the reader asking for the end (the composer calls this from its send): the message is going to land
     there, and a reader who had scrolled up to read follows it down */
  const sent = () => pin.pin();
  /* a row the reader opens or closes changes the layout by their own hand and is not chased: it is held through the
     frame that lays it out (the observer reports in that frame, after its animation callbacks, so the second callback
     is the one that gives the hold up) and then reads where the reader is now. the tapped row keeps its place */
  const follow = {
    hold() {
      held = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { held = false; pin.derive(); }));
    },
  };
  /* the live tape sticks above the dock while a turn runs (thread.tsx): the pill and the pinned ask ride above it, and the
     transcript ends where its card does, so nothing reads in the band between the card and the composer (stage.css, the dissolve) */
  const liveTape = { stuck: (px: number) => { stageEl.style.setProperty("--live-tape", `${px}px`); stageEl.toggleAttribute("data-tape-stuck", px > 0); } };
  const toBottom = () => { pin.input(); win.travel(() => scroller.scrollHeight - scroller.clientHeight); setNewBelow(0); seenCount = messagesCount(); };

  /* ---------- links: the url names the turn in view; a link in opens a row ---------- */
  const turnEls = () => [...scroller.querySelectorAll<HTMLElement>("section.turn[data-turn]")];
  /** the last of the turns, in order, whose top is at or above the line 80 px under the top of the view: found by bisection, since each top is a
      layout read and a long thread has hundreds of them (every scroll event asks) */
  const turnAtLine = (els: readonly HTMLElement[]): HTMLElement | undefined => {
    let lo = 0, hi = els.length - 1, found: HTMLElement | undefined;
    const line = scroller.scrollTop + 80;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (topOf(els[mid] as HTMLElement) <= line) { found = els[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  };
  let placeTimer: ReturnType<typeof setTimeout> | undefined;
  const placeChanged = () => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      let at: string | null = null;
      at = turnAtLine(turnEls())?.dataset["turn"] ?? null;
      markPlace({ at, part: null });
    }, 250);
  };
  onCleanup(() => clearTimeout(placeTimer));
  let landed = false;
  /* the thread is drawn: its rows are there, or the worker said it is empty (the point its first paint is stamped at). a cache draws
     rows before the fetch behind them lands */
  const loaded = () => data.held() && !(data.hydrating() && !data.turns().length);
  /* the thread is read: the fetch behind it has landed. what a cold launch's cache holds predates the ask a push named, so the ask
     is not missing from it until then */
  const read = () => data.held() && !data.hydrating();
  /* the stream has caught up: it is live at the hello, before the frames that bring the fleet's asks (ui/caught-up.ts) */
  const caughtUp = createCaughtUp();
  /* the wait for an ask the focus names and the thread does not show yet: it starts once the thread is read, not when the focus was set,
     since a cold launch spends its first seconds on the gate, the sign-in and the thread itself (store.ts, FOCUS_FOR_MS) */
  const lapse = createLapse<Focus>(FOCUS_FOR_MS, releaseFocus);
  onCleanup(lapse.stop);
  /* a stage under something (another layer, the new-thread sheet) cannot take the focus now: it looks again when whatever covers it
     lets go. one under another layer of the same thread leaves the focus to the layer on top, which asks for it as it mounts */
  let uncover: MutationObserver | undefined;
  const stopWatching = () => { uncover?.disconnect(); uncover = undefined; };
  const watchInert = () => {
    if (uncover) return;
    uncover = new MutationObserver(() => { if (!stageEl.closest("[inert]")) { stopWatching(); landSoon(); } });
    uncover.observe(document.documentElement, { attributes: true, attributeFilter: ["inert"], subtree: true });
  };
  onCleanup(stopWatching);
  /* an ask a push, a window's "answer" or the bar's "wants you" named: its row is scrolled to and its card takes focus, so a
     keyboard answers it and the ring, drawn round the whole row (thread.css), says which one it is. it is not lit as well:
     two boxes round one ask read as two things. true once it has gone there. a stage that is
     already on the thread comes here too, when the focus changes (the effect below) */
  const goToAsk = (): boolean => {
    const focus = state.focus;
    if (!focus || focus.thread !== key()) return false;
    // a push that named the thread alone has what it asked for once the thread is read
    if (!focus.ask) { if (loaded()) releaseFocus(focus); return false; }
    const askID = focus.ask;
    if (stageEl.closest("[inert]")) { watchInert(); return false; }
    const row = scroller.querySelector<HTMLElement>(`.row[data-ask="${CSS.escape(askID)}"]`);
    if (!row) {
      // the row comes with the thread: the fetch behind a cache's rows is still to land
      if (!read()) return false;
      // an ask the fleet does not hold, with its thread read and the stream caught up, was answered elsewhere: there is nothing to go to,
      // and a focus left would send the stage somewhere at its next turn
      if (caughtUp() && !data.asks().has(askID)) { releaseFocus(focus); return false; }
      // the ask may still be on its way: the wait is bounded, and starts now
      lapse.start(focus);
      return false;
    }
    lapse.stop();
    landed = true;
    /* the row's top lands just below the bar, where the bar's fade has cleared (the band is 40 px from 4 px above the bar's foot): the
       bar's own height, laid out (a thread arriving is drawn smaller and each of its parts moves on its own), not the scroller's top, which the bar covers. an ask near the end of the thread
       cannot reach that high, and sits lower, whole, where the end stops it */
    const below = barEl.offsetTop + barEl.offsetHeight - scroller.offsetTop + CLEAR_OF_BAR;
    const landing = askLanding(layoutTop(row, scroller), below, scroller.scrollHeight - scroller.clientHeight);
    // a row that nearly fills the room: the end gains what keeps the pin from dragging it up under the bar (ask-landing.ts)
    if (landing.pad > 0) {
      askPad += landing.pad;
      askPadFor = askID;
      scroller.style.setProperty("--ask-pad", `${askPad}px`);
    }
    bring(row, scroller, below);
    /* the row holds the view, not whatever is at its top: rows between that settle or grow do not push it down (stage-window.ts, hold) */
    win.hold(row);
    /* a move to somewhere that is not the end lets go of it: a stage that opens pinned would follow the thread as it lays out and
       take the view back to the end under the smooth scroll (pin.ts). one that ends at the end keeps it */
    if (landing.leavesEnd) pin.leave();
    row.querySelector<HTMLElement>(".ask-card")?.focus({ preventScroll: true });
    openFocus(null);
    return true;
  };
  /* the end room goes with its ask: once that is answered or gone, the thread ends where its rows do */
  createEffect(() => {
    const asks = data.asks();
    if (askPadFor === null || asks.has(askPadFor)) return;
    askPad = 0;
    askPadFor = null;
    scroller.style.removeProperty("--ask-pad");
  });
  /** the turn that holds a part (a tool, a thought or a said row), named by its id: what a link to a row finds the turn by */
  /** every turn is shown, for what has to look in all of them or go to any */
  const whole = (): void => { if (data.more()) data.all(); };
  const turnOfPart = (part: string): string | undefined => { whole(); return data.turns().find((t) => t.answer?.id === part || t.items.some((x) => x.id === part))?.id; };
  const landOnLink = () => {
    if (goToAsk() || landed) return;
    const place = placeInUrl();
    /* the place in the url is another thread's when this stage is under another layer or was opened by a tap: it is not a reason to make every turn */
    if (placeHere().at === null && placeHere().part === null) { if (data.turns().length) { landed = true; pin.pin(); } return; }
    if (place.part) {
      /* the row's turn is filled first: a turn the window has not filled has no rows to find (stage-window.ts, reveal) */
      const owner = turnOfPart(place.part);
      if (owner) win.reveal(owner);
      const row = scroller.querySelector<HTMLElement>(`.row[data-part~="${CSS.escape(place.part)}"]`);
      if (row) {
        landed = true;
        const button = row.querySelector<HTMLButtonElement>(":scope > button.row-h");
        if (button && !row.classList.contains("open")) button.click();
        light(row, scroller);
        return;
      }
    }
    if (place.at) {
      whole();
      win.reveal(place.at);
      const el = scroller.querySelector<HTMLElement>(`section.turn[data-turn="${CSS.escape(place.at)}"]`);
      /* the scroll event that tells the stage it has left the end never comes when the turn is already at the top of the view,
         so the stage is told here: else a review arriving a moment later would find it pinned to the end and follow it down */
      if (el) { landed = true; scroller.scrollTop = topOf(el) - 72; pin.derive(); return; }
    }
    if (data.turns().length) { landed = true; pin.pin(); }
  };

  /* ---------- perf: the thread's first paint, and a row's ---------- */
  let painted = false;
  /* whether the first paint came from the client's own copy (paint-source.ts): the thread already in memory, or restored from the cache
     after this stage mounted, which is not what the store held at mount */
  const source = paintSource();
  source.see({ held: data.held(), hydrating: data.hydrating(), turns: data.turns().length });
  createEffect(on(() => `${data.held()}/${data.hydrating()}/${data.turns().length}`, () => {
    source.see({ held: data.held(), hydrating: data.hydrating(), turns: data.turns().length });
    /* the first frame that shows the thread: its rows, or, once the worker has answered, that it is empty */
    if (painted || !data.held() || (data.hydrating() && !data.turns().length)) return;
    painted = true;
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => setStill(false))));
    const cached = source.cached();
    requestAnimationFrame(() => {
      const ms = Math.round(performance.now() - mountedAt);
      emit("perf.thread", { what: "thread", cached: cached ? 1 : 0, messages: messagesCount() }, { ms, ok: ms <= (cached ? 300 : 1500), surface: "thread", session: key() });
      emit("surface.ready", { cached: cached ? 1 : 0 }, { ms, surface: "thread", session: key() });
    });
  }));
  /* the stage already on a thread is sent to its ask: the window's pill in the strip and the rail, where the thread is on stage */
  let linkFrame = 0;
  const landSoon = () => { cancelAnimationFrame(linkFrame); linkFrame = requestAnimationFrame(landOnLink); };
  onCleanup(() => cancelAnimationFrame(linkFrame));
  createEffect(on(() => state.focus, (focus) => { if (focus) landSoon(); }, { defer: true }));
  /* a link in is followed as soon as its target exists, once */
  createEffect(on(() => `${data.turns().length}/${data.asks().size}/${data.hydrating()}/${caughtUp()}`, () => { if ((!landed || state.focus) && data.turns().length) landSoon(); }));
  onMount(() => emit("surface.view", { route: `/?thread=${key()}` }, { surface: "thread", session: key() }));
  /* what the memo caches held when this stage closed, one row each (docs/thread.md, what is remembered) */
  onCleanup(() => {
    const at = untrack(key);
    for (const [what, cache] of [["turns", threadCaches.turns], ["ledgers", threadCaches.ledgers], ["html", threadCaches.html], ["heights", threadCaches.heights]] as const) {
      emit("perf.memo", { what, entries: cache.size, bytes: cache.weight, hits: cache.hits, misses: cache.misses, evicted: cache.evicted }, { surface: "thread", session: at });
    }
  });
  const measure = (what: "row", ms: number) => emit("perf.thread", { what }, { ms: Math.round(ms), ok: ms <= 17, surface: "thread", session: key() });

  /* ---------- the agents on screen: a row or a lane within a screen of the view holds its child's thread (live.ts, want) ---------- */
  const watched = new Map<Element, string>();
  /** how far from the middle of the view each element within a screen of it is, px */
  const near = new Map<Element, number>();
  let childWatch: IntersectionObserver | undefined;
  /* a child is within a screen when any of its elements is (its row, its lane on the tape): the nearest says how near */
  const tell = (child: string): void => {
    let nearest: number | null = null;
    for (const [el, c] of watched) { const d = near.get(el); if (c === child && d !== undefined && (nearest === null || d < nearest)) nearest = d; }
    data.seen(child, nearest);
  };
  const watchChild = (el: HTMLElement, child: string): (() => void) => {
    childWatch ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        const c = watched.get(e.target);
        if (!c) continue;
        if (e.isIntersecting) near.set(e.target, Math.abs(e.boundingClientRect.top + e.boundingClientRect.height / 2 - (e.rootBounds ? e.rootBounds.top + e.rootBounds.height / 2 : 0)));
        else near.delete(e.target);
        tell(c);
      }
    }, { root: scroller, rootMargin: "100% 0px" });
    watched.set(el, child);
    childWatch.observe(el);
    return () => { watched.delete(el); near.delete(el); childWatch?.unobserve(el); tell(child); };
  };
  onCleanup(() => { childWatch?.disconnect(); childWatch = undefined; watched.clear(); near.clear(); });

  /* ---------- asks: the actions the cards call, and the settle that stamps the perf row ---------- */
  const actions = askActions(data.host);
  /* ---------- the review card: an agent in a checkout asked to be merged (docs/design.md, the needs table) ---------- */
  const reviewNeed = createMemo(() => openReview(session()));
  /* a merge or a discard serves its need as it acts, and the card stays to say what happened: the layer says when it is done */
  const [reviewHeld, setReviewHeld] = createSignal(false);
  /* the rows' names are told apart across every turn on the page (docs/thread.md, accessibility) */
  const names = createNames(() => data.turns().map((t) => t.id));
  createEffect(on(() => [...data.asks().keys()].join("|"), (now, before) => {
    if (import.meta.env.DEV) console.debug("asks pending", now || "(none)", "before", before ?? "(first)");
    if (before === undefined) return;
    const gone = new Set(before.split("|").filter(Boolean));
    for (const id of now.split("|")) gone.delete(id);
    for (const id of gone) settled(id, key());
  }));

  /* ---------- a pending ask scrolled out of view is carried by a line above the dock, never lost ---------- */
  const [askInView, setAskInView] = createSignal(true);
  createEffect(on(() => `${[...data.asks().keys()].join("|")}/${data.turns().length}`, () => {
    if (!data.asks().size) { setAskInView(true); return; }
    let io: IntersectionObserver | undefined;
    const frame = requestAnimationFrame(() => {
      const rows = [...scroller.querySelectorAll<HTMLElement>(".row[data-ask]")];
      if (!rows.length) { setAskInView(true); return; }
      const seen = new Map<Element, boolean>();
      io = new IntersectionObserver((entries) => { for (const e of entries) seen.set(e.target, e.isIntersecting); setAskInView([...seen.values()].some(Boolean)); }, { root: scroller, threshold: 0.2 });
      for (const r of rows) io.observe(r);
    });
    onCleanup(() => { cancelAnimationFrame(frame); io?.disconnect(); });
  }));
  const pinned = () => { if (askInView()) return null; const a = [...data.asks().values()][0]; if (!a) return null; const q = a.kind === "question" ? String((a.request["questions"] as Array<{ question?: string }> | undefined)?.[0]?.question ?? "a question") : `${String(a.request["permission"] ?? "use")} ${String((a.request["patterns"] as string[] | undefined)?.[0] ?? "")}`.trim(); return { id: a.id, text: q }; };
  /* ---------- a review scrolled out of view is carried by a line above the dock as well (docs/design.md); an ask's line
     outranks it, so there is one at a time, and a card on screen needs none ---------- */
  const [reviewBox, setReviewBox] = createSignal<HTMLElement>();
  const [reviewInView, setReviewInView] = createSignal(true);
  createEffect(() => {
    const box = reviewBox();
    if (!box) { setReviewInView(true); return; }
    const io = new IntersectionObserver((entries) => { const last = entries.at(-1); if (last) setReviewInView(last.isIntersecting); }, { root: scroller, threshold: 0.2 });
    io.observe(box);
    onCleanup(() => io.disconnect());
  });
  const reviewPinned = createMemo(() => reviewLine(reviewNeed(), reviewInView(), pinned() !== null));
  /* a scroll the person asked for by tapping the line, and the keyboard goes where the eye does */
  const toReview = () => {
    const box = reviewBox();
    if (!box) return;
    pin.input();
    if (reducedMotion()) scroller.scrollTo({ top: topOf(box) - 72, behavior: "auto" }); else win.travel(() => topOf(box) - 72);
    box.querySelector<HTMLElement>(".review-card, .review-missing")?.focus({ preventScroll: true });
  };
  const toAsk = (id: string) => { const row = scroller.querySelector<HTMLElement>(`.row[data-ask="${CSS.escape(id)}"]`); if (row) light(row, scroller); };

  /* ---------- the ruler ---------- */
  const prompts = createMemo(() => data.turns().filter((t) => t.by === "you" || t.by === "queued" || t.by === "steer" || t.by === "brief"));
  const current = () => {
    const els = new Map(turnEls().map((e) => [e.dataset["turn"], e]));
    const mine = prompts().map((t) => els.get(t.id)).filter((e): e is HTMLElement => e !== undefined);
    const at = turnAtLine(mine);
    return at ? Math.max(0, mine.indexOf(at)) : 0;
  };
  const [cur, setCur] = createSignal(0);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const showRuler = () => { if (wide() && panel() !== null) return; setRulerShown(true); clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (rulerDrag() === null) setRulerShown(false); }, RULER_HIDE_MS); };
  onCleanup(() => clearTimeout(hideTimer));
  createEffect(on(() => scroller, () => scroller.addEventListener("scroll", () => { if (rulerDrag() === null) setCur(current()); }, { passive: true })));
  let rulerEl!: HTMLDivElement;
  const pick = (e: PointerEvent) => {
    const ticks = [...rulerEl.children] as HTMLElement[];
    let k = 0, best = Infinity;
    ticks.forEach((b, j) => { const r = b.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - e.clientY); if (d < best) { best = d; k = j; } });
    if (k !== rulerDrag()) {
      setRulerDrag(k); setCur(k);
      const t = prompts()[k];
      const el = t ? win.reveal(t.id) : null;
      if (el) { pin.input(); scroller.scrollTop = topOf(el) - 72; }
    }
  };
  const rulerDown = (e: PointerEvent) => { try { rulerEl.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone; moves still arrive */ } setRulerShown(true); clearTimeout(hideTimer); setRulerDrag(-1); pick(e); };
  const rulerMove = (e: PointerEvent) => { if (rulerDrag() !== null) pick(e); };
  const rulerUp = () => { setRulerDrag(null); showRuler(); };
  const rulerCard = () => { const k = rulerDrag(); if (k === null || k < 0) return null; const t = prompts()[k]; if (!t) return null; const steps = t.items.filter((x) => x.k === "step").length; return { k, t, steps }; };

  /* ---------- the panel: the turns and the details ---------- */
  const listed = createMemo(() => data.turns().filter((t) => t.by !== "notice"));
  const changed = createMemo(() => filesChanged(data.turns()));
  /* what the thread and every agent under it have cost (details-model.ts, spendOf): the facts line and the details say the whole */
  const spent = createMemo(() => spendOf(data.turns(), session()?.info, data.kin(), agents()));
  const facts = createMemo(() => factsOf(data.turns(), session()?.info, spent().agents));
  const [here, setHere] = createSignal<string | null>(null);
  createEffect(on(() => scroller, () => scroller.addEventListener("scroll", () => setHere(turnAtLine(turnEls())?.dataset["turn"] ?? null), { passive: true })));
  const goTo = (t: Turn) => {
    const el = win.reveal(t.id);
    if (el) { pin.input(); win.travel(() => topOf(el) - 72); }
    if (!wide()) setPanel(null);
  };
  /* one panel at a time; docked, the ledger makes room for it by flip */
  const showPanel = (which: "turns" | "details" | null) => { if (wide()) flip(scroller, () => setPanel(which)); else setPanel(which); };
  /* where the panel is: home's inspector when it gave one, else docked in the stage (a sheet on the phone) */
  const shown = () => (props.inspector ? props.inspector.view() : panel());
  const openPanel = (which: "turns" | "details" | null) => (props.inspector ? props.inspector.show(which) : showPanel(which));
  const toggleDetails = () => openPanel(shown() === "details" ? null : "details");
  /* the panel keeps what it showed while it slides away */
  const lastPanel = createMemo<"turns" | "details">((before) => shown() ?? before, "turns");
  /* a window that crossed into the inspector's width hands it what was docked */
  createEffect(on(() => props.inspector !== undefined, (has) => {
    if (!has) return;
    const docked = panel();
    if (docked) props.inspector?.show(docked);
    setPanel(null);
  }));
  /* the turns and the details trade places with a fade, the one motion the panel makes itself: opening and folding
     are home's (the inspector) or the sheet's */
  let panelEl: HTMLElement | undefined;
  let inspectEl: HTMLDivElement | undefined;
  createEffect(on(() => shown(), (now, before) => {
    if (!now || !before || now === before || reducedMotion()) return;
    const root = props.inspector ? inspectEl : panelEl;
    root?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
    // the control that swapped the view went with the old one: the keyboard lands on the new heading
    if (document.activeElement === document.body) root?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }, { defer: true }));
  const panelId = createUniqueId();
  /* a panel that is asked for takes the keyboard with it, on its heading, and gives it back to what asked (the menu's
     button, never an item of the menu, which is inert once it closes) when the panel closes. the toggle keeps its own
     focus: a person who pressed it is still on it */
  let moreEl!: HTMLButtonElement;
  let returnTo: HTMLElement | undefined;
  const enter = (which: "turns" | "details") => {
    const from = document.activeElement;
    returnTo = from instanceof HTMLElement && from !== document.body && !from.closest(".menu") ? from : moreEl;
    openPanel(which);
    requestAnimationFrame(() => (props.inspector ? inspectEl : panelEl)?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true }));
  };
  createEffect(on(shown, (now) => {
    if (now || !returnTo) return;
    const root = props.inspector ? inspectEl : panelEl;
    const active = document.activeElement;
    if (returnTo.isConnected && (!active || active === document.body || root?.contains(active))) returnTo.focus({ preventScroll: true });
    returnTo = undefined;
  }, { defer: true }));
  /* what the panel reads, by accessor: one object each, whichever place draws it */
  const detailsData: DetailsData = {
    get turns() { return data.turns(); },
    get agents() { return agents(); },
    get files() { return changed(); },
    get info() { return session()?.info; },
    get spend() { return spent(); },
    get now() { return data.now(); },
    openAgent: (id) => openAgent(`${data.host()}:${id}`),
  };
  /* the repo's name, as the window says it: its project root's, never a worktree directory's */
  const repoLabel = () => repoName(data.repoRoot()) || data.host();
  /* the phone's sheet is headed by the thread, as the prototype's details sheet is */
  const sheetHeading = {
    get title() { return data.title(); },
    get sub() { return `${repoLabel()}, on ${data.host()}`; },
  };
  const turnsData: TurnsData = {
    get listed() { return listed(); },
    get here() { return here(); },
    label: (t) => turnLabel(t),
    goTo,
  };
  const openAgent = (childKey: string) => { setPanel(null); if (props.onOpenAgent) props.onOpenAgent(childKey); else openThread(childKey); };
  const toggleThinking = () => { const next = thinking() === "open" ? "rows" : "open"; setThinking(next); prefs.set(THINKING_KEY, next); };

  const tone = () => (props.colour ? toneOfColour(props.colour) : data.tone());
  /* the same colour, as the composer and the browser chrome take it */
  const colour = (): RepoColour => { const t = tone(); return { name: t.name, top: t.top, bottom: t.bottom, light: t.tone }; };
  /* on the deck the stage is the whole screen, its top against the status bar's strip, which the browser paints in the
     theme-color (no viewport-fit=cover, decision 19): while it is open that strip takes the top of the flood, so the
     colour runs to the screen's edge instead of stopping under a band of the ground */
  createEffect(() => {
    if (props.deck !== true) return;
    onCleanup(holdChrome(floodTop(colour())));
  });
  /** the first line with words in it, to 300 characters: the turns list and the ruler's card show two lines of it, and a prompt of megabytes must not be the text they hold */
  const firstLineOf = (text: string): string => { for (const line of text.slice(0, 20_000).split("\n")) if (line.trim()) return line.slice(0, 300); return ""; };
  const turnLabel = (t: Turn) => (t.by === "compaction" ? "compacted" : t.by === "mail" ? `${t.from ?? "an agent"} ${t.note ? "wrote" : "reported"}` : firstLineOf(t.prompt) || "(an image)");
  /* the turn that is live: the newest one that has started, from the moment the session works until it is idle. it is
     the session's state, not the last message's, that decides: between two steps the last message is complete and the
     next not yet begun, and the turn must not settle and run again. a prompt queued behind it has not started and is
     not live */
  const liveId = createMemo(() => {
    if (!data.working()) return undefined;
    const turns = data.turns();
    const s = session()?.status;
    /* when the session began working, by the daemon's clock, as the messages' times are. the busy status can arrive a
       moment before the new prompt does, and the turn before it, ended earlier, must not be live for that moment: a turn
       belongs to this run if it was still going when the run began */
    const since = s?.type === "busy" || s?.type === "retry" ? s.since : undefined;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i] as Turn;
      if (t.by === "queued" && t.status !== "working" && !t.items.length) continue;
      if (t.status !== "working" && since !== undefined && t.end < since - RUN_SLACK_MS) return undefined;
      return t.id;
    }
    return undefined;
  });
  const isLive = (t: Turn) => t.id === liveId();
  /* the turns that hold a pending ask are filled whatever the view does: an ask is never an empty box, and its row is there to land on */
  const asking = createMemo<ReadonlySet<string>>(() => {
    const calls = new Set([...data.asks().values()].flatMap((a) => (a.callID ? [a.callID] : [])));
    const out = new Set<string>();
    if (!calls.size) return out;
    for (const t of data.turns()) if (t.items.some((x) => x.k === "step" && calls.has(x.callID))) out.add(t.id);
    return out;
  }, new Set(), { equals: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)) });
  /* the log is mounted progressively, and the stage's window is also the owner of the reader's place with the pin (stage-window.ts) */
  const win = createStageWindow({ scroller: () => scroller, thread: key, turns: data.turns, live: liveId, asking, pin, caches: threadCaches, follow: () => { if (!held) pin.follow(); } });
  /* the rest of a long thread comes in newest first, a few turns a frame, above the reader's place and never under a finger (a fling is
     ended by a write to the scroll position). a focus on this thread has it all at once: the row it is to go to may be in any. a pending ask brings its own turn (turns.ts, `need`) */
  let growFrame = 0;
  let growTimer: ReturnType<typeof setTimeout> | undefined;
  const growSoon = (): void => {
    if (growFrame || growTimer) return;
    growFrame = requestAnimationFrame(() => {
      growFrame = 0;
      if (!data.more()) return;
      if (!win.steady()) { growTimer = setTimeout(() => { growTimer = undefined; growSoon(); }, 150); return; }
      win.keep(() => data.grow(GROW_TURNS));
      growSoon();
    });
  };
  createEffect(() => { if (data.more()) growSoon(); });
  onCleanup(() => { cancelAnimationFrame(growFrame); clearTimeout(growTimer); });
  createEffect(() => { if (data.more() && state.focus && state.focus.thread === key()) data.all(); });

  return (
    <section
      ref={stageEl}
      class="thread-stage"
      classList={{ wide: wide() }}
      data-thread={key()}
      style={{ "--tone": tone().tone, "--window-top": tone().top, "--window-bottom": tone().bottom, "--keyboard": `${inset()}px` }}
    >
      {/* the flood: the repo's colour pours down the stage, on home's layer as in a story (design.md, the stage) */}
      <div class="stage-bg" aria-hidden="true" />
      <div class="stage-body">
        <div class="stage-col">
          <header class="stage-bar" ref={(el) => { barEl = el; props.headerRef?.(el); }} classList={{ on: condensed(), still: still() }} data-deck={props.deck ? "" : undefined}>
            {/* only the deck has a back: at strip and rail the stage never empties (design.md, input; the route table).
                an agent's stage has one everywhere: it sits over its parent, and back returns there */}
            <Show when={props.deck !== false || parentKey()}>
              <button class="back" aria-label={parentKey() ? `back to ${parentTitle()}` : "back to all windows"} onClick={(event) => (props.onBack ? props.onBack(event) : parentKey() ? openThread(parentKey() as string) : closeThread())} />
            </Show>
            <div class="stage-bar-title">
              <b>{data.title()}</b>
              <span><Show when={status().live}><i /></Show>{status().text}</span>
            </div>
            <Show when={wide()}><DetailsToggle expanded={shown() === "details"} controls={panelId} shortcut={props.inspector !== undefined} onClick={toggleDetails} /></Show>
            <button ref={moreEl} class="round more" aria-label="thread menu" aria-expanded={menuOpen() ? "true" : "false"} aria-controls="stage-menu" onClick={() => setMenuOpen(!menuOpen())}><i /><i /><i /></button>
          </header>
          <div id="stage-menu" class="menu" classList={{ on: menuOpen() }} inert={!menuOpen()} role="menu" aria-label="thread menu">
            <button role="menuitem" onClick={() => { setMenuOpen(false); enter("turns"); }}>turns<em>{prompts().length}</em></button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); enter("details"); }}>details<em>{summaryOf(agents().length, changed().files.length)}</em></button>
            <button role="menuitemcheckbox" aria-checked={thinking() === "open" ? "true" : "false"} onClick={() => { setMenuOpen(false); toggleThinking(); }}>show thinking<em>{thinking() === "open" ? "on" : "off"}</em></button>
            <Show
              when={confirming()}
              fallback={<button ref={archiveItem} role="menuitem" onClick={() => ask(true)}>archive</button>}
            >
              <div class="menu-ask" role="group" aria-label="archive this thread">
                <p>archive this thread? it leaves every list on every device. its history stays on disk.{data.working() ? " it is working now, and archiving stops the turn." : ""}</p>
                <Show when={archiveNote()}>{(why) => <p class="menu-ask-note" role="alert">{why()}</p>}</Show>
                <div class="menu-ask-do">
                  <button ref={keepButton} onClick={() => ask(false)}>keep it</button>
                  <button class="menu-ask-go" disabled={archiving()} onClick={(event) => void archive(event)}>archive it</button>
                </div>
              </div>
            </Show>
          </div>
          <div ref={scroller} class="stage-scroll" onScroll={onScroll} onWheel={markTouched} onTouchStart={markTouched} onPointerDown={markTouched} onKeyDown={markTouched}>
            <div ref={threadEl} class="thread" classList={{ wide: wide() }} data-flip-root aria-label="transcript">
              <div ref={titleBlock} class="title-block">
                <div class="tb-repo"><RepoMark host={data.host()} root={data.repoRoot()} name={repoLabel()} colour={colour()} size={20} /><span>{repoLabel()}<Show when={parentKey()}><span class="tb-parent">an agent of {parentTitle()}</span></Show></span></div>
                <h1 class="tb-h1">{data.title()}</h1>
                <div class="tb-status" aria-live="polite">
                  <Show when={status().live}><i /></Show>
                  {/* a line about the agents opens them */}
                  <Show when={status().agents && agents().length} fallback={<span>{status().text}</span>}>
                    <button class="tb-agents" aria-controls={panelId} onClick={() => enter("details")}>{status().text}</button>
                  </Show>
                  <Show when={data.working()}><button class="stop" onClick={() => void stop()} disabled={stopping()}>stop</button></Show>
                </div>
                <Show when={facts()}>{(line) => <FactsButton facts={line()} open={() => enter("details")} />}</Show>
              </div>
              <Show when={!data.held() || (data.hydrating() && !data.turns().length)}><p class="stage-empty">reading the thread.</p></Show>
              <Show when={data.held() && !data.hydrating() && !data.turns().length}><p class="stage-empty">nothing here yet.</p></Show>
              <AskContext.Provider value={actions}>
                <MeasureContext.Provider value={measure}>
                  <NamesContext.Provider value={names}>
                    <CachesContext.Provider value={threadCaches}><ThreadKeyContext.Provider value={key}><WindowContext.Provider value={win}><ChildWatchContext.Provider value={watchChild}><LandingContext.Provider value={still}><SettleContext.Provider value={settle}><FollowContext.Provider value={follow}><LiveTapeContext.Provider value={liveTape}>
                      <OpenAgentContext.Provider value={(child) => openAgent(`${data.host()}:${child}`)}>
                        {/* turns are keyed by their id: the running turn is rebuilt as an object on every delta and must keep its dom, and turns come in above the first */}
                        <For each={data.ids()}>{(id) => { let last: Turn | undefined; const turn = (): Turn => (last = data.turnOf(id) ?? last) as Turn; return <TurnView turn={turn()} ctx={data.ctx()} live={isLive(turn())} now={data.now()} />; }}</For>
                      </OpenAgentContext.Provider>
                    </LiveTapeContext.Provider></FollowContext.Provider></SettleContext.Provider></LandingContext.Provider></ChildWatchContext.Provider></WindowContext.Provider></ThreadKeyContext.Provider></CachesContext.Provider>
                  </NamesContext.Provider>
                </MeasureContext.Provider>
              </AskContext.Provider>
              {/* a review waits at the live edge, where an ask would, and folds into its line when it is done */}
              <Show when={reviewNeed() || reviewHeld()}>
                <ReviewSlot Layer={ReviewLayer} box={setReviewBox} layer={{ client: api, motion: { play, fade: FADE, tick: TICK_DRAW }, host: data.host, session: () => key().slice(data.host().length + 1), need: reviewNeed, holding: setReviewHeld }} />
              </Show>
              {/* the transcript's end, for the composer's line: it shows the newest step only while this is out of view */}
              <div ref={transcriptEnd} class="thread-end" aria-hidden="true" />
            </div>
          </div>
          <div ref={rulerEl} class="ruler" classList={{ show: rulerShown(), drag: rulerDrag() !== null }} role="slider" aria-label="jump to a turn" aria-valuemin={1} aria-valuemax={prompts().length} aria-valuenow={cur() + 1} tabIndex={0} onPointerDown={rulerDown} onPointerMove={rulerMove} onPointerUp={rulerUp} onPointerCancel={rulerUp} style={{ "--gap": `${Math.max(4, Math.min(9, (scroller?.clientHeight ?? 600) / Math.max(1, prompts().length) - 0.5))}px` }}>
            <For each={prompts()}>{(t, j) => <b classList={{ "k-cur": j() === cur(), "k-ask": t.items.some((x) => x.k === "step" && x.family === "ask") }} />}</For>
          </div>
          <Show when={rulerCard()}>{(c) => (
            <div class="rcard on" aria-hidden="true" style={{ top: `${(rulerEl.children[c().k]?.getBoundingClientRect().top ?? 0) - rulerEl.parentElement!.getBoundingClientRect().top + 4}px` }}>
              <small>turn {c().k + 1} of {prompts().length}, {clock(c().t.at)}</small>
              <span>{turnLabel(c().t)}</span>
              <em>{c().steps || c().t.answer ? `${c().steps ? `${plural(c().steps, "step")}, ${dur(c().t.end - c().t.at)}` : ""}${c().t.answer ? `${c().steps ? ", " : ""}answered` : ""}` : "no reply"}</em>
            </div>
          )}</Show>
          <div class="stage-dock" data-slot="composer">
            <Show when={newBelow() > 0}><button class="new-below" onClick={toBottom}>{plural(newBelow(), "new message")} below</button></Show>
            <Show when={pinned()}>{(p) => <button class="pinned" aria-label={`wants you: ${p().text}. go to it`} onClick={() => toAsk(p().id)}><i /><span><b>wants you</b> {p().text}</span></button>}</Show>
            <Show when={reviewPinned()}>{(r) => <button class="pinned" data-kind="review" aria-label={r().name} onClick={toReview}><i /><span><b>ready to merge</b> {r().note}</span></button>}</Show>
            <Show when={splitKey(key())}>
              {(place) => <Composer target={{ kind: "session", host: place().host, session: place().session, directory: data.directory() }} mount="bar" title={data.title()} onScreen={() => transcriptEnd} onSent={sent} agents={{ count: agents().length, open: () => enter("details") }} colour={colour()} />}
            </Show>
          </div>
        </div>
        <Show when={!props.inspector}>
          <aside id={panelId} ref={panelEl} class="turns" classList={{ on: panel() !== null }} aria-label={lastPanel()} inert={panel() === null}>
            <Panel which={lastPanel()} place={wide() ? "docked" : "sheet"} heading={sheetHeading} palette={tone()} details={detailsData} turns={turnsData} filling={data.more()} close={{ label: `close ${lastPanel()}`, run: () => showPanel(null) }} />
          </aside>
        </Show>
      </div>
      {/* home's inspector, outside the stage: the panel is carried into it, flat on the ground, under the repo's palette set
          again because the stage's own does not reach it. the element stays while it is folded so the toggles have
          something to name; home fades it as a whole, so the content makes no entrance of its own */}
      <Show when={props.inspector?.el()}>{(el) => (
        <Portal mount={el()} ref={(container) => { inspectEl = container as HTMLDivElement; container.id = panelId; }}>
          <Show when={props.inspector?.view()} keyed>{(view) => (
            <Panel which={view} place="flat" palette={tone()} details={detailsData} turns={turnsData} filling={data.more()} close={view === "turns" ? { label: "back to details", run: () => props.inspector?.show("details") } : undefined} />
          )}</Show>
        </Portal>
      )}</Show>
      <div class="scrim" classList={{ on: menuOpen() || (panel() !== null && !wide()) }} onClick={() => { setMenuOpen(false); if (!wide()) setPanel(null); }} />
    </section>
  );
}

export type { ThreadData };
