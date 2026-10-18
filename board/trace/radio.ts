/* the radio's seams for a native daemon (docs/board.md, the harness's
   seams), recorded as v1's preload recorded `say` and `sox`:

     - `say_command` names a shim that runs say-recorder.ts, which appends
       its argv and the time to a log and exits 0 without speaking. a line
       becomes `exec say <args>` and `exec-end say`.
     - `BOXBOX_BOARD_METER=script:<path>` reads the scripted microphone
       written here: the six level windows 150ms apart that preload.ts fed
       v1's meter through a fake sox, then quiet. in script mode the daemon
       appends `start` and `stop` lines to `<path>.log`; each becomes
       `exec sox` and `exec-end sox`, so the radio channel compares with
       v1's sox start and stop line for line.

   both logs are tailed every TAIL_MS. a say line carries its own time; a
   meter line is stamped when it is read, at most TAIL_MS late. */

import { chmodSync, existsSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Record } from "./records";

/** preload.ts's microphone: window rms values, so the meter's auto-gain
    lands on the same bars every run */
export const MIC_WINDOWS = [0.3, 0.15, 0.3, 0.08, 0.3, 0.15];
export const MIC_WINDOW_MS = 150;
const TAIL_MS = 10;
const RECORDER = resolve(import.meta.dir, "say-recorder.ts");

export type MeterScript = { windowMs: number; levels: number[] };

export function meterScript(): MeterScript {
  return { windowMs: MIC_WINDOW_MS, levels: MIC_WINDOWS };
}

/** an executable that records instead of speaking, for `say_command` */
export function writeSayShim(dir: string, log: string): string {
  const path = join(dir, "say");
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(RECORDER)} ${quote(log)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** new lines appended to a file since the last call */
function tailer(path: string): () => string[] {
  let offset = 0;
  let partial = "";
  return () => {
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    if (size <= offset) return [];
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      offset += read;
      partial += buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    return lines.filter((line) => line.trim() !== "");
  };
}

export type SayLine = { t: number; argv: string[] };

function isSayLine(value: unknown): value is SayLine {
  return typeof value === "object" && value !== null && "t" in value && typeof value.t === "number" && "argv" in value && Array.isArray(value.argv);
}

export type Radio = { sayCommand: string; meterPath: string; stop: () => void };

/** writes the meter script and the say shim into `dir`, and tails both logs */
export function startRadio(dir: string, onRecord: (record: Record) => void, now: () => number = Date.now): Radio {
  const meterPath = join(dir, "meter.json");
  writeFileSync(meterPath, `${JSON.stringify(meterScript())}\n`);
  const sayLog = join(dir, "say.log");
  const sayCommand = writeSayShim(dir, sayLog);
  const says = tailer(sayLog);
  const meter = tailer(`${meterPath}.log`);
  const poll = () => {
    for (const line of says()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isSayLine(parsed)) continue;
      onRecord({ ch: "exec", t: parsed.t, cmd: "say", args: parsed.argv.map(String) });
      onRecord({ ch: "exec-end", t: parsed.t, cmd: "say" });
    }
    for (const line of meter()) {
      const t = now();
      const word = line.trim();
      if (word === "start") onRecord({ ch: "exec", t, cmd: "sox", args: [] });
      else if (word === "stop") onRecord({ ch: "exec-end", t, cmd: "sox" });
    }
  };
  const timer = setInterval(poll, TAIL_MS);
  return {
    sayCommand,
    meterPath,
    stop: () => {
      clearInterval(timer);
      poll();
    },
  };
}
