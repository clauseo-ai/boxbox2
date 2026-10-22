/* what a row opens to when it is an agent's (its facts, its brief, the door to its thread), a search's hits, a plan's items, the files
   row's list (each file's diff on a tap), an edit's or a write's diff, or its thoughts: drawn only in a row someone opened (a failed search or edit, a settled permission's row, or every thought row under
   "show thinking", open on their own, wait for the chunk, which is warmed with the surfaces as the launch goes idle), so split from the first load as code.tsx is (ui/later.ts;
   architecture.md, the script budget). their styles stay in thread.css */

import { For, Show, createMemo, createSignal, useContext } from "solid-js";
import { Slip } from "../later";
import { DiffView } from "./diff";
import { flip } from "./motion";
import { type Body, type DiffLine, type FileLine, clockS, dur, n, plural } from "./rows";
import { boundedPlain } from "./big-text";
import { DIFF_PREVIEW, DIFF_WHOLE, wholeLines } from "./evidence";
import { ShowAll } from "./show-all";
import { base, dirOf } from "./shell";
import { BedView, Facts, FileBar, FileName, FollowContext, OpenAgentContext, inlineNodes } from "./thread";

export function HitsBody(props: { b: Extract<Body, { k: "hits" }> }) {
  return (
            <>
              <Show when={props.b.files.length}>
                <div class="hits"><For each={props.b.files}>{(f) => <div><div class="hf">{base(f.path)}<span>  {dirOf(f.path)}</span></div><For each={f.hits}>{(h) => <div class="hl"><i>{h.line}</i><span>{h.text}</span></div>}</For></div>}</For></div>
              </Show>
              <Show when={props.b.list.length}><div class="hits"><For each={props.b.list}>{(h) => <div class="hl"><i /><span>{h}</span></div>}</For></div></Show>
              <Show when={!props.b.files.length && !props.b.list.length && props.b.spread.length}><Facts facts={props.b.spread.slice(0, 8).map((s) => ({ text: s.n ? `${s.name} ${s.n}` : s.name }))} /></Show>
              <Show when={props.b.error}>{(e) => <BedView bed={{ lines: e().split("\n").slice(0, 12) }} cls="err" />}</Show>
            </>
          );
}

export function PlanBody(props: { b: Extract<Body, { k: "plan" }> }) {
  return <div><For each={props.b.todos}>{(t) => <div class={`todo ${t.status}`}><i /><span>{t.content}</span></div>}</For></div>;
}

export function FilesBody(props: { b: Extract<Body, { k: "files" }>; root: () => HTMLElement }) {
  return <div><For each={props.b.files}>{(f) => <FileEntry f={f} root={props.root} />}</For></div>;
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


export function AgentBody(props: { b: Extract<Body, { k: "agent" }> }) {
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

export function ThoughtsBody(props: { b: Extract<Body, { k: "thoughts" }> }) {
  return <div><For each={props.b.thoughts}>{(t) => <div class="thought-text"><Show when={props.b.thoughts.length > 1}><small>{clockS(t.at)}{t.ms >= 1000 ? `, ${dur(t.ms)}` : ""}</small></Show><For each={boundedPlain(t.text).shown.split(/\n{2,}/)}>{(p) => <p>{inlineNodes(p)}</p>}</For></div>}</For></div>;
}

/** an edit's diff: whole up to DIFF_WHOLE lines; a longer one shows its first DIFF_PREVIEW under a fade, and "show the whole diff"
    opens it in place, a write's from the content the agent sent (its diff keeps 80 lines) */
export function DiffBed(props: { lines: DiffLine[]; wrote?: string | undefined; row: string }) {
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
