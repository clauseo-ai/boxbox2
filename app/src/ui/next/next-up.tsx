/* home, what next (docs/design.md, home: what next): what the stage shows at the strip and the rail when no thread is
   chosen, and the top of the deck. the field is the hero (field.tsx); under it, what to do next, assembled from what the
   server gave (assemble.ts): the threads that need you in the inbox's order, each one tap from its verb, then the repos to
   start in. the working fold is not repeated here: its capsule is on screen at every arrangement. on the deck the windows
   under the field are the list already, in the same order, so the deck draws the field alone, and "start in" under it only
   when the deck has no windows to show (all folded, or none).

   a chunk of its own (ui/later.ts): it is warmed the moment home mounts, and its styles are in the first load (next.css,
   imported by home), so its arrival never reorders the cascade. home mounts it once, whatever the arrangement, so the
   field and its words live through a resize across 700 px. */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { play } from "../../motion/animate";
import { SHEET, SNAP } from "../../motion/springs";
import { Icon } from "../composer/icons";
import type { Place } from "../composer/new-thread";
import { RepoMark } from "../repo-mark/repo-mark";
import type { WindowView } from "../window/view";
import { type NeedRow, nextUp, type RepoRow } from "./assemble";
import { Field, type FieldApi, type FieldPlace } from "./field";

/** a home mark: under the two-letter size (repo-mark/letters.ts), so a repo reads as the one letter its window, its chip
    and the capsule's beads show on the same screen (design.md, the repo mark) */
export const MARK = 26;

/** how far down the spare height of the stage the field and its list stand: a little above the middle, where the eye
    rests, and never under the top once they are taller than the stage (they flow from the top and scroll then) */
export const PLACE = 0.4;

/** what home asks of what next: the field's own verbs, the arrival as a thread steps back, and how many repos it offers */
export type NextApi = FieldApi & { arrive: () => void; offers: () => number };

export type NextUpProps = {
  /** the deck draws the field alone, and "start in" under it when it has no windows; the strip and the rail draw the list */
  deck: boolean;
  /** the deck shows no windows (all folded, or none): the list's "start in" fills the room under the field */
  bare: boolean;
  start: Place | null;
  /** home's windows in the server's order, and their views */
  order: readonly string[];
  viewOf: (key: string) => WindowView | null;
  now: number;
  /** how many repos there is room for under the list */
  repoRoom: number;
  onOpen: (key: string, from: HTMLElement) => void;
  onAnswer: (key: string, from: HTMLElement) => void;
  onBorn: (key: string, from: HTMLElement) => void;
  /** escape on the empty field: the thread you came from, when you came from one */
  onEscape?: (() => void) | undefined;
  api?: (api: NextApi) => void;
};

export function NextUp(props: NextUpProps) {
  let field: FieldApi | undefined;
  /* the field's machine and its repos in recency order: the field owns them (composer/new-thread.ts), the list reads them */
  const [place, setPlace] = createSignal<FieldPlace | null>(null);
  const next = createMemo(() =>
    nextUp({ order: props.order, viewOf: props.viewOf, host: place()?.host() ?? "", repos: place()?.repos() ?? [], lastAt: (host, root) => place()?.lastAt(host, root) ?? null, now: props.now, repoLimit: props.repoRoom }),
  );
  const lists = () => !props.deck || props.bare;
  const needs = () => (props.deck ? [] : next().needs);

  /* where the block stands in the stage (strip and rail): PLACE of the spare height down, measured when the stage or the
     block changes size, never in a frame loop. the field growing as words are typed is left out of the block's height, so
     typing never walks the field up the screen; a list that grows or shrinks moves the block, and that move plays from where
     it was on the snap spring (a FLIP of one box, transform only). rows arriving inside the list are home's reorder flip,
     after the calm, like the windows' (home.tsx, applyOrder) */
  let rootEl: HTMLDivElement | undefined;
  createEffect(() => {
    const root = rootEl;
    const room = root?.parentElement;
    if (!root || !room) return;
    if (props.deck) {
      root.style.marginTop = "";
      return;
    }
    let rest = 0;
    let top = -1;
    let left = Number.NaN;
    const measure = () => {
      const fieldEl = root.querySelector<HTMLElement>(".nx-field");
      const tall = fieldEl?.offsetHeight ?? 0;
      if (fieldEl && (fieldEl.querySelector("textarea")?.value ?? "") === "") rest = tall;
      const grown = rest ? Math.max(0, tall - rest) : 0;
      const style = getComputedStyle(room);
      const height = room.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      const next = Math.round(Math.max(0, height - (root.offsetHeight - grown)) * PLACE);
      const at = room.getBoundingClientRect().left + root.offsetLeft;
      const dy = top < 0 ? 0 : top - next;
      const dx = Number.isNaN(left) ? 0 : left - at;
      top = next;
      left = at;
      root.style.marginTop = `${next}px`;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) play(root, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], SNAP);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(room);
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });

  /* a thread stepping back: the field comes down out of the bar where its collapsed form was, the list settles in under
     it, both on the sheet spring and a beat behind the thread's own leaving, so two pages of words never cross */
  const arrive = () => {
    const fieldEl = rootEl?.querySelector(".nx-field");
    const listsEl = rootEl?.querySelector(".nx-lists");
    if (fieldEl) play(fieldEl, [{ opacity: 0, transform: "translateY(-18px) scale(.985)" }, { opacity: 1, transform: "none" }], SHEET, { delay: 90, fill: "backwards" });
    if (listsEl) play(listsEl, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], SHEET, { delay: 140, fill: "backwards" });
  };

  return (
    <div class="nx" ref={rootEl} data-deck={props.deck ? "" : undefined}>
      <h1 class="nx-title">what next?</h1>
      <Field
        start={props.start}
        onBorn={props.onBorn}
        {...(props.onEscape ? { onEscape: props.onEscape } : {})}
        onPlace={(p) => setPlace(() => p)}
        api={(api) => {
          field = api;
          props.api?.({ ...api, arrive, offers: () => next().repos.length });
        }}
      />
      <Show when={lists()}>
        <div class="nx-lists">
          <Show when={needs().length > 0}>
            <section class="nx-group" aria-labelledby="nx-needs">
              <h2 id="nx-needs">waiting on you</h2>
              <ul class="nx-list">
                <For each={needs()}>{(row) => <Need row={row} onOpen={props.onOpen} onAnswer={props.onAnswer} />}</For>
              </ul>
            </section>
          </Show>
          <Show when={needs().length === 0 && !props.deck}>
            <p class="nx-quiet">nothing needs you right now.</p>
          </Show>
          <Show when={next().repos.length > 0}>
            <StartIn repos={next().repos} onPick={(row) => field?.pick(row.host, row.root)} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** the repos to start in, as a group of rows: under the list, or in the inspector's column at the widest rail */
export function StartIn(props: { repos: readonly RepoRow[]; onPick: (row: RepoRow) => void }) {
  return (
    <section class="nx-group" aria-labelledby="nx-start">
      <h2 id="nx-start">start in</h2>
      <ul class="nx-list">
        <For each={props.repos}>
          {(row) => (
            <li>
              <button type="button" class="nx-item" aria-label={row.name} onClick={() => props.onPick(row)}>
                <RepoMark host={row.host} root={row.root} size={MARK} />
                <span class="nx-text" aria-hidden="true">
                  <b>{row.repo}</b>
                  <small>{row.detail}</small>
                </span>
                <span class="nx-verb nx-verb-icon" aria-hidden="true"><Icon name="plus" /></span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

function Need(props: { row: NeedRow; onOpen: (key: string, from: HTMLElement) => void; onAnswer: (key: string, from: HTMLElement) => void }) {
  const go = (event: MouseEvent & { currentTarget: HTMLElement }) => (props.row.verb === "answer" ? props.onAnswer(props.row.key, event.currentTarget) : props.onOpen(props.row.key, event.currentTarget));
  return (
    <li>
      <button type="button" class="nx-item" data-state={props.row.state} aria-label={props.row.name} aria-haspopup={props.row.verb === "answer" ? "dialog" : undefined} onClick={go}>
        <RepoMark host={props.row.host} root={props.row.root} size={MARK} />
        <span class="nx-text" aria-hidden="true">
          <b>{props.row.head}</b>
          <small>{props.row.detail}</small>
        </span>
        <span class="nx-verb" data-on={props.row.verb === "answer" ? "" : undefined} aria-hidden="true">{props.row.verb}</span>
      </button>
    </li>
  );
}

/** the way home from a thread at strip and rail (design.md, home: what next): the field, collapsed in the thread's bar. a
    press, or escape with no field focused, and the thread pours back while the field drops out of the bar. it comes with
    the field's chunk, which home warms as it mounts, so it is in before any thread can be on the stage */
export function WhatNext(props: { onPress: (event: Event) => void }) {
  return (
    <button class="bar-next" type="button" aria-label="what next? go home" aria-keyshortcuts="Escape" onClick={(event) => props.onPress(event)}>
      <span class="bar-next-words">what next?</span>
      <kbd class="bar-next-key" aria-hidden="true">esc</kbd>
    </button>
  );
}
