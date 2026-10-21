/* the stage's window over a scroller and boxes that are only numbers (docs/thread.md, the window): what a move fills, and what writes while
   it goes. there is no dom in this pass, so the scroller and its boxes are the few things the window reads of them (a top, a height, the
   scroll position); the layout is a thread of equal turns. these need solid's browser build (the justfile's check runs them with the
   others), and skip themselves in the plain pass. */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import type { Turn } from "./model";
import type { Pin } from "./pin";
import { createStageWindow } from "./stage-window";
import { play } from "../../motion/animate";
import { SHEET } from "../../motion/springs";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

class Watch { observe() {} unobserve() {} disconnect() {} }
const g = globalThis as Record<string, unknown>;
g["IntersectionObserver"] ??= Watch;
g["ResizeObserver"] ??= Watch;
g["requestAnimationFrame"] ??= (run: () => void) => setTimeout(run, 0) as unknown as number;
g["cancelAnimationFrame"] ??= (id: number) => clearTimeout(id);

const TURN = 500, VIEW = 800, N = 300;
type Scrolled = { top: number; behavior: string | undefined };

function rig(own: { pinned?: boolean; follow?: () => void } = {}) {
  const scrolls: Scrolled[] = [];
  const s = {
    scrollTop: 0, clientHeight: VIEW, offsetHeight: VIEW, clientTop: 0, clientWidth: 430, scrollHeight: N * TURN,
    style: { getPropertyValue: () => "" },
    getBoundingClientRect: () => ({ top: 0, height: VIEW }),
    scrollTo(o: { top: number; behavior?: string }) { scrolls.push({ top: o.top, behavior: o.behavior }); if (o.behavior !== "smooth") s.scrollTop = o.top; },
    addEventListener() {}, removeEventListener() {},
  };
  const places: number[] = [];
  const pin = { pinned: () => own.pinned === true, place: (top: number) => { places.push(top); s.scrollTop = Math.round(top); } } as unknown as Pin;
  const turn = (i: number): Turn => ({ id: `t${i}`, by: "you", prompt: "a question", items: [], files: new Map(), status: "done", at: i, end: i, cost: 0, compacted: false, unknownParts: 0 }) as unknown as Turn;
  const turns = Array.from({ length: N }, (_, i) => turn(i));
  const box = (i: number) => ({
    children: [], dataset: { turn: `t${i}` }, isConnected: true, offsetHeight: TURN,
    classList: { contains: () => false },
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: i * TURN - s.scrollTop, bottom: (i + 1) * TURN - s.scrollTop, height: TURN }),
    closest: () => null, removeAttribute() {}, toggleAttribute() {},
  });
  const boxes: unknown[] = [];
  const made = createRoot((dispose) => {
    const win = createStageWindow({ scroller: () => s as unknown as HTMLElement, thread: () => "desk:far", turns: () => turns, live: () => undefined, asking: () => new Set(), pin, ...(own.follow ? { follow: own.follow } : {}) });
    for (let i = 0; i < N; i++) { const b = box(i); boxes.push(b); win.slot(b as unknown as HTMLElement, () => `t${i}`, () => turns[i] as Turn); }
    return { win, dispose };
  });
  const filled = (): number => turns.filter((t) => made.win.filled(t.id)).length;
  const isFilled = (i: number): boolean => made.win.filled(`t${i}`);
  return { ...made, s, scrolls, places, filled, isFilled, boxes };
}

afterEach(() => { jest.useRealTimers(); });

describe.skipIf(!reactive)("a far move through the stage window", () => {
  test("from the end of 300 turns to the first lands at once and fills nothing on the way", () => {
    const r = rig();
    r.s.scrollTop = N * TURN - VIEW;
    const before = r.filled();
    r.win.travel(() => 0);
    expect(r.scrolls).toEqual([{ top: 0, behavior: undefined }]);
    expect(r.filled()).toBe(before);
    expect(before).toBeLessThan(10);
    r.dispose();
  });
  test("and the same going the other way, from the first turn to the bottom", () => {
    const r = rig();
    const before = r.filled();
    r.win.travel(() => N * TURN - VIEW);
    expect(r.filled()).toBe(before);
    expect(r.scrolls.at(-1)?.behavior).toBeUndefined();
    r.dispose();
  });
});

describe.skipIf(!reactive)("a short move through the stage window", () => {
  test("is smooth, and the turns it goes past, and one beyond each end, are filled before it starts", () => {
    jest.useFakeTimers();
    const r = rig();
    r.s.scrollTop = 200 * TURN;
    r.win.travel(() => 197 * TURN);
    expect(r.scrolls).toEqual([{ top: 197 * TURN, behavior: "smooth" }]);
    for (let i = 196; i <= 201; i++) expect(r.isFilled(i)).toBe(true);
    expect(r.isFilled(150)).toBe(false);
    r.dispose();
  });
  test("writes nothing to the scroll position while it goes, whatever fills", () => {
    jest.useFakeTimers();
    const r = rig();
    r.s.scrollTop = 200 * TURN;
    r.win.travel(() => 197 * TURN);
    const writes = r.places.length;
    r.win.reveal("t190");
    r.win.reveal("t210");
    expect(r.isFilled(190)).toBe(true);
    expect(r.places.length).toBe(writes);
    r.dispose();
  });
  test("lands by where its target is when it stops, not where it was when it began", () => {
    jest.useFakeTimers();
    const r = rig();
    r.s.scrollTop = 200 * TURN;
    r.win.travel(() => 197 * TURN);
    // the browser stopped short, as a smooth scroll does when what is under it moved
    r.s.scrollTop = 197 * TURN + 120;
    jest.advanceTimersByTime(400);
    expect(r.s.scrollTop).toBe(197 * TURN);
    r.dispose();
  });
  test("the reader's touch ends it where they are", () => {
    jest.useFakeTimers();
    const r = rig();
    r.s.scrollTop = 200 * TURN;
    r.win.travel(() => 197 * TURN);
    r.s.scrollTop = 199 * TURN;
    r.win.touch(true);
    jest.advanceTimersByTime(2000);
    expect(r.s.scrollTop).toBe(199 * TURN);
    r.dispose();
  });
  test("a new move replaces the one that was going", () => {
    jest.useFakeTimers();
    const r = rig();
    r.s.scrollTop = 200 * TURN;
    r.win.travel(() => 197 * TURN);
    r.win.travel(() => 203 * TURN);
    r.s.scrollTop = 203 * TURN - 40;
    jest.advanceTimersByTime(400);
    expect(r.s.scrollTop).toBe(203 * TURN);
    r.dispose();
  });
});

describe.skipIf(!reactive)("a change made to the page while the view follows the end", () => {
  test("is followed to the end in the same task, after it is made: the browser never lays out the view at a place the stage meant to leave", () => {
    /* the end was put back by a resize observer, after the layout, and the layout-shift entries counted the layout in between: 32 turns coming in
       above a view at the end moved everything on screen out of it, once for each (0.37 apiece in chromium, a bare page does it too) */
    const order: string[] = [];
    const r = rig({ pinned: true, follow: () => order.push("follow") });
    order.length = 0;
    r.win.keep(() => order.push("change"));
    expect(order).toEqual(["change", "follow"]);
    r.dispose();
  });
  test("a fill above the view is one of them", () => {
    const order: string[] = [];
    const r = rig({ pinned: true, follow: () => order.push("follow") });
    r.s.scrollTop = N * TURN - VIEW;
    order.length = 0;
    r.win.reveal("t250");
    expect(r.isFilled(250)).toBe(true);
    expect(order).toEqual(["follow"]);
    r.dispose();
  });
  test("a view that is not at the end is held by what it looks at, and is not taken to the end", () => {
    const order: string[] = [];
    const r = rig({ pinned: false, follow: () => order.push("follow") });
    r.s.scrollTop = 100 * TURN;
    order.length = 0;
    r.win.keep(() => order.push("change"));
    expect(order).toEqual(["change"]);
    r.dispose();
  });
  test("a move the page is making takes it nowhere, whatever fills: it lands where it goes", () => {
    jest.useFakeTimers();
    const order: string[] = [];
    const r = rig({ pinned: true, follow: () => order.push("follow") });
    r.s.scrollTop = 200 * TURN;
    r.win.travel(() => 197 * TURN);
    order.length = 0;
    r.win.keep(() => order.push("change"));
    expect(order).toEqual(["change"]);
    r.dispose();
  });
});

describe.skipIf(!reactive)("turns that arrive", () => {
  const made = (i: number): Turn => ({ id: `t${i}`, by: "you", prompt: "a question", items: [], files: new Map(), status: "done", at: i, end: i, cost: 0, compacted: false, unknownParts: 0 }) as unknown as Turn;
  const open = (count: number) => {
    const [list, setList] = createSignal<Turn[]>(Array.from({ length: count }, (_, i) => made(i)));
    const pin = { pinned: () => true, place() {}, follow() {} } as unknown as Pin;
    const win = createRoot((dispose) => ({ win: createStageWindow({ scroller: () => undefined, thread: () => "desk:arrive", turns: list, live: () => undefined, asking: () => new Set(), pin }), dispose }));
    return { ...win, setList };
  };
  test("every one of the newest three that a batch brings is made in the task that brings it: the older of two arriving together is no empty box for a frame", () => {
    /* a frame is painted between the task that applies the patches and the next frame's callbacks: a turn that waited for that callback was an empty
       box in the view of a reader at the end for one frame (two reports arriving with a prompt, under load) */
    const r = open(40);
    r.setList((all) => [...all, made(40), made(41)]);
    expect(r.win.filled("t41")).toBe(true);
    expect(r.win.filled("t40")).toBe(true);
    r.dispose();
  });
});

/* home's transition carries the stage's layer in (a pour, a grow, an agent sliding over its parent): the frame after a thread opens is one of
   the transition's, and what it makes there that the reader cannot see is a dropped frame (docs/thread.md, budgets). a layer here is a box the
   scroller sits in, moved by `play` with an animation the test lands by hand */
describe.skipIf(!reactive)("a thread opening while its layer is carried in", () => {
  const frame = () => new Promise((done) => setTimeout(done, 5));
  const carry = (scroller: unknown) => {
    let land = () => {};
    const animation = { playState: "running", finished: new Promise<void>((done) => { land = done; }) };
    const layer = { isConnected: true, contains: (el: unknown) => el === scroller, animate: () => animation };
    play(layer as unknown as Element, [{ transform: "translateX(100%)" }, { transform: "none" }], SHEET);
    return () => { animation.playState = "finished"; land(); };
  };
  /* the first screen is one turn tall here, so the older two of the newest three are left to the frame after; the view is at the end */
  const opening = () => {
    const was = g["innerHeight"];
    g["innerHeight"] = 1;
    const r = rig({ pinned: true });
    g["innerHeight"] = was;
    return r;
  };
  test("with nothing carrying it, the frame after makes the older of the newest three, on screen or not", async () => {
    const r = opening();
    expect([r.isFilled(N - 1), r.isFilled(N - 2), r.isFilled(N - 3)]).toEqual([true, false, false]);
    await frame();
    expect([r.isFilled(N - 2), r.isFilled(N - 3)]).toEqual([true, true]);
    r.dispose();
  });
  test("while it is carried in, the frame after makes the one that reaches into the last screen, and the other when it lands", async () => {
    const r = opening();
    const land = carry(r.s);
    expect([r.isFilled(N - 1), r.isFilled(N - 2), r.isFilled(N - 3)]).toEqual([true, false, false]);
    await frame();
    // the last screen is the end's 800 px: turn N - 2 reaches 300 px into it, turn N - 3 ends 200 px above it
    expect([r.isFilled(N - 2), r.isFilled(N - 3)]).toEqual([true, false]);
    await frame();
    expect(r.isFilled(N - 3)).toBe(false);
    land();
    await frame();
    await frame();
    expect(r.isFilled(N - 3)).toBe(true);
    r.dispose();
  });
  test("a view held anywhere but the end makes them all in the frame after, carried or not: where it will be is not known yet", async () => {
    const was = g["innerHeight"];
    g["innerHeight"] = 1;
    const r = rig({ pinned: false });
    g["innerHeight"] = was;
    const land = carry(r.s);
    await frame();
    expect([r.isFilled(N - 2), r.isFilled(N - 3)]).toEqual([true, true]);
    land();
    r.dispose();
  });

  test("while it is carried in, the loop makes the turns on screen and leaves the ones only near the view until it lands", async () => {
    /* the observers say what is near and what is on screen, as the browser would after the first frame's layout */
    const watchers: Array<{ margin: string; report: (entries: unknown[]) => void }> = [];
    const was = g["IntersectionObserver"];
    g["IntersectionObserver"] = class { constructor(report: (entries: unknown[]) => void, o: { rootMargin: string }) { watchers.push({ margin: o.rootMargin, report }); } observe() {} unobserve() {} disconnect() {} };
    const r = opening();
    g["IntersectionObserver"] = was;
    await frame();
    const land = carry(r.s);
    const near = watchers.find((w) => w.margin !== "0px");
    const seeing = watchers.find((w) => w.margin === "0px");
    // the view sits on turn N - 10 (a link, say, though the end is followed here) and turns N - 14 to N - 6 are near it
    seeing?.report([{ target: r.boxes[N - 10], isIntersecting: true }]);
    near?.report([N - 14, N - 13, N - 12, N - 11, N - 10, N - 9, N - 8, N - 7, N - 6].map((i) => ({ target: r.boxes[i], isIntersecting: true })));
    await frame();
    expect(r.isFilled(N - 10)).toBe(true);
    expect([N - 14, N - 12, N - 9, N - 6].map((i) => r.isFilled(i))).toEqual([false, false, false, false]);
    await frame();
    expect(r.isFilled(N - 9)).toBe(false);
    land();
    for (let i = 0; i < 12; i++) await frame();
    expect([N - 14, N - 12, N - 9, N - 6].map((i) => r.isFilled(i))).toEqual([true, true, true, true]);
    r.dispose();
  });
});
