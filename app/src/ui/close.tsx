/* the one close (docs/design.md, the close): every surface that closes, a sheet, a dialog, a viewer, a panel, closes with this. a
   36 px round of liquid glass, the stage bar's and the composer's rounds' material (styles.css, `.lg`, `.lg-press`), with a
   drawn cross in the full ink: two strokes of 1.75 px with round caps, so it sits at the round's centre whatever the font (a
   typographic "×" sits off centre and thin, and differs by face). the look is styles.css's `.close-round`. */

import type { JSX } from "solid-js";

export function Close(props: { label: string; onClick: (e: MouseEvent) => void; /** the surface's own class, for its placing only */ class?: string }): JSX.Element {
  return (
    <button type="button" class={`close-round lg lg-press${props.class ? ` ${props.class}` : ""}`} aria-label={props.label} onClick={(e) => props.onClick(e)}>
      <svg viewBox="0 0 13 13" aria-hidden="true"><path d="M1.75 1.75l9.5 9.5M11.25 1.75l-9.5 9.5" /></svg>
    </button>
  );
}
