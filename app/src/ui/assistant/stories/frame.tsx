/* the solid side of the assistant surfaces' stories: an assistant's stage (its palette's flood, the thread's tokens)
   around whatever one story draws, and the ready mark the screenshot test waits for. the palette is the agent's slot,
   coral unless a story names another (docs/design.md, agents: who a window belongs to). */

import { type JSX, onMount } from "solid-js";
import { render } from "solid-js/web";
import { installMotionProperties } from "../../../motion/animate";
import { assistantColour } from "../../window/repo";
import "./stories.css";

export type FrameProps = {
  /** the palette slot; coral by default */
  palette?: string;
  /** "stage" (the default) is the thread's flood with a centred column; "ground" is the page, for home and the agents screen */
  ground?: "stage" | "ground";
  /** ms after the first paint before the story says it is ready (a story that plays something waits for it) */
  readyAfter?: number;
  /** runs once painted, with the frame's element: a story drives itself the way a person would */
  drive?: (el: HTMLElement) => void;
  children: JSX.Element;
};

export function Frame(props: FrameProps) {
  let el!: HTMLDivElement;
  const colour = assistantColour(props.palette ?? "coral");
  onMount(() => {
    props.drive?.(el);
    setTimeout(() => el.setAttribute("data-ready", ""), props.readyAfter ?? 300);
  });
  return (
    <div
      ref={el}
      class={props.ground === "ground" ? "as-story as-ground" : "as-story as-stage"}
      style={{ "--tone": colour.light, "--window-top": colour.top, "--window-bottom": colour.bottom, "--c1": colour.top, "--c2": colour.bottom, "--hi": colour.light }}
    >
      {props.children}
    </div>
  );
}

/** mounts one story's solid tree into the react host's element; returns its disposer */
export function mount(el: HTMLElement, node: () => JSX.Element): () => void {
  installMotionProperties();
  return render(node, el);
}
