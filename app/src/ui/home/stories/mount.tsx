/* the solid side of the stories (ladle hosts are react, .ladle/config.mjs):
   each function renders into an element and returns the disposer. every
   state comes from the recorded journal (fixtures/journal.ndjson) played
   through the real reducer; the few facts the fleet model does not carry
   yet (a failure's reason, read state) are supplied as `Extra` and named
   as such in the story (docs/home.md, gaps). */

import { For } from "solid-js";
import { render } from "solid-js/web";
import { applyPatches, bootSync, setOpenThread, setStream, state, syncNeedsReload } from "../../../store";
import type { StreamStatus } from "../../../sync/messages";
import { type Extra, windowView } from "../../window/view";
import { type Arrangement, Window } from "../../window/window";
import journal from "../fixtures/journal.ndjson?raw";
import { endOf, keyOf, parseJournal, replay, TITLES } from "../fixtures/replay";
import { Home } from "../home";
import { INSPECTOR_KEY, RAIL_KEY } from "../remembered";
import { notesTranscript } from "../../thread/stories/transcript";
import { askWith, asking, fleetAsking, LONG_ASK, type Question, TWO_QUESTIONS } from "../../thread/stories/asks";
import { sweep } from "../../../motion/animate";
import "../../window/window.css";
import "../home.css";

/** a device that remembers nothing of the folds: every story that does not set them starts with both columns open */
const forgetful = { getItem: () => null, setItem: () => undefined };

const recorded = parseJournal(journal);
const final = replay(recorded);
const AT = endOf(recorded);

export type StateStory = keyof typeof TITLES | "failed" | "idle" | "review" | "wants-long" | "wants-two";

const SOURCES: Record<StateStory, { title: string; extra: Extra }> = {
  working: { title: TITLES.working, extra: {} },
  wants: { title: TITLES.wants, extra: {} },
  "wants-long": { title: TITLES.wants, extra: {} },
  "wants-two": { title: TITLES.wants, extra: {} },
  done: { title: TITLES.done, extra: {} },
  queued: { title: TITLES.queued, extra: {} },
  parked: { title: TITLES.parked, extra: {} },
  failed: { title: TITLES.done, extra: { failure: "the provider refused the request: the key has no credit left" } },
  idle: { title: TITLES.done, extra: { seen: true } },
  review: { title: TITLES.done, extra: { review: "the annual toggle is in and the table holds at 320 wide. tests pass.", seen: false } },
};

/** the questions a story's ask holds in place of the recorded "which greeting": a long one and a pair (thread/stories/asks.ts) */
const ASKS: Partial<Record<StateStory | HomeStory, Question[]>> = {
  "wants-long": LONG_ASK,
  "wants-two": TWO_QUESTIONS,
  "ask-long": LONG_ASK,
  "ask-two": TWO_QUESTIONS,
};

const ARRANGEMENTS: Arrangement[] = ["deck", "strip", "rail"];

/** one window state, as the deck, the strip and the rail each size it */
export function mountState(el: HTMLElement, story: StateStory): () => void {
  const { title, extra } = SOURCES[story];
  const key = keyOf(final.state, title);
  const entry = final.state.fleet.sessions[key];
  if (!entry) throw new Error(`no session for ${title}`);
  const questions = ASKS[story];
  const view = windowView(
    entry,
    Object.values(final.state.fleet.asks)
      .filter((a) => a.key === key)
      .map((a) => (questions ? askWith(a, questions) : a)),
    extra,
  );
  return render(
    () => (
      <div class="story-row" data-ready>
        <For each={ARRANGEMENTS}>
          {(arrangement) => (
            <figure class="story-frame" data-arrangement={arrangement}>
              <Window
                view={view}
                live={false}
                current={false}
                offline={false}
                showHost={false}
                now={AT}
                onOpen={() => undefined}
                onOpenAsk={() => undefined}
              />
              <figcaption>{arrangement}</figcaption>
            </figure>
          )}
        </For>
      </div>
    ),
    el,
  );
}

export type HomeStory = "live" | "ask-long" | "ask-two" | "offline" | "reload" | "long" | "stale" | "crowd" | "gone" | "empty" | "rail-folded" | "inspector-folded" | "both-folded" | "inspector-turns";

/** what each story's device remembers of the rail and the inspector (home.tsx, `memory`): its own, so no story leaks into the next */
const FOLDS: Partial<Record<HomeStory, Record<string, string>>> = {
  "rail-folded": { [RAIL_KEY]: "folded" },
  "inspector-folded": { [INSPECTOR_KEY]: "folded" },
  "both-folded": { [RAIL_KEY]: "folded", [INSPECTOR_KEY]: "folded" },
  "inspector-turns": { [INSPECTOR_KEY]: "turns" },
};

/** a repo name longer than a phone's bar has room for beside its pills, for the story that proves the bar's line wraps
    inside its own box and never runs under them */
const LONG_REPO = "boxbox-shell-scratch-checkout-with-a-long-name";

/** the recorded fleet with the asking thread's checkout renamed to `LONG_REPO`, so the bar reads "<long> wants you" */
function withLongRepo(fleet: typeof final.state.fleet): typeof final.state.fleet {
  const key = keyOf(final.state, TITLES.wants);
  const entry = fleet.sessions[key];
  if (!entry) throw new Error(`no session for ${TITLES.wants}`);
  const root = entry.info.projectID.replace(/\/[^/]*\/?$/, "");
  const info = { ...entry.info, projectID: `${root}/${LONG_REPO}`, directory: `${root}/${LONG_REPO}` };
  return { ...fleet, sessions: { ...fleet.sessions, [key]: { ...entry, info } } };
}

/** the recorded fleet with 22 more done threads and the asking one twice more: the bar's worst realistic line, "3 want you,
    ... 24 done" beside a two digit "clear 24", for the story that proves no pill wraps alone at any width */
function withCrowd(fleet: typeof final.state.fleet): typeof final.state.fleet {
  const sessions = { ...fleet.sessions };
  const asks = { ...fleet.asks };
  const order = [...fleet.order];
  const copy = (from: string, n: number, repo: string) => {
    const source = fleet.sessions[from];
    if (!source) throw new Error(`no session ${from}`);
    const id = `${source.id}_c${n}`;
    const key = `${source.host}:${id}`;
    const root = source.info.projectID.replace(/\/[^/]*\/?$/, "");
    const info = { ...source.info, id, projectID: `${root}/${repo}`, directory: `${root}/${repo}` };
    sessions[key] = { ...source, id, key, info };
    order.push(key);
    for (const ask of Object.values(fleet.asks).filter((a) => a.key === from)) asks[`${ask.id}_c${n}`] = { ...ask, id: `${ask.id}_c${n}`, key };
    return key;
  };
  const done = keyOf(final.state, TITLES.done);
  for (let n = 0; n < 22; n++) copy(done, n, `crowd-${n}`);
  const wants = keyOf(final.state, TITLES.wants);
  copy(wants, 100, "api");
  copy(wants, 101, "web");
  return { ...fleet, sessions, asks, order };
}

/** the first window leaves the fleet while it is the thread on the stage (archived at the daemon). `order()` trails the
    fleet by the calm, so for a moment its first key is a thread the fleet does not hold: home's own effects (pour the
    first window, let go of a thread that left) once chased each other for seconds. this lets the stage settle, takes the
    first thread out of the fleet the way the reducer does, and reports what home did about it on `window.__gone`: how many
    times it wrote the url, the longest task, the layers on the stage, and which thread the stage landed on */
function watchFirstLeave(): void {
  const longest: number[] = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longest.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // no long task timing here: the count of writes and the layers still hold the check
  }
  let writes = 0;
  const replace = history.replaceState.bind(history);
  history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    writes += 1;
    replace(...args);
  };
  // on the deck nothing is on the stage until a window is tapped: open the first one, as a person would
  const deck = !matchMedia("(min-width: 700px)").matches;
  if (deck) setTimeout(() => setOpenThread(state.fleet.order[0] ?? null), 800);
  setTimeout(() => {
    const first = state.openThread;
    if (!first) {
      (window as unknown as { __gone: unknown }).__gone = { error: "no thread was on the stage before the first one left" };
      return;
    }
    writes = 0;
    // a stream that has just come back has not replayed yet: home does not call the thread gone until it has caught up
    setStream({ state: "live", since: Date.now(), lastEventAt: Date.now() });
    applyPatches([
      { path: ["fleet", "sessions", first], value: undefined },
      { path: ["fleet", "order"], value: state.fleet.order.filter((key) => key !== first) },
    ]);
    let under = false;
    setTimeout(() => {
      // the windows are inert only under a layer that is drawn: never under nothing, while the stream catches up
      const inert = [...document.querySelectorAll(".home .bar, .home .wins, .home .home-dock")].some((el) => (el as HTMLElement).inert);
      under = inert && document.querySelector(".stage .layer") === null;
    }, 400);
    setTimeout(() => {
      history.replaceState = replace;
      (window as unknown as { __gone: unknown }).__gone = {
        left: first,
        landedOn: state.openThread,
        layers: document.querySelectorAll(".stage .layer").length,
        writes,
        longest: Math.max(0, ...longest),
        held: state.openThread !== null && state.fleet.sessions[state.openThread] !== undefined,
        under,
        deck,
      };
    }, 3000);
  }, 2500);
}

/** the whole of home, from the journal's last frame; the arrangement follows the story's width. at the ipad and mac
    widths home puts the window that wants you on the stage, so its transcript is held as the worker would hold it */
export function mountHome(el: HTMLElement, story: HomeStory): () => void {
  const stream: StreamStatus =
    story === "offline" ? { state: "down", since: Date.now() - 60_000, lastEventAt: AT } : { state: "live", since: Date.now() - 60_000, lastEventAt: AT };
  let dispose: (() => void) | undefined;
  let gone = false;
  void (async () => {
    const wants = keyOf(final.state, TITLES.wants);
    const asks = fleetAsking(final.state.fleet, ASKS[story]);
    const pending = Object.values(asks.asks).find((a) => a.key === wants);
    const transcript = await notesTranscript(wants);
    // the thread on the stage holds the question the window previews, running at its end, as the daemon holds it
    const threads = { [wants]: pending ? asking(transcript, pending) : transcript };
    if (gone) return;
    const fleet = story === "long" ? withLongRepo(asks) : story === "crowd" ? withCrowd(asks) : story === "empty" ? { ...asks, sessions: {}, asks: {}, order: [] } : asks;
    bootSync({ fleet, threads, drafts: {}, outbox: [], stream });
    if (story === "reload") syncNeedsReload();
    // a relaunch whose url names a thread the fleet does not hold: home must let it go, not sit inert under no layer
    if (story === "stale") setOpenThread("desk:ses_not_in_the_fleet");
    if (story === "gone") watchFirstLeave();
    const kept = { ...FOLDS[story] };
    const memory = { getItem: (key: string) => kept[key] ?? null, setItem: (key: string, value: string) => void (kept[key] = value) };
    dispose = render(
      () => (
        <div data-ready>
          <Home onMachines={() => undefined} onHistory={() => undefined} at={AT} measure={false} memory={memory} />
        </div>
      ),
      el,
    );
  })();
  return () => {
    gone = true;
    dispose?.();
  };
}

/** home as the journal happened: starts two thirds in and applies the rest in real time, patch by patch, as the
    worker would. not screenshotted; it is for looking at the motion */
export function mountReplay(el: HTMLElement): () => void {
  const start = Math.floor(recorded.length * 0.66);
  const early = replay(recorded, start);
  bootSync({ fleet: early.state.fleet, threads: {}, drafts: {}, outbox: [], stream: { state: "live", since: Date.now() - 60_000, lastEventAt: AT } });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stepMs = 16_000 / (recorded.length - start);
  for (let i = start; i < recorded.length; i++) {
    const patches = final.patches[i];
    if (patches) timers.push(setTimeout(() => applyPatches(patches), (i - start) * stepMs));
  }
  const dispose = render(
    () => (
      <div data-ready>
        <Home onMachines={() => undefined} onHistory={() => undefined} measure={false} memory={forgetful} />
      </div>
    ),
    el,
  );
  return () => {
    for (const timer of timers) clearTimeout(timer);
    dispose();
  };
}

/** the earned moments, played on cue against the recorded fleet, for looking at the motion and for the law check
    (only transform, opacity, clip-path and filter may animate). `window.boxboxMoments` plays them:
    - birth: the done thread leaves the fleet at boot and arrives on cue, born where the order puts it (second, in view at every width);
    - sweep: one sweep of light crosses the first window. */
export function mountMoments(el: HTMLElement): () => void {
  const parked = keyOf(final.state, TITLES.done);
  const { [parked]: held, ...rest } = final.state.fleet.sessions;
  bootSync({
    fleet: { ...final.state.fleet, sessions: rest, order: final.state.fleet.order.filter((k) => k !== parked) },
    threads: {},
    drafts: {},
    outbox: [],
    stream: { state: "live", since: Date.now() - 60_000, lastEventAt: AT },
  });
  const dispose = render(
    () => (
      <div data-ready>
        <Home onMachines={() => undefined} onHistory={() => undefined} at={AT} measure={false} memory={forgetful} />
      </div>
    ),
    el,
  );
  const moments = {
    birth: () => {
      if (!held) return;
      applyPatches([
        { path: ["fleet", "sessions", parked], value: held },
        { path: ["fleet", "order"], value: final.state.fleet.order },
      ]);
    },
    sweep: () => {
      const sheen = document.querySelector(".wins .win .sheen");
      if (sheen) sweep(sheen, true);
    },
  };
  (window as unknown as { boxboxMoments: typeof moments }).boxboxMoments = moments;
  return dispose;
}
