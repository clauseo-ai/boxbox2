/* the btw stories (docs/thread.md, btw; docs/composer.md, btw has the composer's in composer.stories.tsx): the card in
   every state, its dismissed line and that line opened again, a btw added to the thread with the marker on its message,
   and an answer streaming in. written with createElement: this file is react (ladle's host) and the project's jsx is
   solid's. */

import { createElement, type ReactElement, useEffect, useRef } from "react";
import { type BtwStory, mountBtw } from "./mount";
import "../../thread/stories/stories.css";

export default { title: "btw" };

function Host(props: { story: BtwStory }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(".mount");
    return el ? mountBtw(el, props.story) : undefined;
  }, [props.story]);
  return createElement("div", { ref, className: "stage-sample", "data-story": `btw ${props.story}` }, createElement("div", { className: "mount" }));
}

const story = (name: BtwStory) => () => createElement(Host, { story: name });

export const Running = story("running");
export const RunningBeforeTheFirstWord = story("running-empty");
export const Streaming = story("streaming");
export const Done = story("done");
export const Failed = story("error");
export const Dismissed = story("dismissed");
export const DismissedOpenedAgain = story("expanded");
export const AddedToThread = story("added");
export const MarkerOnTheMessage = story("marker");
export const SeveralInOneTurn = story("several");
export const AtTheEndOfARunningTurn = story("live-turn");
