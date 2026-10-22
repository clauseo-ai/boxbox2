/* what arrives in a turn (docs/thread.md, arrivals; decision 92): an agent's report or note and a runtime notice are rows of the
   turn they came into, never turns of their own, unless nothing from the person came before them. their rows say who sent them and
   what it came to, a status mail reads as the status, a job's notice as its command and how it ended, and an agent row's link to
   its report goes to the arrival's row */

import { describe, expect, test } from "bun:test";
import { ledgerOf } from "./ledger";
import { type Arrival, type Step, type Turn, startsTurn, turnsOf, wakeOf } from "./model";
import { jobOf, reportOf, statusOf } from "./report";
import { type RowCtx, arrivalModel, mailsOf, reportFor, stepModel } from "./rows";
import type { WireMessage } from "./wire";
import { neutralMessage } from "../../sync/fixtures/neutral";

const wire = (info: Record<string, unknown>, parts: readonly Record<string, unknown>[]): WireMessage => neutralMessage({ info, parts: parts as Record<string, unknown>[] });
const T0 = 1_790_000_000_000;
let n = 0;
const you = (id: string, at: number, text = "go", info: Record<string, unknown> = {}): WireMessage => wire({ id, role: "user", time: { created: at }, ...info }, [{ id: `${id}_p`, messageID: id, type: "text", text }]);
const mail = (id: string, at: number, kind: string, text: string, from = "/root/helper", fromID = "ses_helper"): WireMessage => wire({ id, role: "user", time: { created: at }, mail: { kind, from, fromID } }, [{ id: `${id}_p`, messageID: id, type: "text", text, mail: { kind, from, fromID } }]);
const notice = (id: string, at: number, text: string): WireMessage => wire({ id, role: "user", time: { created: at }, notice: true }, [{ id: `${id}_p`, messageID: id, type: "text", text, notice: true }]);
const tool = (tool: string, at: number, extra: Record<string, unknown> = {}): Record<string, unknown> => { n++; return { id: `prt_${n}`, type: "tool", callID: `call_${n}`, tool, state: { status: "completed", input: {}, output: "", metadata: {}, time: { start: at, end: at + 500 }, ...extra } }; };
const said = (text: string, at: number): Record<string, unknown> => { n++; return { id: `prt_${n}`, type: "text", text, time: { start: at, end: at } }; };
const agent = (id: string, at: number, parts: Record<string, unknown>[], done = true, info: Record<string, unknown> = {}): WireMessage => wire({ id, role: "assistant", time: { created: at, ...(done ? { completed: at + 5000 } : {}) }, ...info }, parts.map((p) => ({ ...p, messageID: id })));

const JOB = "job job_mvhrc411w0014a: exited with code 0; no output\n(started by you: cd /tmp/x && ./checks.sh > /tmp/x/out.log 2>&1)";

describe("a turn starts only at a message from the person", () => {
  test("reports, notes and notices into a turn are rows of it, at their place in time; the next turn starts at the person's next message", () => {
    const turns = turnsOf([
      you("u1", T0, "start the corpus agents"),
      agent("a1", T0 + 1000, [tool("spawn", T0 + 1100), tool("wait", T0 + 2000)]),
      mail("m1", T0 + 60_000, "report", "agent /root/helper reached status: parked\n\nready: the corpus is in"),
      agent("a2", T0 + 61_000, [tool("wait", T0 + 61_100)]),
      notice("n1", T0 + 120_000, JOB),
      mail("m2", T0 + 121_000, "message", "see the fixture"),
      agent("a3", T0 + 122_000, [tool("shell", T0 + 122_100), said("all green.", T0 + 130_000)]),
      you("u2", T0 + 200_000, "thanks"),
      agent("a4", T0 + 201_000, [said("ok.", T0 + 201_100)]),
    ], "/");
    expect(turns.map((t) => [t.id, t.by])).toEqual([["u1", "you"], ["u2", "you"]]);
    const first = turns[0] as Turn;
    expect(first.items.map((x) => (x.k === "arrive" ? `arrive:${x.kind}` : x.k === "step" ? x.family : x.k))).toEqual(["spawn", "wait", "arrive:report", "wait", "arrive:job", "arrive:note", "shell"]);
    expect(first.answer?.text).toBe("all green.");
    const report = first.items[2] as Arrival;
    expect(report).toMatchObject({ id: "m1", from: "helper", fromID: "ses_helper", at: T0 + 60_000 });
    expect(wakeOf(first)).toBe(T0 + 121_000);
  });

  test("the answer is the agent's last words after its last step or arrival across the whole turn; words before are said rows", () => {
    const [t] = turnsOf([
      you("u1", T0),
      agent("a1", T0 + 1000, [said("starting two agents.", T0 + 1100), tool("spawn", T0 + 1200)]),
      mail("m1", T0 + 9000, "report", "ready: done"),
    ], "/");
    expect(t?.answer).toBeUndefined();
    expect(t?.items.map((x) => x.k)).toEqual(["say", "step", "arrive"]);
  });

  test("a wake that was stopped, then woken again by a report, ends as the last wake did", () => {
    const [t] = turnsOf([
      you("u1", T0),
      agent("a1", T0 + 1000, [tool("wait", T0 + 1100)], true, { error: { name: "MessageAbortedError", message: "aborted" }, finish: "aborted" }),
      mail("m1", T0 + 9000, "report", "ready: done"),
      agent("a2", T0 + 10_000, [said("merged.", T0 + 10_100)]),
    ], "/");
    expect(t?.status).toBe("done");
    expect(t?.error).toBeUndefined();
  });

  test("a report that came before anything from the person still starts a turn of its own, and what follows it joins it", () => {
    const turns = turnsOf([
      mail("m0", T0, "report", "ready: before you"),
      agent("a0", T0 + 1000, [said("noted.", T0 + 1100)]),
      notice("n0", T0 + 2000, JOB),
      you("u1", T0 + 9000),
    ], "/");
    expect(turns.map((t) => [t.id, t.by])).toEqual([["m0", "mail"], ["u1", "you"]]);
    expect(turns[0]?.items.map((x) => x.k)).toEqual(["say", "arrive"]);
  });

  test("the brief that started an agent and a compaction start turns; a report, a note, a job and a system line do not", () => {
    const u = (m: WireMessage) => startsTurn(m.info, m.parts);
    expect(u(you("u", T0))).toBe(true);
    expect(u(you("q", T0, "later", { queued: true }))).toBe(true);
    expect(u(mail("b", T0, "task", "build it", "/root"))).toBe(true);
    expect(u(wire({ id: "c", role: "user", time: { created: T0 } }, [{ id: "c_p", messageID: "c", type: "compaction", auto: true }]))).toBe(true);
    for (const kind of ["report", "message", "job", "system"]) expect(u(mail(kind, T0, kind, "x"))).toBe(false);
    expect(u(notice("n", T0, JOB))).toBe(false);
    /* imported history marks a report as a synthetic text */
    expect(u(wire({ id: "i", role: "user", time: { created: T0 } }, [{ id: "i_p", messageID: "i", type: "text", text: "[from /root/x]: done", synthetic: true }]))).toBe(false);
  });

  test("a part arriving keeps an arrival's object, so its row is not made again", () => {
    const memo = new Map();
    const messages = [you("u1", T0), agent("a1", T0 + 1000, [tool("wait", T0 + 1100)]), mail("m1", T0 + 9000, "report", "ready: done")];
    const [a] = turnsOf(messages, "/", undefined, memo);
    const [b] = turnsOf([...messages, agent("a2", T0 + 10_000, [said("so", T0 + 10_100)], false)], "/", undefined, memo);
    expect(b?.items[1]).toBe(a?.items[1]);
  });
});

describe("a status mail and a report's daemon line", () => {
  test("the daemon's status line alone is a status, said as the status, never as a report", () => {
    const r = reportOf({ from: "r2_corpus", prompt: "agent /root/r2_corpus reached status: parked\n\n[child session: ses_1; transcript kept on disk. to continue: message(\"ses_1\")]", at: T0 });
    expect(r).toMatchObject({ kind: "status", status: "parked", gist: "parked", outcome: "none", verb: "parked" });
    expect(r.spoken).toMatch(/^status of r2_corpus, parked, \d\d:\d\d$/);
    expect(reportOf({ from: "x", prompt: "agent /root/x reached status: closed (closed by /root)", at: T0 })).toMatchObject({ kind: "status", gist: "closed, closed by root" });
  });

  test("above the agent's words, the daemon's line is left out of the gist, and its failure stands in for an outcome", () => {
    const r = reportOf({ from: "transport_impl", prompt: "agent /root/transport_impl reached status: parked\n\nready to merge cd16978\n\n[child session: ses_2; transcript kept on disk.]", at: T0 });
    expect(r).toMatchObject({ kind: "report", outcome: "ready", gist: "ready to merge cd16978" });
    expect(r.spoken).toMatch(/^report from transport_impl, ready, \d\d:\d\d, ready to merge cd16978$/);
    expect(reportOf({ from: "x", prompt: "agent /root/x reached status: failed\nthe model refused", at: T0 })).toMatchObject({ kind: "report", outcome: "failed", gist: "the model refused" });
    expect(statusOf("ready: no daemon line")).toBeUndefined();
  });
});

describe("a job's notice", () => {
  test("reads into its command, how it ended and whether it wrote anything, its id kept for the open row", () => {
    expect(jobOf(JOB)).toEqual({ id: "job_mvhrc411w0014a", command: "cd /tmp/x && ./checks.sh > /tmp/x/out.log 2>&1", exit: 0, output: "", who: "started by you" });
    expect(jobOf("job job_2: exited with code 1; last output:\nFAIL a.test.ts\n2 failed\n(started by the user: bun test)")).toEqual({ id: "job_2", command: "bun test", exit: 1, output: "FAIL a.test.ts\n2 failed", who: "started by the user" });
    expect(jobOf("job job_3: killed by SIGTERM; no output\n(started by you: sleep 99)")).toMatchObject({ signal: "SIGTERM", command: "sleep 99" });
  });

  test("words of another shape are not read into parts", () => {
    expect(jobOf("job job_4: became ready on port 3000")).toBeUndefined();
    expect(jobOf("you stopped the turn.")).toBeUndefined();
  });
});

describe("an arrival's row", () => {
  const arrival = (kind: Arrival["kind"], text: string, from = "transport_impl"): Arrival => ({ k: "arrive", id: "msg_m1", kind, text, at: T0, ...(kind === "report" || kind === "note" ? { from, fromID: "ses_t" } : {}) });

  test("a report: the agent's name and its gist, the outcome in its tone, a press raises its sheet, named as its chip is", () => {
    const m = arrivalModel(arrival("report", "agent /root/transport_impl reached status: parked\n\nready: the transport is in"));
    expect(m).toMatchObject({ kind: "report", key: "arrive:msg_m1", partIDs: ["msg_m1"], result: { text: "ready", tone: "lit" }, body: { k: "report" } });
    expect(m.content).toEqual([{ t: "fn", s: "transport_impl" }, { t: "brief", s: "the transport is in" }]);
    expect(m.label).toMatch(/^report from transport_impl, ready, \d\d:\d\d, the transport is in$/);
    expect(m.agent).toBeUndefined();
  });

  test("a note reads from its sender; a status reads as the status", () => {
    expect(arrivalModel(arrival("note", "see the fixture")).content[0]).toEqual({ t: "lead", s: "from " });
    const s = arrivalModel(arrival("report", "agent /root/r2_corpus reached status: parked", "r2_corpus"));
    expect(s).toMatchObject({ kind: "status", result: { text: "parked" }, content: [{ t: "fn", s: "r2_corpus" }] });
    expect(s.label).toMatch(/^status of r2_corpus, parked/);
  });

  test("a job: its command's short form, exit 0 quiet or a failure in red, and its id, how it ended and its output inside", () => {
    const ok = arrivalModel(arrival("job", JOB));
    expect(ok).toMatchObject({ kind: "job", result: { text: "exit 0", tone: "quiet" }, bad: false });
    expect(ok.content.at(-1)).toEqual({ t: "lead", s: " no output" });
    expect(ok.label).toMatch(/^job .*checks\.sh.*, exit 0, no output, \d\d:\d\d$/);
    expect(ok.body?.k === "shell" && ok.body.facts.map((f) => f.text)).toContain("job job_mvhrc411w0014a");
    const bad = arrivalModel(arrival("job", "job job_2: exited with code 2; last output:\nboom\n(started by you: false)"));
    expect(bad).toMatchObject({ result: { text: "exit 2", tone: "bad" }, bad: true });
    expect(bad.body?.k === "shell" && bad.body.output?.lines).toEqual(["boom"]);
  });

  test("a notice of a shape it does not read: its first line, and its words whole inside", () => {
    const m = arrivalModel(arrival("job", "job job_4: became ready on port 3000\nmore"));
    expect(m).toMatchObject({ kind: "job", content: [{ t: "prose", s: "job job_4: became ready on port 3000" }], body: { k: "notice", text: "job job_4: became ready on port 3000\nmore" } });
    expect(arrivalModel(arrival("system", "you stopped the turn. these agents are still running")).kind).toBe("notice");
  });
});

describe("an agent row's link to its report", () => {
  test("goes to the arrival's row in the turn it came into, and the agent's ledger row says it reported", () => {
    const turns = turnsOf([
      you("u1", T0),
      agent("a1", T0 + 1000, [tool("spawn", T0 + 1100, { input: { name: "helper", message: "do it" }, metadata: { child_session_id: "ses_helper", path: "/root/helper" } }), tool("wait", T0 + 2000)]),
      mail("m1", T0 + 60_000, "report", "agent /root/helper reached status: parked"),
      mail("m2", T0 + 90_000, "report", "agent /root/helper reached status: parked\n\nready: done"),
      agent("a2", T0 + 91_000, [said("merged.", T0 + 91_100)]),
    ], "/");
    const t = turns[0] as Turn;
    const ctx: RowCtx = { reports: turns.flatMap(mailsOf), children: new Map(), thinking: "rows" };
    const spawn = t.items.find((x): x is Step => x.k === "step" && x.family === "spawn") as Step;
    /* the report with words is preferred to the status line alone */
    expect(reportFor(ctx, spawn)).toMatchObject({ part: "m2", turn: "u1", status: false });
    const m = stepModel(spawn, ctx);
    expect(m.link).toEqual({ report: "helper", turn: "u1", part: "m2" });
    expect(m.result.text).toBe("reported");
    /* the row it goes to is in the turn's ledger, under that part */
    const entries = ledgerOf()(t, ctx);
    expect(entries.find((e) => e.model?.partIDs.includes("m2"))?.model?.kind).toBe("report");
  });

  test("a status line alone stands in while it is all that came", () => {
    const turns = turnsOf([
      you("u1", T0),
      agent("a1", T0 + 1000, [tool("spawn", T0 + 1100, { input: { name: "helper", message: "do it" }, metadata: { child_session_id: "ses_helper" } })]),
      mail("m1", T0 + 60_000, "report", "agent /root/helper reached status: parked"),
    ], "/");
    const ctx: RowCtx = { reports: turns.flatMap(mailsOf), children: new Map(), thinking: "rows" };
    const spawn = turns[0]?.items.find((x): x is Step => x.k === "step" && x.family === "spawn") as Step;
    expect(reportFor(ctx, spawn)).toMatchObject({ part: "m1", status: true });
  });

  test("the reports a turn holds are read once per turn object", () => {
    const [t] = turnsOf([you("u1", T0), mail("m1", T0 + 9000, "report", "ready: done")], "/");
    expect(mailsOf(t as Turn)).toBe(mailsOf(t as Turn));
  });
});
