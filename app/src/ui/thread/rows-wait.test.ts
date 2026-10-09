/* a wait's row says what it waits on while it runs and who it heard from once it has (docs/thread.md, the rows). cmx2
   titles every wait "wait for agents", so neither comes from the title: an agent waiting on its own background jobs,
   or on its parent's reply, never reads as waiting on agents */

import { describe, expect, test } from "bun:test";
import { type Step, arrivalsOf, turnsOf } from "./model";
import { type Child, type RowCtx, stepModel, waitingOn } from "./rows";
import type { WireMessage, WirePart } from "./wire";

const T0 = 1_790_000_000_000;
const wait = (over: Partial<Step>): Step => ({ k: "step", id: "w1", callID: "c1", family: "wait", tool: "wait", status: "completed", object: "", result: "", add: 0, del: 0, ms: 60_000, at: T0, ...over }) as Step;
const child = (state: Child["state"]): Child => ({ steps: 0, ms: 0, items: [], held: false, state, since: T0, created: T0, title: "helper (worker)" });
const ctx = (children: Child[] = []): RowCtx => ({ turns: [], children: new Map(children.map((c, i) => [`ses_${i}`, c])), thinking: "rows", now: T0 + 5000 });
const text = (s: Step, c: RowCtx = ctx()) => stepModel(s, c).content.map((x) => ("s" in x ? x.s : "")).join("");

describe("who a finished wait heard from", () => {
  test("names the agents that reported, the jobs, the parent's task and the daemon, never a path", () => {
    expect(arrivalsOf([{ from: "/root/helper", kind: "report" }])).toBe("helper");
    expect(arrivalsOf([{ from: null, kind: "job" }])).toBe("a background job");
    expect(arrivalsOf([{ from: null, kind: "job" }, { from: null, kind: "job" }])).toBe("2 background jobs");
    expect(arrivalsOf([{ from: "/root", kind: "task" }])).toBe("root");
    expect(arrivalsOf([{ from: "/root/a", kind: "report" }, { from: null, kind: "job" }])).toBe("a and a background job");
    expect(arrivalsOf([{ from: null, kind: "report" }])).toBe("a pool");
    expect(arrivalsOf([{ from: null, kind: "system" }])).toBe("the daemon");
  });

  test("many reports name two and count the rest; nothing that came is nothing said", () => {
    const four = ["a", "b", "c", "d"].map((n) => ({ from: `/root/${n}`, kind: "report" }));
    expect(arrivalsOf(four)).toBe("a, b and 2 more agents");
    expect(arrivalsOf([...four.slice(0, 3)])).toBe("a, b and c");
    expect(arrivalsOf([])).toBe("");
    expect(arrivalsOf([null, 3, "x"])).toBe("");
  });

  test("the model reads it from the part's metadata, and a correlation id makes it a wait for a reply", () => {
    const part = (state: Record<string, unknown>): WirePart => ({ id: "p", type: "tool", tool: "wait", callID: "c", state }) as unknown as WirePart;
    const msgs = (p: WirePart): WireMessage[] => [
      { info: { id: "u", role: "user", time: { created: T0 } } as WireMessage["info"], parts: [{ id: "u_p", type: "text", text: "go" } as WirePart] },
      { info: { id: "a", role: "assistant", time: { created: T0 + 100, completed: T0 + 5000 } } as WireMessage["info"], parts: [p] },
    ];
    const done = turnsOf(msgs(part({ status: "completed", input: { timeout_ms: 600000 }, output: "arrived: job from the runtime", title: "wait for agents", metadata: { arrived: true, timed_out: false, items: [{ from: null, kind: "job" }] }, time: { start: T0, end: T0 + 1000 } })), "/")[0]?.items[0];
    expect(done).toMatchObject({ family: "wait", object: "a background job", result: "" });
    const asked = turnsOf(msgs(part({ status: "running", input: { timeout_ms: 600000, correlation_id: "q1" }, title: "wait for agents", time: { start: T0 } })), "/")[0]?.items[0];
    expect(asked).toMatchObject({ family: "wait", reply: true });
  });
});

describe("a wait's row", () => {
  test("running, it names the agents at work under it, else a reply it asked for, else a job or a message", () => {
    const running = wait({ status: "running" });
    expect(text(running, ctx([child("working"), child("working"), child("idle")]))).toBe("for 2 agents");
    expect(text(running, ctx([child("idle")]))).toBe("for a job or a message");
    expect(text(wait({ status: "running", reply: true }))).toBe("for a reply");
  });

  test("done, it says who it heard from, or that nothing came", () => {
    expect(text(wait({ object: "helper" }))).toBe("from helper");
    expect(text(wait({ result: "timed out" }))).toBe("nothing came");
    expect(stepModel(wait({ result: "timed out" }), ctx()).result.text).toBe("timed out");
  });

  test("the status line's words: agents first, then the agent it messaged, then a reply, then a job or a message", () => {
    expect(waitingOn({ agents: 1, reply: true, replyFrom: "its parent" })).toBe("1 agent");
    expect(waitingOn({ agents: 0, reply: false, replyFrom: "its parent" })).toBe("a reply from its parent");
    expect(waitingOn({ agents: 0, reply: true })).toBe("a reply");
    expect(waitingOn({ agents: 0, reply: false })).toBe("a job or a message");
  });
});
