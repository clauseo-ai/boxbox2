/* the motion helpers against stand-ins for the dom's animation objects (bun has no web animations): what the code asks of
   them is pinned here, and how browsers then move is pinned by the frame-by-frame compare in docs/gotchas.md (home, webkit
   keeps every animation) */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { flip, settleIn } from "./animate";

class FakeEffect {
  constructor(
    public target: Element | null,
    public frames: Keyframe[] = [],
    public timing: object = {},
  ) {}
  setKeyframes(frames: Keyframe[]) {
    this.frames = frames;
  }
  updateTiming(timing: object) {
    this.timing = timing;
  }
}
class FakeAnimation {
  calls: string[] = [];
  startTime: number | null = null;
  #time: number | null = 0;
  constructor(public effect: FakeEffect) {}
  get currentTime() {
    return this.#time;
  }
  set currentTime(t: number | null) {
    this.calls.push(`currentTime=${t}`);
    this.#time = t;
  }
  play() {
    this.calls.push("play");
  }
  cancel() {
    this.calls.push("cancel");
  }
}
class FakeCss extends FakeAnimation {
  constructor(
    effect: FakeEffect,
    public animationName: string,
  ) {
    super(effect);
  }
}

const globals = globalThis as Record<string, unknown>;
const saved = { CSSAnimation: globals["CSSAnimation"], KeyframeEffect: globals["KeyframeEffect"] };
beforeAll(() => {
  globals["CSSAnimation"] = FakeCss;
  globals["KeyframeEffect"] = FakeEffect;
});
afterAll(() => {
  globals["CSSAnimation"] = saved.CSSAnimation;
  globals["KeyframeEffect"] = saved.KeyframeEffect;
});

/** an element as the helpers see it: a box, the animations on it (and under it), a class list and listeners */
function element(left = 0) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const classes = new Set<string>();
  const el = {
    left,
    isConnected: true,
    own: [] as FakeAnimation[],
    under: [] as FakeAnimation[],
    made: [] as FakeAnimation[],
    getBoundingClientRect: () => ({ left: el.left, top: 0 }) as DOMRect,
    getAnimations: (options?: { subtree?: boolean }) => (options?.subtree ? [...el.own, ...el.under] : el.own),
    animate(frames: Keyframe[], timing: object) {
      const a = new FakeAnimation(new FakeEffect(el as unknown as Element, frames, timing));
      el.made.push(a);
      el.own = [a];
      return a;
    },
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    addEventListener: (type: string, f: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(f);
    },
    removeEventListener: (type: string, f: (event: Event) => void) => listeners.get(type)?.delete(f),
    fire(type: string, props: object) {
      for (const f of [...(listeners.get(type) ?? [])]) f({ type, target: el, ...props } as unknown as Event);
    },
    listening: (type: string) => listeners.get(type)?.size ?? 0,
  };
  return el;
}

describe("a word's settle", () => {
  test("drops its class once the fade has ended, so a move or a show later does not fade it in again", () => {
    const span = element();
    settleIn(span as unknown as Element);
    expect(span.classList.contains("settle-in")).toBe(true);
    span.fire("animationend", { animationName: "something-else" });
    expect(span.classList.contains("settle-in")).toBe(true);
    span.fire("animationend", { animationName: "settle-in" });
    expect(span.classList.contains("settle-in")).toBe(false);
    expect(span.listening("animationend")).toBe(0);
  });

  test("a reorder hands a fade still running its start time back, so it carries on where it was", () => {
    const win = element(0);
    const span = element();
    const fading = new FakeCss(new FakeEffect(span as unknown as Element), "settle-in");
    fading.startTime = 1000;
    win.under = [fading];
    // the move puts the span back in the page: the browser starts its css animation over
    const restarted = new FakeCss(new FakeEffect(span as unknown as Element), "settle-in");
    flip([win as unknown as Element], () => {
      win.left = 200;
      span.own = [restarted];
    });
    expect(restarted.startTime).toBe(1000);
  });

  test("a fade not started yet keeps its place by its current time, and the same holds with motion off", () => {
    const win = element(0);
    const span = element();
    const fading = new FakeCss(new FakeEffect(span as unknown as Element), "settle-in");
    fading.currentTime = 40;
    win.under = [fading];
    const restarted = new FakeCss(new FakeEffect(span as unknown as Element), "settle-in");
    flip([win as unknown as Element], () => (span.own = [restarted]), undefined, false);
    expect(restarted.currentTime).toBe(40);
  });
});

describe("a window moved at a reorder", () => {
  test("is given one animation, and moved again restarts it as a new one starts: cancelled, then played", () => {
    const win = element(0);
    flip([win as unknown as Element], () => (win.left = 100));
    expect(win.made.length).toBe(1);
    const first = win.made[0] as FakeAnimation;
    flip([win as unknown as Element], () => (win.left = 300));
    flip([win as unknown as Element], () => (win.left = 0));
    expect(win.made.length).toBe(1);
    expect(first.calls).toEqual(["cancel", "play", "cancel", "play"]);
    expect(first.effect.frames[0]).toEqual({ transform: "translate(300px, 0px)" });
  });
});
