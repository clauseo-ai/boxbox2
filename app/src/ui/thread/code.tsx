/* what a tool row opens to when it holds a file, a script or words (docs/thread.md, code and copying; the native client's toolrows): a read's lines
   in a bed with their numbers, its copy control and a door to the reader, the file full screen with its numbers, a wrap toggle and
   copy (reader.tsx, a chunk of its own: ui/later.ts); a long file's bed shows its opening lines under a fade and "show all 300 lines" opens it to every line; a script's
   code highlighted as a code block's, and long, shortened the same way; and the slip that
   holds words an agent wrote to another (a brief, a message), its copy control in its header, a long one faded under 44 px with
   "read all 30 lines". a chunk of its own (ui/later.ts): it draws only in a row someone opened, and the shell warms it once the
   launch has painted (architecture.md, the script budget). */

import { For, type JSX, Show, createMemo, createSignal, onMount } from "solid-js";
import { CopyButton } from "./copy-button";
import { type CopyKind, scriptLabel } from "./copy-names";
import { highlight, highlighterReady, loadHighlighter } from "./highlight";
import { cutRuns } from "./big-text";
import { FileReader as LazyReader, warmOn, whenLoaded } from "../later";
import { type FileText, fileFacts, wholeFile } from "./code-text";
import { ShowAll } from "./show-all";
import { watchOverflow } from "./diff";
import { CODE_PREVIEW, CODE_WHOLE } from "./evidence";
import { plural } from "./rows";

export { type FileText, fileFacts } from "./code-text";

export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

export function Numbered(props: { file: FileText; wrap?: boolean; /** the bed shows only its opening lines: they fade into the control that opens the rest */ faded?: boolean }) {
  let el!: HTMLDivElement;
  onMount(() => watchOverflow(el));
  const digits = () => Math.max(2, String(props.file.from + props.file.lines.length - 1).length);
  return (
    <div ref={el} class={`bed numbered ${props.wrap ? "wrap" : ""} ${props.faded ? "faded" : ""}`} style={{ "--gutter": `${digits()}ch` }}>
      <For each={props.file.lines}>{(l, i) => <span><i aria-hidden="true">{props.file.from + i()}</i>{l || " "}</span>}</For>
    </div>
  );
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
        <button ref={door} class="file-open" aria-haspopup="dialog" aria-label={`open ${nameOf(props.file.path)} in the reader, ${props.row}`} onPointerDown={warmOn("FileReader")} onClick={() => whenLoaded("FileReader", () => setReading(true))}><i aria-hidden="true" />reader</button>
        <CopyButton kind="file" name={`copy the file, ${props.row}`} text={() => whole().lines.join("\n")} />
      </div>
      <Numbered file={shown()} faded={short()} />
      <Show when={short()}><ShowAll count={whole().lines.length} row={props.row} onShow={() => setAll(true)} /></Show>
      <Show when={reading()}><LazyReader file={whole()} onClose={() => { setReading(false); door.focus({ preventScroll: true }); }} /></Show>
    </div>
  );
}

/** a script's code (cmx2's `run`) in a code block of its own: "script" and its copy control in the header, the code highlighted as
    javascript under them, scrolling on its own and fading at the edge it continues past. past 40 lines its first 14 fade into "show
    all 86 lines", which opens it in place. the code is plain until the highlighter lands (a chunk of its own, highlight.ts), and paints
    the moment it does. the copy is the code exactly as it was sent */
export function ScriptBed(props: { code: string; /** the row it is the body of, which its controls are named after */ row: string }) {
  let pre!: HTMLPreElement;
  onMount(() => watchOverflow(pre));
  const [all, setAll] = createSignal(false);
  /* the agent's closing newline is not a line of the script; the copy keeps it */
  const lines = createMemo(() => props.code.replace(/\n+$/, "").split("\n"));
  const short = () => lines().length > CODE_WHOLE && !all();
  /* a run too long to lay out (a pasted data url) is cut for the page, as a fence's is (big-text.ts); the copy is still the whole */
  const shown = createMemo(() => cutRuns((short() ? lines().slice(0, CODE_PREVIEW) : lines()).join("\n")));
  const [ready, setReady] = createSignal(highlighterReady());
  if (!ready()) void loadHighlighter().then(() => setReady(highlighterReady()));
  const painted = createMemo(() => (ready() ? highlight("javascript", shown()) : undefined));
  return (
    <div class="cblock script-bed">
      <div class="cblock-h"><span class="cblock-lang">script</span><CopyButton kind="script" name={scriptLabel(props.row)} text={() => props.code} /></div>
      {/* the highlighter's html is the code escaped into its own spans (as a fence's in markdown.ts): nothing the agent wrote is markup */}
      <pre ref={pre} class={short() ? "faded" : ""}><Show when={painted()} fallback={<code>{shown()}</code>}>{(html) => <code innerHTML={html()} />}</Show></pre>
      <Show when={short()}><ShowAll count={lines().length} row={props.row} onShow={() => setAll(true)} /></Show>
    </div>
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
