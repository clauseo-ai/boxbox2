/* the one second clocks the screens count from (home's footers, the
   composer's offline line, the thread's working clock). a clock is for
   eyes, so it stops while the page is hidden: a hidden page used to run a
   tick a second for each of them, and every tick repainted every window
   nobody could see. coming back, it shows at once what a clock that never
   stopped would show: its last whole tick, counted from when it started.

   logic that reads a clock and must move on while hidden (home's 12 hour
   rule, the composer's offline word) names the moment it next needs
   (`wake`): the clock reaches that tick while hidden too, and no other. so
   what a hidden page decides is what it decided before, and the screen it
   comes back to is the same. */

import { type Accessor, createEffect, createSignal, onCleanup, untrack } from "solid-js";

/** whether the page shows, and a way to hear when that changes: the document's, unless a test gives its own */
export type Page = { visible: () => boolean; watch: (changed: () => void) => () => void };

const documentPage: Page = {
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
  watch: (changed) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  },
};

export type ClockOptions = {
  /** ms between ticks */
  every?: number;
  /** while true a tick leaves the clock where it is (home's, while the stream is offline) */
  held?: () => boolean;
  /** the clock runs only while this is true, and starts again from now each time this is read anew and true (the thread's, while
      a turn runs); always, without it */
  active?: () => boolean;
  /** the moment some logic needs the clock to reach next, ms, read reactively: a hidden page ticks there and nowhere else */
  wake?: () => number | undefined;
  page?: Page;
  /** the time and the timers, for tests */
  time?: () => number;
  timers?: Timers;
};

export type Timers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (run: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

const globalTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

/** the longest a hidden clock waits before it looks at the time again */
const RECHECK_MS = 60_000;

export function createClock(options: ClockOptions = {}): Accessor<number> {
  const every = options.every ?? 1000;
  const page = options.page ?? documentPage;
  const time = options.time ?? Date.now;
  const timers = options.timers ?? globalTimers;
  const held = options.held ?? (() => false);
  const [now, setNow] = createSignal(time());
  const [visible, setVisible] = createSignal(page.visible());
  const [recheck, setRecheck] = createSignal(0);
  onCleanup(page.watch(() => setVisible(page.visible())));
  const tick = () => {
    if (!held()) setNow(time());
  };

  const run = (anchor: number) => {
    /** the time of the last tick a clock started at `anchor` and never stopped would have made by `t` */
    const last = (t: number) => anchor + Math.floor((t - anchor) / every) * every;
    createEffect(() => {
      if (visible()) {
        const back = last(time());
        if (back > untrack(now) && !untrack(held)) setNow(back);
        let interval: unknown;
        const first = timers.setTimeout(() => {
          tick();
          interval = timers.setInterval(tick, every);
        }, back + every - time());
        onCleanup(() => {
          timers.clearTimeout(first);
          if (interval !== undefined) timers.clearInterval(interval);
        });
        return;
      }
      recheck();
      const due = options.wake?.();
      if (due === undefined || held() || now() >= due) return;
      const reached = last(time());
      if (reached >= due) {
        setNow(reached);
        return;
      }
      /* the first tick at or after the moment, looked at again at least every minute: timers stand still while the machine
         sleeps, so one timer of hours would land late by the sleep, where the old interval caught up within a minute */
      const at = last(due) === due ? due : last(due) + every;
      const timer = timers.setTimeout(() => setRecheck((n) => n + 1), Math.min(at - time(), RECHECK_MS));
      onCleanup(() => timers.clearTimeout(timer));
    });
  };

  const active = options.active;
  if (active) {
    createEffect(() => {
      if (!active()) return;
      const anchor = time();
      setNow(anchor);
      untrack(() => run(anchor));
    });
  } else run(untrack(now));
  return now;
}
