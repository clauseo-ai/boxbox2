/* decision 79's allowed deltas: each rule forgives exactly the change it
   names, in the steps it names, and nothing next to it. the diff prints
   what it forgave on its own. */

import { describe, expect, test } from "bun:test";
import { BEYOND_79, type Channel, DECISION_79, deltasFor, HOLD_SLACK_MS, permuteDigits, type LineContext, FLOOR_CELL, frameCells, KEY_CHANGES, V1_MARK_READ_CELL } from "../trace/deltas";
import { diffViewsWith, lineDiffWith } from "../trace/diff";
import type { StepView, View } from "../trace/normalize";
import { scenario } from "../trace/scenarios";

const hex = (n: number) => n.toString(16).padStart(2, "0");
/** a drive frame like the traces': nl, / lit for h1, * - dark, + the given cell */
function drive(plus: number, overrides: { [wire: number]: number } = {}): string {
  const cells = [0x1d, 0x79, 0x03, 0x03, 0x29, 0x29, 0x29, plus, 0x29, 0x29, 0x29, 0x29, 0x29, 0x29, 0x19, 0xfd, 0x83];
  for (const [wire, value] of Object.entries(overrides)) cells[Number(wire)] = value;
  return `frame ${cells.map(hex).join(" ")}`;
}

const same = (scenarioName: string, step: string, channel: Channel, e: string, a: string) => deltasFor(DECISION_79, scenarioName, step, channel).some((r) => r.same(e, a));

describe("plus is machine 4", () => {
  test("the mark-read light on + may be a machine light in the replay, in any scenario and step", () => {
    expect(same("permission-pit", "tap k1: into the pit", "leds", drive(V1_MARK_READ_CELL), drive(FLOOR_CELL))).toBe(true);
    expect(same("talk-key", "anything", "leds", drive(V1_MARK_READ_CELL), drive(0x79))).toBe(true);
  });

  test("but only on +, only from the mark-read light, and only to a machine's light", () => {
    /* another cell differs too */
    expect(same("talk-key", "s", "leds", drive(V1_MARK_READ_CELL), drive(FLOOR_CELL, { 11: 0x49 }))).toBe(false);
    /* + was not the mark-read light in the trace (the meter's column, a lap's sweep) */
    expect(same("talk-key", "s", "leds", drive(0x1f), drive(FLOOR_CELL))).toBe(false);
    /* + shows something no machine key shows */
    expect(same("talk-key", "s", "leds", drive(V1_MARK_READ_CELL), drive(0x49))).toBe(false);
    /* the mark-read light on . where v1's . was the floor, with + a machine light */
    expect(same("talk-key", "s", "leds", drive(V1_MARK_READ_CELL, { 16: FLOOR_CELL }), drive(FLOOR_CELL, { 16: V1_MARK_READ_CELL }))).toBe(true);
    /* but never over v1's more-pages hint on . */
    expect(same("talk-key", "s", "leds", drive(V1_MARK_READ_CELL, { 16: 0x83 }), drive(FLOOR_CELL, { 16: V1_MARK_READ_CELL }))).toBe(false);
    /* not a frame */
    expect(same("talk-key", "s", "leds", "global 255", "global 128")).toBe(false);
  });
});

describe("the fleet bank's fourth column", () => {
  const fleet = (overrides: { [wire: number]: number } = {}) => {
    const cells = Array<number>(17).fill(0x03);
    for (const [wire, value] of Object.entries(overrides)) cells[Number(wire)] = value;
    return `frame ${cells.map(hex).join(" ")}`;
  };

  test("the odometer's cells (- + ent) may differ in the fleet steps of thread switching", () => {
    expect(same("thread-switching", "tap nl: drive to fleet", "leds", fleet({ 14: 0x9b }), fleet({ 14: 0x7b, 7: 0x75 }))).toBe(true);
  });

  test("no other cell, and no other step", () => {
    expect(same("thread-switching", "tap nl: drive to fleet", "leds", fleet(), fleet({ 4: 0x75 }))).toBe(false);
    expect(same("thread-switching", "tap k1: focus alpha", "leds", fleet(), fleet({ 14: 0x75 }))).toBe(false);
    expect(same("talk-key", "tap nl: drive to fleet", "leds", fleet(), fleet({ 14: 0x75 }))).toBe(false);
  });
});

describe("mark read is a hold on dot", () => {
  const step = "tap plus: mark the top call read";

  test("the step presses dot for 600ms instead of tapping plus, and its label still names the scenario's step", () => {
    expect(KEY_CHANGES).toEqual([expect.objectContaining({ scenario: "thread-switching", step, gesture: { kind: "hold", key: "dot", ms: 600 } })]);
    expect(scenario("thread-switching").steps.map((s) => s.label)).toContain(step);
  });

  test("the board reports wire 16 where the trace has 7, down and up, in that step only", () => {
    expect(same("thread-switching", step, "board", "key 7 down", "key 16 down")).toBe(true);
    expect(same("thread-switching", step, "board", "key 7 up", "key 16 up")).toBe(true);
    expect(same("thread-switching", step, "board", "key 7 down", "key 16 up")).toBe(false);
    expect(same("thread-switching", "tap k1: focus alpha", "board", "key 7 down", "key 16 down")).toBe(false);
  });

  test("v1's tap on + is the hold on . in its board.key events, with the same bank and outcome", () => {
    const e = 'telemetry board.key {"bank":"drive","target":"copy","verb":"tap","wire":7} ok 1';
    const start = 'telemetry board.key {"bank":"drive","target":"read","verb":"holdStart","wire":16} ok 1';
    const end = 'telemetry board.key {"bank":"drive","target":"read","verb":"holdEnd","wire":16} ok 1';
    expect(same("thread-switching", step, "calls", e, start)).toBe(true);
    expect(same("thread-switching", step, "calls", e, start.replace("ok 1", "ok 0"))).toBe(false);
    expect(same("thread-switching", step, "calls", e, start.replace('"drive"', '"fleet"'))).toBe(false);
    expect(same("thread-switching", step, "calls", e, start.replace('"read"', '"focus"'))).toBe(false);
    expect(same("thread-switching", step, "calls", 'markRead {"session":"h1:<alpha>"} -> ok', 'markRead {"session":"h1:<bravo>"} -> ok')).toBe(false);
    /* the hold's other half has no trace line to pair with, and is accounted for, not silent */
    const { lines, accounted } = lineDiffWith([e], [start, end], { rules: deltasFor(DECISION_79, "thread-switching", step, "calls") });
    expect(lines).toEqual([]);
    expect(accounted.map((a) => a.expected)).toEqual([e, "(nothing)"]);
    const elsewhere = lineDiffWith([], [end], { rules: deltasFor(DECISION_79, "thread-switching", "tap k1: focus alpha", "calls") });
    expect(elsewhere.lines).toEqual([`+ ${end}`]);
  });
});

describe("the diff with decision 79", () => {
  const view = (steps: Partial<StepView>[]): View => ({
    keepaliveGapMs: 500,
    steps: steps.map((s, i) => ({ label: s.label ?? `step ${i}`, leds: s.leds ?? [], ledsOptional: s.ledsOptional ?? [], board: s.board ?? [], calls: s.calls ?? [], radio: s.radio ?? [] })),
  });

  test("prints what a rule forgave apart from what fails", () => {
    const expected = view([{ label: "tap k1: focus alpha", leds: [drive(V1_MARK_READ_CELL), drive(V1_MARK_READ_CELL, { 11: 0x1f })] }]);
    const actual = view([{ label: "tap k1: focus alpha", leds: [drive(FLOOR_CELL), drive(FLOOR_CELL, { 11: 0x2f })] }]);
    const { hunks, accounted } = diffViewsWith(expected, actual, { scenario: "thread-switching", deltas: DECISION_79 });
    expect(accounted).toEqual([
      expect.objectContaining({ step: 0, channel: "leds", rule: "plus is machine 4, and the mark-read light moves to dot", source: "decision 79", expected: drive(V1_MARK_READ_CELL), actual: drive(FLOOR_CELL) }),
    ]);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toEqual([`+ ${drive(FLOOR_CELL, { 11: 0x2f })}`, `- ${drive(V1_MARK_READ_CELL, { 11: 0x1f })}`]);
  });

  test("without the deltas (the v1 determinism check) nothing is forgiven", () => {
    const { lines, accounted } = lineDiffWith([drive(V1_MARK_READ_CELL)], [drive(FLOOR_CELL)]);
    expect(accounted).toEqual([]);
    expect(lines).toHaveLength(2);
  });

  test("frameCells reads a frame line and nothing else", () => {
    expect(frameCells(drive(0x25))?.[7]).toBe(0x25);
    expect(frameCells("palette 1 2,3,4")).toBeNull();
  });
});
describe("beyond decision 79", () => {
  const rule = (id: string) => {
    const found = BEYOND_79.find((d) => d.id === id);
    if (!found) throw new Error(`no rule ${id}`);
    return found;
  };
  const ctx = (expectedSeats: (string | null)[] | null, actualSeats: (string | null)[] | null, actualBeforeView = false): LineContext => ({ expectedSeats, actualSeats, actualBeforeView });
  const seats = (...keys: string[]) => [...keys, ...Array<null>(9 - keys.length).fill(null)];
  const seatRule = rule("seats follow the app's window order");

  test("a frame compares by thread through each side's seat map (decision 80)", () => {
    /* v1: bravo, the asker, on k3 (wire 13); v2: bravo on k1 (wire 11) */
    const v1 = drive(FLOOR_CELL, { 11: 0x29, 12: 0x29, 13: 0xe9 });
    const v2 = drive(FLOOR_CELL, { 11: 0xe9, 12: 0x29, 13: 0x29 });
    expect(seatRule.same(v1, v2, ctx(seats("a", "c", "b"), seats("b", "c", "a")))).toBe(true);
    /* the asker's light on the wrong thread */
    expect(seatRule.same(v1, v2, ctx(seats("a", "c", "b"), seats("c", "b", "a")))).toBe(false);
    /* a key that is not a digit must still match byte for byte */
    expect(seatRule.same(v1, drive(FLOOR_CELL, { 11: 0xe9, 12: 0x29, 13: 0x29, 0: 0x15 }), ctx(seats("a", "c", "b"), seats("b", "c", "a")))).toBe(false);
    /* and with no seat map there is nothing to compare by */
    expect(seatRule.same(v1, v2, ctx(null, seats("b", "c", "a")))).toBe(false);
  });

  test("a reseated frame may also carry decision 79's light on + and .", () => {
    const v1 = drive(V1_MARK_READ_CELL, { 11: 0x29, 13: 0xe9 });
    const v2 = drive(FLOOR_CELL, { 11: 0xe9, 13: 0x29, 16: V1_MARK_READ_CELL });
    expect(seatRule.same(v1.replace(/fd 83$/, "fd 03"), v2, ctx(seats("a", "c", "b"), seats("b", "c", "a")))).toBe(true);
  });

  test("permuting needs both maps to seat the same threads", () => {
    const cells = Array<number>(17).fill(3);
    expect(permuteDigits(cells, seats("a", "b"), seats("b", "a"))).not.toBeNull();
    expect(permuteDigits(cells, seats("a", "b"), seats("a", "c"))).toBeNull();
    expect(permuteDigits(cells, seats("a"), seats("a", "b"))).toBeNull();
  });

  test("where v1 redrew its seat memo after an answer, v2 may show the thread's true state for at most 250ms (decision 80)", () => {
    const memo = rule("the thread's true state where v1 redrew its seat memo");
    /* v1: bravo's stale ask on k1 under bravo, alpha, charlie; v2: bravo working on k3 under charlie, alpha, bravo */
    const v1 = drive(V1_MARK_READ_CELL, { 11: 0x49, 12: 0x29, 13: 0x29, 16: FLOOR_CELL });
    const v2 = drive(FLOOR_CELL, { 11: 0x29, 12: 0x29, 13: 0xe9, 16: V1_MARK_READ_CELL });
    const at = (expectedMemo: boolean, actualHold: number): LineContext => ({ ...ctx(seats("b", "a", "c"), seats("c", "a", "b")), expectedMemo, actualHold });
    expect(memo.same(v1, v2, at(true, 250))).toBe(true);
    /* not v1's memo redraw, or held past the window */
    expect(memo.same(v1, v2, at(false, 250))).toBe(false);
    /* one build of the server's view, seen at the board with a little transport jitter */
    expect(memo.same(v1, v2, at(true, 251))).toBe(true);
    expect(memo.same(v1, v2, at(true, 250 + HOLD_SLACK_MS + 1))).toBe(false);
    /* two keys differ, read by thread */
    expect(memo.same(v1, drive(FLOOR_CELL, { 11: 0x5f, 12: 0x29, 13: 0xe9, 16: V1_MARK_READ_CELL }), at(true, 200))).toBe(false);
    /* a key that is not a digit differs */
    expect(memo.same(v1, drive(FLOOR_CELL, { 0: 0x15, 11: 0x29, 12: 0x29, 13: 0xe9, 16: V1_MARK_READ_CELL }), at(true, 200))).toBe(false);
  });

  test("a bare frame is forgiven only before the first view (decision 81)", () => {
    const bare = rule("a bare frame before the first view");
    expect(bare.same(drive(V1_MARK_READ_CELL), drive(FLOOR_CELL, { 1: 3, 11: 3 }), ctx(null, null, true))).toBe(true);
    expect(bare.same(drive(V1_MARK_READ_CELL), drive(FLOOR_CELL, { 1: 3, 11: 3 }), ctx(null, null, false))).toBe(false);
    expect(bare.same("global 255", drive(FLOOR_CELL), ctx(null, null, true))).toBe(false);
  });

  test("board.connect may say the real fw, proto and reconnects; perf.board is new; nothing else moves", () => {
    const connect = rule("board.connect says the board's real firmware");
    const v1 = 'telemetry board.connect {"fw":1,"proto":1}';
    expect(connect.same(v1, 'telemetry board.connect {"fw":5,"proto":1,"reconnects":0}')).toBe(true);
    expect(connect.same(v1, 'telemetry board.connect {"fw":5,"proto":2,"reconnects":0}')).toBe(false);
    expect(connect.same(v1, 'telemetry board.connect {"fw":5,"proto":1,"reconnects":0} ok 0')).toBe(false);
    expect(connect.same(v1, 'telemetry board.connect {"bank":"x","fw":5,"proto":1,"reconnects":0}')).toBe(false);
    const perf = rule("perf.board is new");
    expect(perf.extra?.('telemetry perf.board {"board":0,"cpu":0.5}')).toBe(true);
    expect(perf.extra?.('telemetry board.key {"wire":1}')).toBe(false);
  });
});
