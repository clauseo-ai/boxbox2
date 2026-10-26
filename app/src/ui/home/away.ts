/* the away sheet's words (docs/home.md, cleared while you were away), pure so away.test.ts pins them. a row says when
   the thread was done, when it was seen (or that it was not), and how long after that the server cleared it, which is
   the rule of the mode that cleared it: an hour after it was seen, or 3 hours after it was done, seen or not. */

import type { HomePrefs } from "../../store";
import type { AwayThread } from "../../sync/protocol";
import { clockOf } from "../window/view";

export { awayWords } from "./away-words";

const HOUR = 60 * 60 * 1000;

/** the line under the sheet's title, for the mode the person has chosen */
export function awaySubtitle(mode: HomePrefs["autoClear"]): string {
  switch (mode) {
    case "seen1h":
      return "each was done and seen more than an hour ago. they are still in history.";
    case "any3h":
      return "each was done more than 3 hours ago, seen or not. they are still in history.";
    case "never":
      return "each was cleared before auto-clear was turned off. they are still in history.";
    default:
      return mode satisfies never;
  }
}

/** "an hour after", "3 hours after": whole hours, never under one (the sweep runs every few minutes past the mark) */
export function hoursAfter(ms: number): string {
  const hours = Math.max(1, Math.floor(ms / HOUR));
  return hours === 1 ? "an hour after" : `${hours} hours after`;
}

/** "done 13:48, seen 13:55, cleared an hour after", "done 09:10, not seen, cleared 3 hours after". the clear is counted
    from what the mode counts from: the seen under "1 h after seen" (when there was one), the done otherwise */
export function awayDetail(row: Pick<AwayThread, "doneAt" | "seenAt" | "clearedAt">, mode: HomePrefs["autoClear"]): string {
  const seen = row.seenAt ?? null;
  const from = mode === "seen1h" && seen !== null ? seen : row.doneAt;
  return `done ${clockOf(row.doneAt)}, ${seen === null ? "not seen" : `seen ${clockOf(seen)}`}, cleared ${hoursAfter(row.clearedAt - from)}`;
}
