/* home, what next (docs/design.md, home: what next): what the stage shows at the strip and the rail when no thread is
   chosen, and the top of the deck. the field is the hero (field.tsx); under it, at the strip and the rail, what to do
   next, assembled from what the server gave (assemble.ts): the threads that need you in the inbox's order, each one tap
   from its verb, then the working fold, then the repos to start in. on the deck the windows under the field are that list
   already, in the same order, so the deck draws the field alone.

   a chunk of its own (ui/later.ts): it is warmed the moment home mounts, and its styles are in the first load (next.css,
   imported by home), so its arrival never reorders the cascade. */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { play } from "../../motion/animate";
import { FADE, SHEET } from "../../motion/springs";
import { Icon } from "../composer/icons";
import type { Place } from "../composer/new-thread";
import type { FoldKind } from "../home/working-fold";
import { RepoMark } from "../repo-mark/repo-mark";
import type { WindowView } from "../window/view";
import { type NeedRow, nextUp, type RepoRow } from "./assemble";
import { Field, type FieldApi, type FieldPlace } from "./field";

/** what home asks of what next: the field's own verbs, and the arrival as a thread steps back */
export type NextApi = FieldApi & { arrive: () => void };

export type NextUpProps = {
  /** the deck draws the field alone; the strip and the rail draw the list under it */
  deck: boolean;
  /** the inspector's column beside the stage (the rail, 1400 and up, with the column shown): the repos go there, so the
      column is never empty ground beside home, and the card's edge does not move between home and a thread */
  asideRepos: boolean;
  /** that column, once it is home's to draw in (the thread's details have left it) */
  aside?: HTMLElement | undefined;
  start: Place | null;
  /** home's windows in the server's order, and their views */
  order: readonly string[];
  viewOf: (key: string) => WindowView | null;
  foldKeys: readonly string[];
  kindOf: (key: string) => FoldKind;
  now: number;
  /** how many repos there is room for under the list */
  repoRoom: number;
  onOpen: (key: string, from: HTMLElement) => void;
  onAnswer: (key: string, from: HTMLElement) => void;
  onFold: (from: HTMLElement) => void;
  onBorn: (key: string, from: HTMLElement) => void;
  /** escape on the empty field: the thread you came from, when you came from one */
  onEscape?: (() => void) | undefined;
  api?: (api: NextApi) => void;
};

export function NextUp(props: NextUpProps) {
  let field: FieldApi | undefined;
  /* the field's machine and its repos in recency order: the field owns them (composer/new-thread.ts), the list reads them */
  const [place, setPlace] = createSignal<FieldPlace | null>(null);
  const fold = createMemo(() => {
    const working = props.foldKeys.filter((key) => props.kindOf(key) === "working").length;
    return { working, waiting: props.foldKeys.length - working };
  });
  const next = createMemo(() =>
    nextUp({ order: props.order, viewOf: props.viewOf, fold: fold(), host: place()?.host() ?? "", repos: place()?.repos() ?? [], lastAt: (host, root) => place()?.lastAt(host, root) ?? null, now: props.now, repoLimit: props.asideRepos ? 10 : props.repoRoom }),
  );
  const empty = () => next().needs.length === 0 && next().fold === null;

  /* the inspector's column stands its first row level with the field across the stage: measured when either box changes
     size (a resize, the list growing), never in a frame loop */
  let rootEl: HTMLDivElement | undefined;
  const [asideTop, setAsideTop] = createSignal(26);
  createEffect(() => {
    const column = props.asideRepos ? props.aside : undefined;
    const root = rootEl;
    if (!column || !root) return;
    const measure = () => {
      const fieldEl = root.querySelector(".nx-field");
      // the column's own padding is inside its box: the row stands level with the field's edge, not the column's
      const inset = parseFloat(getComputedStyle(column).paddingTop) || 0;
      if (fieldEl) setAsideTop(Math.max(26, Math.round(fieldEl.getBoundingClientRect().top - column.getBoundingClientRect().top - inset)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(root);
    if (root.parentElement) observer.observe(root.parentElement);
    onCleanup(() => observer.disconnect());
  });

  /* a thread stepping back: the field comes down out of the bar where its collapsed form was, the list settles in under
     it, both on the sheet spring and a beat behind the thread's own fade, so two pages of words never cross */
  const arrive = () => {
    const fieldEl = rootEl?.querySelector(".nx-field");
    const lists = rootEl?.querySelector(".nx-lists");
    if (fieldEl) play(fieldEl, [{ opacity: 0, transform: "translateY(-18px) scale(.985)" }, { opacity: 1, transform: "none" }], SHEET, { delay: 90, fill: "backwards" });
    if (lists) play(lists, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], SHEET, { delay: 140, fill: "backwards" });
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
          props.api?.({ ...api, arrive });
        }}
      />
      <Show when={!props.deck}>
        <div class="nx-lists">
          <Show when={next().needs.length > 0}>
            <section class="nx-group" aria-labelledby="nx-needs">
              <h2 id="nx-needs">waiting on you</h2>
              <ul class="nx-list">
                <For each={next().needs}>{(row) => <Need row={row} onOpen={props.onOpen} onAnswer={props.onAnswer} />}</For>
              </ul>
            </section>
          </Show>
          <Show when={next().fold}>
            {(counts) => (
              <section class="nx-group" aria-label="working">
                <ul class="nx-list">
                  <li>
                    <button type="button" class="nx-item" aria-haspopup="dialog" aria-label={workingName(counts().working, counts().waiting)} onClick={(event) => props.onFold(event.currentTarget)}>
                      <span class="nx-beads" aria-hidden="true">
                        <For each={props.foldKeys.slice(0, 3)}>
                          {(key) => (
                            <Show when={props.viewOf(key)}>{(view) => <RepoMark host={view().host} root={view().root} size={22} />}</Show>
                          )}
                        </For>
                      </span>
                      <span class="nx-text" aria-hidden="true">
                        <b>{workingWords(counts().working, counts().waiting)}</b>
                        <small>nothing wrong</small>
                      </span>
                      <span class="nx-verb" aria-hidden="true">see</span>
                    </button>
                  </li>
                </ul>
              </section>
            )}
          </Show>
          <Show when={empty()}>
            <p class="nx-quiet">nothing needs you right now.</p>
          </Show>
          <Show when={next().repos.length > 0}>
            <Show when={props.asideRepos} fallback={<StartIn repos={next().repos} onPick={(row) => field?.pick(row.host, row.root)} />}>
              <Show when={props.aside}>
              {(column) => (
                <Portal mount={column()}>
                  <div class="nx nx-aside" style={{ "--nx-aside-top": `${asideTop()}px` }} ref={(el) => play(el, [{ opacity: 0 }, { opacity: 1 }], FADE)}>
                    <StartIn repos={next().repos} onPick={(row) => field?.pick(row.host, row.root)} />
                  </div>
                </Portal>
              )}
              </Show>
            </Show>
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
                <RepoMark host={row.host} root={row.root} size={32} />
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
        <RepoMark host={props.row.host} root={props.row.root} size={32} />
        <span class="nx-text" aria-hidden="true">
          <b>{props.row.head}</b>
          <small>{props.row.detail}</small>
        </span>
        <span class="nx-verb" data-on={props.row.verb === "answer" ? "" : undefined} aria-hidden="true">{props.row.verb}</span>
      </button>
    </li>
  );
}

const workingWords = (working: number, waiting: number) => [working ? `${working} working` : "", waiting ? `${waiting} waiting on a job` : ""].filter(Boolean).join(", ");
/** named apart from the capsule's "4 working. show the list": both can be on screen, and every name is unique */
const workingName = (working: number, waiting: number) => `see the working fold: ${workingWords(working, waiting)}`;
