/* forking a thread (docs/thread.md, fork): where a fork from a turn is cut, when a fork is held, and the line a forked
   thread shows about the thread it came from. pure, so the stage and its turns only render what these say. the server
   cuts a fork before a message of the thread (`POST /api/agents/{agent}/threads/{thread}/fork`, `before`): a turn is
   forked through its end by cutting before the first message of the turn after it, and the last turn by forking the
   whole thread. */

import type { Turn } from "./model";

/** what the fork request carries: the first message the fork leaves out, or none for the whole thread */
export type Cut = { before?: string };

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

/** why a fork cannot be made now, in the words the control shows; null when it can. the order is what a person can do
    something about first: the connection, then the turn */
export function forkHeld(now: { streamDown: boolean; browseOnly: boolean; working: boolean }): string | null {
  if (now.browseOnly) return "imported history is browse only";
  if (now.streamDown) return "offline";
  if (now.working) return "after this turn";
  return null;
}

/** the visible name of a turn's fork control is the same on every turn; its accessible one tells them apart as the
    reply's copy control does (copy-names.ts, replyLabel): the turn's clock and its prompt's first line */
export function forkLabel(clock: string, prompt: string): string {
  return `fork from here, ${clock}, ${prompt.split("\n").find((l) => l.trim())?.trim().slice(0, 40) || "an image"}`;
}

/** the thread a forked thread came from, as its line says it and its link opens it */
export type Lineage = {
  /** `<agent>:<thread>` */
  key: string;
  /** the thread's title while the fleet holds it; null when it does not (archived, not on home, never seen) */
  title: string | null;
  /** the message the fork was cut before, which the link lands just above; null for a fork of the whole thread */
  cut: string | null;
};

/** the lineage of a thread from its `forkedFrom` (absent on a server or agent that does not say): its agent is the
    thread's own, since a fork never crosses agents */
export function lineageOf(forkedFrom: { thread: string; message?: string | null } | null | undefined, agent: string, titleOf: (key: string) => string | undefined): Lineage | null {
  if (!forkedFrom?.thread) return null;
  const key = `${agent}:${forkedFrom.thread}`;
  return { key, title: titleOf(key) || null, cut: forkedFrom.message ?? null };
}

/** the words of the lineage line */
export function lineageWords(lineage: Lineage): string {
  return lineage.title ? `forked from ${lineage.title}` : "forked from another thread";
}

/** where a fork's copied history ends: the last turn that began before the fork was made. the copies keep the times the
    parent's messages were written at, and the fork's own turns are written after it was made, so the thread's creation time
    splits them; positions would need the count of copied messages, which no client is told. null when no turn shown is a
    copy (a fork cut before its first turn, or one whose copied turns are not read yet) */
export function forkBoundary(turns: readonly Pick<Turn, "id" | "at">[], created: number): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn && turn.at < created) return turn.id;
  }
  return null;
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

/** the turn a link to a fork's cut lands on: the one just above the message it was cut before. a cut that is not a turn
    of the thread (cut by another client inside a turn, or gone since) lands nowhere, and the thread opens at its end */
export function turnBeforeCut(turns: readonly Pick<Turn, "id">[], cut: string): string | null {
  const at = turns.findIndex((t) => t.id === cut);
  if (at < 0) return null;
  return (turns[at - 1] ?? turns[at])?.id ?? null;
}
