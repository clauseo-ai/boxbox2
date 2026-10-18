/* the replay checker: feeds a trace's key presses to a board daemon under
   the fake board, in a freshly staged world, and diffs the led frames, the
   board reports, the calls and the radio against the trace.

     bun board/trace/replay.ts <trace.json | all> --daemon target/release/boxbox-board --world v2
     bun board/trace/replay.ts <trace.json | all> [--daemon <v1 daemon dir>]
     bun board/trace/replay.ts <trace.json | all> ... --rediff   # the last run diffed again, starts nothing
     bun board/trace/replay.ts <trace.json> --show

   --world v2 (the m6 gate) stages boxbox v2 from this checkout in front of
   the pinned cmx2 (world-v2.ts), and --daemon names the native binary. the
   trace is read across versions: v1 calls v2 has no counterpart for are
   dropped on both sides (normalize.ts, V1_ONLY), and decision 79's
   deliberate changes (deltas.ts) are forgiven and printed on their own,
   "accounted for by decision 79", and the other deliberate changes (the
   server's seat order, decision 80; the daemon's silence until plugged
   in, decision 81; v1's telemetry fixed) under "accounted for by decisions
   80 and 81, and telemetry fixes". anything else that differs fails.

   --world v1 (the default) stages boxbox v1 (world-v1.ts), and --daemon
   defaults to v1's own daemon from the v1 export: the check that the
   harness itself is deterministic, whose diff must be empty with nothing
   forgiven. it needs the private v1 repo.

   prints the diff per step and channel, `-` the trace and `+` the replay,
   and exits 1 when it is not empty. --show prints a trace's normalized
   view instead and starts nothing. */

import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { isNative } from "./daemon";
import { KEY_CHANGES, type KeyChange, V2_DELTAS } from "./deltas";
import { diffViewsWith, headingOf, printAccounted, printHunks } from "./diff";
import { CHANNELS, normalize, V1, V1_CROSS, V1_ONLY, V2_CROSS, type View } from "./normalize";
import { TRACES } from "./record";
import { traceRun, type TracedStep } from "./run";
import { keyEvents, type Scenario, scenario as byName } from "./scenarios";
import { readTrace, scrub, type Trace, writeTrace } from "./trace";
import type { World } from "./world";
import { prepareV1, startV1World } from "./world-v1";
import { startV2World } from "./world-v2";

const HERE = import.meta.dir;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

export function printView(view: View): string {
  const out: string[] = [];
  for (const [index, step] of view.steps.entries()) {
    out.push(`step ${index} · ${step.label}`);
    for (const channel of CHANNELS) {
      for (const [i, line] of step[channel].entries()) {
        const optional = channel === "leds" && step.ledsOptional[i] === true;
        out.push(`  ${channel.padEnd(5)} ${line}${optional ? "   (optional: a seat memo re-show)" : ""}`);
      }
    }
  }
  out.push(`longest gap between host writes: ${view.keepaliveGapMs}ms`);
  return out.join("\n");
}

export type WorldName = "v1" | "v2";

/** --rediff: diff the last replay's own run again (.work/replay-<scenario>/replay.json) without starting anything,
    for reading a change to the normalizer or the deltas against the run it was made for */
const rediff = process.argv.includes("--rediff");

/** stages the world, runs the daemon under the fake board, and returns the run scrubbed */
async function runIt(trace: Trace, target: Scenario, daemon: string, worldName: WorldName, scratch: string, changed: Map<string, KeyChange>): Promise<TracedStep[]> {
  const world: World = worldName === "v2" ? await startV2World(`replay-${trace.scenario}`) : await startV1World(`replay-${trace.scenario}`);
  try {
    await target.setup(world);
    const run = await traceRun({
      scenario: target,
      world,
      daemon,
      runDir: scratch,
      keysFor: (index) => {
        const change = changed.get(target.steps[index - 1]?.label ?? "");
        return change ? keyEvents(change.gesture) : trace.steps[index]?.keys;
      },
    });
    const steps = scrub(run, { aliases: world.aliases(), redactions: world.redactions() });
    /* the replay's own run, in trace form, for reading a diff against */
    writeTrace(join(scratch, "replay.json"), { ...trace, recorded: { ...trace.recorded, daemon, at: new Date().toISOString() }, steps });
    return steps;
  } finally {
    await world.stop();
  }
}

async function replay(path: string, daemon: string, worldName: WorldName): Promise<boolean> {
  const trace = readTrace(path);
  const target = byName(trace.scenario);
  const labels = target.steps.map((s) => s.label);
  const recorded = trace.steps.slice(1).map((s) => s.label);
  if (labels.join("\n") !== recorded.join("\n")) {
    throw new Error(`${path} was recorded from a different ${trace.scenario} script; record it again`);
  }
  console.log(`replaying ${trace.scenario} (recorded ${trace.recorded.at} against ${trace.recorded.against})`);
  console.log(`  daemon under test: ${daemon}, world ${worldName}`);
  const v2 = worldName === "v2";
  /* decision 79 moved a verb off a key: those steps press what v2 binds it to */
  const changed = new Map(v2 ? KEY_CHANGES.filter((k) => k.scenario === trace.scenario).map((k) => [k.step, k]) : []);
  for (const k of changed.values()) console.log(`  step "${k.step}" presses ${k.gesture.kind} ${"key" in k.gesture ? k.gesture.key : ""}: ${k.source}, ${k.why}`);
  const scratch = join(HERE, ".work", `replay-${trace.scenario}`);
  const steps = rediff ? readTrace(join(scratch, "replay.json")).steps : await runIt(trace, target, daemon, worldName, scratch, changed);
  const expected = normalize(trace.steps, v2 ? V1_CROSS : V1);
  const actual = normalize(steps, v2 ? V2_CROSS : V1);
  const { hunks, accounted } = diffViewsWith(expected, actual, v2 ? { scenario: trace.scenario, deltas: V2_DELTAS } : {});
  const lines = (view: View) => view.steps.reduce((n, s) => n + CHANNELS.reduce((m, c) => m + s[c].length, 0), 0);
  console.log(
    `${trace.scenario}: ${expected.steps.length} steps, ${lines(expected)} lines in the trace, ${lines(actual)} in the replay; ` +
      `longest gap between host writes ${actual.keepaliveGapMs}ms`,
  );
  if (v2) console.log(`${trace.scenario}: not compared, v1 only: ${V1_ONLY.map((d) => d.verb).join(", ")}`);
  for (const heading of [...new Set(accounted.map((a) => headingOf(a.source)))].sort()) {
    const these = accounted.filter((a) => headingOf(a.source) === heading);
    console.log(`${trace.scenario}: ${these.length} lines ${heading}\n${printAccounted(these)}`);
  }
  if (hunks.length === 0) {
    console.log(`${trace.scenario}: diff empty (leds, board, calls, radio)`);
    return true;
  }
  console.log(`${trace.scenario}: ${hunks.length} differing step channels\n${printHunks(hunks)}`);
  return false;
}

if (import.meta.main) {
  const which = process.argv[2];
  if (!which) {
    console.error("usage: bun board/trace/replay.ts <trace.json | all> [--daemon <binary | v1 dir>] [--world v1 | v2] [--show]");
    process.exit(2);
  }
  const paths =
    which === "all"
      ? readdirSync(TRACES)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => join(TRACES, f))
      : [resolve(which)];
  if (process.argv.includes("--show")) {
    for (const path of paths) console.log(printView(normalize(readTrace(path).steps)));
    process.exit(0);
  }
  const worldArg = arg("--world") ?? "v1";
  if (worldArg !== "v1" && worldArg !== "v2") {
    console.error(`--world is v1 or v2, not ${worldArg}`);
    process.exit(2);
  }
  const daemonArg = arg("--daemon");
  if (worldArg === "v2" && (!daemonArg || !isNative(resolve(daemonArg)))) {
    console.error("--world v2 replays the native daemon: --daemon <path to the boxbox-board binary>, e.g. target/release/boxbox-board");
    process.exit(2);
  }
  const daemon = daemonArg ? resolve(daemonArg) : join(prepareV1(), "board");
  let clean = true;
  for (const path of paths) clean = (await replay(path, daemon, worldArg)) && clean;
  process.exit(clean ? 0 : 1);
}
