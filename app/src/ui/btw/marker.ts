/* where a "from a btw" marker goes (docs/thread.md, btw: the marker). a promoted message names its btw by id, and the
   card lives with the thread the btw was asked in. a fork copies the parent's messages, the promoted one with its id, but
   never its btws: the card stayed with the parent, so the marker in the fork opens the parent at that card. */

/** the marker's target: the card in this thread; the parent's card, through the fork's lineage; or nowhere (a btw this
    thread does not hold, in a thread that is not a fork: nothing to go to, so the marker is words, not a control) */
export type MarkerTarget =
  | { kind: "here"; turn: string }
  | { kind: "parent"; key: string; title: string | null; cut: string | null; btw: string }
  | { kind: "none" };

/** this thread's card first: a btw asked in the fork itself, or a parent's card the fork somehow holds, is right here */
export function markerTarget(btwID: string, turnOf: (btwID: string) => string | undefined, lineage: { key: string; title: string | null; cut: string | null } | null): MarkerTarget {
  const turn = turnOf(btwID);
  if (turn !== undefined) return { kind: "here", turn };
  if (lineage) return { kind: "parent", key: lineage.key, title: lineage.title, cut: lineage.cut, btw: btwID };
  return { kind: "none" };
}

/** the marker's accessible name for a card in the thread it was forked from */
export function parentMarkerName(title: string | null): string {
  return title ? `from a btw, with its answer: go to the btw in ${title}` : "from a btw, with its answer: go to the btw in the thread this was forked from";
}

/** what a parent says when a fork's marker landed on it and the btw is not among its cards (dismissed ones still are: this
    is one let go, by the cap or by the agent) */
export const BTW_GONE = "that btw is not on this thread any more, so it opened where the fork was cut.";
