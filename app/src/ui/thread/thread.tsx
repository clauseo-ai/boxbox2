/* the thread's components: a turn, its ledger of rows, its tape and what it came
   to (docs/thread.md). a running turn is the same ledger as a settled one,
   growing at its end. state that is the reader's (which rows are open) lives
   here; everything about the turn comes from the model. */

import { type Accessor, For, lazy, Index, type JSX, Show, createComputed, createContext, createEffect, createMemo, createRenderEffect, createSignal, on, onCleanup, onMount, untrack, useContext } from "solid-js";
import { cutMiddle, typeWord } from "../composer/files";
import { type Copying, CopyButton } from "./copy-button";
import { commandLabel, outputLabel, replyLabel } from "./copy-names";
import { boundedPlain, newestOf, openLabel } from "./big-text";
import { pacer } from "./pace";
import { painter } from "./markdown";
import { type Picture, type Say, type Turn, spawnsOf } from "./model";
import { flip, installMotion, rise } from "./motion";
import { type Entry, type Live, ledgerOf, namesOf, sameCtxFor } from "./ledger";
import { type Label, NONE, type Names, createNames, sameList } from "./names";
import { type ThreadCaches, cacheKey, weighTurn } from "./memo-cache";
import { longPrompt } from "./far";
import { type StageWindow, moveTo } from "./stage-window";
import { COPY_OUTPUT_CAP, DIFF_PREVIEW, DIFF_WHOLE, cleanOutput, wholeLines } from "./evidence";
import { type Bed, type Body, type DiffLine, type FileLine, type Inline, type Result, type RowCtx, type RowModel, clock, clockDur, clockS, dur, firstSentence, n, pictureNames, plural } from "./rows";
import { base, dirOf } from "./shell";
import { AskCard, PermissionCard, PermitRecord } from "../asks/card";
import { layoutTop } from "./ask-landing";
import { DiffView, watchOverflow } from "./diff";
import { FileBed, ShowAll, Slip } from "./code";
import { type Group, type StripMark, currentOf, foldedOf, groupClock, groupLabel, groupLine, groupsOf, lineShown, nearestMark } from "./groups";
import { StripLane } from "./strip";
import { reportOf } from "./report";
import { PictureViewer, ReportSheet, warmOn, whenLoaded } from "../later";
import { ReportGlyph } from "./report-glyph";
import "./thread.css";

/* ---------- answering in place ---------- */

export type { AskOutcome } from "./outcome";
/** what the stage does when an ask is answered, and the context the cards read it from (ui/asks/card.tsx, which draws them for home too) */
export { AskContext, type AskActions } from "../asks/card";
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

/** the stage's way to learn which agents are on screen: an element that shows a child (its row) says so,
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
export function useOrdinal(id: Accessor<string>): Accessor<string> {
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

function ResultView(props: { r: Result; now?: number | undefined; clockless?: boolean }) {
  const text = () => (props.r.clockFrom !== undefined && props.clockless ? "" : props.r.clockFrom !== undefined && props.now !== undefined ? clockDur(Math.max(0, props.now - props.r.clockFrom)) : props.r.text);
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


/** a bed that has a copy control: the command, or the output. it is dressed as a code block is (a header, the control at the same inset), so the three read as one family; `label` is what its header says it is */
type BedCopy = { kind: "command" | "output"; label: string; name: string; text: () => string | Copying; refused?: string | undefined };

function BedView(props: { bed: Bed; cls?: string; copy?: BedCopy | undefined; /** under the lines, inside the bed's block: its "show all" */ foot?: JSX.Element }) {
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
      <Show when={props.bed.rest}>{(rest) => <span class="cut">and {plural(rest(), "more line", "more lines")}, past what a bed opens to</span>}</Show>
    </div>
  );
  return (
    <Show when={props.copy} fallback={<>{bed()}{props.foot}</>}>
      {(c) => (
        <div class="bed-wrap">
          <div class="cblock-h"><span class="cblock-lang">{c().label}</span><CopyButton kind={c().kind} name={c().name} text={c().text} refused={c().refused} /></div>
          {bed()}
          {props.foot}
        </div>
      )}
    </Show>
  );
}

/** a command's output: its head and tail, and once it was cut, "show all 3,200 lines" opens the bed in place to every line (up to
    what a bed opens to, the copy's own cap), read from the output the store holds when pressed, never kept on the model */
function OutputBed(props: { bed: Bed; raw: string | undefined; count: number; copy: BedCopy | undefined; row: string }) {
  const [all, setAll] = createSignal(false);
  const more = () => props.raw !== undefined && (props.bed.cut !== undefined || props.bed.clipped === true);
  const shown = createMemo((): Bed => {
    if (!all() || props.raw === undefined) return props.bed;
    const whole = wholeLines(cleanOutput(props.raw));
    return { lines: whole.lines, ...(whole.rest ? { rest: whole.rest } : {}) };
  });
  return <BedView bed={shown()} copy={props.copy} foot={<Show when={more() && !all()}><ShowAll count={props.count} row={props.row} onShow={() => setAll(true)} /></Show>} />;
}

/** an edit's diff: whole up to DIFF_WHOLE lines; a longer one shows its first DIFF_PREVIEW under a fade, and "show the whole diff"
    opens it in place, a write's from the content the agent sent (its diff keeps 80 lines) */
function DiffBed(props: { lines: DiffLine[]; wrote?: string | undefined; row: string }) {
  const [all, setAll] = createSignal(false);
  const long = () => props.lines.length > DIFF_WHOLE;
  const whole = createMemo((): DiffLine[] => {
    if (props.wrote === undefined) return props.lines;
    const w = wholeLines(props.wrote);
    return [...w.lines.map((l): DiffLine => ({ kind: "add", text: `+${l}` })), ...(w.rest ? [{ kind: "tail" as const, text: `and ${plural(w.rest, "more line", "more lines")}, past what a bed opens to` }] : [])];
  });
  const count = () => (props.wrote !== undefined ? props.wrote.split("\n").length : props.lines.filter((l) => l.kind === "add" || l.kind === "del" || l.kind === "ctx").length);
  return (
    <Show when={long()} fallback={<DiffView lines={props.lines} />}>
      <div class="bed-wrap plain">
        <DiffView lines={all() ? whole() : props.lines.slice(0, DIFF_PREVIEW)} faded={!all()} />
        <Show when={!all()}><ShowAll count={count()} diff row={props.row} onShow={() => setAll(true)} /></Show>
      </div>
    </Show>
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
              <Show when={x.output} fallback={<Show when={!x.error}><div class="none">no output</div></Show>}>{(o) => <OutputBed bed={o()} raw={x.outputRaw} count={x.outputLines ?? o().lines.length} copy={output} row={props.row} />}</Show>
              <Show when={x.images || x.more}><Pictures groups={[{ pics: x.images ?? [] }]} more={x.more} /></Show>
              <Show when={x.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
            );
          }
          case "diff": return (
            <>
              <Show when={x.bar}>{(bar) => <FileBar bar={bar()} />}</Show>
              <Show when={x.lines} fallback={<div class="none">{x.none}</div>}>{(l) => <DiffBed lines={l()} wrote={x.wrote} row={props.row} />}</Show>
              <Show when={x.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
          );
          case "read": return (
            <>
              <Pictures more={x.more} groups={x.files.map((f) => ({ head: () => <div class="fl"><FileName path={f.path} /><span class="fv">{f.note}</span><Show when={f.bar}>{(bar) => <FileBar bar={bar()} />}</Show></div>, pics: f.images ?? [] }))} />
              <Show when={x.file} fallback={<Show when={x.preview}>{(p) => <BedView bed={p()} />}</Show>}>{(f) => <FileBed file={f()} row={props.row} />}</Show>
              <Show when={x.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
          );
          case "images": return <Pictures groups={[{ pics: x.images }]} more={x.more} />;
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
          case "message": return <Slip head={<>to <b>{x.to}</b></>} text={x.text} copy={{ kind: "message", name: `copy the message to ${x.to}, ${props.row}` }} />;
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

/* ---------- the images a tool returned: thumbnails, and each one full size (docs/design.md, pictures) ---------- */

type PictureGroup = { /** what introduces the group's thumbnails: a read's file line */ head?: () => JSX.Element; pics: readonly Picture[] };

/** the images in an open row, each group of them under what introduces it (a file's line), as thumbnails of one fixed box: the
    row's height is known before any image has loaded, so the window's heights hold. a press opens the image in a modal dialog
    in the top layer, at the size of the screen, and a press on the image there takes it to its own size and back; escape,
    the close control and a press outside it close it, and focus goes back to the thumbnail. the thumbnails are the same data
    url strings the step holds (an img takes the string, there is no copy of it here), loaded lazily and decoded off the
    main thread. what the row does not draw (past its cap, past the daemon's) is said, not hidden */
function Pictures(props: { groups: readonly PictureGroup[]; more?: number | undefined; /** what tells these thumbnails from another turn's of the same names */ suffix?: string | undefined }) {
  const [viewing, setViewing] = createSignal<{ pic: Picture; name: string } | null>(null);
  /* a name for each thumbnail that is its own in the row, whatever file it came from */
  const names = createMemo(() => pictureNames(props.groups.flatMap((g) => g.pics)).map((n) => `${n}${props.suffix ?? ""}`));
  const starts = createMemo(() => { let at = 0; return props.groups.map((g) => { const from = at; at += g.pics.length; return from; }); });
  return (
    <>
      {/* the groups by place and the thumbnails by picture: callers hand a new group object at every build of their row, and a list
          keyed by it made every img again, a fresh load and decode of its data url (docs/gotchas.md, a sent photo flickering) */}
      <Index each={props.groups}>{(g, gi) => (
        <>
          {g().head?.()}
          <Show when={g().pics.length}>
            <div class="pv-strip">
              <For each={g().pics}>{(pic, i) => {
                const name = () => names()[(starts()[gi] ?? 0) + i()] ?? "image";
                return (
                  <button class="pv-t" aria-haspopup="dialog" aria-label={name()} onPointerDown={warmOn("PictureViewer")} onClick={() => whenLoaded("PictureViewer", () => setViewing({ pic, name: name() }))}>
                    <img src={pic.url} alt="" loading="lazy" decoding="async" draggable={false} />
                  </button>
                );
              }}</For>
            </div>
          </Show>
        </>
      )}</Index>
      <Show when={props.more}>{(more) => <div class="pv-more">and {plural(more(), "more image")}</div>}</Show>
      <Show when={viewing()}>{(v) => <PictureViewer pic={v().pic} name={v().name} onClose={() => setViewing(null)} />}</Show>
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
      <Show when={props.b.brief}><Slip head={<>brief for <b>{props.b.name}</b></>} text={props.b.brief} copy={{ kind: "brief", name: `copy the brief for ${props.b.name}` }} /></Show>
      <Show when={door()}>
        {(d) => <button class="agent-door" aria-label={`open ${props.b.name}'s thread`} onClick={() => d().open(d().child, props.b.name)}>open its thread<i /></button>}
      </Show>
    </>
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

export function RowView(props: { m: RowModel; time: string; now?: number | undefined; /** the newest row of a running turn: open with what it is doing */ cur?: boolean; live?: Live | undefined; /** a row arriving while the reader watches rises in */ enter?: boolean; /** the name the page tells it apart by, when a row above shares its label */ name?: string | undefined; /** its running clock is the group line's, shown there */ clockless?: boolean; /** it opens when first painted: the latest step of a group the reader opened */ opened?: boolean }) {
  const [open, setOpen] = createSignal(props.m.open || props.opened === true);
  /* the newest row of a running turn is open on its own; a reader who closes it keeps it closed */
  const [shut, setShut] = createSignal(false);
  const [over, setOver] = createSignal(false);
  let rowEl!: HTMLDivElement;
  let contentEl!: HTMLSpanElement;
  let bodyEl: HTMLDivElement | undefined;
  let liveEl: HTMLDivElement | undefined;
  const follow = useContext(FollowContext);
  const landing = useContext(LandingContext);
  const hasBody = () => props.m.body !== undefined || props.live !== undefined || props.m.permit !== undefined;
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
  createEffect(on(key, () => { setOpen(props.m.open || props.opened === true); setShut(false); queueMicrotask(measure); }, { defer: true }));
  /* live: the box follows its newest line once it overflows */
  /* a thought being written shows in its box, or whole: a tap on the box opens the whole thought, which grows as it is written, and a
     second tap takes it back to the box (the native client's decision 21). the row's head still opens and closes the row */
  const [whole, setWhole] = createSignal(false);
  const [boxOver, setBoxOver] = createSignal(false);
  const followBox = () => {
    if (!liveEl) return;
    if (whole() && props.live?.text !== undefined) { setBoxOver(false); liveEl.classList.remove("over"); return; }
    liveEl.scrollTop = liveEl.scrollHeight;
    const over = liveEl.scrollTop > 2;
    liveEl.classList.toggle("over", over);
    setBoxOver(over);
  };
  createEffect(() => {
    void props.live?.text; void props.live?.out?.length; void whole();
    followBox();
  });
  const toggleWhole = () => { follow?.hold(); setWhole(!whole()); };
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
      <Show when={props.m.link} fallback={<ResultView r={props.m.result} now={props.now} clockless={props.clockless === true} />}>
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
            {/* the line a settled permission leaves: what this device replied, where and when (sync/replies.ts) */}
            <Show when={props.m.permit}>{(r) => <PermitRecord record={r()} />}</Show>
            <Show when={props.cur && props.live} fallback={<Show when={props.m.body}>{(b) => <BodyView b={b()} root={() => flipRoot(rowEl)} now={props.now} row={props.name ?? props.m.label} />}</Show>}>{(l) => (
              <Show when={l().text !== undefined} fallback={<div ref={liveEl} class="live-out"><Show when={l().diff} fallback={<BedView bed={{ lines: l().out ?? [" "] }} />}>{(d) => <DiffView lines={d()} />}</Show></div>}>
                <div class="live-thought">
                  <div ref={liveEl} class={`live-text ${l().streaming ? "caret" : ""} ${whole() ? "whole" : ""}`}><Streamed text={l().text ?? ""} whole={whole()} onPaint={followBox} /></div>
                  <button class="live-door" aria-expanded={whole() ? "true" : "false"} aria-label={whole() ? "the whole thought" : "the thought being written"} title={whole() ? "shows only its newest lines" : "shows the whole thought"} onClick={toggleWhole}>
                    <Show when={boxOver() && !whole()}><i class="live-more" aria-hidden="true" /></Show>
                  </button>
                </div>
              </Show>
            )}</Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** a streamed thought's words: what is there stays put and what arrives fades in (design.md, motion). a text
    that does not carry on from the last one is painted whole with no motion, as is the first text a row paints, so a
    thread opened mid-stream never animates (replay never animates) */
function Streamed(props: { text: string; /** the whole thought, not the box's newest lines */ whole?: boolean; /** the box grew between batches */ onPaint?: () => void }) {
  type Chunk = { text: string; fresh: boolean };
  /* the box follows the newest line, so a thought of megabytes shows its last few thousand characters and nothing else (big-text.ts);
     whole, it shows as much of it as a page lays out (its bound) */
  const newest = () => (props.whole ? boundedPlain(props.text).shown : newestOf(props.text));
  const first = untrack(newest);
  const [chunks, setChunks] = createSignal<Chunk[]>([{ text: first, fresh: false }]);
  /* a batch is revealed over the frames after it (pace.ts); a text that does not carry on is in the box at once, before the box follows
     it (the effects after this render effect) */
  const pace = pacer(first, {
    append: (piece) => {
      const grown = [...chunks(), { text: piece, fresh: true }];
      /* the settled words fold into one chunk, so a long reply never holds hundreds of spans */
      setChunks(grown.length > MAX_CHUNKS ? [{ text: grown.slice(0, -RECENT_CHUNKS).map((c) => c.text).join(""), fresh: false }, ...grown.slice(-RECENT_CHUNKS)] : grown);
      props.onPaint?.();
    },
    replace: (text) => setChunks([{ text, fresh: false }]),
  });
  createRenderEffect(on(newest, (text) => pace.set(text), { defer: true }));
  onCleanup(() => pace.dispose());
  return <For each={chunks()}>{(c) => <span classList={{ w: c.fresh }}>{c.text}</span>}</For>;
}
const MAX_CHUNKS = 64;
/* a fold makes the words it takes plain, so the chunks kept are the ones a frame a piece can still be fading in (360 ms at 60 fps) */
const RECENT_CHUNKS = 24;

/** the agent's markdown painted as it stands: the answer's own sanitised markdown, so what a said row says reads the way the
    answer will. a streaming text changes more than once a frame at times and one parse of the newest is all the eye gets, so
    a change repaints on the next frame (the first paint is at once, and a row that did not change paints nothing). only the
    blocks whose html changed are replaced (markdown.ts), so a settled code block keeps its node, its focus and its "copied"
    while the reply streams on. while the text streams its caret sits at the end of the last thing written */
export function Markdown(props: { text: string; caret?: boolean | undefined; class: string; ref?: ((el: HTMLDivElement) => void) | undefined }) {
  const el = <div /> as HTMLDivElement;
  /* a memo, so the class is set when it changes: a streaming row's class is worked out again on every word */
  const className = createMemo(() => props.class);
  createRenderEffect(() => { el.className = className(); });
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

/** one place the ledger paints: an entry, or a run's group. an entry in an opened group that is the run's latest step opens with it
    (`opened`), and the first of them leaves its quiet-stretch line to the group, which shows it */
type Place = { k: "entry"; entry: Entry; opened?: boolean; gapless?: boolean; /** the live row under a line that already dates and clocks it */ twin?: boolean } | { k: "group"; group: Group; open: boolean };

/** what a step on the strip is, in a word, where its row has no label */
const KIND_WORD: Record<StripMark["kind"], string> = { read: "read", search: "searched", edit: "edited", run: "ran", web: "fetched", spawn: "started an agent", ask: "asked", other: "step" };

/** a run of steps folded into one row (docs/thread.md, the step group): what the run did in a line, how long it took, and the run's
    strip under it. it sits between the agent's paragraphs and reads quieter than them: the line in the second ink, no surface, a
    chevron in the kind column where the steps' kinds stand when it opens. one line and a fixed strip, so its height never moves as
    steps fold into it. its steps are rows of their own after it (Ledger); this draws only the group */
export function GroupView(props: { group: Group; open: boolean; now?: number | undefined; name?: string | undefined; stripName?: string | undefined; onToggle: () => void; onPick: (m: StripMark) => void }) {
  const g = () => props.group;
  const line = createMemo(() => groupLine(g()));
  const marks = () => g().strip.marks;
  /* the step a keyboard has moved to on the strip, by its place; none until it moves */
  const [sel, setSel] = createSignal<number | null>(null);
  let stripEl!: HTMLDivElement;
  const pick = (e: MouseEvent) => {
    const r = stripEl.getBoundingClientRect();
    if (!r.width) return;
    const m = nearestMark(g().strip, ((e.clientX - r.left) / r.width) * 100, props.now);
    if (m) props.onPick(m);
  };
  const valueText = () => {
    const at = sel(), all = marks(), m = at === null ? undefined : all[Math.min(at, all.length - 1)];
    if (!m || at === null) return plural(g().steps, "step");
    const label = g().entries.find((e) => e.key === m.row)?.model?.label || KIND_WORD[m.kind];
    return [`${Math.min(at, all.length - 1) + 1} of ${all.length}`, label, ...(m.running ? ["running"] : []), ...(m.bad ? ["failed"] : [])].join(", ");
  };
  const key = (e: KeyboardEvent) => {
    const n = marks().length;
    if (!n) return;
    const at = sel() === null ? -1 : Math.min(sel() as number, n - 1);
    let next: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(n - 1, at + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const m = marks()[Math.max(0, at)]; if (m) props.onPick(m); return; }
    if (next === undefined) return;
    e.preventDefault();
    setSel(next);
  };
  /* closed, the group answers for the parts folded into it, so a link to one finds the group and opens it (the stage clicks a row's head);
     open, the rows do */
  const parts = () => (props.open ? undefined : foldedOf(g()).flatMap((e) => e.model?.partIDs ?? (e.say ? [e.say.id] : [])).join(" ") || undefined);
  return (
    <div class={`row group ${props.open ? "shown" : ""} ${g().live ? "live" : ""}`} data-key={g().key} data-from={g().at} data-to={g().end} data-part={parts()}>
      <button class="row-h" aria-expanded={props.open ? "true" : "false"} aria-label={props.name ?? groupLabel(g())} onClick={() => props.onToggle()}>
        <span class="row-t">{g().time}</span>
        <span class="row-k"><i class="group-chev" /></span>
        <span class="row-c">
          <Show when={line().doing}>{(d) => <><span class="group-doing">{d()}</span> · </>}</Show>
          {line().rest}
          <Show when={line().failed}>{(f) => <> · <span class="no">{f()}</span></>}</Show>
        </span>
        <span class={`row-r ${g().live ? "lit" : ""}`}>{groupClock(g(), props.now) ?? ""}</span>
      </button>
      <div class="group-band">
        <span class="group-gutter" aria-hidden="true" onClick={() => props.onToggle()} />
        <div ref={stripEl} class="strip" role="slider" tabIndex={0} aria-label={props.stripName ?? "steps of this run"} aria-valuemin={1} aria-valuemax={Math.max(1, marks().length)} aria-valuenow={Math.min(sel() ?? 0, Math.max(0, marks().length - 1)) + 1} aria-valuetext={valueText()} onClick={pick} onKeyDown={key}>
          <StripLane strip={g().strip} now={g().live ? props.now : undefined} />
        </div>
      </div>
    </div>
  );
}

/** the places of a turn read as text: its words, the thoughts that led to them, its asks, and every run of steps between them as one
    group (groups.ts). a running turn is the same ledger, growing at its end: the run going on now is a group with its newest row open
    under it, what the agent is saying at the end streams as its newest row, and once it writes again (or the turn ends) the run
    folds whole. a group the reader opens shows its strip and every one of its steps, only the latest open */
export function Ledger(props: { turn: Turn; ctx: RowCtx; live?: boolean; /** rows that arrive rise in */ enter?: boolean }) {
  /* a row's model and entry are rebuilt only when what it reads changed (ledger.ts), and places are keyed by where they stand:
     an unchanged place is handed the same object and its dom is left alone; a changed one keeps its dom and its open state */
  const thread = useContext(ThreadKeyContext);
  const caches = useContext(CachesContext);
  const follow = useContext(FollowContext);
  /* a settled turn's models are kept between stages, so a thread opened again paints its rows from what it had (memo-cache.ts). a
     view takes the ledger out while it paints and puts it back when it goes, so no two views of one thread share a ledger, and a
     turn that is running when it goes (it never settled) puts nothing back. a turn that is running keeps its own all along */
  /* read once, as the view is made: a layer's thread and a turn's id do not change under it, and the stage's <Show> that hands the
     thread down may have let it go by the time the view does (a thread that leaves the fleet), so the cleanup must not read it */
  const at = thread && caches ? cacheKey(untrack(thread), untrack(() => props.turn.id)) : undefined;
  const taken = (() => {
    if (at === undefined || !caches || props.live === true) return undefined;
    const held = caches.ledgers.get(at);
    if (held) caches.ledgers.delete(at);
    return held;
  })();
  const own = taken ?? ledgerOf();
  /* a view that goes after the sign-out puts nothing back (memo-cache.ts, stamp) */
  const owner = thread ? untrack(thread) : "";
  const stamp = caches?.stamp(owner) ?? 0;
  /* the turn and whether it runs, as last seen: the cleanup reads these, not the props, since reading the stage's memos while it
     takes the view down can run them again and take the same views down a second time */
  let seen = { turn: untrack(() => props.turn), live: untrack(() => props.live === true) };
  createComputed(() => (seen = { turn: props.turn, live: props.live === true }));
  onCleanup(() => {
    if (at !== undefined && caches && !seen.live) caches.keep(caches.ledgers, owner, stamp, at, own, weighTurn(seen.turn));
  });
  const entries = createMemo(() => own(props.turn, props.ctx, props.live === true));
  const grouping = groupsOf();
  const segments = createMemo(() => grouping(entries(), { running: props.live === true, ctx: props.ctx, answer: props.turn.answer }));
  /* the groups the reader opened, by key: the reader's, so they live here and not in the model */
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  /* a place is the same object while what it shows is: an entry's by the entry, a group's by the group and whether it is open */
  const entryPlaces = new WeakMap<Entry, Map<string, Place>>();
  const groupPlaces = new WeakMap<Group, Place[]>();
  const entryPlace = (entry: Entry, opened = false, gapless = false, twin = false): Place => {
    const flavour = `${opened ? 1 : 0}${gapless ? 1 : 0}${twin ? 1 : 0}`;
    let held = entryPlaces.get(entry);
    if (!held) { held = new Map(); entryPlaces.set(entry, held); }
    let place = held.get(flavour);
    if (!place) { place = { k: "entry", entry, ...(opened ? { opened } : {}), ...(gapless ? { gapless } : {}), ...(twin ? { twin } : {}) }; held.set(flavour, place); }
    return place;
  };
  const groupPlace = (group: Group, open: boolean): Place => {
    let held = groupPlaces.get(group);
    if (!held) { held = [{ k: "group", group, open: false }, { k: "group", group, open: true }]; groupPlaces.set(group, held); }
    return held[open ? 1 : 0] as Place;
  };
  const places = createMemo<Place[]>(() => {
    const open = opened();
    const out: Place[] = [];
    for (const seg of segments()) {
      if (seg.k === "entry") { out.push(entryPlace(seg.entry)); continue; }
      const g = seg.group;
      if (open.has(g.key)) {
        out.push(groupPlace(g, true));
        g.entries.forEach((e, i) => out.push(entryPlace(e, i === g.entries.length - 1 && e.model?.body !== undefined, i === 0)));
      } else {
        if (lineShown(g)) out.push(groupPlace(g, false));
        const cur = currentOf(g);
        /* a run of one live step: the line above already says when it started and how long it has run, so its row repeats neither */
        if (cur) out.push(entryPlace(cur, false, lineShown(g), lineShown(g) && g.entries[0] === cur));
      }
    }
    return out;
  }, [], { equals: sameList });
  /* a place is a control when it has something to open (RowView); a group is two, its line and its strip */
  const labelsOf = (p: Place): Label[] => (p.k === "group" ? [groupLabel(p.group), "steps of this run"] : [p.entry.model?.body !== undefined || p.entry.live !== undefined ? p.entry.model?.label : undefined]);
  const offsets = createMemo(() => { let at = 0; return places().map((p) => { const from = at; at += p.k === "group" ? 2 : 1; return from; }); });
  const names = turnNames(() => props.turn.id, () => places().flatMap(labelsOf));
  /* rows a tap on a group brings in do not rise: only what arrives while the reader watches does */
  const [toggling, setToggling] = createSignal(false);
  let ledgerEl: HTMLDivElement | undefined;
  const setOpen = (group: string, open: boolean) => {
    if (untrack(opened).has(group) === open) return;
    follow?.hold();
    setToggling(true);
    setOpened((all) => { const next = new Set(all); if (open) next.add(group); else next.delete(group); return next; });
    queueMicrotask(() => setToggling(false));
  };
  /* a tap on a step on the strip opens its group and goes to that step's row, open */
  const pick = (group: string, mark: StripMark) => {
    setOpen(group, true);
    requestAnimationFrame(() => {
      const row = ledgerEl?.querySelector<HTMLElement>(`:scope > .row:not(.group)[data-key="${CSS.escape(mark.row)}"]`);
      if (!row) return;
      if (!row.classList.contains("open")) row.querySelector<HTMLButtonElement>(":scope > button.row-h")?.click();
      light(row, row.closest<HTMLElement>(".stage-scroll") ?? undefined);
    });
  };
  return (
    <Show when={places().length}>
      <div ref={ledgerEl} class="ledger">
        <Index each={places()}>{(p, i) => (
          <Show when={p().k === "group" ? (p() as Extract<Place, { k: "group" }>) : undefined} fallback={(() => {
            const e = () => (p() as Extract<Place, { k: "entry" }>).entry;
            return (
              <>
                <Show when={!(p() as Extract<Place, { k: "entry" }>).gapless && e().gap}><div class="gap">{e().gap}</div></Show>
                <Show when={e().model} fallback={<Show when={e().say}>{(say) => <SayRow say={say()} time={e().time} enter={props.enter === true && !toggling()} />}</Show>}>{(m) => <RowView m={m()} time={(p() as Extract<Place, { k: "entry" }>).twin ? "" : e().time} clockless={(p() as Extract<Place, { k: "entry" }>).twin === true} now={props.ctx.now} cur={e().cur === true} live={e().live} enter={props.enter === true && !toggling()} name={names()[offsets()[i] ?? 0]} opened={(p() as Extract<Place, { k: "entry" }>).opened === true} />}</Show>
              </>
            );
          })()}>{(gp) => (
            <>
              <Show when={gp().group.gap}><div class="gap">{gp().group.gap}</div></Show>
              <GroupView group={gp().group} open={gp().open} now={props.ctx.now} name={names()[offsets()[i] ?? 0]} stripName={names()[(offsets()[i] ?? 0) + 1]} onToggle={() => setOpen(gp().group.key, !gp().open)} onPick={(m) => pick(gp().group.key, m)} />
            </>
          )}</Show>
        )}</Index>
      </div>
    </Show>
  );
}

/* ---------- what started the turn, and what it came to ---------- */

/** the bubble clamps at six lines, which the first thousand characters more than fill: the rest of a long prompt is not made into text the page must lay out */
export const CLAMPED_CHARS = 1200;

export function YouBubble(props: { turn: Turn }) {
  /* ten messages of one length have ten controls with the same words: the turn tells them apart (AGENTS.md, accessibility: unique names) */
  const ordinal = useOrdinal(() => props.turn.id);
  const long = () => longPrompt(props.turn.prompt);
  const [all, setAll] = createSignal(false);
  let el!: HTMLDivElement;
  const follow = useContext(FollowContext);
  // a brief from the root agent says only "brief": the title block already says whose agent this is
  const label = () => (props.turn.by === "brief" ? (props.turn.from && props.turn.from !== "root" ? `brief from ${props.turn.from}, ` : "brief, ") : "");
  return (
    <>
    {/* the photos sent with it stand above its words, thumbnails of one box that open full size (the native client's sentphotos); a photo
        sent alone has no words, and its bubble keeps its time */}
    <Show when={props.turn.photos?.length ? props.turn.photos : undefined}>{(photos) => <div class="you-photos"><Pictures groups={[{ pics: photos() }]} suffix={`, sent${ordinal()}`} /></div>}</Show>
    {/* the files sent with it (a pdf, a text file), each named by its kind and its name, between the photos and the words */}
    <Show when={props.turn.sentFiles?.length ? props.turn.sentFiles : undefined}>
      {(files) => (
        <ul class="you-files" aria-label={`files sent${ordinal()}`}>
          <For each={files()}>
            {(file) => (
              <li aria-label={file.filename}>
                <b aria-hidden="true">{typeWord(file.filename, file.mime)}</b>
                <span aria-hidden="true">{cutMiddle(file.filename, 28)}</span>
              </li>
            )}
          </For>
        </ul>
      )}
    </Show>
    <div ref={el} class="you">
      <Show when={long() && !all()} fallback={boundedPlain(props.turn.prompt).shown}>
        <span class="clamp">{props.turn.prompt.slice(0, CLAMPED_CHARS)}</span>
        <button class="all" onClick={() => { follow?.hold(); flip(flipRoot(el), () => setAll(true)); }} aria-label={`${openLabel(props.turn.prompt.length)}${ordinal()}`}>{openLabel(props.turn.prompt.length)}</button>
      </Show>
      <time>{label()}{clock(props.turn.at)}</time>
    </div>
    </>
  );
}

/** an agent's report or note: one line, a chip (the native client's decision 26). the outcome's glyph, the agent's name and the
    report's first line; a press raises the whole report in its sheet (report-sheet.tsx). one line whatever the report holds, so a
    report arriving moves the page by a line and opening it moves nothing */
export function ReportCard(props: { turn: Turn }) {
  const [reading, setReading] = createSignal(false);
  const report = createMemo(() => reportOf(props.turn));
  let el!: HTMLButtonElement;
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
    <>
      <button ref={el} class="report" data-report={props.turn.from} data-turn={props.turn.id} aria-haspopup="dialog" aria-label={`${report().spoken}${ordinal()}`} title={`opens the ${report().note ? "note" : "report"}`} onPointerDown={warmOn("ReportSheet")} onClick={() => whenLoaded("ReportSheet", () => setReading(true))}>
        <ReportGlyph report={report()} size="chip" />
        <span class="rep-line"><b>{report().name}</b><Show when={report().gist}>{(g) => <span> · {g()}</span>}</Show></span>
        <i class="rep-chev" aria-hidden="true" />
      </button>
      <Show when={reading()}>
        <ReportSheet report={report()} onClose={() => { setReading(false); el.focus({ preventScroll: true }); }} onAgent={props.turn.from ? toAgent : undefined}>
          <Markdown class="rep-b" text={props.turn.prompt} />
        </ReportSheet>
      </Show>
    </>
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
      <Markdown ref={(c) => { card = c; }} class={`sumcard ${open() ? "open" : ""}`} text={props.turn.summary ?? props.turn.answer?.text ?? ""} />
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

/** what the stage does around a turn settling (docs/thread.md, live: the prompt keeps its place) */
export type Settle = {
  /** called before the settle changes the end of the turn (the newest row closes, the reply becomes the answer, the files row arrives); returns what to call once it has */
  begin(): () => void;
};
export const SettleContext = createContext<Settle>();
/** true while the stage lands a thread it has just opened: what is painted then is not a live event and does not move */
export const LandingContext = createContext<() => boolean>();

/** a far turn's text-only stand-in (far-turn.tsx), a chunk of its own: fetched when the first turn is let go */
const StandIn = lazy(() => import("./far-turn").then((m) => ({ default: m.StandIn })));

export function TurnView(props: { turn: Turn; ctx: RowCtx; live?: boolean; now?: number }) {
  let el!: HTMLElement;
  const t = () => props.turn;
  const live = () => props.live === true;
  const settle = useContext(SettleContext);
  const win = useContext(WindowContext);
  /* an older turn is an empty box until the stage's window fills it, and stays filled (stage-window.ts); with no window, always */
  const filled = () => win === undefined || win.filled(t().id);
  const boxHeight = createMemo(() => (win === undefined ? 0 : win.height(t())));
  /* a turn that was filled and is far: its stand-in (far-turn.tsx), until it comes back within range, focus goes into it or a pointer comes over it */
  const far = createMemo(() => win?.far(t().id));
  /* what a reader watches arrive rises in: the rows of a turn that runs in front of them, and what its settle adds. what is
     painted when a thread lands does not (the rows ask LandingContext) */
  const [watched, setWatched] = createSignal(live());
  /* a settled turn whose agents still work keeps its agent rows' clock running for them (the parent is parked on them). it is handed a
     clock to run by the stage (`now`) or, in a story, by its context (`tick`); whether it is handed one does not change for the life
     of the view, so `now` is read here only for that, untracked: this must not wake every turn each second */
  const parked = createMemo(() => (props.ctx.tick !== undefined || untrack(() => props.now !== undefined)) && spawnsOf(t()).some((s) => s.agent?.child !== undefined && props.ctx.children.get(s.agent.child)?.state === "working"));
  /* the context this turn is painted in: the stage's, with the clock only where the clock is read, the running turn (`now`)
     and a turn whose agents work (`tick`: their rows' clock). the memo's equality is what this turn reads of it
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
  /* the settle changes as little as it can: the run folds whole into its group and the trailing reply becomes the answer in
     place (faded up once). the stage takes the view's place before it and gives it back after, since a
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
  onMount(() => { if (win) onCleanup(win.slot(el, () => t().id, t)); });
  /* a message that waits and has nothing of its own yet takes no room: the composer's queue shows it */
  const waits = () => (t().by === "queued" || t().by === "steer") && !t().items.length && !t().answer;
  return (
    <section ref={el} class="turn" data-turn={t().id} data-waits={waits() ? "" : undefined} data-pending={filled() ? undefined : ""} data-gist={filled() ? undefined : firstSentence(t().prompt).slice(0, 90)} data-far={far() ? "" : undefined} style={filled() ? undefined : { height: `${far()?.height ?? boxHeight()}px` }}>
      <Show when={filled()} fallback={<Show when={far()}>{(f) => <StandIn turn={t()} ctx={ctx()} far={f()} refill={() => win?.refill(t().id)} />}</Show>}>
        <Show when={t().by === "mail"}><ReportCard turn={t()} /></Show>
        <Show when={t().by === "compaction" || t().by === "notice"}><MarkLine turn={t()} /></Show>
        {/* a message that waits (queued, or a steer waiting for the step in flight) is the composer's queue's, never a bubble here: it
            draws once it lands as a turn (docs/composer.md, the queue) */}
        <Show when={t().by === "you" || t().by === "brief"}><YouBubble turn={t()} /></Show>
        {/* a compaction turn reads as any turn under its mark, its summary only in the card the mark opens; one recorded with no summary
            message keeps the old reading, its last words the summary */}
        <Show when={t().by !== "compaction" || t().summary !== undefined}>
          <Ledger turn={t()} ctx={ctx()} live={live()} enter={watched()} />
          <Show when={!live() && t().answer}>{(a) => <Answer say={a()} name={replyLabel(clock(t().at), t().prompt)} />}</Show>
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

