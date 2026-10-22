/* the thread's stories (docs/thread.md, verification): one per part type per
   state, every one drawn from a scrubbed real session. this file is react
   (ladle's host) and mounts the solid components; it uses createElement
   because the project's jsx is solid's. */

import { type ReactElement, createElement, useEffect, useRef, useState } from "react";
import { type JSX as SolidJSX, createComponent, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { type Item, type Say, type Step, type Turn, turnsOf } from "../model";
import type { WireMessage } from "../wire";
import { neutralMessage } from "../../../sync/fixtures/neutral";
import { type Child, type FoldRow, type Row, type RowCtx, type RowModel, clock, endRows, foldModel, kindOf, modelOf, rowsOf, stepModel } from "../rows";
import { watchMeasure } from "../measure";
import { isChain } from "../shell";
import { Answer, Ledger, MarkLine, ReportCard, RowView, SayRow, ThreadLog, TurnView, YouBubble } from "../thread";
import { orderedStrip } from "../groups";
import { StripLane } from "../strip";
import { AskCard } from "../../asks/card";
import type { AskReply } from "../../../sync/replies";
import { type Loaded, type Tone, loadImported, loadNative, stepsOf } from "./fixtures";
import { ANSWER_WITH_CODE, FENCES_OF_ALL_SHAPES, GITHUB_READING, HOSTILE_MARKUP, REPLY_IN_A_FENCE, REPLY_IN_A_LIST, REPORT_WITH_CODE } from "./code-sample";
import { type Question as Asked, FOUR_QUESTIONS, LONG_ASK, MARKDOWN_ASK, TWO_QUESTIONS } from "./asks";
import { HomeFrame, Host, TurnFrame } from "./host";
import { picture } from "./pictures";
import { CodeReplay, LiveReplay } from "./replay";
import { UnitsCheck } from "./units-check";
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
export const TurnHeavyWithAgent = story("turn: heavy, 89 steps, one agent (its runs folded into groups between its words)", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 1)); });
export const TurnLongPrompt = story("turn: a long prompt, clamped with show all", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 0)); });
export const TurnReportWithTests = story("turn: an agent's report, then tests", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 2)); });
export const TurnPush = story("turn: a push", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 3)); });
export const TurnCompaction = story("turn: compacted here, recorded before the summary was marked (its last words are the summary)", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 4)); });
/** a turn cmx2 compacted mid-turn: the summary marked, then the turn's own work and answer */
const compacted = (l: Loaded): Turn => ({ ...turnAt(l, 2), by: "compaction", compacted: true, prompt: "", summary: turnAt(l, 2).prompt });
export const TurnCompactionContinues = story("turn: compacted mid-turn, the turn reads as any turn under its mark", async () => { const l = await northstar(); return oneTurn(l, compacted(l)); });
export const TurnCompactionSummaryOpen = story("turn: compacted mid-turn, the mark opened to its summary in a well under it", async () => { const l = await northstar(); const built = oneTurn(l, compacted(l)); return { ...built, node: (wide) => createComponent(Pressed, { press: ".turn-mark button", get children() { return built.node(wide); } }) }; });
export const TurnStopped = story("turn: you stopped it", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 5)); });
export const TurnFailedEditWithAnswer = story("turn: a failed edit, then the answer", async () => { const l = await northstar(); return oneTurn(l, turnAt(l, 6)); });
export const TurnDeployWithAsks = story("turn: a deploy with a commit, pushes, two asks, stopped", async () => { const l = await cmx(); return oneTurn(l, turnAt(l, 1)); });
export const TurnTestsMany = story("turn: 109 steps, twelve test runs, one failed", async () => { const l = await cmx(); return oneTurn(l, turnAt(l, 0)); });

/* ---------- text ---------- */

export const YouTyped = story("text, user, typed: your message", async () => { const l = await cmx(); return inHost(l, () => createComponent(YouBubble, { turn: turnAt(l, 1) })); });
export const YouPhotos = story("text and file, user: photos sent above your words, each opening full size", async () => { const l = await cmx(); const t: Turn = { ...turnAt(l, 1), prompt: "the strip looks off on the ipad, see these", photos: [picture("ipad-strip.png", 210), picture("ipad-strip-dark.png", 250, 400, 640), picture("phone.jpg", 30, 640, 400, "image/jpeg")] }; return inHost(l, () => createComponent(TurnFrame, { get children() { return createComponent(YouBubble, { turn: t }); } })); });
export const YouFiles = story("text and file, user: a photo, a pdf and a text file sent with your words, the files named above them", async () => { const l = await cmx(); const t: Turn = { ...turnAt(l, 1), prompt: "check the dates against the plan", photos: [picture("ipad-strip.png", 210)], sentFiles: [{ filename: "booking-confirmation-lisbon-final.pdf", mime: "application/pdf" }, { filename: "plan.md", mime: "text/plain" }] }; return inHost(l, () => createComponent(TurnFrame, { get children() { return createComponent(YouBubble, { turn: t }); } })); });
export const YouPhotoOpen = story("file, user: a photo opened full size, its name and the one close over it", async () => { const l = await cmx(); const t: Turn = { ...turnAt(l, 1), prompt: "the strip looks off on the ipad, see these", photos: [picture("ipad-strip-dark-from-the-review.png", 250, 400, 640)] }; return inHost(l, () => createComponent(Pressed, { press: ".pv-t", get children() { return createComponent(TurnFrame, { get children() { return createComponent(YouBubble, { turn: t }); } }); } })); });
export const YouPhotoAlone = story("file, user: a photo sent alone, its bubble keeps its time", async () => { const l = await cmx(); const t: Turn = { ...turnAt(l, 1), prompt: "", photos: [picture("whiteboard.png", 120, 640, 480)] }; return inHost(l, () => createComponent(TurnFrame, { get children() { return createComponent(YouBubble, { turn: t }); } })); });
export const ReportFromAgent = story("text, user, mail: an agent's report", async () => { const l = await northstar(); return inHost(l, () => createComponent(ReportCard, { turn: turnAt(l, 2) })); });
export const NoticeFromRuntime = story("text, user, notice: a runtime notice", async () => { const l = await notes(); const t = l.turns.find((x) => x.by === "notice"); if (!t) throw new Error("no notice in the fixture"); return inHost(l, () => createComponent(MarkLine, { turn: t })); });
export const SaidSettled = story("text, assistant, settled: what it said", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "say", "said row"); if (r.k !== "say") throw new Error(); return inHost(l, () => createComponent(SayRow, { say: r.say, time: clock(r.at) }), true); });
export const SaidStreaming = story("text, assistant, streaming: with the caret, the newest row of a running turn", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "say", "said row"); if (r.k !== "say") throw new Error(); return inHost(l, () => createComponent(SayRow, { say: { ...r.say, text: r.say.text.slice(0, Math.floor(r.say.text.length * 0.6)), streaming: true }, time: clock(r.at) }), true); });
export const AnswerMarkdown = story("text, assistant, the answer: markdown at reading measure", async () => { const l = await cmx(); const t = l.turns.find((x) => x.answer); if (!t?.answer) throw new Error("no answer in the fixture"); return inHost(l, () => createComponent(Answer, { say: t.answer as NonNullable<Turn["answer"]> })); });

/* ---------- code in the markdown, and the copy controls ---------- */

const said = (l: Loaded, text: string, streaming = false): Say => ({ k: "say", id: "prt_code", text, at: turnAt(l, 0).at, streaming });
export const AnswerWithCode = story("the answer with code: a block for every language, highlighted, each with its copy control, and the reply's under it", async () => { const l = await cmx(); return inHost(l, () => createComponent(TurnFrame, { get children() { return createComponent(Answer, { say: said(l, ANSWER_WITH_CODE) }); } })); });
export const ReportOutcomes = story("text, user, mail: report chips, one line each: ready, blocked, failed, a note, and a first word that says no outcome", async () => {
  const l = await northstar();
  const t = turnAt(l, 2);
  const chips: Turn[] = [
    { ...t, id: "r1", from: "stepgroups", prompt: "ready to merge cd16978: the groups replace the tape, tests green" },
    { ...t, id: "r2", from: "zoomshots", prompt: "blocked: the zoom shots wait on the simulator image, which the build machine has not pushed yet" },
    { ...t, id: "r3", from: "deploy_web", prompt: "## failed\n\nthe health check never passed" },
    { ...t, id: "r4", from: "worker_a", note: true, prompt: "the fixture has a second steer at 17:21 you may want for the story" },
    { ...t, id: "r5", from: "transport_impl", prompt: "**Summary**: rewrote the transport so frames are paced by the display link" },
  ];
  return inHost(l, () => createComponent(TurnFrame, { get children() { return chips.map((turn) => createComponent(ReportCard, { turn })); } }));
});
export const ReportSheetOpen = story("text, user, mail: a press on the chip raises the whole report in its sheet, at half the screen", async () => { const l = await northstar(); return inHost(l, () => createComponent(Pressed, { press: "button.report", get children() { return createComponent(ReportCard, { turn: { ...turnAt(l, 2), prompt: `ready to merge: ${REPORT_WITH_CODE}` } }); } })); });
export const ReportSheetWhole = story("text, user, mail: the report's sheet taken whole, a report with code", async () => { const l = await northstar(); return inHost(l, () => createComponent(Pressed, { press: ".rep-grab", get children() { return createComponent(Pressed, { press: "button.report", get children() { return createComponent(ReportCard, { turn: { ...turnAt(l, 2), prompt: REPORT_WITH_CODE } }); } }); } })); });
export const SaidStreamingInAListFence = story("text, assistant, streaming: part-way through a fence inside a list item, the open block holds back its control", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, REPLY_IN_A_LIST, true), time: clock(turnAt(l, 0).at) }), true); });
export const SaidFencesOfAllShapes = story("text, assistant, settled: a fence in a quote, an unlabelled block of several lines, an unlabelled line", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, FENCES_OF_ALL_SHAPES), time: clock(turnAt(l, 0).at) }), true); });
export const SaidHostileMarkup = story("text, assistant: html written to look like our controls loses its classes and its button", async () => { const l = await cmx(); return inHost(l, () => createComponent(SayRow, { say: said(l, HOSTILE_MARKUP), time: clock(turnAt(l, 0).at) }), true); });
export const SaidStreamingThroughFences = story("text, assistant, streaming: a reply written through prose and fences, its settled blocks keeping their nodes (data-replaced stays 0)", async () => { const l = await cmx(); return { ...inHost(l, () => createComponent(CodeReplay, { text: ANSWER_WITH_CODE, at: turnAt(l, 0).at }), true) }; });
export const SaidStreamingEquivalence = story("text, assistant, streaming: every test document streamed in seeded chunks paints, after every chunk, what painting it whole does (data-mismatches stays 0)", async () => { const l = await cmx(); return inHost(l, () => createComponent(UnitsCheck, {}), true); });
export const AnswerGithubReading = story("the answer read as github reads it: a single tilde as written, footnotes, details, keys, an image as its words, a link that runs nothing", async () => { const l = await cmx(); return inHost(l, () => createComponent(TurnFrame, { get children() { return createComponent(Answer, { say: said(l, GITHUB_READING) }); } })); });
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
/* a settled ask with this device's record of its reply (sync/replies.ts): the line above the tool's body, then where and when */
const replied = (s: Step, r: Pick<AskReply, "kind" | "reply" | "who">): ReadonlyMap<string, AskReply> => new Map([[s.callID, { thread: "desk:ses", callID: s.callID, askID: "per_story", at: s.at + s.ms, ...r }]]);
const repliedRow = async (pred: (s: Step) => boolean, what: string, r: Pick<AskReply, "kind" | "reply" | "who">, opts: RowOpts = {}): Promise<Built> => { const l = await notes(); const s = pickStep(l, pred, what); return oneRow(l, stepModel(s, { ...l.ctx, replies: replied(s, r) }), opts); };
const deniedEdit = (s: Step) => s.tool === "edit" && s.status === "error";
const doneEdit = (s: Step) => s.tool === "edit" && s.status === "completed";
export const EditPermitDeniedWhy = story("tool edit, error: you denied it, with the reason, on this device", () => repliedRow(deniedEdit, "denied edit", { kind: "permission", reply: { k: "permit", reply: "reject", message: "not that file, use the copy in notes/" }, who: { here: true } }));
export const EditPermitDenied = story("tool edit, error: you denied it, no reason", () => repliedRow(deniedEdit, "denied edit", { kind: "permission", reply: { k: "permit", reply: "reject" }, who: { here: true } }));
export const EditPermitOnce = story("tool edit, completed: you allowed it once", () => repliedRow(doneEdit, "edit", { kind: "permission", reply: { k: "permit", reply: "once" }, who: { here: true } }));
export const EditPermitAlways = story("tool edit, completed: you always allowed it", () => repliedRow(doneEdit, "edit", { kind: "permission", reply: { k: "permit", reply: "always" }, who: { here: true } }));
export const EditPermitElsewhere = story("tool edit, completed: answered on another device", () => repliedRow(doneEdit, "edit", { kind: "permission", reply: { k: "permit", reply: "once" }, who: { by: "ipad" } }));
export const WriteNew = story("tool write, completed: a new file", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.tool === "write" && /^new/.test(s.result), "new file"), { open: true }); });
export const WriteOver = story("tool write, completed: a file written whole", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.tool === "write" && s.status === "completed", "write")); });
export const ReadOne = story("tool read, completed: one file", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length === 1, "single read"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx)); });
export const ReadPartial = story("tool read, completed: part of a file, with the file line", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length === 1 && x.steps[0]?.span?.total !== undefined && (x.steps[0].span.end - x.steps[0].span.start + 1) < x.steps[0].span.total, "partial read"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx), { open: true }); });
export const ReadInTheReader = story("tool read, open, in the reader: the file full screen with its numbers, wrap and copy", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length === 1 && x.steps[0]?.output !== undefined, "read with lines"); const built = oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx), { open: true }); return { ...built, node: (wide) => createComponent(Pressed, { press: ".file-open", get children() { return built.node(wide); } }) }; });
/* beds that open to their whole length (code.tsx ShowAll, thread.tsx OutputBed and DiffBed): a long one shows its opening lines under a
   fade and "show all N lines" opens it in place; the reader holds every line the read returned, or says the thread keeps only part */
const pressing = (built: Built, press: string): Built => ({ ...built, node: (wide) => createComponent(Pressed, { press, get children() { return built.node(wide); } }) });
const longRead = (s: Step) => s.family === "read" && s.readRaw !== undefined && s.readRaw.split("\n").length > 60 && s.readRaw.startsWith("<path>") && s.readRaw.includes("<type>file</type>");
const readRow = async (): Promise<Built> => { const l = await northstar(); const s = pickStep(l, longRead, "long read"); return stepRow(l, s, { open: true }); };
export const ReadLong = story("tool read, open: a long file shows its first 14 lines under a fade, then show all", readRow);
export const ReadLongWhole = story("tool read, open: show all pressed, the bed holds every line the read returned", async () => pressing(await readRow(), ".bed-all"));
export const ReadLongInTheReader = story("tool read, in the reader: the whole read, not the preview, and where it stopped", async () => pressing(await readRow(), ".file-open"));
export const ReadKeptPreview = story("tool read, in the reader: the thread keeps only the preview, and says so", async () => {
  const l = await cmx();
  const s = pickStep(l, (x) => x.family === "read" && x.span !== undefined && x.span.end - x.span.start + 1 > 10 && x.output !== undefined, "read with a span");
  const kept: Step = { ...s };
  delete kept.readRaw;
  return { ...pressing(stepRow(l, kept, { open: true }), ".file-open"), note: "the read's output removed from a real step: what a row shows when the output is not numbered lines it can read" };
});
const longEdit = async (): Promise<Built> => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.tool === "edit" && s.diff !== undefined && s.diff.split("\n").length > 60, "long edit"), { open: true }); };
export const EditLong = story("tool edit, open: a long diff shows its first 24 lines under a fade, then show the whole diff", longEdit);
export const EditLongWhole = story("tool edit, open: show the whole diff pressed", async () => pressing(await longEdit(), ".bed-all"));
export const WriteLongWhole = story("tool write, open: the whole file written, past the 80 lines its diff keeps", async () => { const l = await northstar(); return pressing(stepRow(l, pickStep(l, (s) => s.tool === "write" && (s.wrote?.split("\n").length ?? 0) > 300, "long write"), { open: true }), ".bed-all"); });
const longRun = async (): Promise<Built> => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "shell" && s.status === "completed" && (s.output?.cut ?? 0) > 40, "long output"), { open: true }); };
export const RunOutputLong = story("tool run, open: a long output's head and tail, then show all", longRun);
export const RunOutputWhole = story("tool run, open: show all pressed, every line of the output", async () => pressing(await longRun(), ".bed-all"));
export const ReadFolded = story("tool read, completed: a run of reads, named", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length > 1 && x.steps.length <= 6, "folded reads"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx)); });
export const ReadFoldedOpen = story("tool read, completed, open: every file with its span", async () => { const l = await northstar(); const r = pickRow(l, (x) => x.k === "fold" && x.family === "read" && x.steps.length > 1, "folded reads"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx), { open: true }); });
/** a read step of a picture: the first read of the fixture with its lines taken off and the images put on */
const imageRead = (l: Loaded, path: string, images: ReturnType<typeof picture>[], dropped = 0): Step => {
  const s: Step = { ...pickStep(l, (x) => x.family === "read" && x.status === "completed", "read"), object: path, images, ...(dropped ? { imagesDropped: dropped } : {}) };
  delete (s as { span?: unknown }).span;
  delete (s as { output?: unknown }).output;
  return s;
};
export const ReadImageClosed = story("tool read, completed: an image, closed (says 1 image)", async () => { const l = await northstar(); return stepRow(l, imageRead(l, "screens/home.png", [picture("home.png", 210)])); });
export const ReadImageOpen = story("tool read, completed, open: an image as a thumbnail, a press opens it full size", async () => { const l = await northstar(); return stepRow(l, imageRead(l, "screens/home.png", [picture("home.png", 210)]), { open: true }); });
export const ReadImagesFolded = story("tool read, completed, open: reads of several images folded, the thumbnails under their own file, past eight \"and 3 more images\"", async () => {
  const l = await northstar();
  const steps = [
    imageRead(l, "screens/home.png", [picture("home.png", 210), picture("home-dark.png", 250), picture("home-wide.png", 190, 960, 400)]),
    imageRead(l, "screens/thread.png", [picture("thread.png", 20), picture("thread-open.png", 40), picture("thread-ask.jpg", 330, 400, 700, "image/jpeg")]),
    imageRead(l, "screens/notes.png", Array.from({ length: 5 }, (_, i) => picture(`notes-${i + 1}.png`, 100 + i * 30)), 1),
  ].map((s, i) => ({ ...s, id: `img_${i}`, at: s.at + i * 1000 }));
  const fold: FoldRow = { k: "fold", family: "read", tool: "read", at: steps[0]?.at ?? 0, end: (steps.at(-1)?.at ?? 0) + 500, steps };
  return oneRow(l, foldModel(fold, l.ctx), { open: true });
});
export const RunWithImage = story("tool run, completed, open: a command that wrote a picture", async () => { const l = await northstar(); const s = { ...pickStep(l, (x) => x.family === "shell" && x.status === "completed" && !isChain(x.object) && x.polls === undefined, "command"), images: [picture("capture.png", 160, 800, 500)] }; return stepRow(l, s, { open: true }); });
export const ReadFailed = story("tool read, error", async () => { const l = await notes(); return stepRow(l, pickStep(l, (s) => s.family === "read" && s.status === "error", "failed read")); });

/* ---------- tools: search, web ---------- */

export const Grep = story("tool grep, completed: the pattern and its hits", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "fold" && x.tool === "grep" && x.steps.length === 1 && (x.steps[0]?.hits?.length ?? 0) > 0, "grep with hits"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx), { open: true }); });
export const GrepFolded = story("tool grep, completed: searches folded", async () => { const l = await cmx(); const r = pickRow(l, (x) => x.k === "fold" && x.tool === "grep" && x.steps.length > 1, "folded greps"); return oneRow(l, modelOf(r as Exclude<Row, { k: "say" }>, l.ctx)); });

/* ---------- tools: agents, asks, plans ---------- */

export const AgentReported = story("tool agent, completed: reported", async () => { const l = await northstar(); return stepRow(l, pickStep(l, (s) => s.family === "spawn" && s.agent?.child !== undefined, "agent with a session"), { open: true }); });
export const AgentBriefLong = story("tool agent, open: a long brief in its slip, faded, with read all and copy", async () => { const l = await northstar(); const s = pickStep(l, (x) => x.family === "spawn" && x.agent?.child !== undefined, "agent"); const brief = Array.from({ length: 18 }, (_, i) => `${i + 1}. ${s.agent?.brief.split(/(?<=\.)\s/)[0] ?? "do the work"}`).join("\n"); return stepRow(l, { ...s, agent: { ...(s.agent ?? { name: "agent" }), brief: `Start here. ${brief}` } as NonNullable<Step["agent"]> }, { open: true }); });
export const MessageToAgent = story("tool note, open: a message to another agent in its slip, with copy", async () => { const l = await northstar(); const s = pickStep(l, (x) => x.family === "spawn", "a step to recast"); const note: Step = { ...s, family: "message", tool: "message", object: "transport_impl", words: "the render path is done on my side. keep to the transport files and report when the pacing test passes; do not commit." }; delete (note as { agent?: unknown }).agent; return stepRow(l, note, { open: true }); });
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
export const QuestionAnsweredHere = story("tool ask, completed: answered on this device, the record says where and when after any repaint", () => repliedRow((s) => s.family === "ask" && s.status === "completed", "answered question", { kind: "question", reply: { k: "answers", answers: [["hi"]] }, who: { here: true } }, { open: true }));
export const QuestionDismissed = story("tool ask, error: dismissed, its record", async () => { const l = await notes(); return stepRow(l, pickStep(l, (s) => s.family === "ask" && s.status === "error", "dismissed question"), { open: true }); });
export const QuestionAnsweredOptions = story("tool ask, completed: the record open to the options as they were offered, the chosen one marked", async () => { const l = await notes(); const s = pickStep(l, (x) => x.family === "ask" && x.status === "completed", "answered question"); const built = stepRow(l, s, { open: true }); return { ...built, node: (wide) => createComponent(Pressed, { press: ".ask-rec-more", get children() { return built.node(wide); } }) }; });
export const QuestionEnded = story("tool ask, error: not answered, its turn ended under it", async () => { const l = await cmx(); return stepRow(l, pickStep(l, (s) => s.family === "ask" && s.status === "error", "aborted question"), { open: true }); });
export const QuestionTwoAnswered = story("tool ask, completed: two questions answered together, one typed, the record open", async () => {
  const l = await notes();
  const s = pickStep(l, (x) => x.family === "ask" && x.status === "completed", "answered question");
  const two: Step = { ...s, questions: TWO_QUESTIONS.map((q, i) => ({ header: q.header, question: q.question, options: q.options, custom: q.custom, multiple: q.multiple === true, answer: i === 0 ? [q.options[1]?.label ?? ""] : ["after the release, not before"] })) };
  const built = stepRow(l, two, { open: true });
  return { ...built, node: (wide) => createComponent(Pressed, { press: ".ask-rec-more", get children() { return built.node(wide); } }) };
});
/** a settled question's step asking `questions` instead of "which greeting", answered as `answers` says (one list per question; none
    for an ask that was dismissed or whose turn ended): the shapes a real agent asks, which the recording does not hold */
const settledAs = async (status: "completed" | "error", questions: readonly Asked[], answers: ReadonlyArray<readonly string[]> = [], opts: { press?: string; here?: boolean } = {}): Promise<Built> => {
  const l = await notes();
  const s = pickStep(l, (x) => x.family === "ask" && x.status === status, status === "completed" ? "answered question" : "dismissed question");
  const step: Step = { ...s, questions: questions.map((q, i) => ({ header: q.header, question: q.question, options: q.options, custom: q.custom, multiple: q.multiple === true, answer: answers[i] ? [...answers[i]] : undefined })) };
  const built = oneRow(l, stepModel(step, { ...l.ctx, ...(opts.here ? { replies: replied(step, { kind: "question", reply: { k: "answers", answers: answers.map((a) => [...a]) }, who: { here: true } }) } : {}) }), { open: true });
  return opts.press ? pressing(built, opts.press) : built;
};
export const QuestionMarkdownPending = story("tool ask, pending: a question in markdown, its link opens in a tab of its own, a javascript: link is only words, copy copies the markdown", () => asked(MARKDOWN_ASK));
export const QuestionMarkdownAnswered = story("tool ask, completed: a question in markdown stays whole over its record, with its link and its copy", () => settledAs("completed", MARKDOWN_ASK, [["Done, retry now"]], { here: true }));
export const QuestionMarkdownClosed = story("tool ask, completed, closed: the head says the question as plain words, no markdown marks", async () => { const l = await notes(); const s = pickStep(l, (x) => x.family === "ask" && x.status === "completed", "answered question"); return stepRow(l, { ...s, questions: MARKDOWN_ASK.map((q) => ({ header: q.header, question: q.question, options: q.options, custom: q.custom, multiple: false, answer: ["Done, retry now"] })) }); });
export const QuestionFourAnswered = story("tool ask, completed: four questions answered together, each question's words with its answer under them", () => settledAs("completed", FOUR_QUESTIONS, FOUR_QUESTIONS.map((q) => [q.options[0]?.label ?? ""]), { here: true }));
export const QuestionFourAnsweredOptions = story("tool ask, completed: four questions, show the 9 options pressed, each question's options under its own answer", () => settledAs("completed", FOUR_QUESTIONS, FOUR_QUESTIONS.map((q) => [q.options[0]?.label ?? ""]), { here: true, press: ".ask-rec-more" }));
export const QuestionTwoDismissed = story("tool ask, error: two questions dismissed, both questions whole, then you dismissed it", () => settledAs("error", TWO_QUESTIONS));
export const AskCardOnItsOwn = story("ask card on its own: the card outside the thread, as home's answer sheet draws it", async () => {
  const l = await notes("question pending: greeting");
  const s = pickStep(l, (x) => x.family === "ask" && x.status !== "completed" && x.status !== "error", "pending question");
  const m = stepModel({ ...s, questions: TWO_QUESTIONS.map((q) => ({ header: q.header, question: q.question, options: q.options, custom: q.custom, multiple: q.multiple === true, answer: undefined })) }, l.ctx);
  if (m.body?.k !== "ask") throw new Error("the step has no ask");
  const body = m.body;
  return { tone: l.tone, node: () => createComponent(AskCard, { b: body }) };
});
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

/* ---------- the step group ---------- */

/** what a story shows once a finger has pressed a control in it: the first control the selector finds, pressed as it mounts */
function Pressed(props: { press: string; children: SolidJSX.Element }) {
  onMount(() => document.querySelector<HTMLButtonElement>(props.press)?.click());
  return props.children;
}
/** a ledger whose first group the reader has opened (a press on its line) */
const OpenedLedger = (props: { turn: Turn; ctx: RowCtx }) => createComponent(Pressed, { press: ".row.group > button.row-h", get children() { return createComponent(Ledger, { turn: props.turn, ctx: props.ctx }); } });
export const GroupSettled = story("step group, settled: each run between the agent's words is one line and its strip", async () => { const l = await northstar(); return inHost(l, () => createComponent(Ledger, { turn: turnAt(l, 1), ctx: l.ctx })); });
export const GroupOpen = story("step group, open: its strip and every step, the latest one open", async () => { const l = await northstar(); return inHost(l, () => createComponent(OpenedLedger, { turn: turnAt(l, 1), ctx: l.ctx })); });
export const GroupFailed = story("step group, settled: a run with a failure says how many failed, in red", async () => { const l = await cmx(); return inHost(l, () => createComponent(Ledger, { turn: turnAt(l, 0), ctx: l.ctx })); });
export const GroupStopped = story("step group, settled: a turn you stopped", async () => { const l = await northstar(); return inHost(l, () => createComponent(Ledger, { turn: turnAt(l, 5), ctx: l.ctx })); });
export const StripOrdered = story("strip, in order: a home window's steps known only by their order, the running one lit", async () => { const l = await cmx(); const strip = orderedStrip([{ kind: "read", running: false, bad: false }, { kind: "search", running: false, bad: false }, { kind: "edit", running: false, bad: false }, { kind: "run", running: false, bad: true }, { kind: "edit", running: false, bad: false }, { kind: "spawn", running: false, bad: false }, { kind: "run", running: true, bad: false }], true); return inHost(l, () => createComponent(StripLane, { strip })); });

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
export const ThinkingWhole = story("reasoning, streaming, live: a tap on the box shows the whole thought, growing as it is written", async () => { const l = await cmx(); const built = arriving(l, turnAt(l, 2), 6, { think: "the health check failed once and then passed, which points at a service that was slow to start rather than one that is broken. before saying it is fine i want to read the second service's log, since a pass after a fail can also mean the check was only retried and the cause is still there, waiting for the next deploy to show itself. the log will say whether the first check timed out or was refused, and a refusal means the port was not open yet, which is the slow start, while a timeout means it was open and did not answer, which is worse." }); return { ...built, node: (wide) => createComponent(Pressed, { press: ".live-door", get children() { return built.node(wide); } }) }; });
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
export const HeavyLive = story("live: twelve minutes into a heavy turn, the running step open under its run's group, the strip's head at now", async () => {
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

/* ---------- a script step in a run (the owner's screenshot): cmx2's run tool, whose input is a javascript script ---------- */

const SCRIPT = "const cmds = {\n  status: 'git status --short',\n  log: 'git log --oneline -5',\n};\nconst out = {};\nfor (const [k, c] of Object.entries(cmds)) out[k] = (await shell.exec({ command: c })).output;\nreturn out;";
const S0 = 1_791_200_280_000;
type Part = WireMessage["parts"][number];
const runTool = (id: string, code: string, at: number | undefined, ms: number | undefined): Part =>
  ({ id, type: "tool", callID: `c_${id}`, tool: "run", state: ms === undefined
    ? { status: "running", input: { code }, metadata: {}, ...(at !== undefined ? { time: { start: at } } : {}) }
    : { status: "completed", input: { code }, output: "{}", metadata: {}, time: { start: at, end: (at ?? 0) + ms } } }) as unknown as Part;
const shellTool = (id: string, command: string, at: number): Part => ({ id, type: "tool", callID: `c_${id}`, tool: "shell", state: { status: "completed", input: { command }, output: "ok", metadata: { exit_code: 0 }, time: { start: at, end: at + 1400 } } }) as unknown as Part;
const readTool = (id: string, path: string, at: number): Part => ({ id, type: "tool", callID: `c_${id}`, tool: "read", state: { status: "completed", input: { filePath: `/w/boxbox2/${path}` }, output: "x", metadata: {}, time: { start: at, end: at + 300 } } }) as unknown as Part;
/** a turn as the daemon sends it: you asked, the agent thought, said it would look, then ran: one running script with no start of
    its own (cmx2 leaves it null), a settled one, a run of several steps, or a one-line script */
function scriptTurn(shape: "running" | "settled" | "several" | "one-line"): { turn: Turn; ctx: RowCtx; now: number } {
  const said = 64_000;
  const steps: Part[] = shape === "several"
    ? [readTool("r1", "app/src/ui/thread/groups.ts", S0 + 66_000), readTool("r2", "app/src/ui/thread/strip.tsx", S0 + 67_000), shellTool("s1", "bun test groups", S0 + 70_000), runTool("x1", `// read the open lanes' logs\n${SCRIPT}`, S0 + 75_000, 9_000), runTool("x2", SCRIPT, S0 + 90_000, 2_000)]
    : shape === "settled" ? [runTool("x1", SCRIPT, S0 + said + 1000, 41_000)]
    : shape === "one-line" ? [runTool("x1", "return (await shell.exec({ command: 'git status --short' })).output", S0 + said + 1000, 900)]
    : [runTool("x1", SCRIPT, undefined, undefined)];
  const done = shape !== "running";
  /* written in cmx2's shapes, made neutral as the server's translate makes them */
  const messages: WireMessage[] = [
    { info: { id: "u_s", role: "user", time: { created: S0 } }, parts: [{ id: "u_s_p", type: "text", text: "why does the group look broken on the mac?" }] },
    { info: { id: "a_s", role: "assistant", time: { created: S0 + 1500, ...(done ? { completed: S0 + 200_000 } : {}) } }, parts: [
      { id: "t_s", type: "reasoning", text: "the strip is drawn in groups.ts and strip.tsx; a look at both and at the logs first.", time: { start: S0 + 2000, end: S0 + 30_000 } },
      { id: "w_s", type: "text", text: "I'll take a quick read-only look first, then say what i find.", time: { start: S0 + said - 2000, end: S0 + said } },
      ...steps,
      ...(done ? [{ id: "w_e", type: "text", text: "found it: the strip's running bar took the home bar's styles.", time: { start: S0 + 199_000, end: S0 + 200_000 } }] : []),
    ] },
  ].map((m) => neutralMessage(m as unknown as { info: Record<string, unknown>; parts: Record<string, unknown>[] }));
  const turns = turnsOf(messages, "/w/boxbox2");
  const turn = turns[0];
  if (!turn) throw new Error("no turn");
  return { turn, ctx: { turns, children: new Map(), thinking: "rows" }, now: S0 + said + 309_000 };
}
/** a running turn with its clock going, a second at a time from `from` */
function Ticking(props: { turn: Turn; ctx: RowCtx; from: number }) {
  const [now, setNow] = createSignal(props.from);
  const timer = setInterval(() => setNow((n) => n + 1000), 1000);
  onCleanup(() => clearInterval(timer));
  return createComponent(TurnView, { turn: props.turn, ctx: props.ctx, live: true, get now() { return now(); } });
}
/** the run as it sat on a desktop home (rail): inside .home, whose stylesheet styles a `.bar` of its own */
const OnHome = (props: { children: SolidJSX.Element }) => createComponent(HomeFrame, { get children() { return props.children; } });
function scriptStory(name: string, shape: Parameters<typeof scriptTurn>[0], onHome = false): Story {
  return story(name, async () => {
    const l = await cmx();
    const { turn, ctx, now } = scriptTurn(shape);
    const t = shape === "running" ? running(turn, turn.items) : turn;
    const view = () => (shape === "running" ? createComponent(Ticking, { turn: t, ctx, from: now }) : createComponent(TurnView, { turn: t, ctx }));
    return inHost(l, () => (onHome ? createComponent(OnHome, { get children() { return view(); } }) : view()), false);
  });
}
export const ScriptGroupLive = scriptStory("step group, live: one script running five minutes, after a thought and words", "running");
export const ScriptGroupLiveOnHome = scriptStory("step group, live, on a desktop home: the running script's bar stays in its 16 px lane", "running", true);
export const ScriptGroupSettled = scriptStory("step group, settled: the script's run folded whole, named by what it did", "settled");
export const ScriptGroupSettledOnHome = scriptStory("step group, settled, on a desktop home: a long script's bar stays in its lane", "settled", true);
export const ScriptGroupSeveral = scriptStory("step group, settled: reads, a command and two scripts, one named by its comment", "several", true);
export const ScriptGroupOneLine = scriptStory("step group, settled: a one-line script, still named in words", "one-line");

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
