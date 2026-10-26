/* the working fold's capsule (docs/home.md, the working fold; working-fold.ts decides who folds and the words): one glass
   capsule under the bar (beside the windows at the strip) for the threads at work with nothing wrong. a bead per thread,
   its repo's mark over a small line that moves while it works and stands still while it waits on a job. a press opens
   the list (lists.tsx, `FoldList`: a sheet on the deck, a popover at the strip and the rail). the capsule is in the first
   load; the list is a chunk of its own (ui/later.ts). */

import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { RepoMark } from "../repo-mark/repo-mark";
import { colourStyle } from "../window/repo";
import type { WindowView } from "../window/view";
import { warmOn } from "../later";
import { type FoldKind, foldLines, foldName, LEFT_MS } from "./working-fold";

/** beads past this many become one "+N": a phone's capsule has room for six beside its words */
const BEADS = 6;

export function WorkingFold(props: {
  /** the folded threads in the order's order, and what each is doing */
  keys: readonly string[];
  kindOf: (key: string) => FoldKind;
  viewOf: (key: string) => WindowView | null;
  /** the repo of the thread that just left the fold: a new object for each leaving, so the same repo twice is news twice */
  left: { repo: string } | null;
  open: boolean;
  onOpen: (from: HTMLElement) => void;
}) {
  const working = () => props.keys.filter((key) => props.kindOf(key) === "working").length;
  const waiting = () => props.keys.length - working();
  /* the beads are kept by key, so a working thread's every frame changes its view and never remakes its bead */
  const lines = () => foldLines(working(), waiting(), news());
  const shown = () => props.keys.slice(0, props.keys.length > BEADS ? BEADS - 1 : BEADS);
  /* "<repo> just left" is news for LEFT_MS, then the line says nothing is wrong again; the timer is this capsule's */
  const [news, setNews] = createSignal<string | null>(null);
  createEffect(
    on(
      () => props.left,
      (left) => {
        setNews(left?.repo ?? null);
        if (left === null) return;
        const timer = setTimeout(() => setNews(null), LEFT_MS);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );
  return (
    <button
      class="wfold"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={props.open}
      aria-label={foldName(working(), waiting(), props.open)}
      onPointerDown={warmOn("FoldList")}
      onClick={(event) => props.onOpen(event.currentTarget)}
    >
      <span class="wfold-words" aria-hidden="true">
        <b>{lines().first}</b>
        <small data-waiting={lines().waiting ? "" : undefined}>{lines().second}</small>
      </span>
      <span class="wfold-beads" aria-hidden="true">
        <For each={shown()}>
          {(key) => (
            <Show when={props.viewOf(key)}>
              {(view) => (
                <span class="wbead" data-fold={props.kindOf(key)} style={colourStyle(view().colour)}>
                  <RepoMark host={view().host} root={view().root} name={view().repo} colour={view().colour} size={20} />
                  <i class="wlane">
                    <i />
                  </i>
                </span>
              )}
            </Show>
          )}
        </For>
        <Show when={props.keys.length > BEADS}>
          <span class="wbead wmore">+{props.keys.length - (BEADS - 1)}</span>
        </Show>
      </span>
      <svg class="wfold-chev" viewBox="0 0 24 24" aria-hidden="true">
        <path d={props.open ? "M7 14l5-5 5 5" : "M10 7l5 5-5 5"} />
      </svg>
    </button>
  );
}
