/* what the window reads of a filled turn before it lets it go (docs/thread.md, the window: far turns), a chunk of its own, fetched when the
   first turn waits to be let go: whether the turn holds anything of the reader's, which keeps it filled, and the copy controls its stand-in
   keeps as hidden marks */

import { FAR_PER_TASK, type FarCopy, type FarTurn, longPrompt } from "./far";

/** whether a filled turn holds something of the reader's that a stand-in would take away: the focus, a selection, a row or a group
    opened (anything expanded), a sheet or a picture open, a copy control's "copied", a field, a bubble opened whole, or a box scrolled
    (a code block, a bed). any of them keeps the turn filled */
function holdsReader(el: HTMLElement, prompt: string): boolean {
  const doc = el.ownerDocument as Document | undefined;
  if (!doc) return false;
  const active = doc.activeElement;
  if (active && active !== doc.body && el.contains(active)) return true;
  const selection = doc.getSelection();
  for (let i = 0; i < (selection?.rangeCount ?? 0); i++) {
    const range = selection?.getRangeAt(i);
    if (range && !range.collapsed && range.intersectsNode(el)) return true;
  }
  if (el.querySelector('[aria-expanded="true"], dialog[open], button[data-copy][data-state], input, textarea, select, [contenteditable]')) return true;
  if (longPrompt(prompt) && el.querySelector(".you") && !el.querySelector(".you > .clamp")) return true;
  return Array.from(el.querySelectorAll("*")).some((node) => node.scrollTop !== 0 || node.scrollLeft !== 0);
}

/** the copy controls a turn holds, in order */
const copiesIn = (el: HTMLElement): FarCopy[] =>
  typeof el.querySelectorAll === "function" ? Array.from(el.querySelectorAll<HTMLElement>("button[data-copy]"), (b) => ({ kind: b.dataset["copy"] ?? "", name: b.dataset["name"] ?? "" })) : [];

/** of the turns waiting to be let go, the first few that may be (`look` answers a turn still filled, far and not always filled, with its box,
    prompt and height): each looked at leaves the wait, and one that holds nothing of the reader's is answered with its stand-in's makings */
export function pick(letting: Set<string>, look: (id: string) => { el: HTMLElement; prompt: string; height: number } | undefined): Array<[string, FarTurn]> {
  const ready: Array<[string, FarTurn]> = [];
  for (const id of letting) {
    if (ready.length >= FAR_PER_TASK) break;
    letting.delete(id);
    const t = look(id);
    if (t && t.height > 0 && !holdsReader(t.el, t.prompt)) ready.push([id, { height: t.height, copies: copiesIn(t.el) }]);
  }
  return ready;
}
