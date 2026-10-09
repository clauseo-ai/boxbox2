/* a world: the server side a board trace runs against. the board daemon is
   a client of one origin; behind it sits the server under test and the
   agent runtime it fronts, both real, both started and stopped by the
   world. scenarios speak to the world in one small vocabulary, so the same
   scenario runs against v1 (world-v1.ts) and against v2 (the world m6
   adds), and the traces stay comparable. */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/** what a scenario can make an agent do; the world's model scripts each one */
export type Turn =
  /** a one-line reply, which leaves the thread unread */
  | { kind: "reply" }
  /** one shell command that has to be allowed */
  | { kind: "permission" }
  /** one question with this many options, 1 to 9 */
  | { kind: "question"; options: number }
  /** a streamed reply: this many words, one every `everyMs` */
  | { kind: "work"; words: number; everyMs: number };

export type World = {
  /** the board daemon's server */
  origin: string;
  password: string;
  /** the host ids the machines row shows, in order */
  machineOrder: string[];
  /** open a thread titled `alias` and start its first turn */
  open(alias: string, turn: Turn): Promise<void>;
  /** start another turn on an open thread */
  prompt(alias: string, turn: Turn): Promise<void>;
  /** wait until the thread's turn has finished, or is waiting on him */
  settled(alias: string): Promise<void>;
  /** no agent is working: every busy thread is waiting on an ask */
  quiet(): Promise<boolean>;
  /** real ids the world minted, to the aliases scenarios use */
  aliases(): Map<string, string>;
  /** machine-specific strings (paths) to their placeholders, applied
      before a trace is written so it names nothing on this machine */
  redactions(): [string, string][];
  stop(): Promise<void>;
};

export type Service = { name: string; child: ChildProcess };

/** a service in its own process group, so stopping it stops what it spawned */
export function launch(name: string, command: string, args: string[], cwd: string, env: Record<string, string>, logPath: string): Service {
  const log = createWriteStream(logPath);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return { name, child };
}

export async function halt(services: Service[]) {
  for (const { child } of [...services].reverse()) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* the group is already gone */
    }
  }
  const deadline = Date.now() + 8000;
  for (const { child } of services) {
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone between the check and the kill */
      }
    }
  }
}

export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000) {
  const began = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - began > timeoutMs) throw new Error(`gave up waiting for ${what} after ${timeoutMs}ms`);
    await Bun.sleep(250);
  }
}

/** the port is free, or the run stops before it starts anything */
export async function assertFree(port: number) {
  const inUse = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then(
    () => true,
    () => false,
  );
  if (inUse) throw new Error(`port ${port} is taken; the harness uses 4880 to 4889 and 3021, stop what holds it`);
}
