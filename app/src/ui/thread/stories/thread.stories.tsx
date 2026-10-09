/* the thread's stories (docs/thread.md, verification): one per part type per
   state, every one drawn from a scrubbed real session. this file is react
   (ladle's host) and mounts the solid components; it uses createElement
   because the project's jsx is solid's. */

import { type ReactElement, createElement, useEffect, useRef, useState } from "react";
import { type JSX as SolidJSX, createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { Item, Say, Step, Turn } from "../model";
import { type Child, type Row, type RowCtx, type RowModel, clock, endRows, kindOf, modelOf, rowsOf, stepModel } from "../rows";
import { watchMeasure } from "../measure";
import { isChain } from "../shell";
import { Answer, Ledger, MarkLine, ReportCard, RowView, SayRow, Tape, ThreadLog, TurnView, YouBubble } from "../thread";
import { type Loaded, type Tone, loadImported, loadNative, stepsOf } from "./fixtures";
import { ANSWER_WITH_CODE, FENCES_OF_ALL_SHAPES, HOSTILE_MARKUP, REPLY_IN_A_FENCE, REPLY_IN_A_LIST, REPORT_WITH_CODE } from "./code-sample";
import { type Question as Asked, LONG_ASK, TWO_QUESTIONS } from "./asks";
import { Host, TurnFrame } from "./host";
import { CodeReplay, LiveReplay } from "./replay";
import "./stories.css";

export default { title: "thread" };

/** a ladle story: a react component with a name. ladle's own type is not imported, since its sources would be checked as solid jsx */
type Story = (() => ReactElement) & { storyName?: string };

/* ---------- the host: a react story that mounts a solid tree once the fixture has loaded ---------- */

type Built = { tone: Tone; node: (wide: () => boolean) => SolidJSX.Element; note?: string };
type Build = () => Promise<Built>;

function story(name: string, build: Build): Story {
  const S: Story = () => {
    const ref = useRef<HTMLDivElement>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      let gone = false, dispose: (() => void) | undefined, ro: ResizeObserver | undefined;
      // the sample says its width to the stylesheet as the stage's scroller does (measure.ts)
      const unmeasure = watchMeasure(el);
      build().then((built) => {
        if (gone) return;
        el.style.setProperty("--tone", built.tone.tone);
        el.style.setProperty("--window-top", built.tone.top);
        el.style.setProperty("--window-bottom", built.tone.bottom);
        const [wide, setWide] = createSignal(el.offsetWidth >= 700);
        el.classList.toggle("wide", wide());
        // the border box: `wide` changes the sample's padding, so a content-box observer would notify itself again
        ro = new ResizeObserver(([entry]) => { const w = (entry?.borderBoxSize[0]?.inlineSize ?? el.offsetWidth) >= 700; setWide(w); el.classList.toggle("wide", w); });
        ro.observe(el, { box: "border-box" });
        if (built.note) setNote(built.note);
        const mount = el.querySelector<HTMLElement>(".mount");
        if (!mount) return;
        dispose = render(() => built.node(wide), mount);
        el.dataset["ready"] = "1";
      }).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
      return () => { gone = true; dispose?.(); ro?.disconnect(); unmeasure(); };
    }, []);
    return createElement("div", { ref, className: "stage-sample", "data-story": name },
      note ? createElement("p", { className: "story-note" }, note) : null,
      problem ? createElement("p", { className: "problem", role: "alert" }, problem) : null,
      createElement("div", { className: "mount" }));
  };
  S.storyName = name;
  return S;
}

/* ---------- picking examples from the fixtures ---------- */

const rowsIn = (turns: readonly Turn[]): Row[] => turns.flatMap((t) => rowsOf(t.items));
const turnAt = (l: Loaded, i: number): Turn => { const t = l.turns[i]; if (!t) throw new Error(`the fixture has no turn ${i}`); return t; };
const pickStep = (l: Loaded, pred: (s: Step) => boolean, what: string): Step => { const s = stepsOf(l.turns).find(pred); if (!s) throw new Error(`no ${what} in the fixture`); return s; };
const pickRow = (l: Loaded, pred: (r: Row) => boolean, what: string): Row => { const r = rowsIn(l.turns).find(pred); if (!r) throw new Error(`no ${what} in the fixture`); return r; };

/** one row, as the ledger would paint it */
type RowOpts = { open?: boolean; now?: number; live?: { text?: string; out?: string[] } };
function oneRow(l: Loaded, m: RowModel, opts: RowOpts = {}): Built {
  const model: RowModel = opts.open === undefined ? m : { ...m, open: opts.open };
  return { tone: l.tone, node: (wide) => createComponent(Host, { get wide() { return wide(); }, get children() { return createComponent(RowView, { m: model, time: clock(model.at), ...(opts.now !== undefined ? { now: opts.now } : {}), ...(opts.live ? { live: opts.live, cur: true } : {}) }); } }) };
}
const stepRow = (l: Loaded, s: Step, opts: RowOpts = {}): Built => oneRow(l, stepModel(s, { ...l.ctx, ...(opts.now !== undefined ? { now: opts.now } : {}) }), opts);
const oneTurn = (l: Loaded, t: Turn): Built => ({ tone: l.tone, node: (wide) => createComponent(Host, { get wide() { return wide(); }, ledger: false, get children() { return createComponent(TurnView, { turn: t, ctx: l.ctx }); } }) });
const inHost = (l: Loaded, make: () => SolidJSX.Element, ledger = false, end = false): Built => ({ tone: l.tone, node: (wide) => createComponent(Host, { get wide() { return wide(); }, ledger, end, get children() { return make(); } }) });

const northstar = () => loadImported("northstar");
const cmx = () => loadImported("cmx");
const notes = (label?: string) => loadNative(label);

/* ---------- turns ---------- */

export const WholeThreadNorthstar = story("a thread: the tvos session's excerpt", async () => { const l = await northstar(); return { tone: l.tone, node: (wide) => createComponent(ThreadLog, { turns: l.turns, ctx: l.ctx, get wide() { return wide(); } }) }; });
export const WholeThreadCmx = story("a thread: the cmx deploy's excerpt", async () => { const l = await cmx(); return { tone: l.tone, node: (wide) => createComponent(ThreadLog, { turns: l.turns, ctx: l.ctx, get wide() { return wide(); } }) }; });
export const WholeThreadNotes = story("a thread: the native session, settled", async () => { const l = await notes(); return { tone: l.tone, node: (wide) => createComponent(ThreadLog, { turns: l.turns, ctx: l.ctx, get wide() { return wide(); } }) }; });
export const TurnHeavyWithAgent = story("turn: heavy, 89 steps, one agent (the tape and the ledger)", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 1)); });
export const TurnLongPrompt = story("turn: a long prompt, clamped with show all", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 0)); });
export const TurnReportWithTests = story("turn: an agent's report, then tests", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 2)); });
export const TurnPush = story("turn: a push", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 3)); });
export const TurnCompaction = story("turn: compacted here", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 4)); });
export const TurnStopped = story("turn: you stopped it", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 5)); });
export const TurnFailedEditWithAnswer = story("turn: a failed edit, then the answer", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 6)); });
export const TurnDeployWithAsks = story("turn: a deploy with a commit, pushes, two asks, stopped", async () => { const l = await cmx(); return oneTurn(l, turnAt(l, 1)); });
export const TurnTestsMany = story("turn: 109 steps, twelve test runs, one failed", async () => { const l = await cmx(); return oneTurn(l, turnAt(l, 0)); });

/* ---------- text ---------- */

export const YouTyped = story("text, user, typed: your message", async () => { const l = await cmx(); return inHost(l, () => createComponent(YouBubble, { turn: turnAt(l, 1) })); });
export const YouQueued = story("text, user, queued: your message that waited", async () => { const l = await notes(); const t = l.turns.find((x) => x.by === "queued") ?? { ...turnAt(l, 1), by: "queued" as const }; return inHost(l, () => createComponent(YouBubble, { turn: t })); });
export const YouSteer = story("text, user, steer: a steer into the running turn", async () => { const l = await notes(); const t = { ...turnAt(l, 0), by: "steer" as const }; return { ...inHost(l, () => createComponent(YouBubble, { turn: t })), note: "the origin is set on the turn; the fixture's steer is recorded in session.steered, which the model reads from the event log" }; });
export const ReportFromAgent = story("text, user, mail: an agent's report", async () => { const l = await northstar(); return inHost(l, () => createComponent(ReportCard, { turn: turnAt(l, 2) })); });
export const NoticeFromRuntime = story("text, user, notice: a runtime notice", async () => { const l = await notes(); const t = l.turns.find((x) => x.by === "notice"); if (!t) throw new Error("no notice in the fixture"); return inHost(l, () => createComponent(MarkLine, { turn: t })); });
export const SaidSettled = story("text, assistant, settled: what it said", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "say", "said row"); if (r.k !== "say") throw new Error(); return inHost(l, () => createComponent(SayRow, { say: r.say, time: clock(r.at) }), true); });
export const SaidStreaming = story("text, assistant, streaming: with the caret, the newest row of a running turn", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "say", "said row"); if (r.k !== "say") throw new Error(); return inHost(l, () => createComponent(SayRow, { say: { ...r.say, text: r.say.text.slice(0, Math.floor(r.say.text.length * 0.6)), streaming: true }, time: clock(r.at) }), true); });
export const AnswerMarkdown = story("text, assistant, the answer: markdown at reading measure", async () => { const l = await cmx(); const t = l.turns.find((x) => x.answer); if (!t?.answer) throw new Error("no answer in the fixture"); return inHost(l, () => createComponent(Answer, { say: t.answer as NonNullable<Turn["answer"]> })); });

/* ---------- code in the markdown, and the copy controls ---------- */

const said = (l: Loaded, text: string, streaming = false): Say => ({ k: "say", id: "prt_code", text, at: turnAt(l, 0).at, streaming });
export const AnswerWithCode = story("the answer with code: a block for every language, highlighted, each with its copy control, and the reply's under it", async () => { const l = await cmx(); return inHost(l, () => createComponent(TurnFrame, { get children() { return createComponent(Answer, { say: said(l, ANSWER_WITH_CODE) }); } })); });
export const ReportWithCode = story("text, user, mail: a report with code, its copy control in the card's header", async () => { const l = await northstar(); return inHost(l, () => createComponent(ReportCard, { turn: { ...turnAt(l, 2), prompt: REPORT_WITH_CODE } })); });
export const SaidStreamingInAListFence = story("text, assistant, streaming: part-way through a fence inside a list item, the open block holds back its control", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, REPLY_IN_A_LIST, true), time: clock(turnAt(l, 0).at) }), true); });
export const SaidFencesOfAllShapes = story("text, assistant, settled: a fence in a quote, an unlabelled block of several lines, an unlabelled line", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, FENCES_OF_ALL_SHAPES), time: clock(turnAt(l, 0).at) }), true); });
export const SaidHostileMarkup = story("text, assistant: html written to look like our controls loses its classes and its button", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, HOSTILE_MARKUP), time: clock(turnAt(l, 0).at) }), true); });
export const SaidStreamingThroughFences = story("text, assistant, streaming: a reply written through prose and fences, its settled blocks keeping their nodes (data-replaced stays 0)", async () => { const l = await cmx(); return { ...inHost(l, () => createComponent(CodeReplay, { text: ANSWER_WITH_CODE, at: turnAt(l, 0).at }), true) }; });
export const SaidWithCode = story("text, assistant, settled: a said row with a code block (no reply control mid-turn)", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, ANSWER_WITH_CODE.split("run the suite")[0] ?? ""), time: clock(turnAt(l, 0).at) }), true); });
export const SaidStreamingInAFence = story("text, assistant, streaming: part-way through a fence, the open block holds back its control", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, REPLY_IN_A_FENCE, true), time: clock(turnAt(l, 0).at) }), true); });

/* ---------- reasoning ---------- */

export const ThoughtOne = story("reasoning, settled: one thought", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "think" && x.thoughts.length === 1, "single thought"); if (r.k !== "think") throw new Error(); return oneRow(l, modelOf(r, l.ctx)); });
export const ThoughtsFolded = story("reasoning, settled: thoughts folded", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "think" && x.thoughts.length > 1, "folded thoughts"); if (r.k !== "think") throw new Error(); return oneRow(l, modelOf(r, l.ctx)); });
export const ThoughtsOpen = story("reasoning, open: every word", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "think" && x.thoughts.length > 1, "folded thoughts"); if (r.k !== "think") throw new Error(); return oneRow(l, modelOf(r, { ...l.ctx, thinking: "open" })); });
export const ThoughtStreaming = story("reasoning, streaming: thinking with a clock", async () => {
  const l = await northstar(); const r = pickRow(l, (x) => x.k === "think" && x.thoughts[0] !== undefined && x.thoughts[0].text.length > 400, "long thought"); if (r.k !== "think") throw new Error();
  const th = r.thoughts[0] as NonNullable<(typeof r.thoughts)[0]>;
  const text = th.text.slice(0, 500);
  const live = { ...r, thoughts: [{ ...th, text, streaming: true }] };
  const now = th.at + 36_000;
  return oneRow(l, modelOf(live, { ...l.ctx, now }), { now, live: { text } });
});

/* ---------- tools: run ---------- */

export const RunCompleted = story("tool run, completed: one command", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "shell" && s.status === "completed" && !isChain(s.object) && s.polls === undefined && s.ms >= 1500 && !s.evidence?.kind.match(/tests|build|commit|push/), "plain command")); });
export const RunCompletedOpen = story("tool run, completed, open: facts and output", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "shell" && s.status === "completed" && !isChain(s.object) && s.polls === undefined && (s.outputLines ?? 0) > 5, "command with output"), { open: true }); });
export const RunChain = story("tool run, completed: a chain, named in order", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "shell" && s.status === "completed" && isChain(s.object) && s.polls === undefined, "chain")); });
export const RunChainOpen = story("tool run, completed, open: the whole chain", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "shell" && s.status === "completed" && isChain(s.object) && s.polls === undefined, "chain"), { open: true }); });
export const RunTestsPassed = story("tool run, completed: tests passed, with the meter", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.evidence?.kind === "tests" && s.evidence.failed === 0, "passing tests")); });
export const RunTestsFailed = story("tool run, completed: tests failed", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.evidence?.kind === "tests" && s.evidence.failed > 0, "failing tests")); });
export const RunBuildOk = story("tool run, completed: a clean build", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.evidence?.kind === "build" && s.evidence.ok, "clean build")); });
export const RunFailed = story("tool run, error: a failed command, open", async () => { const l = await cmx(); const s = stepsOf(l.turns).find((x) => x.family === "shell" && x.status === "error" && !x.interrupted) ?? pickStep(l, (x) => x.status === "error" && !x.interrupted, "failed step"); return stepRow(l, s); });
export const RunRunning = story("tool run, running: a live clock and the output so far", async () => {
  const l = await northstar(); const s = pickStep(l, (x) => x.family === "shell" && x.status === "completed" && (x.outputLines ?? 0) > 10 && x.ms > 5000, "long command");
  const lines = (s.output?.lines ?? []).slice(0, 6);
  const running: Step = { ...s, status: "running", ms: 0, output: { lines, cut: 0, cutAt: -1 } };
  delete (running as { evidence?: unknown }).evidence;
  delete (running as { exit?: unknown }).exit;
  delete (running as { outputLines?: unknown }).outputLines;
  return stepRow(l, running, { now: s.at + 12_000, live: { out: lines } });
});
export const RunPending = story("tool run, pending: waiting to start", async () => { const l = await northstar(); const s = pickStep(l, (x) => x.family === "shell" && x.status === "completed" && !isChain(x.object), "command"); const pending: Step = { ...s, status: "pending", ms: 0 }; delete (pending as { output?: unknown }).output; delete (pending as { evidence?: unknown }).evidence; return stepRow(l, pending, { now: s.at + 1000 }); });
export const RunWatch = story("tool watch, completed: reading a running command", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.polls !== undefined && !s.typed, "poll")); });
export const RunType = story("tool type, completed: typing into a running command", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.polls !== undefined && !!s.typed, "typed input")); });
export const RunCommit = story("tool commit: the subject and the hash", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.evidence?.kind === "commit", "commit")); });
export const RunPush = story("tool push: the branch and a tick", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.evidence?.kind === "push", "push")); });
export const RunStopped = story("tool run, interrupted: stopped by you", async () => { const l = await northstar(); const s = stepsOf(l.turns).find((x) => x.status === "error" && x.interrupted); if (!s) { const any = pickStep(l, (x) => x.family === "shell", "command"); return { ...stepRow(l, { ...any, status: "error", interrupted: true, error: "MessageAbortedError" }), note: "no interrupted step in the fixture; this one is the abort shape applied to a real command" }; } return stepRow(l, s); });

/* ---------- tools: edit, write, read ---------- */

export const EditCompleted = story("tool edit, completed: counts, then the diff", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.tool === "edit" && s.status === "completed" && s.diff !== undefined, "edit with a diff")); });
export const EditCompletedOpen = story("tool edit, completed, open: the file line and the diff", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.tool === "edit" && s.status === "completed" && s.diff !== undefined && (s.hunks?.length ?? 0) > 0, "edit with hunks"), { open: true }); });
export const EditFailed = story("tool edit, error: open, with the reason", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.tool === "edit" && s.status === "error" && !s.interrupted, "failed edit")); });
export const EditNativeNoDiff = story("tool edit, completed, native: no diff yet (ask a16)", async () => { const l = await notes(); return stepRow(l, pickStep(l, (s) => s.tool === "edit" && s.status === "completed", "native edit"), { open: true }); });
export const EditPermissionPending = story("tool edit, pending: wants your permission", async () => { const l = await notes("permission pending: edit notes.md"); return stepRow(l, pickStep(l, (s) => s.permission !== undefined, "pending permission")); });
export const EditPermissionDenied = story("tool edit, error: you denied it", async () => { const l = await notes(); return stepRow(l, pickStep(l, (s) => s.tool === "edit" && s.status === "error", "denied edit")); });
export const WriteNew = story("tool write, completed: a new file", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.tool === "write" && /^new/.test(s.result), "new file"), { open: true }); });
export const WriteOver = story("tool write, completed: a file written whole", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.tool === "write" && s.status === "completed", "write")); });
export const ReadOne = story("tool read, completed: one file", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length === 1, "single read"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx)); });
export const ReadPartial = story("tool read, completed: part of a file, with the file line", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length === 1 && x.steps[0]?.span?.total !== undefined && (x.steps[0].span.end - x.steps[0].span.start + 1) < x.steps[0].span.total, "partial read"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx), { open: true }); });
export const ReadFolded = story("tool read, completed: a run of reads, named", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length > 1 && x.steps.length <= 6, "folded reads"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx)); });
export const ReadFoldedOpen = story("tool read, completed, open: every file with its span", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length > 1, "folded reads"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx), { open: true }); });
export const ReadFailed = story("tool read, error", async () => { const l = await notes(); return stepRow(l, pickStep(l, (s) => s.family === "read" && s.status === "error", "failed read")); });

/* ---------- tools: search, web ---------- */

export const Grep = story("tool grep, completed: the pattern and its hits", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "fold" && x.tool === "grep" && x.steps.length === 1 && (x.steps[0]?.hits?.length ?? 0) > 0, "grep with hits"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx), { open: true }); });
export const GrepFolded = story("tool grep, completed: searches folded", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "fold" && x.tool === "grep" && x.steps.length > 1, "folded greps"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx)); });

/* ---------- tools: agents, asks, plans ---------- */

export const AgentReported = story("tool agent, completed: reported", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "spawn" && s.agent?.child !== undefined, "agent with a session"), { open: true }); });
export const AgentDidNotStart = story("tool agent, completed: never started", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "spawn" && s.agent?.child === undefined, "agent without a session"), { open: true }); });
export const AgentWorking = story("tool agent, live: working alongside, with a clock", async () => { const l = await northstar(); const s = pickStep(l, (x) => x.family === "spawn" && x.agent?.child !== undefined, "agent"); return stepRow(l, s, { now: s.at + 190_000 }); });
/** the agent row after its turn ended, read from the child's own state (docs/thread.md, agents): the fixture's child is
    recast in each state, the turns after the spawn dropped so no report has arrived yet */
function agentIn(l: Loaded, state: Child["state"]): { l: Loaded; s: Step; tick: number } {
  const s = pickStep(l, (x) => x.family === "spawn" && x.agent?.child !== undefined, "agent");
  const held = l.ctx.children.get(s.agent?.child ?? "");
  if (!held) throw new Error("the agent has no child in the fixture");
  const children = new Map(l.ctx.children);
  children.set(s.agent?.child ?? "", { ...held, state, since: s.at });
  const turns = l.turns.filter((t) => t.at <= s.at);
  return { l: { ...l, turns, ctx: { ...l.ctx, turns, children } }, s, tick: s.at + 412_000 };
}
export const AgentWorkingAfterTheTurn = story("tool agent, the turn done, its child still working: the clock runs on, the door opens its thread", async () => { const { l, s, tick } = agentIn(await northstar(), "working"); return oneRow(l, stepModel(s, { ...l.ctx, tick }), { open: true }); });
export const AgentWantsYou = story("tool agent: its child waits on you", async () => { const { l, s } = agentIn(await northstar(), "wants"); return oneRow(l, stepModel(s, l.ctx), { open: true }); });
export const AgentParked = story("tool agent: its child is parked on agents of its own", async () => { const { l, s } = agentIn(await northstar(), "parked"); return oneRow(l, stepModel(s, l.ctx), { open: true }); });
export const QuestionPending = story("tool ask, pending: options in place", async () => { const l = await notes("question pending: greeting"); return stepRow(l, pickStep(l, (s) => s.family === "ask" && s.status !== "completed" && s.status !== "error", "pending question")); });
/** the pending question's step, asking `questions` instead of "which greeting": what a real agent writes, which the recording does not hold */
const asked = async (questions: readonly Asked[]): Promise<Built> => {
  const l = await notes("question pending: greeting");
  const s = pickStep(l, (x) => x.family === "ask" && x.status !== "completed" && x.status !== "error", "pending question");
  return stepRow(l, { ...s, questions: questions.map((q) => ({ header: q.header, question: q.question, options: q.options, custom: q.custom, multiple: q.multiple === true, answer: undefined })) });
};
export const QuestionLongPending = story("tool ask, pending: a header, a four line question, three options of three to five lines each", () => asked(LONG_ASK));
export const QuestionTwoPending = story("tool ask, pending: two questions in one ask, answered together", () => asked(TWO_QUESTIONS));
export const QuestionAnswered = story("tool ask, completed: answered", async () => { const l = await notes(); return stepRow(l, pickStep(l, (s) => s.family === "ask" && s.status === "completed", "answered question"), { open: true }); });
export const QuestionDismissed = story("tool ask, error: dismissed", async () => { const l = await notes(); return stepRow(l, pickStep(l, (s) => s.family === "ask" && s.status === "error", "dismissed question"), { open: true }); });
export const AskInProse = story("tool ask, completed: a long question the agent wrote", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.family === "ask" && s.object.length > 80, "long question")); });
export const Skill = story("tool skill", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "skill", "skill")); });
export const Find = story("tool find, completed: a glob and its files", async () => { const all = [await northstar(), await cmx()]; const l = all.find((x) => stepsOf(x.turns).some((s) => s.tool === "glob")) ?? all[0]; if (!l) throw new Error(); return stepRow(l, pickStep(l, (s) => s.tool === "glob", "glob"), { open: true }); });
export const Plan = story("tool plan, completed: the current item, then every item", async () => { const all = [await northstar(), await cmx()]; const l = all.find((x) => stepsOf(x.turns).some((s) => s.family === "plan")) ?? all[0]; if (!l) throw new Error(); return stepRow(l, pickStep(l, (s) => s.family === "plan", "plan"), { open: true }); });
export const Agents = story("tool agents: listing or closing agents", async () => { const all = [await northstar(), await cmx()]; const l = all.find((x) => stepsOf(x.turns).some((s) => s.family === "agents")) ?? all[0]; if (!l) throw new Error(); return stepRow(l, pickStep(l, (s) => s.family === "agents", "agents step")); });

/* ---------- the turn's last rows ---------- */

export const FilesRow = story("files: what the turn changed", async () => { const l = await northstar(); const m = endRows(turnAt(l, 1)).find((x) => x.kind === "files"); if (!m) throw new Error("no files row"); return oneRow(l, m); });
export const FilesRowOpen = story("files, open: every file with its counts", async () => { const l = await northstar(); const m = endRows(turnAt(l, 1)).find((x) => x.kind === "files"); if (!m) throw new Error("no files row"); return oneRow(l, m, { open: true }); });
export const StoppedRow = story("stopped: you stopped it", async () => { const l = await northstar(); const m = endRows(turnAt(l, 5)).find((x) => x.kind === "stopped"); if (!m) throw new Error("no stopped row"); return oneRow(l, m); });
export const FailedRow = story("failed: the turn failed", async () => { const l = await northstar(); const t: Turn = { ...turnAt(l, 6), status: "failed", error: "the provider returned 529: overloaded" }; const m = endRows(t).find((x) => x.kind === "failed"); if (!m) throw new Error("no failed row"); return { ...oneRow(l, m), note: "no failed turn in the fixtures; this is the failed shape on a real turn" }; });
export const GapBetweenRows = story("a gap: minutes later", async () => { const l = await northstar(); const t = l.turns.find((x) => { const rows = rowsOf(x.items); let prev = x.at; return rows.some((r) => { const g = r.at - prev > 90_000; prev = Math.max(prev, r.end); return g; }); }); if (!t) throw new Error("no gap in the fixture"); return inHost(l, () => createComponent(Ledger, { turn: t, ctx: l.ctx })); });

/* ---------- the tape ---------- */

export const TapeHeavy = story("tape: a 32 minute turn with an agent", async () => { const l = await northstar(); return inHost(l, () => createComponent(Tape, { turn: turnAt(l, 1), ctx: l.ctx })); });
export const TapeStopped = story("tape: a turn you stopped", async () => { const l = await northstar(); return inHost(l, () => createComponent(Tape, { turn: turnAt(l, 5), ctx: l.ctx })); });
export const TapeLive = story("tape, live: the scale runs ahead, the head travels", async () => { const l = await northstar(); const t = turnAt(l, 1); const now = t.at + 4 * 60_000 + 20_000; const live: Turn = { ...t, items: t.items.filter((x) => x.at <= now), status: "working" }; return inHost(l, () => createComponent(Tape, { turn: live, ctx: l.ctx, now, live: true })); });

/* ---------- live ---------- */

export const LiveShort = story("live: a 27 step turn replayed at speed, pinned at the end, to its settle", async () => { const l = await cmx(); return inHost(l, () => createComponent(LiveReplay, { turn: turnAt(l, 2), ctx: l.ctx }), false, true); });
export const LiveHeavy = story("live: the 32 minute turn replayed at speed (about three minutes), pinned at the end, to its settle", async () => { const l = await northstar(); return inHost(l, () => createComponent(LiveReplay, { turn: turnAt(l, 1), ctx: l.ctx }), false, true); });

/** a turn as it stands while it runs: the model calls its trailing prose the answer once settled, and the ledger shows it as
    its newest said row until then */
const running = (t: Turn, items: readonly Item[], extra: Partial<Turn> = {}): Turn => { const { answer: _settled, ...rest } = t; return { ...rest, items: [...items], status: "working", ...extra }; };
const live = (l: Loaded, turn: Turn, now: number, end = true): Built => inHost(l, () => createComponent(TurnView, { turn, ctx: l.ctx, live: true, now }), false, end);

/** a running turn cut at its n-th item with one part arriving as cmx2's contract v5 announces them: the part is born
    streaming with its time.start and grows by deltas */
function arriving(l: Loaded, t: Turn, keep: number, part: { say: string } | { think: string }): Built {
  const items = t.items.slice(0, keep);
  const at = (items.at(-1)?.at ?? t.at) + 3_000;
  const now = at + 7_000;
  const turn = "say" in part
    ? running(t, items, { answer: { k: "say", id: "prt_arriving", text: part.say, at, streaming: true } })
    : running(t, [...items, { k: "think", id: "prt_arriving", text: part.think, ms: 0, at, streaming: true }]);
  return live(l, turn, now);
}
const REPLY = "the deploy is done and the three services came up in order.\n\n- **api**: healthy on the first check\n- **worker**: failed its first health check and passed on the second, so nothing needs your hand\n- **web**: healthy, and `build 4812` is the one that is live\n\ni left the old build in place for a day in case you want it back, and the notes say how to";
export const ReplyStreaming = story("text, assistant, streaming, live: the reply streams as the newest row at full height, with its caret", async () => { const l = await cmx(); return arriving(l, turnAt(l, 2), 6, { say: REPLY }); });
export const ReplyAnnounced = story("text, assistant, announced: the row is there at the start of the reply, empty, with its caret", async () => { const l = await cmx(); return arriving(l, turnAt(l, 2), 6, { say: "" }); });
export const ThinkingStreaming = story("reasoning, streaming, live: thinking, a running clock, its words in the box", async () => { const l = await cmx(); return arriving(l, turnAt(l, 2), 6, { think: "the health check failed once and then passed, which points at a service that was slow to start rather than one that is broken. before saying it is fine i want to read the second service's log, since a pass after a fail can also mean the check was only retried and the cause is still there, waiting for the next deploy to show itself." }); });
export const ThinkingAnnounced = story("reasoning, announced: the thinking row opens with its clock before the first word", async () => { const l = await cmx(); return arriving(l, turnAt(l, 2), 6, { think: "" }); });
export const CommandRunningLive = story("live: a command running at the end of the ledger, the rows above it closed and openable", async () => {
  const l = await northstar();
  const s = pickStep(l, (x) => x.family === "shell" && x.status === "completed" && (x.outputLines ?? 0) > 10 && x.ms > 5000, "long command");
  const t = l.turns.find((x) => x.items.includes(s));
  if (!t) throw new Error("the command has no turn");
  const lines = (s.output?.lines ?? []).slice(0, 8);
  const going: Step = { ...s, status: "running", ms: 0, output: { lines, cut: 0, cutAt: -1 } };
  delete (going as { evidence?: unknown }).evidence;
  delete (going as { exit?: unknown }).exit;
  delete (going as { outputLines?: unknown }).outputLines;
  return live(l, running(t, [...t.items.slice(0, t.items.indexOf(s)), going]), s.at + 12_000);
});
export const AskPendingLive = story("live: a question waits in a running turn, its row open where it was asked", async () => {
  const l = await notes("question pending: greeting");
  const t = l.turns.at(-1);
  if (!t) throw new Error("no turn in the snapshot");
  return live(l, running(t, t.items), (t.items.at(-1)?.at ?? t.at) + 9_000);
});
export const HeavyLiveStuck = story("live: twelve minutes into a heavy turn, the tape stuck at the foot of the view while the rows run on above it", async () => {
  const l = await northstar();
  const t = turnAt(l, 1);
  const now = t.at + 12 * 60_000;
  return live(l, running(t, t.items.filter((x) => x.at <= now)), now, false);
});

export const EditRunningLive = story("live: an edit at the end of the ledger, its diff in the box that follows its newest line", async () => {
  const l = await cmx();
  const s = pickStep(l, (x) => x.tool === "edit" && x.status === "completed" && x.diff !== undefined && (x.hunks?.length ?? 0) > 0, "edit with a diff");
  const t = l.turns.find((x) => x.items.includes(s));
  if (!t) throw new Error("the edit has no turn");
  return live(l, running(t, t.items.slice(0, t.items.indexOf(s) + 1)), s.at + 2_000);
});
export const GapLive = story("live: a quiet stretch inside a running turn keeps its 'N min later' line", async () => {
  const l = await northstar();
  for (const t of l.turns) {
    const rows = rowsOf(t.items);
    let prev = t.at;
    const at = rows.findIndex((r) => { const gap = r.at - prev > 90_000; prev = Math.max(prev, r.end); return gap; });
    const from = rows[at];
    if (!from) continue;
    // the turn from the first row after the pause, so its line is the first thing the ledger shows
    const cut = rows[Math.min(rows.length, at + 4) - 1]?.end ?? t.end;
    return live(l, running(t, t.items.filter((x) => x.at >= from.at && x.at <= cut)), cut + 5_000, false);
  }
  throw new Error("no gap in the fixture");
});

/* ---------- coverage: which kinds and states the fixtures really hold ---------- */

export const Coverage: Story = () => {
  const [rows, setRows] = useState<Array<[string, string, number]>>([]);
  useEffect(() => {
    void Promise.all([northstar(), cmx(), notes()]).then((all) => {
      const counts = new Map<string, number>();
      for (const l of all) for (const s of stepsOf(l.turns)) { const k = `${kindOf(s)}\u0000${s.status}${s.interrupted ? " (interrupted)" : ""}${s.permission ? " (permission)" : ""}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
      for (const l of all) for (const t of l.turns) { for (const it of t.items) if (it.k !== "step") { const k = `${it.k === "say" ? "said" : "thought"}\u0000${it.streaming ? "streaming" : "settled"}`; counts.set(k, (counts.get(k) ?? 0) + 1); } counts.set(`turn\u0000${t.status}, ${t.by}`, (counts.get(`turn\u0000${t.status}, ${t.by}`) ?? 0) + 1); }
      setRows([...counts].map(([k, v]) => { const [a, b] = k.split("\u0000"); return [a ?? "", b ?? "", v] as [string, string, number]; }).sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1])));
    });
  }, []);
  return createElement("div", { className: "stage-sample coverage", "data-ready": rows.length ? "1" : undefined },
    createElement("p", { className: "story-note" }, "every kind and state the three fixtures hold, counted. a state with no row here has no real example yet and its story says so."),
    createElement("table", null, createElement("thead", null, createElement("tr", null, createElement("th", null, "kind"), createElement("th", null, "state"), createElement("th", null, "examples"))),
      createElement("tbody", null, ...rows.map(([k, s, c]) => createElement("tr", { key: `${k}-${s}` }, createElement("td", null, k), createElement("td", null, s), createElement("td", null, String(c)))))));
};
Coverage.storyName = "coverage: kinds and states in the fixtures";
