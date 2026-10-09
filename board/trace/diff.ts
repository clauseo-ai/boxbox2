/* the replay diff: two normalized views, step by step and channel by
   channel, as a line diff. `-` is the recorded trace, `+` the replay. an
   empty diff is the whole claim: identical behaviour on every channel. */

import { CHANNELS, type View } from "./normalize";

export type Hunk = { step: number; label: string; channel: (typeof CHANNELS)[number]; lines: string[] };

/** longest-common-subsequence line diff, context lines dropped. a line
    marked optional on its own side is not a difference when the other side
    lacks it; it still has to match wherever both sides have it. */
export function lineDiff(expected: string[], actual: string[], expectedOptional: boolean[] = [], actualOptional: boolean[] = []): string[] {
  const n = expected.length;
  const m = actual.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const below = lcs[i + 1] as number[];
      row[j] = expected[i] === actual[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && expected[i] === actual[j]) {
      i++;
      j++;
    } else if (j < m && (i === n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      if (!actualOptional[j]) out.push(`+ ${actual[j]}`);
      j++;
    } else {
      if (!expectedOptional[i]) out.push(`- ${expected[i]}`);
      i++;
    }
  }
  return out;
}

export function diffViews(expected: View, actual: View): Hunk[] {
  const hunks: Hunk[] = [];
  const count = Math.max(expected.steps.length, actual.steps.length);
  for (let step = 0; step < count; step++) {
    const want = expected.steps[step];
    const got = actual.steps[step];
    if (want?.label !== got?.label) {
      hunks.push({ step, label: want?.label ?? got?.label ?? "", channel: "board", lines: [`- step ${want?.label ?? "(none)"}`, `+ step ${got?.label ?? "(none)"}`] });
      continue;
    }
    if (!want || !got) continue;
    for (const channel of CHANNELS) {
      const lines = channel === "leds" ? lineDiff(want.leds, got.leds, want.ledsOptional, got.ledsOptional) : lineDiff(want[channel], got[channel]);
      if (lines.length > 0) hunks.push({ step, label: want.label, channel, lines });
    }
  }
  return hunks;
}

export function printHunks(hunks: Hunk[]): string {
  return hunks.map((h) => [`step ${h.step} · ${h.label} · ${h.channel}`, ...h.lines.map((l) => `  ${l}`)].join("\n")).join("\n");
}
