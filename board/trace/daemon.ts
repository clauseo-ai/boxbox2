/* a board daemon under trace: its own main.ts, unmodified, in its own bun
   process, with preload.ts in front of it. the parent presses keys and
   hears every record over ipc. the daemon's own log lines go to a file in
   the run directory, for the person reading a failed replay. */

import { type Subprocess } from "bun";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command, Record } from "./preload";

const PRELOAD = resolve(import.meta.dir, "preload.ts");

export type DaemonOptions = {
  /** the daemon package: holds src/main.ts and imports ../lib by relative path */
  daemonDir: string;
  /** scratch for this run: config, state dir, home, log */
  runDir: string;
  origin: string;
  password: string;
  /** host order for the machines row */
  machineOrder: string[];
  onRecord: (record: Record) => void;
};

export type TracedDaemon = {
  plug: () => void;
  press: (wire: number, down: boolean) => void;
  stop: () => Promise<void>;
  exited: Promise<number>;
};

/** the daemon's config for a trace: every clock-driven input pinned. the
    night curve is flat so GLOBAL does not depend on the hour the trace is
    recorded or replayed in; timings stay at the daemon's own defaults. */
export function traceConfig(options: Pick<DaemonOptions, "origin" | "password" | "machineOrder" | "runDir">) {
  return {
    origin: options.origin,
    password: options.password,
    stateDir: join(options.runDir, "state"),
    nightCurve: Array<number>(24).fill(255),
    machineOrder: options.machineOrder,
    micMeter: true,
    voice: "",
  };
}

export function startDaemon(options: DaemonOptions): TracedDaemon {
  const main = join(options.daemonDir, "src", "main.ts");
  if (!existsSync(main)) throw new Error(`no board daemon at ${main}`);
  /* a fresh daemon every run: a state dir left from the last one would
     carry its cookie and device id, and the login would go missing */
  rmSync(options.runDir, { recursive: true, force: true });
  const home = join(options.runDir, "home");
  mkdirSync(home, { recursive: true });
  const configPath = join(options.runDir, "board.json");
  writeFileSync(configPath, `${JSON.stringify(traceConfig(options), null, 2)}\n`);
  const log = createWriteStream(join(options.runDir, "daemon.log"));

  const child: Subprocess = Bun.spawn(["bun", "--preload", PRELOAD, main], {
    cwd: options.daemonDir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      BOARD_CONFIG: configPath,
    },
    stdout: "pipe",
    stderr: "pipe",
    ipc: (message: Record) => options.onRecord(message),
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (stream instanceof ReadableStream) void stream.pipeTo(new WritableStream({ write: (chunk) => void log.write(chunk) }));
  }

  return {
    plug: () => child.send({ kind: "plug" } satisfies Command),
    press: (wire, down) => child.send({ kind: "key", wire, down } satisfies Command),
    exited: child.exited,
    stop: async () => {
      child.kill("SIGTERM");
      const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => null)]);
      if (code === null) child.kill("SIGKILL");
      await child.exited;
      log.end();
    },
  };
}
