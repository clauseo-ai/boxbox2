/* the board's stories (docs/design.md, the board; docs/board.md, the app): a board's digits on home's windows and
   swatches in every state, each at the phone, ipad and mac widths .ladle/shots.ts shoots (`--prefix board--`, in both
   appearances with `--theme`). written with createElement: this file is react (ladle's host) and the project's jsx is
   solid's. */

import { createElement, type ReactElement, useEffect, useRef } from "react";
import { type BoardStory, mountBoard } from "./mount";
import "../../ui/home/stories/stories.css";

function Host(props: { story: BoardStory }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    return el ? mountBoard(el, props.story) : undefined;
  }, [props.story]);
  return createElement("div", { ref, className: "story" });
}

const story = (name: BoardStory) => () => createElement(Host, { story: name });

export const Arriving = story("arriving");
export const Changing = story("changing");
export const Leaving = story("leaving");
export const Seated = story("seated");
export const StripFolded = story("strip-folded");
export const RailFolded = story("rail-folded");
export const ReducedMotion = story("reduced");

export default { title: "board" };
