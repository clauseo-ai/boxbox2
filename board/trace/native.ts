/* a native board daemon under trace (decision 78): the `boxbox-board`
   binary, unmodified, in its own process, with the harness at each seam
   docs/board.md names:

     - BOXBOX_BOARD_HID=unix:<path>: the fake board on a socket
       (socket-board.ts), plugged in when the run says so;
     - BOXBOX_BOARD_METER=script:<path>: the scripted microphone, whose
       start and stop the daemon logs beside it (radio.ts);
     - BOXBOX_BOARD_CONFIG=<path>: the config below, its origin the
       recording proxy (proxy.ts) in front of the world's server, and its
       say_command the recorder (radio.ts).

   HOME is the run's own, so the daemon's state dir (cookie, device id, log)
   starts empty every run. the daemon's stdout and stderr go to daemon.log
   in the run directory. */

import { type Subprocess } from "bun";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonOptions, TracedDaemon } from "./daemon";
import { startProxy } from "./proxy";
import { startRadio } from "./radio";
import { SocketBoard } from "./socket-board";

/** a toml string: json's escapes are toml's for everything a path holds */
const tomlString = (s: string) => JSON.stringify(s);

/** the daemon's config for a trace: every clock-driven input pinned. the
    night curve is flat so GLOBAL does not depend on the hour; the verb
    timings are left out, so the daemon's own defaults apply. */
export function nativeConfig(options: { origin: string; passwordFile: string; sayCommand: string }): string {
  return [
    "# written by board/trace/native.ts for one traced run",
    `origin = ${tomlString(options.origin)}`,
    `password_file = ${tomlString(options.passwordFile)}`,
    `night_curve = [${Array<number>(24).fill(255).join(", ")}]`,
    'voice = ""',
    "mic_meter = true",
    `say_command = ${tomlString(options.sayCommand)}`,
    "",
  ].join("\n");
}

export function startNativeDaemon(options: DaemonOptions): TracedDaemon {
  if (!existsSync(options.daemon) || !statSync(options.daemon).isFile()) {
    throw new Error(`no board daemon binary at ${options.daemon}; build it with \`cargo build --release -p boxbox-board\``);
  }
  rmSync(options.runDir, { recursive: true, force: true });
  const home = join(options.runDir, "home");
  const radioDir = join(options.runDir, "radio");
  for (const dir of [home, radioDir]) mkdirSync(dir, { recursive: true });

  const proxy = startProxy(options.origin, options.onRecord);
  const radio = startRadio(radioDir, options.onRecord);
  /* a short path: macos caps a unix socket's path at 104 bytes */
  const socketPath = join("/tmp", `boxbox-board-trace-${process.pid}-${Date.now().toString(36)}.sock`);
  const board = new SocketBoard({ path: socketPath, onRecord: options.onRecord });

  const passwordFile = join(options.runDir, "password");
  writeFileSync(passwordFile, `${options.password}\n`, { mode: 0o600 });
  const configPath = join(options.runDir, "board.toml");
  writeFileSync(configPath, nativeConfig({ origin: proxy.origin, passwordFile, sayCommand: radio.sayCommand }), { mode: 0o600 });
  const log = createWriteStream(join(options.runDir, "daemon.log"));

  const child: Subprocess = Bun.spawn([options.daemon, "run"], {
    cwd: options.runDir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      RUST_LOG: process.env.BOARD_TRACE_RUST_LOG ?? "info",
      BOXBOX_BOARD_CONFIG: configPath,
      BOXBOX_BOARD_HID: `unix:${socketPath}`,
      BOXBOX_BOARD_METER: `script:${radio.meterPath}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (stream instanceof ReadableStream) void stream.pipeTo(new WritableStream({ write: (chunk) => void log.write(chunk) }));
  }

  return {
    connectsBeforePlug: false,
    plug: () => board.plug(),
    press: (wire, down) => board.press(wire, down),
    exited: child.exited,
    stop: async () => {
      child.kill("SIGTERM");
      const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => null)]);
      if (code === null) child.kill("SIGKILL");
      await child.exited;
      board.stop();
      radio.stop();
      await proxy.stop();
      log.end();
    },
  };
}
