/* the replay diff: two normalized views, step by step and channel by
   channel, as a line diff. `-` is the recorded trace, `+` the replay. an
   empty diff is the whole claim: identical behaviour on every channel,
   apart from the deliberate changes deltas.ts lists, which a replay against
   v2 forgives and prints on their own. */

import { type Delta, deltasFor, type LineContext } from "./deltas";
import { CHANNELS, type Seats, type View } from "./normalize";

export type Hunk = { step: number; label: string; channel: (typeof CHANNELS)[number]; lines: string[] };

/** a trace line and a replay line that differ, paired as the same behaviour by a rule */
export type Accounted = { step: number; label: string; channel: (typeof CHANNELS)[number]; rule: string; source: string; expected: string; actual: string };

export type LineDiff = { lines: string[]; accounted: { rule: Delta; expected: string; actual: string }[] };

/** longest-common-subsequence line diff, context lines dropped. a line
    marked optional on its own side is not a difference when the other side
    lacks it; it still has to match wherever both sides have it. two lines
    are equal when they are the same text, or when a rule says they are the
    same behaviour; the second kind is returned as accounted, never hidden. */
export function lineDiffWith(
  expected: string[],
  actual: string[],
  options: {
    expectedOptional?: boolean[];
    actualOptional?: boolean[];
    rules?: readonly Delta[];
    expectedSeats?: (Seats | null)[];
    actualSeats?: (Seats | null)[];
    actualBeforeView?: boolean[];
    expectedMemo?: boolean[];
    actualHold?: number[];
  } = {},
): LineDiff {
  const rules = options.rules ?? [];
  const expectedOptional = options.expectedOptional ?? [];
  const actualOptional = options.actualOptional ?? [];
  const context = (i: number, j: number): LineContext => ({
    expectedSeats: options.expectedSeats?.[i] ?? null,
    actualSeats: options.actualSeats?.[j] ?? null,
    actualBeforeView: options.actualBeforeView?.[j] ?? false,
    expectedMemo: options.expectedMemo?.[i] ?? false,
    actualHold: options.actualHold?.[j] ?? Number.POSITIVE_INFINITY,
  });
  const ruleAt = (i: number, j: number): Delta | null => rules.find((r) => r.same(expected[i] as string, actual[j] as string, context(i, j))) ?? null;
  const equal = (i: number, j: number) => expected[i] === actual[j] || ruleAt(i, j) !== null;
  const n = expected.length;
  const m = actual.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const below = lcs[i + 1] as number[];
      row[j] = equal(i, j) ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: LineDiff = { lines: [], accounted: [] };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && equal(i, j)) {
      const e = expected[i] as string;
      const a = actual[j] as string;
      const rule = e === a ? null : ruleAt(i, j);
      if (rule) out.accounted.push({ rule, expected: e, actual: a });
      i++;
      j++;
    } else if (j < m && (i === n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      const a = actual[j] as string;
      const rule = rules.find((r) => r.extra?.(a) === true);
      if (rule) out.accounted.push({ rule, expected: "(nothing)", actual: a });
      else if (!actualOptional[j]) out.lines.push(`+ ${a}`);
      j++;
    } else {
      if (!expectedOptional[i]) out.lines.push(`- ${expected[i]}`);
      i++;
    }
  }
  return out;
}

export function lineDiff(expected: string[], actual: string[], expectedOptional: boolean[] = [], actualOptional: boolean[] = []): string[] {
  return lineDiffWith(expected, actual, { expectedOptional, actualOptional }).lines;
}

export type ViewDiff = { hunks: Hunk[]; accounted: Accounted[] };

/** the diff of a scenario's two views, with `deltas` forgiven where they hold */
export function diffViewsWith(expected: View, actual: View, options: { scenario?: string; deltas?: readonly Delta[] } = {}): ViewDiff {
  const out: ViewDiff = { hunks: [], accounted: [] };
  const count = Math.max(expected.steps.length, actual.steps.length);
  for (let step = 0; step < count; step++) {
    const want = expected.steps[step];
    const got = actual.steps[step];
    if (want?.label !== got?.label) {
      out.hunks.push({ step, label: want?.label ?? got?.label ?? "", channel: "board", lines: [`- step ${want?.label ?? "(none)"}`, `+ step ${got?.label ?? "(none)"}`] });
      continue;
    }
    if (!want || !got) continue;
    for (const channel of CHANNELS) {
      const rules = deltasFor(options.deltas ?? [], options.scenario ?? "", want.label, channel);
      const result =
        channel === "leds"
          ? lineDiffWith(want.leds, got.leds, {
              expectedOptional: want.ledsOptional,
              actualOptional: got.ledsOptional,
              rules,
              ...(want.ledsSeats ? { expectedSeats: want.ledsSeats } : {}),
              ...(got.ledsSeats ? { actualSeats: got.ledsSeats } : {}),
              ...(got.ledsBeforeView ? { actualBeforeView: got.ledsBeforeView } : {}),
              ...(want.ledsMemo ? { expectedMemo: want.ledsMemo } : {}),
              ...(got.ledsHold ? { actualHold: got.ledsHold } : {}),
            })
          : lineDiffWith(want[channel], got[channel], { rules });
      if (result.lines.length > 0) out.hunks.push({ step, label: want.label, channel, lines: result.lines });
      for (const a of result.accounted) out.accounted.push({ step, label: want.label, channel, rule: a.rule.id, source: a.rule.source, expected: a.expected, actual: a.actual });
    }
  }
  return out;
}

export function diffViews(expected: View, actual: View): Hunk[] {
  return diffViewsWith(expected, actual).hunks;
}

export function printHunks(hunks: Hunk[]): string {
  return hunks.map((h) => [`step ${h.step} · ${h.label} · ${h.channel}`, ...h.lines.map((l) => `  ${l}`)].join("\n")).join("\n");
}

/** the heading a forgiven line prints under: decision 79's own, or the rest of what v2 changed on purpose */
export function headingOf(source: string): string {
  return source === "decision 79" ? "accounted for by decision 79" : "accounted for by decisions 80 and 81, and telemetry fixes";
}

export function printAccounted(accounted: Accounted[]): string {
  return accounted.map((a) => [`step ${a.step} · ${a.label} · ${a.channel} · ${a.source}: ${a.rule}`, `  - ${a.expected}`, `  + ${a.actual}`].join("\n")).join("\n");
}
