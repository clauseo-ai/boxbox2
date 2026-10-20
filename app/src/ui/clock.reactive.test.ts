/* the clocks stop while the page is hidden (ui/clock.ts) and lose nothing by it: against a clock that never stopped, on one
   fake timeline, the first value back and every one after are the same, logic that names a wake sees the same answers while
   hidden, a held clock holds, and a hidden page arms no tick at all. solid's browser build only (`bun test --conditions
   browser`, the justfile's check). */

import { describe, expect, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { type Page, type Timers, createClock } from "./clock";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

/** one fake timeline: timers fire in order as it is moved on, and `now` is its time */
function timeline(start: number) {
  let now = start;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void; every?: number }>();
  const timers: Timers = {
    setTimeout: (run, ms) => { const id = next++; due.set(id, { at: now + Math.max(0, ms), run }); return id; },
    clearTimeout: (id) => { due.delete(id as number); },
    setInterval: (run, ms) => { const id = next++; due.set(id, { at: now + ms, run, every: ms }); return id; },
    clearInterval: (id) => { due.delete(id as number); },
  };
  const to = (t: number) => {
    for (;;) {
      let first: [number, { at: number; run: () => void; every?: number }] | undefined;
      for (const entry of due) if (entry[1].at <= t && (!first || entry[1].at < first[1].at)) first = entry;
      if (!first) break;
      const [id, timer] = first;
      now = timer.at;
      if (timer.every !== undefined) timer.at += timer.every;
      else due.delete(id);
      timer.run();
    }
    now = t;
  };
  /** the machine sleeps: the wall clock moves on, and every timer stands still with it (they fire that much later) */
  const sleep = (ms: number) => {
    now += ms;
    for (const timer of due.values()) timer.at += ms;
  };
  const longest = () => Math.max(0, ...[...due.values()].map((t) => t.at - now));
  return { timers, time: () => now, to, sleep, armed: () => due.size, longest };
}

function page(initially: boolean) {
  const [visible, setVisible] = createSignal(initially);
  let changed = () => {};
  const p: Page = { visible, watch: (fn) => { changed = fn; return () => { changed = () => {}; }; } };
  return { page: p, set: (v: boolean) => { setVisible(v); changed(); } };
}

const T0 = 1_790_000_000_123;

describe.skipIf(!reactive)("clock", () => {
  test("hidden then visible: the first value back and every one after match a clock that never stopped", () => {
    const line = timeline(T0);
    const shown = page(true);
    {
      let dispose = () => {};
      const clock = createRoot((d) => { dispose = d; return createClock({ page: shown.page, time: line.time, timers: line.timers }); });
      // the clock as it was: an interval from the start, Date.now() at each tick
      let reference = line.time();
      line.timers.setInterval(() => { reference = line.time(); }, 1000);
      for (let t = 0; t <= 4000; t += 250) { line.to(T0 + t); expect(clock()).toBe(reference); }
      shown.set(false);
      // hidden: the reference's interval is the only timer left
      expect(line.armed()).toBe(1);
      line.to(T0 + 4000 + 93_617);
      shown.set(true);
      expect(clock()).toBe(reference);
      for (let t = 0; t <= 5000; t += 125) { line.to(T0 + 97_617 + t); expect(clock()).toBe(reference); }
      dispose();
    }
  });

  test("a wake is reached while hidden, at the same tick the never stopped clock reached it, and logic reads the same", () => {
    const line = timeline(T0);
    const shown = page(true);
    {
      let dispose = () => {};
      const [due, setDue] = createSignal<number | undefined>(undefined);
      const clock = createRoot((d) => { dispose = d; return createClock({ page: shown.page, time: line.time, timers: line.timers, wake: due }); });
      let reference = line.time();
      line.timers.setInterval(() => { reference = line.time(); }, 1000);
      line.to(T0 + 2500);
      shown.set(false);
      setDue(T0 + 30_400);
      for (let t = 2500; t <= 40_000; t += 100) {
        line.to(T0 + t);
        expect(clock() >= T0 + 30_400).toBe(reference >= T0 + 30_400);
      }
      // a moment already passed while the clock held still is reached at once, at the tick that passed it
      setDue(T0 + 35_000);
      expect(clock()).toBe(reference);
      shown.set(true);
      expect(clock()).toBe(reference);
      dispose();
    }
  });

  test("held, it holds while visible and while hidden, and moves on at the next tick once let go", () => {
    const line = timeline(T0);
    const shown = page(true);
    {
      let dispose = () => {};
      const [held, setHeld] = createSignal(false);
      const clock = createRoot((d) => { dispose = d; return createClock({ page: shown.page, time: line.time, timers: line.timers, held }); });
      let reference = line.time();
      line.timers.setInterval(() => { if (!held()) reference = line.time(); }, 1000);
      line.to(T0 + 3000);
      setHeld(true);
      line.to(T0 + 9000);
      expect(clock()).toBe(T0 + 3000);
      shown.set(false);
      line.to(T0 + 20_000);
      shown.set(true);
      expect(clock()).toBe(reference);
      setHeld(false);
      line.to(T0 + 21_000);
      expect(clock()).toBe(reference);
      dispose();
    }
  });

  test("active: it starts from now each time it turns on, ticks a second from there, and arms nothing while off", () => {
    const line = timeline(T0);
    const shown = page(true);
    {
      let dispose = () => {};
      const [on, setOn] = createSignal(false);
      const clock = createRoot((d) => { dispose = d; return createClock({ page: shown.page, time: line.time, timers: line.timers, active: on }); });
      line.to(T0 + 5000);
      expect(line.armed()).toBe(0);
      expect(clock()).toBe(T0);
      setOn(true);
      expect(clock()).toBe(T0 + 5000);
      line.to(T0 + 7500);
      expect(clock()).toBe(T0 + 7000);
      setOn(false);
      expect(line.armed()).toBe(0);
      line.to(T0 + 9300);
      setOn(true);
      expect(clock()).toBe(T0 + 9300);
      line.to(T0 + 10_400);
      expect(clock()).toBe(T0 + 10_300);
      dispose();
    }
  });

  test("starting hidden: no tick is armed but the wake's, it is reached at the tick the never stopped clock reached it, and showing gives that clock's value", () => {
    const line = timeline(T0);
    const shown = page(false);
    let dispose = () => {};
    const due = T0 + 7500;
    const clock = createRoot((d) => { dispose = d; return createClock({ page: shown.page, time: line.time, timers: line.timers, wake: () => due }); });
    let reference = line.time();
    line.timers.setInterval(() => { reference = line.time(); }, 1000);
    // the reference's interval and the one wake
    expect(line.armed()).toBe(2);
    for (let t = 0; t <= 12_000; t += 100) {
      line.to(T0 + t);
      expect(clock() >= due).toBe(reference >= due);
    }
    line.to(T0 + 15_250);
    shown.set(true);
    expect(clock()).toBe(reference);
    dispose();
  });

  test("hidden across a sleep: a wake hours away is looked at every minute, so it is reached within a minute of the machine waking", () => {
    const line = timeline(T0);
    const shown = page(false);
    let dispose = () => {};
    const due = T0 + 3 * 60 * 60 * 1000;
    const clock = createRoot((d) => { dispose = d; return createClock({ page: shown.page, time: line.time, timers: line.timers, wake: () => due }); });
    line.to(T0 + 1);
    expect(line.longest()).toBeLessThanOrEqual(60_000);
    line.to(T0 + 30 * 60 * 1000);
    // the machine sleeps four hours: past the moment, and no timer ran meanwhile
    line.sleep(4 * 60 * 60 * 1000);
    expect(clock()).toBeLessThan(due);
    line.to(line.time() + 60_000);
    expect(clock()).toBeGreaterThanOrEqual(due);
    dispose();
  });
});
