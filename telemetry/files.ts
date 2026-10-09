/* the read half of the telemetry log: where the day files live and how
   one is parsed. the write half is the rust server (server/src/telemetry),
   which appends the same one-object-per-line files v1 wrote, so the query
   tool reads v1's days and v2's days alike.

   carried from v1's lib/telemetry/log.ts; only the data dir default moved
   (v2's server keeps its data in ~/.local/share/boxbox). */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WireEvent } from "./schema";

export function dataDir(): string {
  return process.env.BOXBOX_DATA_DIR ?? join(homedir(), ".local", "share", "boxbox");
}

export function telemetryDir(): string {
  return join(dataDir(), "telemetry");
}

export type DayFile = { day: string; path: string };

/** every day file present, oldest first. `since` is an inclusive
    YYYY-MM-DD floor. */
export function dayFiles(since?: string): DayFile[] {
  let names: string[];
  try {
    names = readdirSync(telemetryDir());
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => ({ day: n.replace(/\.jsonl$/, ""), path: join(telemetryDir(), n) }))
    .filter((f) => !since || f.day >= since)
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** parse one day file, skipping torn lines (a kill -9 mid-append leaves
    at most one). returns what survived. */
export function readDay(path: string): WireEvent[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: WireEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as WireEvent);
    } catch {
      /* torn tail line */
    }
  }
  return out;
}
