/* a script step's name (script.ts) wherever it is said: the row, the group's line, a home window's tail line; a part with no start
   of its own dated after the part before it, so a group's time and clock read in the order the rows do; the place line's name for a
   root or home folder */

import { describe, expect, test } from "bun:test";
import { tailLines } from "../window/tail";
import { doingOf, groupLine, segmentsOf, stripKind } from "./groups";
import { ledgerOf } from "./ledger";
import { type Step, turnsOf } from "./model";
import { placeName } from "./place";
import { type RowCtx, kindOf } from "./rows";
import { A_SCRIPT, leadingComment, scriptName, scriptTitle } from "./script";
import type { WireMessage, WirePart } from "./wire";
import { neutral } from "./fixtures/wire";
import { mailsOf } from "./rows";

const T0 = 1_790_000_000_000;
const SCRIPT = "const cmds = {\n  a: 'git status',\n};\nfor (const c of Object.values(cmds)) await shell.exec({ command: c });";

const user = (): WireMessage => neutral({ info: { id: "u1", role: "user", time: { created: T0 } }, parts: [{ id: "u1_p", type: "text", text: "look" } as WirePart] });
const assistant = (parts: WirePart[]): WireMessage => neutral({ info: { id: "a1", role: "assistant", time: { created: T0 + 100 } }, parts });
const runPart = (input: Record<string, unknown>, time?: { start?: number; end?: number }): WirePart =>
  ({ id: "prt_run", type: "tool", callID: "c_run", tool: "run", state: { status: "running", input, metadata: {}, ...(time ? { time } : {}) } }) as unknown as WirePart;
const stepIn = (msgs: WireMessage[]): Step => { const s = turnsOf(msgs, "/w")[0]?.items.find((x) => x.k === "step"); if (!s || s.k !== "step") throw new Error("no step"); return s; };

describe("a script's name", () => {
  test("its description, else its leading comment, else \"a script\": never its first line of code", () => {
    expect(scriptName(SCRIPT)).toBe(A_SCRIPT);
    expect(scriptName(`// check what changed\n${SCRIPT}`)).toBe("check what changed");
    expect(scriptName(`\n// read the three\n// config files\n${SCRIPT}`)).toBe("read the three config files");
    expect(scriptName(`/* list the\n * open ports */\n${SCRIPT}`)).toBe("list the open ports");
    expect(scriptName(SCRIPT, "  count the tests  ")).toBe("count the tests");
    expect(scriptName("return 1")).toBe(A_SCRIPT);
    expect(scriptName("")).toBe(A_SCRIPT);
    expect(scriptName(`// ${"x".repeat(100)}`)).toHaveLength(72);
    expect(leadingComment("const a = 1 // not leading")).toBeUndefined();
  });

  test("a title from the daemon: a line of code is \"a script\", words stay words", () => {
    expect(scriptTitle("const cmds = {")).toBe(A_SCRIPT);
    expect(scriptTitle("await shell.exec({ command: 'ls' })")).toBe(A_SCRIPT);
    expect(scriptTitle(SCRIPT)).toBe(A_SCRIPT);
    expect(scriptTitle("// look at the logs")).toBe("look at the logs");
    expect(scriptTitle("look at the logs")).toBe("look at the logs");
    expect(scriptTitle("")).toBe(A_SCRIPT);
  });

  test("the step: named in words, a run in the kind column and on the strip", () => {
    const s = stepIn([user(), assistant([runPart({ code: SCRIPT })])]);
    expect(s.object).toBe(A_SCRIPT);
    expect(s.script).toBe(true);
    expect(kindOf(s)).toBe("run");
    expect(stripKind(s)).toBe("run");
    expect(stepIn([user(), assistant([runPart({ code: `// tidy the tree\n${SCRIPT}` })])]).object).toBe("tidy the tree");
    expect(stepIn([user(), assistant([runPart({ code: SCRIPT, description: "find the slow test" })])]).object).toBe("find the slow test");
    expect(stepIn([user(), assistant([runPart({ code: "await shell.exec({ command: 'ls' })" })])]).object).toBe(A_SCRIPT);
  });

  test("the group's line says what the script does", () => {
    const base = stepIn([user(), assistant([runPart({ code: SCRIPT })])]);
    expect(doingOf({ k: "step", at: base.at, end: base.at, step: base })).toBe("running a script");
    expect(doingOf({ k: "step", at: base.at, end: base.at, step: { ...base, status: "completed" } })).toBe("ran a script");
    expect(doingOf({ k: "step", at: base.at, end: base.at, step: { ...base, object: "tidy the tree" } })).toBe("tidy the tree");
    const msgs = [user(), assistant([{ id: "w1", type: "text", text: "a quick look first.", time: { start: T0 + 60_000, end: T0 + 61_000 } } as unknown as WirePart, runPart({ code: SCRIPT })])];
    const turn = turnsOf(msgs, "/w")[0];
    if (!turn) throw new Error("no turn");
    const ctx: RowCtx = { reports: ([turn]).flatMap(mailsOf), children: new Map(), thinking: "rows", now: T0 + 400_000 };
    const segs = segmentsOf(ledgerOf()(turn, ctx, true), { running: true, ctx });
    const g = segs.find((x) => x.k === "group");
    if (g?.k !== "group") throw new Error("no group");
    expect(groupLine(g.group).text).toBe("running a script · 1 step");
    const settled = segmentsOf(ledgerOf()(turn, ctx, false), { running: false, ctx }).find((x) => x.k === "group");
    if (settled?.k !== "group") throw new Error("no settled group");
    expect(groupLine(settled.group).text).toBe("1 step · ran 1");
  });

  test("a home window's tail line", () => {
    const item = (text: string) => ({ kind: "tool", tool: "run", text, messageID: "m", partID: "p", role: "assistant", state: "running" }) as Parameters<typeof tailLines>[0][number];
    expect(tailLines([item("const cmds = {")])).toMatchObject([{ kind: "tool", verb: "run", object: A_SCRIPT }]);
    expect(tailLines([item("// tidy the tree")])).toMatchObject([{ kind: "tool", verb: "run", object: "tidy the tree" }]);
  });
});

describe("a part's moment, in the order the rows read", () => {
  test("a call with no start of its own starts no earlier than the words before it, so its group's time and clock follow them", () => {
    const words = { id: "w1", type: "text", text: "a quick look first.", time: { start: T0 + 60_000, end: T0 + 61_000 } } as unknown as WirePart;
    const s = stepIn([user(), assistant([words, runPart({ code: SCRIPT })])]);
    expect(s.at).toBe(T0 + 61_000);
    const turn = turnsOf([user(), assistant([words, runPart({ code: SCRIPT })])], "/w")[0];
    if (!turn) throw new Error("no turn");
    const ctx: RowCtx = { reports: ([turn]).flatMap(mailsOf), children: new Map(), thinking: "rows", now: T0 + 300_000 };
    const segs = segmentsOf(ledgerOf()(turn, ctx, true), { running: true, ctx });
    const g = segs.find((x) => x.k === "group");
    if (g?.k !== "group") throw new Error("no group");
    expect(g.group.at).toBeGreaterThanOrEqual(T0 + 60_000);
  });

  test("a call that says when it started keeps its own start; the first part of a message falls back to the message", () => {
    expect(stepIn([user(), assistant([runPart({ code: SCRIPT }, { start: T0 + 5000 })])]).at).toBe(T0 + 5000);
    expect(stepIn([user(), assistant([runPart({ code: SCRIPT })])]).at).toBe(T0 + 100);
  });
});

describe("the place line", () => {
  test("a repo by its name; the disk's root by the machine; a home folder as home", () => {
    expect(placeName("/Users/rohan/src/boxbox2", "desk")).toBe("boxbox2");
    expect(placeName("/", "desk")).toBe("desk");
    expect(placeName("", "desk")).toBe("desk");
    expect(placeName("/Users/rohan", "desk")).toBe("home");
    expect(placeName("/home/rohan/", "desk")).toBe("home");
    expect(placeName("/root", "desk")).toBe("home");
    expect(placeName("~", "desk")).toBe("home");
  });
});
