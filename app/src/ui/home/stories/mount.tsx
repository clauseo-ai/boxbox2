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
import { FOCUS_KEY, INSPECTOR_KEY, STRIP_KEY } from "../remembered";
import { heavyTranscripts, notesTranscript } from "../../thread/stories/transcript";
import { askWith, asking, fleetAsking, LONG_ASK, type Question, TWO_QUESTIONS } from "../../thread/stories/asks";
import { sweep } from "../../../motion/animate";
import { NewThreadDock } from "../../composer/dock";
import { colourStyle } from "../../window/repo";
import { RepoMark } from "../../repo-mark/repo-mark";
import "../../window/window.css";
import "../home.css";
import "../fold.css";

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
  "answer-two": TWO_QUESTIONS,
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
    {},
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

export type HomeStory = "live" | "stray" | "answer" | "answer-two" | "ask-long" | "ask-two" | "offline" | "reload" | "long" | "stale" | "crowd" | "gone" | "empty" | "windows-hidden" | "inspector-folded" | "hidden-inspector-folded" | "inspector-turns" | "strip-folded" | "details" | "heavy";

/** what each story's device remembers of the rail and the inspector (home.tsx, `memory`): its own, so no story leaks into the next */
const FOLDS: Partial<Record<HomeStory, Record<string, string>>> = {
  "windows-hidden": { [FOCUS_KEY]: "hidden" },
  "inspector-folded": { [INSPECTOR_KEY]: "folded" },
  "hidden-inspector-folded": { [FOCUS_KEY]: "hidden", [INSPECTOR_KEY]: "folded" },
  "inspector-turns": { [INSPECTOR_KEY]: "turns" },
  "strip-folded": { [STRIP_KEY]: "folded" },
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

/** the spawn-only agent the stray story's thread starts: the fleet never holds its session */
export const STRAY = { id: "ses_stray_scout", name: "notes_scout" };

/** the thread with one more turn at its end: a spawn whose child session is `STRAY`, as the daemon writes it */
function withStrayAgent(thread: Awaited<ReturnType<typeof notesTranscript>>): Awaited<ReturnType<typeof notesTranscript>> {
  const last = [...thread.messages].reverse().find((m) => m.info.role === "assistant");
  if (!last) return thread;
  const at = AT - 30_000;
  const sessionID = last.info.sessionID;
  const info = { ...last.info, id: "m_stray", time: { created: at, completed: at + 900 } } as typeof last.info;
  const part = {
    id: "p_stray", sessionID, messageID: "m_stray", type: "tool", callID: "p_stray", tool: "spawn",
    state: { status: "completed", input: { brief: "read the notes and say which greeting they use" }, output: "", metadata: { agents: [{ id: STRAY.id, name: STRAY.name, seat: "scout" }], child_session_id: STRAY.id }, time: { start: at, end: at + 900 } },
  } as unknown as (typeof last.parts)[number];
  return { ...thread, messages: [...thread.messages, { info, parts: [part] }] };
}

/** opens the asking thread (the deck has nothing on the stage until a window is tapped), then the spawn's row and its door, as
    a person would; ready once the agent's layer is up */
function openStray(el: HTMLElement, wants: string): void {
  if (!matchMedia("(min-width: 700px)").matches) setTimeout(() => setOpenThread(wants), 300);
  const press = (selector: string) => document.querySelector<HTMLButtonElement>(selector)?.click();
  setTimeout(() => press('.stage .row[data-part="p_stray"] .row-h, .stage .row[data-part="p_stray"] button'), 1500);
  setTimeout(() => press(".stage .agent-door"), 2100);
  setTimeout(() => el.querySelector("div")?.setAttribute("data-ready", ""), 3200);
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
    const recorded = await notesTranscript(wants);
    // the stray story: the asking thread started an agent whose session the fleet does not hold (a spawn-only agent)
    const transcript = story === "stray" ? withStrayAgent(recorded) : recorded;
    // the thread on the stage holds the question the window previews, running at its end, as the daemon holds it
    // the heavy story: every other window holds a long imported session, for timing the pour into a thread already read
    const others = story === "heavy" ? await heavyTranscripts(asks.order.filter((key) => key !== wants)) : {};
    const threads = { ...others, [wants]: pending ? asking(transcript, pending) : transcript };
    if (gone) return;
    const fleet = story === "long" ? withLongRepo(asks) : story === "crowd" ? withCrowd(asks) : story === "empty" ? { ...asks, sessions: {}, asks: {}, order: [] } : asks;
    bootSync({ fleet, threads, drafts: {}, outbox: [], stream });
    if (story === "reload") syncNeedsReload();
    // a relaunch whose url names a thread the fleet does not hold: home must let it go, not sit inert under no layer
    if (story === "stale") setOpenThread("desk:ses_not_in_the_fleet");
    if (story === "gone") watchFirstLeave();
    const kept = { ...FOLDS[story] };
    const memory = { getItem: (key: string) => kept[key] ?? null, setItem: (key: string, value: string) => void (kept[key] = value) };
    // the answer sheet's stories press the asking window's tray, as a person would, and are ready once it is up
    const answering = story === "answer" || story === "answer-two";
    // the details' story asks for them from the stage's bar, as a person would: docked beside the folded rail on a landscape
    // ipad, a sheet on a portrait one, the inspector already showing them at the mac's width
    const detailing = story === "details";
    dispose = render(
      () => (
        <div data-ready={answering || detailing || story === "stray" ? undefined : ""}>
          <Home onMachines={() => undefined} onHistory={() => undefined} at={AT} measure={false} memory={memory} />
        </div>
      ),
      el,
    );
    if (story === "stray") openStray(el, wants);
    if (detailing) {
      setTimeout(() => el.querySelector<HTMLButtonElement>(".stage-bar .details-toggle[aria-expanded=false]")?.click(), 700);
      setTimeout(() => el.querySelector("div")?.setAttribute("data-ready", ""), 1600);
    }
    if (answering) {
      setTimeout(() => el.querySelector<HTMLButtonElement>(".win .wask")?.click(), 700);
      setTimeout(() => el.querySelector("div")?.setAttribute("data-ready", ""), 1400);
    }
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

/** home's liquid glass controls (styles.css, `.lg`; docs/home.md, the bar) laid over live windows so the glass has
    something to bend: the bar's pills and rounds, the clear pill, the fold's new-thread disc, the capsule and the dock.
    the second panel is the same controls on the solid material that reduced transparency (or a browser without
    backdrop-filter) gives them, forced by the tokens on the panel, since a story cannot set the system's preference; it is
    a picture to compare, so it is inert and its controls do not repeat the first panel's names */
export function mountGlass(el: HTMLElement): () => void {
  const views = (["working", "wants", "done"] as const).map((story) => {
    const key = keyOf(final.state, SOURCES[story].title);
    const entry = final.state.fleet.sessions[key];
    if (!entry) throw new Error(`no session for ${story}`);
    return windowView(entry, Object.values(final.state.fleet.asks).filter((a) => a.key === key), {}, SOURCES[story].extra);
  });
  const asking = views[1];
  if (!asking) throw new Error("no asking window");
  const panel = (solid: boolean) => (
    <figure class="glass-panel" data-solid={solid ? "" : undefined}>
      <div class="glass-ground" data-arrangement="rail" aria-hidden="true" inert>
        <For each={views}>
          {(view) => <Window view={view} live={false} current={false} offline={false} showHost={false} now={AT} onOpen={() => undefined} onOpenAsk={() => undefined} />}
        </For>
      </div>
      <div class="glass-over" aria-hidden={solid ? "true" : undefined} inert={solid}>
        <button
          class="capsule"
          type="button"
          style={{ "--c1": asking.colour.top, "--c2": asking.colour.bottom, "--hi": asking.colour.light }}
          aria-label={`open ${asking.repo}, it wants you`}
        >
          <RepoMark host={asking.host} root={asking.root} name={asking.repo} colour={asking.colour} size={34} />
          <span>
            <b>{asking.repo}</b> wants you: which greeting
          </span>
          <em>open</em>
        </button>
        <div class="pills">
          <button class="pill new" type="button" aria-label="new thread">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            <span class="new-word" aria-hidden="true">new thread</span>
          </button>
          <button class="pill" type="button" aria-label="clear 3">clear 3</button>
          <button class="pill" type="button" aria-label="history">history</button>
          <button class="pill icon" type="button" aria-label="machines">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4.5" width="16" height="6.5" rx="2.2" />
              <rect x="4" y="13" width="16" height="6.5" rx="2.2" />
              <path d="M8 7.75h.01M8 16.25h.01" />
            </svg>
          </button>
          <button class="fold-new" type="button" aria-label="new thread disc">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <div class="glass-dock" style={colourStyle(asking.colour)}>
          <NewThreadDock host={asking.host} directory={asking.root} showHost={false} onOpen={() => undefined} />
        </div>
      </div>
      <figcaption>{solid ? "solid: reduced transparency, or no backdrop-filter" : "liquid glass"}</figcaption>
    </figure>
  );
  return render(
    () => (
      <div class="home story-glass" data-ready>
        {panel(false)}
        {panel(true)}
      </div>
    ),
    el,
  );
}
