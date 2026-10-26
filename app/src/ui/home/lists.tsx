/* home's two lists over the windows (docs/home.md, the working fold; cleared while you were away), a chunk of their own
   (ui/later.ts): the working fold opened, a row per folded thread with its live line and clock, and the threads the server
   cleared while you were away, each with "bring back". both are the answer sheet's shape (asks/sheet.tsx): a sheet from the
   foot on the deck, where a thumb reaches; a popover hung under what opened it on the strip and the rail, so the stage
   stays in view. escape, a press outside and the close button close it, and focus goes back to what opened it. */

import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { play } from "../../motion/animate";
import { FADE, SHEET } from "../../motion/springs";
import { state } from "../../store";
import type { AwayThread } from "../../sync/protocol";
import { Close } from "../close";
import { RepoMark } from "../repo-mark/repo-mark";
import { clearSuffix, clearThreads } from "../window/clear";
import { clearName } from "../window/clearing";
import { colourMap } from "../window/colours";
import { colourOf, colourStyle } from "../window/repo";
import type { TailLine } from "../window/tail";
import { footClock, parkedOn, type WindowView, windowName } from "../window/view";
import { awayDetail, awaySubtitle, awayWords } from "./away";
import { unclear } from "./settle-api";
import { type FoldKind, foldWords } from "./working-fold";

type Arrangement = "deck" | "strip" | "rail";

/** the popover's width and its margins from the screen */
const POPOVER_WIDTH = 440;
const MARGIN = 12;
const LEAST = 280;

function HomeSheet(props: { arrangement: Arrangement; from: HTMLElement; title: string; sub: string; label: string; onClose: () => void; children: JSX.Element; close?: (close: () => void) => void }) {
  let sheetEl: HTMLDivElement | undefined;
  let scrimEl: HTMLDivElement | undefined;
  const deck = () => props.arrangement === "deck";
  /* the popover's place, measured once as it opens: under what opened it, its left edge on that one's */
  const place = (): Record<string, string> => {
    if (deck()) return {};
    // the away line's "show" opens it, and it hangs from the line's start, as the capsule's list hangs from the capsule
    const box = (props.from.closest(".away-line") ?? props.from).getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, innerWidth - 2 * MARGIN);
    const top = Math.min(box.bottom + 8, innerHeight - MARGIN - LEAST);
    const left = Math.max(MARGIN, Math.min(box.left, innerWidth - MARGIN - width));
    return { top: `${top}px`, left: `${left}px`, width: `${width}px`, "max-height": `${innerHeight - top - MARGIN}px` };
  };
  const placed = place();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const out = sheetEl && play(sheetEl, deck() ? [{ transform: "none" }, { transform: "translateY(110%)" }] : [{ opacity: 1 }, { opacity: 0, transform: "scale(.97)" }], deck() ? SHEET : FADE, { fill: "forwards" });
    if (scrimEl) play(scrimEl, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
    await out?.finished.catch(() => undefined);
    const back = props.from;
    props.onClose();
    // home is inert under the sheet until it closes: focus goes back to what opened it once it is not
    queueMicrotask(() => back.isConnected && back.focus({ preventScroll: true }));
  };
  props.close?.(() => void close());
  onMount(() => {
    if (sheetEl) play(sheetEl, deck() ? [{ transform: "translateY(110%)" }, { transform: "none" }] : [{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], deck() ? SHEET : FADE);
    if (scrimEl) play(scrimEl, [{ opacity: 0 }, { opacity: 1 }], FADE);
    queueMicrotask(() => sheetEl?.focus({ preventScroll: true }));
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    void close();
  };
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => document.removeEventListener("keydown", onKey, true));
  return (
    <>
      <div class="hsheet-scrim" data-deck={deck() ? "" : undefined} ref={scrimEl} onClick={() => void close()} />
      <div ref={sheetEl} class="hsheet" data-arrangement={props.arrangement} role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1} style={placed}>
        <Show when={deck()}>
          <i class="hsheet-grab" aria-hidden="true" />
        </Show>
        <div class="hsheet-head">
          <h2>{props.title}</h2>
          <Close label={`close ${props.label}`} class="hsheet-close" onClick={() => void close()} />
        </div>
        <p class="hsheet-sub">{props.sub}</p>
        {props.children}
      </div>
    </>
  );
}

/** a tail line in a few words: what a folded thread is doing now */
export function lineOf(line: TailLine | undefined): string {
  if (!line) return "";
  switch (line.kind) {
    case "tool":
      return `${line.verb} ${line.object}`.trim();
    case "reads":
      return line.count > 1 ? `read ${line.count} files` : `read ${line.object}`;
    case "prose":
    case "prompt":
      return line.text;
    case "report":
      return `${line.from}: ${line.text}`;
    case "file":
      return line.name;
    default:
      return line satisfies never;
  }
}

/** a folded row's second line: what a parked thread waits on, as its window says it; a working one's newest line */
export function rowLine(view: WindowView): string {
  if (view.state === "parked") return `waiting on ${parkedOn(view)}; ${view.jobs === 1 || !view.jobs ? "its notice wakes it" : "their notices wake it"}`;
  if (view.parkedAgents) return view.parkedAgents === 1 ? "its agent is at work; its report wakes it" : `${view.parkedAgents} agents at work; their reports wake it`;
  return lineOf(view.tail.at(-1)) || "working";
}

export type FoldListProps = {
  keys: readonly string[];
  kindOf: (key: string) => FoldKind;
  viewOf: (key: string) => WindowView | null;
  now: number;
  showHost: boolean;
  arrangement: Arrangement;
  from: HTMLElement;
  onClose: () => void;
  onOpenThread: (key: string, from: HTMLElement, event: Event) => void;
};

/** the working fold, opened: a row per folded thread. a row opens its thread; a thread parked on jobs alone keeps its clear,
    as its window had it. the list follows the fold: a thread that finishes, fails or asks leaves it at once, and when the
    last has gone the list closes */
export function FoldList(props: FoldListProps) {
  let closeIt: () => void = () => undefined;
  const working = () => props.keys.filter((key) => props.kindOf(key) === "working").length;
  createEffect(() => {
    if (props.keys.length === 0) closeIt();
  });
  return (
    <HomeSheet
      arrangement={props.arrangement}
      from={props.from}
      title={foldWords(working(), props.keys.length - working()) || "nothing working"}
      sub="nothing wrong with any of them. one leaves this list the moment it finishes, stops or asks."
      label="the working threads"
      onClose={props.onClose}
      close={(close) => (closeIt = close)}
    >
      <ul class="hrows" aria-label="working threads">
        <For each={props.keys}>
          {(key) => (
            <Show when={props.viewOf(key)}>
              {(view) => (
                <li class="hrow wrow" data-fold={props.kindOf(key)} style={colourStyle(view().colour)}>
                  <RepoMark host={view().host} root={view().root} name={view().repo} colour={view().colour} size={22} />
                  <button
                    class="hrow-open"
                    type="button"
                    aria-label={`open ${windowName(view())}`}
                    onClick={(event) => {
                      props.onOpenThread(key, event.currentTarget.closest<HTMLElement>(".hrow") ?? event.currentTarget, event);
                      closeIt();
                    }}
                  >
                    <span class="hrow-t">
                      <b>{view().repo}</b> · {view().title}
                    </span>
                  </button>
                  <Show when={view().state === "parked"} fallback={<span class="hrow-clock">{footClock(view(), props.now)}</span>}>
                    <button class="hrow-act" type="button" aria-label={clearName(view(), props.showHost, clearSuffix(key))} onClick={() => void clearThreads([key], "window")}>
                      clear
                    </button>
                  </Show>
                  <span class="hrow-s">{rowLine(view())}</span>
                  <i class="hrow-lane" aria-hidden="true">
                    <i />
                  </i>
                </li>
              )}
            </Show>
          )}
        </For>
      </ul>
    </HomeSheet>
  );
}

export type AwaySheetProps = {
  /** the list as it stood when "show" was pressed: seeing it empties the server's list, and the sheet keeps its rows */
  rows: readonly AwayThread[];
  mode: "seen1h" | "any3h" | "never";
  arrangement: Arrangement;
  from: HTMLElement;
  onClose: () => void;
};

/** the threads the server cleared while you were away, each with "bring back", and "bring all back" at the foot. a row
    brought back says so and stays, so the list does not move under the finger */
export function AwaySheet(props: AwaySheetProps) {
  let closeIt: () => void = () => undefined;
  const [back, setBack] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = createSignal<string | null>(null);
  const rowOf = createMemo(() =>
    props.rows.map((row) => {
      const thread = state.fleet.threads[row.key];
      const repo = thread?.place?.name ?? "";
      const title = thread ? thread.title.trim() || "untitled" : "a thread no longer held here";
      const colour = colourOf({ host: thread?.agent ?? "", root: thread?.place?.root ?? "" }, colourMap());
      return { row, repo, title, host: thread?.agent ?? "", root: thread?.place?.root ?? "", colour };
    }),
  );
  const bring = async (keys: string[]) => {
    const todo = keys.filter((key) => !back().has(key) && !busy().has(key));
    if (todo.length === 0) return;
    setBusy((was) => new Set([...was, ...todo]));
    const result = await unclear(todo, "away");
    setBusy((was) => new Set([...was].filter((key) => !todo.includes(key))));
    if (!result.ok) return setProblem(`not brought back. ${result.error}`);
    setBack((was) => new Set([...was, ...result.back]));
    setProblem(result.refused[0]?.message ?? null);
  };
  const left = () => props.rows.filter((row) => !back().has(row.key)).map((row) => row.key);
  return (
    <HomeSheet
      arrangement={props.arrangement}
      from={props.from}
      title={awayWords(props.rows.length)}
      sub={awaySubtitle(props.mode)}
      label="threads cleared while you were away"
      onClose={props.onClose}
      close={(close) => (closeIt = close)}
    >
      <ul class="hrows" aria-label="cleared threads">
        <For each={rowOf()}>
          {(item, index) => {
            const name = () => `${item.repo ? `${item.repo}: ` : ""}${item.title}${rowOf().some((other, i) => i !== index() && other.repo === item.repo && other.title === item.title) ? `, ${item.row.key.slice(-6)}` : ""}`;
            return (
              <li class="hrow arow" style={colourStyle(item.colour)}>
                <RepoMark host={item.host} root={item.root} name={item.repo || "?"} colour={item.colour} size={22} />
                <span class="hrow-t">
                  <Show when={item.repo}>
                    <b>{item.repo}</b> ·{" "}
                  </Show>
                  {item.title}
                </span>
                <Show when={!back().has(item.row.key)} fallback={<span class="hrow-done">brought back</span>}>
                  <button class="hrow-act" type="button" aria-label={`bring back ${name()}`} disabled={busy().has(item.row.key)} onClick={() => void bring([item.row.key])}>
                    bring back
                  </button>
                </Show>
                <span class="hrow-s">{awayDetail(item.row, props.mode)}</span>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={problem()}>
        {(said) => (
          <p class="hsheet-problem" role="alert">
            {said()}
          </p>
        )}
      </Show>
      <button
        class="hsheet-all"
        type="button"
        disabled={left().length === 0 || busy().size > 0}
        onClick={async () => {
          await bring(left());
          if (left().length === 0) closeIt();
        }}
      >
        bring all back
      </button>
    </HomeSheet>
  );
}
