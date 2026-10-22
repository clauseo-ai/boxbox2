/* the step groups (docs/thread.md, the step group): which rows fold into a run and which stand alone, the line and the clock a
   group says, where a turn's last rows go, the strip's geometry, and that a group whose rows did not change is the object it was */

import { describe, expect, test } from "bun:test";
import { type Group, type Segment, currentOf, foldedOf, groupLabel, groupLine, groupOf, groupTook, groupsOf, lineShown, nearestMark, orderedStrip, segmentsOf, stripMap, stripShapes } from "./groups";
import { ledgerOf } from "./ledger";
import type { Arrival, ArrivalKind, Family, Item, Say, Step, Think, Turn } from "./model";
import type { RowCtx } from "./rows";
import { mailsOf } from "./rows";

const T0 = 1_790_000_000_000;
let next = 0;
const step = (family: Family, extra: Partial<Step> = {}): Step => {
  next++;
  return { k: "step", id: `prt_s${next}`, callID: `call_${next}`, family, tool: family === "shell" ? "shell" : family === "edit" ? "edit" : family === "search" ? "grep" : family, status: "completed", object: family === "shell" ? "bun test" : `src/file${next}.ts`, result: "", add: 0, del: 0, ms: 500, at: T0 + next * 1000, ...extra };
};
const think = (text = "the plan is to read the file first.", extra: Partial<Think> = {}): Think => { next++; return { k: "think", id: `prt_t${next}`, text, ms: 2000, at: T0 + next * 1000, streaming: false, ...extra }; };
const say = (text = "here is what i found.", extra: Partial<Say> = {}): Say => { next++; return { k: "say", id: `prt_w${next}`, text, at: T0 + next * 1000, streaming: false, ...extra }; };
const arrive = (kind: ArrivalKind, text: string, extra: Partial<Arrival> = {}): Arrival => { next++; return { k: "arrive", id: `msg_a${next}`, kind, text, at: T0 + next * 1000, ...(kind === "report" || kind === "note" ? { from: "r2", fromID: "ses_r2" } : {}), ...extra }; };
const turn = (items: Item[], extra: Partial<Turn> = {}): Turn => ({ id: "msg_1", by: "you", prompt: "go", at: T0, end: T0 + 600_000, items, status: "done", cost: 0, files: new Map(), compacted: false, unknownParts: 0, ...extra });
const ctxOf = (t: Turn, now?: number): RowCtx => ({ reports: ([t]).flatMap(mailsOf), children: new Map(), thinking: "rows", ...(now !== undefined ? { now } : {}) });

/** a settled turn's places, as its view reads them: the ledger's entries grouped, the answer told */
function places(t: Turn, running = false, now?: number): Segment[] {
  const ctx = ctxOf(t, now);
  return segmentsOf(ledgerOf()(t, ctx, running), { running, ctx, answer: t.answer });
}
const shape = (segs: readonly Segment[]): string[] => segs.map((s) => (s.k === "group" ? `group(${s.group.entries.length})` : s.entry.say ? "say" : (s.entry.model?.kind ?? "?")));
const groupIn = (segs: readonly Segment[], at = 0): Group => { const g = segs.filter((s) => s.k === "group")[at]; if (g?.k !== "group") throw new Error("no group"); return g.group; };

describe("which rows fold", () => {
  test("a run of steps between two of the agent's texts is one group; the words stand alone", () => {
    const t = turn([step("read"), step("shell"), say(), step("edit"), step("shell")]);
    expect(shape(places(t))).toEqual(["group(2)", "say", "group(2)", "files"]);
  });

  test("thinking folds into the group, the thought that led to words included", () => {
    const t = turn([think(), step("read"), think(), say()]);
    expect(shape(places(t))).toEqual(["group(3)", "say"]);
  });

  test("a stretch of thinking alone between two texts keeps its thought row, not a group of one", () => {
    const t = turn([say("first."), think(), think("then this."), say()]);
    expect(shape(places(t))).toEqual(["say", "thought", "say"]);
  });

  test("a thought before the settled answer folds into the run before it; the turn's last rows come after the group", () => {
    const edit = step("edit", { diff: "+a", add: 1, tool: "edit" });
    const t = { ...turn([step("read"), edit, think()]), answer: say("done.") };
    expect(shape(places(t))).toEqual(["group(3)", "files"]);
  });

  test("a lone thought before the settled answer stands above it, and the turn's last rows go above that thought", () => {
    const edit = step("edit", { diff: "+a", add: 1, tool: "edit" });
    const t = { ...turn([step("read"), edit, say("so."), think()]), answer: say("done.") };
    expect(shape(places(t))).toEqual(["group(2)", "say", "files", "thought"]);
  });

  test("what arrived folds into the stretch it came in: a wake, a wait, a report, a wait, a job and three commands are one group", () => {
    const t = turn([
      step("wait"),
      arrive("report", "agent /root/r2 reached status: parked\n\nready: the corpus is in"),
      step("wait"),
      arrive("job", "job job_1: exited with code 0; no output\n(started by you: bun test)"),
      step("shell"), step("shell"), step("shell"),
      say("all three passed."),
    ]);
    const segs = places(t);
    expect(shape(segs)).toEqual(["group(7)", "say"]);
    const g = groupIn(segs);
    expect(g.steps).toBe(5);
    expect(g.arrivals).toEqual([{ verb: "report", n: 1 }, { verb: "job", n: 1 }]);
    expect(groupLine(g).text).toBe("5 steps · ran 3, waited 2 · 1 report, 1 job");
  });

  test("the person stopping the turn folds into its last group as that group's last row, and the line says so", () => {
    const t = turn([step("read"), step("shell")], { status: "aborted", end: T0 + 600_000 + next * 1000 });
    const segs = places(t);
    expect(shape(segs)).toEqual(["group(3)"]);
    const g = groupIn(segs);
    expect(g.stopped).toBe(true);
    expect(g.entries.at(-1)?.model?.kind).toBe("stopped");
    expect(foldedOf(g).at(-1)?.model?.kind).toBe("stopped");
    expect(groupLine(g)).toMatchObject({ rest: "2 steps · read 1, ran 1", stopped: "stopped", text: "2 steps · read 1, ran 1 · stopped" });
    // the run lasted until the person stopped it: its clock runs to the turn's end
    expect(g.end).toBe(t.end);
    expect(groupLabel(g)).toBe("2 steps, read 1, ran 1, stopped, 10 min");
  });

  test("a stop after the agent's words has no group to go into: it stands, and a failure always stands", () => {
    expect(shape(places(turn([step("read"), say("so.")], { status: "aborted" })))).toEqual(["group(1)", "say", "stopped"]);
    expect(shape(places(turn([step("read")], { status: "failed", error: "boom" })))).toEqual(["group(1)", "failed"]);
  });

  test("asks and permission prompts never fold, so a run breaks around them", () => {
    const t = turn([step("read"), step("ask", { questions: [] }), step("shell", { permission: { id: "per_1", permission: "bash", patterns: ["bun test"] } }), step("read")]);
    expect(shape(places(t))).toEqual(["group(1)", "ask", "run", "group(1)"]);
  });

  test("a pending ask from the fleet's list stands alone too", () => {
    const asking = step("shell");
    const t = turn([step("read"), asking]);
    const ctx: RowCtx = { ...ctxOf(t), asks: new Map([[asking.callID, { id: "per_2", kind: "permission", permission: null, questions: null }]]) };
    expect(shape(segmentsOf(ledgerOf()(t, ctx), { running: false, ctx }))).toEqual(["group(1)", "run"]);
  });
});

describe("a group's words", () => {
  test("settled: the steps, the top three verbs most first, ties in the order they came, the rest as more, and the time it took", () => {
    const steps = [step("read"), step("read"), step("read"), step("shell"), step("shell"), step("edit"), step("search"), step("web")];
    const g = groupIn(places(turn(steps)));
    expect(groupLine(g).text).toBe("8 steps · read 3, ran 2, edited 1, 2 more");
    expect(groupTook(g)).toBe("8 s");
    expect(groupLabel(g)).toBe("8 steps, read 3, ran 2, edited 1, 2 more, 8 s");
  });

  test("what arrived is counted apart from the steps, after the verbs, each the top two and the rest as more", () => {
    const g = groupIn(places(turn([
      step("wait"), arrive("report", "ready: one"), step("wait"), arrive("report", "ready: two"), step("wait"),
      arrive("report", "agent /root/r2 reached status: parked"), arrive("job", "job job_1: exited with code 0; no output\n(started by you: ls)"),
      step("shell"), step("agents"),
    ])));
    expect(g.arrivals).toEqual([{ verb: "report", n: 2 }, { verb: "status", n: 1 }, { verb: "job", n: 1 }]);
    expect(groupLine(g).text).toBe("5 steps · waited 3, ran 1, 1 more · 2 reports, 1 status, 1 more");
    expect(groupLabel(g)).toMatch(/^5 steps, waited 3, ran 1, 1 more, 2 reports, 1 status, 1 more, \d+ s$/);
    expect(g.strip.marks.filter((m) => m.kind === "arrival")).toHaveLength(4);
  });

  test("a run that is only arrivals says them alone, with no steps counted", () => {
    const g = groupIn(places(turn([arrive("note", "see the fixture"), arrive("system", "you stopped the turn.")])));
    expect(groupLine(g).text).toBe("1 note, 1 notice");
  });

  test("an arrival's strip mark lands on its row", () => {
    const a = arrive("job", "job job_9: exited with code 2; no output\n(started by you: false)");
    const g = groupIn(places(turn([step("wait"), a])));
    const mark = g.strip.marks.find((m) => m.kind === "arrival");
    expect(mark).toMatchObject({ row: `arrive:${a.id}`, part: a.id, bad: true });
    expect(g.entries.some((e) => e.key === mark?.row)).toBe(true);
  });

  test("a failure is counted and said last", () => {
    const g = groupIn(places(turn([step("shell", { status: "error", error: "exit 1", exit: 1 }), step("shell")])));
    expect(groupLine(g)).toMatchObject({ rest: "2 steps · ran 2", failed: "1 failed", text: "2 steps · ran 2 · 1 failed" });
    expect(g.strip.marks.filter((m) => m.bad)).toHaveLength(1);
  });

  test("a run under a second says no time", () => {
    const g = groupIn(places(turn([step("read", { ms: 100 })])));
    expect(groupTook(g)).toBeUndefined();
  });

  test("live: what the newest row is doing, then the steps, and no time in the name", () => {
    const running = step("shell", { status: "running", ms: 0, object: "bun test 2>&1" });
    const t = turn([step("read"), running], { status: "working" });
    const g = groupIn(places(t, true, running.at + 42_000));
    expect(g.live).toBe(true);
    expect(groupLine(g).text).toBe("running bun test · 2 steps");
    expect(groupLabel(g)).toBe("running bun test, 2 steps");
    expect(foldedOf(g)).toHaveLength(1);
    expect(currentOf(g)?.cur).toBe(true);
    expect(lineShown(g)).toBe(true);
  });

  test("a lone live thought has no line: it may lead to words and stand alone", () => {
    const t = turn([think("hmm", { streaming: true })], { status: "working" });
    const g = groupIn(places(t, true, T0 + 99_000));
    expect(lineShown(g)).toBe(false);
    expect(currentOf(g)?.model?.kind).toBe("thought");
  });

  test("once the agent writes again the run folds whole", () => {
    const t = turn([step("read"), step("shell")], { status: "working", answer: say("all green", { streaming: true }) });
    const segs = places(t, true, T0 + 60_000);
    expect(shape(segs)).toEqual(["group(2)", "say"]);
    expect(groupIn(segs).live).toBe(false);
  });
});

describe("the strip", () => {
  const g = (): Group => groupIn(places(turn([think(), step("read"), step("shell", { ms: 5000 }), step("edit"), step("spawn")])));

  test("settled: thinking spans on the track, a long command a bar, the rest ticks by kind, nothing live", () => {
    const shapes = stripShapes(g().strip);
    expect(shapes.thoughts).toHaveLength(1);
    expect(shapes.marks.map((m) => `${m.kind}${m.bar ? " bar" : ""}`)).toEqual(["read", "run bar", "edit", "spawn"]);
    expect(shapes.head).toBeUndefined();
    expect(shapes.wash).toBeUndefined();
    expect(shapes.tracks).toEqual([{ left: 0, width: 100 }]);
  });

  test("settled: a quiet stretch over three minutes is folded out and breaks the tracks", () => {
    const late = step("shell", { at: T0 + 30 * 60_000 });
    const strip = groupIn(places(turn([step("read"), late]))).strip;
    expect(strip.gaps).toHaveLength(1);
    expect(stripShapes(strip).tracks).toHaveLength(2);
    expect(stripMap(strip)(late.at)).toBeLessThan(100);
    expect(stripMap(strip)(late.at)).toBeGreaterThan(50);
  });

  test("live: the span runs ahead to a round one past now, the running step grows to the head", () => {
    const running = step("shell", { status: "running", ms: 0 });
    const strip = groupIn(places(turn([running], { status: "working", at: running.at }), true, running.at + 40_000)).strip;
    const shapes = stripShapes(strip, running.at + 40_000);
    // 40 s into the run: the span is a minute, so now sits two thirds of the way across
    expect(shapes.head).toBeCloseTo(66.67, 1);
    expect(shapes.wash).toBeCloseTo(66.67, 1);
    expect(shapes.marks[0]).toMatchObject({ bar: true, running: true });
    expect(shapes.marks[0]?.width).toBeCloseTo(66.67, 1);
  });

  test("a tap finds the nearest step and carries the row it sits in", () => {
    const group = g();
    const m = nearestMark(group.strip, 100);
    expect(m?.kind).toBe("spawn");
    expect(group.entries.some((e) => e.key === m?.row)).toBe(true);
  });

  test("in order (a home window): one mark per step evenly apart, the running one standing whole, no head", () => {
    const strip = orderedStrip([{ kind: "read", running: false, bad: false }, { kind: "run", running: true, bad: false }], true);
    const shapes = stripShapes(strip, T0);
    expect(shapes.marks.map((m) => m.left)).toEqual([25, 75]);
    expect(shapes.marks[1]).toMatchObject({ running: true, bar: false });
    expect(shapes.head).toBeUndefined();
  });

  test("a run with no steps of its own (a live thought) draws an empty strip", () => {
    const solo = groupOf([], false);
    expect(stripShapes(solo.strip).marks).toEqual([]);
  });
});

describe("remembering groups", () => {
  test("a group whose rows are the entries they were is the same object, so its view is handed nothing new", () => {
    const t = turn([step("read"), step("shell"), say()]);
    const ledger = ledgerOf();
    const group = groupsOf();
    const ctx = ctxOf(t);
    const a = group(ledger(t, ctx), { running: false, ctx });
    const b = group(ledger(t, ctx), { running: false, ctx });
    expect(b[0]).toBe(a[0] as Segment);
  });

  test("a group that gained a step is a new one, under the same key", () => {
    const first = step("read");
    const ledger = ledgerOf();
    const group = groupsOf();
    const t1 = turn([first, step("shell", { status: "running", ms: 0 })], { status: "working" });
    const a = group(ledger(t1, ctxOf(t1, T0 + 9000), true), { running: true, ctx: ctxOf(t1, T0 + 9000) });
    const t2 = turn([...t1.items, step("edit", { status: "running", ms: 0 })], { status: "working" });
    const b = group(ledger(t2, ctxOf(t2, T0 + 19_000), true), { running: true, ctx: ctxOf(t2, T0 + 19_000) });
    expect(b[0]).not.toBe(a[0] as Segment);
    expect(groupIn(b).key).toBe(groupIn(a).key);
  });
});
