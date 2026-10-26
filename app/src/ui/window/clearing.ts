/* clearing a thread off home, the parts with no dom (docs/home.md, clearing).
   the marks live on the server and arrive as `entry.cleared` (membership.ts
   skips those); this decides only which windows offer a clear, which ones
   "clear done" takes, and what the controls are called. pure, so
   clearing.test.ts pins it. */

import type { WindowState, WindowView } from "./view";

/** a window that is finished or stopped waiting offers its own clear. a working window does not: the server would
    refuse it, and one that wants you has to be answered first */
const OFFERS: ReadonlySet<WindowState> = new Set<WindowState>(["done", "idle", "failed", "parked"]);

/** what "clear done" takes: threads whose turn finished, read or not. a stopped (failed) or parked thread is left,
    since it still has something to tell you */
const DONE: ReadonlySet<WindowState> = new Set<WindowState>(["done", "idle"]);

export function clearable(view: Pick<WindowView, "state">): boolean {
  return OFFERS.has(view.state);
}

export function doneKeys(views: readonly Pick<WindowView, "key" | "state">[]): string[] {
  return views.filter((view) => DONE.has(view.state)).map((view) => view.key);
}

/** the bar's pill: its words. the summary beside it counts "done" and "idle" apart, and this is the two together */
export function doneLabel(count: number): string {
  return `clear ${count}`;
}

/** the pill's accessible name: it starts with the words on it, and says what is cleared */
export function doneName(count: number): string {
  return `${doneLabel(count)} ${count === 1 ? "thread that is done or idle" : "threads that are done or idle"}`;
}

/** one window's control: unique per window, so a screen reader and a test can tell them apart. `suffix` is
    `nameSuffixes`' answer for a window whose repo, title and machine another window shares */
export function clearName(view: Pick<WindowView, "repo" | "title" | "host">, showHost = false, suffix = ""): string {
  return `clear ${view.repo}: ${view.title}${showHost ? `, ${view.host}` : ""}${suffix}`;
}

/** for windows that would have the same clear name (a fan of threads titled alike in one repo), a suffix of the
    session id as short as tells them apart (AGENTS.md, accessibility). windows with a name of their own get none. the key is
    `host:session`, and a window is the same as another when its repo, title and, if the name shows it, machine match */
export function nameSuffixes(windows: readonly Pick<WindowView, "key" | "repo" | "title" | "host">[], showHost: boolean): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const view of windows) {
    const name = clearName(view, showHost);
    groups.set(name, [...(groups.get(name) ?? []), view.key]);
  }
  const suffixes = new Map<string, string>();
  const idOf = (key: string): string => key.slice(key.indexOf(":") + 1);
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const ids = keys.map(idOf);
    const longest = Math.max(...ids.map((id) => id.length));
    let length = 4;
    while (length < longest && new Set(ids.map((id) => id.slice(-length))).size < ids.length) length += 1;
    for (const key of keys) suffixes.set(key, `, ${idOf(key).slice(-length)}`);
  }
  return suffixes;
}

/** windows the person cleared by hand and the server has not yet dropped from the order. home's reorder does not
    wait out its calm period for these: the window already left under their finger, and the rest close up at once */
const byHand = new Set<string>();

export function handCleared(key: string): boolean {
  return byHand.has(key);
}

/** the timers that let a mark go if the server's order never drops the window: one per key, so a release (or a newer
    clear of the same key) clears its own */
const letGo = new Map<string, ReturnType<typeof setTimeout>>();

/** marks `keys`, and lets them go after `HAND_MS` whatever happens, calling `expired` with the ones still marked then */
export function markHandCleared(keys: readonly string[], expired?: (keys: string[]) => void): void {
  for (const key of keys) {
    byHand.add(key);
    clearTimeout(letGo.get(key));
    letGo.delete(key);
  }
  if (!expired) return;
  const timer = setTimeout(() => {
    const still = keys.filter((key) => letGo.get(key) === timer);
    for (const key of still) letGo.delete(key);
    releaseHandCleared(still);
    expired(still);
  }, HAND_MS);
  for (const key of keys) letGo.set(key, timer);
}

export function releaseHandCleared(keys: readonly string[]): void {
  for (const key of keys) {
    byHand.delete(key);
    clearTimeout(letGo.get(key));
    letGo.delete(key);
  }
}

/** threads the person just brought back (the toast's undo, the away sheet's bring back) that the order has not yet brought
    home: like a hand clear, their windows are born without the calm wait. each lets itself go after `HAND_MS` */
const back = new Map<string, ReturnType<typeof setTimeout>>();

export function broughtBack(key: string): boolean {
  return back.has(key);
}

export function markBroughtBack(keys: readonly string[]): void {
  for (const key of keys) {
    clearTimeout(back.get(key));
    back.set(
      key,
      setTimeout(() => back.delete(key), HAND_MS),
    );
  }
}

/** how long a hand-cleared mark waits for the server's order before it is let go */
export const HAND_MS = 2500;
