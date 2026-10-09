/* the trace recorder: stages a scenario in the v1 world, runs a board
   daemon under the fake board, plays the steps and writes the trace.

     bun board/trace/record.ts <scenario | all> [--daemon <dir>]

   maintainer-only: it builds the private boxbox v1 repo (BOXBOX_V1_REPO) and
   needs a cmx binary. the recorded traces in this repo replay without both.

   --daemon defaults to v1's own board daemon, from the v1 export the world
   builds (board/ at V1_COMMIT), so a recorded trace is v1 end to end. the
   traces land in board/trace/traces/<scenario>.json. everything started is
   stopped before the recorder exits, on success or failure. */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalize } from "./normalize";
import { traceRun } from "./run";
import { SCENARIOS, scenario as byName, type Scenario } from "./scenarios";
import { FORMAT, scrub, writeTrace } from "./trace";
import { prepareV1, startV1World, V1_COMMIT } from "./world-v1";

const HERE = import.meta.dir;
export const TRACES = join(HERE, "traces");

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

export function cmxVersion(): string {
  const out = spawnSync(process.env.CMX_BINARY ?? join(homedir(), ".local/share/cmx/bin/opencode"), ["--version"], { encoding: "utf8" });
  return out.stdout.trim() || "unknown";
}

async function record(target: Scenario, daemonDir: string, daemonName: string) {
  console.log(`recording ${target.name}`);
  const scratch = join(HERE, ".work", `record-${target.name}`);
  const world = await startV1World(`record-${target.name}`);
  try {
    await target.setup(world);
    const run = await traceRun({ scenario: target, world, daemonDir, runDir: scratch });
    const steps = scrub(run, { aliases: world.aliases(), redactions: world.redactions() });
    const path = join(TRACES, `${target.name}.json`);
    writeTrace(path, {
      format: FORMAT,
      scenario: target.name,
      about: target.about,
      recorded: { against: `boxbox v1 ${V1_COMMIT.slice(0, 7)} with cmx ${cmxVersion()}`, daemon: daemonName, at: new Date().toISOString() },
      steps,
    });
    const view = normalize(steps);
    const count = (key: "leds" | "calls" | "board" | "radio") => view.steps.reduce((n, s) => n + s[key].length, 0);
    console.log(
      `wrote ${path}: ${steps.length} steps, ${count("leds")} led lines, ${count("calls")} calls, ${count("board")} board reports, ` +
        `${count("radio")} radio lines, longest gap between host writes ${view.keepaliveGapMs}ms`,
    );
  } finally {
    await world.stop();
  }
}

if (import.meta.main) {
  const which = process.argv[2];
  if (!which) {
    console.error(`usage: bun board/trace/record.ts <${SCENARIOS.map((s) => s.name).join(" | ")} | all> [--daemon <dir>]`);
    process.exit(2);
  }
  const daemonArg = arg("--daemon");
  const daemonDir = daemonArg ? resolve(daemonArg) : join(prepareV1(), "board");
  const daemonName = daemonArg ? `board daemon at ${daemonArg}` : `boxbox v1 ${V1_COMMIT.slice(0, 7)} board/`;
  mkdirSync(TRACES, { recursive: true });
  const targets = which === "all" ? SCENARIOS : [byName(which)];
  for (const target of targets) await record(target, daemonDir, daemonName);
}
