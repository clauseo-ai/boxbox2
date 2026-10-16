/* the reader (docs/thread.md, code and copying; the native client's toolrows): a read's file full screen, from the door in
   its bed (code.tsx). it opens at a press, so it is a chunk of its own (ui/later.ts). */

import { Show, createSignal, onMount } from "solid-js";
import { Numbered, nameOf } from "./code";
import { type ShownFile, fileFacts, readerEnd } from "./code-text";
import { CopyButton } from "./copy-button";

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
