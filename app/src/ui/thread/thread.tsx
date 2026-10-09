/* the thread's components: a turn, its ledger of rows, its tape and what it came
   to (docs/thread.md). a running turn is the same ledger as a settled one,
   growing at its end. state that is the reader's (which rows are open) lives
   here; everything about the turn comes from the model. */

import { type Accessor, For, Index, type JSX, type Signal, Show, createComputed, createContext, createEffect, createMemo, createRenderEffect, createSignal, on, onCleanup, onMount, untrack, useContext } from "solid-js";
import { type Copying, CopyButton } from "./copy-button";
import { commandLabel, outputLabel, replyLabel, reportLabel } from "./copy-names";
import { boundedPlain, newestOf, openLabel } from "./big-text";
import { painter } from "./markdown";
import { type Item, type Say, type Step, type Turn, spawnsOf } from "./model";
import { SNAP, flip, installMotion, rise } from "./motion";
import { type Live, ledgerOf, namesOf, sameCtxFor } from "./ledger";
import { type Label, NONE, type Names, createNames, sameList } from "./names";
import { type ThreadCaches, cacheKey, weighTurn } from "./memo-cache";
import { type StageWindow, moveTo } from "./stage-window";
import { COPY_OUTPUT_CAP, cleanOutput } from "./evidence";
import { type Bed, type Body, type Child, type DiffLine, type FileLine, type Inline, type Result, type RowCtx, type RowModel, clock, clockDur, clockS, dur, firstSentence, heavy, isBad, n, plural, readout } from "./rows";
import { base, dirOf } from "./shell";
import { shortWords } from "../asks/words";
import { blockForKey, layoutTop } from "./ask-landing";
import type { AskOutcome } from "./outcome";
import { type Mark, marksOf, nearest, scaleOf, thinkSpans, timeMap } from "./tape";
import "./thread.css";

/* ---------- answering in place ---------- */

export type { AskOutcome } from "./outcome";

/** what the stage does when an ask is answered; the stories provide none, so their cards only look the part */
export type AskActions = {
  answer(askID: string, answers: string[][]): Promise<AskOutcome>;
  reject(askID: string): Promise<AskOutcome>;
  permit(askID: string, reply: "once" | "always" | "reject", message?: string): Promise<AskOutcome>;
};
export const AskContext = createContext<AskActions>();
/** the stage's perf hook: how long a row took from the tap to the frame that showed it open */
export const MeasureContext = createContext<(what: "row", ms: number) => void>();
/** the stage's door into an agent's own thread (design.md: a subagent opens as its own stage, back returns to the parent);
    the stories provide none, so their agent rows have no door */
export const OpenAgentContext = createContext<(child: string, name: string) => void>();
/** the stage follows the end of a running turn on any growth while the reader is there. a change the reader makes by
    hand (a row opened, "show all", a report read whole) calls `hold` right before it changes the layout, so the stage
    does not chase the end for it and the row they tapped keeps its place */
export type Follow = { hold(): void };
export const FollowContext = createContext<Follow>();
/** the live tape sticks above the dock while a turn runs and reports how far it reaches up from the scroller's bottom
    edge to its own top (its foot offset and its height), 0 when it is not stuck or gone; the stage lifts the new-below
    pill and the pinned ask above it */
export type LiveTape = { stuck(px: number): void };
export const LiveTapeContext = createContext<LiveTape>();

/** the stage's way to learn which agents are on screen: an element that shows a child (its row, its lane on the tape) says so,
    and the stage holds that child's thread while it is within a screen of the view (live.ts, `want`). answers what stops it.
    the stories provide none, so their children are as their fixtures made them */
export const ChildWatchContext = createContext<(el: HTMLElement, child: string) => () => void>();
/** the stage's window on the log (stage-window.ts): which turns are filled, and the way to one. the stories provide none, so
    every turn they paint is filled, and a link that names a turn finds it */
export const WindowContext = createContext<StageWindow>();
/** the store's caches of what a finished part cost to make (memo-cache.ts); a story has none, and makes everything as it is painted */
export const CachesContext = createContext<ThreadCaches>();
/** the thread a ledger belongs to, which its rows' models are kept under between stages (memo-cache.ts); a story has none */
export const ThreadKeyContext = createContext<Accessor<string>>();

/* ---------- names ---------- */

export const NamesContext = createContext<Names>();

/** the names of one turn's controls, place for place. the turn says its labels to the page's register and reads back its names;
    without a register (a story of one turn) the names are told apart within the turn */
function turnNames(turn: Accessor<string>, labels: Accessor<readonly Label[]>): Accessor<readonly Label[]> {
  const names = useContext(NamesContext);
  const said = createMemo(labels, [], { equals: sameList });
  if (!names) return createMemo(() => namesOf(said(), NONE), [], { equals: sameList });
  createComputed(() => names.say(turn(), said()));
  return createMemo(() => { const own = names.names(turn()); return own.length === said().length ? own : said(); }, [], { equals: sameList });
}

/** what tells one turn's own controls (its tape, its report's buttons) from another turn's with the same words: where the turn stands on
    the page, ", turn 12". no two controls share a name (docs/thread.md, accessibility), and these have no label of their own to count
    the way rows do. a story of one turn has no page, and no ordinal */
function useOrdinal(id: Accessor<string>): Accessor<string> {
  const names = useContext(NamesContext);
  return () => { const at = names ? names.order().indexOf(id()) : -1; return at < 0 ? "" : `, turn ${at + 1}`; };
}

/* ---------- words ---------- */

/* the agent's markdown is painted by markdown.ts (sanitised there); a row's teaser and a thought's paragraphs use inlineNodes, which builds nodes */

/** inline code and bold as nodes, so a row never sets html from a string */
export function inlineNodes(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code>{m[1]}</code>);
    else out.push(<b>{m[2]}</b>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** a file name broken only between its words */
function nameNodes(s: string): JSX.Element[] {
  const parts = s.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[._-])/);
  return parts.flatMap((p, i) => (i ? [<wbr />, p] : [p]));
}

function InlineView(props: { piece: Inline }) {
  const p = () => props.piece;
  return (
    <>
      {(() => {
        const x = p();
        switch (x.t) {
          case "text": return <>{x.s}</>;
          case "lead": return <span class="lead">{x.s}</span>;
          case "fn": return <span class="fn">{nameNodes(x.s)}</span>;
          case "dir": return <span class="dir"><bdi>{x.s}</bdi></span>;
          case "str": return <span class="str">{x.s.split("|").flatMap((seg, i) => (i ? ["|", <wbr />, seg] : [seg]))}</span>;
          case "brief": return <span class="brief">{x.s}</span>;
          case "prose": return <>{inlineNodes(x.s)}</>;
          case "cmd": return <>{x.tokens.map((t) => (t.kind === "space" || t.kind === "arg" ? t.text : <span class={t.kind}>{t.text}</span>))}</>;
        }
      })()}
    </>
  );
}

const TICK = () => (
  <svg class="tick" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
);

function ResultView(props: { r: Result; now?: number | undefined }) {
  const text = () => (props.r.clockFrom !== undefined && props.now !== undefined ? clockDur(Math.max(0, props.now - props.r.clockFrom)) : props.r.text);
  return (
    <span class={`row-r ${props.r.tone}`}>
      <Show when={props.r.meter}>{(m) => { const tot = () => m().passed + m().failed || 1; return <span class="meter"><b style={{ width: `${(m().passed / tot()) * 100}%` }} /><b style={{ width: `${(m().failed / tot()) * 100}%` }} /></span>; }}</Show>
      <Show when={props.r.add !== undefined && props.r.hash === undefined && !props.r.tick && props.r.tone === "quiet"} fallback={<Show when={props.r.hash} fallback={<Show when={props.r.tick} fallback={text()}><TICK /></Show>}><span class="hash">{props.r.hash}</span></Show>}>
        <span class="add">+{n(props.r.add ?? 0)}</span>
        <Show when={props.r.del !== undefined}><span class="del">-{n(props.r.del ?? 0)}</span></Show>
        <Show when={/new$/.test(props.r.text)}> new</Show>
      </Show>
    </span>
  );
}

/* ---------- beds and bodies ---------- */

/** marks a sideways scroller as continuing past its edge */
function watchOverflow(el: HTMLElement): void {
  const check = () => el.classList.toggle("overflows", el.scrollWidth > el.clientWidth + 2 && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  check();
  el.addEventListener("scroll", check, { passive: true });
  void document.fonts?.ready.then(check);
}

/** a bed that has a copy control: the command, or the output. it is dressed as a code block is (a header, the control at the same inset), so the three read as one family; `label` is what its header says it is */
type BedCopy = { kind: "command" | "output"; label: string; name: string; text: () => string | Copying; refused?: string | undefined };

function BedView(props: { bed: Bed; cls?: string; copy?: BedCopy | undefined }) {
  let el!: HTMLDivElement;
  onMount(() => watchOverflow(el));
  const bed = () => (
    <div ref={el} class={`bed ${props.cls ?? ""}`}>
      <For each={props.bed.lines}>{(l, i) => (
        <>
          <Show when={props.bed.cut && i() === props.bed.cut.at}><span class="cut">{plural(props.bed.cut?.n ?? 0, "line")} not shown</span></Show>
          <span>{l || " "}</span>
        </>
      )}</For>
    </div>
  );
  return (
    <Show when={props.copy} fallback={bed()}>
      {(c) => (
        <div class="bed-wrap">
          <div class="cblock-h"><span class="cblock-lang">{c().label}</span><CopyButton kind={c().kind} name={c().name} text={c().text} refused={c().refused} /></div>
          {bed()}
        </div>
      )}
    </Show>
  );
}

function DiffView(props: { lines: DiffLine[] }) {
  let el!: HTMLDivElement;
  onMount(() => watchOverflow(el));
  return (
    <div ref={el} class="bed">
      <For each={props.lines}>{(l) => <span class={l.kind === "add" ? "la" : l.kind === "del" ? "ld" : l.kind === "hunk" ? "hunk" : l.kind === "tail" ? "tail-note" : ""}>{l.text || " "}</span>}</For>
    </div>
  );
}

function FileBar(props: { bar: NonNullable<FileLine["bar"]> }) {
  const pc = (x: number) => `${Math.max(0, Math.min(100, (x / props.bar.total) * 100)).toFixed(2)}%`;
  return (
    <div class="fb">
      <For each={props.bar.reads}>{(sp) => <i class="rd" style={{ left: pc(sp.start - 1), width: pc(sp.end - sp.start + 1) }} />}</For>
      <For each={props.bar.hunks}>{(k) => <i class={k.add >= k.del ? "ad" : "dl"} style={{ left: pc(k.start - 1), width: pc(Math.max(k.add, k.del, 1)) }} />}</For>
    </div>
  );
}

function FileName(props: { path: string; created?: boolean | undefined }) {
  return (
    <span>
      <span class="fn">{nameNodes(base(props.path))}</span>
      <Show when={props.created}><span class="dir"> new</span></Show>
      <Show when={dirOf(props.path)}><span class="dir"><bdi>{dirOf(props.path)}</bdi></span></Show>
    </span>
  );
}

/** a file in the files row: its counts, and its diff on a tap */
function FileEntry(props: { f: FileLine; root: () => HTMLElement }) {
  const [open, setOpen] = createSignal(false);
  let diffEl: HTMLDivElement | undefined;
  const follow = useContext(FollowContext);
  return (
    <>
      <button class="fl" aria-expanded={open() ? "true" : "false"} aria-label={`${props.f.path}, ${props.f.note}`} onClick={() => { follow?.hold(); flip(props.root(), () => setOpen(!open()), open() ? null : diffEl); }}>
        <FileName path={props.f.path} created={props.f.created} />
        <span class="fv"><span class="add">+{n(props.f.add ?? 0)}</span> <span class="del">-{n(props.f.del ?? 0)}</span></span>
        <Show when={props.f.bar}>{(b) => <FileBar bar={b()} />}</Show>
      </button>
      <Show when={open()}>
        <div ref={diffEl} class="fdiff">
          <Show when={props.f.diff} fallback={<div class="none">no diff was recorded</div>}>{(d) => <DiffView lines={d()} />}</Show>
        </div>
      </Show>
    </>
  );
}

function Facts(props: { facts: Array<{ text: string; strong?: boolean; bad?: boolean }> }) {
  return (
    <div class="facts">
      <For each={props.facts}>{(f, i) => <>{i() ? ", " : ""}<Show when={f.strong} fallback={<Show when={f.bad} fallback={f.text}><span class="no">{f.text}</span></Show>}><b>{f.text}</b></Show></>}</For>
    </div>
  );
}

function BodyView(props: { b: Body; root: () => HTMLElement; now?: number | undefined; /** the name of the row this is the body of: what its copy controls are named after */ row: string }) {
  const b = () => props.b;
  /* a card that asks holds what you chose or typed and the focus a tap gave it, and a running row's body is handed over
     again every second: the card is built once, for as long as the row asks, and reads its body as it changes. the other
     bodies are built again whenever theirs is handed over, as they always were */
  const kind = createMemo(() => props.b.k);
  const asked = () => props.b as Extract<Body, { k: "ask" }>;
  const permitted = () => props.b as Extract<Body, { k: "permission" }>;
  return (
    <>
      {(() => {
        if (kind() === "ask") return <AskCard b={asked()} />;
        if (kind() === "permission") return <PermissionCard b={permitted()} />;
        const x = b();
        switch (x.k) {
          case "shell": {
            /* every open command has its bed, and its control is on it; the output's is on the output, and its header says how many lines it has. the command is copied as it was sent (the bed shows home as ~), the output whole as the store holds it, cleaned at the press, up to a cap that is said when it is reached */
            const command: BedCopy | undefined = x.command ? { kind: "command", label: "command", name: commandLabel(props.row), text: () => ({ text: x.commandRaw ?? "" }) } : undefined;
            const raw = x.outputRaw;
            const output: BedCopy | undefined = raw !== undefined ? {
              kind: "output", label: plural(x.outputLines ?? x.output?.lines.length ?? 0, "line"), name: outputLabel(props.row),
              text: () => { const all = cleanOutput(raw); return all.length > COPY_OUTPUT_CAP ? { text: all.slice(0, COPY_OUTPUT_CAP), said: `copied the first ${n(COPY_OUTPUT_CAP)} characters of the output` } : { text: all }; },
              refused: x.output?.cut || x.output?.clipped ? "could not copy. only the lines shown can be selected" : undefined,
            } : undefined;
            return (
            <>
              <Show when={x.command}>{(c) => <BedView bed={{ lines: c() }} cls="wrap" copy={command} />}</Show>
              <Show when={x.facts.length}><Facts facts={x.facts} /></Show>
              <Show when={x.output} fallback={<Show when={!x.error}><div class="none">no output</div></Show>}>{(o) => <BedView bed={o()} copy={output} />}</Show>
              <Show when={x.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
            );
          }
          case "diff": return (
            <>
              <Show when={x.bar}>{(bar) => <FileBar bar={bar()} />}</Show>
              <Show when={x.lines} fallback={<div class="none">{x.none}</div>}>{(l) => <DiffView lines={l()} />}</Show>
              <Show when={x.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
          );
          case "read": return (
            <>
              <For each={x.files}>{(f) => <div class="fl"><FileName path={f.path} /><span class="fv">{f.note}</span><Show when={f.bar}>{(bar) => <FileBar bar={bar()} />}</Show></div>}</For>
              <Show when={x.preview}>{(p) => <BedView bed={p()} />}</Show>
              <Show when={x.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
          );
          case "hits": return (
            <>
              <Show when={x.files.length}>
                <div class="hits"><For each={x.files}>{(f) => <div><div class="hf">{base(f.path)}<span>  {dirOf(f.path)}</span></div><For each={f.hits}>{(h) => <div class="hl"><i>{h.line}</i><span>{h.text}</span></div>}</For></div>}</For></div>
              </Show>
              <Show when={x.list.length}><div class="hits"><For each={x.list}>{(h) => <div class="hl"><i /><span>{h}</span></div>}</For></div></Show>
              <Show when={!x.files.length && !x.list.length && x.spread.length}><Facts facts={x.spread.slice(0, 8).map((s) => ({ text: s.n ? `${s.name} ${s.n}` : s.name }))} /></Show>
              <Show when={x.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
          );
          case "agent": return <AgentBody b={x} />;
          // built above, once
          case "ask":
          case "permission": return null;
          case "plan": return <div><For each={x.todos}>{(t) => <div class={`todo ${t.status}`}><i /><span>{t.content}</span></div>}</For></div>;
          case "thoughts": return <div><For each={x.thoughts}>{(t) => <div class="thought-text"><Show when={x.thoughts.length > 1}><small>{clockS(t.at)}{t.ms >= 1000 ? `, ${dur(t.ms)}` : ""}</small></Show><For each={boundedPlain(t.text).shown.split(/\n{2,}/)}>{(p) => <p>{inlineNodes(p)}</p>}</For></div>}</For></div>;
          case "files": return <div><For each={x.files}>{(f) => <FileEntry f={f} root={props.root} />}</For></div>;
          case "error": return <BedView bed={{ lines: x.error.split("\n").slice(0, 12) }} cls="err" />;
        }
      })()}
    </>
  );
}

/* ---------- an agent's row, open: what it was told, and the door to its own thread ---------- */

function AgentBody(props: { b: Extract<Body, { k: "agent" }> }) {
  const openAgent = useContext(OpenAgentContext);
  const door = () => (openAgent && props.b.child ? { open: openAgent, child: props.b.child } : null);
  return (
    <>
      <Facts facts={props.b.facts} />
      <Show when={props.b.brief}><div class="brief-full">{props.b.brief}</div></Show>
      <Show when={door()}>
        {(d) => <button class="agent-door" aria-label={`open ${props.b.name}'s thread`} onClick={() => d().open(d().child, props.b.name)}>open its thread<i /></button>}
      </Show>
    </>
  );
}

/* ---------- asks, answered where they happened ---------- */

/** the honest state of a reply: nothing sent, sending, sent (until the ask settles on the stream), a note (it lost the race, or the
    ask is gone: said in the law's words, with nothing to retry), or a problem to tap */
function useReply() {
  const [busy, setBusy] = createSignal(false);
  const [sent, setSent] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  let last: (() => Promise<AskOutcome>) | null = null;
  const run = async (label: string, send: () => Promise<AskOutcome>) => {
    if (busy() || sent() !== null || note() !== null) return;
    last = send;
    setBusy(true);
    setProblem(null);
    const out = await send();
    setBusy(false);
    if (out.ok) setSent(label);
    else if (out.settled || out.gone) setNote(out.problem);
    else setProblem(out.problem);
  };
  const retry = () => { if (last) void run(sent() ?? "", last); };
  return { busy, sent, problem, note, run, retry };
}

/** keys 1 to 9 press the options of one question while focus is on the card or inside it, never in a field: the window used to
    answer them, and the card a push or a window's pill sends you to takes focus, so a keyboard answers it from there. an ask of
    several questions counts within the question focus is in, else the first with no answer yet (ask-landing.ts) */
function pressOption(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return;
  const digit = Number(event.key);
  if (!Number.isInteger(digit) || digit < 1 || !(event.currentTarget instanceof HTMLElement)) return;
  const card = event.currentTarget;
  const blocks = [...card.querySelectorAll<HTMLElement>(".ask-q")];
  const scope = blocks[blockForKey(blocks.map((b) => ({ focused: b.contains(document.activeElement), answered: b.querySelector('[aria-pressed="true"]') !== null || (b.querySelector<HTMLInputElement>("input")?.value.trim() ?? "") !== "" })))] ?? card;
  const option = scope.querySelectorAll<HTMLButtonElement>("button.ask-opt")[digit - 1];
  if (!option || option.disabled) return;
  event.preventDefault();
  option.click();
}

function AskCard(props: { b: Extract<Body, { k: "ask" }> }) {
  const actions = useContext(AskContext);
  const reply = useReply();
  /* the questions as words: a new body with the same words is the same questions, so the blocks and their fields are kept */
  const questions = createMemo(() => props.b.questions, props.b.questions, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const several = () => questions().length > 1;
  /* what is chosen and what is typed, a list of each per question: a typed answer is the one the daemon takes in place of
     the options, so it wins when there are words in it */
  const [picked, setPicked] = createSignal<string[][]>([]);
  const [typed, setTyped] = createSignal<string[]>([]);
  const answerOf = (i: number): string[] => { const words = typed()[i]?.trim(); return words ? [words] : (picked()[i] ?? []); };
  const complete = () => questions().length > 0 && questions().every((_, i) => answerOf(i).length > 0);
  const id = () => props.b.askID;
  const send = (answers: string[][]) => { const askID = id(); if (!askID || !actions) return; void reply.run(answers.map((a) => a.join(", ")).join("; "), () => actions.answer(askID, answers)); };
  const sendAll = () => send(questions().map((_, i) => answerOf(i)));
  const dismiss = () => { const askID = id(); if (!askID || !actions) return; void reply.run("dismissed", () => actions.reject(askID)); };
  const locked = () => reply.busy() || reply.sent() !== null || reply.note() !== null;
  const choose = (question: number, label: string, multiple: boolean) => setPicked((all) => {
    const next = questions().map((_, i) => [...(all[i] ?? [])]);
    const held = next[question] ?? [];
    next[question] = multiple ? (held.includes(label) ? held.filter((x) => x !== label) : [...held, label]) : [label];
    return next;
  });
  const type = (question: number, words: string) => setTyped((all) => questions().map((_, i) => (i === question ? words : (all[i] ?? ""))));
  const first = () => questions()[0];
  /* one tap answers a lone question with one choice; anything more is chosen, then sent */
  const oneTap = () => !several() && first()?.multiple !== true;
  const sentLabel = () => reply.sent();
  return (
    <div class="ask-card" data-ask={id()} tabIndex={-1} role="group" aria-label={several() ? `${questions().length} questions` : `question: ${shortWords(first()?.question ?? "", 60)}`} onKeyDown={pressOption}>
      <Show when={props.b.pending && !id()}><div class="ask-ans">waiting its turn: not asked yet</div></Show>
      <Show when={props.b.pending && id()} fallback={<Show when={!props.b.pending}><div class="ask-ans">{reply.note() ?? (props.b.dismissed ? "you dismissed it" : <>you answered <b>{questions().map((q) => q.answer?.join(", ") || "nothing").join("; ") || "nothing"}</b></>)}</div></Show>}>
        <For each={questions()}>{(q, qi) => (
          <div class="ask-q" role={several() || q.multiple ? "group" : undefined} aria-label={several() ? q.question : q.multiple ? "pick any" : undefined}>
            <Show when={several()}>
              <Show when={q.header}><p class="ask-h">{q.header}</p></Show>
              <p class="ask-t">{q.question}</p>
            </Show>
            <div class="ask-opts">
              <For each={q.options}>{(o, i) => (
                <button
                  class={`ask-opt ${i() === 0 && oneTap() ? "first" : ""}`}
                  aria-label={several() ? `answer ${o.label}, ${shortWords(q.question, 60)}` : `answer ${o.label}`}
                  aria-pressed={oneTap() ? (sentLabel() === o.label ? "true" : "false") : (picked()[qi()]?.includes(o.label) ?? false)}
                  disabled={locked()}
                  onClick={() => (oneTap() ? send([[o.label]]) : choose(qi(), o.label, q.multiple))}
                >
                  {o.label}
                  <Show when={o.description && o.description !== `answer ${o.label}`}><small>{o.description}</small></Show>
                </button>
              )}</For>
            </div>
            <Show when={q.custom}>
              <form class="ask-line" onSubmit={(e) => { e.preventDefault(); const words = typed()[qi()]?.trim(); if (several()) { if (complete()) sendAll(); } else if (words) send([[words]]); }}>
                <input class="ask-input" type="text" placeholder="or type an answer" aria-label={several() ? `type an answer to ${shortWords(q.question, 60)}` : "type an answer"} value={typed()[qi()] ?? ""} onInput={(e) => type(qi(), e.currentTarget.value)} disabled={locked()} autocomplete="off" />
                <Show when={!several()}><button class="ask-go" type="submit" aria-label="answer with what you typed" disabled={locked() || !typed()[qi()]?.trim()}>answer</button></Show>
              </form>
            </Show>
          </div>
        )}</For>
        <Show when={several()}>
          <button class="ask-go ask-send" aria-label={`answer all ${questions().length} questions: ${shortWords(first()?.question ?? "", 40)}`} disabled={locked() || !complete()} onClick={sendAll}>answer</button>
        </Show>
        <Show when={!several() && !oneTap()}>
          <button class="ask-go ask-send" disabled={locked() || (picked()[0]?.length ?? 0) === 0} onClick={() => send([picked()[0] ?? []])}>answer with {picked()[0]?.length ?? 0} picked</button>
        </Show>
        <div class="ask-foot">
          <Show when={reply.busy()}><span class="ask-sent">sending</span></Show>
          <Show when={reply.sent()}>{(s) => <span class="ask-sent">sent: {s()}</span>}</Show>
          <Show when={reply.note()}>{(n) => <span class="ask-note">{n()}</span>}</Show>
          <Show when={reply.problem()}>{(p) => <button class="ask-problem" onClick={reply.retry}>{p()}</button>}</Show>
          <Show when={!locked()}><button class="ask-quiet" onClick={dismiss}>dismiss</button></Show>
        </div>
      </Show>
    </div>
  );
}

function PermissionCard(props: { b: Extract<Body, { k: "permission" }> }) {
  const actions = useContext(AskContext);
  const reply = useReply();
  const [why, setWhy] = createSignal<string | null>(null);
  const id = () => props.b.askID;
  const locked = () => reply.busy() || reply.sent() !== null || reply.note() !== null;
  const permit = (r: "once" | "always" | "reject", label: string, message?: string) => { const askID = id(); if (!askID || !actions) return; void reply.run(label, () => actions.permit(askID, r, message)); };
  return (
    <div class="ask-card" data-ask={id()} tabIndex={-1} role="group" aria-label={`permission: ${shortWords(props.b.what, 60)}`} onKeyDown={pressOption}>
      <div class="facts">wants your permission to <b>{props.b.what}</b></div>
      <Show when={props.b.diff}>{(d) => <DiffView lines={d()} />}</Show>
      <div class="ask-opts">
        <button class="ask-opt first" aria-label="allow once" aria-pressed={reply.sent() === "allowed once" ? "true" : "false"} disabled={locked()} onClick={() => permit("once", "allowed once")}>allow once</button>
        <button class="ask-opt" aria-label="always allow" aria-pressed={reply.sent() === "always allowed" ? "true" : "false"} disabled={locked()} onClick={() => permit("always", "always allowed")}>always allow<small>every {props.b.permission} in this project</small></button>
        <button class="ask-opt" aria-label="deny" aria-pressed={reply.sent() === "denied" ? "true" : "false"} disabled={locked()} onClick={() => permit("reject", "denied")}>deny</button>
      </div>
      <Show when={why() === null} fallback={
        <form class="ask-line" onSubmit={(e) => { e.preventDefault(); permit("reject", "denied", why()?.trim() || undefined); }}>
          <input class="ask-input" type="text" placeholder="say why, and the agent reads it" aria-label="why not" value={why() ?? ""} onInput={(e) => setWhy(e.currentTarget.value)} disabled={locked()} autocomplete="off" />
          <button class="ask-go" type="submit" disabled={locked()}>deny</button>
        </form>
      }>
        <Show when={!locked()}><button class="ask-quiet" onClick={() => setWhy("")}>or deny and say why</button></Show>
      </Show>
      <div class="ask-foot">
        <Show when={reply.busy()}><span class="ask-sent">sending</span></Show>
        <Show when={reply.sent()}>{(s) => <span class="ask-sent">sent: {s()}</span>}</Show>
        <Show when={reply.note()}>{(n) => <span class="ask-note">{n()}</span>}</Show>
        <Show when={reply.problem()}>{(p) => <button class="ask-problem" onClick={reply.retry}>{p()}</button>}</Show>
      </div>
    </div>
  );
}

/* ---------- a row ---------- */

const flipRoot = (el: HTMLElement): HTMLElement => el.closest<HTMLElement>("[data-flip-root]") ?? document.body;

/** what an element tells the stage's scroller, up the tree, before it scrolls the view for the reader: the scroll that follows is theirs
    and lets go of the end (pin.ts), however long after their tap it runs */
export const READING = "reading";
const reading = (el: HTMLElement): void => { el.dispatchEvent(new Event(READING, { bubbles: true })); };

/** scrolls to an element in the thread, as the reader's own move (the stage lets go of the end for it). given its scroller, only
    that scrolls: a row the scroller cannot bring to its top (the thread's end is near) would else leave the rest of the move to
    the page and the layers above it, which have no scroll of their own to give and slid the whole screen up. `below` is how far
    under the scroller's top the element's top should land (the bar's height and what its fade covers); its scroll margin if left out.
    answers where the scroller is sent, or null when the page's own scroll took the move */
export function bring(el: HTMLElement, within?: HTMLElement, below?: number): number | null {
  reading(el);
  if (!within) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return null; }
  const top = layoutTop(el, within) - (below ?? (Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0));
  /* the move is the stage window's when it has one: the way is filled first, nothing writes to the scroll position while it goes, and it lands
     exactly (stage-window.ts, travel). a far move lands at once (windowing.ts, travel) */
  const offset = below ?? (Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
  moveTo(within, () => layoutTop(el, within) - offset);
  return top;
}

/** scrolls to an element in the thread and lights it for a moment */
export function light(el: HTMLElement, within?: HTMLElement): void {
  bring(el, within);
  el.ownerDocument.querySelectorAll(".lit").forEach((r) => r.classList.remove("lit"));
  el.classList.add("lit");
  setTimeout(() => el.classList.remove("lit"), 1600);
}

export function RowView(props: { m: RowModel; time: string; now?: number | undefined; /** the newest row of a running turn: open with what it is doing */ cur?: boolean; live?: Live | undefined; /** a row arriving while the reader watches rises in */ enter?: boolean; /** the name the page tells it apart by, when a row above shares its label */ name?: string | undefined }) {
  const [open, setOpen] = createSignal(props.m.open);
  /* the newest row of a running turn is open on its own; a reader who closes it keeps it closed */
  const [shut, setShut] = createSignal(false);
  const [over, setOver] = createSignal(false);
  let rowEl!: HTMLDivElement;
  let contentEl!: HTMLSpanElement;
  let bodyEl: HTMLDivElement | undefined;
  let liveEl: HTMLDivElement | undefined;
  const follow = useContext(FollowContext);
  const landing = useContext(LandingContext);
  const hasBody = () => props.m.body !== undefined || props.live !== undefined;
  const isOpen = () => !shut() && (open() || (props.cur === true && hasBody()));
  const measure = () => setOver(!isOpen() && contentEl.scrollHeight > contentEl.clientHeight + 1);
  onMount(() => {
    installMotion();
    measure();
    void document.fonts?.ready.then(measure);
    if (props.enter && !landing?.()) rise(rowEl, 18);
  });
  /* a row whose place now holds another step starts closed again. the key is read through a memo: `on` runs its
     function whenever its dependencies notify, and a running row's model is handed over on every tick, so an effect
     on `props.m.key` alone would close a tapped-open row at the next second */
  const key = createMemo(() => props.m.key);
  createEffect(on(key, () => { setOpen(props.m.open); setShut(false); queueMicrotask(measure); }, { defer: true }));
  /* live: the box follows its newest line once it overflows */
  createEffect(() => { void props.live?.text; void props.live?.out?.length; if (liveEl) { liveEl.scrollTop = liveEl.scrollHeight; liveEl.classList.toggle("over", liveEl.scrollTop > 2); } });
  /* an agent's row on screen is a reason to hold its child's thread (live.ts, `want`): its step count and its lane come from it */
  const watch = useContext(ChildWatchContext);
  const child = createMemo(() => props.m.child);
  createEffect(() => {
    const c = child();
    if (c && watch) onCleanup(watch(rowEl, c));
  });
  const measureOpen = useContext(MeasureContext);
  const toggle = () => {
    const next = !isOpen();
    const tapped = performance.now();
    follow?.hold();
    flip(flipRoot(rowEl), () => { setOpen(next); setShut(!next); }, next ? bodyEl : null);
    queueMicrotask(measure);
    if (next && measureOpen) requestAnimationFrame(() => measureOpen("row", performance.now() - tapped));
  };
  const cls = () => `row ${props.m.kind} ${props.m.face} ${props.m.clamps ? "clamps" : ""} ${isOpen() ? "open" : ""} ${props.m.bad ? "bad" : ""} ${props.m.stopped ? "stopped" : ""} ${props.m.running ? "running" : ""}`;
  const win = useContext(WindowContext);
  const toReport = (e: MouseEvent) => {
    e.stopPropagation();
    const link = props.m.link;
    if (!link) return;
    /* the report's turn is filled before the move, so there is a card to land on (stage-window.ts, reveal) */
    win?.reveal(link.turn);
    const root = flipRoot(rowEl);
    const cards = [...root.querySelectorAll<HTMLElement>(`.report[data-report="${CSS.escape(link.report)}"]`)];
    const after = root.querySelector<HTMLElement>(`.report[data-turn="${CSS.escape(link.turn)}"]`) ?? cards.find((c) => c.compareDocumentPosition(rowEl) & Node.DOCUMENT_POSITION_PRECEDING) ?? cards[cards.length - 1];
    if (after) light(after, root.closest<HTMLElement>(".stage-scroll") ?? undefined);
  };
  const head = () => (
    <>
      <span class="row-t">{props.time}</span>
      <span class="row-k">{props.m.kind}</span>
      <span ref={contentEl} class={`row-c ${over() ? "over" : ""}`}>
        <Show when={props.m.header}>{(header) => <span class="row-hd">{header()}</span>}</Show>
        <span class="teaser"><For each={props.m.content}>{(p) => <InlineView piece={p} />}</For></span>
        <Show when={props.m.opened}><span class="opened lead">{props.m.opened}</span></Show>
      </span>
      <Show when={props.m.link} fallback={<ResultView r={props.m.result} now={props.now} />}>
        <span class="row-r quiet"><button class="row-link" aria-label={`the report ${props.m.link?.report} sent`} onClick={toReport}>{props.m.result.text}</button></span>
      </Show>
    </>
  );
  return (
    <div ref={rowEl} class={cls()} data-key={props.m.key} data-from={props.m.at} data-to={props.m.end} data-part={props.m.partIDs.join(" ")} data-agent={props.m.agent} data-ask={props.m.body?.k === "ask" || props.m.body?.k === "permission" ? props.m.body.askID : undefined}>
      <Show when={hasBody()} fallback={<div class="row-h">{head()}</div>}>
        <button class="row-h" aria-expanded={isOpen() ? "true" : "false"} aria-label={props.name ?? props.m.label} onClick={toggle}>{head()}</button>
        <Show when={isOpen()}>
          <div ref={bodyEl} class="row-b">
            <Show when={props.cur && props.live} fallback={<Show when={props.m.body}>{(b) => <BodyView b={b()} root={() => flipRoot(rowEl)} now={props.now} row={props.name ?? props.m.label} />}</Show>}>{(l) => (
              <Show when={l().text !== undefined} fallback={<div ref={liveEl} class="live-out"><Show when={l().diff} fallback={<BedView bed={{ lines: l().out ?? [" "] }} />}>{(d) => <DiffView lines={d()} />}</Show></div>}>
                <div ref={liveEl} class={`live-text ${l().streaming ? "caret" : ""}`}><Streamed text={l().text ?? ""} /></div>
              </Show>
            )}</Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** a streamed thought's words: what is there stays put and what arrives enters with the blur settle (design.md, motion). a text
    that does not carry on from the last one is painted whole with no motion, as is the first text a row paints, so a
    thread opened mid-stream never animates (replay never animates) */
function Streamed(props: { text: string }) {
  type Chunk = { text: string; fresh: boolean };
  /* the box follows the newest line, so a thought of megabytes shows its last few thousand characters and nothing else (big-text.ts) */
  const newest = () => newestOf(props.text);
  const [chunks, setChunks] = createSignal<Chunk[]>([{ text: newest(), fresh: false }]);
  let shown = newest();
  /* a render effect, so the words are in the box before the box follows them (the effects after it) */
  createRenderEffect(on(newest, (text) => {
    if (text === shown) return;
    if (text.startsWith(shown)) {
      const grown = [...chunks(), { text: text.slice(shown.length), fresh: true }];
      /* the settled words fold into one chunk, so a long reply never holds hundreds of spans */
      setChunks(grown.length > MAX_CHUNKS ? [{ text: grown.slice(0, -RECENT_CHUNKS).map((c) => c.text).join(""), fresh: false }, ...grown.slice(-RECENT_CHUNKS)] : grown);
    } else setChunks([{ text, fresh: false }]);
    shown = text;
  }, { defer: true }));
  return <For each={chunks()}>{(c) => <span classList={{ w: c.fresh }}>{c.text}</span>}</For>;
}
const MAX_CHUNKS = 64;
const RECENT_CHUNKS = 12;

/** the agent's markdown painted as it stands: the answer's own sanitised markdown, so what a said row says reads the way the
    answer will. a streaming text changes more than once a frame at times and one parse of the newest is all the eye gets, so
    a change repaints on the next frame (the first paint is at once, and a row that did not change paints nothing). only the
    blocks whose html changed are replaced (markdown.ts), so a settled code block keeps its node, its focus and its "copied"
    while the reply streams on. while the text streams its caret sits at the end of the last thing written */
function Markdown(props: { text: string; caret?: boolean | undefined; class: string; ref?: ((el: HTMLDivElement) => void) | undefined }) {
  const el = <div /> as HTMLDivElement;
  createRenderEffect(() => { el.className = props.class; });
  const surface = painter(el, useContext(CachesContext)?.htmlFor());
  surface.paint(props.text, props.caret === true);
  props.ref?.(el);
  let frame = 0;
  createEffect(on(() => [props.text, props.caret], () => { frame ||= requestAnimationFrame(() => { frame = 0; surface.paint(props.text, props.caret === true); }); }, { defer: true }));
  onCleanup(() => { cancelAnimationFrame(frame); surface.dispose(); });
  return el;
}

/** what the agent said between its steps, as markdown; the newest one of a running turn streams with its caret and, when the turn
    settles with it, steps into the answer's type with the same structure. a said row has no reply control: mid-turn prose stays
    text to select, so the ledger stays quiet (its code blocks do carry theirs) */
export function SayRow(props: { say: Say; time: string; enter?: boolean }) {
  let rowEl!: HTMLDivElement;
  const landing = useContext(LandingContext);
  onMount(() => { if (props.enter && !landing?.()) rise(rowEl, 18); });
  return (
    <div ref={rowEl} class="row say" data-key={`say:${props.say.id}`} data-from={props.say.at} data-to={props.say.at}>
      <div class="row-h">
        <span class="row-t">{props.time}</span>
        <div class="row-c" data-part-text>
          <Markdown class="say-md" text={props.say.text} caret={props.say.streaming} />
        </div>
      </div>
    </div>
  );
}

/* ---------- the ledger ---------- */

/** the rows of a turn, in the order they happened. a running turn is the same ledger, growing at its end: every row
    is there from the moment it happens and can be opened, the newest is open with what it is doing, and what the agent
    is saying at the end streams as its newest row (ledger.ts) */
export function Ledger(props: { turn: Turn; ctx: RowCtx; live?: boolean; /** rows that arrive rise in */ enter?: boolean }) {
  /* a row's model and entry are rebuilt only when what it reads changed (ledger.ts), and rows are keyed by their place:
     an unchanged row is handed the same entry and its dom is left alone; a changed one keeps its dom and its open state */
  const thread = useContext(ThreadKeyContext);
  const caches = useContext(CachesContext);
  /* a settled turn's models are kept between stages, so a thread opened again paints its rows from what it had (memo-cache.ts). a
     view takes the ledger out while it paints and puts it back when it goes, so no two views of one thread share a ledger, and a
     turn that is running when it goes (it never settled) puts nothing back. a turn that is running keeps its own all along */
  const key = () => (thread && caches ? cacheKey(thread(), untrack(() => props.turn.id)) : undefined);
  const taken = (() => {
    const at = key();
    if (at === undefined || !caches || props.live === true) return undefined;
    const held = caches.ledgers.get(at);
    if (held) caches.ledgers.delete(at);
    return held;
  })();
  const own = taken ?? ledgerOf();
  /* a view that goes after the sign-out puts nothing back (memo-cache.ts, stamp) */
  const owner = thread ? untrack(thread) : "";
  const stamp = caches?.stamp(owner) ?? 0;
  onCleanup(() => {
    const at = key();
    if (at !== undefined && caches && !untrack(() => props.live)) caches.keep(caches.ledgers, owner, stamp, at, own, weighTurn(untrack(() => props.turn)));
  });
  const entries = createMemo(() => own(props.turn, props.ctx, props.live === true));
  /* a row is a control when it has something to open (RowView) */
  const names = turnNames(() => props.turn.id, () => entries().map((e) => (e.model?.body !== undefined || e.live !== undefined ? e.model?.label : undefined)));
  return (
    <Show when={entries().length}>
      <div class="ledger">
        <Index each={entries()}>{(e, i) => (
          <>
            <Show when={e().gap}><div class="gap">{e().gap}</div></Show>
            <Show when={e().model} fallback={<Show when={e().say}>{(say) => <SayRow say={say()} time={e().time} enter={props.enter === true} />}</Show>}>{(m) => <RowView m={m()} time={e().time} now={props.ctx.now} cur={e().cur === true} live={e().live} enter={props.enter === true} name={names()[i]} />}</Show>
          </>
        )}</Index>
      </div>
    </Show>
  );
}

/* ---------- the tape ---------- */

/** the turn's receipt, at its end: what the turn did, on a time scale. while the turn runs it floats over the stream as an opaque
    card in the flood's own colour, stuck above the dock wherever the reader is in the turn, so the instrument is always beside
    what it measures; settled it lands into the page as a pressed well */
export function Tape(props: { turn: Turn; ctx: RowCtx; now?: number | undefined; live?: boolean; /** the turn ended but its agents work on: the tape keeps time for them */ parked?: boolean; /** it arrives while the reader watches: it rises in, the way a row does */ enter?: boolean; onLand?: (s: Step) => void }) {
  let tapeEl!: HTMLDivElement;
  let sentinelEl: HTMLDivElement | undefined;
  let plotEl!: HTMLDivElement;
  const landing = useContext(LandingContext);
  const watch = useContext(ChildWatchContext);
  const ordinal = useOrdinal(() => props.turn.id);
  const liveTape = useContext(LiveTapeContext);
  onMount(() => { if (props.enter && !landing?.()) rise(tapeEl, 18); });

  /* stuck: its own place is out of the view and the tape is held at the foot of it. a sentinel after the tape's place says
     whether that place is in view (above the line the tape is held at); the tape itself says whether it is in view at all,
     so a turn that is entirely below the view shows no tape and lifts nothing. the effect depends on a memo of `live`, so
     a delta, which hands the tape a new turn, does not tear the observers down and flash the tape out of its stuck state */
  const live = createMemo(() => props.live === true);
  const [stuck, setStuck] = createSignal(false);
  createEffect(() => {
    if (!live() || !sentinelEl) { setStuck(false); return; }
    const root = tapeEl.closest<HTMLElement>(".stage-scroll, .stage-sample");
    /* the line the tape is held at, less two pixels so that its resting place, which is that line to a fraction, is in view */
    const foot = Math.max(0, (Number.parseFloat(root ? getComputedStyle(root).getPropertyValue("--foot") : "") || 0) - 2);
    let placeInView = true, tapeInView = false;
    const sync = () => setStuck(tapeInView && !placeInView);
    const place = new IntersectionObserver((es) => { placeInView = es.at(-1)?.isIntersecting ?? placeInView; sync(); }, { root, rootMargin: `0px 0px -${foot}px 0px` });
    const self = new IntersectionObserver((es) => { tapeInView = es.at(-1)?.isIntersecting ?? tapeInView; sync(); }, { root });
    place.observe(sentinelEl);
    self.observe(tapeEl);
    onCleanup(() => { place.disconnect(); self.disconnect(); setStuck(false); });
  });
  /* while stuck the stage is told how far up from the scroller's foot the tape reaches, and again when the tape changes height */
  createEffect(() => {
    if (!stuck()) return;
    const root = tapeEl.closest<HTMLElement>(".stage-scroll, .stage-sample");
    const report = () => liveTape?.stuck((root?.getBoundingClientRect().bottom ?? innerHeight) - tapeEl.getBoundingClientRect().top);
    report();
    const size = new ResizeObserver(report);
    size.observe(tapeEl);
    onCleanup(() => { size.disconnect(); liveTape?.stuck(0); });
  });
  const items = () => props.turn.items;
  const steps = createMemo(() => items().filter((x): x is Step => x.k === "step"));
  // the scale runs ahead while anything is still moving, so marks never slide
  const map = createMemo(() => timeMap(props.turn, items(), props.now, live() || props.parked));
  const agents = createMemo(() => {
    const seen = new Set<string>();
    return steps().flatMap((s) => { const c = s.agent?.child; if (!c || seen.has(c) || !props.ctx.children.has(c)) return []; seen.add(c); return [{ step: s, child: props.ctx.children.get(c) as Child, name: s.agent?.name ?? "agent" }]; });
  });
  const thoughts = () => items().filter((x) => x.k === "think").length;
  const failed = () => steps().filter(isBad).length;
  const total = () => (props.now ?? props.turn.end) - props.turn.at;
  const label = () => live() ? { text: `working ${clockDur(total())}`, lit: true } : props.parked ? { text: `working ${clockDur(total())}, through its agents`, lit: true } : props.turn.status === "aborted" ? { text: `stopped after ${dur(total())}`, lit: false } : { text: `worked ${dur(total())}`, lit: false };
  const counts = () => [plural(steps().length, "step"), thoughts() ? plural(thoughts(), "thought") : "", agents().length ? plural(agents().length, "agent") : ""].filter(Boolean).join(", ");

  /* scrubbing: a playhead follows the pointer and names the step under it; letting go lands on its row */
  const [scrub, setScrub] = createSignal<{ x: number; step: Step } | null>(null);
  let drag: { x0: number; y0: number; live: boolean; id: number } | null = null;
  const pct = (e: PointerEvent) => { const r = plotEl.getBoundingClientRect(); return Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)); };
  const showAt = (p: number) => { const s = nearest(steps(), map(), p); if (!s) return; const lr = plotEl.getBoundingClientRect(), tr = tapeEl.getBoundingClientRect(); setScrub({ x: lr.left - tr.left + (map().x(s.at) / 100) * lr.width, step: s }); };
  const down = (e: PointerEvent) => { if (!steps().length) return; drag = { x0: e.clientX, y0: e.clientY, live: e.pointerType === "mouse", id: e.pointerId }; if (drag.live) { try { tapeEl.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ } showAt(pct(e)); } };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    if (!drag.live) { const dx = Math.abs(e.clientX - drag.x0), dy = Math.abs(e.clientY - drag.y0); if (dy > 10 && dy > dx) { drag = null; return; } if (dx > 6) { drag.live = true; try { tapeEl.setPointerCapture(drag.id); } catch { /* the pointer is gone */ } } else return; }
    showAt(pct(e));
  };
  const up = (e: PointerEvent) => { if (!drag) return; if (!drag.live) showAt(pct(e)); const s = scrub()?.step; drag = null; setScrub(null); if (s) props.onLand?.(s); };
  const cancel = () => { drag = null; setScrub(null); };
  onMount(() => { document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", cancel); });
  onCleanup(() => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", cancel); });
  const capText = () => { const s = scrub()?.step; if (!s) return null; const r = readout(s).text; const what = s.family === "read" || s.family === "edit" ? base(s.object) : s.family === "spawn" ? s.agent?.name ?? "agent" : s.family === "shell" ? (s.polls || s.object).split("\n")[0] ?? "" : s.object; return { when: `${clock(s.at)}, ${dur(s.at - props.turn.at)} in`, what: `${s.tool}  ${what.slice(0, 40)}`, r, bad: isBad(s) }; };

  const Lane = (p: { items: readonly Item[]; steps: readonly Step[]; map: ReturnType<typeof timeMap>; agent?: boolean; now?: number | undefined; head?: boolean | undefined }) => (
    <div class={`lane ${p.agent ? "agent" : ""}`}>
      <For each={thinkSpans(p.items, p.map)}>{(s) => <i class="tp-think" style={{ left: `${s.left}%`, width: `${s.width}%` }} />}</For>
      <For each={marksOf(p.steps, p.map, p.now)}>{(m: Mark) => <i class={`tp-mk ${m.kind} ${m.bad ? "bad" : ""} ${m.live ? "running" : ""}`} style={{ left: `${m.left}%`, ...(m.width !== undefined ? { width: `${m.width}%` } : {}) }} />}</For>
      <Show when={p.head && props.now !== undefined}><i class="tp-now" style={{ left: `${p.map.x(props.now ?? 0)}%` }} /></Show>
    </div>
  );
  return (
    <>
    <div ref={tapeEl} class={`tape ${live() ? "live" : ""} ${scrub() ? "scrub" : ""}`} data-stuck={stuck() ? "" : undefined} role="slider" aria-label={`scrub through the work of this turn${ordinal()}`} aria-valuemin={0} aria-valuemax={steps().length} aria-valuenow={scrub() ? steps().indexOf(scrub()?.step as Step) : undefined} tabIndex={0} onPointerDown={down}>
      <div class="tape-h"><b class={label().lit ? "lit" : ""}>{label().text}</b><span>{counts()}<Show when={failed()}>, <span class="no">{failed()} failed</span></Show></span></div>
      <div class="tape-lanes">
        <div class="lane-hd"><span>thinking</span><span>tools</span></div>
        <div ref={plotEl} class="lane-plot"><Lane items={items()} steps={steps()} map={map()} now={props.now} head={live() || props.parked} /></div>
        <For each={agents()}>{(a) => {
          const from = () => map().x(a.step.at);
          const sub = () => { const f = from(); return { ...map(), x: (tm: number) => ((map().x(tm) - f) / Math.max(1, 100 - f)) * 100 }; };
          let laneEl!: HTMLDivElement;
          const child = a.step.agent?.child;
          if (child && watch) onMount(() => onCleanup(watch(laneEl, child)));
          const until = () => props.now ?? map().end;
          const cItems = () => a.child.items.filter((x) => x.at >= props.turn.at && x.at <= until());
          const cSteps = () => cItems().filter((x): x is Step => x.k === "step" && x.at + x.ms <= until() + 1);
          return (
            <>
              <div class="lane-hd agent">agent</div>
              <div ref={laneEl} class="lane-plot"><div class="lane-name">{a.name}<span>{cSteps().length ? `, ${plural(cSteps().length, "step")}` : ""}</span></div><div style={{ "margin-left": `${from()}%` }}><Lane items={cItems()} steps={cSteps()} map={sub()} agent /></div></div>
            </>
          );
        }}</For>
      </div>
      <div class="tp-scale">
        <For each={scaleOf(map())}>{(t) => <><i class={t.major ? "maj" : ""} style={{ left: `${t.left}%` }} /><Show when={t.label}><span style={{ left: `${t.left}%` }}>{t.label}</span></Show></>}</For>
        <span class="first" style={{ left: "0" }}>{clock(map().start)}</span><span class="last" style={{ left: "100%" }}>{clock(map().end)}</span>
      </div>
      <div class="tp-playhead" style={{ left: `${scrub()?.x ?? 0}px` }} />
      <div class="tp-cap" style={{ left: `${Math.max(112, Math.min((tapeEl?.clientWidth ?? 400) - 112, scrub()?.x ?? 0))}px` }}>
        <Show when={capText()}>{(c) => <><small>{c().when}</small><span>{c().what}</span><Show when={c().r}><em class={c().bad ? "no" : ""}>{c().r}</em></Show></>}</Show>
      </div>
    </div>
    <Show when={live()}><div ref={sentinelEl} class="tape-sentinel" aria-hidden="true" /></Show>
    </>
  );
}

/* ---------- what started the turn, and what it came to ---------- */

/** the bubble clamps at six lines, which the first thousand characters more than fill: the rest of a long prompt is not made into text the page must lay out */
const CLAMPED_CHARS = 1200;

export function YouBubble(props: { turn: Turn }) {
  /* ten messages of one length have ten controls with the same words: the turn tells them apart (rule 5, unique names) */
  const ordinal = useOrdinal(() => props.turn.id);
  const long = () => props.turn.prompt.length > 300 || props.turn.prompt.split("\n").length > 6;
  const [all, setAll] = createSignal(false);
  let el!: HTMLDivElement;
  const follow = useContext(FollowContext);
  // a brief from the root agent says only "brief": the title block already says whose agent this is
  const label = () => (props.turn.by === "queued" ? "queued, " : props.turn.by === "steer" ? "steer, " : props.turn.by === "brief" ? (props.turn.from && props.turn.from !== "root" ? `brief from ${props.turn.from}, ` : "brief, ") : "");
  return (
    <div ref={el} class="you">
      <Show when={long() && !all()} fallback={boundedPlain(props.turn.prompt).shown}>
        <span class="clamp">{props.turn.prompt.slice(0, CLAMPED_CHARS)}</span>
        <button class="all" onClick={() => { follow?.hold(); flip(flipRoot(el), () => setAll(true)); }} aria-label={`${openLabel(props.turn.prompt.length)}${ordinal()}`}>{openLabel(props.turn.prompt.length)}</button>
      </Show>
      <time>{label()}{clock(props.turn.at)}</time>
    </div>
  );
}

export function ReportCard(props: { turn: Turn }) {
  const [short, setShort] = createSignal(props.turn.prompt.length > 700);
  let el!: HTMLDivElement;
  const follow = useContext(FollowContext);
  const win = useContext(WindowContext);
  const ordinal = useOrdinal(() => props.turn.id);
  const toAgent = () => {
    const name = props.turn.from;
    if (!name) return;
    /* the turn that started the agent is filled before the move, so its row is there to land on */
    const started = win?.agentRow(name, props.turn.id);
    if (started) win?.reveal(started.turn);
    const root = flipRoot(el);
    const rows = [...root.querySelectorAll<HTMLElement>(`.row[data-agent="${CSS.escape(name)}"]`)];
    const before = (started ? root.querySelector<HTMLElement>(`.row[data-part~="${CSS.escape(started.part)}"]`) : null) ?? rows.filter((r) => r.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? rows[0];
    if (before) light(before, root.closest<HTMLElement>(".stage-scroll") ?? undefined);
  };
  return (
    <div ref={el} class={`report ${short() ? "short" : ""}`} data-report={props.turn.from} data-turn={props.turn.id}>
      <div class="rep-h"><span><button class="rep-agent" aria-label={`the agent ${props.turn.from}, where it started${ordinal()}`} onClick={toAgent}><b>{props.turn.from}</b></button> {props.turn.note ? "wrote" : "reported"}</span><span class="rep-r"><span>{clock(props.turn.at)}</span><CopyButton kind="report" name={reportLabel(props.turn.from ?? "agent", props.turn.note === true)} text={() => props.turn.prompt} refused={short() ? `could not copy. read the whole ${props.turn.note ? "note" : "report"}, then select it` : undefined} /></span></div>
      <Markdown class="rep-b" text={props.turn.prompt} />
      <button class="rep-all" aria-label={`read the whole ${props.turn.note ? "note" : "report"}${ordinal()}`} onClick={() => { follow?.hold(); flip(flipRoot(el), () => setShort(false)); }}>read the whole {props.turn.note ? "note" : "report"}</button>
    </div>
  );
}

/** a mark line is its words between two hairlines; words too long to sit between rules a person can see wrap flush
    instead, with no rules (the canvas measures the words on one line, so the answer does not depend on how they wrapped) */
const MIN_RULE = 24;
/** canvas takes font-stretch as a keyword, so a percentage is read as the nearest one */
const STRETCH: ReadonlyArray<readonly [number, CanvasFontStretch]> = [[50, "ultra-condensed"], [62.5, "extra-condensed"], [75, "condensed"], [87.5, "semi-condensed"], [100, "normal"], [112.5, "semi-expanded"], [125, "expanded"], [150, "extra-expanded"], [200, "ultra-expanded"]];
/** one context for every mark line, made when the first is measured */
let measurer: CanvasRenderingContext2D | null | undefined;
function watchRules(mark: HTMLElement): void {
  const words = mark.firstElementChild;
  measurer ??= document.createElement("canvas").getContext("2d");
  const ctx = measurer;
  if (!words || !ctx) return;
  const check = () => {
    const s = getComputedStyle(words);
    ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const stretch = Number.parseFloat(s.fontStretch);
    ctx.fontStretch = STRETCH.reduce((best, k) => (Math.abs(k[0] - stretch) < Math.abs(best[0] - stretch) ? k : best))[1];
    // the gap is the mark's own, which it keeps whether it is a row of words between rules or a block
    const gap = Number.parseFloat(getComputedStyle(mark).columnGap);
    mark.classList.toggle("wraps", ctx.measureText(words.textContent ?? "").width > mark.clientWidth - 2 * (MIN_RULE + gap));
  };
  const watch = new ResizeObserver(check);
  watch.observe(mark);
  void document.fonts?.ready.then(check);
  onCleanup(() => watch.disconnect());
}

export function MarkLine(props: { turn: Turn }) {
  const [open, setOpen] = createSignal(false);
  let card: HTMLDivElement | undefined;
  let el!: HTMLDivElement;
  const follow = useContext(FollowContext);
  onMount(() => watchRules(el));
  return (
    <Show when={props.turn.by === "compaction"} fallback={<div ref={el} class="turn-mark"><span>{firstSentence(props.turn.prompt).slice(0, 120)}</span></div>}>
      <div ref={el} class="turn-mark"><button aria-expanded={open() ? "true" : "false"} onClick={() => { follow?.hold(); flip(flipRoot(el), () => setOpen(!open()), open() ? null : card); }}>compacted here. <b>{open() ? "hide" : "show"} the summary</b></button></div>
      <Markdown ref={(c) => { card = c; }} class={`sumcard ${open() ? "open" : ""}`} text={props.turn.answer?.text ?? ""} />
    </Show>
  );
}

/** the answer, markdown at reading measure, and under it, once it is settled, one quiet line holding the reply's copy control: the answer's markdown as the agent wrote it. a streaming reply has no control. */
export function Answer(props: { say: Say; /** the reply's control is named by its turn (replyLabel) */ name?: string | undefined }) {
  const copyable = () => !props.say.streaming && props.say.text.trim() !== "";
  return (
    <>
      <Markdown class={`answer ${props.say.streaming ? "caret" : ""}`} text={props.say.text} ref={(el) => el.setAttribute("data-part-text", "")} />
      <Show when={copyable()}>
        <div class="act-line"><CopyButton kind="reply" name={props.name ?? "copy the reply"} text={() => props.say.text} /></div>
      </Show>
    </>
  );
}

/** scrolls the row for a step into view and lights it */
export function landOn(turnEl: HTMLElement, s: Step): void {
  const rows = [...turnEl.querySelectorAll<HTMLElement>(".ledger > .row")];
  const row = rows.find((r) => Number(r.dataset["from"]) <= s.at && s.at <= Number(r.dataset["to"])) ?? rows.find((r) => Number(r.dataset["from"]) >= s.at) ?? rows[rows.length - 1];
  if (!row) return;
  reading(row);
  const within = row.closest<HTMLElement>(".stage-scroll");
  if (within) bring(row, within); else row.scrollIntoView({ behavior: "smooth", block: "start" });
  turnEl.ownerDocument.querySelectorAll(".row.lit").forEach((r) => r.classList.remove("lit"));
  row.classList.add("lit");
  setTimeout(() => row.classList.remove("lit"), 1600);
}

/** what the stage does around a turn settling (docs/thread.md, live: the prompt keeps its place) */
export type Settle = {
  /** called before the settle changes the end of the turn (the newest row closes, the reply becomes the answer, the files row arrives); returns what to call once it has */
  begin(): () => void;
};
export const SettleContext = createContext<Settle>();
/** true while the stage lands a thread it has just opened: what is painted then is not a live event and does not move */
export const LandingContext = createContext<() => boolean>();

export function TurnView(props: { turn: Turn; ctx: RowCtx; live?: boolean; now?: number }) {
  let el!: HTMLElement;
  const t = () => props.turn;
  const live = () => props.live === true;
  const settle = useContext(SettleContext);
  const win = useContext(WindowContext);
  /* an older turn is an empty box until the stage's window fills it, and stays filled (stage-window.ts); with no window, always */
  const filled = () => win === undefined || win.filled(t().id);
  const boxHeight = createMemo(() => (win === undefined ? 0 : win.height(t())));
  /* what a reader watches arrive rises in: the rows and the tape of a turn that runs in front of them, and what its
     settle adds. what is painted when a thread lands does not (the rows and the tape ask LandingContext) */
  const [watched, setWatched] = createSignal(live());
  /* a settled turn whose agents still work keeps its tape's clock running for them (the parent is parked on them). it is handed a
     clock to run by the stage (`now`) or, in a story, by its context (`tick`); whether it is handed one does not change for the life
     of the view, so `now` is read here only for that, untracked: this must not wake every turn each second */
  const parked = createMemo(() => (props.ctx.tick !== undefined || untrack(() => props.now !== undefined)) && spawnsOf(t()).some((s) => s.agent?.child !== undefined && props.ctx.children.get(s.agent.child)?.state === "working"));
  /* the context this turn is painted in: the stage's, with the clock only where the clock is read, the running turn (`now`)
     and a turn whose agents work (`tick`: their rows' and the tape's clock). the memo's equality is what this turn reads of it
     (ledger.ts, sameCtxFor), so a delta, an ask or a child elsewhere does not wake the turn and a second passing wakes only
     the turns that show time */
  const ctx = createMemo<RowCtx>(() => {
    /* the turn is read here so that a turn that changes is compared again: a spawn row it has just gained finds its child in the
       stage's context, not in an older one this memo kept because the turn then read nothing of what differed */
    t();
    if (live()) return { ...props.ctx, now: props.now ?? t().at };
    if (parked() && props.now !== undefined) return { ...props.ctx, tick: props.now };
    return props.ctx;
  }, props.ctx, { equals: (a, b) => sameCtxFor(untrack(t), a, b) });
  /* the settle changes as little as it can: the newest row closes, the trailing reply becomes the answer in place (faded up
     once) and the tape un-sticks into a well. the stage takes the view's place before it and gives it back after, since a
     row closing at the end while the stage is pinned there would clamp the scroll and drop the view */
  let wasLive = live();
  createComputed(() => {
    const running = live();
    if (running) setWatched(true);
    if (wasLive && !running) {
      const done = settle?.begin();
      queueMicrotask(() => {
        done?.();
        const answer = el.querySelector<HTMLElement>(":scope > .answer");
        if (answer) rise(answer, 10);
      });
    }
    wasLive = running;
  });
  /* heavy, by the turn's own clock while it runs: the tape arrives at the end when the turn turns heavy */
  const heavyNow = createMemo(() => filled() && heavy(t(), live() ? props.now ?? t().at : undefined));
  onMount(() => { if (win) onCleanup(win.slot(el, () => t().id, t)); });
  return (
    <section ref={el} class="turn" data-turn={t().id} data-pending={filled() ? undefined : ""} data-gist={filled() ? undefined : firstSentence(t().prompt).slice(0, 90)} style={filled() ? undefined : { height: `${boxHeight()}px` }}>
      <Show when={filled()}>
        <Show when={t().by === "mail"}><ReportCard turn={t()} /></Show>
        <Show when={t().by === "compaction" || t().by === "notice"}><MarkLine turn={t()} /></Show>
        <Show when={t().by === "you" || t().by === "queued" || t().by === "steer" || t().by === "brief"}><YouBubble turn={t()} /></Show>
        <Show when={t().by !== "compaction"}>
          <Ledger turn={t()} ctx={ctx()} live={live()} enter={watched()} />
          <Show when={!live() && t().answer}>{(a) => <Answer say={a()} name={replyLabel(clock(t().at), t().prompt)} />}</Show>
          <Show when={heavyNow()}><Tape turn={t()} ctx={ctx()} now={live() ? props.now ?? t().at : parked() ? props.now ?? props.ctx.tick : undefined} live={live()} parked={parked()} enter={watched()} onLand={(s) => landOn(el, s)} /></Show>
        </Show>
      </Show>
    </section>
  );
}

/** the whole log of a thread: the turns, one after another */
export function ThreadLog(props: { turns: readonly Turn[]; ctx: RowCtx; wide: boolean }) {
  const names = createNames(() => props.turns.map((t) => t.id));
  return (
    <div class={`thread ${props.wide ? "wide" : ""}`} data-flip-root>
      <NamesContext.Provider value={names}>
        <For each={props.turns}>{(t) => <TurnView turn={t} ctx={props.ctx} />}</For>
      </NamesContext.Provider>
    </div>
  );
}

