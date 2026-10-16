/* an agent's report, opened (docs/thread.md, what started the turn; the
   native client's decision 26): the transcript's chip raises the whole report
   in a sheet of glass from the foot of the screen, at half its height and
   whole at a press on its grabber (or a drag up), with the agent, when it
   reported, copy and close on top and the report's markdown at the answer's
   size under them. a modal dialog in the top layer, so the stage's masked
   scroller does not turn its glass off; escape, close, a press outside it and
   a drag down close it, and focus goes back to the chip. */

import { type JSX, Show, createSignal, onCleanup, onMount } from "solid-js";
import { CopyButton } from "./copy-button";
import { reportLabel } from "./copy-names";
import { type Outcome, type Report } from "./report";
import { clock } from "./rows";

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

/** how far up the sheet stands: half the screen, or nearly all of it */
type Detent = "medium" | "large";

export function ReportSheet(props: { report: Report; onClose: () => void; /** the agent's name goes to the row that started it */ onAgent?: (() => void) | undefined; /** the report's markdown, painted by the thread */ children?: JSX.Element }) {
  let dialog!: HTMLDialogElement;
  const [detent, setDetent] = createSignal<Detent>("medium");
  /* a drag on the grabber: up past 40 px takes the sheet whole, down past 60 px half it, or closes it from half */
  let drag: { y: number; id: number } | null = null;
  const [pull, setPull] = createSignal(0);
  const down = (e: PointerEvent) => { drag = { y: e.clientY, id: e.pointerId }; try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ } };
  const move = (e: PointerEvent) => { if (drag && e.pointerId === drag.id) setPull(Math.max(-80, Math.min(240, e.clientY - drag.y))); };
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    drag = null;
    setPull(0);
    if (Math.abs(dy) < 6) { setDetent(detent() === "medium" ? "large" : "medium"); return; }
    if (dy < -40) setDetent("large");
    else if (dy > 60) { if (detent() === "large") setDetent("medium"); else dialog.close(); }
  };
  const cancel = () => { drag = null; setPull(0); };
  /* the sheet itself takes focus, not its grabber: a ring on the grabber reads as a selection nobody made */
  onMount(() => { dialog.showModal(); dialog.focus(); });
  onCleanup(() => { if (dialog.open) dialog.close(); });
  const kind = () => (props.report.note ? "note" : "report");
  return (
    <dialog ref={dialog} class="rep-sheet" tabIndex={-1} data-detent={detent()} aria-label={`${kind()} from ${props.report.name}`} style={pull() ? { transform: `translateY(${pull()}px)` } : undefined}
      on:keydown={(e) => e.key === "Escape" && e.stopPropagation()} on:close={() => props.onClose()} onClick={(e) => e.target === dialog && dialog.close()}>
      <button class="rep-grab" aria-label={detent() === "medium" ? `show the whole ${kind()}` : `show half of the ${kind()}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}><i /></button>
      <header class="rep-sheet-h">
        <ReportGlyph report={props.report} size="sheet" />
        <div class="rep-sheet-who">
          <Show when={props.onAgent} fallback={<b>{props.report.name}</b>}>
            {(go) => <button class="rep-sheet-name" aria-label={`the agent ${props.report.name}, where it started`} onClick={() => { dialog.close(); go()(); }}><b>{props.report.name}</b></button>}
          </Show>
          <span>{props.report.verb} at {clock(props.report.at)}</span>
        </div>
        <CopyButton kind="report" name={reportLabel(props.report.name, props.report.note)} text={() => props.report.text} />
        <button class="rep-sheet-x" aria-label="close" onClick={() => dialog.close()}><i /></button>
      </header>
      <div class="rep-sheet-body">
        <Show when={props.report.outcome !== "none"}><span class="rep-tag" data-outcome={props.report.outcome}><ReportGlyph report={props.report} size="tag" />{props.report.outcome}</span></Show>
        {props.children}
      </div>
    </dialog>
  );
}
