/* the copy control for what solid paints (a reply, a report, a command, its output); a code block's is made by markdown.ts.
   the same markup (copy.ts) and the same outcome on it. the text is read when it is pressed, so a control never holds a copy of it, and it is
   copied in the press's own call (copy.ts says why). */

import { createEffect, onCleanup, onMount } from "solid-js";
import { COPY_INNER, copyFrom, forget, renameSoon, warmLater } from "./copy";
import type { CopyKind } from "./copy-names";

/** what a press copies; `said` is what is announced when it is not "copied <the name>" */
export type Copying = { text: string; said?: string };

export function CopyButton(props: {
  kind: CopyKind;
  /** what it copies, in words: its name until the page has a namesake of it (copy-names.ts) */
  name: string;
  text: () => string | Copying;
  /** what it says when the browser refuses, for text the reader cannot select by hand (a clamped report, an output with its middle cut) */
  refused?: string | undefined;
  class?: string;
}) {
  warmLater();
  let el!: HTMLButtonElement;
  let thread: Element | null = null;
  onMount(() => { thread = el.closest(".thread"); });
  /* named with the rest when it is made, and again when its name changes (the row it belongs to was told apart from a new namesake) */
  createEffect(() => { void props.name; renameSoon(el); });
  onCleanup(() => { forget(el); renameSoon(thread); });
  const press = () => {
    const made = props.text();
    if (typeof made === "string") copyFrom(el, made); else copyFrom(el, made.text, made.said);
  };
  return (
    <button ref={el} type="button" class={`copy-btn ${props.class ?? ""}`} data-copy={props.kind} data-name={props.name} data-refused={props.refused} aria-label={props.name} innerHTML={COPY_INNER} onClick={press} />
  );
}
