/* what follows a copy (docs/thread.md, code and copying): how long the outcome holds on the control, what is announced, and naming namesakes. the copy
   itself and the outcome's first drawing are copy.ts, in the tap's own call; this is the chunk of its own that keeps the first-load script inside its
   script budget. on success the control holds "copied" with the tick for 1.6 s, the same time a lit row holds, then goes back; a refusal holds
   longer, since it is words to read. the state is announced through one visually hidden status in the thread, never through the control's name,
   which stays what automation found it by. */

import { COPIED_MS, REFUSED_MS, REFUSED_WORDS, show } from "./copy";
import { namesOf } from "./ledger";

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** a control that has left the page lets go of its timer */
export function forget(button: Element): void {
  const held = timers.get(button);
  if (held !== undefined) clearTimeout(held);
  timers.delete(button);
}

/** the one visually hidden status a thread has: a polite live region, made when the first copy is announced */
function statusOf(button: HTMLElement): HTMLElement {
  const root = button.closest<HTMLElement>(".thread") ?? button.ownerDocument.body;
  const had = root.querySelector<HTMLElement>(":scope > .copy-status");
  if (had) return had;
  const status = button.ownerDocument.createElement("div");
  status.className = "copy-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  root.append(status);
  return status;
}

/** "copy the typescript code" announces as "copied the typescript code" */
export const announcement = (name: string): string => (name.startsWith("copy ") ? `copied ${name.slice(5)}` : "copied");

/** keeps an outcome on a control for its time and announces it. pressing again while it holds starts the hold over; the status is emptied at the end only if it still holds this press's words, so a later press's are not cut short */
export function settle(button: HTMLElement, ok: boolean, said?: string): void {
  forget(button);
  const words = ok ? said ?? announcement(button.getAttribute("aria-label") ?? "") : button.dataset["refused"] ?? REFUSED_WORDS;
  const status = statusOf(button);
  // emptied first, so the same words said twice in a row are said twice
  status.textContent = "";
  requestAnimationFrame(() => { status.textContent = words; });
  timers.set(button, setTimeout(() => { timers.delete(button); show(button, null); if (status.textContent === words) status.textContent = ""; }, ok ? COPIED_MS : REFUSED_MS));
}

const NONE: ReadonlyMap<string, number> = new Map();
/** names every copy control in a thread, in document order: its base name (`data-name`), and for the second of a kind "again", then "third time" (ledger.ts, namesOf). the page is read as it stands, so a control that appears above another (a row opened) moves the namesakes below it on by one. a far turn's stand-in holds its controls as hidden marks (far.ts), counted here, so letting a turn go renames nothing below it */
export function renameAll(root: Element): void {
  const controls = Array.from(root.querySelectorAll<HTMLElement>("button[data-copy], [data-copy-held]"));
  const names = namesOf(controls.map((b) => b.dataset["name"]), NONE);
  controls.forEach((b, i) => { const name = names[i]; if (name && b.getAttribute("aria-label") !== name) b.setAttribute("aria-label", name); });
}
