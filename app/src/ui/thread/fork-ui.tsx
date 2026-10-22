/* a fork's lineage line and its divider (docs/thread.md, fork): drawn only in a thread that was forked, so they load with
   the first one, never in the first load (architecture.md, the script budget). the stage owns what they show (the
   lineage, the boundary, the opening and its note) and the press; these only draw it. until the chunk is in they draw
   nothing, and the stage warms it as soon as it opens a fork, so a thread lands with them */

import { Show } from "solid-js";
import type { Lineage } from "./fork";
import { boundaryWords, forkHeld, lineageWords } from "./fork-words";

/** the thread menu's fork: the whole thread, held while a turn runs (its end is not written yet) or the stream is down. what
    a failed fork said shows under it */
export function ForkMenuItem(props: { streamDown: boolean; working: boolean; busy: boolean; forking: boolean; note: string | null; fork: () => void }) {
  const held = () => forkHeld({ streamDown: props.streamDown, browseOnly: false, working: props.working });
  return (
    <>
      <button role="menuitem" disabled={held() !== null} aria-disabled={props.busy ? "true" : undefined} onClick={() => props.fork()}>{props.forking ? "forking" : "fork"}<em>{held() ?? "a new thread with this history"}</em></button>
      <Show when={props.note}>{(why) => <p class="menu-note" role="alert">{why()}</p>}</Show>
    </>
  );
}

/** the line beside the repo: "forked from <title>", the door back to the turn it was forked from */
export function LineageLine(props: { from: Lineage; opening: boolean; open: () => void }) {
  return <button type="button" class="tb-parent tb-fork" aria-label={lineageWords(props.from)} aria-disabled={props.opening ? "true" : undefined} onClick={() => props.open()}>{lineageWords(props.from)}</button>;
}

/** the divider after the last copied turn; the link and its full stop never part (`.fork-mark-at`) */
export function ForkMark(props: { from: Lineage; ownTurns: boolean; opening: boolean; note: string | null; open: () => void }) {
  const words = () => boundaryWords(props.from, props.ownTurns);
  return (
    <div class="fork-mark">
      <p>{words().before}<span class="fork-mark-at"><button type="button" aria-label={words().name} aria-disabled={props.opening ? "true" : undefined} onClick={() => props.open()}>{words().link}</button>{words().stop}</span>{words().after}</p>
      <Show when={props.note}>{(why) => <p class="fork-mark-note" role="alert">{why()}</p>}</Show>
    </div>
  );
}
