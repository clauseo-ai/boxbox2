/* the review, as the stage mounts it: the controller and the card together, so that one lazy import (stage.tsx) carries all of
   it. the stage says when there is a review need and hears whether the layer still holds something to show (a call out,
   a folded line) after the need has been served. */

import { type Accessor, createEffect } from "solid-js";
import type { api } from "../../api/client";
import { reviewApiOver } from "./api";
import { createReviewControl } from "./control";
import type { ReviewNeed } from "./open";
import { ReviewCard, type ReviewMotion } from "./review-card";

export function ReviewLayer(props: { client: typeof api; motion: ReviewMotion; host: Accessor<string>; session: Accessor<string>; need: Accessor<ReviewNeed | undefined>; holding: (holds: boolean) => void }) {
  const { control, offer } = createReviewControl({ host: props.host, session: props.session, api: reviewApiOver(props.client) });
  createEffect(() => offer(props.need()));
  createEffect(() => props.holding(control.need() !== null));
  return <ReviewCard control={control} motion={props.motion} />;
}
