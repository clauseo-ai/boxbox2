/* what a tool row opens to when it holds a file or words (docs/thread.md, code and copying; the native client's toolrows): a read's lines
   in a bed with their numbers, its copy control and a door to the reader, the file full screen with its numbers, a wrap toggle and
   copy; a long file's bed shows its opening lines under a fade and "show all 300 lines" opens it to every line; and the slip that
   holds words an agent wrote to another (a brief, a message), its copy control in its header, a long one faded under 44 px with
   "read all 30 lines". */

import { For, type JSX, Show, createMemo, createSignal, onMount } from "solid-js";
import { CopyButton } from "./copy-button";
import type { CopyKind } from "./copy-names";
import { type FileText, type ShownFile, fileFacts, readerEnd, showAllWords, wholeFile } from "./code-text";
import { watchOverflow } from "./diff";
import { CODE_PREVIEW, CODE_WHOLE } from "./evidence";
import { plural } from "./rows";

export { type FileText, fileFacts } from "./code-text";

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

function Numbered(props: { file: FileText; wrap?: boolean; /** the bed shows only its opening lines: they fade into the control that opens the rest */ faded?: boolean }) {
  let el!: HTMLDivElement;
  onMount(() => watchOverflow(el));
  const digits = () => Math.max(2, String(props.file.from + props.file.lines.length - 1).length);
  return (
    <div ref={el} class={`bed numbered ${props.wrap ? "wrap" : ""} ${props.faded ? "faded" : ""}`} style={{ "--gutter": `${digits()}ch` }}>
      <For each={props.file.lines}>{(l, i) => <span><i aria-hidden="true">{props.file.from + i()}</i>{l || " "}</span>}</For>
    </div>
  );
}

/** "show all 300 lines": the control at the foot of a bed that shows its opening lines, which opens it in place to every line. it
    goes one way: the row's head closes the row, and the row opens again with the bed short */
export function ShowAll(props: { count: number; diff?: boolean; /** the row it is in, which its name is told apart by */ row: string; onShow: () => void }) {
  const words = () => showAllWords(props.count, props.diff === true);
  return <button class="bed-all" aria-label={`${words()}, ${props.row}`} onClick={() => props.onShow()}>{words()}<i aria-hidden="true" /></button>;
}

/** a read's lines in a bed with their numbers, headed by the file's lines and its copy control, and a door to the reader. the bed
    holds every line the read returned when the row has them; a long file shows its first lines and opens to the rest */
export function FileBed(props: { file: FileText; /** the row it is the body of, which its controls are named after */ row: string }) {
  const [reading, setReading] = createSignal(false);
  const [all, setAll] = createSignal(false);
  /* read from the step's output when the row opens, never kept on the model: a closed row costs nothing */
  const whole = createMemo(() => wholeFile(props.file));
  const long = () => whole().lines.length > CODE_WHOLE;
  const short = () => long() && !all();
  const shown = (): FileText => (short() ? { ...whole(), lines: whole().lines.slice(0, CODE_PREVIEW) } : whole());
  let door!: HTMLButtonElement;
  return (
    <div class="bed-wrap file-bed">
      <div class="cblock-h">
        <span class="cblock-lang">{fileFacts(whole())}</span>
        <button ref={door} class="file-open" aria-haspopup="dialog" aria-label={`open ${nameOf(props.file.path)} in the reader, ${props.row}`} onClick={() => setReading(true)}><i aria-hidden="true" />reader</button>
        <CopyButton kind="file" name={`copy the file, ${props.row}`} text={() => whole().lines.join("\n")} />
      </div>
      <Numbered file={shown()} faded={short()} />
      <Show when={short()}><ShowAll count={whole().lines.length} row={props.row} onShow={() => setAll(true)} /></Show>
      <Show when={reading()}><FileReader file={whole()} onClose={() => { setReading(false); door.focus({ preventScroll: true }); }} /></Show>
    </div>
  );
}

/** the file full screen: its name, its facts, wrap, copy, close; its lines with their numbers, scrolling both ways unwrapped, and
    under them what they are: the end of the read, where it stopped, or that the thread keeps only part of it */
export function FileReader(props: { file: ShownFile; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  const [wrap, setWrap] = createSignal(false);
  /* the reader itself takes focus, not its close control: a ring on close reads as a choice nobody made */
  onMount(() => { dialog.showModal(); dialog.focus(); });
  const name = () => nameOf(props.file.path);
  const dir = () => props.file.path.slice(0, Math.max(0, props.file.path.lastIndexOf("/")));
  return (
    <dialog ref={dialog} class="reader" tabIndex={-1} aria-label={`${name()}, in the reader`} on:keydown={(e) => e.key === "Escape" && e.stopPropagation()} on:close={() => props.onClose()}>
      <header class="reader-h">
        <button class="reader-x" aria-label={`close ${name()}`} onClick={() => dialog.close()}><i /></button>
        <div class="reader-name"><b>{name()}</b><span>{fileFacts(props.file)}<Show when={dir()}>{(d) => <>, in {d()}</>}</Show></span></div>
        <button class="reader-wrap" aria-pressed={wrap() ? "true" : "false"} aria-label="wrap long lines" onClick={() => setWrap(!wrap())}>wrap</button>
        <CopyButton kind="file" name={`copy the file, ${name()}`} text={() => props.file.lines.join("\n")} />
      </header>
      <div class="reader-body">
        <Numbered file={props.file} wrap={wrap()} />
        <p class="reader-end">{readerEnd(props.file)}</p>
      </div>
    </dialog>
  );
}

/** a long slip: over 700 characters or 12 lines its opening shows under a fade, and "read all N lines" opens it */
const LONG_CHARS = 700, LONG_LINES = 12;

/** words an agent wrote to another, in a slip of their own: its head says what they are ("brief for helper", "to root"), its copy
    control copies them whole */
export function Slip(props: { head: JSX.Element; text: string; copy: { kind: CopyKind; name: string } }) {
  const lines = () => props.text.split("\n").length;
  const long = () => props.text.length > LONG_CHARS || lines() > LONG_LINES;
  const [all, setAll] = createSignal(false);
  return (
    <div class={`slip ${long() && !all() ? "short" : ""}`}>
      <div class="slip-h"><span class="slip-head">{props.head}</span><CopyButton kind={props.copy.kind} name={props.copy.name} text={() => props.text} /></div>
      <div class="slip-b">{long() && !all() ? props.text.slice(0, 1600) : props.text}</div>
      <Show when={long()}><button class="slip-more" aria-expanded={all() ? "true" : "false"} aria-label={`${all() ? "show less of" : `read all ${plural(lines(), "line")} of`} ${props.copy.name.replace(/^copy /, "")}`} onClick={() => setAll(!all())}>{all() ? "show less" : `read all ${plural(lines(), "line")}`}</button></Show>
    </div>
  );
}
