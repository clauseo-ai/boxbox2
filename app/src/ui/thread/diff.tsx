/* a diff's bed and the fade a sideways scroller wears where it continues
   (docs/thread.md, open in place): shared by the rows and the permission
   card (ui/asks/card.tsx), which home's answer sheet draws too. */

import { For, onMount } from "solid-js";
import type { DiffLine } from "./rows";

/** marks a sideways scroller as continuing past its edge */
export function watchOverflow(el: HTMLElement): void {
  const check = () => el.classList.toggle("overflows", el.scrollWidth > el.clientWidth + 2 && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  check();
  el.addEventListener("scroll", check, { passive: true });
  void document.fonts?.ready.then(check);
}

export function DiffView(props: { lines: DiffLine[]; /** only its opening lines: they fade into the control that opens the rest */ faded?: boolean }) {
  let el!: HTMLDivElement;
  onMount(() => watchOverflow(el));
  return (
    <div ref={el} class={props.faded ? "bed faded" : "bed"}>
      <For each={props.lines}>{(l) => <span class={l.kind === "add" ? "la" : l.kind === "del" ? "ld" : l.kind === "hunk" ? "hunk" : l.kind === "tail" ? "tail-note" : ""}>{l.text || " "}</span>}</For>
    </div>
  );
}