/* a thread's agents and its kin read the fleet by parent (ui/fleet-index.ts) instead of walking every session on every frame:
   driven through a seeded run of the stream (home/fixtures/fleet-sim.ts) with a family three deep under one thread, the
   children's keys and the kin list (who, under whom, in the walk's order, with titles, times and costs) must equal the old
   walk over `Object.values(state.fleet.threads)` after every step, and the kin list keeps its array when nothing in it
   changed. solid's browser build only (`bun test --conditions browser`, the justfile's check). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemo, createRoot, createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import type { Thread } from "../../sync/protocol";
import type { Fleet, Patch } from "../../sync/reducer";
import { simulate } from "../home/fixtures/fleet-sim";
import type { Kin } from "./details-model";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

/* the sync client hands the drive a handle on `window` when it loads, and bun has none: given one only in the browser pass, which
   is the only one that loads them */
if (reactive) (globalThis as { window?: unknown }).window ??= globalThis;
/* loaded by name, so the root typecheck (no dom) does not follow them into the sync client */
type Store = { applyPatches: (patches: readonly Patch[]) => void; state: { fleet: Fleet } };
type Live = { createThreadData: (key: () => string, thinking: () => "open" | "rows") => { kin: () => readonly Kin[]; children: () => ReadonlyMap<string, unknown> } };
const at = (path: string): string => path;
const { applyPatches, state } = reactive ? ((await import(at("../../store"))) as Store) : ({} as Store);
const { createThreadData } = reactive ? ((await import(at("./live"))) as Live) : ({} as Live);


const journal = readFileSync(join(import.meta.dir, "../home/fixtures/journal-p3.ndjson"), "utf8");

/* the walk as it stood (live.ts), with no thread held: the fleet's sessions by parent, breadth first from the thread */
function kinBefore(fleet: Fleet, key: string): Kin[] {
  const host = key.split(":")[0] ?? "";
  const me = key.slice(host.length + 1);
  if (!fleet.threads[key]) return [];
  const under = new Map<string, Set<string>>();
  const add = (parent: string, child: string) => { const set = under.get(parent) ?? new Set<string>(); set.add(child); under.set(parent, set); };
  for (const entry of Object.values(fleet.threads)) { const p = entry.parent; if (entry.agent === host && p) add(p, entry.key.slice(host.length + 1)); }
  const out: Kin[] = [];
  const seen = new Set<string>([me]);
  const queue: Array<[string, string]> = [...(under.get(me) ?? [])].map((id) => [me, id]);
  for (let i = 0; i < queue.length; i++) {
    const [parent, id] = queue[i] as [string, string]; // i < queue.length
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = fleet.threads[`${host}:${id}`];
    out.push({ id, parent, title: entry?.title ?? "", at: entry?.created ?? 0, cost: entry ? (entry.cost ?? null) : null, gone: !entry });
    for (const next of under.get(id) ?? []) queue.push([id, next]);
  }
  return out;
}
const childKeysBefore = (fleet: Fleet, key: string): string[] => {
  const host = key.split(":")[0] ?? "";
  const me = key.slice(host.length + 1);
  return Object.values(fleet.threads).filter((e) => e.agent === host && e.parent === me).map((e) => e.key).sort();
};

describe.skipIf(!reactive)("a thread's agents and kin", () => {
  for (const fine of [false, true]) {
    test(`equal the full walk after every step, and keep their arrays when nothing changed (${fine ? "changed leaves" : "whole entries"})`, () => {
      const sim = simulate(journal, { sessions: 200, steps: 800, seed: fine ? 5 : 3, fine });
      const fleet = structuredClone(sim.start);
      // a family three deep under the first thread, and a same named one on the other host that is not its kin
      const root = Object.values(fleet.threads)[0] as Thread;
      const kid = (id: string, parent: string, host = root.agent): Thread => ({ ...structuredClone(root), key: `${host}:${id}`, agent: host, id, title: id, parent });
      for (const s of [kid("ses_c1", root.id), kid("ses_c2", root.id), kid("ses_g1", "ses_c1"), kid("ses_g2", "ses_c1"), kid("ses_gg", "ses_g2"), kid("ses_x", root.id, root.agent === "bench" ? "desk" : "bench")]) fleet.threads[s.key] = s;
      applyPatches([{ path: ["fleet"], value: fleet } as Patch]);
      const r = createRoot((dispose) => ({ data: createThreadData(() => root.key, () => "rows"), dispose }));
      let same = 0;
      let last = r.data.kin();
      sim.steps.forEach((step, n) => {
        const patches = [...step.patches];
        // the family moves too: a grandchild's cost, a new great grandchild now and then
        if (n % 7 === 0) patches.push({ path: ["fleet", "threads", `${root.agent}:ses_g1`, "cost"], value: n / 10 } as Patch);
        if (n % 97 === 0) { const s = kid(`ses_n${n}`, n % 2 ? "ses_gg" : root.id); patches.push({ path: ["fleet", "threads", s.key], value: s } as Patch); }
        applyPatches(patches);
        const plain = unwrap(state.fleet);
        const kin = r.data.kin();
        expect(kin).toEqual(kinBefore(plain, root.key));
        expect([...r.data.children().keys()].map((id) => `${root.agent}:${id}`).sort()).toEqual(childKeysBefore(plain, root.key));
        if (kin === last) same++;
        last = kin;
      });
      expect(last.length).toBeGreaterThan(5);
      // most frames touch nobody in the family: the list is the same array, so what reads it does not run
      expect(same).toBeGreaterThan(sim.steps.length / 2);
      r.dispose();
    });
  }
});
