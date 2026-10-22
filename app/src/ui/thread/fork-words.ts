/* the words of a fork's lineage line, divider and menu item (docs/thread.md, fork), apart from fork.ts: only the lazily loaded
   fork-ui.tsx says them, so they are not in the first load (architecture.md, the script budget) */

import type { Lineage } from "./fork";

/** the words of the lineage line */
export function lineageWords(lineage: Lineage): string {
  return lineage.title ? `forked from ${lineage.title}` : "forked from another thread";
}

/** the words of the divider at that boundary, around the link to the thread it came from */
export function boundaryWords(lineage: Lineage, ownTurns: boolean): { before: string; link: string; stop: string; after: string; name: string } {
  const title = lineage.title ?? "another thread";
  return {
    before: "forked from ",
    link: title,
    /* the full stop is its own piece so the divider can keep it on the link's line: a break between them orphaned it */
    stop: ".",
    after: ownTurns ? " everything above came from it; this thread's own turns start here." : " everything above came from it; this thread's own turns will start here.",
    name: lineage.title ? `open ${lineage.title} where this fork was cut` : "open the thread this was forked from, where it was cut",
  };
}

/** why a fork cannot be made now, in the words the control shows; null when it can. the order is what a person can do
    something about first: the connection, then the turn */
export function forkHeld(now: { streamDown: boolean; browseOnly: boolean; working: boolean }): string | null {
  if (now.browseOnly) return "imported history is browse only";
  if (now.streamDown) return "offline";
  if (now.working) return "after this turn";
  return null;
}
