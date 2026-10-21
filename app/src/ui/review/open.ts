/* which need brings the review card. no solid and no wiring here: the stage, the window's note and the card's chunk all
   ask this, and the first load carries only this much of the review (the card, its controller and its words are a
   chunk the stage loads when a review waits, stage.tsx). */

import type { Thread } from "../../sync/protocol";

export type ReviewNeed = Thread["needs"][number];

/** the session's open review need: the newest, when the checkout asked twice (each request has a need of its own) */
export function openReview(entry: Pick<Thread, "needs"> | undefined): ReviewNeed | undefined {
  return entry?.needs.filter((need) => need.kind === "review" && (need.servedAt ?? null) === null).at(-1);
}

/** the line above the composer for a review whose card is out of view (stage.tsx), as an ask's line is for an ask: the
    note on one line, and the name a screen reader and the drive read it by. an ask's line outranks it (one line at a
    time), and a card on screen needs no line */
export function reviewLine(need: ReviewNeed | undefined, inView: boolean, askLine: boolean): { note: string; name: string } | null {
  if (!need || inView || askLine) return null;
  const note = need.body.replace(/\s+/g, " ").trim();
  return { note, name: note ? `ready to merge: ${note}${/[.!?]$/.test(note) ? "" : "."} go to it` : "ready to merge. go to it" };
}
