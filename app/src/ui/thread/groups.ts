/* a turn read as text (docs/thread.md, the step group): the agent's words
   stay in the thread, and every run of steps between two of them (tool calls
   and the thinking that led to the next call) folds into one group, which is
   that run's timeline. thinking that led to words sits above them as its own
   "thought for" row; asks and permission prompts never fold. while a run is
   live its newest row shows under its group, open. the strip is the run's
   steps and thinking in time, drawn the same in a group and on a home window
   (which knows its steps only by their order). pure; no dom. */

import type { Family, Say, Step } from "./model";
import type { Entry } from "./ledger";
import { type Row, type RowCtx, clockDur, dur, isBad, isRunning, plural } from "./rows";
import { A_SCRIPT } from "./script";
import { base, shortCommand } from "./shell";

/* ---------- the strip ---------- */

export type StripKind = "read" | "search" | "edit" | "run" | "web" | "spawn" | "ask" | "other";
const KIND: Partial<Record<Family, StripKind>> = { read: "read", search: "search", edit: "edit", shell: "run", web: "web", spawn: "spawn", ask: "ask" };
export const stripKind = (s: Pick<Step, "family" | "script">): StripKind => KIND[s.family] ?? (s.script ? "run" : "other");

/** one step on a strip: its kind and time, and where a tap on it lands (the row it sits in, and its part) */
export type StripMark = { kind: StripKind; at: number; ms: number; running: boolean; bad: boolean; row: string; part: string };
export type StripThought = { at: number; ms: number; streaming: boolean };
/** what a strip draws: its steps and thinking over time, or in order (a home window, whose tail carries no clock) */
export type Strip = {
  start: number;
  end: number;
  live: boolean;
  /** the marks stand evenly apart by their order, not their time */
  ordered: boolean;
  /** quiet stretches folded out of a settled strip, each [from, to] */
  gaps: ReadonlyArray<readonly [number, number]>;
  thoughts: readonly StripThought[];
  marks: readonly StripMark[];
};

/** live, the span runs ahead to the next of these past the elapsed time, so marks hold still for a while */
export const STRIP_RANGES: readonly number[] = [0.5, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240].map((m) => m * 60_000);
/** a command at least this long draws as a bar */
export const BAR_FROM = 1200;

const timed = (s: Strip): boolean => s.live && !s.ordered;

/** a moment to a place on the strip, in percent: settled, the run's own span with its quiet stretches folded; live, the next round
    span past now, so the head travels across it */
export function stripMap(s: Strip, now?: number): (time: number) => number {
  const clamp = (x: number): number => Math.max(0, Math.min(100, x));
  if (timed(s)) {
    const elapsed = Math.max(0, (now ?? s.end) - s.start);
    const span = Math.max(1, STRIP_RANGES.find((r) => r >= elapsed * 1.08) ?? elapsed * 1.2);
    return (t) => clamp(((t - s.start) / span) * 100);
  }
  const folded = s.gaps.reduce((a, [x, y]) => a + (y - x), 0);
  const span = Math.max(1, s.end - s.start - folded);
  return (t) => {
    let off = t - s.start;
    for (const [a, b] of s.gaps) { if (t > b) off -= b - a; else if (t > a) off -= t - a; }
    return clamp((off / span) * 100);
  };
}

/** the clock a live group shows: from the run's start to now, never below zero and never past a day (a clock that reads further is
    reading a moment from another clock, and says nothing) */
export const elapsed = (from: number, to: number): number => { const ms = to - from; return ms < 0 || ms > 86_400_000 ? 0 : ms; };

/** a strip of steps known only by their order (a home window's tail): one mark per step, evenly apart */
export function orderedStrip(kinds: ReadonlyArray<{ kind: StripKind; running: boolean; bad: boolean }>, live: boolean): Strip {
  return {
    start: 0, end: Math.max(1, kinds.length) * 1000, live, ordered: true, gaps: [], thoughts: [],
    marks: kinds.map((k, i) => ({ kind: k.kind, at: i * 1000 + 500, ms: 0, running: k.running, bad: k.bad, row: "", part: "" })),
  };
}

/** the mark nearest a place on the strip (percent), placed by the map the strip draws with */
export function nearestMark(s: Strip, pct: number, now?: number): StripMark | undefined {
  const x = stripMap(s, now);
  let best: StripMark | undefined, d = Infinity;
  for (const m of s.marks) { const dd = Math.abs(x(m.at) - pct); if (dd < d) { d = dd; best = m; } }
  return best;
}

/** how a mark is drawn: `bar` stretches to `width` (percent); the rest are ticks the stylesheet sizes by kind */
export type MarkShape = { left: number; width?: number; kind: StripKind; running: boolean; bad: boolean; bar: boolean };
export type StripShapes = {
  /** the stretches of the tracks between the folded quiet stretches, in percent */
  tracks: Array<{ left: number; width: number }>;
  /** live, the time gone so far is washed in the light tone, to here */
  wash?: number;
  thoughts: Array<{ left: number; width: number }>;
  marks: MarkShape[];
  /** live, now */
  head?: number;
};

/** a strip's geometry at a moment, in percent of its width: what the view draws, in one pass */
export function stripShapes(s: Strip, now?: number): StripShapes {
  const x = stripMap(s, now);
  const clock = timed(s) ? now : undefined;
  const head = clock !== undefined ? x(clock) : undefined;
  const breaks = !s.ordered && !s.live ? s.gaps.map(([a]) => x(a)).sort((a, b) => a - b) : [];
  const tracks: StripShapes["tracks"] = [];
  let from = 0;
  for (const b of breaks) { if (b > from) tracks.push({ left: from, width: b - from }); from = Math.max(from, b); }
  if (from < 100) tracks.push({ left: from, width: 100 - from });
  const thoughts = s.thoughts.flatMap((t) => {
    const until = t.streaming ? Math.max(t.at + t.ms, clock ?? t.at + t.ms) : t.at + t.ms;
    if (until <= t.at) return [];
    const left = x(t.at);
    return [{ left, width: Math.max(0, x(until) - left) }];
  });
  const marks = s.marks.map((m): MarkShape => {
    const left = x(m.at);
    const grows = m.running && clock !== undefined;
    const long = !m.running && !s.ordered && m.kind === "run" && m.ms >= BAR_FROM;
    if (grows || long) return { left, width: Math.max(0, x(grows ? Math.max(clock ?? m.at, m.at) : m.at + m.ms) - left), kind: m.kind, running: m.running, bad: m.bad, bar: true };
    return { left, kind: m.kind, running: m.running, bad: m.bad, bar: false };
  });
  return { tracks, ...(head !== undefined && head > 0 ? { wash: head } : {}), thoughts, marks, ...(head !== undefined ? { head } : {}) };
}

/* ---------- the group ---------- */

export type Tally = { verb: string; n: number };

/** one run of a turn's steps, folded into one row */
export type Group = {
  /** its own key, for its open state: "group:" and its first row's key */
  key: string;
  /** every row of the run, in order (the newest is the live one while the run is live) */
  entries: readonly Entry[];
  /** the run is the turn's newest work, still going */
  live: boolean;
  at: number;
  end: number;
  /** the clock where the minute changes, else "" (its first row's) */
  time: string;
  /** a quiet stretch before the run (its first row's "3 min later") */
  gap?: string;
  /** tool calls in the run: a folded read of three files is three */
  steps: number;
  failed: number;
  /** how many of each verb, most first, ties in the order they came */
  tally: readonly Tally[];
  /** while live, what the newest row is doing ("running bun test"); settled, none */
  doing?: string;
  strip: Strip;
};

export type Segment = { k: "entry"; entry: Entry } | { k: "group"; group: Group };

/** the rows folded into the group: all of them, or all but the live one */
export const foldedOf = (g: Group): readonly Entry[] => (g.live ? g.entries.slice(0, -1) : g.entries);
/** the live row under the group */
export const currentOf = (g: Group): Entry | undefined => (g.live ? g.entries.at(-1) : undefined);
/** a ledger place that is a tool's step: not words, not a thought */
const isStep = (e: Entry): boolean => e.say === undefined && e.model !== undefined && e.model.kind !== "thought";
/** the line shows once something folded into it, or from the start of a live run whose live row is a step. a lone live thought has
    none: it may lead to words and stand alone, and a line that came and went would move the row the reader watches */
export const lineShown = (g: Group): boolean => foldedOf(g).length > 0 || (currentOf(g) !== undefined && isStep(currentOf(g) as Entry));

/** the verb a step is counted under in a group's line */
export function verbOf(family: Family): string {
  switch (family) {
    case "read": return "read";
    case "search": return "searched";
    case "edit": return "edited";
    case "shell": return "ran";
    case "web": return "fetched";
    case "spawn": return "started";
    case "message": return "messaged";
    case "wait": return "waited";
    case "agents": return "checked";
    case "ask": return "asked";
    case "plan": return "planned";
    case "skill": return "loaded";
    case "other": return "used";
  }
}

const short = (s: string): string => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

/** what the live row is doing, in a few words: "running bun test", "reading rows.ts", "thinking" */
export function doingOf(row: Row): string {
  if (row.k === "say") return "writing";
  if (row.k === "think") return "thinking";
  if (row.k === "fold") return row.family === "read" ? `read ${plural(row.steps.length, "file")}` : `${verbOf(row.family)} ${row.steps.length}`;
  const s = row.step;
  /* a script is named by what it does (script.ts): its own words stand as the doing, else "running a script" */
  if (s.script) return s.object === A_SCRIPT ? `${isRunning(s) ? "running" : "ran"} ${A_SCRIPT}` : short(s.object);
  const object = short(s.family === "read" || s.family === "edit" ? base(s.object) : s.family === "shell" ? shortCommand(s.object) : s.object.split("\n")[0] ?? "");
  const going = isRunning(s);
  const verbs: Partial<Record<Family, [string, string]>> = { read: ["reading", "read"], search: ["searching", "searched"], edit: ["editing", "edited"], shell: ["running", "ran"], web: ["fetching", "fetched"], spawn: ["starting", "started"], message: ["messaging", "messaged"], wait: ["waiting", "waited"] };
  const [now, past] = verbs[s.family] ?? ["running", "ran"];
  const verb = going ? now : past;
  return object ? `${verb} ${object}` : verb;
}

/** a group's line in its parts: what the live row is doing (full ink), the counts, the failures (red). `text` is the whole line,
    "6 steps · read 3, ran 2, edited 1", live "running bun test · 4 steps" */
export function groupLine(g: Group): { doing?: string; rest: string; failed?: string; text: string } {
  const parts: string[] = [plural(g.steps, "step")];
  if (g.doing === undefined && g.tally.length) {
    const shown = g.tally.slice(0, 3).map((t) => `${t.verb} ${t.n}`);
    const more = g.tally.slice(3).reduce((a, t) => a + t.n, 0);
    parts.push([...shown, ...(more > 0 ? [`${more} more`] : [])].join(", "));
  }
  const rest = parts.join(" · ");
  const failed = g.failed > 0 ? `${g.failed} failed` : undefined;
  const text = [g.doing, rest, failed].filter((x): x is string => x !== undefined).join(" · ");
  return { ...(g.doing !== undefined ? { doing: g.doing } : {}), rest, ...(failed ? { failed } : {}), text };
}

/** a settled group's clock: how long the run took, "1 min"; nothing under a second */
export const groupTook = (g: Group): string | undefined => (g.end - g.at >= 1000 ? dur(g.end - g.at) : undefined);
/** the clock a group shows at a moment: live, the run's clock from its first step; settled, how long it took */
export const groupClock = (g: Group, now?: number): string | undefined => (g.live && now !== undefined ? clockDur(elapsed(g.at, now)) : groupTook(g));
/** the group's name, its line with the separators read as pauses, and how long a settled run took (a live clock is left out, so the
    name does not change every second) */
export const groupLabel = (g: Group): string => { const words = groupLine(g).text.replaceAll(" · ", ", "); const took = g.live ? undefined : groupTook(g); return took ? `${words}, ${took}` : words; };

/* ---------- which rows fold ---------- */

/** a step a group never hides: a question, or a call that waits on the person's permission */
export const standsAlone = (s: Step, ctx: Pick<RowCtx, "asks">): boolean => s.family === "ask" || s.permission !== undefined || s.question !== undefined || ctx.asks?.get(s.callID) !== undefined;

/** a row folds into a run unless it stands on its own: the agent's words; a thought that led to words, to an ask or to the end of a
    settled turn; an ask or a permission. the thinking a running turn is doing now folds: what it leads to is not known yet */
export function inRun(row: Row, next: Row | undefined, last: boolean, running: boolean, ctx: Pick<RowCtx, "asks">): boolean {
  switch (row.k) {
    case "say": return false;
    case "fold": return true;
    case "step": return !standsAlone(row.step, ctx);
    case "think":
      if (!next) return last && running;
      if (next.k === "say" || next.k === "think") return false;
      if (next.k === "fold") return true;
      return !standsAlone(next.step, ctx);
  }
}

/** the quiet stretches over three minutes inside a run, folded down to twenty seconds each side */
function gapsOf(rows: readonly Row[], start: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = start;
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    if (r.at - cursor > 180_000) gaps.push([cursor + 20_000, r.at - 20_000]);
    cursor = Math.max(cursor, r.end);
  }
  return gaps;
}

/** a run's group: its counts, its words, its strip */
export function groupOf(run: ReadonlyArray<{ row: Row; entry: Entry }>, live: boolean): Group {
  const first = run[0];
  const at = first?.row.at ?? 0;
  const end = run.reduce((a, p) => Math.max(a, p.row.end), at);
  let steps = 0, failed = 0;
  const order: string[] = [];
  const counts = new Map<string, number>();
  const thoughts: StripThought[] = [];
  const marks: StripMark[] = [];
  const count = (s: Step, row: string) => {
    steps++;
    const bad = isBad(s);
    if (bad) failed++;
    const verb = s.script ? "ran" : verbOf(s.family);
    if (!counts.has(verb)) order.push(verb);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
    marks.push({ kind: stripKind(s), at: s.at, ms: s.ms, running: isRunning(s), bad, row, part: s.id });
  };
  for (const { row, entry } of run) {
    if (row.k === "think") for (const t of row.thoughts) thoughts.push({ at: t.at, ms: t.ms, streaming: t.streaming });
    else if (row.k === "fold") for (const s of row.steps) count(s, entry.key);
    else if (row.k === "step") count(row.step, entry.key);
  }
  const tally = order.map((verb, i) => ({ i, t: { verb, n: counts.get(verb) ?? 0 } })).sort((a, b) => (a.t.n !== b.t.n ? b.t.n - a.t.n : a.i - b.i)).map((x) => x.t);
  const last = run.at(-1);
  const doing = live && last ? doingOf(last.row) : undefined;
  const firstKey = first?.entry.key ?? "";
  return {
    key: `group:${firstKey}`, entries: run.map((p) => p.entry), live, at, end, time: first?.entry.time ?? "",
    ...(first?.entry.gap ? { gap: first.entry.gap } : {}), steps, failed, tally, ...(doing !== undefined ? { doing } : {}),
    strip: { start: at, end: Math.max(end, at + 1000), live, ordered: false, gaps: gapsOf(run.map((p) => p.row), at), thoughts, marks },
  };
}

/** a turn's places, in order: entries that stand alone and groups of the runs between them. `entries` are the ledger's (ledger.ts):
    the rows it made, each with the row it was made from, then the turn's last rows (its files, how it ended), which have none. a
    settled turn's answer is not among them (the turn paints it), but a thought before it is a thought that led to words, so it is
    told: and the last rows go above that thought, which stays directly above the words it led to */
export function segmentsOf(entries: readonly Entry[], opts: { running: boolean; ctx: Pick<RowCtx, "asks">; answer?: Say | undefined }): Segment[] {
  const placed = entries.filter((e): e is Entry & { row: Row } => e.row !== undefined);
  const ends = entries.filter((e) => e.row === undefined);
  const after: Row | undefined = opts.answer && !opts.running ? { k: "say", at: opts.answer.at, end: opts.answer.at, say: opts.answer } : undefined;
  const out: Segment[] = [];
  let run: Array<{ row: Row; entry: Entry }> = [];
  const close = (live: boolean) => { if (run.length) out.push({ k: "group", group: groupOf(run, live) }); run = []; };
  placed.forEach((e, i) => {
    const last = i === placed.length - 1;
    const next = last ? after : placed[i + 1]?.row;
    if (inRun(e.row, next, last, opts.running, opts.ctx)) run.push({ row: e.row, entry: e });
    else { close(false); out.push({ k: "entry", entry: e }); }
  });
  close(opts.running);
  if (!opts.running && ends.length) {
    const tail = out.at(-1);
    const thoughtLast = after !== undefined && tail?.k === "entry" && tail.entry.model?.kind === "thought";
    out.splice(thoughtLast ? out.length - 1 : out.length, 0, ...ends.map((entry): Segment => ({ k: "entry", entry })));
  }
  return out;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** the segments of one view, remembered between passes: a group whose rows are the same entries as last pass (ledger.ts keeps an
    unchanged row's entry) is the same object, and so is its segment, so its view is handed nothing new */
export function groupsOf(): (entries: readonly Entry[], opts: Parameters<typeof segmentsOf>[1]) => Segment[] {
  let held = new Map<string, Segment>();
  return (entries, opts) => {
    const next = new Map<string, Segment>();
    const out = segmentsOf(entries, opts).map((seg) => {
      if (seg.k === "entry") return seg;
      const was = held.get(seg.group.key);
      const keep = was?.k === "group" && was.group.live === seg.group.live && was.group.gap === seg.group.gap && was.group.time === seg.group.time && sameList(was.group.entries, seg.group.entries) ? was : seg;
      next.set(seg.group.key, keep);
      return keep;
    });
    held = next;
    return out;
  };
}
