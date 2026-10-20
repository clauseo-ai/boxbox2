/* each window's view is a memo of its own (views.ts): through a seeded run of the stream (fixtures/fleet-sim.ts) every
   window's view must equal the view made fresh from the fleet after every step, and a frame must make the view of the thread
   it names and no other, where the old list made every window's view again. solid's browser build only (`bun test
   --conditions browser`, the justfile's check). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import type { Ask } from "../../sync/protocol";
import type { Fleet } from "../../sync/reducer";
import { extraOf } from "../inbox/extra";
import { windowView } from "../window/view";
import { setPath, simulate } from "./fixtures/fleet-sim";
import { createViews } from "./views";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

const journal = readFileSync(join(import.meta.dir, "fixtures", "journal.ndjson"), "utf8");

describe.skipIf(!reactive)("home's window views", () => {
  for (const fine of [false, true]) {
    test(`equal a fresh view after every step, and a frame makes only its own thread's (${fine ? "changed leaves" : "whole entries"})`, () => {
      const sim = simulate(journal, { sessions: 300, steps: 400, seed: fine ? 21 : 13, fine });
      const [store, setStore] = createStore<{ fleet: Fleet }>({ fleet: structuredClone(sim.start) });
      let made = 0;
      let madeBefore = 0;
      const r = createRoot((dispose) => {
        const order = createMemo(() => [...store.fleet.order]);
        const asksBy = createMemo(() => {
          const by: Record<string, Ask[]> = {};
          for (const ask of Object.values(store.fleet.asks)) (by[ask.key] ??= []).push(ask);
          return by;
        });
        const make = (key: string, asks: readonly Ask[]) => {
          const entry = store.fleet.sessions[key];
          return entry ? windowView(entry, asks, store.fleet.colours, extraOf(entry)) : null;
        };
        const viewOf = createViews(order, asksBy, (key, asks) => { made++; return make(key, asks); });
        // the list as home had it: every window's view made again whenever anything it read changed
        const before = createMemo(() => order().map((key) => { madeBefore++; return make(key, asksBy()[key] ?? []); }));
        const views = createMemo(() => order().map(viewOf));
        return { order, views, before, dispose };
      });
      for (const step of sim.steps) {
        setStore(produce((draft) => { for (const p of step.patches) setPath(draft as unknown as Record<string, unknown>, p); }));
        const plain = unwrap(store.fleet);
        const fresh = plain.order.map((key) => { const entry = plain.sessions[key]; return entry ? windowView(entry, Object.values(plain.asks).filter((a) => a.key === key), plain.colours, extraOf(entry)) : null; });
        expect(r.views()).toEqual(fresh);
        expect(r.before()).toEqual(fresh);
      }
      // a frame makes its own window's view; the list made all of them
      expect(made).toBeLessThan(madeBefore / 20);
      r.dispose();
    });
  }
});
