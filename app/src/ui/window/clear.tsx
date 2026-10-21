/* clearing a thread off home: a window's own control, and the bar's "clear done"
   (docs/home.md, clearing; docs/design.md, the model: windows).

   the window leaves under the finger by its own exit (opacity and a short rise on the fade curve, held at its end
   until it is gone), then the server is told, and the stream brings the order without it: home closes the others up by flip
   (home.tsx, applyOrder; a hand-cleared window skips its calm wait). nothing is deleted: the thread stays in history,
   and comes back on its own when it works, asks or is updated (server/src/fleet/model.rs). a refusal (the thread
   started working in the meantime) puts the window back with the reason beside it. */

import { createMemo, createRoot, createSignal, Show } from "solid-js";
import { api } from "../../api/client";
import { play } from "../../motion/animate";
import { FADE } from "../../motion/springs";
import { state } from "../../store";
import { deviceIdentity } from "../../sync/client";
import { said, UNREACHABLE } from "../machines/verb";
import { doneKeys, doneLabel, doneName, markHandCleared, nameSuffixes, releaseHandCleared } from "./clearing";
import type { WindowView } from "./view";

export { handCleared } from "./clearing";

export type ClearSource = "window" | "done";

const [notices, setNotices] = createSignal<Record<string, string>>({});

/** why a thread stayed on home, to show in its window until the next clear or until the window's state moves on */
export function clearNotice(key: string): string | undefined {
  return notices()[key];
}

/** the window changed (it finished, asked, started again): what it was told no longer holds */
export function dismissClearNotice(key: string): void {
  if (notices()[key] === undefined) return;
  setNotices((was) => Object.fromEntries(Object.entries(was).filter(([held]) => held !== key)));
}

/** the suffix that keeps this window's clear name its own among windows that share repo, title and machine. read from
    the fleet, so only a title, a repo or the order moving works it out again */
const suffixes = createRoot(() => {
  const windows = createMemo(() =>
    state.fleet.order.flatMap((key) => {
      const thread = state.fleet.threads[key];
      return thread ? [{ key, host: thread.agent, repo: thread.place?.name ?? "", title: thread.title.trim() || "untitled" }] : [];
    }),
  );
  return {
    /** the clear button's name shows the machine when there is more than one */
    clear: createMemo(() => nameSuffixes(windows(), state.fleet.agentNames.length > 1)),
    /** the window's own button's name never shows the machine */
    open: createMemo(() => nameSuffixes(windows(), false)),
  };
});

export function clearSuffix(key: string): string {
  return suffixes.clear().get(key) ?? "";
}

/** the same, for the window's own button (`windowName`): two threads titled alike in one repo are two buttons */
export function openSuffix(key: string): string {
  return suffixes.open().get(key) ?? "";
}

const windowOf = (key: string): HTMLElement | null => document.querySelector<HTMLElement>(`.win[data-key="${CSS.escape(key)}"]`);

/** the window's exit: it fades and rises a little (a content swap, so the fade curve) and stays gone until the order
    drops it. flip is not used here: the others close up once, when the order changes, measured then */
function leave(key: string): Animation | null {
  const el = windowOf(key);
  if (!el) return null;
  return play(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px) scale(.97)" }], FADE, { fill: "forwards" });
}

/** clears threads off home, for every device. resolves once the server has answered; the windows are already gone */
export async function clearThreads(keys: readonly string[], source: ClearSource): Promise<void> {
  if (keys.length === 0) return;
  setNotices((was) => Object.fromEntries(Object.entries(was).filter(([key]) => !keys.includes(key))));
  const exits = new Map(keys.map((key) => [key, leave(key)] as const));
  // marked before the exits end, because the order that drops them can reach this device before the answer does. the
  // mark lets itself go after HAND_MS: a window the order never drops is put back rather than left invisible
  markHandCleared(keys, (late) => {
    for (const key of late) if (windowOf(key)) exits.get(key)?.cancel();
  });
  // the windows leave first and the rest close up after: the server is asked once they are gone, because the order
  // that drops them is what makes home flip the others, and a window removed in the same frame would never be seen leaving
  await Promise.all([...exits.values()].map((exit) => exit?.finished.catch(() => undefined)));
  const back = (key: string, why: string) => {
    exits.get(key)?.cancel();
    releaseHandCleared([key]);
    setNotices((was) => ({ ...was, [key]: why }));
  };
  try {
    const { data, error, response } = await api.POST("/api/clear", { body: { ...deviceIdentity(), keys: [...keys], source } });
    if (!data) {
      for (const key of keys) back(key, said(error, response.status));
      return;
    }
    for (const refused of data.refused) back(refused.key, refused.message);
    // the order the stream carries drops the rest
  } catch {
    for (const key of keys) back(key, UNREACHABLE);
  }
}

/** the bar's pill: every done or idle thread off home at once. nothing is drawn when there is none */
export function ClearDone(props: { views: readonly WindowView[] }) {
  const keys = () => doneKeys(props.views);
  /* the count is a memo, so the name is set when it changes and not again on every new list of views */
  const count = createMemo(() => keys().length);
  return (
    <Show when={count() > 0}>
      <button class="pill" type="button" data-clears="done" aria-label={doneName(count())} onClick={() => void clearThreads(keys(), "done")}>
        {doneLabel(count())}
      </button>
    </Show>
  );
}
