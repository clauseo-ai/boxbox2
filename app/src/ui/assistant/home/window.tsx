/* an assistant's window on the deck (docs/home.md, assistants on home): a cmx window's plane, chip, title, ask preview and
   footer (ui/window/window.css), in the assistant's palette. what changes: the header leads with the round mark and the
   name in the light tone with nothing after it; the tail speaks the assistant's grammar (folded steps, a voice note, a
   picture or a file, a scheduled run's mark line); the footer's left says where the conversation is ("via whatsapp");
   and a window of an agent that is away is stale ("stale, 11:40") and holds still.

   presentational: it draws what it is given and opens nothing itself. the window is an article with one stretched
   button (the title), so the "answer" pill can be a real button of its own, as a cmx window's. */

import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { RepoMark } from "../../repo-mark/repo-mark";
import { Icon } from "../../composer/icons";
import { assistantColour, colourStyle } from "../../window/repo";
import type { ChipTone, WindowState } from "../../window/view";
import type { Agent } from "../wire";
import { agentName, timeOf } from "../words";
import { answerName, assistantWindowName, footOrigin, footState, moreWords, runsChip, runsName, runsTitle, runWords, voiceLine } from "./words";
import "../../window/window.css";
import "./window.css";

/** one step in a folded steps line: its verb (dim) and its thing (lit) */
export type Step = { verb: string; thing: string };

/** a line of an assistant's tail (home.md, the tail's grammar); `mine` sits on the right, as your prompt does */
export type AssistantLine =
  | { kind: "prose"; text: string }
  | { kind: "prompt"; text: string }
  | { kind: "steps"; steps: Step[] }
  | { kind: "step-failed"; step: Step }
  | { kind: "voice"; mine: boolean; durationMs?: number; playing?: boolean }
  | { kind: "media"; mine: boolean; glyph: "image" | "file"; name: string }
  | { kind: "scheduled"; word: "scheduled" | "heartbeat"; rest: string };

export type AssistantAsk = { kind: "question" | "permission"; header: string | null; text: string; waiting: string };

/** what the window draws, read from the agent's thread (contract 2's thread and its newest turns) */
export type AssistantView = {
  key: string;
  title: string;
  state: WindowState;
  chip: { text: string; tone: ChipTone } | null;
  /** what the clock counts from: the turn's start, the ask's arrival, when it was done */
  since: number | null;
  tail: AssistantLine[];
  ask: AssistantAsk | null;
  /** the channel the newest message came in on (`origin.kind: channel`), or null for one written from boxbox */
  channel: string | null;
  /** steps the last turn took, said on the left when there is no channel */
  steps: number;
};

export type AssistantWindowProps = {
  agent: Agent;
  view: AssistantView;
  now: number;
  /** the time of boxbox's last read while the agent is not answering or refused: the window is stale */
  staleAt?: number | null;
  onOpen?: (el: HTMLElement, event: Event) => void;
  onOpenAsk?: (el: HTMLElement, event: Event) => void;
};

export function AssistantWindow(props: AssistantWindowProps) {
  let root!: HTMLElement;
  const name = () => agentName(props.agent);
  const colour = () => assistantColour(props.agent.palette);
  const stale = () => props.staleAt ?? null;
  const origin = () => footOrigin(props.view.channel, props.view.steps);
  return (
    <article ref={root} class="win ah-win" data-key={props.view.key} data-state={props.view.state} data-asking={props.view.ask ? "" : undefined} data-stale={stale() !== null ? "" : undefined} style={colourStyle(colour())}>
      <Header agent={props.agent} name={name()} chip={props.view.chip} dot={stale() === null && (props.view.state === "working" || props.view.state === "queued")} />
      <h2>
        <button class="win-open" type="button" aria-label={assistantWindowName(name(), props.view.title, props.view.state, props.view.since)} onClick={(e) => props.onOpen?.(root, e)}>
          {props.view.title}
        </button>
      </h2>
      <ol class="tail" aria-label={`${name()}, latest`}>
        <For each={props.view.tail}>{(line) => <Line line={line} name={name()} />}</For>
      </ol>
      <Show when={props.view.ask}>
        {(ask) => (
          <section class="wask" aria-label={`${name()} ${ask().kind === "question" ? "asks a question" : "asks permission"}`}>
            <Show when={ask().header}>{(header) => <p class="wask-label">{header()}</p>}</Show>
            <p class="wask-text">{ask().text}</p>
            <div class="wask-foot">
              <span class="wask-waiting">{ask().waiting}</span>
              <button class="wask-go" type="button" aria-label={answerName(name(), ask().text)} disabled={stale() !== null} onClick={(e) => props.onOpenAsk?.(root, e)}>
                answer
              </button>
            </div>
          </section>
        )}
      </Show>
      <footer class="wf">
        <span class="ah-origin">{origin()}</span>
        <span class="clk">{footState(props.view.state, props.view.since, props.now, stale())}</span>
      </footer>
    </article>
  );
}

/** the runs window (home.md, quieter runs): one per assistant for every run with something unseen; its tail one line
    per run, newest last, at most 12 */
export function RunsWindow(props: { agent: Agent; onOpen?: (el: HTMLElement, event: Event) => void }) {
  let root!: HTMLElement;
  const name = () => agentName(props.agent);
  const runs = () => props.agent.runs ?? { unseen: 0, items: [] };
  const items = () => [...runs().items].sort((a, b) => a.at - b.at).slice(-12);
  const earliest = () => items()[0]?.at ?? null;
  const newest = () => items().at(-1)?.at ?? null;
  return (
    <article ref={root} class="win ah-win" data-key={`${props.agent.key}:runs`} data-state="done" style={colourStyle(assistantColour(props.agent.palette))}>
      <Header agent={props.agent} name={name()} chip={{ text: runsChip(runs().unseen), tone: "plain" }} dot={false} />
      <h2>
        <button class="win-open" type="button" aria-label={runsName(name(), runs().unseen, earliest())} onClick={(e) => props.onOpen?.(root, e)}>
          {runsTitle(name())}
        </button>
      </h2>
      <ol class="tail" aria-label={`${name()}'s runs, newest last`}>
        <For each={items()}>
          {(run) => (
            <li class="ah-run">
              <time>{timeOf(run.at)}</time> <span>{runWords(run.name, run.preview)}</span>
            </li>
          )}
        </For>
      </ol>
      <footer class="wf">
        <span class="ah-origin">scheduled</span>
        <span class="clk">{newest() === null ? "" : timeOf(newest() as number)}</span>
      </footer>
    </article>
  );
}

function Header(props: { agent: Agent; name: string; chip: { text: string; tone: ChipTone } | null; dot: boolean }) {
  return (
    <header class="wh">
      <span class="who">
        <RepoMark host={props.agent.key} root="" name={props.name} colour={assistantColour(props.agent.palette)} shape="round" size={22} />
        <span class="name ah-name">{props.name}</span>
      </span>
      <Show when={props.chip}>
        {(chip) => (
          <span class="chip" data-tone={chip().tone}>
            <Show when={props.dot}>
              <i aria-hidden="true" />
            </Show>
            {chip().text}
          </span>
        )}
      </Show>
    </header>
  );
}

const PLAY = (
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <path d="M8.5 6.6v8.8l7-4.4z" fill="currentColor" />
  </svg>
);
const PAUSE = (
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <path d="M7.6 6.5h2.4v9H7.6zM12 6.5h2.4v9H12z" fill="currentColor" />
  </svg>
);

function Line(props: { line: AssistantLine; name: string }) {
  return (
    <Switch>
      <Match when={props.line.kind === "prose" && props.line}>{(line) => <li class="say">{line().text}</li>}</Match>
      <Match when={props.line.kind === "prompt" && props.line}>
        {(line) => (
          <li class="me">
            <span class="sr">you said: </span>
            {line().text}
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "steps" && props.line}>{(line) => <StepsLine steps={line().steps} />}</Match>
      <Match when={props.line.kind === "step-failed" && props.line}>
        {(line) => (
          <li class="tool ah-steps" data-status="failed">
            <span>
              <span class="ah-fail">{line().step.verb}</span> <b>{line().step.thing}</b>
            </span>
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "voice" && props.line}>
        {(line) => (
          <li class={line().mine ? "me ah-media" : "say ah-media"} data-playing={line().playing ? "" : undefined}>
            <span class="ah-disc">{line().playing ? PAUSE : PLAY}</span>
            <span class="sr">{line().mine ? "your " : `${props.name}'s `}</span>
            {voiceLine(line().durationMs)}
            <Show when={line().playing}>
              <span class="sr">, playing</span>
            </Show>
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "media" && props.line}>
        {(line) => (
          <li class={line().mine ? "me ah-media" : "say ah-media"}>
            <Icon name={line().glyph === "image" ? "photo" : "file"} class="ah-glyph" />
            <span class="ah-file">{line().name}</span>
          </li>
        )}
      </Match>
      <Match when={props.line.kind === "scheduled" && props.line}>
        {(line) => (
          <li class="ah-mark">
            <b>{line().word}</b>, {line().rest}
          </li>
        )}
      </Match>
    </Switch>
  );
}

/** steps between two pieces of prose, folded into one mono line that never wraps: past the width it says "and 2 more".
    the steps are laid out whole, then dropped from the end until the line and its "and N more" fit */
function StepsLine(props: { steps: Step[] }) {
  let line!: HTMLSpanElement;
  const [shown, setShown] = createSignal(props.steps.length);
  onMount(() => {
    const fit = () => {
      let n = props.steps.length;
      setShown(n);
      while (n > 1 && line.scrollWidth > line.clientWidth + 0.5) setShown(--n);
    };
    fit();
    // the fonts arrive after the first layout; the fit is taken again once they have
    void document.fonts?.ready.then(fit);
  });
  return (
    <li class="tool ah-steps">
      <span ref={line}>
        <For each={props.steps.slice(0, shown())}>
          {(step, i) => (
            <>
              <Show when={i() > 0}>
                <span class="ah-dim"> · </span>
              </Show>
              <span class="ah-dim">{step.verb}</span> <b>{step.thing}</b>
            </>
          )}
        </For>
      </span>
      <Show when={shown() < props.steps.length}>
        <span class="ah-more">{moreWords(props.steps.length - shown())}</span>
      </Show>
    </li>
  );
}
