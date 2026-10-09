/* daemon config: defaults + a hot-reloaded json file. every timing the
   interaction spec calls "config" lives here so tuning never needs a
   reflash OR a daemon restart (fs.watch on the file). */

import { existsSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./log";

export type BoardConfig = {
  origin: string;
  password: string;
  stateDir: string;
  /** verb grammar timings, ms */
  holdMs: number;
  doubleMs: number;
  /** pit: how long the reject key stays armed */
  rejectArmMs: number;
  /** briefing plays when the stream was away longer than this */
  awayMs: number;
  /** GLOBAL brightness by hour, 24 entries 0-255 */
  nightCurve: number[];
  /** the day's spend line for the fleet bank odometer, usd */
  spendLineUsd: number;
  /** tts voice for readback; empty = system default */
  voice: string;
  /** mic meter master switch */
  micMeter: boolean;
  /** host order for the machines row (div, mul, min) */
  machineOrder: string[];
  /** hands-free is dead reckoning (the daemon never sees wispr's state):
      this long with no voice on the meter clears the flag. with the
      meter unavailable it acts as a hard cap from the double-tap.
      0 disables the clock entirely. */
  handsFreeSilenceMs: number;
};

const DEFAULTS: Omit<BoardConfig, "password"> = {
  origin: "http://localhost:3000",
  stateDir: join(homedir(), ".local", "share", "boxbox-board"),
  holdMs: 350,
  doubleMs: 300,
  rejectArmMs: 5000,
  awayMs: 30 * 60_000,
  /* whispers at 3am, speaks at noon */
  nightCurve: [
    60, 50, 45, 45, 50, 70, 110, 160, 200, 230, 250, 255,
    255, 255, 255, 255, 250, 240, 220, 200, 170, 140, 110, 80,
  ],
  spendLineUsd: 500,
  voice: "",
  micMeter: true,
  machineOrder: [],
  /* generous: mid-dictation thinking pauses are long, and a meter that
     lies for a while beats a clock that cuts a monologue */
  handsFreeSilenceMs: 45_000,
};

export function configPath(): string {
  return process.env.BOARD_CONFIG ?? join(homedir(), ".config", "boxbox-board.json");
}

function read(log: Logger): BoardConfig {
  let fileCfg: Partial<BoardConfig> = {};
  const path = configPath();
  try {
    if (existsSync(path)) {
      fileCfg = JSON.parse(readFileSync(path, "utf8")) as Partial<BoardConfig>;
    }
  } catch (e) {
    /* a broken file mid-edit never downgrades a live daemon — the
       previous config stays active, same law as cmx config reload */
    log.warn("config.unreadable", { path, message: String(e) });
  }
  /* precedence: config file > env > dev default. the file wins so the
     launchd install carries no secrets in the plist. */
  return {
    ...DEFAULTS,
    password: process.env.BOXBOX_PASSWORD ?? "boxbox",
    ...fileCfg,
  };
}

export function loadConfig(log: Logger, onChange: (next: BoardConfig) => void): BoardConfig {
  const initial = read(log);
  const path = configPath();
  try {
    if (existsSync(path)) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      watch(path, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const next = read(log);
          log.info("config.reloaded", { path });
          onChange(next);
        }, 300);
      });
    }
  } catch {
    /* no watcher on an absent file; restart picks it up */
  }
  return initial;
}
