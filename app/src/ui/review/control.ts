/* the review card's controller: the open review need on a session brings a
   card; the checkout is read once for it, and merge and discard call the server
   and fold the card into its line when the server says it is done. the card
   reads accessors and calls these verbs and holds nothing of its own
   (machine.ts decides every transition). */

import { type Accessor, createSignal, onCleanup, untrack } from "solid-js";
import type { ReviewApi } from "./api";
import { type Event, type Fold, none, step } from "./machine";
import type { Phase, Problem, Review } from "./model";
import type { ReviewNeed } from "./open";

export type ReviewControl = {
  /** the need the card shows, kept while a call is out or the card is folded */
  need: Accessor<ReviewNeed | null>;
  phase: Accessor<Phase>;
  review: Accessor<Review | null>;
  problem: Accessor<Problem | null>;
  confirming: Accessor<boolean>;
  fold: Accessor<Fold | null>;
  /** the card folded in front of the reader (an earned moment); one that arrived folded, or after a reload, never plays */
  earned: Accessor<boolean>;
  /** a person pressed merge or discard on this card: the keyboard was on it, so it follows the card into its line */
  pressed: Accessor<boolean>;
  merge: () => void;
  askDiscard: () => void;
  keep: () => void;
  discard: () => void;
  retry: () => void;
};

export function createReviewControl(input: { host: Accessor<string>; session: Accessor<string>; api: ReviewApi }): { control: ReviewControl; offer: (need: ReviewNeed | undefined) => void } {
  const api = input.api;
  const [state, setState] = createSignal(none);
  const [held, setHeld] = createSignal<ReviewNeed | null>(null);
  const [earned, setEarned] = createSignal(false);
  const [pressed, setPressed] = createSignal(false);
  /** the open review need as the stage last saw it, for a card that was busy when a newer request came */
  let latest: ReviewNeed | undefined;
  /** which read or call a late answer belongs to: a card that was replaced or has gone ignores it */
  let epoch = 0;
  onCleanup(() => epoch++);

  const send = (event: Event): void => {
    setState((now) => step(now, event));
  };

  async function read(): Promise<void> {
    const mine = ++epoch;
    const result = await api.read(input.host(), input.session());
    if (mine !== epoch) return;
    send(result.ok ? { type: "read", review: result.value } : { type: "unread", problem: result.problem });
  }

  /** the session's open review need, as the stage sees it now. an effect calls this on every change of the needs, so what it
      reads of its own state is not tracked: it would run itself again */
  function offer(need: ReviewNeed | undefined): void {
    latest = need;
    untrack(() => settle(need));
  }

  function settle(need: ReviewNeed | undefined): void {
    if (need) {
      const before = state().id;
      send({ type: "need", id: need.id });
      if (state().id === need.id) setHeld(need);
      if (before !== state().id) { setEarned(false); setPressed(false); void read(); }
      return;
    }
    send({ type: "gone" });
    if (state().id === null) { epoch++; setHeld(null); setEarned(false); setPressed(false); }
  }

  /** a call in flight keeps its epoch: only a replaced card moves it on */
  async function act<T>(start: Event, call: () => Promise<{ ok: true; value: T } | { ok: false; problem: Problem }>, done: (value: T) => Event): Promise<void> {
    send(start);
    setPressed(true);
    const mine = ++epoch;
    const result = await call();
    if (mine !== epoch) return;
    if (result.ok) {
      setEarned(true);
      send(done(result.value));
    } else send({ type: "failed", problem: result.problem });
    // a newer request arrived while this call was out: it is the card now (every request has an id of its own)
    if (latest && latest.id !== state().id) settle(latest);
  }

  const control: ReviewControl = {
    need: held,
    phase: () => state().phase,
    review: () => state().review,
    problem: () => state().problem,
    confirming: () => state().confirming,
    fold: () => state().fold,
    earned,
    pressed,
    merge: () => { if (state().phase === "ready") void act({ type: "merge" }, () => api.merge(input.host(), input.session()), (result) => ({ type: "merged", result })); },
    askDiscard: () => send({ type: "ask-discard" }),
    keep: () => send({ type: "keep" }),
    discard: () => { if (state().phase === "ready" && state().confirming) void act({ type: "discard" }, () => api.discard(input.host(), input.session()), (result) => ({ type: "discarded", result })); },
    retry: () => { if (state().phase === "reading" && state().problem) { send({ type: "retry" }); void read(); } },
  };
  return { control, offer };
}
