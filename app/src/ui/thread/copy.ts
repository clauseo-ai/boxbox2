/* the copy control (docs/thread.md, code and copying). one markup for every control, built here: two sheets and the word "copy".

   a press copies in the tap's own call. the clipboard (clipboard.ts) is in the first-load script and `copyText` is called before anything is
   awaited, because on ios the textarea way (`execCommand`, what plain http over a tailnet gets) is allowed only inside the tap's own
   handler, and a lazy import in between would lose it. the outcome is drawn on the control at once; what is not time-critical (how long it
   holds, the announcement, naming namesakes) is copy-run.ts, a chunk of its own that is fetched on a quiet moment and at the latest by
   the first press, and that this file falls back from if it cannot be fetched. */

import { copyText } from "./clipboard";
import type { CopyKind } from "./copy-names";
import { loadHighlighter } from "./highlight";

/** how long "copied" holds: the same 1.6 s a lit row holds (thread.md, links) */
export const COPIED_MS = 1600;
/** a refusal is words to read, so it holds longer */
export const REFUSED_MS = 4000;
/** what a control says when the browser refuses both ways. a control whose text cannot be selected by hand (a report shown clamped, an output with its middle not shown) says what can be (`data-refused`) */
export const REFUSED_WORDS = "could not copy. select the text instead";

/** the control's insides: static, written here and nowhere else, so setting them as html carries nothing an agent wrote. the glyph is drawn by the stylesheet (thread.css, .copy-g: two sheets, and the thread's tick once it has copied), which the script budget does not count */
export const COPY_INNER = '<i class="copy-g" aria-hidden="true"></i><span class="copy-w">copy</span>';

/** a control for the markup that is not solid's (a code block's, painted by markdown.ts) */
export function copyButton(kind: CopyKind, name: string): HTMLButtonElement {
  warmLater();
  const holder = document.createElement("div");
  holder.innerHTML = `<button type="button" class="copy-btn" data-copy="${kind}">${COPY_INNER}</button>`;
  const button = holder.firstElementChild as HTMLButtonElement;
  button.dataset["name"] = name;
  button.setAttribute("aria-label", name);
  return button;
}

/** draws a control's state: its word, and `data-state` for the stylesheet (the tick, the colours) */
export function show(button: HTMLElement, state: "copied" | "refused" | null): void {
  const word = button.querySelector(".copy-w");
  if (!word) return;
  if (state) button.dataset["state"] = state; else delete button.dataset["state"];
  word.textContent = state === "copied" ? "copied" : state === "refused" ? button.dataset["refused"] ?? REFUSED_WORDS : "copy";
}

/** what a press does, as a chunk of its own */
type Press = typeof import("./copy-run");
let pressed: Press | undefined;
const press = (): Promise<Press> => import("./copy-run").then((m) => (pressed = m));

/** copies `text` for a control: called in the tap's own call, so nothing before `copyText` may wait. `said` is what is announced when it differs from "copied <the control's name>" (a copy that stopped at a cap says so) */
export function copyFrom(button: HTMLElement, text: string, said?: string): void {
  void copyText(text).then((ok) => {
    show(button, ok ? "copied" : "refused");
    /* the chunk keeps the hold and the announcement; one that cannot be fetched leaves the outcome on the control and resets it here, never silent */
    return press().then((m) => m.settle(button, ok, said), () => { setTimeout(() => show(button, null), ok ? COPIED_MS : REFUSED_MS); });
  });
}

/** a control that has left the page lets go of its timer */
export const forget = (button: Element): void => pressed?.forget(button);

/** controls that were made or taken away since the last frame: the page's controls are named again once, in the frame after, so that namesakes are told apart (copy-run.ts, renameAll). `from` is any element in the thread, or the thread itself */
const changed = new Set<Element>();
let renaming = 0;
export function renameSoon(from: Element | null): void {
  if (from) changed.add(from);
  renaming ||= requestAnimationFrame(() => {
    renaming = 0;
    const roots = new Set([...changed].map((el) => el.closest(".thread") ?? document.body));
    changed.clear();
    void press().then((m) => roots.forEach(m.renameAll), () => undefined);
  });
}

let warmed = false;
/** on a quiet moment after the first surface or control is made, fetches the highlighter, so it has usually landed before a fence needs it. what follows a copy is fetched sooner, in the frame after the first control is made (renameSoon) */
export function warmLater(after = 1500): void {
  if (warmed) return;
  warmed = true;
  setTimeout(() => void loadHighlighter(), after);
}

/** the code a block holds as the author wrote it: marked ends every block's text with a newline of its own, which is not the author's */
export const sourceOf = (code: Element | null | undefined): string => (code?.textContent ?? "").replace(/\n$/, "");
