/* a provider's mark: the glyph in a quiet glass tile, or for a provider with no
   mark the first letter of its name. decorative only (aria-hidden): the name is
   always in the words beside it. the glyph is drawn from the sprite in index.html
   (marks-data.ts says why the paths are not in the script), so it is there in the
   first frame. */

import { createMemo, type JSX } from "solid-js";
import { markNameOf } from "./marks";
import "./mark.css";

function Glyph(props: { name: string; class?: string | undefined }): JSX.Element {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <use href={`#cz-mark-${props.name}`} />
    </svg>
  );
}

/** the first letter of the provider's name, lowercase; "?" when it has none */
const letterOf = (provider: string): string => provider.match(/[a-z0-9]/i)?.[0]?.toLowerCase() ?? "?";

export function ProviderMark(props: { provider: string; size?: number }): JSX.Element {
  const found = () => markNameOf(props.provider) ?? undefined;
  return (
    <span class="cz-mark" data-brand={found()} data-fallback={found() ? undefined : ""} aria-hidden="true" style={{ "--mark": `${props.size ?? 22}px` }}>
      {(() => {
        const name = found();
        return name ? <Glyph name={name} /> : <b>{letterOf(props.provider)}</b>;
      })()}
    </span>
  );
}

/** the bare glyph, no tile; null when the provider has no mark */
export function MarkGlyph(props: { provider: string; class?: string }): JSX.Element {
  /* a memo, so the glyph is made again when the mark changes: the composer's provider is worked out again on every keystroke */
  const hit = createMemo(() => markNameOf(props.provider));
  return <>{(() => {
    const name = hit();
    return name ? <Glyph name={name} class={props.class} /> : null;
  })()}</>;
}
