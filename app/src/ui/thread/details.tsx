/* the thread's details and its turns, drawn once and shown where the layout has
   room (docs/design.md, the thread menu and details): flat on the ground in
   home's inspector, docked as a card in the stage at a wide stage, as a sheet
   on the phone. the stage decides where; this decides what. what they say is
   ./details-model.ts, how they look is ./details.css. */

import { createMemo } from "solid-js";
import type { Thread } from "../../sync/protocol";
import type { AgentRow, FactLine, Spend, filesChanged } from "./details-model";
import type { Turn } from "./model";
import { warmEdgeOn } from "../later";
import "./details.css";

/** the repo's palette, set inline on what sits outside the stage (the inspector) so its accents are the thread's */
export type Palette = { tone: string; top: string; bottom: string };

export type DetailsData = {
  /** every turn of the thread: the steps, the files and the models are read from them */
  turns: readonly Turn[];
  agents: readonly AgentRow[];
  files: ReturnType<typeof filesChanged>;
  /** the daemon's account of the session: its spend, tokens, context and branch */
  info: Thread | undefined;
  /** what the thread and every agent under it have cost (details-model.ts, spendOf) */
  spend: Spend;
  now: number;
  /** a subagent's id: opens its thread */
  openAgent: (id: string, name?: string) => void;
};

export type TurnsData = {
  /** the turns the list shows, in order */
  listed: readonly Turn[];
  /** the turn the log is on */
  here: string | null;
  label: (t: Turn) => string;
  goTo: (t: Turn) => void;
};

/* ---------- the doors in ---------- */

/** the line under the title that says the model, the context and the spend, and opens the details */
export function FactsButton(props: { facts: FactLine; open: () => void }) {
  /* the facts are a new object on every frame of a streaming thread; the name is set when it changes */
  const name = createMemo(() => props.facts.name);
  return (
    <button class="tb-facts" aria-label={name()} onClick={() => props.open()}>
      <span>{props.facts.text}</span>
      <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M1.5 1.5 6 6l-4.5 4.5" /></svg>
    </button>
  );
}

/** the bar's toggle for the details: a sidebar glyph, the mirror of home's fold toggle for the rail, whose rule sits
    on the left (docs/design.md, the thread menu and details) */
export function DetailsToggle(props: { expanded: boolean; controls: string; shortcut: boolean; onClick: () => void }) {
  return (
    <button class="round details-toggle" aria-label="details" aria-expanded={props.expanded ? "true" : "false"} aria-controls={props.controls} aria-keyshortcuts={props.shortcut ? "]" : undefined} onPointerDown={warmEdgeOn} onClick={() => props.onClick()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path class="pane" d="M14.5 4.5H17a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-2.5z" /><rect x="4" y="4.5" width="16" height="15" rx="3" /><path d="M14.5 4.5v15" /></svg>
    </button>
  );
}
