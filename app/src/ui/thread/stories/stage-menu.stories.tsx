/* the thread menu (docs/thread.md, navigation), open on the real stage over the shell's thread story: where the panel goes,
   what is done to the thread (compact, copy link), archive. one with a compaction running, which the composer's card shows
   too, since both read the one state per thread (composer/compact.ts) */

import { applyPatches, setCompaction, state } from "../../../store";
import type { Message } from "../../../sync/protocol";
import { onShell } from "./on-shell";

export default { title: "stage" };

const openMenu = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(".stage-bar .more")?.click();

export const MenuOpen = onShell((_key, el) => openMenu(el));

/** a turn running with the big title scrolled away: the bar carries stop, so it is in reach at any scroll */
export const BarStop = onShell((key) => applyPatches([{ path: ["fleet", "threads", key, "activity"], value: { state: "busy", since: Date.now() - 42_000 } }]));

/** the reader scrolls up by their own hand (a wheel), then `n` messages arrive below them */
function scrolledUp(key: string, el: HTMLElement, n: number): void {
  const scroller = el.querySelector<HTMLElement>(".stage-scroll");
  if (!scroller) return;
  // after the stage has landed at the end and filled the rest of the thread in above it, which takes it its first second
  setTimeout(() => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    scroller.scrollTop = 0;
    const held = state.threads[key]?.messages ?? [];
    const last = held.at(-1);
    if (!last || !n) return;
    setTimeout(() => {
      const more: Message[] = Array.from({ length: n }, (_, i) => ({ ...last, info: { ...last.info, id: `msg_more_${i}` }, parts: [] }));
      applyPatches([{ path: ["threads", key, "messages"], value: [...held, ...more] }]);
    }, 300);
  }, 1500);
}

/** a screen or more above the end with nothing new: the jump shows alone */
export const JumpFar = onShell((key, el) => scrolledUp(key, el, 0));
/** three messages came below the reader: the jump carries the count */
export const JumpNewBelow = onShell((key, el) => scrolledUp(key, el, 3));
/** more than 99 came: the count says 99+ */
export const JumpMany = onShell((key, el) => scrolledUp(key, el, 120));

/** a compaction asked for from the menu: the item says "compacting" and is held, and the composer's card says it with its clock */
export const MenuCompacting = onShell((key, el) => {
  setCompaction(key, { state: "running", since: Date.now() - 12_000 });
  openMenu(el);
});
