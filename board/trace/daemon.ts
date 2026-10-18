/* a board daemon under trace, attached at its process boundary one of two
   ways, chosen by what `--daemon` names:

     - a directory: v1's bun daemon (`<dir>/src/main.ts`), unmodified, in
       its own bun process with preload.ts in front of it. the parent
       presses keys and hears every record over ipc. this is the replay
       against v1's own daemon that proves the harness deterministic.
     - a file: the native `boxbox-board` binary (decision 78), with the
       harness at its seams (native.ts).

   either way the daemon's own log lines go to daemon.log in the run
   directory, for the person reading a failed replay. */

import { type Subprocess } from "bun";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startNativeDaemon } from "./native";
import type { Command } from "./preload";
import type { Record } from "./records";

const PRELOAD = resolve(import.meta.dir, "preload.ts");

export type DaemonOptions = {
  /** v1's daemon package (holds src/main.ts), or the native binary */
  daemon: string;
  /** scratch for this run: config, state dir, home, log */
  runDir: string;
  origin: string;
  password: string;
  /** host order for v1's machines row; the native daemon takes it from the server's view */
  machineOrder: string[];
  onRecord: (record: Record) => void;
};

export type TracedDaemon = {
  /** v1's daemon logs in and opens its stream with no board; the native one
      waits idle for the board and talks to nobody until it is plugged in */
  connectsBeforePlug: boolean;
  plug: () => void;
  press: (wire: number, down: boolean) => void;
  stop: () => Promise<void>;
  exited: Promise<number>;
};

export function isNative(daemon: string): boolean {
  return existsSync(daemon) && statSync(daemon).isFile();
}

export function startDaemon(options: DaemonOptions): TracedDaemon {
  return isNative(options.daemon) ? startNativeDaemon(options) : startV1Daemon(options);
}

/** v1's daemon config for a trace: every clock-driven input pinned. the
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

function startV1Daemon(options: DaemonOptions): TracedDaemon {
  const main = join(options.daemon, "src", "main.ts");
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
    cwd: options.daemon,
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
    connectsBeforePlug: true,
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
