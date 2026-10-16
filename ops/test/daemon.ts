/* the cmx2 daemon the ops tests run against: the pinned commit
   (scripts/pinned.ts), on 127.0.0.1:4900 with the bench model on 4901, its
   state under /tmp/boxbox-ops-bench/: a daemon working inside a git
   checkout makes the checkout its project (AGENTS.md, scratch in /tmp). the ops
   lane's ports (4900 to 4909) keep it clear of `just cmx2` on 4840 to
   4849. the bench password is written to /tmp/boxbox-ops-bench/password
   for the container to read.

   --port <n> moves it (the model takes n + 1) and its state to
   /tmp/boxbox-ops-bench-<n>/, so a second one never shares a data dir.
   daemon.json there says where everything is, for the pairing test in
   server/src/cli/init.rs, which mints a token with this daemon's own cli
   (`cmx2 pair`) against its data dir.

   one process tree: sigterm or ctrl-c stops both children, and if either
   dies the other is stopped too. */

import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  baseEnv,
  basicAuth,
  daemonArgs,
  daemonDirs,
  daemonEnv,
  exportPin,
  mintPassword,
  modelArgs,
  pinnedVersion,
  ROOT,
  SOURCE,
  writeDaemonConfig,
} from "../../scripts/pinned";

const at = process.argv.indexOf("--port");
const PORT = at === -1 ? 4900 : Number(process.argv[at + 1]);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65534) {
  console.error(`ops daemon: --port must be a port from 1024 to 65534, not ${process.argv[at + 1]}`);
  process.exit(2);
}
const MODEL_PORT = PORT + 1;
const BENCH = at === -1 ? "/tmp/boxbox-ops-bench" : `/tmp/boxbox-ops-bench-${PORT}`;

exportPin((line) => console.log(`ops daemon: ${line}`));
const dirs = daemonDirs(BENCH);
writeDaemonConfig(dirs, MODEL_PORT);
const password = mintPassword(join(BENCH, "password"), "bench");

const children: ChildProcess[] = [];
let stopping = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  }
  const deadline = setTimeout(() => process.exit(code), 3000);
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() => {
    clearTimeout(deadline);
    process.exit(code);
  });
}

function start(name: string, args: string[], cwd: string, env: Record<string, string>) {
  // its own process group, so stopping it stops what it spawned
  const child = spawn("bun", args, { cwd, env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`ops daemon: ${name} exited (${signal ?? code}); stopping`);
      stop(1);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
start("the bench model", modelArgs(MODEL_PORT), ROOT, baseEnv());
start("the daemon", daemonArgs(PORT), dirs.work, daemonEnv(dirs, password));

let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/global/health`, { headers: { authorization: basicAuth(password) } });
    if (res.ok) {
      const health = (await res.json()) as { version: string };
      console.log(`ops daemon: GET /global/health -> ${JSON.stringify(health)}`);
      if (health.version !== pinnedVersion()) {
        console.error(`ops daemon: reports ${health.version}, the pin says ${pinnedVersion()}`);
        stop(1);
      }
      const where = {
        url: `http://127.0.0.1:${PORT}`,
        port: String(PORT),
        cli: join(SOURCE, "packages/cli/src/index.ts"),
        home: dirs.home,
        configDir: dirs.config,
        dataDir: dirs.data,
        pids: children.map((c) => c.pid),
      };
      writeFileSync(join(BENCH, "daemon.json"), `${JSON.stringify(where, null, 2)}\n`);
      console.log(`ops daemon: ready on http://127.0.0.1:${PORT}, pids ${children.map((c) => c.pid).join(" ")}; ${join(BENCH, "daemon.json")}`);
      ready = true;
    }
  } catch {
    // not up yet
  }
  if (!ready) await Bun.sleep(200);
}
if (!ready) {
  console.error(`ops daemon: no answer on /global/health at ${PORT} within 20 s`);
  stop(1);
}
