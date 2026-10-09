/* which agents the stage holds: never more than the worker's reserve can keep, so a pack of spawns on one screen does not hold, evict
   and hold again; a wanted one that was evicted is held again, a few times; one no longer wanted is released */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { HOLD_CAP, REHOLDS, type Wanted, chooseHolds, createHolds, isRead } from "./holds";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

const keys = (n: number, p = "desk:c"): string[] => Array.from({ length: n }, (_, i) => `${p}${i}`);
const near = (n: number): Wanted[] => keys(n).map((key, i) => ({ key, distance: (n - i) * 100 }));

describe("a thread that is read", () => {
  const thread = (status: string, n: number) => ({ status, messages: { length: n } });
  test("one the worker has only started is not read, so its steps are not counted as none", () => {
    expect(isRead(undefined)).toBe(false);
    expect(isRead(thread("hydrating", 0))).toBe(false);
  });
  test("one that is live is read, empty or not", () => {
    expect(isRead(thread("live", 0))).toBe(true);
    expect(isRead(thread("live", 40))).toBe(true);
  });
  test("one restored from the cache and stale is read as far as it shows", () => {
    expect(isRead(thread("hydrating", 12))).toBe(true);
  });
});

describe("which agents are wanted", () => {
  test("forty on one screen are capped under the reserve, the nearest to the view", () => {
    const picked = chooseHolds([], near(40));
    expect(picked).toHaveLength(HOLD_CAP);
    expect(HOLD_CAP).toBeLessThan(16);
    expect(picked[0]).toBe("desk:c39");
    expect(picked.at(-1)).toBe(`desk:c${40 - HOLD_CAP}`);
  });
  test("the live ones come first, and take the places the screen would have had", () => {
    const live = keys(5, "desk:live");
    const picked = chooseHolds(live, near(40));
    expect(picked.slice(0, 5)).toEqual(live);
    expect(picked).toHaveLength(HOLD_CAP);
  });
  test("a live agent that is also on screen is wanted once", () => {
    expect(chooseHolds(["desk:c1"], near(3))).toEqual(["desk:c1", "desk:c2", "desk:c0"]);
  });
  test("more live than the cap: the cap holds, live in the order given", () => {
    expect(chooseHolds(keys(30), [])).toEqual(keys(HOLD_CAP));
  });
});

describe.skipIf(!reactive)("holding them", () => {
  function rig(opts: { cap?: number } = {}) {
    const holds: string[] = [], releases: string[] = [];
    const [live, setLive] = createSignal<string[]>([]);
    const [visible, setVisible] = createSignal<Wanted[]>([]);
    const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set());
    const root = createRoot((dispose) => {
      const target = createHolds({ live, visible, present: (k) => !gone().has(k), hold: (k) => holds.push(k), release: (k) => releases.push(k), ...(opts.cap ? { cap: opts.cap } : {}) });
      return { dispose, target };
    });
    return { holds, releases, setLive, setVisible, setGone, ...root };
  }
  /** time passes by the page's own timers, as it does in the browser: nothing the holds read changes */
  const wait = (ms: number): void => { jest.advanceTimersByTime(ms); };
  afterEach(() => { jest.useRealTimers(); });

  test("forty agents wanted at once: the worker is asked for the cap and no more, and not again as the screen holds still", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setVisible(near(40));
    expect(r.holds).toHaveLength(HOLD_CAP);
    r.setVisible([...near(40)]);
    wait(60_000);
    expect(r.holds).toHaveLength(HOLD_CAP);
    expect(r.releases).toEqual([]);
    r.dispose();
  });

  test("an agent that leaves the screen is released, and one that arrives is held", () => {
    const r = rig();
    r.setVisible([{ key: "desk:a", distance: 1 }, { key: "desk:b", distance: 2 }]);
    r.setVisible([{ key: "desk:b", distance: 1 }, { key: "desk:c", distance: 2 }]);
    expect(r.holds).toEqual(["desk:a", "desk:b", "desk:c"]);
    expect(r.releases).toEqual(["desk:a"]);
    r.dispose();
  });

  test("an agent the worker evicted while it is still wanted is held again", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setLive(["desk:a"]);
    wait(5000);
    r.setGone(new Set(["desk:a"]));
    expect(r.holds).toEqual(["desk:a", "desk:a"]);
    r.dispose();
  });

  test("an agent that is evicted again and again is asked for a few times, not in a loop", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setLive(["desk:a"]);
    wait(5000);
    // 15 rounds of 1.6 s: 24 s, inside the 30 s the budget is counted in
    for (let i = 0; i < 15; i++) {
      wait(1600);
      r.setGone(new Set(["desk:a"]));
      r.setGone(new Set<string>());
    }
    expect(r.holds.length).toBe(1 + REHOLDS);
    r.dispose();
  });

  test("a thread that is not in the store yet is not held twice for being absent a moment", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setGone(new Set(["desk:a"]));
    r.setLive(["desk:a"]);
    wait(300);
    r.setGone(new Set(["desk:a", "desk:x"]));
    expect(r.holds).toEqual(["desk:a"]);
    r.dispose();
  });

  test("when the parent leaves the stage, everything held is released", () => {
    const r = rig();
    r.setLive(["desk:a", "desk:b"]);
    r.dispose();
    expect(r.releases.sort()).toEqual(["desk:a", "desk:b"]);
  });

  test("a stage that closes releases every place it leased, and only those: the worker keeps a lease until it is released", () => {
    const r = rig();
    r.setLive(["desk:live0", "desk:live1"]);
    r.setVisible(near(40));
    expect(r.holds).toHaveLength(HOLD_CAP);
    r.setVisible(near(40).slice(0, 5));
    const stillHeld = r.holds.filter((k) => !r.releases.includes(k));
    expect(stillHeld.length).toBeGreaterThan(0);
    r.dispose();
    // every lease it took, released once: none left, none twice
    expect(new Set(r.releases)).toEqual(new Set(r.holds));
    expect(r.releases.length).toBe(new Set(r.holds).size);
  });

  test("an agent that goes quiet is released when it is no longer live and not on screen", () => {
    const r = rig();
    r.setLive(["desk:a"]);
    r.setLive([]);
    expect(r.releases).toEqual(["desk:a"]);
    r.dispose();
  });

  test("a hold the worker refused is asked again by the holds' own timer, with nothing they read having changed", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setGone(new Set(["desk:a"]));
    r.setLive(["desk:a"]);
    expect(r.holds).toEqual(["desk:a"]);
    wait(2000);
    expect(r.holds).toEqual(["desk:a", "desk:a"]);
    wait(2000);
    wait(2000);
    expect(r.holds).toHaveLength(1 + REHOLDS);
    // the budget is spent: it is not asked in a loop...
    wait(20_000);
    expect(r.holds).toHaveLength(1 + REHOLDS);
    // ...and asked again once the window has let the first of them go
    wait(30_000);
    expect(r.holds.length).toBeGreaterThan(1 + REHOLDS);
    r.dispose();
  });

  test("an agent evicted a moment after it was held is held again once it has had its time to settle", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setLive(["desk:a"]);
    wait(200);
    r.setGone(new Set(["desk:a"]));
    expect(r.holds).toEqual(["desk:a"]);
    wait(2000);
    expect(r.holds).toEqual(["desk:a", "desk:a"]);
    r.dispose();
  });

  test("a hold that arrived needs no asking again, and its timer is let go", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setLive(["desk:a"]);
    wait(60_000);
    expect(r.holds).toEqual(["desk:a"]);
    r.dispose();
  });

  test("a stage that closes, or an agent no longer wanted, asks for nothing more afterwards", () => {
    jest.useFakeTimers();
    const r = rig();
    r.setGone(new Set(["desk:a", "desk:b"]));
    r.setLive(["desk:a", "desk:b"]);
    r.setLive(["desk:a"]);
    r.dispose();
    const asked = r.holds.length;
    wait(120_000);
    expect(r.holds).toHaveLength(asked);
  });
});
