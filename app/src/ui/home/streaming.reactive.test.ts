/* home's streaming label (streaming.ts) against the effect it replaced, as that effect behaved on whole-entry frames: long
   tasks are filed as streaming after every batch that writes any session while one of them works, and never while none
   does. driven through the real store (store.ts, applyPatches and its beat) with a seeded run of the stream in both frame
   shapes (fixtures/fleet-sim.ts), then with the writes a changed-field stream adds: a tail item alone, a status of a thread
   at rest, a session coming and going, an ask (which the old effect never read). solid's browser build only (`bun test
   --conditions browser`, the justfile's check). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemo, createRoot, createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import type { SessionEntry } from "../../sync/protocol";
import type { Fleet, Patch } from "../../sync/reducer";
import { sessionKeys } from "../fleet-index";
import { simulate } from "./fixtures/fleet-sim";
import { watchStreaming } from "./streaming";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

/* the store is loaded by name, so the root typecheck (no dom) does not follow it into the sync client, which also wants a
   `window` to hand the drive its handle on: given one only in the browser pass, the only one that loads it */
if (reactive) (globalThis as { window?: unknown }).window ??= globalThis;
type Store = { applyPatches: (patches: readonly Patch[]) => void; state: { fleet: Fleet }; sessionsBeat: () => number };
const at = (path: string): string => path;
const store = reactive ? ((await import(at("../../store"))) as Store) : ({} as Store);

const journal = readFileSync(join(import.meta.dir, "fixtures", "journal.ndjson"), "utf8");

function watch() {
  let marks = 0;
  const dispose = createRoot((d) => {
    watchStreaming(() => store.state.fleet, store.sessionsBeat, sessionKeys(() => store.state.fleet), () => marks++);
    return d;
  });
  return { marks: () => marks, dispose };
}
const anyWorking = () => Object.values(unwrap(store.state.fleet).sessions).some((s) => s.status?.type === "busy");
const writesSessions = (patches: readonly Patch[]) => patches.some((p) => p.path[0] === "fleet" && (p.path[1] === undefined || p.path[1] === "sessions"));

describe.skipIf(!reactive)("home's streaming label", () => {
  for (const fine of [false, true]) {
    test(`marks once for every batch that writes a session while one works, and never while none does (${fine ? "changed leaves" : "whole entries"})`, () => {
      const sim = simulate(journal, { sessions: 200, steps: 1200, seed: fine ? 9 : 4, fine });
      store.applyPatches([{ path: ["fleet"], value: structuredClone(sim.start) } as Patch]);
      const w = watch();
      let marked = 0;
      for (const step of sim.steps) {
        if (step.patches.length === 0) continue;
        const was = w.marks();
        store.applyPatches(step.patches);
        const expected = writesSessions(step.patches) && anyWorking() ? 1 : 0;
        expect(w.marks() - was).toBe(expected);
        marked += expected;
      }
      expect(marked).toBeGreaterThan(100);
      w.dispose();
    });
  }

  test("a tail item alone, a status of a thread at rest, a session coming and going each mark while one works; an ask does not, and nothing marks once none works", () => {
    const sim = simulate(journal, { sessions: 20, steps: 0 });
    const fleet = structuredClone(sim.start);
    const keys = Object.keys(fleet.sessions);
    const busy = keys[0] as string;
    const rest = keys[1] as string;
    for (const key of keys) (fleet.sessions[key] as SessionEntry).status = key === busy ? { type: "busy", queued: 0, since: sim.now } : null;
    store.applyPatches([{ path: ["fleet"], value: fleet } as Patch]);
    const w = watch();
    const marksFor = (patches: Patch[]) => { const was = w.marks(); store.applyPatches(patches); return w.marks() - was; };
    expect(marksFor([{ path: ["fleet", "sessions", busy, "tail", 0], value: { ...(fleet.sessions[busy] as SessionEntry).tail[0], text: "more" } } as Patch])).toBe(1);
    expect(marksFor([{ path: ["fleet", "sessions", rest, "status"], value: { type: "idle", since: sim.now } } as Patch])).toBe(1);
    const born = { ...structuredClone(fleet.sessions[rest] as SessionEntry), key: "bench:ses_born", id: "ses_born" };
    expect(marksFor([{ path: ["fleet", "sessions", born.key], value: born } as Patch])).toBe(1);
    expect(marksFor([{ path: ["fleet", "sessions", born.key], value: undefined } as Patch])).toBe(1);
    expect(marksFor([{ path: ["fleet", "asks", "bench:que_x"], value: { key: rest, host: "bench", id: "que_x", kind: "question", request: {} } } as Patch])).toBe(0);
    // the thread that worked stops: nothing works, and nothing marks
    expect(marksFor([{ path: ["fleet", "sessions", busy, "status"], value: null } as Patch])).toBe(0);
    expect(marksFor([{ path: ["fleet", "sessions", rest, "tail", 0], value: { ...(fleet.sessions[rest] as SessionEntry).tail[0], text: "quiet" } } as Patch])).toBe(0);
    w.dispose();
  });
});
