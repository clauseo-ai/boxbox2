/* the board's stories (docs/design.md, the board): home as the recorded journal ended, with a board's digits arriving,
   changing, leaving, at rest, on the folded rail and strip, and under reduced motion. each story plays its move, holds
   the frame the screenshot should show (a move in flight is paused part way), and says what it measured on its root:
   the layout shift and the long tasks while the digits moved, the keys drawn, and whether every window's name carries
   its key and stays unique. .ladle/shots.ts reads that and fails the story on any of it. */

import { boardGone, boardHere } from "../../store";
import { setMotionChoice } from "../../motion/animate";
import { type HomeStory, mountHome } from "../../ui/home/stories/mount";

export type BoardStory = "arriving" | "changing" | "leaving" | "seated" | "strip-folded" | "rail-folded" | "reduced";

/** the frame a move in flight is held at, ms in: the snap spring covers most of its way in its first third, so each is early
    enough to see it moving and late enough to see where it goes (an arrival's key starts 70 ms after its chip moves) */
const HOLD_MS = { arriving: 200, changing: 70, leaving: 120 };

const HOMES: Record<BoardStory, HomeStory> = {
  arriving: "live",
  changing: "live",
  leaving: "live",
  seated: "live",
  "strip-folded": "strip-folded",
  "rail-folded": "details",
  reduced: "live",
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** the windows home drew, in its order, once it has drawn them */
async function windows(root: HTMLElement): Promise<string[]> {
  for (let i = 0; i < 80; i++) {
    const keys = [...root.querySelectorAll<HTMLElement>(".win[data-key]")].map((el) => el.dataset.key ?? "");
    if (keys.length > 0 && root.querySelector("[data-ready]")) return keys;
    await wait(50);
  }
  return [];
}

/** the seats a board shows for these windows: digit n for window n, from `from`, with the windows in `bound` paired */
const seatsOf = (keys: string[], from = 1, bound: number[] = []) => keys.slice(0, 9).map((key, i) => ({ key, digit: ((i + from - 1) % 9) + 1, ...(bound.includes(i) ? { bound: true } : {}) }));

export function mountBoard(el: HTMLElement, story: BoardStory): () => void {
  const host = document.createElement("div");
  host.className = "board-story";
  el.append(host);
  const disposeHome = mountHome(host, HOMES[story]);
  let gone = false;
  let shift = 0;
  let longest = 0;
  const shifts = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!entry.hadRecentInput) shift += entry.value;
  });
  const tasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longest = Math.max(longest, entry.duration);
  });
  void (async () => {
    const keys = await windows(host);
    // the details' story opens them first; its digits come once the rail has folded for them
    if (story === "rail-folded") await wait(1700);
    if (gone) return;
    // the chunk is in before the board comes, as it is in the app for every board frame after the first
    await import("../board");
    if (story === "reduced") setMotionChoice("reduced");
    shifts.observe({ type: "layout-shift", buffered: false });
    tasks.observe({ type: "longtask", buffered: false });
    let held = false;
    if (story === "arriving") {
      boardHere(seatsOf(keys, 1, [1]));
      await wait(HOLD_MS.arriving);
      held = true;
    } else if (story === "changing") {
      boardHere(seatsOf(keys, 1));
      await wait(900);
      boardHere(seatsOf(keys, 4, [0, 2]));
      await wait(HOLD_MS.changing);
      held = true;
    } else if (story === "leaving") {
      boardHere(seatsOf(keys, 1, [1]));
      await wait(900);
      boardGone();
      await wait(HOLD_MS.leaving);
      held = true;
    } else {
      boardHere(seatsOf(keys, 1, [1]));
      await wait(900);
    }
    if (gone) return;
    const moving = document.getAnimations().filter((a) => a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.closest(".bkey, .wh > .chip"));
    if (held) for (const animation of moving) animation.pause();
    const names = [...host.querySelectorAll<HTMLElement>(".win-open, .swatch")].filter((b) => !b.closest("[inert]")).map((b) => b.getAttribute("aria-label") ?? "");
    const seated = story !== "leaving";
    const data = host.dataset;
    data.shift = String(Math.round(shift * 1000));
    data.longest = String(Math.round(longest));
    data.keys = String(host.querySelectorAll(".bkey:not([hidden])").length);
    data.named = String(names.filter((n) => /, board key [1-9]/.test(n)).length);
    data.names = String(names.length);
    data.unique = String(new Set(names).size === names.length);
    data.moving = String(moving.length);
    data.seated = String(seated);
    data.done = "1";
    shifts.disconnect();
    tasks.disconnect();
  })();
  return () => {
    gone = true;
    shifts.disconnect();
    tasks.disconnect();
    boardGone();
    setMotionChoice("system");
    disposeHome();
    host.remove();
  };
}
