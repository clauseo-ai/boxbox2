/* the replay checker: feeds a trace's key presses to a board daemon under
   the fake board, in a freshly staged world, and diffs the led frames, the
   board reports, the calls and the radio against the trace.

     bun board/trace/replay.ts <trace.json | all> [--daemon <dir>]
     bun board/trace/replay.ts <trace.json> --show

   --daemon defaults to v1's own board daemon (the v1 export), which is the
   check that the harness itself is deterministic: the diff against v1 must
   be empty. m6 points --daemon at board/daemon with the ported client.ts
   and runs it against a v2 world (docs/board-verification.md).

   prints the diff per step and channel, `-` the trace and `+` the replay,
   and exits 1 when it is not empty. --show prints a trace's normalized
   view instead and starts nothing. */

import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { diffViews, printHunks } from "./diff";
import { CHANNELS, normalize, type View } from "./normalize";
import { TRACES } from "./record";
import { traceRun } from "./run";
import { scenario as byName } from "./scenarios";
import { readTrace, scrub, writeTrace } from "./trace";
import { prepareV1, startV1World } from "./world-v1";

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

async function replay(path: string, daemonDir: string): Promise<boolean> {
  const trace = readTrace(path);
  const target = byName(trace.scenario);
  const labels = target.steps.map((s) => s.label);
  const recorded = trace.steps.slice(1).map((s) => s.label);
  if (labels.join("\n") !== recorded.join("\n")) {
    throw new Error(`${path} was recorded from a different ${trace.scenario} script; record it again`);
  }
  console.log(`replaying ${trace.scenario} (recorded ${trace.recorded.at} against ${trace.recorded.against})`);
  console.log(`  daemon under test: ${daemonDir}`);
  const scratch = join(HERE, ".work", `replay-${trace.scenario}`);
  const world = await startV1World(`replay-${trace.scenario}`);
  let steps;
  try {
    await target.setup(world);
    const run = await traceRun({
      scenario: target,
      world,
      daemonDir,
      runDir: scratch,
      keysFor: (index) => trace.steps[index]?.keys,
    });
    steps = scrub(run, { aliases: world.aliases(), redactions: world.redactions() });
    /* the replay's own run, in trace form, for reading a diff against */
    writeTrace(join(scratch, "replay.json"), { ...trace, recorded: { ...trace.recorded, daemon: daemonDir, at: new Date().toISOString() }, steps });
  } finally {
    await world.stop();
  }
  const expected = normalize(trace.steps);
  const actual = normalize(steps);
  const hunks = diffViews(expected, actual);
  const lines = (view: View) => view.steps.reduce((n, s) => n + CHANNELS.reduce((m, c) => m + s[c].length, 0), 0);
  console.log(
    `${trace.scenario}: ${expected.steps.length} steps, ${lines(expected)} lines in the trace, ${lines(actual)} in the replay; ` +
      `longest gap between host writes ${actual.keepaliveGapMs}ms`,
  );
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
    console.error("usage: bun board/trace/replay.ts <trace.json | all> [--daemon <dir>] [--show]");
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
  const daemonArg = arg("--daemon");
  const daemonDir = daemonArg ? resolve(daemonArg) : join(prepareV1(), "board");
  let clean = true;
  for (const path of paths) clean = (await replay(path, daemonDir)) && clean;
  process.exit(clean ? 0 : 1);
}
