/* the wire on protocol 3, replayed (fixtures/wire-replay.ts; docs/protocol.md, section 16): the recorded journal tape and
   the cases it lacks, published by a simulated server (fixtures/server.ts) and read through the reducer, the page gate,
   the landing and the store as the app does, on seeded schedules of switches, hidden spells, lost connections, injected
   protocol errors, a lost delta and late or early reads. each run holds that the ui's store equals the worker at every
   apply, that every thread in interest whose read or catch-up has landed equals the server's read at the client's
   journal position (nothing doubled, nothing missing), that the only faults are the injected ones and the rules'
   (a lost delta's hash miss, a late read refused), and that the run ends with the server's fleet and threads. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type Hasher, journal, type Options, replayWire, scenario } from "./fixtures/wire-replay";

const tape = gunzipSync(readFileSync(join(import.meta.dir, "../../../server/goldens/protocol3/journal.sse.gz"))).toString("utf8");
const steps = scenario(journal(tape), 24_000);
const sha = (): Hasher => {
  const hash = createHash("sha256");
  return { update: (text) => void hash.update(text), digest: () => hash.digest("hex") };
};

const RUNS: { name: string; seed: number; options: Options }[] = [
  { name: "seed 1", seed: 1, options: {} },
  { name: "seed 2, a read still out when its thread leaves and comes back", seed: 2, options: { slow: 2000 } },
  { name: "seed 3, a ring of 150 seqs (stale keys read again)", seed: 3, options: { ring: 150 } },
  { name: "seed 4, raw catch-ups", seed: 4, options: { compaction: "raw" } },
  { name: "seed 5, a late read, raw catch-ups", seed: 5, options: { slow: 2000, compaction: "raw" } },
  { name: "seed 7, a short ring and a source never ahead", seed: 7, options: { ring: 150, ahead: false } },
  { name: "seed 6, reads from a source never ahead", seed: 6, options: { ahead: false } },
];

describe("the wire on protocol 3, replayed", () => {
  for (const { name, seed, options } of RUNS) {
    test(`exactly once, and the server's state at the end (${name})`, () => {
      const run = replayWire(steps, sha, seed, options);
      expect(run.mismatch).toBeNull();
      expect(run.exact).toBeNull();
      expect(run.endsEqual).toBe(true);
      expect(run.behind).toBeNull();
      // the faults are the injected ones and the rules' own, every injected one recovered by a reset
      expect(run.faults["patch-error"]).toBe(run.seen.injected);
      expect(run.seen.recovered).toBe(run.seen.injected);
      expect(run.faults["catchup-error"]).toBe(0);
      expect(run.faults["hash-miss"]).toBe(run.seen.lost);
      expect(run.faults["read-late"]).toBe(options.slow === undefined ? 0 : 1);
      // the end
      expect(run.fleet.client).toEqual(run.fleet.server);
      expect(Object.keys(run.threads).length).toBeGreaterThan(0);
      for (const { client, server } of Object.values(run.threads)) expect(client).toEqual(server);
      // what the run went through
      expect(run.seen.switches).toBe(10);
      expect(run.seen.injected).toBeGreaterThanOrEqual(1);
      expect(run.seen.lost).toBe(1);
      expect(run.seen.drops).toBeGreaterThanOrEqual(4);
      expect(run.seen.caughts).toBeGreaterThanOrEqual(3);
      expect(run.seen.hidden).toBe(2);
      expect(run.seen.sinceKeys).toBeGreaterThan(0);
      expect(run.seen.readKeys).toBeGreaterThan(0);
      expect(run.seen.checks).toBeGreaterThan(2000);
      expect(run.seen.skipped).toBeGreaterThan(500);
      if (options.ring !== undefined) expect(run.seen.stale).toBeGreaterThan(0);
      else expect(run.seen.catchups).toBeGreaterThan(0);
      expect(run.applies).toBeGreaterThan(300);
    }, 30_000);
  }

  test("a seed is one schedule: two runs see the same apply points and end in the same state", () => {
    const a = replayWire(steps, sha, 1);
    const b = replayWire(steps, sha, 1);
    expect(a.uiDigest).toBe(b.uiDigest);
    expect(a.workerDigest).toBe(b.workerDigest);
    expect(a.seen).toEqual(b.seen);
  }, 30_000);
});

/* a hidden page does no page work: the worker holds what it would post (gate.ts) and the ui lands it in one go when the page
   is shown (landing.ts). the connection drops and comes back during the hidden spell past 30 s, so the stream goes live
   and its catch-up follows, held; the ui's caught-up second (ui/caught-up.ts) is timed on the run's clock, and each time
   it runs out the store must hold everything the worker had made by then. the queue that was reverted for racing it fails
   the same check */
describe("a hidden page and the caught-up second", () => {
  test("held by the worker and landed in one go: never behind when the stream has caught up", () => {
    const run = replayWire(steps, sha, 3, { mode: "gate" });
    expect(run.caughtUps).toBeGreaterThanOrEqual(2);
    expect(run.behind).toBeNull();
    expect(run.mismatch).toBeNull();
    expect(run.endsEqual).toBe(true);
  }, 30_000);

  test("the hidden queue that was reverted is caught: the ui says caught up with the catch-up still waiting", () => {
    const run = replayWire(steps, sha, 3, { mode: "naive" });
    expect(run.behind).not.toBeNull();
    expect(run.endsEqual).toBe(true);
  }, 30_000);

  test("held and posted one message at a time holds too: the status comes after the patches, which land before it", () => {
    const run = replayWire(steps, sha, 3, { mode: "separate" });
    expect(run.caughtUps).toBeGreaterThanOrEqual(2);
    expect(run.behind).toBeNull();
    expect(run.mismatch).toBeNull();
    expect(run.endsEqual).toBe(true);
  }, 30_000);
});
