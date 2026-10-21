/* the colour sheet (docs/design.md, the colour sheet) over the real thread stage of the shell's thread story, and the thread
   menu with its colour item. the recorded fleet has two repos on its one machine; two more are given colours here so the
   sheet has neighbours, one of them (relay) wearing slate by hand. "use" is answered by the stories' server: the success
   story patches the store as the stream's `colour` frame would, the unkept story does that and then answers 503 with
   `store-down` (the store did not keep it), and the refused story answers 400 with the server's words. */

import "../../../shell/stories/server";
import { type ReactElement, createElement, useEffect, useRef } from "react";
import { answerColours } from "../../../shell/stories/server";
import { mountShell, type ShellStory } from "../../../shell/stories/mount";
import { applyPatches, state } from "../../../store";
import { onShell } from "../../thread/stories/on-shell";
import type { Fleet } from "../../../sync/reducer";
import { mountStageAlone } from "../../thread/stories/stage-alone";
import { type ColourMap, repoKey } from "../../window/repo";

export default { title: "colour" };

/** the repos beside the open thread's, on its machine, that no recorded thread is in */
const RELAY = "/private/tmp/boxbox-m5-windows/repos/relay";
const DOCS = "/private/tmp/boxbox-m5-windows/repos/docs";

/** the server's map with the thread's repo given `chosen` (null: automatic, cobalt), the machine's other recorded repo
    green, relay slate by hand and docs plum */
function coloursFor(fleet: Fleet, key: string, chosen: string | null): ColourMap {
  const session = fleet.threads[key];
  const host = session?.agent ?? "bench";
  const root = session?.place?.root ?? "";
  const other = Object.values(fleet.threads).map((s) => s.place?.root ?? "").find((r) => r !== root);
  return {
    [repoKey({ host, root })]: { auto: "cobalt", chosen },
    ...(other ? { [repoKey({ host, root: other })]: { auto: "green", chosen: null } } : {}),
    [repoKey({ host, root: RELAY })]: { auto: "teal", chosen: "slate" },
    [repoKey({ host, root: DOCS })]: { auto: "plum", chosen: null },
  };
}

/** the same map, patched into the store as the stream's `colour` frames would */
function colour(key: string, chosen: string | null): void {
  applyPatches(Object.entries(coloursFor(state.fleet, key, chosen)).map(([k, value]) => ({ path: ["fleet", "colours", k], value })));
}

/** waits for `selector` under the page (the sheet is a chunk of its own, and a dialog in the top layer), then runs `then` */
function when(selector: string, then: (el: HTMLElement) => void): void {
  const look = (tries: number) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) then(el);
    else if (tries > 0) setTimeout(() => look(tries - 1), 50);
  };
  look(100);
}

const openSheet = (el: HTMLElement, then?: () => void) => {
  el.querySelector<HTMLButtonElement>(".tb-repo-btn")?.click();
  when(".cs-sheet[open] .cs-sw", () => then?.());
};
const tryPick = (pick: string) => when(`.cs-sheet [data-pick="${pick}"]`, (b) => b.click());

/** the server takes a choice: the stream's frame lands first, as it usually does, then the answer */
const takes = () =>
  answerColours((choice) => {
    const key = repoKey(choice);
    const auto = state.fleet.colours[key]?.auto ?? "cobalt";
    applyPatches([{ path: ["fleet", "colours", key], value: { auto, chosen: choice.chosen } }]);
    return { status: 200, body: { host: choice.host, root: choice.root, auto, chosen: choice.chosen } };
  });

/** automatic is current: the automatic row is checked, cobalt is ringed and says "auto", nothing to use yet */
export const SheetAutomatic = onShell((key, el) => { takes(); colour(key, null); openSheet(el); });

/** a chosen colour is current: sunset ringed and ticked, automatic still names cobalt */
export const SheetChosen = onShell((key, el) => { takes(); colour(key, "sunset"); openSheet(el); });

/** trying slate, which relay wears on the machine: the stage behind repaints in slate, the note says who wears it and that
    sharing is allowed, and the buttons are "keep cobalt" and "use slate" */
export const SheetTryingShared = onShell((key, el) => { takes(); colour(key, null); openSheet(el, () => tryPick("slate")); });

/** trying automatic from sunset: "keep sunset" and "use automatic" */
export const SheetTryingAutomatic = onShell((key, el) => { takes(); colour(key, "sunset"); openSheet(el, () => tryPick("auto")); });

/** the server heard the choice and could not keep it (a 503 with `store-down`): every device shows sunset already, the sheet stays open and
    says it goes back at a restart, and "use sunset" stays to send it again */
export const SheetUnkept = onShell((key, el) => {
  answerColours((choice) => {
    const k = repoKey(choice);
    applyPatches([{ path: ["fleet", "colours", k], value: { auto: state.fleet.colours[k]?.auto ?? "cobalt", chosen: choice.chosen } }]);
    return { status: 503, body: { error: { code: "store-down", message: "the server's store is not answering; try again in a moment" } } };
  });
  colour(key, null);
  openSheet(el, () => {
    tryPick("sunset");
    when(".cs-sheet .cs-use", (b) => b.click());
  });
});

/** the server refused the choice (a 400): nothing changed, the sheet stays open with the server's words */
export const SheetRefused = onShell((key, el) => {
  answerColours((choice) => ({ status: 400, body: { error: { code: "bad-request", message: `boxbox has no thread in ${choice.root} on ${choice.host}; a repo gets a colour once a thread works there` } } }));
  colour(key, null);
  openSheet(el, () => {
    tryPick("sunset");
    when(".cs-sheet .cs-use", (b) => b.click());
  });
});

/** the thread menu, open, with its colour item: the colour's dot, "cobalt · automatic" */
export const MenuColour = onShell((key, el) => { colour(key, null); el.querySelector<HTMLButtonElement>(".stage-bar .more")?.click(); });

/** the menu after a choice: "sunset · chosen" */
export const MenuColourChosen = onShell((key, el) => { colour(key, "sunset"); el.querySelector<HTMLButtonElement>(".stage-bar .more")?.click(); });

/** the repo line above the big title, the button that opens the sheet, at the top of the log on every size (the bar, once the
    title has scrolled away, holds the title and the status only). the stage alone with the thread's first turn, so the title
    block is in view, as the place line's stories show it */
export const RepoLine = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    takes();
    return mountStageAlone(el, { followed: true, shape: (fleet, thread, key) => ({ fleet: { ...fleet, colours: coloursFor(fleet, key, null) }, thread: { ...thread, messages: thread.messages.slice(0, 2) } }) });
  }, []);
  return createElement("div", { ref, className: "shell-story" });
};

/** settings' repo colours: every repo with its colour, a press opens the same sheet */
function onScreen(story: ShellStory, then: () => void): () => ReactElement {
  return () => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      takes();
      const stop = mountShell(el, story);
      let gone = false;
      void (async () => {
        while (!gone && !el.dataset["ready"]) await new Promise((r) => setTimeout(r, 50));
        if (!gone) then();
      })();
      return () => { gone = true; stop(); };
    }, []);
    return createElement("div", { ref, className: "shell-story" });
  };
}

const settingsColours = () => {
  const key = Object.keys(state.fleet.threads)[0];
  if (key) colour(key, "sunset");
};

export const SettingsColours = onScreen("settings", settingsColours);
