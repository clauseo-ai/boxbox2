/* the solid side of a story: the thread's ground around one or more rows,
   with the flip root the rows look for. an agent row's door is shown
   (the stage would open the agent's thread; a story only says so). a running turn's story is pinned to the end of its
   sample while it grows, as the stage follows the end, so the newest row is the one in view. */

import { type JSX, onCleanup, onMount } from "solid-js";
import { OpenAgentContext } from "../thread";
import "../../home/home.css";

export function Host(props: { wide: boolean; ledger?: boolean; /** pinned to the end of the sample while it grows */ end?: boolean; children: JSX.Element }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const sample = el.closest<HTMLElement>(".stage-sample");
    if (!props.end || !sample) return;
    const pin = new ResizeObserver(() => { sample.scrollTop = sample.scrollHeight; });
    pin.observe(el);
    onCleanup(() => pin.disconnect());
  });
  return (
    <OpenAgentContext.Provider value={(child, name) => console.info(`the story would open ${name}'s thread (${child})`)}>
      <div ref={el} class={`thread ${props.wide ? "wide" : ""}`} data-flip-root>
        {props.ledger === false ? props.children : <div class="ledger">{props.children}</div>}
      </div>
    </OpenAgentContext.Provider>
  );
}

/** a desktop home around the rows (the rail), for a story of what home's stylesheet does to them: `.home`'s own placing (fixed,
    a grid) is set aside, so only what its rules say of what is inside it applies */
export function HomeFrame(props: { children: JSX.Element }) {
  return <div class="home" data-arrangement="rail" style={{ position: "static", display: "block", overflow: "visible" }}>{props.children}</div>;
}

/** a turn's own column (the rows' 16 px gap and no more), for a story that shows what a turn puts beside the answer */
export function TurnFrame(props: { children: JSX.Element }) {
  return <section class="turn">{props.children}</section>;
}
