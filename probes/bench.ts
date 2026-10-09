/* the daemon the probes run against: cmx2 from the commit in cmx2.pin,
   started by the probes themselves because a1 kills and restarts it and a3
   samples its rss. the bench model runs on the next port. everything lives
   under .cmx2/probes/, wiped at the start of each run, so every run starts
   from an empty store; the logs stay there afterwards for reading.

   the probes never attach to a daemon they did not start: if either port
   answers, they refuse (AGENTS.md rule 13). */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  baseEnv,
  basicAuth,
  checkPort,
  type DaemonDirs,
  daemonArgs,
  daemonDirs,
  daemonEnv,
  exportPin,
  mintPassword,
  modelArgs,
  pinnedVersion,
  ROOT,
  writeDaemonConfig,
} from "../scripts/pinned";

export const BASE = join(ROOT, ".cmx2", "probes");
const STOP_GRACE_MS = 3000;

function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", () => resolve()));
}

/** signals the child's whole process group (it runs detached), so what it spawned goes too */
function signal(child: ChildProcess | undefined, sig: NodeJS.Signals) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    /* already gone */
  }
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child) return;
  signal(child, "SIGTERM");
  const timer = setTimeout(() => signal(child, "SIGKILL"), STOP_GRACE_MS);
  await exited(child);
  clearTimeout(timer);
}

/** what the probes' sessions work in: two env files whose reads ask permission (the default rules ask
    for `*.env`), a `/probe` command, and its own git root so the project is this directory */
function prepareWork(dirs: DaemonDirs) {
  writeFileSync(join(dirs.work, "one.env"), "PROBE_ONE=1\n");
  writeFileSync(join(dirs.work, "two.env"), "PROBE_TWO=2\n");
  mkdirSync(join(dirs.work, ".cmx2", "command"), { recursive: true });
  writeFileSync(
    join(dirs.work, ".cmx2", "command", "probe.md"),
    "---\ndescription: the probes' command\n---\n[bench:words 3 5] the probe command ran\n",
  );
  spawnSync("git", ["init", "--quiet"], { cwd: dirs.work });
}

export class Bench {
  readonly url: string;
  readonly auth: string;
  readonly version: string;
  private daemon: ChildProcess | undefined;
  private model: ChildProcess | undefined;

  private constructor(
    readonly port: number,
    readonly dirs: DaemonDirs,
    private readonly password: string,
  ) {
    this.url = `http://127.0.0.1:${port}`;
    this.auth = basicAuth(password);
    this.version = pinnedVersion();
  }

  static async start(port: number, log: (line: string) => void): Promise<Bench> {
    checkPort(port);
    for (const p of [port, port + 1]) {
      if (await inUse(p)) throw new Error(`port ${p} is in use; the probes start their own daemon and never attach to one`);
    }
    exportPin(log);
    rmSync(BASE, { recursive: true, force: true });
    const dirs = daemonDirs(BASE);
    writeDaemonConfig(dirs, port + 1);
    prepareWork(dirs);
    const bench = new Bench(port, dirs, mintPassword(join(BASE, "password"), "probe"));
    bench.model = bench.spawn("model.log", modelArgs(port + 1), ROOT, baseEnv());
    await bench.startDaemon();
    return bench;
  }

  private spawn(logName: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
    const out = openSync(join(BASE, logName), "a");
    const child = spawn("bun", args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    return child;
  }

  private async startDaemon() {
    this.daemon = this.spawn("daemon.log", daemonArgs(this.port), this.dirs.work, daemonEnv(this.dirs, this.password));
    const health = await this.health(20_000);
    if (health.version !== this.version) {
      throw new Error(`the daemon reports ${String(health.version)}, the pinned source says ${this.version}`);
    }
  }

  async health(timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.daemon?.exitCode !== null) throw new Error(`the daemon exited during startup; see ${join(BASE, "daemon.log")}`);
      try {
        const res = await fetch(`${this.url}/global/health`, { headers: { authorization: this.auth } });
        if (res.ok) return (await res.json()) as Record<string, unknown>;
      } catch {
        /* not up yet */
      }
      await Bun.sleep(100);
    }
    throw new Error(`the daemon did not answer /global/health on ${this.port} within ${timeoutMs} ms`);
  }

  get pid(): number {
    if (!this.daemon?.pid) throw new Error("the daemon is not running");
    return this.daemon.pid;
  }

  /** resident memory of the daemon process in kb, from ps */
  rss(): number {
    const out = spawnSync("ps", ["-o", "rss=", "-p", String(this.pid)], { encoding: "utf8" });
    const kb = Number(out.stdout.trim());
    if (!Number.isFinite(kb) || kb <= 0) throw new Error(`ps could not read the daemon's rss (pid ${this.pid})`);
    return kb;
  }

  /** a1's restart: sigkill, so nothing gets a chance to flush on the way out, then the same data dir */
  async kill9AndRestart() {
    const daemon = this.daemon;
    signal(daemon, "SIGKILL");
    if (daemon) await exited(daemon);
    await this.startDaemon();
  }

  async stop() {
    await Promise.all([stopChild(this.daemon), stopChild(this.model)]);
  }
}
