/* the away line (docs/home.md, cleared while you were away): under the bar's line when the server auto-cleared threads
   while no device was looking, "6 cleared while you were away", with "show" (the away sheet, lists.tsx, a chunk of its
   own) and a dismiss. either one acknowledges the list for every device (POST /api/away/seen, home.tsx); the threads stay
   cleared and in history. */

import { warmOn } from "../later";
import { awayWords } from "./away-words";

export function AwayLine(props: { count: number; open: boolean; onShow: (from: HTMLElement) => void; onDismiss: () => void }) {
  return (
    <p class="away-line">
      <span class="away-tick" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M6 12.5l4 4 8-9" />
        </svg>
      </span>
      <span class="away-words">{awayWords(props.count)}</span>
      <button
        class="away-show"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={props.open}
        aria-label={`show the ${props.count === 1 ? "thread" : `${props.count} threads`} cleared while you were away`}
        onPointerDown={warmOn("AwaySheet")}
        onClick={(event) => props.onShow(event.currentTarget)}
      >
        show
      </button>
      <button class="away-dismiss" type="button" aria-label="dismiss the cleared while you were away line" onClick={() => props.onDismiss()}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      </button>
    </p>
  );
}
