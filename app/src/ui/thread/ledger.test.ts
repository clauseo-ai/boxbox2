/* the running turn is not rebuilt whole on each delta (docs/thread.md, live): a recorded turn is played as the store
   plays a stream (a thought's text grows in place, a tool part is sent again whole, a message's info is replaced with
   copies of its parts, the clock ticks), and after each change exactly the rows that read the changed part hand their
   view a new object. every other item, row model and entry is the object from the pass before, so `Index` gives its
   place nothing new and its dom is left alone. each pass is also checked against a rebuild from nothing, so what is
   kept is never stale. */

import { describe, expect, test } from "bun:test";
import { type Entry, ledgerOf, namesOf, nthName, sameCtxFor, tally } from "./ledger";
import { type Item, type PartMemo, type Step, type Turn, projectRoot, turnsOf } from "./model";
import { type Child, type RowCtx, clockS } from "./rows";
import type { WireMessage, WirePart } from "./wire";

type Recorded = { session: { directory: string }; messages: WireMessage[] };
type Mutable = { info: WireMessage["info"]; parts: WirePart[] };

/* fetched, never imported: a megabyte json module makes the type checker build a literal type of it (gotchas.md) */
const file = (await Bun.file(new URL("./fixtures/cmx-deploy.json", import.meta.url)).json()) as Recorded;
const ROOT = projectRoot(file.session.directory, file.messages);
const NOW = 1_790_000_000_000;
const THOUGHT = "prt_streaming_thought";

/** the recorded report turn (109 steps, 77 thoughts), still running: its answer not yet written, its last message open,
    and a thought starting to stream at its end */
function runningTurn(): { messages: Mutable[]; thought: Record<string, unknown> } {
  const nextUser = file.messages.findIndex((m, i) => i > 0 && m.info.role === "user");
  const messages = structuredClone(file.messages.slice(0, nextUser - 1)) as Mutable[];
  const last = messages.at(-1) as Mutable; // the turn has 84 messages before its answer
  delete (last.info.time as { completed?: number }).completed;
  const thought: Record<string, unknown> = { id: THOUGHT, type: "reasoning", text: "first", streaming: true, time: { start: NOW - 4000 } };
  last.parts.push(thought as WirePart);
  return { messages, thought };
}

/** one view of the running turn, as a component holds it: the part memo and the ledger, growing at its end */
function viewer() {
  const parts: PartMemo = new Map();
  const ledger = ledgerOf();
  return (messages: readonly Mutable[], now = NOW) => {
    const turn = turnsOf(messages, ROOT, undefined, parts)[0] as Turn;
    const ctx: RowCtx = { turns: [turn], children: new Map(), thinking: "rows", now };
    return { turn, entries: ledger(turn, ctx, true) };
  };
}

/** the same messages read from nothing: no memo, no remembered rows */
function fresh(messages: readonly Mutable[], now = NOW) {
  return viewer()(structuredClone(messages) as Mutable[], now);
}

/** the places whose object changed between two passes */
const changed = <T,>(before: readonly T[], after: readonly T[]): number[] => after.flatMap((x, i) => (x === before[i] ? [] : [i]));
/** what a view paints, without the identities */
const painted = (entries: readonly Entry[]) => JSON.parse(JSON.stringify(entries)) as unknown;
const lastIndex = <T,>(list: readonly T[], match: (x: T) => boolean): number => {
  for (let i = list.length - 1; i >= 0; i--) if (match(list[i] as T)) return i;
  return -1;
};
const sameItems = (a: readonly Item[], b: readonly Item[]) => b.flatMap((x, i) => (x === a[i] ? [] : [i]));

describe("the running turn, delta by delta", () => {
  test("a thought growing in place rebuilds its own row and no other", () => {
    const { messages, thought } = runningTurn();
    const view = viewer();
    let pass = view(messages);
    expect(pass.entries.length).toBeGreaterThan(100);
    for (const words of ["checking", " the", " build", " before", " the", " push", ", then", " the", " tests"]) {
      thought["text"] = `${String(thought["text"])}${words}`;
      const next = view(messages);
      // the turn is a new object, but only the thought's item is
      expect(next.turn).not.toBe(pass.turn);
      expect(sameItems(pass.turn.items, next.turn.items)).toEqual([next.turn.items.length - 1]);
      // one entry: the thought's row, the newest, carrying the words as they stand
      expect(changed(pass.entries, next.entries)).toEqual([next.entries.length - 1]);
      expect(next.entries.at(-1)?.model?.partIDs).toContain(THOUGHT);
      expect(next.entries.at(-1)?.live?.text).toBe(String(thought["text"]));
      expect(painted(next.entries)).toEqual(painted(fresh(messages).entries));
      pass = next;
    }
  });

  test("a tool part sent again whole rebuilds that step's row alone", () => {
    const { messages } = runningTurn();
    const view = viewer();
    const before = view(messages);
    const at = lastIndex(messages, (m) => m.parts.some((p) => p.type === "tool" && (p as { tool?: string }).tool === "exec_command"));
    const message = messages[at] as Mutable;
    const index = lastIndex(message.parts, (p) => p.type === "tool");
    const part = structuredClone(message.parts[index]) as WirePart & { state: { output?: string } };
    part.state.output = `${part.state.output ?? ""}\nand one more line`;
    message.parts[index] = part;
    const after = view(messages);
    const step = after.turn.items.findIndex((x) => x.k === "step" && x.id === (part as { id?: string }).id);
    expect(sameItems(before.turn.items, after.turn.items)).toEqual([step]);
    const row = after.entries.findIndex((e) => e.model?.partIDs.includes(String((part as { id?: string }).id)));
    expect(changed(before.entries, after.entries)).toEqual([row]);
    expect(painted(after.entries)).toEqual(painted(fresh(messages).entries));
  });

  test("a message's info replaced with copies of its parts changes no row", () => {
    const { messages } = runningTurn();
    const view = viewer();
    const before = view(messages);
    // the store's patch for a message upsert carries every part again, as new objects with the same content
    const at = messages.length - 2;
    const message = messages[at] as Mutable;
    messages[at] = { info: { ...structuredClone(message.info), tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } as WireMessage["info"], parts: structuredClone(message.parts) as WirePart[] };
    const after = view(messages);
    expect(sameItems(before.turn.items, after.turn.items)).toEqual([]);
    expect(changed(before.entries, after.entries)).toEqual([]);
  });

  test("the clock ticking rebuilds only the rows that count it", () => {
    const { messages } = runningTurn();
    const view = viewer();
    const before = view(messages, NOW);
    const after = view(messages, NOW + 1000);
    // the streaming thought counts the clock; the finished steps above it do not
    expect(changed(before.entries, after.entries)).toEqual([after.entries.length - 1]);
    expect(painted(after.entries)).toEqual(painted(fresh(messages, NOW + 1000).entries));
  });

  test("every row of the turn is in the ledger as it happens, the newest alone is current, and nothing is a settled turn's last row yet", () => {
    const { entries } = viewer()(runningTurn().messages);
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.map((e) => e.cur === true)).toEqual(entries.map((_, i) => i === entries.length - 1));
    expect(entries.filter((e) => e.live).length).toBe(1);
    expect(entries.some((e) => e.model?.kind === "files" || e.model?.kind === "stopped" || e.model?.kind === "failed")).toBe(false);
  });

  test("a quiet stretch is marked where it happens, as it is once the turn has settled", () => {
    const { messages } = runningTurn();
    const live = viewer()(messages).entries;
    const parts: PartMemo = new Map();
    const turn = turnsOf(messages, ROOT, undefined, parts)[0] as Turn;
    const settled = ledgerOf()(turn, { turns: [turn], children: new Map(), thinking: "rows" });
    const gaps = (entries: readonly Entry[]) => entries.flatMap((e) => (e.gap ? [`${e.key}: ${e.gap}`] : []));
    expect(gaps(live)).not.toEqual([]);
    expect(gaps(live)).toEqual(gaps(settled));
  });

  test("settled, the same turn's ledger has its last rows and no current row", () => {
    const { messages } = runningTurn();
    const parts: PartMemo = new Map();
    const turn = turnsOf(messages, ROOT, undefined, parts)[0] as Turn;
    const ctx: RowCtx = { turns: [turn], children: new Map(), thinking: "rows" };
    const entries = ledgerOf()(turn, ctx);
    expect(entries.some((e) => e.cur)).toBe(false);
    expect(entries.some((e) => e.live)).toBe(false);
    expect(entries.some((e) => e.model?.kind === "files")).toBe(true);
  });

  test("the row before the newest keeps its entry when the next row arrives and only loses what made it current", () => {
    const { messages } = runningTurn();
    const view = viewer();
    const before = view(messages);
    const last = messages.at(-1) as Mutable;
    last.parts.push({ id: "prt_next_step", type: "tool", callID: "call_next", tool: "read", state: { status: "completed", input: { filePath: `${ROOT}/next.md` }, output: "x", title: "next.md", metadata: {}, time: { start: NOW - 2000, end: NOW - 1900 } } } as unknown as WirePart);
    const after = view(messages);
    expect(after.entries.length).toBe(before.entries.length + 1);
    // the entries above the old newest are untouched; the old newest is rebuilt without its live body, the new one is current
    expect(changed(before.entries, after.entries)).toEqual([before.entries.length - 1, before.entries.length]);
    expect(after.entries.at(-2)?.cur).toBeUndefined();
    expect(after.entries.at(-2)?.live).toBeUndefined();
    expect(after.entries.at(-1)?.cur).toBe(true);
  });

  test("a finished turn's ledger keeps every entry while the thread around it changes", () => {
    const nextUser = file.messages.findIndex((m, i) => i > 0 && m.info.role === "user");
    const done = structuredClone(file.messages.slice(0, nextUser)) as Mutable[];
    const parts: PartMemo = new Map();
    const turn = turnsOf(done, ROOT, undefined, parts)[0] as Turn;
    const ledger = ledgerOf();
    const first = ledger(turn, { turns: [turn], children: new Map(), thinking: "rows" });
    // another turn running beside it: the context is a new object with a clock, every second and every delta
    const other = { ...turn, id: "another" };
    const second = ledger(turn, { turns: [turn, other], children: new Map(), thinking: "rows", now: NOW });
    expect(changed(first, second)).toEqual([]);
    expect(first.some((e) => e.model?.kind === "files")).toBe(true);
  });

  test("a part a pass no longer sees is forgotten", () => {
    const { messages } = runningTurn();
    const parts: PartMemo = new Map();
    turnsOf(messages, ROOT, undefined, parts);
    const held = parts.size;
    const shorter = messages.slice(0, 10);
    turnsOf(shorter, ROOT, undefined, parts);
    expect(parts.size).toBeLessThan(held);
    expect(parts.has(THOUGHT)).toBe(false);
  });
});

/* every control on a page has a name of its own (AGENTS.md rule 5; docs/thread.md, accessibility): a row whose label a
   row above it already carries says how many times it has come up, and a place that is not a control has no name */
describe("the rows' names", () => {
  test("a label the page has not shown yet is the name as it is", () => {
    expect(namesOf(["read notes.md, 3 lines", "edit notes.md, +1 -1"], new Map())).toEqual(["read notes.md, 3 lines", "edit notes.md, +1 -1"]);
  });

  test("a namesake later in the same turn reads again, then third time", () => {
    expect(namesOf(["run ls", "run ls", undefined, "run ls"], new Map())).toEqual(["run ls", "run ls, again", undefined, "run ls, third time"]);
  });

  test("a namesake in an earlier turn counts, so the same step in a later turn is told apart", () => {
    const above = new Map<string, number>();
    tally(["read notes.md, 3 lines", undefined, "edit notes.md, failed"], above);
    expect(namesOf(["read notes.md, 3 lines", "edit notes.md, +1 -1"], above)).toEqual(["read notes.md, 3 lines, again", "edit notes.md, +1 -1"]);
  });

  test("past the tenth time the count is an ordinal that reads right", () => {
    expect([10, 11, 12, 13, 21, 22, 23, 111, 112].map((n) => nthName("run ls", n))).toEqual([
      "run ls, tenth time", "run ls, 11th time", "run ls, 12th time", "run ls, 13th time", "run ls, 21st time", "run ls, 22nd time", "run ls, 23rd time", "run ls, 111th time", "run ls, 112th time",
    ]);
  });

  test("however many times a label comes up, every name on the page is different", () => {
    const labels = Array.from({ length: 40 }, (_, i) => (i % 3 ? "read notes.md" : "run bun test, 54 passed"));
    const names = [...namesOf(labels.slice(0, 15), new Map()), ...namesOf(labels.slice(15), (() => { const m = new Map<string, number>(); tally(labels.slice(0, 15), m); return m; })())];
    expect(new Set(names).size).toBe(labels.length);
  });
});

/* where the stage has no margin for the ledger's clock (a phone), an open row is where its time is read (docs/thread.md, the row) */
describe("an open row's time", () => {
  test("a command says to the second when it ran", () => {
    const { messages } = runningTurn();
    const { entries } = viewer()(messages);
    const shell = entries.flatMap((e) => (e.model?.body?.k === "shell" ? [e.model] : []));
    expect(shell.length).toBeGreaterThan(10);
    for (const m of shell) {
      const facts = m.body?.k === "shell" ? m.body.facts : [];
      expect(facts.at(-1)?.text).toBe(`at ${clockS(m.at)}`);
    }
  });
});

describe("what a turn reads of its context", () => {
  const step = (over: Partial<Step>): Step => ({ k: "step", id: "p1", callID: "call_1", family: "shell", tool: "shell", status: "completed", object: "ls", result: "", add: 0, del: 0, ms: 0, at: NOW, ...over }) as Step;
  const turnOf = (...items: Step[]): Turn => ({ id: "m1", by: "you", prompt: "go", at: NOW, end: NOW, items, status: "done", cost: 0, files: new Map(), compacted: false, unknownParts: 0 });
  const child = (over: Partial<Child> = {}): Child => ({ steps: 3, ms: 1000, items: [], held: true, state: "idle", since: NOW, created: NOW, title: "", ...over });
  const base: RowCtx = { turns: [], children: new Map(), asks: new Map(), thinking: "rows" };
  const spawn = step({ id: "p2", callID: "call_2", family: "spawn", tool: "spawn", agent: { name: "helper", brief: "do it", child: "ses_c" } });

  test("another turn's ask, child or report changing leaves it as it was", () => {
    const turn = turnOf(step({}));
    const other: RowCtx = { ...base, asks: new Map([["call_9", { id: "ask_1", kind: "question", request: {} }]]), children: new Map([["ses_other", child()]]), turns: [turnOf()] };
    expect(sameCtxFor(turn, base, other)).toBe(true);
  });

  test("an ask on one of its own steps, or its agent's child, wakes it", () => {
    const turn = turnOf(step({}), spawn);
    const asked: RowCtx = { ...base, asks: new Map([["call_1", { id: "ask_1", kind: "permission", request: {} }]]) };
    expect(sameCtxFor(turn, base, asked)).toBe(false);
    const working: RowCtx = { ...base, children: new Map([["ses_c", child({ state: "working" })]]) };
    expect(sameCtxFor(turn, base, working)).toBe(false);
    expect(sameCtxFor(turn, working, { ...working, children: new Map(working.children) })).toBe(true);
  });

  test("the clock and the thinking setting wake every turn that is handed them", () => {
    const turn = turnOf(step({}));
    expect(sameCtxFor(turn, base, { ...base, now: NOW + 1000 })).toBe(false);
    expect(sameCtxFor(turn, base, { ...base, tick: NOW + 1000 })).toBe(false);
    expect(sameCtxFor(turn, base, { ...base, thinking: "open" })).toBe(false);
  });

  test("a report arriving wakes the turn whose agent sent it, not a turn with no agents", () => {
    const report: Turn = { ...turnOf(), id: "m2", by: "mail", from: "helper", fromID: "ses_c", at: NOW + 5000 };
    const reported: RowCtx = { ...base, turns: [report] };
    expect(sameCtxFor(turnOf(spawn), base, reported)).toBe(false);
    expect(sameCtxFor(turnOf(step({})), base, reported)).toBe(true);
  });
});
