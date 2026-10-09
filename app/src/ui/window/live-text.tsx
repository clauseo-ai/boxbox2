/* streamed prose that settles in (docs/design.md, motion law): what was
   already painted stays one plain text node; words that arrive while the
   window is live join as one span that settles from a 5 px blur, then fold
   into the plain text once they have settled. prose shows its last two
   sentences, so a new sentence can push the oldest out at the front while
   words arrive at the end: what stays keeps its place and only the new
   words settle. anything else (a replay, a rewrite, an offscreen window,
   reduced motion) paints in place. */

import { createSignal, For, on, createEffect, onCleanup } from "solid-js";
import { settle } from "../../motion/animate";
import { SETTLE } from "../../motion/springs";
import { growth } from "./tail";

type Arrival = { id: number; text: string };

export function LiveText(props: { text: string; live: boolean }) {
  const [base, setBase] = createSignal(props.text);
  const [arrivals, setArrivals] = createSignal<Arrival[]>([]);
  let serial = 0;
  let fold: ReturnType<typeof setTimeout> | undefined;

  const shown = () => base() + arrivals().map((a) => a.text).join("");

  createEffect(
    on(
      () => props.text,
      (text) => {
        const grew = props.live ? growth(shown(), text) : null;
        if (grew) {
          if (grew.dropped > 0) {
            // the oldest sentence left: what stays is settled text now, and the fold below is the only one pending
            setBase(shown().slice(grew.dropped));
            setArrivals([{ id: ++serial, text: grew.added }]);
          } else {
            setArrivals((list) => [...list, { id: ++serial, text: grew.added }]);
          }
          // one fold per burst: every arrival has settled by the time the last one has
          clearTimeout(fold);
          fold = setTimeout(() => {
            setBase(shown());
            setArrivals([]);
          }, SETTLE.duration + 40);
          return;
        }
        clearTimeout(fold);
        setBase(text);
        setArrivals([]);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(fold));

  return (
    <>
      {base()}
      <For each={arrivals()}>{(arrival) => <span class="arriving" ref={(el) => settle(el, true)}>{arrival.text}</span>}</For>
    </>
  );
}
