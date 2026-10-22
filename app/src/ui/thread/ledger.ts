/* the rows of one turn as its views paint them (docs/thread.md, the ledger;
   live), remembered between passes. the running turn is a new object on
   every delta, but its items are not (model.ts keeps an unchanged part's
   item), so each row's model is rebuilt only when what it reads changed:
   its items, its pending ask, the clock while it runs, an agent's child and
   report. a row whose model is the one from last pass keeps its entry
   object, so the view's `Index` gives it nothing new and its dom is left
   alone. pure; no dom. */

import { type Say, type Step, type Turn, liveItemsOf, spawnsOf } from "./model";
import { type DiffLine, type Row, type RowCtx, type RowModel, clock, dur, endRows, isRunning, minuteOf, modelOf, reportFor, rowsOf } from "./rows";

/** one place in the ledger: a said row or a modelled row, with its clock where the minute changes and a quiet stretch before it.
    in a running turn the newest place is `cur`, and carries `live` when its row is writing something the reader can watch. `row` is
    the row it was made from, which the step groups count and draw (groups.ts); the turn's last rows (its files, how it ended) have
    none. a kept entry keeps the row it was made with, which holds the same items as this pass's when its model is the same */
export type Entry = { key: string; time: string; gap?: string; say?: Say; model?: RowModel; cur?: boolean; live?: Live; row?: Row };

/** what the newest row shows while it works: the thought being written, a command's output, an edit's diff */
export type Live = { text?: string; /** the thought is still being written: its caret shows, its words settle in */ streaming?: boolean; out?: string[]; diff?: DiffLine[] };

type Modelled = Exclude<Row, { k: "say" }>;

/** a row's identity across passes: the first item it holds, which a growing fold or run of thoughts keeps */
function rowKey(r: Modelled): string {
  if (r.k === "step") return `step:${r.step.id}`;
  if (r.k === "fold") return `fold:${r.steps[0]?.id ?? r.at}`;
  if (r.k === "arrive") return `arrive:${r.arrival.id}`;
  return `think:${r.thoughts[0]?.id ?? r.at}`;
}

/** everything a row's model reads (rows.ts, stepModel, foldModel, thinkModel): when each is the same object or value
    as last pass, the model would come out the same */
function inputsOf(r: Modelled, ctx: RowCtx): unknown[] {
  if (r.k === "fold") return r.steps;
  /* an arrival's row reads its item alone, which a rebuild keeps while its message says the same (model.ts, arrivalIn) */
  if (r.k === "arrive") return [r.arrival];
  if (r.k === "think") return [...r.thoughts, ctx.thinking, r.thoughts.at(-1)?.streaming ? ctx.now : undefined];
  const s: Step = r.step;
  const spawn = s.family === "spawn";
  const child = spawn && s.agent?.child ? ctx.children.get(s.agent.child) : undefined;
  // an agent row's clock runs while its child works, after the turn itself ended too (ctx.tick)
  return [s, ctx.asks?.get(s.callID), ctx.replies?.get(s.callID), isRunning(s) || spawn ? ctx.now : undefined, spawn ? ctx.tick : undefined, child, spawn ? reportFor(ctx, s) : undefined];
}

const same = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** the row models of one view, by row: a model is rebuilt only when its inputs changed. each pass drops the rows it
    did not see, so it holds one turn's rows at most */
function rowModels(): { pass(): (r: Modelled, ctx: RowCtx) => RowModel; sweep(): void } {
  const held = new Map<string, { inputs: unknown[]; model: RowModel }>();
  let seen = new Set<string>();
  return {
    pass() {
      seen = new Set();
      return (r, ctx) => {
        const key = rowKey(r);
        seen.add(key);
        const inputs = inputsOf(r, ctx);
        const was = held.get(key);
        if (was && same(was.inputs, inputs)) return was.model;
        const model = modelOf(r, ctx);
        held.set(key, { inputs, model });
        return model;
      };
    },
    sweep() {
      for (const key of held.keys()) if (!seen.has(key)) held.delete(key);
    },
  };
}

/** last pass's entry when every field is the same, so an unchanged place hands its view the same object */
function keep<T extends { key: string }>(held: Map<string, T>, next: Map<string, T>, fresh: T, equal: (a: T, b: T) => boolean): T {
  const was = held.get(fresh.key);
  const entry = was && equal(was, fresh) ? was : fresh;
  next.set(fresh.key, entry);
  return entry;
}

/** what a turn's last rows read (rows.ts, endRows and filesOf): its edits, its span and how it ended */
const endInputsOf = (t: Turn): unknown[] => [t.id, t.at, t.end, t.status, t.error, ...t.items.filter((x) => x.k === "step" && x.family === "edit")];

const sameLive = (a: Live | undefined, b: Live | undefined): boolean => a === b || (a !== undefined && b !== undefined && a.text === b.text && a.streaming === b.streaming && a.out === b.out && a.diff === b.diff);
const sameEntry = (a: Entry, b: Entry): boolean => a.time === b.time && a.gap === b.gap && a.say === b.say && a.model === b.model && a.cur === b.cur && sameLive(a.live, b.live);

const NO_LINES: DiffLine[] = [];

/** what the newest row of a running turn is writing, if it is writing something */
function liveOf(r: Row, m: RowModel | undefined): Live | undefined {
  if (r.k === "think") { const last = r.thoughts[r.thoughts.length - 1]; return { text: last?.text ?? "", streaming: last?.streaming === true }; }
  if (r.k !== "step") return undefined;
  if (r.step.family === "shell" && (r.step.status === "running" || r.step.output)) return { out: r.step.output?.lines ?? [" "] };
  if (r.step.family === "edit" && r.step.diff !== undefined) return { diff: (m?.body?.k === "diff" ? m.body.lines : undefined) ?? NO_LINES };
  return undefined;
}

/** the ledger of a turn: its rows with their clocks, quiet stretches marked, and, once it has settled, its last rows
    (the files it changed, how it ended). a running turn is the same ledger growing at its end: every row it has so far,
    its reply as the newest said row (the model calls it the answer once settled), the newest row marked `cur` with what
    it is writing. returns a function for one view to call on every pass */
export type Ledgerer = (t: Turn, ctx: RowCtx, running?: boolean) => Entry[];

export function ledgerOf(): Ledgerer {
  const models = rowModels();
  let entries = new Map<string, Entry>();
  let ends: { inputs: unknown[]; rows: RowModel[] } | undefined;
  return (t, ctx, running = false) => {
    const model = models.pass();
    const next = new Map<string, Entry>();
    const out: Entry[] = [];
    let lastMin: number | null = null;
    let prevEnd = t.at;
    const rows = rowsOf(running ? liveItemsOf(t) : t.items);
    rows.forEach((r, i) => {
      const gap = r.at - prevEnd > 90_000 ? `${dur(r.at - prevEnd)} later` : undefined;
      const minute = minuteOf(r.at);
      const time = minute !== lastMin ? clock(r.at) : "";
      lastMin = minute;
      const cur = running && i === rows.length - 1;
      let fresh: Entry;
      if (r.k === "say") fresh = { key: `say:${r.say.id}`, time, ...(gap ? { gap } : {}), ...(cur ? { cur } : {}), say: r.say, row: r };
      else {
        const m = model(r, ctx);
        const live = cur ? liveOf(r, m) : undefined;
        fresh = { key: m.key, time, ...(gap ? { gap } : {}), ...(cur ? { cur } : {}), model: m, ...(live ? { live } : {}), row: r };
      }
      out.push(keep(entries, next, fresh, sameEntry));
      prevEnd = Math.max(prevEnd, r.end);
    });
    if (!running) {
      const endInputs = endInputsOf(t);
      if (!ends || !same(ends.inputs, endInputs)) ends = { inputs: endInputs, rows: endRows(t) };
      for (const m of ends.rows) out.push(keep(entries, next, { key: m.key, time: m.kind === "files" ? "" : clock(t.end), model: m }, sameEntry));
    }
    models.sweep();
    entries = next;
    return out;
  };
}

/** whether a turn would paint the same under `b` as under `a`: the turn reads the clock, the thinking setting, the asks on
    its own steps and this device's replies to them, and for each of its agents the child and its report (rows.ts, reportFor), and nothing else of the context. the stage hands every
    turn one context memo with this as its equality, so a delta, an ask or a child changing elsewhere wakes only the turns
    that read it (docs/thread.md, the stage as built) */
export function sameCtxFor(turn: Turn, a: RowCtx, b: RowCtx): boolean {
  if (a === b) return true;
  if (a.thinking !== b.thinking || a.now !== b.now || a.tick !== b.tick) return false;
  if (a.asks !== b.asks) {
    /* only the asks that came or went or changed can matter, and a turn reads them by the call ids of its steps (a set read once per turn) */
    const calls = callsOf(turn);
    for (const [call, ask] of a.asks ?? []) if (calls.has(call) && b.asks?.get(call) !== ask) return false;
    for (const [call, ask] of b.asks ?? []) if (calls.has(call) && a.asks?.get(call) !== ask) return false;
  }
  if (a.replies !== b.replies) {
    const calls = callsOf(turn);
    for (const [call, r] of a.replies ?? []) if (calls.has(call) && b.replies?.get(call) !== r) return false;
    for (const [call, r] of b.replies ?? []) if (calls.has(call) && a.replies?.get(call) !== r) return false;
  }
  const kids = a.children !== b.children, reports = a.reports !== b.reports;
  if (kids || reports) {
    for (const s of spawnsOf(turn)) {
      const child = s.agent?.child;
      if (kids && child && a.children.get(child) !== b.children.get(child)) return false;
      if (reports && reportFor(a, s) !== reportFor(b, s)) return false;
    }
  }
  return true;
}

/* the call ids of a turn's steps, by turn object: read once for a turn that did not change */
const callSets = new WeakMap<Turn, ReadonlySet<string>>();
function callsOf(turn: Turn): ReadonlySet<string> {
  let found = callSets.get(turn);
  if (!found) { found = new Set(turn.items.flatMap((it) => (it.k === "step" ? [it.callID] : []))); callSets.set(turn, found); }
  return found;
}

/* ---------- names ---------- */

const NTH = ["", "", "again", "third time", "fourth time", "fifth time", "sixth time", "seventh time", "eighth time", "ninth time", "tenth time"];

/** 11th, 21st, 22nd, 113th */
const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
};

/** a row's name the nth time the page shows it (docs/thread.md, accessibility): its label the first time, then
    "read notes.md, 3 lines, again", then "read notes.md, 3 lines, third time" and on, so no two controls share a name */
export function nthName(label: string, nth: number): string {
  if (nth <= 1) return label;
  return `${label}, ${NTH[nth] ?? `${ordinal(nth)} time`}`;
}

/** adds how many times each label comes up to `counts`; a place that is not a control (undefined) counts for nothing */
export function tally(labels: ReadonlyArray<string | undefined>, counts: Map<string, number>): void {
  for (const label of labels) if (label !== undefined) counts.set(label, (counts.get(label) ?? 0) + 1);
}

/** the names of one turn's controls, place for place: each label told apart from the times `before` says the rows
    above it on the page already carried it, and from its namesakes earlier in the turn */
export function namesOf(labels: ReadonlyArray<string | undefined>, before: ReadonlyMap<string, number>): Array<string | undefined> {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    if (label === undefined) return undefined;
    const inTurn = (seen.get(label) ?? 0) + 1;
    seen.set(label, inTurn);
    return nthName(label, (before.get(label) ?? 0) + inTurn);
  });
}
