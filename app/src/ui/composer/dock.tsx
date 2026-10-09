/* the dock under home's deck (docs/composer.md, the dock): the one gesture that starts a thread, a window of the colour
   of the repo you are looking at. it is a button, not a text box that only pretends: it takes no words itself, it opens
   the new-thread sheet at the place it names. it follows the window in view (colour, repo, machine) by its props, and
   holds nothing anyone types in, so following never remounts anything. */

import { Show } from "solid-js";
import { colourOf, colourStyle, repoName } from "../window/repo";
import "./composer.css";

export type DockProps = {
  host: string;
  /** the repo's directory, or none when nothing has run on this machine yet */
  directory: string | null;
  /** more than one machine: the dock says which one */
  showHost: boolean;
  onOpen: () => void;
};

export function NewThreadDock(props: DockProps) {
  const colour = () => colourOf({ host: props.host, root: props.directory ?? props.host });
  const where = () => (props.directory ? `in ${repoName(props.directory)}` : `on ${props.host}`);
  const name = () => (props.directory ? `new thread in ${repoName(props.directory)} on ${props.host}` : `new thread on ${props.host}`);
  return (
    <div class="composer" data-mount="dock" style={colourStyle(colour())}>
      <button class="cz-window cz-dock" type="button" aria-label={name()} aria-keyshortcuts="Meta+N" onClick={() => props.onOpen()}>
        <span class="cz-dock-text">
          <b>start something</b>
          <small>
            {where()}
            <Show when={props.showHost && props.directory}>, on {props.host}</Show>
          </small>
        </span>
        <span class="cz-disc" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        </span>
      </button>
    </div>
  );
}
