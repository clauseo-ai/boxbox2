/* home, what next (docs/design.md, home: what next): what the stage shows at the strip and the rail when no thread is
   chosen, and the top of the deck. the field is the hero (field.tsx); under it, what to do next, assembled from what the
   server gave (assemble.ts): the threads that need you in the inbox's order, each one tap from its verb, then the working
   fold, then the repos to start in. the fold's row is there at the strip and the rail although its capsule leads the
   column: the column can be folded or put away, and a home that says "nothing needs you" over three threads at work reads
   as broken. on the deck the windows under the field are the list already, in the same order, and the capsule is under
   the bar, so the deck draws the field alone, and "start in" under it only when the deck has no windows to show.

   a chunk of its own (ui/later.ts): it is warmed the moment home mounts, and its styles are in the first load (next.css,
   imported by home), so its arrival never reorders the cascade. home mounts it once, whatever the arrangement, so the
   field and its words live through a resize across 700 px. */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { play } from "../../motion/animate";
import { FADE, SHEET, SNAP } from "../../motion/springs";
import { Icon } from "../composer/icons";
import type { Place } from "../composer/new-thread";
import { warmEdge } from "../later";
import { RepoMark } from "../repo-mark/repo-mark";
import { FoldToggle } from "../home/fold";
import type { Beside } from "../home/windows";
import { type FoldKind, foldWords } from "../home/working-fold";
import type { WindowView } from "../window/view";
import { type NeedRow, nextUp, type RepoRow } from "./assemble";
import { Field, type FieldApi, type FieldPlace } from "./field";

/** a home mark: under the two-letter size (repo-mark/letters.ts), so a repo reads as the one letter its window, its chip
    and the capsule's beads show on the same screen (design.md, the repo mark) */
export const MARK = 26;

/** the way back to the windows fades in this long into their move: as the edge comes to it */
const BACK_AFTER_MS = 220;

/** how far down the spare height of the stage the field and its list stand: a little above the middle, where the eye
    rests, and never under the top once they are taller than the stage (they flow from the top and scroll then) */
export const PLACE = 0.4;

/** what home asks of what next: the field's own verbs, the arrival as a thread steps back, and how many repos it offers */
export type NextApi = FieldApi & {
  arrive: () => void;
  /** how many repos "start in" offers (the empty deck's ghost gives way to them) */
  offers: () => number;
  /** what of home's list moves in home's reorder flip when its rows change (none on the deck, where the windows are the list) */
  moving: () => Element[];
  /** stands the block where the room as it is now puts it, at once and without a move of its own: the card's edge lays the
      stage out and measures it in one task, and carries the block itself (home.tsx, glide; edge.ts, riders) */
  place: () => void;
};

export type NextUpProps = {
  /** the deck draws the field alone, and "start in" under it when it shows no window (all folded, or none); the strip and
      the rail draw the list */
  deck: boolean;
  start: Place | null;
  /** home's windows in the server's order, and their views */
  order: readonly string[];
  viewOf: (key: string) => WindowView | null;
  now: number;
  /** the window's height, for how many repos there is room for */
  height: number;
  onOpen: (key: string, from: HTMLElement) => void;
  onAnswer: (key: string, from: HTMLElement) => void;
  onBorn: (key: string, from: HTMLElement) => void;
  /** the threads folded into the working fold, in the order's order, and what each is doing: at the strip and the rail
      home says them as a row of its own, so a stage with the windows folded or put away still says what is at work */
  foldKeys: readonly string[];
  kindOf: (key: string) => FoldKind;
  /** the row's press: the fold's list, as the capsule's press opens it */
  onFold: (from: HTMLElement) => void;
  /** the windows put away with no thread on the stage (strip and rail): the round that shows them again, at the room's top
      left where a thread's bar holds it, so home is never left with no way back to them. `arriving`: it comes with the
      windows' move, under the receding edge (edge.ts clips the room with the card), and fades in as it is uncovered, since
      the card on home is clear and a hard cut would be an edge nobody can see */
  back: { form: Beside; arriving: boolean; onShow: () => void } | null;
  /** escape on the empty field: the thread you came from, when you came from one */
  onEscape?: (() => void) | undefined;
  api?: (api: NextApi) => void;
};

export function NextUp(props: NextUpProps) {
  let field: FieldApi | undefined;
  /* the field's machine and its repos in recency order: the field owns them (composer/new-thread.ts), the list reads them */
  const [place, setPlace] = createSignal<FieldPlace | null>(null);
  /* the repos there is room for under what needs you: the stage's height less the field and the rows above (on the deck,
     the bar and the capsule above the field too), two to eight (five on the deck) */
  const repoRoom = () => Math.max(2, Math.min(props.deck ? 5 : 8, Math.floor((props.height - (props.deck ? 520 : 470)) / 64)));
  const bare = () => props.deck && props.order.length === 0;
  const next = createMemo(() =>
    nextUp({ order: props.order, viewOf: props.viewOf, host: place()?.host() ?? "", repos: place()?.repos() ?? [], lastAt: (host, root) => place()?.lastAt(host, root) ?? null, now: props.now, repoLimit: repoRoom() }),
  );
  const lists = () => !props.deck || bare();
  const needs = () => (props.deck ? [] : next().needs);
  const working = createMemo(() => {
    if (props.deck || props.foldKeys.length === 0) return null;
    const busy = props.foldKeys.filter((key) => props.kindOf(key) === "working").length;
    return { working: busy, waiting: props.foldKeys.length - busy };
  });

  /* where the block stands in the stage (strip and rail): PLACE of the spare height down, measured when the stage or the
     block changes size, never in a frame loop. the field growing as words are typed is left out of the block's height, so
     typing never walks the field up the screen; a list that grows or shrinks moves the block, and that move plays from where
     it was on the snap spring (a FLIP of one box, transform only, up and down). across, the block is left alone: the room
     only changes width when the card's edge moves, and the edge carries the room's boxes with it (edge.ts, riders), so a
     flip of its own would play a second move after the first. rows arriving inside the list are home's reorder flip, after
     the calm, like the windows' (home.tsx, applyOrder) */
  let rootEl: HTMLDivElement | undefined;
  let placeNow = () => {};
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
    const measure = (still = false) => {
      const fieldEl = root.querySelector<HTMLElement>(".nx-field");
      const tall = fieldEl?.offsetHeight ?? 0;
      if (fieldEl && (fieldEl.querySelector("textarea")?.value ?? "") === "") rest = tall;
      const grown = rest ? Math.max(0, tall - rest) : 0;
      const style = getComputedStyle(room);
      const height = room.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      const next = Math.round(Math.max(0, height - (root.offsetHeight - grown)) * PLACE);
      const dy = top < 0 ? 0 : top - next;
      top = next;
      root.style.marginTop = `${next}px`;
      if (!still && Math.abs(dy) > 1) play(root, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], SNAP);
    };
    const observer = new ResizeObserver(() => measure());
    observer.observe(room);
    observer.observe(root);
    placeNow = () => measure(true);
    onCleanup(() => {
      observer.disconnect();
      placeNow = () => {};
    });
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
    <>
      <Show when={props.back}>
        {(back) => (
          <div class="nx-back" ref={(el) => back().arriving && play(el, [{ opacity: 0 }, { opacity: 1 }], FADE, { delay: BACK_AFTER_MS, fill: "backwards" })}>
            <FoldToggle form={back().form} state="hidden" round onToggle={back().onShow} />
          </div>
        )}
      </Show>
      <div class="nx" ref={rootEl} data-deck={props.deck ? "" : undefined}>
        <h1 class="nx-title">what next?</h1>
        <Field
          start={props.start}
          onBorn={props.onBorn}
          {...(props.onEscape ? { onEscape: props.onEscape } : {})}
          onPlace={(p) => setPlace(() => p)}
          api={(api) => {
            field = api;
            props.api?.({ ...api, arrive, offers: () => (lists() ? next().repos.length : 0), moving: () => (props.deck || !rootEl ? [] : [...rootEl.querySelectorAll(".nx-field, .nx-group, .nx-quiet")]), place: () => placeNow() });
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
            <Show when={working()}>
              {(counts) => (
                <section class="nx-group" aria-label="working">
                  <ul class="nx-list">
                    <li>
                      <button type="button" class="nx-item" aria-haspopup="dialog" aria-label={workingName(counts().working, counts().waiting)} onClick={(event) => props.onFold(event.currentTarget)}>
                        <span class="nx-beads" aria-hidden="true">
                          <For each={props.foldKeys.slice(0, 3)}>
                            {(key) => <Show when={props.viewOf(key)}>{(view) => <RepoMark host={view().host} root={view().root} size={MARK} />}</Show>}
                          </For>
                        </span>
                        <span class="nx-text" aria-hidden="true">
                          <b>{foldWords(counts().working, counts().waiting)}</b>
                          <small>nothing wrong</small>
                        </span>
                        <span class="nx-verb" aria-hidden="true">see</span>
                      </button>
                    </li>
                  </ul>
                </section>
              )}
            </Show>
            <Show when={needs().length === 0 && !working() && !props.deck}>
              <p class="nx-quiet">nothing needs you right now.</p>
            </Show>
            <Show when={next().repos.length > 0}>
              <StartIn repos={next().repos} onPick={(row) => field?.pick(row.host, row.root)} />
            </Show>
          </div>
        </Show>
      </div>
    </>
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
  // the way home's motion is the edge's chunk (ui/later.ts): a thread on the stage, however it came, is when it is next wanted
  onMount(() => void warmEdge().catch(() => undefined));
  return (
    <button class="bar-next" type="button" aria-label="what next? go home" aria-keyshortcuts="Escape" onClick={(event) => props.onPress(event)}>
      <span class="bar-next-words">what next?</span>
      <kbd class="bar-next-key" aria-hidden="true">esc</kbd>
    </button>
  );
}

/** named apart from the capsule's "4 working. show the list": both can be on screen, and every name is unique */
const workingName = (working: number, waiting: number) => `see the working fold: ${foldWords(working, waiting)}`;
