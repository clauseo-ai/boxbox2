/* the needs side of a window: what a session's open needs make it show.
   pure, so it is tested without a browser. */

import type { SessionEntry } from "../../sync/protocol";
import { openReview } from "../review/open";
import type { Extra } from "../window/view";

/** what a window shows of its session's needs: an open fault's reason, an open review's note (the agent's, else its
    branch), and whether its last turn was seen (no done or news waiting) */
export function extraOf(entry: SessionEntry): Extra {
  const fault = entry.needs.find((need) => need.kind === "fault");
  const unseen = entry.needs.some((need) => need.kind === "done" || need.kind === "job" || need.kind === "review");
  const review = openReview(entry);
  return { ...(fault ? { failure: fault.body } : {}), ...(review ? { review: review.body } : {}), seen: !unseen };
}
