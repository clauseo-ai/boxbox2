/* `just probes <port> [aN ...]`: the contract probes for cmx2's asks
   (docs/verification.md, the opening step of m2, m3 and m4).

   starts the daemon from cmx2.pin on <port> with the bench model on the
   next port (probes/bench.ts), runs one probe per ask in order, prints each
   assertion as it passes, then the per-ask table, and stops everything it
   started. an ask counts as landed when cmx2's ASKS.md at the pinned commit
   says so (probes/wire.ts, landedAsks); a failure on an ask not yet landed
   is an expected fail.

   exit 0 when every landed ask passes and no probe errored; 1 otherwise. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PIN, SOURCE } from "../scripts/pinned";
import { a1 } from "./a1";
import { a2 } from "./a2";
import { a3 } from "./a3";
import { a4 } from "./a4";
import { a5 } from "./a5";
import { a6 } from "./a6";
import { a7 } from "./a7";
import { a8 } from "./a8";
import { a9 } from "./a9";
import { a10 } from "./a10";
import { a11 } from "./a11";
import { a23 } from "./a23";
import { a26 } from "./a26";
import { BASE, Bench } from "./bench";
import { Context, Failure, type Probe } from "./probe";
import { landedAsks } from "./wire";

const PROBES: Probe[] = [a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a23, a26];
const PROBE_TIMEOUT_MS = 180_000;

type Outcome = "pass" | "expected fail" | "fail" | "error";

interface Result {
  ask: string;
  landed: boolean;
  outcome: Outcome;
  passed: number;
  seconds: number;
  assertion?: string;
  detail?: string;
}

function usage(message: string): never {
  console.error(`probes: ${message}\nusage: just probes <port 4840-4848> [a1 a2 ...]`);
  process.exit(2);
}

function withTimeout(run: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Failure("setup", `the probe finishes within ${PROBE_TIMEOUT_MS / 1000} s`, "it did not")), PROBE_TIMEOUT_MS);
  });
  return Promise.race([run, limit]).finally(() => clearTimeout(timer));
}

async function runProbe(bench: Bench, probe: Probe, landed: boolean): Promise<Result> {
  console.log(`\n${probe.ask} ${probe.title}`);
  const ctx = new Context(bench, probe.ask, (line) => console.log(line));
  const started = performance.now();
  const result = (outcome: Outcome, assertion?: string, detail?: string): Result => ({
    ask: probe.ask,
    landed,
    outcome,
    passed: ctx.passed.length,
    seconds: (performance.now() - started) / 1000,
    ...(assertion === undefined ? {} : { assertion }),
    ...(detail === undefined ? {} : { detail }),
  });
  try {
    await withTimeout(probe.run(ctx));
    return result("pass");
  } catch (e) {
    if (e instanceof Failure) {
      console.log(`  ${e.kind === "setup" ? "error" : "fail "} ${e.assertion}\n        ${e.detail}`);
      if (e.kind === "setup") return result("error", e.assertion, e.detail);
      return result(landed ? "fail" : "expected fail", e.assertion, e.detail);
    }
    const message = e instanceof Error ? e.message : String(e);
    console.log(`  error ${message}`);
    return result("error", "the probe runs without throwing", message);
  } finally {
    ctx.close();
  }
}

function table(results: Result[]) {
  console.log("\nask  landed  result         ok  secs  first failing assertion");
  for (const r of results) {
    const outcome = r.outcome === "pass" && !r.landed ? "pass (early)" : r.outcome;
    console.log(
      `${r.ask.padEnd(4)} ${(r.landed ? "yes" : "no").padEnd(7)} ${outcome.padEnd(14)} ${String(r.passed).padStart(2)}  ${r.seconds.toFixed(1).padStart(4)}  ${r.assertion ?? ""}`,
    );
    if (r.detail) console.log(`${" ".repeat(35)}${r.detail}`);
  }
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  console.log(`\n${count("pass")} pass, ${count("expected fail")} expected fail, ${count("fail")} fail, ${count("error")} error`);
}

const [portArg, ...only] = process.argv.slice(2);
if (portArg === undefined) usage("give the port to run the daemon on");
const unknown = only.filter((ask) => !PROBES.some((p) => p.ask === ask));
if (unknown.length > 0) usage(`no probe for ${unknown.join(", ")}`);
const selected = only.length > 0 ? PROBES.filter((p) => only.includes(p.ask)) : PROBES;

const asksPath = join(SOURCE, "docs/engineering/ASKS.md");
const log = (line: string) => console.log(`probes: ${line}`);
let bench: Bench | undefined;
const shutdown = async (code: number) => {
  await bench?.stop();
  process.exit(code);
};
process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

try {
  bench = await Bench.start(Number(portArg), log);
} catch (e) {
  log(e instanceof Error ? e.message : String(e));
  await shutdown(1);
}
const running = bench as Bench;
const landed = landedAsks(existsSync(asksPath) ? readFileSync(asksPath, "utf8") : undefined);
log(`cmx2 ${PIN.slice(0, 7)} (version ${running.version}) on ${running.url}, bench model on ${running.port + 1}`);
log(
  existsSync(asksPath)
    ? `ASKS.md at the pin marks landed: ${[...landed].join(", ") || "none"}`
    : "ASKS.md does not exist at the pin: no ask is landed there",
);
log(`logs: ${join(BASE, "daemon.log")}, ${join(BASE, "requests.log")}`);

const results: Result[] = [];
for (const probe of selected) results.push(await runProbe(running, probe, landed.has(probe.ask)));
await running.stop();
log(`daemon and bench model stopped`);
table(results);
process.exit(results.some((r) => r.outcome === "fail" || r.outcome === "error") ? 1 : 0);
