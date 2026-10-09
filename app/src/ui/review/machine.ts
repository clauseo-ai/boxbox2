/* what the review card is doing, as one pure step function: the need that
   brings it, the read of the checkout, a merge or a discard in flight, the fold
   into one line, and the problem a refusal leaves beside the card. the
   controller (control.ts) turns events into calls and calls into events; this
   decides what each leaves behind, so the rules are tested without a browser. */

import { type Discarded, discardedLine, GONE_LINE, holds, type Merged, mergedLine, type Phase, type Problem, type Review } from "./model";

export type Fold = { kind: "merged" | "discarded" | "gone"; line: string };

export type State = {
  /** the need the card answers; null while there is no card */
  id: string | null;
  phase: Phase;
  review: Review | null;
  problem: Problem | null;
  /** the discard has been asked about once, in words, and waits for a second tap */
  confirming: boolean;
  /** the one line a merge or a discard leaves */
  fold: Fold | null;
};

export const none: State = { id: null, phase: "reading", review: null, problem: null, confirming: false, fold: null };

export type Event =
  | { type: "need"; id: string }
  | { type: "gone" }
  | { type: "read"; review: Review }
  | { type: "unread"; problem: Problem }
  | { type: "retry" }
  | { type: "merge" }
  | { type: "merged"; result: Merged }
  | { type: "ask-discard" }
  | { type: "keep" }
  | { type: "discard" }
  | { type: "discarded"; result: Discarded }
  | { type: "failed"; problem: Problem };

/** the card for a checkout the daemon no longer has: one line, and it leaves when the need is served */
const vanished = (state: State): State => ({ ...state, phase: "gone", review: null, problem: null, confirming: false, fold: { kind: "gone", line: GONE_LINE } });

export function step(state: State, event: Event): State {
  switch (event.type) {
    case "need":
      // the same need again changes nothing; a new one is a new card, unless a call is out (its answer folds the old card)
      if (event.id === state.id || state.phase === "merging" || state.phase === "discarding") return state.id === null ? { ...none, id: event.id } : state;
      return { ...none, id: event.id };
    case "gone":
      // the server serves the need as it merges: a card in a call, or folded, stays to say what happened
      return holds(state.phase) ? state : none;
    case "read":
      return state.id === null || state.phase !== "reading" ? state : { ...state, phase: "ready", review: event.review, problem: null };
    case "unread":
      if (state.id === null || state.phase !== "reading") return state;
      return event.problem.kind === "gone" ? vanished(state) : { ...state, problem: event.problem };
    case "retry":
      return state.phase === "reading" ? { ...state, problem: null } : state;
    case "merge":
      return state.phase === "ready" ? { ...state, phase: "merging", problem: null, confirming: false } : state;
    case "merged":
      return state.phase === "merging" ? { ...state, phase: "merged", problem: null, fold: { kind: "merged", line: mergedLine(event.result) } } : state;
    case "ask-discard":
      return state.phase === "ready" ? { ...state, confirming: true, problem: null } : state;
    case "keep":
      return { ...state, confirming: false };
    case "discard":
      return state.phase === "ready" && state.confirming ? { ...state, phase: "discarding", problem: null, confirming: false } : state;
    case "discarded":
      return state.phase === "discarding" ? { ...state, phase: "discarded", problem: null, fold: { kind: "discarded", line: discardedLine(event.result) } } : state;
    case "failed":
      // a call that did not do its work leaves the card as it was, with the reason beside it
      if (state.phase !== "merging" && state.phase !== "discarding") return state;
      return event.problem.kind === "gone" ? vanished(state) : { ...state, phase: "ready", problem: event.problem };
    default: {
      const never: never = event;
      return never;
    }
  }
}
