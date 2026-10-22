/* an agent's report as a glyph (docs/thread.md, arrivals): the outcome on a disc of its colour, or the agent's letter. a status
   (the daemon's "reached status" alone) has a glyph of its own, never the letter: a pause for parked, a stop for closed or shut
   down, the cross for failed, a bar for the rest. the transcript's chip and its rows draw it at first paint, so it is in the first
   load; the sheet they open (report-sheet.tsx) is a chunk of its own (ui/later.ts) and draws it too. */

import { Show } from "solid-js";
import { type Outcome, type Report } from "./report";

const CROSS = "M4.5 4.5l7 7M11.5 4.5l-7 7";

/** a status's glyph: what the child is doing now, in one shape */
export function statusPath(status: string): string {
  if (status === "parked" || status === "paused") return "M6 4.5v7M10 4.5v7";
  if (status === "closed" || status === "shutdown" || status === "stopped") return "M5 5h6v6H5z";
  if (status === "failed") return CROSS;
  return "M4.5 8h7";
}

/** the outcome's glyph on a disc of its colour, the status's, or the agent's letter in the light tone */
export function ReportGlyph(props: { report: Report; size: "chip" | "sheet" | "tag" | "row" }) {
  const path = (o: Outcome): string | undefined => (props.report.kind === "status" ? statusPath(props.report.status ?? "") : o === "ready" ? "M3.5 8.5l3 3 6-7" : o === "blocked" ? "M8 3.2v6" : o === "failed" ? CROSS : undefined);
  return (
    <span class={`rep-glyph ${props.size}`} data-outcome={props.report.outcome} data-status={props.report.kind === "status" ? props.report.status : undefined} aria-hidden="true">
      <Show when={path(props.report.outcome)} fallback={<b>{props.report.initial}</b>}>
        {(d) => (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d={d()} />
            <Show when={props.report.kind !== "status" && props.report.outcome === "blocked"}><circle cx="8" cy="12.6" r="0.4" fill="currentColor" /></Show>
          </svg>
        )}
      </Show>
    </span>
  );
}
