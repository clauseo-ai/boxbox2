/* the solid side of the review stories: the real card and the real control over
   a made-up server. each scenario says what the checkout looks like and how the
   server answers, then plays what a person would do (press merge, ask to
   discard, open the patch) so the card is shown in the state that follows. the
   react file beside this one mounts it. */

import { lazy, onMount } from "solid-js";
import { render } from "solid-js/web";
import { play } from "../../../motion/animate";
import { FADE, TICK_DRAW } from "../../../motion/springs";
import { TONES } from "../../thread/stories/fixtures";
import "../../thread/thread.css";
import "../../thread/stories/stories.css";
import type { Result, ReviewApi } from "../api";
import { createReviewControl } from "../control";
import type { ReviewLayer } from "../layer";
import type { Discarded, Merged, Problem, Review } from "../model";
import type { ReviewNeed } from "../open";
import { ReviewCard } from "../review-card";
import { ReviewSlot } from "../slot";

/** a chunk that fails to load, as a page asking for a hash the server no longer serves does */
const StaleLayer = lazy<typeof ReviewLayer>(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));

export type Step = "merge" | "ask" | "discard" | "patch";

export type Scenario = {
  /** what the checkout looks like; a problem is a read the server refused, null a read still out */
  review: Review | { problem: Problem } | null;
  /** how the server answers a merge and a discard; absent, the call never returns (it is in flight) */
  merge?: Result<Merged>;
  discard?: Result<Discarded>;
  /** what the person does once the card is up */
  play?: Step[];
  /** the agent's note on the need; absent, the need carries the branch */
  note?: string;
  wide?: boolean;
  /** the review's chunk is one the server no longer has (a page from before a deploy): the stage's slot says so */
  stale?: boolean;
};

const need = (note: string): ReviewNeed => ({ id: "review:desk:ses_1:site-fix", key: "desk:ses_1", kind: "review", rank: 3, raisedAt: 1, title: "pricing is ready to merge", body: note, checkout: "site-fix" });

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function Sample(props: { scenario: Scenario }) {
  const s = props.scenario;
  let ground!: HTMLDivElement;
  const api: ReviewApi = {
    read: () => (s.review === null ? new Promise(() => undefined) : Promise.resolve("problem" in s.review ? { ok: false, problem: s.review.problem } : { ok: true, value: s.review })),
    merge: () => (s.merge ? Promise.resolve(s.merge) : new Promise(() => undefined)),
    discard: () => (s.discard ? Promise.resolve(s.discard) : new Promise(() => undefined)),
  };
  const { control, offer } = createReviewControl({ host: () => "desk", session: () => "ses_1", api });
  const note = s.note ?? (s.review && "branch" in s.review ? (s.review.branch ?? "site-fix") : "agent/site-fix");
  offer(need(note));
  onMount(() => {
    void (async () => {
      if (s.stale) {
        for (let i = 0; i < 40 && !ground.querySelector(".review-missing"); i++) await wait(25);
        // a story that did not say what failed is never ready
        if (ground.querySelector(".review-missing button")) ground.dataset["ready"] = "1";
        return;
      }
      for (let i = 0; i < 40 && control.phase() === "reading" && !control.problem(); i++) await wait(25);
      for (const step of s.play ?? []) {
        if (step === "merge") control.merge();
        else if (step === "ask") control.askDiscard();
        else if (step === "discard") control.discard();
        else (ground.querySelector<HTMLButtonElement>(".review-quiet"))?.click();
        await wait(60);
      }
      await wait(600);
      ground.dataset["ready"] = "1";
    })();
  });
  return (
    <div ref={ground} class={`stage-sample ${s.wide ? "wide" : ""}`} style={{ "--tone": TONES.green.tone, "--window-top": TONES.green.top, "--window-bottom": TONES.green.bottom }}>
      <div class="mount">
        <div class="thread" data-flip-root>
          {s.stale ? (
            <ReviewSlot Layer={StaleLayer} box={() => undefined} layer={{ client: undefined as never, motion: { play, fade: FADE, tick: TICK_DRAW }, host: () => "desk", session: () => "ses_1", need: () => need(note), holding: () => undefined }} />
          ) : (
            <ReviewCard control={control} motion={{ play, fade: FADE, tick: TICK_DRAW }} />
          )}
        </div>
      </div>
    </div>
  );
}

/** mounts a scenario into `el`; the returned function takes it down */
export function mountReview(el: HTMLElement, scenario: Scenario): () => void {
  return render(() => <Sample scenario={scenario} />, el);
}
