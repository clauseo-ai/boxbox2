/* where the review sits in the stage: one box at the live edge that the stage watches (for the line above the composer
   when the card is out of view), holding the review's chunk. the chunk is loaded when a review waits (stage.tsx), and
   after a deploy the page may ask for a chunk the server no longer has: the card then says so in words and offers to
   reload, rather than showing nothing or taking the stage down. this file and its styles are in the first load, so
   they hold nothing of the card. */

import { type Component, type ComponentProps, ErrorBoundary } from "solid-js";
import { emit } from "../../sync/client";
import type { ReviewLayer } from "./layer";
import "./slot.css";

export type LayerProps = ComponentProps<typeof ReviewLayer>;

/** the review's chunk as the stage lazy-loads it (`lazy(() => import("../review/layer"))`, written where the import is) */
export type LayerComponent = Component<LayerProps>;

export function ReviewSlot(props: { Layer: LayerComponent; layer: LayerProps; /** the box, for the stage's watch */ box: (el: HTMLElement) => void }) {
  return (
    <div class="review-slot" ref={props.box}>
      <ErrorBoundary
        fallback={() => {
          // the words are fixed: nothing of what failed (a url, a person's note) goes into a telemetry label
          emit("error.client", { message: "the review did not load", verb: "loadReview" }, { surface: "thread" });
          return <Unavailable />;
        }}
      >
        <props.Layer {...props.layer} />
      </ErrorBoundary>
    </div>
  );
}

/** the card that could not load: what happened, and the one thing to do */
function Unavailable() {
  return (
    <section class="review-missing" role="alert" aria-label="review">
      <p>the review did not load. this page may be from before an update: reload it, and the review will show.</p>
      <button type="button" onClick={() => location.reload()}>
        reload
      </button>
    </section>
  );
}
