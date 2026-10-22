/* an agent's row and the agents panel for a child whose thread is not held (docs/thread.md, agents): they read what the fleet's
   session info says, and leave the step count off until the thread is held, never showing it as zero */

import { describe, expect, test } from "bun:test";
import { agentState, type AgentRow } from "./details-model";
import type { Step } from "./model";
import { type Child, type RowCtx, stepModel } from "./rows";

const T0 = 1_790_000_000_000;
const spawn = { k: "step", id: "p1", callID: "c1", family: "spawn", tool: "spawn", status: "completed", object: "helper", result: "", add: 0, del: 0, ms: 0, at: T0, agent: { name: "helper", brief: "read the logs", child: "ses_c" } } as Step;
const child = (over: Partial<Child>): Child => ({ steps: 0, ms: 60_000, items: [], held: false, state: "idle", since: T0, created: T0, title: "helper (worker)", ...over });
const ctx = (c: Child): RowCtx => ({ reports: [], children: new Map([["ses_c", c]]), thinking: "rows" });

describe("an agent whose thread is not held", () => {
  test("its row says nothing of steps, and its facts leave the count off", () => {
    const m = stepModel(spawn, ctx(child({})));
    expect(m.result.text).toBe("");
    expect(m.body?.k === "agent" && m.body.facts[0]?.text).toBe("its turn ended, no report");
    expect(m.body?.k === "agent" && m.body.facts.some((f) => /step/.test(f.text))).toBe(false);
  });

  test("held, its row says how many steps it took", () => {
    const m = stepModel(spawn, ctx(child({ held: true, steps: 128 })));
    expect(m.result.text).toBe("128 steps");
    expect(m.body?.k === "agent" && m.body.facts.some((f) => f.text === "128 steps")).toBe(true);
  });

  test("working or waiting, it reads the same held or not", () => {
    expect(stepModel(spawn, ctx(child({ state: "wants" }))).result.text).toBe("wants you");
    expect(stepModel(spawn, ctx(child({ state: "parked" }))).result.text).toBe("parked");
  });

  test("the panel's row says there is no report, in place of a count", () => {
    const row = (c: Child, reported = false) => ({ id: "ses_c", child: c, name: "helper", at: T0, reported, label: "helper" }) as AgentRow;
    expect(agentState(row(child({})))).toBe("no report");
    expect(agentState(row(child({ held: true, steps: 3 })))).toBe("3 steps");
    expect(agentState(row(child({}), true))).toBe("reported");
  });
});
