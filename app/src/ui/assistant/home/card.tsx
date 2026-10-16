/* an assistant's card on the agents screen (docs/home.md, the agents): a machine's window (ui/machines/host.tsx, its
   material and classes) in the assistant's palette. the round mark beside the name, the chip, the mono line, then what
   its state says: the approval it waits for, the threads it is reading, the figures it can say (wants you, threads,
   memory with `admin`), or why it is refused, in red. its foot holds reload and restart with `admin` (restart confirmed
   in place, as a machine's) and forget for a paired one.

   presentational: the verbs call what they are given. the copy is home.md's table, made in words.ts. */

import { createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { RepoMark } from "../../repo-mark/repo-mark";
import { assistantColour, colourStyle } from "../../window/repo";
import type { Agent } from "../wire";
import { agentName } from "../words";
import { cardChip, cardMeta, cardSays, forgetWords, GHOST_LINE, NO_AGENTS, restartWords } from "./words";
import "../../machines/machines.css";
import "./card.css";

const numbers = new Intl.NumberFormat("en");
const VIOLET = { name: "violet", top: "#34298a", bottom: "#171240", light: "#b7abff" };

export type AgentCounts = { wants: number; threads: number };
type Arming = "idle" | "restart" | "forget";

export type AgentCardProps = {
  agent: Agent;
  /** the threads boxbox holds for it, and how many want you; the last it said while it says nothing */
  counts: AgentCounts | null;
  now: number;
  /** a story opens the card with a confirmation already showing */
  arming?: Arming;
  /** what the card said after a verb ("reloaded at 14:02: ..."), or a refusal */
  note?: { text: string; failed: boolean } | null;
  onReload?: () => void;
  onRestart?: () => void;
  onForget?: () => void;
  /** asks the gateway again now (the card asks every 5 s by itself while the screen is open) */
  onCheck?: () => void;
};

export function AgentCard(props: AgentCardProps) {
  const name = () => agentName(props.agent);
  const titleId = createUniqueId();
  const chip = () => cardChip(props.agent);
  const says = () => cardSays(props.agent);
  const status = () => props.agent.status;
  const ready = () => status() === "ready";
  const admin = () => props.agent.capabilities.admin;
  const paired = () => props.agent.connection.origin === "paired";
  /** the figures: none while it waits for approval or is refused (it has said nothing under this pairing), the last it
      said, in the second ink, while it is syncing, connecting or down */
  const figures = () => (status() === "pairing" || status() === "refused" ? null : props.counts);
  const memory = () => (admin() ? props.agent.connection.memory : null);
  const colour = () => (props.agent.palette ? assistantColour(props.agent.palette) : VIOLET);

  const [arming, setArming] = createSignal<Arming>(props.arming ?? "idle");
  const [copied, setCopied] = createSignal(false);
  const verbs: Partial<Record<Exclude<Arming, "idle">, HTMLButtonElement>> = {};
  let keep: HTMLButtonElement | undefined;
  const arm = (verb: Exclude<Arming, "idle">) => {
    setArming(verb);
    queueMicrotask(() => keep?.focus({ preventScroll: true }));
  };
  const disarm = () => {
    const was = arming();
    setArming("idle");
    if (was !== "idle") queueMicrotask(() => verbs[was]?.focus({ preventScroll: true }));
  };
  const onConfirmKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    disarm();
  };
  const copy = () => {
    const words = props.agent.connection.lastError ?? "";
    void navigator.clipboard?.writeText(words).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <li class="host ah-card" aria-labelledby={titleId} data-status={status()} data-look={chip().look} style={colourStyle(colour())}>
      <div class="host-main">
        <div class="host-head">
          <span class="ah-who">
            <Show when={props.agent.mark === "round"}>
              <RepoMark host={props.agent.key} root="" name={name()} colour={colour()} shape="round" size={22} />
            </Show>
            <h2 class="host-name" id={titleId}>
              {name()}
            </h2>
          </span>
          <span class="host-chip">
            <i aria-hidden="true" />
            {chip().text}
          </span>
        </div>
        <p class="host-meta">
          <For each={cardMeta(props.agent, props.now)}>
            {(part, i) => (
              <>
                {i() > 0 ? " · " : ""}
                <Show when={part.lit} fallback={part.text}>
                  <span class="ah-lit">{part.text}</span>
                </Show>
              </>
            )}
          </For>
        </p>
        <Show when={status() === "pairing"}>
          <div class="ah-approve">
            <p>approve boxbox on {props.agent.label.machine}'s gateway:</p>
            <pre class="ah-bed">{props.agent.connection.lastError ?? "the gateway has not said how yet."}</pre>
            <div class="host-verbs ah-approve-verbs">
              <button class="host-verb" type="button" aria-label="copy the approval command" disabled={!props.agent.connection.lastError} onClick={copy}>
                copy the approval command
              </button>
              <button class="host-verb" type="button" aria-label="check again" onClick={() => props.onCheck?.()}>
                check again
              </button>
            </div>
            <Show when={copied()}>
              <p class="ah-copied" role="status">
                copied. run it on {props.agent.label.machine}.
              </p>
            </Show>
          </div>
        </Show>
        <Show when={says()}>{(said) => <p class={said().failed ? "host-error" : "ah-says"}>{said().text}</p>}</Show>
        <Show when={figures()}>
          {(counts) => (
            <dl class="host-figures" data-stale={ready() ? undefined : ""}>
              <div class="host-figure" data-lit={counts().wants > 0 ? "" : undefined}>
                <dt>{counts().wants === 1 ? "wants you" : "want you"}</dt>
                <dd>{numbers.format(counts().wants)}</dd>
              </div>
              <div class="host-figure">
                <dt>{counts().threads === 1 ? "thread" : "threads"}</dt>
                <dd>{numbers.format(counts().threads)}</dd>
              </div>
              <Show when={memory()}>
                {(mem) => (
                  <div class="host-figure">
                    <dt>memory</dt>
                    <dd>
                      {numbers.format(Math.round(mem().rss / 1_048_576))}
                      <small> mb</small>
                    </dd>
                  </div>
                )}
              </Show>
            </dl>
          )}
        </Show>
      </div>
      <Show when={admin() || paired()}>
        <Switch>
          <Match when={arming() === "idle"}>
            <div class="host-foot">
              <div class="host-verbs">
                <Show when={admin()}>
                  <button class="host-verb" type="button" aria-label={`reload ${name()}`} disabled={!ready()} onClick={() => props.onReload?.()}>
                    reload
                  </button>
                  <button ref={(el) => (verbs.restart = el)} class="host-verb" type="button" aria-label={`restart ${name()}`} disabled={!ready()} onClick={() => arm("restart")}>
                    restart
                  </button>
                </Show>
                <Show when={paired()}>
                  <button ref={(el) => (verbs.forget = el)} class="host-verb" type="button" aria-label={`forget ${name()}`} onClick={() => arm("forget")}>
                    forget
                  </button>
                </Show>
              </div>
            </div>
          </Match>
          <Match when={arming() === "restart"}>
            <div class="host-confirm" role="group" aria-label={`restart ${name()}?`} onKeyDown={onConfirmKey}>
              <p>{restartWords(name())}</p>
              <div class="host-choices">
                <button class="on-window" type="button" aria-label={`restart ${name()} now`} onClick={() => props.onRestart?.()}>
                  restart
                </button>
                <button ref={keep} class="quiet" type="button" aria-label={`keep ${name()} running`} onClick={disarm}>
                  keep running
                </button>
              </div>
            </div>
          </Match>
          <Match when={arming() === "forget"}>
            <div class="host-confirm" role="group" aria-label={`forget ${name()}?`} onKeyDown={onConfirmKey}>
              <p>{forgetWords(name(), props.agent.label.machine)}</p>
              <div class="host-choices">
                <button class="on-window" type="button" aria-label={`forget ${name()} now`} onClick={() => props.onForget?.()}>
                  forget
                </button>
                <button ref={keep} class="quiet" type="button" aria-label={`keep ${name()}`} onClick={disarm}>
                  keep
                </button>
              </div>
            </div>
          </Match>
        </Switch>
      </Show>
      <Show when={props.note}>
        {(said) => (
          <p class={said().failed ? "host-note failed" : "host-note"} role="status" tabindex="-1">
            {said().text}
          </p>
        )}
      </Show>
    </li>
  );
}

/** the place the next agent goes: a ghost window after the cards; the whole ghost is the button */
export function AddAgentGhost(props: { onOpen?: () => void }) {
  return (
    <li class="host-add">
      <span class="host-add-plus" aria-hidden="true" />
      <button class="host-add-open" type="button" onClick={() => props.onOpen?.()}>
        add an agent
      </button>
      <p class="host-add-note">{GHOST_LINE}</p>
    </li>
  );
}

/** the line the screen says with no agents, above the ghost alone */
export function NoAgents() {
  return <p class="hosts-empty">{NO_AGENTS}</p>;
}
