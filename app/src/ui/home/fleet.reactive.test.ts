/* home's fleet-wide readings against the computations they replaced (docs/home.md, verification): the window list and its
   order, the host count and the parent index are driven through a long seeded run of the stream
   (fixtures/fleet-sim.ts), with whole-entry frames and with changed-leaf frames, and after every step each must equal what
   the old full walk over `Object.values(state.fleet.sessions)` says, while re-running far less. solid's browser build only
   (`bun test --conditions browser`, the justfile's check); the plain pass skips them. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemo, createRoot, createSignal, onCleanup } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import type { Fleet } from "../../sync/reducer";
import { keyed, parentIndex, sessionKeys } from "../fleet-index";
import { createWindowKeys, RECENT_MS } from "./membership";
import { setPath, simulate } from "./fixtures/fleet-sim";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

const journal = readFileSync(join(import.meta.dir, "fixtures", "journal.ndjson"), "utf8");

/* the computations as they stood before (home.tsx, membership.ts, live.ts), kept here word for word as the reference */
function windowKeysBefore(fleet: Fleet, now: number): string[] {
  const asking = new Set(Object.values(fleet.asks).map((ask) => ask.key));
  const keys: string[] = [];
  for (const key of fleet.order) {
    const entry = fleet.sessions[key];
    if (!entry || entry.info.parentID) continue;
    if (entry.cleared != null) continue;
    const active = entry.status !== null || asking.has(key);
    if (active || now - entry.info.time.updated < RECENT_MS) keys.push(key);
  }
  return keys;
}
const hostsBefore = (fleet: Fleet): number => new Set(Object.values(fleet.sessions).map((s) => s.host)).size;
const childrenBefore = (fleet: Fleet, host: string, me: string): string[] => Object.values(fleet.sessions).filter((e) => e.host === host && e.info.parentID === me).map((e) => e.key);

function run(fine: boolean) {
  const sim = simulate(journal, { sessions: 300, steps: 1500, seed: fine ? 11 : 7, fine });
  const [store, setStore] = createStore<{ fleet: Fleet }>({ fleet: structuredClone(sim.start) });
  const [now, setNow] = createSignal(sim.now);
  const apply = (patches: (typeof sim.steps)[number]["patches"]) => setStore(produce((draft) => { for (const p of patches) setPath(draft as unknown as Record<string, unknown>, p); }));
  const counts = { keys: 0, keysBefore: 0 };
  return createRoot((dispose) => {
    const fleet = () => store.fleet;
    const membership = createWindowKeys(fleet, now);
    const before = createMemo(() => { counts.keysBefore++; return windowKeysBefore(store.fleet, now()); });
    const keys = createMemo(() => { counts.keys++; return membership.keys(); });
    const names = sessionKeys(fleet);
    const hostsOf = keyed(names, (key) => store.fleet.sessions[key]?.host);
    const hosts = createMemo(() => new Set(hostsOf().filter((h) => h !== undefined)).size);
    const parents = parentIndex(fleet, names);
    return { sim, store, apply, setNow, now, keys, before, hosts, parents, membership, counts, dispose };
  });
}

describe.skipIf(!reactive)("home's fleet readings", () => {
  for (const fine of [false, true]) {
    test(`the windows, their order, the host count and the parent index equal the full walk after every step (${fine ? "changed leaves" : "whole entries"})`, () => {
      const r = run(fine);
      let crossings = 0;
      let last = r.keys();
      for (const step of r.sim.steps) {
        if (step.now !== undefined) r.setNow(step.now);
        r.apply(step.patches);
        const plain = unwrap(r.store.fleet);
        const keys = r.keys();
        expect(keys).toEqual(windowKeysBefore(plain, r.now()));
        expect(r.hosts()).toBe(hostsBefore(plain));
        if (step.now !== undefined && keys.length !== last.length) crossings++;
        last = keys;
        for (const entry of Object.values(plain.sessions).slice(0, 40)) {
          expect([...(r.parents().get(`${entry.host}\0${entry.id}`) ?? [])]).toEqual(childrenBefore(plain, entry.host, entry.id));
        }
        const all = [...r.parents().values()].reduce((n, list) => n + list.length, 0);
        expect(all).toBe(Object.values(plain.sessions).filter((e) => e.info.parentID).length);
      }
      // the run does exercise the 12 hour rule: windows left by the clock alone
      expect(crossings).toBeGreaterThan(0);
      // the list is worked out again only when it could have changed, never on every frame and every second as the walk was
      expect(r.counts.keys).toBeLessThan(r.counts.keysBefore / 3);
      r.dispose();
    });
  }

  test("the clock wakes the window list only when a thread's 12 hours run out, and `wake` names that moment", () => {
    const r = run(false);
    const start = r.counts.keys;
    const due = r.membership.wake();
    expect(due).toBeDefined();
    if (due === undefined) return;
    const quiet = Math.min(120, Math.floor((due - r.sim.now - 1) / 1000));
    for (let i = 1; i <= quiet; i++) r.setNow(r.sim.now + i * 1000);
    r.keys();
    // seconds in which no thread's 12 hours ran out: the list was not worked out again
    expect(r.counts.keys - start).toBe(0);
    {
      const left = windowKeysBefore(unwrap(r.store.fleet), due - 1).length;
      r.setNow(due - 1);
      expect(r.keys().length).toBe(left);
      r.setNow(due);
      expect(r.keys().length).toBeLessThan(left);
      expect(r.keys()).toEqual(windowKeysBefore(unwrap(r.store.fleet), due));
    }
    r.dispose();
  });

  test("a session removed and added again, in one batch or two, and thousands coming and going: the readings stay equal, and every memo of a session that left is gone", () => {
    const sim = simulate(journal, { sessions: 50, steps: 0 });
    const [store, setStore] = createStore<{ fleet: Fleet }>({ fleet: structuredClone(sim.start) });
    const live = new Map<string, number>();
    const r = createRoot((dispose) => {
      const fleet = () => store.fleet;
      const names = sessionKeys(fleet);
      const hosts = keyed(names, (key) => {
        live.set(key, (live.get(key) ?? 0) + 1);
        onCleanup(() => { const n = (live.get(key) ?? 1) - 1; if (n) live.set(key, n); else live.delete(key); });
        return store.fleet.sessions[key]?.host;
      });
      const parents = parentIndex(fleet, names);
      const membership = createWindowKeys(fleet, () => sim.now);
      return { names, hosts, parents, membership, dispose };
    });
    const check = () => {
      const plain = unwrap(store.fleet);
      expect([...r.names()]).toEqual(Object.keys(plain.sessions));
      expect(r.hosts()).toEqual(Object.values(plain.sessions).map((s) => s.host));
      expect(r.membership.keys()).toEqual(windowKeysBefore(plain, sim.now));
      for (const entry of Object.values(plain.sessions)) expect([...(r.parents().get(`${entry.host}\0${entry.id}`) ?? [])]).toEqual(childrenBefore(plain, entry.host, entry.id));
    };
    check();
    const baseline = live.size;
    const first = Object.keys(sim.start.sessions)[0] as string;
    const entry = structuredClone(sim.start.sessions[first]);
    // removed, then added again in a later batch: it comes back at the end of the keys, as Object.values has it
    setStore(produce((d) => { delete d.fleet.sessions[first]; }));
    check();
    setStore(produce((d) => { d.fleet.sessions[first] = structuredClone(entry) as typeof d.fleet.sessions[string]; }));
    check();
    // removed and added again in one batch
    setStore(produce((d) => { delete d.fleet.sessions[first]; d.fleet.sessions[first] = structuredClone(entry) as typeof d.fleet.sessions[string]; }));
    check();
    expect(live.size).toBe(baseline);
    // five thousand sessions come, some under a parent, and go again
    const template = structuredClone(entry) as NonNullable<typeof entry>;
    for (let round = 0; round < 10; round++) {
      setStore(produce((d) => {
        for (let i = 0; i < 500; i++) {
          const id = `ses_churn${round}_${i}`;
          const key = `${template.host}:${id}`;
          d.fleet.sessions[key] = { ...structuredClone(template), key, id, info: { ...structuredClone(template.info), id, parentID: i % 3 === 0 ? template.id : undefined } } as typeof d.fleet.sessions[string];
          d.fleet.order.push(key);
        }
      }));
      check();
      expect(live.size).toBe(baseline + 500);
      setStore(produce((d) => {
        for (let i = 0; i < 500; i++) delete d.fleet.sessions[`${template.host}:ses_churn${round}_${i}`];
        d.fleet.order = d.fleet.order.filter((k) => !k.includes("ses_churn"));
      }));
      check();
      expect(live.size).toBe(baseline);
    }
    r.dispose();
    expect(live.size).toBe(0);
  });
});
