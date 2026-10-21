/* the stage: where a window grows into its thread (docs/design.md, the
   stage). home owns the motion (grow, shrink, pour, the back gesture);
   this is the layer that moves: the repo's colour flooding the ground and,
   inside it, the thread's own stage (app/src/ui/thread/stage.tsx: the
   bar that condenses, the ledger, the asks in place, the ruler and the
   turns). the thread's bar is the header home's back gesture pulls on. */

import { type JSX, Show } from "solid-js";
import type { DetailsRoom, InspectorLink } from "../thread/inspector";
import { Stage } from "../thread/stage";
import { colourStyle } from "../window/repo";
import type { WindowView } from "../window/view";

export type LayerProps = {
  view: WindowView;
  /** the deck's full-screen stage has a back control and an edge to swipe from */
  deck: boolean;
  onBack: (event: Event) => void;
  ref?: (el: HTMLElement) => void;
  /** the header and the edge, for the back gesture */
  gestureRefs?: (edge: HTMLElement | undefined, header: HTMLElement) => void;
  /** an agent's thread opens as a layer over this one, named by the row that opened it when it gives a name */
  onOpenAgent: (key: string, name?: string) => void;
  /** the thread this layer sits over (an agent's parent): its back returns there even when the fleet does not hold the
      agent's thread, whose `parent` would say it */
  parent?: string;
  /** another layer sits over this one (an agent's thread): it keeps its place but takes no input and is out of the tree */
  covered?: boolean;
  /** the inspector column beside the stage (the rail, 1400 wide and up): only the layer on top is given it, and only there */
  inspector?: InspectorLink;
  /** below the inspector's width, where the stage's own panel goes: only the layer on top is given it */
  room?: DetailsRoom;
  /** what leads the stage's bar: the windows' toggle while they are put away, the only way back to them on screen */
  barStart?: JSX.Element;
};

export function Layer(props: LayerProps) {
  let edge: HTMLDivElement | undefined;
  return (
    <section class="layer" ref={props.ref} data-key={props.view.key} aria-label={`thread: ${props.view.title}`} style={colourStyle(props.view.colour)} inert={props.covered}>
      <Show when={props.deck}>
        <div class="edge" ref={edge} aria-hidden="true" />
      </Show>
      <Stage
        threadKey={props.view.key}
        colour={props.view.colour}
        deck={props.deck}
        onBack={props.onBack}
        onOpenAgent={props.onOpenAgent}
        {...(props.parent ? { parent: props.parent } : {})}
        {...(props.parent ? { fallback: { title: props.view.title, root: props.view.root } } : {})}
        headerRef={(header) => queueMicrotask(() => props.gestureRefs?.(edge, header))}
        {...(props.inspector ? { inspector: props.inspector } : {})}
        {...(props.room ? { room: props.room } : {})}
        {...(props.barStart ? { barStart: props.barStart } : {})}
      />
      <Show when={props.deck}>
        <div class="veil plane-window" aria-hidden="true" />
      </Show>
    </section>
  );
}
