/* a far turn's stand-in (docs/thread.md, the window: far turns), a chunk of its own, fetched when the first turn is let go: the stand-in
   itself, and the focus that goes into one */

import { For, Show, createMemo, untrack, useContext } from "solid-js";
import { boundedPlain } from "./big-text";
import { type FarTurn, longPrompt } from "./far";
import { segmentsOf, groupLine } from "./groups";
import { languageOf } from "./languages";
import { ledgerOf } from "./ledger";
import { settledHtml } from "./markdown";
import { type HtmlMemo, cacheKey } from "./memo-cache";
import type { Turn } from "./model";
import { reportOf } from "./report";
import { shownPrompt } from "../btw/words";
import { type RowCtx, type RowModel, firstSentence } from "./rows";
import { CLAMPED_CHARS, CachesContext, ThreadKeyContext, useOrdinal } from "./thread";

/** a text as the sanitised html it settled to (markdown.ts, from the store's cache when it has it), its fences left plain with the language
    word over each, as a code block's header says it, and no controls: no highlight, no copy, nothing to scroll by */
function text(md: string, cache: HtmlMemo | undefined): HTMLDivElement {
  const surface = <div data-far-md /> as HTMLDivElement;
  surface.innerHTML = settledHtml(md, cache);
  for (const code of surface.querySelectorAll("pre > code:only-child")) {
    const label = languageOf(/(?:^|\s)language-(\S+)/.exec(code.className)?.[1]).label;
    if (label) code.parentElement?.before(Object.assign(document.createElement("span"), { textContent: label }));
  }
  return surface;
}

/** a row that is no control, as its words: its kind, its head and what it came to (its clock goes, as every timestamp of a far turn) */
const rowWords = (m: RowModel): string => [m.kind, m.header, ...m.content.map((p) => (p.t === "cmd" ? p.tokens.map((k) => k.text).join("") : p.s)), m.opened, m.result.text].filter((w) => w).join(" ");

/** a far turn, as text only: the prompt, the files sent with it, what was said and the answer as the html they settled to, each folded
    group as its line. no controls, no step rows, no pictures, no diffs, no clocks; the copy controls it had are hidden marks, so their
    namesakes below keep their names (copy-run.ts). it is drawn in the turn's box at the height the turn measured, far from the view, and
    the turn fills again before it comes near */
export function StandIn(props: { turn: Turn; ctx: RowCtx; far: FarTurn; refill: () => void }) {
  const thread = useContext(ThreadKeyContext);
  const caches = useContext(CachesContext);
  const html = caches?.htmlFor();
  const ordinal = useOrdinal(() => props.turn.id);
  const t = () => props.turn;
  /* the ledger its view left in the store's cache as it went (thread.tsx, Ledger), which the view takes back when the turn fills; else one of its own */
  const at = thread && caches ? cacheKey(untrack(thread), untrack(t).id) : undefined;
  const own = (at === undefined ? undefined : caches?.ledgers.get(at)) ?? ledgerOf();
  const ledgered = () => t().by !== "compaction" || t().summary !== undefined;
  const segments = createMemo(() => (ledgered() ? segmentsOf(own(t(), props.ctx, false), { running: false, ctx: props.ctx, answer: t().answer }) : []));
  /* focus that goes into it (a link in its text) fills the turn and goes on to the same link in its rows; a pointer that comes over its
     words fills it */
  return (
    <div style={{ display: "contents" }} onFocusIn={(e) => focusBack(e.currentTarget.parentElement, e.target, props.refill)} onPointerOver={() => props.refill()}>
      <Show when={t().by === "you" || t().by === "brief"}>
        <Show when={t().sentFiles?.length ? t().sentFiles : undefined}>
          {(files) => <ul aria-label={`files sent${ordinal()}`}><For each={files()}>{(file) => <li aria-label={file.filename} />}</For></ul>}
        </Show>
        <Show when={shownPrompt(t())}>{(said) => <p>{longPrompt(said()) ? said().slice(0, CLAMPED_CHARS) : boundedPlain(said()).shown}</p>}</Show>
      </Show>
      <Show when={t().by === "mail"}><p>{(() => { const r = reportOf(t()); return r.gist ? `${r.name} · ${r.gist}` : r.name; })()}</p></Show>
      <Show when={t().by === "notice"}><p>{firstSentence(t().prompt).slice(0, 120)}</p></Show>
      <For each={segments()}>{(seg) => (seg.k === "group" ? <p>{groupLine(seg.group).text}</p> : seg.entry.say ? text(seg.entry.say.text, html) : seg.entry.model && seg.entry.model.body === undefined && seg.entry.model.permit === undefined ? <p>{rowWords(seg.entry.model)}</p> : null)}</For>
      <Show when={ledgered() && t().answer}>{(a) => text(a().text, html)}</Show>
      <For each={props.far.copies}>{(c) => <i hidden data-copy-held={c.kind} data-name={c.name} />}</For>
    </div>
  );
}

/** what focus can go to in a turn's text: a link, a disclosure's summary */
const FOCUSABLE = "a[href], summary";

/** focus went into a stand-in (a link in its text): the turn is filled (`refill`) and the same link in its rows takes the focus. the place is
    the nth text surface and the nth link in it, the same in both, since both paint the said rows and then the answer in order */
function focusBack(turn: HTMLElement | null, target: EventTarget | null, refill: () => void): void {
  if (!turn) return;
  const surfaces = Array.from(turn.querySelectorAll("[data-far-md]"));
  const at = surfaces.findIndex((s) => target instanceof Node && s.contains(target));
  const inside = at < 0 ? -1 : Array.from(surfaces[at]?.querySelectorAll(FOCUSABLE) ?? []).indexOf(target as Element);
  refill();
  if (inside >= 0) turn.querySelectorAll(".say-md, .answer")[at]?.querySelectorAll<HTMLElement>(FOCUSABLE)[inside]?.focus();
}
