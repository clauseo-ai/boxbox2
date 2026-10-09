/* `just dev`: the boxbox dev server on 3001, one process tree.

   - vite on 127.0.0.1:3002 serves the app with hot reload; the rust server
     proxies page and module requests to it (boxbox.dev.toml's [dev]).
   - the rust server on 3001 is rebuilt and restarted when anything it is
     built from changes; a failed build leaves the running one in place.
   - ctrl-c or sigterm stops everything: each child runs in its own process
     group and the whole group is signalled, then killed after 3 s.

   it runs against the dev daemon from `just cmx2` and reads the bench
   config (.cmx2/bench/boxbox.dev.toml). the daemon does not have to be up
   first: with no bench config yet, this writes one for the default port
   and the bench password the daemon will use, and the server reloads host
   config whenever `just cmx2` rewrites the file, so starting the daemon
   later (or on another port) connects without a restart. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { BOXBOX_PORT, mintPassword, writeBoxboxConfigs } from "./pinned";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = join(ROOT, ".cmx2/bench");
const CONFIG = join(BENCH, "boxbox.dev.toml");
const BINARY = join(ROOT, "target/debug/boxbox");
const WATCHED = ["server/src", "server/build", "server/Cargo.toml", "vendor/cmx2", "telemetry/schema.json"];
const DEBOUNCE_MS = 300;

let vite: ChildProcess | undefined;
let server: ChildProcess | undefined;
let stopping = false;

function log(line: string) {
  console.log(`dev: ${line}`);
}

function listening(port: number): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0;
}

function start(command: string, args: string[], cwd: string): ChildProcess {
  return spawn(command, args, { cwd, detached: true, stdio: ["ignore", "inherit", "inherit"], env: process.env });
}

function signalGroup(child: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function exited(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function stopChild(child: ChildProcess | undefined) {
  signalGroup(child, "SIGTERM");
  const killer = setTimeout(() => signalGroup(child, "SIGKILL"), 3000);
  await exited(child);
  clearTimeout(killer);
}

function build(): boolean {
  const out = spawnSync("cargo", ["build", "--quiet"], { cwd: ROOT, stdio: "inherit" });
  return out.status === 0;
}

function startServer() {
  server = start(BINARY, ["serve", "--config", CONFIG], ROOT);
  const current = server;
  current.once("exit", (code, signal) => {
    if (!stopping && current === server) log(`the server exited (${signal ?? code}); it restarts on the next change`);
  });
}

async function rebuild() {
  log("change seen; rebuilding the server");
  if (!build()) {
    log("the build failed; the running server stays up");
    return;
  }
  await stopChild(server);
  startServer();
}

async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  log("stopping");
  await Promise.all([stopChild(server), stopChild(vite)]);
  process.exit(code);
}

if (!existsSync(CONFIG)) {
  writeBoxboxConfigs(BENCH, 4840, mintPassword(join(BENCH, "password"), "bench"));
  log("no bench config yet; wrote one for the dev daemon on 4840 (start it with `just cmx2`)");
}
for (const port of [BOXBOX_PORT, 3002]) {
  if (listening(port)) {
    console.error(`dev: port ${port} is taken; one dev server at a time (lsof -nP -iTCP:${port} -sTCP:LISTEN)`);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

vite = start("bunx", ["vite"], join(ROOT, "app"));
vite.once("exit", (code, signal) => {
  if (!stopping) {
    console.error(`dev: vite exited (${signal ?? code}); stopping`);
    void shutdown(1);
  }
});
if (!build()) {
  console.error("dev: the server does not build; fix it and run `just dev` again");
  await shutdown(1);
}
startServer();

let pending: ReturnType<typeof setTimeout> | undefined;
let running = Promise.resolve();
for (const path of WATCHED) {
  watch(join(ROOT, path), { recursive: true }, () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      running = running.then(rebuild);
    }, DEBOUNCE_MS);
  });
}
log(`boxbox on http://127.0.0.1:${BOXBOX_PORT} (vite on 3002, the dev daemon from \`just cmx2\`)`);
