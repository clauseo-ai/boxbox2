/* the wire between the worker and the ui keeps the ui's store equal to the worker's state (fixtures/wire-replay.ts): the
   recorded journal, the cases it lacks and a long streamed answer, posted, copied, queued and applied as the app does,
   compared after every apply. the digests were taken from the build before patches were made smaller (session ticks
   diffed to their leaves, streamed text sent as appends), main at f8f04d1 with this harness and that build's own queue
   (a coalesce per post): the ui's store at every apply point, and the worker's final state, are what they were */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hasher, journal, replayWire, scenario } from "./fixtures/wire-replay";

const recorded = journal(readFileSync(join(import.meta.dir, "../ui/home/fixtures/journal.ndjson"), "utf8"));
const steps = scenario(recorded, 24_000);
const sha = (): Hasher => {
  const hash = createHash("sha256");
  return { update: (text) => void hash.update(text), digest: () => hash.digest("hex") };
};
/** a delta in the middle of the long answer is lost once, so the worker reconnects and the server replays from it */
const gap = steps.findIndex((s, i) => i > recorded.length + 60 && s.frame.type === "delta");
/** the page is hidden from the journal's end, through the cases after it, into the long answer */
const hidden: [number, number] = [recorded.length - 20, recorded.length + 200];

const RUNS = [
  { name: "visible, batches 1", seed: 1, options: { gap } },
  { name: "visible, batches 2", seed: 2, options: { gap } },
  { name: "hidden for a while, batches 3", seed: 3, options: { gap, hidden } },
] as const;

const BEFORE: Record<string, { ui: string; worker: string }> = {
  "visible, batches 1": { ui: "0605409b319e40b80becb4ef9f5ef4d444154065e54badfc3c4f8484e39f996c", worker: "a27a90825b67d308f8336378e44529fd9d1656fedab15f2b93c737585018fe99" },
  "visible, batches 2": { ui: "ae7c7de5639c36984bc7f2decb3bbfa87d6ff119c01317051029fe8ba88b8274", worker: "9fa8874e56eb5dd0cc2cdf2c978abebc0f65e00de43ab5dfea76e5179ebc9dc9" },
  "hidden for a while, batches 3": { ui: "f22d71a4153d1e0825fc815f30de4d983b1e155b469a0031c652ec8ee4cad63a", worker: "33bf035775cf9d16bdec503a161dad4f47f4490fb2b6cb8341b7a2b3ad61638c" },
};

describe("the wire, replayed", () => {
  for (const { name, seed, options } of RUNS) {
    test(`the ui equals the worker at every apply, and holds what it held before (${name})`, () => {
      const run = replayWire(steps, sha, seed, options);
      expect(run.mismatch).toBeNull();
      expect(run.applies).toBeGreaterThan(200);
      // the run went through what it is for
      expect(run.seen.gaps).toBe(1);
      expect(run.seen.answered).toBeGreaterThan(0);
      expect(run.seen.removed).toBe(2);
      expect(run.seen.hydrations).toBeGreaterThan(5);
      expect(run.uiDigest).toBe(BEFORE[name]?.ui ?? "");
      expect(run.workerDigest).toBe(BEFORE[name]?.worker ?? "");
    });
  }
});
