/* the tape's arithmetic: time to position, the spans and marks, the scale
   (docs/thread.md, the tape). pure; no dom. */

import type { Item, Step, Turn } from "./model";
import { isBad } from "./rows";

export type TapeKind = "read" | "search" | "edit" | "run" | "web" | "spawn" | "ask" | "other";
const KIND: Partial<Record<Step["family"], TapeKind>> = { read: "read", search: "search", edit: "edit", shell: "run", web: "web", spawn: "spawn", ask: "ask" };
export const tapeKind = (s: Step): TapeKind => KIND[s.family] ?? "other";

/** live, the scale runs ahead to one of these spans (minutes), so marks never slide */
export const RANGES = [2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240].map((m) => m * 60_000);

export type TimeMap = { x: (time: number) => number; start: number; end: number; span: number };

/** time to a position in percent. settled: linear, with any quiet stretch over three minutes folded so the work fills the width.
    live: the next round span past now, the head travelling across it. */
export function timeMap(t: Pick<Turn, "at" | "end">, items: readonly Item[], now?: number, live = false): TimeMap {
  const start = t.at;
  if (live) {
    const at = now ?? start;
    const span = RANGES.find((r) => r >= (at - start) * 1.08) ?? (at - start) * 1.2;
    return { x: (time) => Math.max(0, Math.min(100, ((time - start) / span) * 100)), start, end: start + span, span };
  }
  const end = Math.max(now ?? t.end, start + 1000);
  const busy = items.filter((x) => x.at).map((x): [number, number] => [x.at, x.at + (x.k === "say" ? 0 : x.ms)]).sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = start;
  for (const [a, b] of busy) { if (a - cursor > 180_000) gaps.push([cursor + 20_000, a - 20_000]); cursor = Math.max(cursor, b); }
  if (end - cursor > 180_000 && now === undefined) gaps.push([cursor + 20_000, end - 20_000]);
  const folded = gaps.reduce((acc, [a, b]) => acc + (b - a), 0);
  const span = Math.max(1, end - start - folded);
  const x = (time: number): number => {
    let off = time - start;
    for (const [a, b] of gaps) { if (time > b) off -= b - a; else if (time > a) off -= time - a; }
    return Math.max(0, Math.min(100, (off / span) * 100));
  };
  return { x, start, end, span };
}

export type ThinkSpan = { left: number; width: number };
export function thinkSpans(items: readonly Item[], map: TimeMap): ThinkSpan[] {
  return items.flatMap((it) => (it.k === "think" && it.ms > 0 ? [{ left: map.x(it.at), width: Math.max(0.3, map.x(it.at + it.ms) - map.x(it.at)) }] : []));
}

export type Mark = { kind: TapeKind; left: number; width?: number; bad: boolean; live: boolean };
export function marksOf(steps: readonly Step[], map: TimeMap, now?: number): Mark[] {
  return steps.map((s) => {
    const kind = tapeKind(s), bad = isBad(s), left = map.x(s.at);
    const running = s.status === "running";
    if (kind === "run" && (s.ms >= 1200 || running)) return { kind, left, width: Math.max(0.8, map.x(s.at + (running ? (now ?? s.at) - s.at : s.ms)) - left), bad, live: running };
    return { kind: kind === "run" ? "read" : kind, left, bad, live: false };
  });
}

export type Tick = { left: number; major: boolean; label?: string };
/** marks every 30 s, 1, 2, 5, 10, 15, 30 or 60 minutes so there are at most six, labelled away from the ends (a fifth of the scale: on the phone a tick label nearer than that touches the clock at the end) */
export function scaleOf(map: TimeMap): Tick[] {
  const minutes = map.span / 60_000;
  const stepMin = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((m) => minutes / m <= 6) ?? 240;
  const out: Tick[] = [];
  for (let m = 0; m <= minutes + 1e-6; m += stepMin / 2) {
    const left = (m / minutes) * 100;
    if (left > 100.5) break;
    const major = Math.abs(m / stepMin - Math.round(m / stepMin)) < 1e-6;
    const label = major && left > 20 && left < 80 ? (m < 1 ? `${Math.round(m * 60)} s` : m >= 60 ? `${m / 60} h` : `${m} min`) : undefined;
    out.push({ left, major, ...(label !== undefined ? { label } : {}) });
  }
  return out;
}

/** the step nearest a position on the tape */
export function nearest(steps: readonly Step[], map: TimeMap, pct: number): Step | undefined {
  let best: Step | undefined, d = Infinity;
  for (const s of steps) { const dd = Math.abs(map.x(s.at) - pct); if (dd < d) { d = dd; best = s; } }
  return best;
}
