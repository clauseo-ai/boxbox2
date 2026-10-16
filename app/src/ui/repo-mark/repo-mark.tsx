/* a repo's mark: its favicon in a squircle tile, beside the repo's name wherever the name appears (docs/design.md, the
   repo mark). identity only, never state: nothing here pulses, badges or escalates, and the name beside it stays the
   accessible name, so the mark is aria-hidden.

   no favicon, or while it loads, or when it never does: the repo's own colour with its initials. with one: the icon on a
   plate chosen so it cannot vanish (plate.ts), or an app-icon style image full bleed, and an opacity crossfade from the
   colour tile, once; an image the browser already holds is there at the first paint, with no fade. the box is fixed at
   `size` from the first frame, so nothing moves when the icon arrives. */

import { createEffect, createMemo, createSignal, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { holdRepoIcon, state } from "../../store";
import { colourOf, colourStyle, type RepoColour, repoName } from "../window/repo";
import { initialsOf } from "../home/swatch";
import { askAgainIn, iconKey, iconUrl } from "./icons";
import { letterScale, lettersFor } from "./letters";
import { ensureRepoIcon } from "./probe";
import { reportIconRead } from "./report";
import { askWhenDue } from "./schedule";
import { sampleImage } from "./sample";
import "./repo-mark.css";

export type RepoMarkProps = {
  host: string;
  /** the repo's project root, never a worktree's directory: one repo is one mark everywhere */
  root: string;
  /** the tile's side in px; the box never changes with what is loaded */
  size: number;
  /** the repo's name, when the surface already holds it (it is the root's last segment otherwise) */
  name?: string;
  /** the repo's colour, when the surface already holds it (it is derived from host and root otherwise) */
  colour?: RepoColour;
  /** for a surface that is already the repo's own colour and already spells its initials (a folded rail's swatch):
      the tile is not drawn until there is a favicon, so there is no tile in a tile */
  bare?: boolean;
  /** the agent's `mark` (docs/design.md, the round mark): `round` is an assistant's circle, which always spells one
      letter, the name's first, and never draws a favicon; `square` (the default) is a repo's squircle */
  shape?: "square" | "round";
};

/** how the app reads an icon: pixels through a canvas, outcomes to telemetry */
const HOW = { sample: sampleImage, onRead: reportIconRead };

export function RepoMark(props: RepoMarkProps): JSX.Element {
  const colour = createMemo(() => props.colour ?? colourOf({ host: props.host, root: props.root }));
  const round = () => props.shape === "round";
  // an assistant's name is a word: two letters would read as a code, so the circle carries its first letter alone
  const letters = createMemo(() => (round() ? ([...initialsOf(props.name ?? props.root)][0] ?? "") : lettersFor(props.name ?? repoName(props.root), props.size)));
  const url = createMemo(() => iconUrl(props.host, props.root));
  const plate = () => {
    if (round()) return null;
    const icon = state.repoIcons[iconKey(props.host, props.root)];
    return icon?.state === "ready" ? icon.plate : null;
  };

  /* the mark holds its repo's verdict while it is up, asks for the icon, and, while the answer is not an image, owns
     the timer that asks again when it falls due (a retry recovers, an unproven root is believed after a minute) without
     the mark being remounted. the timer is cleared whenever the verdict, the repo or the mark changes */
  createEffect(() => {
    const { host, root } = props;
    // a round mark is identity in boxbox's material alone: no favicon, no gateway avatar, so nothing is asked for
    if (!host || !root || round()) return;
    const key = iconKey(host, root);
    onCleanup(holdRepoIcon(key));
    const icon = state.repoIcons[key];
    untrack(() => void ensureRepoIcon(host, root, HOW));
    const wait = icon === undefined ? null : askAgainIn(icon, Date.now());
    if (wait === null) return;
    onCleanup(askWhenDue(wait, () => void ensureRepoIcon(host, root, HOW), document));
  });

  /* the favicon is shown once the browser has it drawn: from its load event, or at mount for an image it already holds,
     which is then there with no fade (`instant`) */
  const [shown, setShown] = createSignal(false);
  const [instant, setInstant] = createSignal(false);
  let img: HTMLImageElement | undefined;
  createEffect(
    on(
      url,
      () => {
        setShown(false);
        setInstant(false);
      },
      { defer: true },
    ),
  );
  onMount(() => {
    // complete is also true for an image that failed: only one with a size was drawn
    if (img?.complete && img.naturalWidth > 0) {
      setInstant(true);
      setShown(true);
    }
  });

  return (
    <span
      class="rm plane-window"
      aria-hidden="true"
      data-bare={props.bare ? "" : undefined}
      data-shape={round() ? "round" : undefined}
      data-plate={plate() ?? undefined}
      data-shown={shown() ? "" : undefined}
      data-instant={instant() ? "" : undefined}
      style={{ ...colourStyle(colour()), "--mark": `${props.size}px`, "--letters": String(letterScale(letters().length)) }}
    >
      <span class="rm-ring" />
      <span class="rm-face">
        <b class="rm-letters">{letters()}</b>
        <Show when={plate()}>
          <span class="rm-icon">
            <img ref={img} src={url()} alt="" draggable={false} decoding="async" onLoad={() => setShown(true)} />
          </span>
        </Show>
      </span>
    </span>
  );
}
