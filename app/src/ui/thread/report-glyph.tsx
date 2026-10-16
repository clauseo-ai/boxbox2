/* an agent's report as a glyph (docs/thread.md, what started the turn): the outcome on a disc of its colour, or the
   agent's letter. the transcript's chip draws it at first paint, so it is in the first load; the sheet the chip opens
   (report-sheet.tsx) is a chunk of its own (ui/later.ts) and draws it too. */

import { Show } from "solid-js";
import { type Outcome, type Report } from "./report";

/** the outcome's glyph on a disc of its colour, or the agent's letter in the light tone */
export function ReportGlyph(props: { report: Report; size: "chip" | "sheet" | "tag" }) {
  const path = (o: Outcome): string | undefined => (o === "ready" ? "M3.5 8.5l3 3 6-7" : o === "blocked" ? "M8 3.2v6" : o === "failed" ? "M4.5 4.5l7 7M11.5 4.5l-7 7" : undefined);
  return (
    <span class={`rep-glyph ${props.size}`} data-outcome={props.report.outcome} aria-hidden="true">
      <Show when={path(props.report.outcome)} fallback={<b>{props.report.initial}</b>}>
        {(d) => (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d={d()} />
            <Show when={props.report.outcome === "blocked"}><circle cx="8" cy="12.6" r="0.4" fill="currentColor" /></Show>
          </svg>
        )}
      </Show>
    </span>
  );
}
