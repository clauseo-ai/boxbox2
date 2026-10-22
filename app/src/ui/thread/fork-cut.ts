/* where a fork through a turn is cut (docs/thread.md, fork), apart from fork.ts: read only at a press, through
   fork-act.ts, so not in the first load (architecture.md, the script budget) */

import type { Cut } from "./fork";
import type { Turn } from "./model";

/** a turn that waits (queued, or a steer before its step) has not run: there is no "through its end" to fork at */
const waits = (t: Pick<Turn, "by" | "items" | "answer">): boolean => (t.by === "queued" || t.by === "steer") && !t.items.length && !t.answer;

/** where a fork through the end of the turn `id` is cut: before the next turn's first message, or nowhere (the whole
    thread) after the last. none for a turn that is running or has not run, and for a turn the thread does not have */
export function cutAfter(turns: readonly Pick<Turn, "id" | "by" | "status" | "items" | "answer">[], id: string): Cut | null {
  const at = turns.findIndex((t) => t.id === id);
  const turn = turns[at];
  if (!turn || turn.status === "working" || waits(turn)) return null;
  const next = turns[at + 1];
  return next ? { before: next.id } : {};
}
