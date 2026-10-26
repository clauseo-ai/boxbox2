/* the working fold (docs/home.md, the working fold; design.md, the working fold): threads at work with nothing wrong fold
   into one capsule under the bar instead of a window each. the parts with no dom: which threads fold, and the words. pure,
   so working-fold.test.ts pins them.

   a thread folds while it works (busy, retrying, queued, or parked with its agents at work) or is parked on background
   jobs alone, and has no ask and no open need. the job filter applies first (inbox/extra.ts): with job notices not counted
   as needs, an open job need does not keep a thread out. it leaves the fold the moment any of that stops holding: it
   finished, failed, asked or got a need. the thread on the stage never folds (home.tsx), so going back on the deck always
   has a window to shrink into. */

import type { Thread } from "../../sync/protocol";
import { counts } from "../inbox/extra";

/** what a folded thread is doing: at work, or parked on background jobs alone */
export type FoldKind = "working" | "waiting";

/** why a thread folds, or null when it keeps its window. `asks` is how many asks it has pending */
export function foldOf(thread: Thread, asks: number, jobsAsNeeds: boolean): FoldKind | null {
  if (asks > 0 || thread.parent) return null;
  if (thread.needs.some((need) => (need.servedAt ?? null) === null && counts(need, jobsAsNeeds))) return null;
  const activity = thread.activity;
  if (activity.state === "busy" || activity.state === "retry") return "working";
  if (activity.state === "parked") return activity.agents > 0 ? "working" : "waiting";
  return null;
}

/** the capsule's first line: "4 working, 2 waiting on a job", "4 working", "2 waiting on a job" */
export function foldWords(working: number, waiting: number): string {
  const parts = [working ? `${working} working` : "", waiting ? `${waiting} waiting on a job` : ""].filter(Boolean);
  return parts.join(", ");
}

/** the capsule's second line: who just left, while that is news, else that nothing is wrong */
export function foldHint(left: string | null): string {
  return left === null ? "nothing wrong, tap to see" : `${left} just left`;
}

/** the capsule's two lines. the words are one phrase in its name ("4 working, 2 waiting on a job"); on the capsule a phone
    has no room for both kinds beside the beads, so the waiting part takes the second line, and news of one that left
    takes it over while it is news */
export function foldLines(working: number, waiting: number, left: string | null): { first: string; second: string; waiting: boolean } {
  if (working && waiting) return { first: foldWords(working, 0), second: left === null ? foldWords(0, waiting) : foldHint(left), waiting: left === null };
  return { first: foldWords(working, waiting), second: foldHint(left), waiting: false };
}

/** the capsule's accessible name: what it says, and what a press does */
export function foldName(working: number, waiting: number, open: boolean): string {
  return `${foldWords(working, waiting)}. ${open ? "hide the list" : "show the list"}`;
}

/** how long "<repo> just left" stays the capsule's second line */
export const LEFT_MS = 30_000;

/** the repo of a thread that has just left the fold and is still on home (it finished, asked or failed), from the fold
    before and after a change: the last one that left, or null when none did (one that left the fleet, or was cleared, is
    not news) */
export function leaverOf(before: readonly string[], after: readonly string[], onHome: (key: string) => string | null): string | null {
  const now = new Set(after);
  let found: string | null = null;
  for (const key of before) {
    if (now.has(key)) continue;
    const repo = onHome(key);
    if (repo !== null) found = repo;
  }
  return found;
}
