/* going to a row from a press elsewhere on the page (docs/thread.md, arrivals; links): an agent row's "reported" to the report's
   row, a report sheet's name to the row that started the agent, a link's part. a row folded into a closed group is reached by
   opening the group first. split from the first load (architecture.md, the script budget): it runs only after a press, and its
   callers import it then */

import type { StageWindow } from "./stage-window";
import { flipRoot, light } from "./thread";

/** goes to the row that shows a part, lit: a closed group answers for the parts folded into it (thread.tsx, GroupView), so it is
    opened first and the row inside it is the one lit. false when no row on the page shows the part */
export function goToPart(root: Element, part: string, scroller?: HTMLElement): boolean {
  const at = `[data-part~="${CSS.escape(part)}"]`;
  const found = root.querySelector<HTMLElement>(`.row${at}`);
  if (!found) return false;
  if (!found.classList.contains("group")) { light(found, scroller); return true; }
  found.querySelector<HTMLButtonElement>(":scope > button.row-h")?.click();
  /* the group's rows are painted by the next frame: the click's update has run by then */
  requestAnimationFrame(() => { const row = root.querySelector<HTMLElement>(`.row:not(.group)${at}`); light(row ?? found, scroller); });
  return true;
}

/** the report sheet's name press (report-sheet.tsx): goes to the row that started the agent, the last one of its name at or before
    the turn the report came into (stage-window.ts, agentRow), its group opened for it when it is folded into one */
export function goToAgent(from: HTMLElement, name: string, turn: string, win: StageWindow | undefined): void {
  /* the turn that started the agent is filled before the move, so its row is there to land on */
  const started = win?.agentRow(name, turn);
  if (started) win?.reveal(started.turn);
  const root = flipRoot(from);
  const scroller = root.closest<HTMLElement>(".stage-scroll") ?? undefined;
  if (started && goToPart(root, started.part, scroller)) return;
  const rows = [...root.querySelectorAll<HTMLElement>(`.row[data-agent="${CSS.escape(name)}"]`)];
  const before = rows.filter((r) => r.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? rows[0];
  if (before) light(before, scroller);
}

/** an agent row's "reported" (rows.ts, the link): the report's turn is filled before the move, so there is a row to land on
    (stage-window.ts, reveal); the row is in a group as a rule, which opens for it. a report that started a turn of its own is that
    turn's chip */
export function goToReport(from: HTMLElement, link: { report: string; turn: string; part: string }, win: StageWindow | undefined): void {
  win?.reveal(link.turn);
  const root = flipRoot(from);
  const scroller = root.closest<HTMLElement>(".stage-scroll") ?? undefined;
  if (goToPart(root, link.part, scroller)) return;
  const cards = [...root.querySelectorAll<HTMLElement>(`.report[data-report="${CSS.escape(link.report)}"]`)];
  const after = root.querySelector<HTMLElement>(`.report[data-turn="${CSS.escape(link.turn)}"]`) ?? cards.find((c) => c.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_PRECEDING) ?? cards[cards.length - 1];
  if (after) light(after, scroller);
}
