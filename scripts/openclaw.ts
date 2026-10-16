/* `just openclaw`: the openclaw dev gateway, built from the commit in
   openclaw.pin, with the scripted model (docs/openclaw.md, section 11).

   - the source comes from a bare mirror at ~/.cache/boxbox/openclaw.git
     (OPENCLAW_MIRROR overrides it), exported with `git archive` into
     .openclaw/<commit>/ and installed and built once with the tree's own
     pnpm (through corepack); the schema the tree generates must equal the
     vendored one. never a local openclaw checkout.
   - starts the scripted model (the tree's scripts/e2e/mock-openai-server.mjs,
     on port + 1, driven by bench/openclaw-script.ts) and the speech stub
     (bench/openclaw-speech.ts, port + 2), and points the gateway's provider
     and tts at them, so no real key or provider is ever used.
   - starts the gateway on 127.0.0.1:4740 (--port moves it; 4700 to 4835,
     x0 to x5 of a decade) with its own home, state dir and config under
     .openclaw/bench/, two agents, and a bench token minted once into
     .openclaw/bench/token. the environment is an allowlist.
   - waits for `hello-ok` with the bench token, checks server.version
     against the pin, makes sure the fixture cron job exists (disabled, run
     on demand), and writes .openclaw/bench/gateway.json ({url, commit, pids}).
   - one process tree: ctrl-c or sigterm stops every child, one dying stops
     the rest. a gateway that exits cleanly (a restart request) or is
     killed with SIGKILL (the chaos client's restart mid-turn) is started
     again on the same state dir, as an installed supervisor would.

   flags: --fresh wipes the bench state (not the token); --port <n>;
   --pairing manual binds the lan address with silent local pairing off
   (the pairing bench, on a port other than 4740); --archive-dashboard-after
   <duration> shortens session.maintenance.archiveDashboardAfter;
   --build-only builds and exits. */

import { type ChildProcess, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayClient, isObject } from "../bench/openclaw-client";
import {
  benchDir,
  benchPaths,
  benchPorts,
  benchToken,
  buildPin,
  checkFfmpeg,
  checkNode,
  checkPort,
  gatewayArgs,
  gatewayEnv,
  listening,
  modelArgs,
  modelEnv,
  PIN,
  ROOT,
  speechArgs,
  writeBenchConfig,
} from "./openclaw-pinned";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function fail(message: string): never {
  console.error(`openclaw: ${message}`);
  process.exit(1);
}

function attempt<T>(step: () => T): T {
  try {
    return step();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const log = (line: string) => console.log(`openclaw: ${line}`);
const PORT = Number(flag("--port") ?? process.env.OPENCLAW_PORT ?? 4740);
const PAIRING = flag("--pairing") ?? "auto";
if (PAIRING !== "auto" && PAIRING !== "manual") fail(`--pairing takes auto or manual, not ${PAIRING}`);
const MANUAL = PAIRING === "manual";
attempt(() => checkPort(PORT));
if (MANUAL && PORT === 4740) fail("--pairing manual runs a second bench: give it its own --port (4743 or 4745 in this decade)");
const ports = benchPorts(PORT);
const BENCH = benchDir(PORT);
const paths = benchPaths(BENCH);

log(`node ${attempt(checkNode)}`);
attempt(checkFfmpeg);
const buildStarted = Date.now();
attempt(() => buildPin(log));
if (process.argv.includes("--build-only")) {
  log(`the export at .openclaw/${PIN.commit.slice(0, 9)} is built (${Math.round((Date.now() - buildStarted) / 1000)} s this run)`);
  process.exit(0);
}

for (const port of Object.values(ports)) {
  if (await listening(port)) fail(`something already listens on ${port}; stop it (lsof -nP -iTCP:${port} -sTCP:LISTEN) or pick another --port`);
}
if (process.argv.includes("--fresh")) {
  for (const dir of ["state", "home", "work", "speech", "script.json", "model-requests.jsonl"]) rmSync(join(BENCH, dir), { recursive: true, force: true });
}
const token = benchToken(BENCH);
const archiveDashboardAfter = flag("--archive-dashboard-after");
writeBenchConfig(paths, { port: PORT, token, manualPairing: MANUAL, ...(archiveDashboardAfter ? { archiveDashboardAfter } : {}) });
writeFileSync(paths.control, `${JSON.stringify({ responses: [{ text: "ok, noted." }] }, null, 2)}\n`);

const children: ChildProcess[] = [];
const names = new Map<ChildProcess, string>();
let stopping = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  const deadline = setTimeout(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    process.exit(code);
  }, 5000);
  Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() => {
    clearTimeout(deadline);
    process.exit(code);
  });
}

function writeState() {
  writeFileSync(
    join(BENCH, "gateway.json"),
    `${JSON.stringify({ url: `ws://127.0.0.1:${PORT}`, commit: PIN.commit, pids: { supervisor: process.pid, ...Object.fromEntries(children.map((c) => [names.get(c) ?? "child", c.pid])) } }, null, 2)}\n`,
  );
}

/** `supervised`: a clean exit or a SIGKILL starts it again on the same state dir; any other exit stops the bench */
function start(name: string, command: string, args: string[], cwd: string, env: Record<string, string>, supervised = false) {
  /* detached: its own process group. stdin is a pipe held open for the gateway's host lifeline */
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "inherit", "inherit"] });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    children.splice(children.indexOf(child), 1);
    if (supervised && ((code === 0 && signal === null) || signal === "SIGKILL")) {
      log(`${name} exited (${signal ?? code}); starting it again on the same state dir`);
      start(name, command, args, cwd, env, supervised);
      writeState();
      return;
    }
    console.error(`openclaw: ${name} exited (${signal ?? code}); stopping the bench`);
    stop(1);
  });
  children.push(child);
  names.set(child, name.replace(/^the /, "").replace(/ /g, "-"));
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start("the scripted model", "node", modelArgs(), paths.root, modelEnv(paths, PORT));
start("the speech stub", "bun", speechArgs(PORT, paths), ROOT, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
start("the gateway", "node", gatewayArgs(PORT, MANUAL ? "lan" : "loopback"), paths.work.main ?? paths.root, gatewayEnv(paths), true);

/** connect with the bench token until hello-ok: the gateway's own readiness */
async function waitForHello(): Promise<GatewayClient> {
  let last = "";
  for (let i = 0; i < 300; i++) {
    if (stopping) process.exit(1);
    try {
      return await GatewayClient.connect({ url: `ws://127.0.0.1:${PORT}`, token, protocol: PIN.protocol });
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(500);
  }
  return fail(`the gateway did not answer hello-ok on ${PORT} within 150 s (${last})`);
}

const client = await waitForHello();
const hello = client.hello ?? {};
const server = isObject(hello.server) ? hello.server : {};
log(`hello-ok: protocol ${String(hello.protocol)}, server ${JSON.stringify(server)}`);
if (hello.protocol !== PIN.protocol) fail(`the gateway speaks protocol ${String(hello.protocol)}, the pin says ${PIN.protocol}`);
if (server.version !== PIN.version) fail(`the gateway reports version ${String(server.version)}, the pin says ${PIN.version}`);

/* the fixture cron job: on main, disabled, run on demand by the harness (cron.run). jobs live in the
   gateway's store, not the config, so it is added once through the api */
const jobs = await client.request("cron.list", { includeDisabled: true, limit: 200 });
const listed = isObject(jobs) && Array.isArray(jobs.jobs) ? jobs.jobs : [];
if (!listed.some((j) => isObject(j) && j.name === "bench scheduled")) {
  await client.request("cron.add", {
    name: "bench scheduled",
    agentId: "main",
    enabled: false,
    schedule: { kind: "cron", expr: "0 0 1 1 *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "the scheduled bench turn" },
  });
  log("added the fixture cron job `bench scheduled` (disabled; run it with cron.run)");
}
client.close();

writeState();
log(`dev gateway ready on ws://127.0.0.1:${PORT}, version ${PIN.version} matches the pin ${PIN.commit.slice(0, 9)}`);
log(`scripted model on http://127.0.0.1:${ports.model}, speech stub on http://127.0.0.1:${ports.speech}`);
log(`token in ${join(BENCH, "token")}; pids in ${join(BENCH, "gateway.json")}; this supervisor is pid ${process.pid}`);
