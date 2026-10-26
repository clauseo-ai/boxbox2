/* the needs side of a window: what a session's open needs make it show.
   pure, so it is tested without a browser. */

import type { Thread } from "../../sync/protocol";
import { openReview } from "../review/open";
import type { Extra } from "../window/view";

type Need = Thread["needs"][number];

/** whether a need counts toward what a window shows (its done or unseen state, the bar's counts). a background job's
    notice counts only when the person chose job notices as needs (settings, home: `jobsAsNeeds`, off by default): off,
    it is a row in its thread and nothing more (design.md, the order is the inbox) */
export function counts(need: Pick<Need, "kind">, jobsAsNeeds: boolean): boolean {
  return need.kind !== "job" || jobsAsNeeds;
}

/** what a window shows of its session's needs: an open fault's reason, an open review's note (the agent's, else its
    branch), and whether its last turn was seen (no done or news waiting). `jobsAsNeeds` is the person's choice (see
    `counts`) */
export function extraOf(entry: Thread, jobsAsNeeds: boolean): Extra {
  const fault = entry.needs.find((need) => need.kind === "fault");
  const unseen = entry.needs.some((need) => (need.kind === "done" || need.kind === "job" || need.kind === "review") && counts(need, jobsAsNeeds));
  const review = openReview(entry);
  return { ...(fault ? { failure: fault.body } : {}), ...(review ? { review: review.body } : {}), seen: !unseen };
}
