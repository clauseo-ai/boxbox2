/* the solid side of the shell's stories (ladle hosts are react,
   .ladle/config.mjs): the whole app as the shell composes it, at one route,
   over a store filled from recordings. the fleet is home's recorded journal
   (ui/home/fixtures), the open thread's transcript (and the stage's on
   home at the ipad and mac widths) is the native session the thread's
   stories read (ui/thread/fixtures/notes-asks.json, its last moment), and the machines, settings and the terminal answer from what a
   real boxbox said (./server.ts, ./fixtures). each route is shown at the
   width the story is opened at, so the screenshot test sees the phone, the
   ipad and the mac forms of every one. */

import { render } from "solid-js/web";
import { answerHistory, answerHosts, answerReview } from "./server";
import api from "./fixtures/api.json";
import { applyPatches, bootSync, FOCUS_FOR_MS, openFocus, refreshHosts, setOpenTerminal, setOpenThread, setScreen, setStream, setTerminalLink, state } from "../../store";
import type { HostStatus } from "../../api/client";
import type { ThreadView } from "../../sync/reducer";
import journal from "../../ui/home/fixtures/journal.ndjson?raw";
import { endOf, keyOf, parseJournal, replay, TITLES } from "../../ui/home/fixtures/replay";
import { merged, NOTE, review } from "../../ui/review/stories/fixtures";
import { AGENT_TITLE, askWith, asking, fleetAsking, LONG_ASK, TWO_QUESTIONS, withAgentSession, withAgentStep } from "../../ui/thread/stories/asks";
import { notesTranscript } from "../../ui/thread/stories/transcript";
import { ShellView } from "../shell";
import terminal from "./fixtures/terminal.json";

export type ShellStory = "home" | "thread" | "thread-ask-long" | "thread-ask-two" | "thread-ask-settles" | "thread-ask-under-agent" | "thread-ask-slow" | "thread-ask-cached" | "thread-ask-reset" | "thread-ask-unseen" | "thread-ask-gone" | "thread-review" | "thread-review-merged" | "thread-review-linked" | "thread-review-scrolled" | "machines" | "machines-many" | "settings" | "terminal" | "history" | "history-empty" | "history-unreached";

const recorded = parseJournal(journal);
const final = replay(recorded);
const AT = endOf(recorded);
/** the terminal the recording opened, on the host the journal names */
const TERMINAL = (terminal as unknown as { terminal: { host: string; id: string } }).terminal;
/** how long the terminal may take to load xterm and paint the recorded session before the story says it is ready */
const TERMINAL_PAINT_MS = 4000;

export function mountShell(el: HTMLElement, story: ShellStory): () => void {
  let dispose: (() => void) | undefined;
  let restore: (() => void) | undefined;
  let gone = false;
  void (async () => {
    const wants = keyOf(final.state, TITLES.wants);
    /* home at the ipad and mac widths puts the window that wants you on the stage beside the windows, so it reads the
       same transcript the thread story opens */
    // the thread asks what the window previews: the recorded greeting, or one of the two a real agent writes
    const questions = story === "thread-ask-two" ? TWO_QUESTIONS : story.startsWith("thread-ask") ? LONG_ASK : undefined;
    const recordedFleet = fleetAsking(final.state.fleet, questions);
    const recordedAsk = Object.values(recordedFleet.asks).find((a) => a.key === wants);
    /* the story that opens an ask from under its agent's thread starts without one: the thread has started an agent (a session of its
       own under it, and the step that names it), the person opens the agent's thread over the parent's, and the ask arrives then. the
       story of an ask answered elsewhere starts without it too, with a focus that names it */
    const started = story === "thread-ask-under-agent" ? withAgentSession(recordedFleet, wants) : null;
    const without = story === "thread-ask-under-agent" || story === "thread-ask-gone" || story === "thread-ask-reset";
    const asks = { ...(started?.fleet ?? recordedFleet), ...(without ? { asks: {} } : {}) };
    const pending = without ? undefined : recordedAsk;
    const transcript = story.startsWith("thread") || story === "home" ? await notesTranscript(wants) : null;
    /* the review stories read a thread that holds no question: their stage is about where the review lands; so do the stories of an ask
       the thread never shows (the daemon raised it, its step has not come) and of one that is gone */
    const bare = story.startsWith("thread-review") || story === "thread-ask-unseen" || story === "thread-ask-gone";
    const threads: Record<string, ThreadView> = {};
    /* the cache's thread of a cold launch: its rows, from before the ask, while the fetch behind them is still to land. the thread
       of a reconnect already holds the question's step, in the turn that is running (its newest row opens by itself when its ask is
       raised): the fleet's ask comes with the replay */
    if (transcript && story !== "thread-ask-slow") {
      threads[wants] =
        story === "thread-ask-cached" ? { ...transcript, status: "hydrating" }
        : bare ? transcript
        : pending ? asking(transcript, pending)
        : story === "thread-ask-reset" && recordedAsk ? asking(transcript, recordedAsk, true)
        : story === "thread-ask-under-agent" ? withAgentStep(transcript)
        : transcript;
    }
    if (started) threads[started.key] = await notesTranscript(started.key);
    /* the parent's ask, as it arrives while the agent's thread is on top: the daemon's ask, and the question step it waits on */
    const raiseAsk = () => {
      const held = state.threads[wants];
      if (!recordedAsk || !held) return;
      applyPatches([
        { path: ["fleet", "asks", `${recordedAsk.host}:${recordedAsk.id}`], value: recordedAsk },
        { path: ["threads", wants, "messages"], value: asking(held, recordedAsk).messages },
      ]);
    };
    /* the thread of a slow start, or the fetch behind a cache: the stage opened on it, with the focus a push left, and the worker has not
       brought it yet (or has brought only what it cached before the ask) */
    const loadThread = () => {
      if (transcript && pending) applyPatches([{ path: ["threads", wants], value: asking(transcript, pending) }]);
    };
    /* the stream reconnects while the person taps a push: it is live at the hello, with the replay that brings the fleet's asks still
       to come, and the focus names the ask; then the replay brings it */
    const reconnect = () => {
      setStream({ state: "live", since: Date.now(), lastEventAt: AT });
      if (recordedAsk) openFocus({ thread: wants, ask: recordedAsk.id, push: null });
    };
    const replay = () => {
      if (recordedAsk) applyPatches([{ path: ["fleet", "asks", `${recordedAsk.host}:${recordedAsk.id}`], value: recordedAsk }]);
    };
    if (story === "machines-many") answerHosts({ hosts: () => ({ status: 200, body: severalHosts() }), alias: { studio: RECORDED_HOST.name } });
    bootSync({ fleet: asks, threads, drafts: {}, outbox: [], stream: { state: "live", since: Date.now() - 60_000, lastEventAt: AT } });
    // the gate opens on the recorded host list
    await refreshHosts();
    if (story.startsWith("thread")) setOpenThread(wants);
    // a tap on a window's "answer" pill: the thread opens with its ask in front and its card focused
    const named = pending ?? (story === "thread-ask-gone" ? recordedAsk : undefined);
    if (story.startsWith("thread-ask") && named) openFocus({ thread: wants, ask: named.id, push: null });
    if (story.startsWith("thread-review")) {
      answerReview((method, tail) => (method === "GET" ? { status: 200, body: review } : tail === "/merge" ? { status: 200, body: merged } : undefined));
      // a reader who is scrolled up has the review arrive: it comes after the stage is up and read
      if (story !== "thread-review-scrolled") raiseReview(wants);
    }
    if (story === "thread-review-linked") {
      // a link in names the oldest turn (`&at=`): the stage lands there, and the review is far below it
      const first = threads[wants]?.messages.find((m) => m.info.role === "user")?.info.id;
      const was = location.href;
      const url = new URL(was);
      // the stage takes a place from the url only when the url names its thread too (stage.tsx, placeHere)
      url.searchParams.set("thread", wants);
      if (first) url.searchParams.set("at", first);
      history.replaceState(null, "", url);
      restore = () => history.replaceState(null, "", was);
    }
    if (story === "machines" || story === "machines-many" || story === "settings") setScreen(story === "settings" ? "settings" : "machines");
    if (story.startsWith("history")) {
      setScreen("history");
      answerHistory(historyFor(story));
    }
    if (story === "terminal") {
      setScreen("machines");
      setTerminalLink("connecting");
      setOpenTerminal(TERMINAL);
    }
    if (gone) return;
    dispose = render(() => <ShellView at={AT} measure={false} />, el);
    // a story that did not show what it is for is never ready, and the screenshot test fails it
    const ok = await settled(el, story, { review: () => raiseReview(wants), ask: raiseAsk, thread: loadThread, reconnect, replay });
    if (!gone && ok) el.dataset.ready = "1";
  })();
  return () => {
    gone = true;
    restore?.();
    answerHistory(undefined);
    answerHosts(undefined);
    answerReview(undefined);
    dispose?.();
  };
}

/** the host the recording read, connected */
const RECORDED_HOST = (api as unknown as { "GET /api/hosts": { body: HostStatus[] } })["GET /api/hosts"].body[0] as HostStatus;

/** a person with four machines, each in another state: the recorded one; a paired one, up for days and busier; one that
    stopped answering three hours ago, holding what it last said; and one never reached yet. the names are placeholders */
function severalHosts(): HostStatus[] {
  const now = Date.now();
  const recorded = RECORDED_HOST;
  const sample = (rss: number, liveSessions: number, uptimeS: number, sampledAt = now) => ({ rss, liveSessions, uptimeS, sampledAt });
  return [
    recorded,
    {
      ...recorded,
      name: "studio",
      url: "http://studio:4096/",
      origin: "paired",
      frames: { decoded: 18_402, undecodable: 0, duplicates: 0 },
      memory: sample(298_844_160, 2, 9 * 86_400 + 3_600),
    },
    {
      ...recorded,
      name: "attic",
      url: "http://attic:4096/",
      connection: "down",
      since: now - 3 * 3_600_000,
      lastError: "cannot connect (connection refused)",
      frames: { decoded: 1_204, undecodable: 2, duplicates: 0 },
      memory: sample(100_663_296, 0, 4 * 86_400, now - 3 * 3_600_000),
    },
    {
      ...recorded,
      name: "loft",
      url: "http://loft:4096/",
      connection: "connecting",
      since: now - 4_000,
      health: null,
      lastError: null,
      connects: 0,
      frames: { decoded: 0, undecodable: 0, duplicates: 0 },
      memory: null,
    },
  ];
}

/** an agent in a checkout has asked for review: the need the server raises */
function raiseReview(key: string): void {
  const need = { id: "review:desk:checkout", key, kind: "review", rank: 3, raisedAt: AT, title: "pricing is ready to merge", body: NOTE, checkout: "site-fix" };
  applyPatches([{ path: ["fleet", "sessions", key, "needs"], value: [need] }]);
}

/** what the history route answers in each history story: every session of the recorded fleet, newest first and
    cleared one of them, an empty fleet, or a machine that did not answer */
function historyFor(story: ShellStory): (query: URLSearchParams) => { status: number; body: unknown } {
  const entries = Object.values(final.state.fleet.sessions).sort((a, b) => b.info.time.updated - a.info.time.updated);
  const rows = entries.map((entry, i) => ({ key: entry.key, host: entry.host, info: entry.info, cleared: i === 2 }));
  return (query) => {
    if (story === "history-empty") return { status: 200, body: { rows: [], unreached: [] } };
    const term = (query.get("q") ?? "").toLowerCase();
    const shown = rows.filter((row) => !term || row.info.title.toLowerCase().includes(term));
    const unreached = story === "history-unreached" ? [{ host: "desk-2", reason: "cannot connect (connection refused)" }] : [];
    return { status: 200, body: { rows: shown, unreached } };
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `count` animation frames later, or 600 ms at most (a tab that is not painting gives none) */
const frames = (count: number) =>
  new Promise<void>((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
    setTimeout(resolve, 600);
  });

/** waits for `found` to be true, for at most `ms`; says whether it was */
async function until(found: () => boolean, ms = TERMINAL_PAINT_MS): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end && !found()) await pause(100);
  return found();
}

/** whether the review's card (its slot) shows at least a fifth of itself in the stage's scroller, as the stage's own watch reads it */
function reviewInView(el: HTMLElement): boolean {
  const slot = el.querySelector(".review-slot")?.getBoundingClientRect();
  const scroller = el.querySelector(".stage-scroll")?.getBoundingClientRect();
  if (!slot || !scroller) return false;
  const shown = Math.min(slot.bottom, scroller.bottom) - Math.max(slot.top, scroller.top);
  return shown >= Math.max(1, slot.height * 0.2) || (slot.height === 0 && shown >= 0);
}

/** a story is ready once what it shows has painted, and, for the review's, once it shows what it is for. false is a story
    that did not: it is never ready, and the screenshot test fails it */
async function settled(el: HTMLElement, story: ShellStory, hooks: { review: () => void; ask: () => void; thread: () => void; reconnect: () => void; replay: () => void }): Promise<boolean> {
  /* a story that is never ready says why on its element, for whoever opens it */
  const fail = (why: string): false => { el.dataset.why = why; return false; };
  if (story.startsWith("thread-review")) {
    // the review is a chunk loaded when a review waits: ready once its card has read the checkout and painted
    if (story === "thread-review-scrolled") {
      // the reader scrolls up before the review arrives: nothing moves for it, and the line carries it
      const scroller = el.querySelector<HTMLElement>(".stage-scroll");
      // the stage lands at the end of the thread when it opens; the reader scrolls up from there
      const landed = () => !!scroller && scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;
      if (!scroller || !(await until(landed))) return fail("the stage never landed at the end of a thread longer than its view");
      // as a reader does: a while after it opened, with a hand on the wheel. a jump to the very top straight after the stage's first
      // writes is where the view was left from, and the pin puts the end back for it (pin.ts, a restore)
      await pause(1600);
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scroller.scrollTop = 0;
      await pause(300);
      hooks.review();
      if (!(await until(() => !!el.querySelector(".review-merge")))) return fail("the card never came");
      await pause(500);
      if (scroller.scrollTop !== 0) return fail("the stage scrolled when the review arrived");
    } else if (!(await until(() => !!el.querySelector(".review-merge")))) return fail("the card never came");
    await pause(400);
    // the line is above the composer exactly while the card is out of view, never both, never neither
    const lineShown = () => !!el.querySelector('.pinned[data-kind="review"]');
    // the stage's watch reports a frame or two after the view settles: it is given that long, not longer
    if (!(await until(() => lineShown() !== reviewInView(el), 2000))) return fail(lineShown() ? "the line shows with the card in view" : "the card is out of view and the line is missing");
    const line = lineShown();
    // a phone is the case the line is for: the card is below the view in every thread that is longer than the screen
    if ((story === "thread-review-linked" || story === "thread-review-scrolled") && el.clientWidth < 500 && !line) return fail("no line on a phone");
    if (story === "thread-review-merged") {
      el.querySelector<HTMLButtonElement>(".review-merge")?.click();
      if (!(await until(() => !!el.querySelector(".review-folded")))) return fail("the card never folded");
      await pause(800);
    }
    return true;
  }
  if (story === "thread-ask-under-agent") return askUnderAgent(el, hooks.ask, fail);
  if (story === "thread-ask-slow" || story === "thread-ask-cached") {
    /* the thread takes longer to come than a focus would wait if it waited from the moment it was set: the wait is the stage's, from the
       moment it has its thread, and a thread a cache has drawn is not yet that (the cache predates the ask; its fetch is still out) */
    await pause(FOCUS_FOR_MS + 1500);
    if (state.focus === null) return fail(story === "thread-ask-slow" ? "the focus was let go before the stage had its thread" : "the focus was let go while the thread's fetch was out, on the strength of what its cache held");
    hooks.thread();
    return askLanded(el, story, fail);
  }
  if (story === "thread-ask-reset") {
    // the person taps a push as the stream reconnects: the fleet does not hold the ask yet, and is not known to have let go of it until the replay has landed
    if (!(await until(() => topLayer(el)?.querySelector(".row") != null, 6000))) return fail("the stage never drew its thread");
    hooks.reconnect();
    // the stage looks for the ask in its next frames, with the fleet still without it; the replay comes after they have run
    await frames(3);
    hooks.replay();
    return askLanded(el, story, fail);
  }
  if (story === "thread-ask-unseen" || story === "thread-ask-gone") return focusLetGo(el, story, fail);
  if (story.startsWith("thread-ask")) return askLanded(el, story, fail);
  if (story.startsWith("history")) return until(() => !!el.querySelector(".history-list, .history .empty:not(:empty)")).then(() => true);
  if (story !== "terminal") return true;
  await until(() => !!el.querySelector(".xterm-rows")?.textContent?.trim());
  return true;
}


/** the thread on top of the stage: the layer a thread opened last draws in */
const topLayer = (el: HTMLElement): HTMLElement | null => [...el.querySelectorAll<HTMLElement>(".stage .layer")].at(-1) ?? null;

/** the ask a window's "answer" pill sent the stage to, read as a person would: the card holds focus, and is the card it was a
    clock's tick later (a running row's body is handed over every second, and a card built again with it lost its choices, its typed
    words and its focus: docs/gotchas.md); one ring is drawn round the ask, on its row and not on the card, with no lit box besides;
    the row's top sits under the bar's fade and not under the bar (or lower, where the end of the thread stops it); and, in the
    story that settles it, the one card built for the pending ask keeps the words typed into it and goes on to its answered state */
async function askLanded(el: HTMLElement, story: ShellStory, fail: (why: string) => false): Promise<boolean> {
  const layer = () => topLayer(el) ?? el;
  const card = () => layer().querySelector<HTMLElement>(".row.ask.running .ask-card");
  if (!(await until(() => card() !== null && document.activeElement === card(), 6000))) return fail("the ask's card never took focus");
  const was = card() as HTMLElement;
  // a tick of the clock, past the move to the ask: the cause comes before what it breaks
  await pause(1300);
  if (!was.isConnected || card() !== was || document.activeElement !== was) return fail("the card that took focus was built again, or lost its focus, when the running row's body was handed over");
  const scroller = layer().querySelector<HTMLElement>(".stage-scroll");
  const bar = layer().querySelector(".stage-bar");
  const row = was.closest<HTMLElement>(".row");
  if (!row || !scroller || !bar) return fail("the stage has no ask row, scroller or bar");
  // the move to the ask is a smooth scroll: the row is read where it has come to rest
  for (let last = -1; last !== scroller.scrollTop; await pause(120)) last = scroller.scrollTop;
  const under = row.getBoundingClientRect().top - bar.getBoundingClientRect().bottom;
  const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2;
  // the bar's fade is whole 36 px below its foot: a row lands there, or lower where the end stops it
  if (under < 34 || (under > 38 && !atEnd)) return fail(`the ask's row top is ${Math.round(under)} px under the bar's foot (36 expected, or lower at the end)`);
  const ring = (box: Element) => getComputedStyle(box).outlineStyle !== "none";
  if (!ring(row) || ring(was) || layer().querySelector(".row.lit")) return fail("the ask is not one ringed object: the ring is on the row, not the card, and no lit box besides");
  if (story !== "thread-ask-settles") return true;
  const input = was.querySelector<HTMLInputElement>("input.ask-input");
  if (!input) return fail("the card has no field to type in");
  input.focus();
  input.value = "in my own words";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // two ticks later the card is the same card with the same words
  await pause(2300);
  if (!was.isConnected || was.querySelector("input.ask-input") !== input || input.value !== "in my own words" || document.activeElement !== input) return fail("the card was built again while it asked: its typed words or focus were lost");
  settleAsk();
  if (!(await until(() => !layer().querySelector(".row.ask.running")))) return fail("the ask never settled");
  // a settled question keeps its record in the card: what was answered, and when (ui/asks/card.tsx)
  const after = was.querySelector(".ask-rec-lead");
  if (!was.isConnected || !after || !/you answered/.test(after.textContent ?? "") || was.querySelector("button.ask-opt")) return fail("the card that asked did not go on to say it was answered");
  return true;
}

/** a focus the stage cannot take to its ask, and what it does about it (ui/thread/stage.tsx, goToAsk): the stage does not go anywhere, and
    lets the focus go rather than leave it to send the stage somewhere at its next turn. an ask answered elsewhere (gone from the fleet's
    asks) is let go as soon as the thread is read; one the fleet holds and the thread does not show yet is waited for, from the moment
    the stage has its thread, and let go when the wait is over (store.ts, FOCUS_FOR_MS) */
async function focusLetGo(el: HTMLElement, story: ShellStory, fail: (why: string) => false): Promise<boolean> {
  const loaded = () => topLayer(el)?.querySelector(".row") != null;
  if (!(await until(loaded, 6000))) return fail("the stage never drew its thread");
  if (story === "thread-ask-gone") {
    if (!(await until(() => state.focus === null, 2000))) return fail("a focus for an ask that is no longer pending was not let go once the thread was read");
    return true;
  }
  await pause(1200);
  if (state.focus === null) return fail("the focus for an ask the thread had not shown yet was let go before the wait was over");
  if (!(await until(() => state.focus === null, FOCUS_FOR_MS + 2500))) return fail("the focus for an ask that never came was never let go");
  return true;
}

/** the parent's ask, opened from under its agent's thread: the person opens the agent's thread over the parent's, the parent asks, and
    the way back to it (its window's pill in the strip and the rail, the capsule on the deck) pours the parent's thread again on top of
    the stack. that layer is the parent's thread twice over, with the agent's layer still leaving over the first: it must not be
    counted as covered, or it takes no input and the ask's card never takes focus (home/layers.ts) */
async function askUnderAgent(el: HTMLElement, raiseAsk: () => void, fail: (why: string) => false): Promise<boolean> {
  const layers = () => [...el.querySelectorAll<HTMLElement>(".stage .layer")];
  const click = (button: Element | null | undefined) => (button as HTMLElement | null | undefined)?.click();
  const row = () => topLayer(el)?.querySelector(".row.agent > button.row-h");
  // a settled run folds whole: the step that started the agent is under its group's head, opened as a person would
  const group = () => [...(topLayer(el)?.querySelectorAll<HTMLElement>(".row.group:not(.open) > button.row-h") ?? [])].find((h) => h.getAttribute("aria-label")?.includes("started"));
  if (!(await until(() => row() != null || group() !== undefined, 8000))) return fail("the parent's thread shows no row for the agent it started");
  if (row() == null) click(group());
  if (!(await until(() => row() != null, 4000))) return fail("the parent's thread shows no row for the agent it started");
  // an opened group opens its newest row with it: the agent's row is pressed only when it is still shut
  await pause(300);
  if (row()?.getAttribute("aria-expanded") !== "true") click(row());
  if (!(await until(() => !!topLayer(el)?.querySelector(".agent-door"), 6000))) return fail("the agent's row has no door to its thread");
  click(topLayer(el)?.querySelector(".agent-door"));
  if (!(await until(() => layers().length > 1 && topLayer(el)?.getAttribute("aria-label") === `thread: ${AGENT_TITLE}`, 6000))) return fail("the agent's thread never opened over its parent's");
  // the agent's thread has come in; now the parent asks
  await pause(900);
  raiseAsk();
  const deck = el.querySelector(".home[data-arrangement=deck]") !== null;
  // on the deck the capsule is the way back; elsewhere the parent's window's tray opens the answer sheet, whose foot opens the thread
  const way = () => el.querySelector<HTMLElement>(deck ? ".capsule" : ".win .wask");
  if (!(await until(() => way() !== null, 6000))) return fail(deck ? "no capsule came for the parent's ask" : "the parent's window has no tray for its ask");
  click(way());
  if (!deck) {
    const foot = () => el.querySelector<HTMLElement>(".asks-open");
    if (!(await until(() => foot() !== null, 6000))) return fail("the parent's tray opened no answer sheet with a way to its thread");
    click(foot());
  }
  if (!(await until(() => topLayer(el)?.getAttribute("aria-label") === "thread: set the greeting in the notes", 6000))) return fail("the parent's thread never came back on top");
  return askLanded(el, "thread-ask-under-agent", fail);
}

/** the daemon's side of an answer from another device: the ask leaves the fleet's list and the question step completes */
function settleAsk(): void {
  const ask = Object.values(state.fleet.asks)[0];
  if (!ask) return;
  const key = ask.key;
  const messages = state.threads[key]?.messages ?? [];
  const at = messages.length - 1;
  const part = messages[at]?.parts[0] as { state?: { input?: unknown; time?: { start?: number } } } | undefined;
  const start = part?.state?.time?.start ?? Date.now();
  applyPatches([
    { path: ["threads", key, "messages", at, "parts", 0, "state"], value: { status: "completed", input: part?.state?.input ?? {}, output: "", metadata: { answers: [["in my own words"]] }, time: { start, end: start + 1000 } } },
    { path: ["fleet", "asks", `${ask.host}:${ask.id}`], value: undefined },
  ]);
}
