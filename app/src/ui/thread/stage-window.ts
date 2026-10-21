/* the log mounted progressively (docs/thread.md, budgets): the stage's side of windowing.ts. every turn is a box of its own on the
   page; an older one is empty, at a remembered or estimated height, until it comes within a few screens of the view, and once
   filled it stays filled: nothing a reader did in it (focus, a selection, an open row, a code block's scroll, words typed) is
   ever taken away by the window. the cost of that is that a box above the reader's eye changes height when it fills in, so this
   file is also the one owner of where the view is, with the end's pin (pin.ts): a fill is made with the reader's anchor taken
   first and put back in the same task, before anything is painted, and a height that changes for any other reason (a late
   highlight, an image) is put back the same way from the frame's resize report. native scroll anchoring is off on the scroller
   (stage.css, `overflow-anchor: none`) so the browser never corrects as well. */

import { type Accessor, batch, createComputed, createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { carried, whenLanded } from "../../motion/animate";
import { layoutTop } from "./ask-landing";
import { HEIGHT_BYTES, type ThreadCaches, cacheKey } from "./memo-cache";
import { type Turn, spawnsOf } from "./model";
import type { Pin } from "./pin";
import { type Near, REACH_SCREENS, SETTLE_MS, alwaysFilled, around, between, calibrate, estimateHeight, firstUnder, keepAt, nextFills, slotAtTop, travel, widthBucket } from "./windowing";

/** a screen and a half of turns is there before the first frame, from the end: what the reader lands on is not painted empty */
const FIRST_SCREENS = 1;
const FIRST_MOST = 4;
/** the turns measured so far that the estimates are scaled by */
const SAMPLES = 40;

export type StageWindow = {
  /** a turn's rows are mounted */
  filled(id: string): boolean;
  /** how tall the empty box of a turn is: what it measured when it was last seen at this width, else an estimate */
  height(turn: Turn): number;
  /** a turn's box, which the window watches: filled by the loop, measured when it changes. answers what stops it */
  slot(el: HTMLElement, id: Accessor<string>, turn: Accessor<Turn>): () => void;
  /** mounts a turn and the ones either side of it, keeps the reader's place, and answers the turn's box: what every move to a
      turn does first (the ruler, the turns panel, a link, an ask), so there is something there to land on */
  reveal(id: string): HTMLElement | null;
  /** the row that started an agent, for a report's link back to it: the last turn's before the report that names the agent, else
      the first anywhere (as the dom search it replaces read it, now that a turn that is not filled has no row to search) */
  agentRow(name: string, before: string): { turn: string; part: string } | null;
  /** the scroller scrolled: the reader's anchor is read again. when it was the reader's own scroll (pin.ts says), fills above the
      view wait for it to settle */
  scrolled(reader: boolean): void;
  /** a finger is on the glass or has left it */
  touch(down: boolean): void;
  /** the page moves the view to where `target` says (a link, the turns panel, an ask, "to the bottom"): the turns on the way are filled
      first, so the heights it lands by are real; while it goes the window writes nothing to the scroll position (a write ends a smooth
      scroll), and when it stops it lands exactly at `target()`. the reader's own touch, wheel or key ends it where they are */
  travel(target: () => number): void;
  /** holds the view by `el` (an ask's row the stage brought to the bar) until the reader scrolls, instead of by what is at the top: rows
      between that grow do not push it down */
  hold(el: HTMLElement | null): void;
  /** a box holds the view now (`hold`): the stage keeps no foot room under it, which the box would rise into */
  holding(): boolean;
  /** a change to the page that may move what the reader looks at (turns arriving above the view): made with their place taken first and
      put back before paint */
  keep(change: () => void): void;
  /** a finger is on the glass, a fling is running or the page is moving the view: a page that has to wait with what it would write to the
      scroll position waits */
  steady(): boolean;
  /** the reader acted on the scroller (a wheel, a key, a touch, a press): a move the page was making stops where it is, and a held box lets go */
  interrupt(): void;
  /** how many turns are mounted, and how many there are (the budget's numbers) */
  counts(): { filled: number; turns: number };
};

export type StageWindowOptions = {
  scroller: () => HTMLElement | undefined;
  /** the thread, which what is remembered is kept under */
  thread: Accessor<string>;
  turns: Accessor<readonly Turn[]>;
  /** the turn that is running now, and the turns that hold a pending ask: filled whatever the view does */
  live: Accessor<string | undefined>;
  asking: Accessor<ReadonlySet<string>>;
  pin: Pin;
  /** where what a turn measured is kept between stages; none (a story) remembers nothing */
  caches?: ThreadCaches | undefined;
  /** puts the end under a view that follows it, now: the stage's own (it holds while a row the reader toggled is laid out). a change to the page
      that a view at the end is made with is followed in the same task, so no layout is ever read with the view where it was */
  follow?: (() => void) | undefined;
};

/** the window of each stage's scroller, for a move made from where only the scroller is known (thread.tsx, bring) */
const windows = new WeakMap<HTMLElement, StageWindow>();

/** moves the view of `scroller` to where `target` says. the stage's window does it when it has one (filling the way first, holding its
    own writes while the move goes, landing exactly); one with no window (a story) scrolls, smooth when it is short */
export function moveTo(scroller: HTMLElement, target: () => number): void {
  const window = windows.get(scroller);
  if (window) { window.travel(target); return; }
  const top = target();
  scroller.scrollTo({ top, behavior: travel(top - scroller.scrollTop, scroller.clientHeight) });
}

export function createStageWindow(options: StageWindowOptions): StageWindow {
  const { pin } = options;
  const [filled, setFilled] = createStore<Record<string, true | undefined>>({});
  const slots = new Map<string, HTMLElement>();
  const owner = new Map<Element, { id: Accessor<string>; turn: Accessor<Turn> }>();
  const near = new Set<string>();
  const seeing = new Set<string>();
  /* the ids in order, which change only when a turn comes or goes: a delta to the running turn does not make the list again */
  const idList = createMemo<readonly string[]>(() => options.turns().map((t) => t.id), [], { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) });
  const ids = (): readonly string[] => idList();
  const scroller = (): HTMLElement | undefined => options.scroller();

  /* ---------- heights ---------- */
  const width = (): number => {
    const s = scroller();
    const said = s ? Number.parseFloat(s.style.getPropertyValue("--scroll-w")) : Number.NaN;
    return Number.isFinite(said) && said > 0 ? said : (s?.clientWidth ?? 390) - 40;
  };
  const estimates = new Map<string, number>();
  const stamps = new Map<string, number>();
  const measured: Array<{ estimated: number; measured: number }> = [];
  const heightFor = (turn: Turn): number => {
    const bucket = widthBucket(width());
    const remembered = options.caches?.heights.get(cacheKey(untrack(options.thread), `${turn.id}\u0000${bucket}`));
    if (remembered !== undefined) return remembered;
    const estimate = Math.round(estimateHeight(turn, width()) * calibrate(measured.slice(-SAMPLES)));
    estimates.set(turn.id, estimate);
    return estimate;
  };
  const remember = (id: string, px: number): void => {
    if (px <= 0) return;
    const thread = untrack(options.thread);
    if (options.caches) {
      /* a mark taken when this stage first wrote for the thread: a stage that outlives a sign-out writes nothing after it */
      if (!stamps.has(thread)) stamps.set(thread, options.caches.stamp(thread));
      options.caches.keep(options.caches.heights, thread, stamps.get(thread) as number, cacheKey(thread, `${id}\u0000${widthBucket(width())}`), px, HEIGHT_BYTES);
    }
    const estimated = estimates.get(id);
    if (estimated !== undefined) {
      measured.push({ estimated, measured: px });
      if (measured.length > SAMPLES * 2) measured.splice(0, SAMPLES);
      estimates.delete(id);
    }
  };

  /* ---------- the reader's place ---------- */
  /** where a box's top is in the scroller's content, to a fraction of a px where the page is drawn at its own size (a layout offset is
      rounded to a whole px at each box it passes, and the view is kept to a pixel); as laid out otherwise, while the layer a thread
      opens in arrives drawn smaller (ask-landing.ts, layoutTop) */
  const topIn = (el: HTMLElement, s: HTMLElement): number => {
    const box = s.getBoundingClientRect();
    if (s.offsetHeight > 0 && Math.abs(box.height / s.offsetHeight - 1) < 0.001) return el.getBoundingClientRect().top - box.top - s.clientTop + s.scrollTop;
    return layoutTop(el, s);
  };
  /** what the reader is looking at: the box at the top of the view, as deep into its turn as the page's own boxes go (a row, a block of
      its answer), and how far its top is from the top of the view; and the turn's own box, for when that one has been replaced */
  type Anchor = { el: HTMLElement; offset: number; slot: string; slotOffset: number };
  let anchor: Anchor | null = null;
  /** where the view was when the anchor was taken: a view that is elsewhere now has been scrolled since, by a write the scroll event
      for which has not been reported yet (a script's, in a frame's callbacks), and is the reader's to keep, not ours to put back */
  let anchoredAt = 0;
  /** a box the view is held by instead of what is at its top, until the reader acts or HOLD_MS (`hold`) */
  let held: HTMLElement | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  /** a move the page is making: where it is going, and the poll that sees it stop */
  let travelling: { target: () => number; last: number; still: number; started: number; poll: ReturnType<typeof setInterval>; ended: () => void } | null = null;
  /* a box with no place of its own is no place to hold the view by */
  const holds = (el: Element): boolean => el.getClientRects().length > 0;
  /** the first box under the top of the view inside `slot`, then the first box of that one, down to where a box has none: the deepest
      thing the reader's eye is above. heights inside a turn change above the eye too (a block of code is highlighted, a font arrives).
      the boxes of a turn are in order down the page, so the first under the top is found by bisection: a turn of a hundred rows costs a
      handful of layout reads on each scroll event, not a hundred at four levels */
  const deepest = (s: HTMLElement, slot: HTMLElement): HTMLElement => {
    let at = slot;
    for (let depth = 0; depth < 4; depth++) {
      const kids = Array.from(at.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
      let lo = 0, hi = kids.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const k = kids[mid] as HTMLElement;
        if (topIn(k, s) + k.offsetHeight > s.scrollTop + 0.5) { found = mid; hi = mid - 1; } else lo = mid + 1;
      }
      // a box with no place of its own (hidden) is no place to hold the view by: the next one is
      while (found >= 0 && found < kids.length && !holds(kids[found] as HTMLElement)) found++;
      if (found < 0 || found >= kids.length) break;
      at = kids[found] as HTMLElement;
    }
    return at;
  };
  /** the turn holding the top of the view (the first when the view is above all of them), and what is under the top inside it */
  const capture = (): void => {
    const s = scroller();
    if (!s || pin.pinned()) { anchor = null; return; }
    if (held?.isConnected) {
      const id = held.closest<HTMLElement>("section.turn[data-turn]")?.dataset["turn"];
      const box = id ? slots.get(id) : undefined;
      if (id && box) { anchor = { el: held, offset: topIn(held, s) - s.scrollTop, slot: id, slotOffset: topIn(box, s) - s.scrollTop }; anchoredAt = s.scrollTop; return; }
    }
    const order = ids().filter((id) => slots.has(id));
    if (!order.length) { anchor = null; return; }
    const at = slotAtTop(order.length, (i) => topIn(slots.get(order[i] as string) as HTMLElement, s), (i) => filled[order[i] as string] === true, s.scrollTop, s.scrollTop + s.clientHeight);
    const id = order[at] as string;
    const slot = slots.get(id) as HTMLElement;
    const el = deepest(s, slot);
    anchor = { el, offset: topIn(el, s) - s.scrollTop, slot: id, slotOffset: topIn(slot, s) - s.scrollTop };
    anchoredAt = s.scrollTop;
  };
  /** `fresh`: the anchor was taken a moment ago in this same task, so a view that is elsewhere now was moved by the browser clamping it to a
      page that has become shorter, not by a script's write: it is put back like any other */
  const restore = (fresh = false): void => {
    const s = scroller();
    if (!s || !anchor || pin.pinned() || travelling) return;
    /* a view that has gone up to the end of a page that became shorter was clamped by the browser, which is not a scroll to keep either */
    const clamped = anchoredAt > s.scrollTop && s.scrollTop >= s.scrollHeight - s.clientHeight - 0.5;
    if (!fresh && !clamped && Math.abs(s.scrollTop - anchoredAt) > 0.5) { capture(); return; }
    const slot = slots.get(anchor.slot);
    /* the box it held is gone (the page replaced it): the turn's box holds the view instead */
    const [el, offset] = anchor.el.isConnected ? [anchor.el, anchor.offset] : slot?.isConnected ? [slot, anchor.slotOffset] : [null, 0];
    if (!el) return;
    pin.place(keepAt(topIn(el, s), offset));
    anchoredAt = s.scrollTop;
  };
  /** a change to the page that may move what the reader looks at: made with their place taken first and put back before paint.
      a view at the end is not held by an anchor (the end is followed, pin.ts) */
  const keeping = (change: () => void): void => {
    /* a move the page is making keeps nothing: the view is going somewhere, and a write to put it back would end it. it lands by what it is
       going to, when it stops (`travel`) */
    if (!scroller() || travelling) { change(); return; }
    /* a view at the end is followed (pin.ts), and in this task, not by the stage's resize observer after the layout: the layout in between
       has the view where it was, and turns made above it have moved everything on screen out of it. nothing is painted so, but the browser
       counts it as a shift (a bare page does the same), once for each block of 32 turns a thread opens with: the budget of 0 was not met */
    if (pin.pinned()) { change(); options.follow?.(); return; }
    capture();
    change();
    restore(true);
  };

  /* ---------- moves the page makes ---------- */
  /** how long a held box (`hold`) holds the view, if the reader does nothing: rows that settle do it in a moment */
  const HOLD_MS = 4000;
  /** the move ended where it was going (the browser says `scrollend`, or the view stood still for two looks, or it took too long): it lands
      by where its target is now, which is not where it was when it began, since turns above filled and rows settled. its one write */
  const endTravel = (land: boolean): void => {
    const t = travelling;
    if (!t) return;
    travelling = null;
    clearInterval(t.poll);
    t.ended();
    const s = scroller();
    if (!s) return;
    if (land) {
      const want = Math.max(0, Math.min(Math.round(t.target()), s.scrollHeight - s.clientHeight));
      if (Math.abs(s.scrollTop - want) > 1) s.scrollTop = want;
    }
    capture();
  };
  /** the index, among the turns that have a box, of the last whose top is at or above `y` */
  const indexAt = (s: HTMLElement, order: readonly string[], y: number): number => {
    let lo = 0, hi = order.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (topIn(slots.get(order[mid] as string) as HTMLElement, s) <= y + 0.5) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const travelTo = (target: () => number): void => {
    const s = scroller();
    if (!s) return;
    endTravel(false);
    held = null;
    /* a far move lands at once, and fills nothing on the way: the turns it goes past are not looked at, and mounting them (hundreds, in one
       task) would keep them mounted for good. the caller has filled the turn it goes to and its neighbours (`reveal`) */
    if (travel(target() - s.scrollTop, s.clientHeight) === "auto") { s.scrollTo({ top: Math.max(0, Math.round(target())) }); return; }
    /* a short one is a smooth scroll, and the turns it goes past are filled first, with the place kept: heights that are real are what it
       lands by, and nothing fills under it */
    const order = ids().filter((id) => slots.has(id));
    if (order.length) fill(between(order.length, indexAt(s, order, s.scrollTop), indexAt(s, order, target())).map((i) => order[i] as string));
    const top = Math.max(0, Math.round(target()));
    const end = () => endTravel(true);
    s.addEventListener("scrollend", end, { once: true });
    const t: NonNullable<typeof travelling> = {
      target,
      last: s.scrollTop,
      still: 0,
      started: performance.now(),
      poll: setInterval(() => {
        if (Math.abs(s.scrollTop - t.last) < 0.5) t.still++; else { t.still = 0; t.last = s.scrollTop; }
        if (t.still >= 2 || performance.now() - t.started > 2500) end();
      }, 80),
      ended: () => s.removeEventListener("scrollend", end),
    };
    travelling = t;
    s.scrollTo({ top, behavior: "smooth" });
  };

  /* ---------- filling ---------- */
  const fill = (wanted: readonly string[]): boolean => {
    const fresh = wanted.filter((id) => !filled[id]);
    if (!fresh.length) return false;
    keeping(() => batch(() => { for (const id of fresh) setFilled(id, true); }));
    for (const id of fresh) slots.get(id)?.removeAttribute("data-waiting");
    return true;
  };
  const must = (): ReadonlySet<string> => alwaysFilled(ids(), options.live(), options.asking());
  /* what has to be there: the newest turns, the running turn, a turn that asks. read as it changes, and made before the frame that
     paints it, so a reply arriving or an ask raised is never an empty box */
  let soonFrame = 0;
  const soon = new Set<string>();
  /* the stage's layer is still pouring, growing or sliding in (home's transition): what the frame after the opening makes is only what is
     on screen then, the rest when it lands. a turn above the first screen is made with the view kept, so it changes no pixel the reader
     sees whenever it is made, and making it in the transition's first frame was the frame the pour dropped (docs/thread.md, budgets) */
  let soonLanding: (() => void) | undefined;
  const makeSoon = (): void => {
    soonFrame = 0;
    const ids = [...soon];
    soon.clear();
    const s = scroller();
    /* only a view at the end is known now: the end is followed after this frame's layout (stage.tsx, resized), so the view the frame paints is
       the scroller's last screen, and a box that reaches into it is made now. a view held anywhere else (a link, an ask, a move) makes them all */
    if (!s || !pin.pinned() || travelling || held || !carried(s)) { fill(ids); return; }
    const box = s.getBoundingClientRect();
    const viewTop = s.scrollHeight - s.clientHeight;
    const now = ids.filter((id) => { const el = slots.get(id); return el === undefined || el.getBoundingClientRect().bottom - box.top - s.clientTop + s.scrollTop > viewTop - 1; });
    for (const id of ids) if (!now.includes(id)) soon.add(id);
    fill(now);
    if (!soon.size) return;
    soonLanding?.();
    soonLanding = whenLanded(s, () => { soonLanding = undefined; soonFrame ||= requestAnimationFrame(makeSoon); });
  };
  onCleanup(() => { cancelAnimationFrame(soonFrame); soonLanding?.(); });
  /* the thread has its turns: what comes after is one or two at a time */
  let populated = false;
  createComputed(() => {
    const wanted = [...must()];
    untrack(() => {
      /* the running turn, a turn that asks and the newest are made in the task that brings them: the reader is looking at them. when a thread opens,
         the older of the newest few are above the first screen, and are made in the frame after (it opens with real rows in three turns, and making
         them all in the task that applies the thread is 55 ms of it). turns that come after are made whole in their task: a frame is painted between
         that task and the next frame's callbacks, and the older of two that arrive together (two reports with a prompt) was an empty box in the view
         of a reader at the end for that frame */
      const ids = idList();
      const live = options.live();
      const asking = options.asking();
      const newest = ids[ids.length - 1];
      const opening = !populated;
      if (wanted.length) populated = true;
      const now = opening ? wanted.filter((id) => id === live || id === newest || asking.has(id)) : wanted;
      fill(now);
      for (const id of wanted) if (!now.includes(id) && !filled[id]) soon.add(id);
      if (soon.size && !soonFrame && !soonLanding) soonFrame = requestAnimationFrame(makeSoon);
    });
  });
  /* the first frame: from the end, what the screen holds and half as much again (the ends of the thread are what a thread opens at) */
  let started = false;
  createComputed(() => {
    const all = options.turns();
    if (started || !all.length) return;
    started = true;
    untrack(() => {
      let px = 0, count = 0;
      const take: string[] = [];
      for (let i = all.length - 1; i >= 0 && px < FIRST_SCREENS * (typeof innerHeight === "number" ? innerHeight : 800) && count < FIRST_MOST; i--) { take.push((all[i] as Turn).id); px += estimateHeight(all[i] as Turn, width()); count++; }
      fill(take);
    });
  });
  /* a turn that left the page is forgotten */
  createEffect(() => {
    const here = new Set(idList());
    for (const id of Object.keys(untrack(() => unwrap(filled)))) if (!here.has(id)) setFilled(id, undefined);
  });

  let touching = false;
  /** a finger has been on this scroller: the page is on a touch screen, whose fling a write to the scroll position ends. a wheel, a trackpad,
      a key and a script have no momentum of that kind to protect, so their scrolls do not hold fills back (the fill is still made with the
      reader's place kept) */
  let touched = false;
  let lastScroll = Number.NEGATIVE_INFINITY;
  /** a finger is down or a fling is running (the page is on a touch screen), or the page is moving the view itself */
  const moving = (): boolean => touching || performance.now() - lastScroll < SETTLE_MS;
  let frame = 0, settle: ReturnType<typeof setTimeout> | undefined;
  let tickLanding: (() => void) | undefined;
  /** the loop's looks at an empty view in a row: nothing is known to be on screen yet, so nothing can be nearest */
  let blind = 0;
  const wake = (): void => { frame ||= requestAnimationFrame(tick); };
  /** the loop: fills the turns the observers say are near, nearest first, a couple a frame. while a finger is down, a fling runs or the page
      moves the view, nothing above the reader's anchor is filled, on screen or not: filling it moves the anchor, and putting the anchor back
      is a write to the scroll position, which ends a fling and a smooth scroll. a turn on screen that waits stays a box of its height and says
      what it is (data-waiting, thread.css), and is filled when the view is still */
  function tick(): void {
    frame = 0;
    const order = ids();
    const index = new Map(order.map((id, i) => [id, i]));
    const candidates: Near[] = [];
    for (const id of near) { const i = index.get(id); if (i !== undefined) candidates.push({ index: i, filled: filled[id] === true }); }
    const see = [...seeing].flatMap((id) => { const i = index.get(id); return i === undefined ? [] : [i]; });
    const holding = moving() || travelling !== null;
    let holdAbove: number | null = null;
    if (holding) {
      if (!anchor && !pin.pinned()) capture();
      holdAbove = (anchor ? index.get(anchor.slot) : undefined) ?? (see.length ? Math.min(...see) : -1);
    }
    /* while the stage's layer is carried in by a transition, the loop makes only what is on screen (which it always makes first, whatever
       its budget), and the turns that are only near wait for it to land: each one made is a frame of the transition's that drops */
    const s = scroller();
    const landing = s !== undefined && carried(s);
    const on = new Set(see);
    const picks = nextFills(landing ? candidates.filter((c) => on.has(c.index)) : candidates, see, holdAbove);
    if (picks.length) fill(picks.map((i) => order[i] as string));
    const waiting = candidates.some((c) => !c.filled && !picks.includes(c.index));
    for (const id of seeing) {
      const box = slots.get(id);
      if (box) box.toggleAttribute("data-waiting", holding && filled[id] !== true);
    }
    if (!waiting) { blind = 0; return; }
    if (landing && s) { tickLanding?.(); tickLanding = whenLanded(s, () => { tickLanding = undefined; wake(); }); return; }
    if (holding) { clearTimeout(settle); settle = setTimeout(wake, travelling ? 120 : SETTLE_MS + 10); return; }
    if (!see.length) {
      // nothing is known to be on screen: looking every frame would be a loop for as long as it lasted. a few looks, a tenth of a second apart; an observer that reports starts it again
      if (blind++ < 10) { clearTimeout(settle); settle = setTimeout(wake, 100); }
      return;
    }
    blind = 0;
    wake();
  }
  onCleanup(() => { cancelAnimationFrame(frame); clearTimeout(settle); clearTimeout(heldTimer); tickLanding?.(); endTravel(false); });

  /* ---------- the observers ---------- */
  let nearWatch: IntersectionObserver | undefined;
  let seeingWatch: IntersectionObserver | undefined;
  let sizeWatch: ResizeObserver | undefined;
  const watchers = (): void => {
    const root = scroller();
    if (nearWatch || !root) return;
    windows.set(root, api);
    const note = (into: Set<string>) => (entries: IntersectionObserverEntry[]) => {
      blind = 0;
      for (const e of entries) { const id = owner.get(e.target)?.id(); if (!id) continue; if (e.isIntersecting) into.add(id); else into.delete(id); }
      wake();
    };
    nearWatch = new IntersectionObserver(note(near), { root, rootMargin: `${REACH_SCREENS * 100}% 0px` });
    seeingWatch = new IntersectionObserver(note(seeing), { root, rootMargin: "0px" });
    /* what a frame's layout changed, read after layout and before paint: a turn that is filled has a height to remember, and the
       reader's place is put back for whatever moved above it (a late highlight, an image). a fill the loop made has already put it back */
    sizeWatch = new ResizeObserver((entries) => {
      for (const e of entries) { const id = owner.get(e.target)?.id(); if (id && filled[id]) remember(id, e.contentRect.height); }
      restore();
    });
  };
  onCleanup(() => { nearWatch?.disconnect(); seeingWatch?.disconnect(); sizeWatch?.disconnect(); nearWatch = seeingWatch = undefined; sizeWatch = undefined; });

  const api: StageWindow = {
    filled: (id) => filled[id] === true,
    height: heightFor,
    slot(el, id, turn) {
      watchers();
      owner.set(el, { id, turn });
      /* read once: a slot's turn keeps its id, and reading it again as the view goes would run the stage's memos while it takes the
         turns down (a thread that leaves the fleet), taking the same turns down twice */
      const at = id();
      slots.set(at, el);
      nearWatch?.observe(el);
      seeingWatch?.observe(el);
      sizeWatch?.observe(el);
      return () => {
        owner.delete(el);
        if (slots.get(at) === el) slots.delete(at);
        near.delete(at);
        seeing.delete(at);
        nearWatch?.unobserve(el);
        seeingWatch?.unobserve(el);
        sizeWatch?.unobserve(el);
      };
    },
    reveal(id) {
      fill(around(ids(), id, 1));
      return slots.get(id) ?? null;
    },
    agentRow(name, before) {
      const all = options.turns();
      const stop = all.findIndex((t) => t.id === before);
      let last: { turn: string; part: string } | null = null, first: { turn: string; part: string } | null = null;
      all.forEach((t, i) => {
        for (const s of spawnsOf(t)) {
          if (s.agent?.name !== name) continue;
          const found = { turn: t.id, part: s.id };
          first ??= found;
          if (stop < 0 || i <= stop) last = found;
        }
      });
      return last ?? first;
    },
    travel: travelTo,
    hold(el) {
      clearTimeout(heldTimer);
      held = el;
      if (el) { heldTimer = setTimeout(() => { held = null; }, HOLD_MS); if (!pin.pinned()) capture(); }
    },
    holding: () => held !== null,
    interrupt() { endTravel(false); clearTimeout(heldTimer); held = null; },
    scrolled(reader) {
      if (reader && touched) lastScroll = performance.now();
      capture();
      if (near.size) { clearTimeout(settle); settle = setTimeout(wake, SETTLE_MS + 10); }
    },
    touch(down) {
      touching = down;
      touched = true;
      if (down) { endTravel(false); clearTimeout(heldTimer); held = null; }
      if (!down) { lastScroll = performance.now(); clearTimeout(settle); settle = setTimeout(wake, SETTLE_MS + 10); }
    },
    keep: keeping,
    steady: () => !(touched && moving()) && travelling === null,
    counts: () => ({ filled: Object.values(filled).filter(Boolean).length, turns: options.turns().length }),
  };
  return api;
}
