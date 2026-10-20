/* one live window (docs/design.md, anatomy of a window): the repo and the
   chip, the title, the live tail, a preview of the ask when there is one,
   and the footer. it renders a `WindowView` and nothing else; home decides
   the order, which windows are live and what opening one does.

   the window never holds an ask's card and never grows for one. a window
   that wants you wears a tray of its accent (the native app's decision 24):
   what the thread needs in one line, from every pending ask (need.ts), and
   the whole tray is the key that opens the answer sheet over home
   (asks/sheet.tsx), where every pending ask is answered in place. its edge
   is lit while it waits, and when it starts waiting in front of you one ring
   leaves its edge, once.

   the window is an article with one stretched button (the title) that
   opens it, so the tray can be a real button of its own; a button inside a
   button is neither valid nor reachable. */

import { shortWords } from "../asks/words";
import { warmOn } from "../later";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { play, prefersReducedMotion, sweep } from "../../motion/animate";
import { PING, PING_SCALE, SNAP, TICK_DRAW } from "../../motion/springs";
import { clearNotice, clearSuffix, clearThreads, dismissClearNotice, openSuffix } from "./clear";
import { clearable, clearName } from "./clearing";
import { LiveText } from "./live-text";
import { RepoMark } from "../repo-mark/repo-mark";
import { StripLane } from "../thread/strip";
import { colourStyle } from "./repo";
import type { TailLine } from "./tail";
import { footClock, parkedOn, type WindowView, windowName } from "./view";
import { BoardKey, boardWords } from "../../board/lazy";
import { state } from "../../store";

export type Arrangement = "deck" | "strip" | "rail";

export type WindowProps = {
  view: WindowView;
  /** motion is allowed: the window is in view, the stream is live and caught up, nothing is replaying */
  live: boolean;
  /** on stage beside the rail or under the strip */
  current: boolean;
  /** the stream has been down past its grace: clocks and tails hold still */
  offline: boolean;
  /** name the host beside the repo: more than one host is connected */
  showHost: boolean;
  /** the clock, ticking once a second while anything counts */
  now: number;
  onOpen: (el: HTMLElement, event: Event) => void;
  /** the tray of a window that wants you: opens the answer sheet with every pending ask (home.tsx) */
  onOpenAsk: (el: HTMLElement, event: Event) => void;
  ref?: (el: HTMLElement) => void;
};

/** a command that runs tests: its green finish is an earned moment */
const TEST_COMMAND = /\b(test|tests|spec|vitest|jest|pytest)\b/;

/** the attention ring leaves the window's edge to 6% past it (the native app's WindowNeedsYouPing) */
const NEED_PING_SCALE = 1.06;

const TICK = (
  <svg class="tick" viewBox="0 0 22 22" aria-hidden="true">
    <path d="M4 11.5l4.5 4.5L18 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export function Window(props: WindowProps) {
  let root!: HTMLElement;
  let chip: HTMLSpanElement | undefined;
  let sheen!: HTMLDivElement;
  let askBox: HTMLElement | undefined;
  // lines that mount with the window paint in place; only lines that arrive afterwards may move
  const [ready, setReady] = createSignal(false);
  onMount(() => requestAnimationFrame(() => setReady(true)));
  const live = () => ready() && props.live && !props.offline;

  // the earned moment: a test command that finished green in front of you, once
  const [earned, setEarned] = createSignal<string | null>(null);
  const lastRun = createMemo(() => {
    const runs = props.view.tail.filter((l): l is Extract<TailLine, { kind: "tool" }> => l.kind === "tool" && l.verb === "run");
    return runs[runs.length - 1] ?? null;
  });
  createEffect(
    on(
      () => {
        const run = lastRun();
        return run ? `${run.id}:${run.status}` : "";
      },
      (now, before) => {
        const run = lastRun();
        if (!run || !before || !live()) return;
        const [id, was] = before.split(":");
        if (id === run.id && was === "running" && run.status === "done" && TEST_COMMAND.test(run.object)) {
          setEarned("tests passed");
          sweep(sheen, true);
          // the tick draws itself left to right, by clip, once the chip holds it
          requestAnimationFrame(() => {
            const tick = chip?.querySelector("svg");
            if (tick) play(tick, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], TICK_DRAW, { delay: TICK_DRAW.delay, fill: "backwards" });
          });
        }
      },
    ),
  );
  // the earned chip lasts until the state changes, not until the next view (a tail line, a clock): `on` runs on every
  // notification of what it reads, so the state goes through a memo that notifies only when it differs
  const viewState = createMemo(() => props.view.state);
  /* a memo, so the name is set when it changes: the binding alone set it again on every new view of this window and on every
     order or title change across the fleet (the suffixes' map is new each time), the same string each time */
  const clearLabel = createMemo(() => clearName(props.view, props.showHost, clearSuffix(props.view.key)));
  createEffect(on(viewState, () => setEarned(null), { defer: true }));
  // a refusal to clear ("it is working, so it stays") is true until the window's state moves on: the same memo, or the
  // next clock tick would take it away
  createEffect(on(viewState, () => dismissClearNotice(props.view.key), { defer: true }));

  const chipText = () => earned() ?? props.view.chip?.text ?? "";
  const chipTone = () => (earned() ? "lit" : (props.view.chip?.tone ?? "plain"));
  // a chip that changes in front of you settles in on the snap spring
  createEffect(
    on(
      chipText,
      () => {
        if (!chip || !live()) return;
        play(chip, [{ transform: "scale(.82)" }, { transform: "none" }], SNAP);
        // a state that starts in front of you lets go one ring from its dot; a finished one has no dot to ring
        const dot = chip.querySelector("i");
        if (dot) play(dot, [{ transform: "scale(1)", opacity: 0.5 }, { transform: `scale(${PING_SCALE})`, opacity: 0 }], PING, { pseudoElement: "::after" });
      },
      { defer: true },
    ),
  );
  // an ask rises out of the tail (design.md: the ask rises); the window itself keeps its size. as it starts waiting in front
  // of you, one ring of its accent leaves its edge and fades: the window clips what it holds, so the ring is drawn on the
  // page at the window's box, measured once, and goes when it has faded. nothing loops; the lit tray is the standing signal,
  // and under reduced motion there is no ring at all
  let ring: HTMLElement | undefined;
  onCleanup(() => ring?.remove());
  const ping = () => {
    if (prefersReducedMotion() || !root.isConnected) return;
    ring?.remove();
    const box = root.getBoundingClientRect();
    const el = document.createElement("i");
    el.className = "win-ping plane-window";
    el.setAttribute("aria-hidden", "true");
    for (const [name, value] of Object.entries({ ...colourStyle(props.view.colour), left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, "border-radius": getComputedStyle(root).borderRadius })) el.style.setProperty(name, value);
    document.body.append(el);
    ring = el;
    const out = play(el, [{ transform: "scale(1)", opacity: 0.7 }, { transform: `scale(${NEED_PING_SCALE})`, opacity: 0 }], PING, { fill: "forwards" });
    if (!out) el.remove();
    else void out.finished.then(() => el.remove(), () => el.remove());
  };
  createEffect(
    on(
      () => props.view.ask?.key,
      (key) => {
        if (!key || !askBox || !live()) return;
        play(askBox, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], SNAP, { delay: 40, fill: "backwards" });
        ping();
      },
      { defer: true },
    ),
  );

  const open = (event: MouseEvent) => {
    event.preventDefault();
    props.onOpen(root, event);
  };

  return (
    <article
      ref={(el) => {
        root = el;
        props.ref?.(el);
      }}
      class="win"
      data-key={props.view.key}
      data-state={props.view.state}
      data-current={props.current ? "" : undefined}
      data-asking={props.view.ask ? "" : undefined}
      style={colourStyle(props.view.colour)}
    >
      <div class="sheen" ref={sheen} aria-hidden="true" />
      <header class="wh">
        <span class="who">
          <RepoMark host={props.view.host} root={props.view.root} name={props.view.repo} colour={props.view.colour} size={22} />
          <span class="name">
            {props.view.repo}
            <Show when={props.showHost}>
              <em>, {props.view.host}</em>
            </Show>
          </span>
        </span>
        <Show when={chipText()}>
          <span class="chip" ref={chip} data-tone={chipTone()}>
            <Show when={earned()} fallback={<Show when={props.view.state === "working" || props.view.state === "queued"}>{<i aria-hidden="true" />}</Show>}>
              {TICK}
            </Show>
            {chipText()}
          </span>
        </Show>
        {/* the board's digit at the header's end, once a board has been here (docs/board.md, the app) */}
        <Show when={state.board.met}>
          <BoardKey thread={props.view.key} form="window" live={live()} />
        </Show>
      </header>
      <h2>
        <button class="win-open" type="button" aria-label={`${windowName(props.view)}${boardWords(props.view.key)}${openSuffix(props.view.key)}`} aria-current={props.current ? "true" : undefined} onClick={open}>
          {props.view.title}
        </button>
      </h2>
      <Show when={props.view.retry}>{(why) => <p class="win-note">{why()}</p>}</Show>
      <Show when={props.view.failure}>{(why) => <p class="win-note" data-tone="fail">{why()}</p>}</Show>
      <Show when={props.view.review}>{(note) => <p class="win-note">ready to merge: {note()}</p>}</Show>
      <Show when={props.view.state === "parked"}>
        <p class="win-note">
          waiting on {parkedOn(props.view)}; {props.view.jobs === 1 ? "its notice wakes it" : "their notices wake it"}
        </p>
      </Show>
      <Show when={props.view.state === "working" && props.view.parkedAgents > 0}>
        <p class="win-note">{props.view.parkedAgents === 1 ? "its agent is at work; its report wakes it" : `${props.view.parkedAgents} agents at work; their reports wake it`}</p>
      </Show>
      <Show when={clearNotice(props.view.key)}>{(why) => <p class="win-note" role="status">{why()}</p>}</Show>
      <ol class="tail" aria-label={`${props.view.repo}, latest work`}>
        <For each={props.view.tail}>{(line) => <Line line={line} live={live()} />}</For>
      </ol>
      {/* the run's strip under its lines while it works (the step group's, drawn in order: the tail has no clock) */}
      <Show when={props.view.strip}>{(strip) => <div class="wstrip"><StripLane strip={strip()} /></div>}</Show>
      <Show when={props.view.need}>
        {(need) => (
          <button
            class="wask"
            type="button"
            ref={(el) => (askBox = el)}
            aria-label={`answer ${props.view.repo}: ${shortWords(need().line, 60)}`}
            aria-description={need().detail}
            aria-haspopup="dialog"
            onPointerDown={warmOn("AskSheet")}
            onClick={(event) => props.onOpenAsk(root, event)}
          >
            <Show when={need().eyebrow}>{(eyebrow) => <span class="wask-label">{eyebrow()}</span>}</Show>
            <span class="wask-text">{need().line}</span>
            <span class="wask-foot">
              <span class="wask-waiting">{need().detail}</span>
              {/* the key inside the key: the accent turned over, so the tray reads as one thing to press */}
              <span class="wask-go" aria-hidden="true">
                answer
                <svg viewBox="0 0 12 12"><path d="M3 7.5 6 4.5l3 3" /></svg>
              </span>
            </span>
          </button>
        )}
      </Show>
      <footer class="wf">
        <span class="d">
          <Show when={props.view.diff} fallback="no edits yet">
            {(diff) => (
              <>
                <span class="add">+{diff().additions}</span> <span class="del">-{diff().deletions}</span>
              </>
            )}
          </Show>
        </span>
        <span class="tiles">
          <For each={Array.from({ length: Math.min(props.view.agents, 6) })}>{() => <i aria-hidden="true" />}</For>
          <Show when={props.view.agents > 0}>
            <span class="sr">{props.view.agents === 1 ? "1 agent" : `${props.view.agents} agents`}</span>
          </Show>
        </span>
        <span class="clk">{footClock(props.view, props.now)}</span>
        <Show when={clearable(props.view)}>
          <button class="wclear" type="button" aria-label={clearLabel()} onClick={() => void clearThreads([props.view.key], "window")}>
            clear
          </button>
        </Show>
      </footer>
    </article>
  );
}

/** one line of the tail; a line that arrives while the window is live pushes the rest up and settles in */
function Line(props: { line: TailLine; live: boolean }) {
  const mount = (el: HTMLLIElement) => {
    if (!props.live) return;
    requestAnimationFrame(() => {
      if (el !== el.parentElement?.lastElementChild) return;
      // the tail stands on its bottom edge, so a new line lifted everything above it by its own height
      const lift = el.offsetHeight + Number.parseFloat(getComputedStyle(el.parentElement).rowGap || "0");
      for (let above = el.previousElementSibling; above; above = above.previousElementSibling) {
        play(above, [{ transform: `translateY(${lift}px)` }, { transform: "none" }], SNAP);
      }
      play(el, [{ opacity: 0, transform: "translateY(8px)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], SNAP, { fill: "backwards" });
    });
  };
  return (
    <Switch>
      <Match when={props.line.kind === "prose" && props.line}>
        {(line) => (
          <li class="say" ref={mount}>
            <LiveText text={line().text} live={props.live} />
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "prompt" && props.line}>
        {(line) => (
          <li class="me" ref={mount}>
            <span class="sr">you asked: </span>
            {line().text}
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "report" && props.line}>
        {(line) => (
          <li class="tool" ref={mount}>
            <span>
              <b>{line().from}</b> reported
            </span>
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "tool" && props.line}>
        {(line) => (
          <li class="tool" data-status={line().status} ref={mount}>
            <span>
              {line().verb} <b>{line().object}</b>
            </span>
            <Show when={line().result}>
              <span class="res">{line().result}</span>
            </Show>
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "reads" && props.line}>
        {(line) => (
          <li class="tool" data-status={line().status} ref={mount}>
            <span>
              read <b>{line().count === 1 ? line().object : `${line().count} files`}</b>
            </span>
            <Show when={line().count === 1}>
              <span class="res">1 file</span>
            </Show>
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "file" && props.line}>
        {(line) => (
          <li class="tool" ref={mount}>
            <span>
              attached <b>{line().name}</b>
            </span>
          </li>
        )}
      </Match>
    </Switch>
  );
}
