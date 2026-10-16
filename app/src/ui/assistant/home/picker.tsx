/* start something with an agent (docs/composer.md): the agent row at the sheet's head, the picker that opens under it,
   and the line under the composer with an assistant chosen.

   the row is a disclosure (aria-expanded) pressed into the sheet: the agent's mark (33: a square holding the machine's
   initials in the page's quiet material for cmx, the round mark in its palette for an assistant), its name over its
   runtime and machine, and a chevron. the picker is a deeper card of the window plane: every cmx agent (square marks),
   a hairline, then every assistant that declares `threads`, the chosen one carrying a check. an agent that cannot take
   a thread now is listed dim and says why, and is not a choice. arrows walk it, return takes one, esc closes it.

   presentational: the sheet owns which agent is chosen and whether the picker is open. */

import { createMemo, createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { Icon } from "../../composer/icons";
import { RepoMark } from "../../repo-mark/repo-mark";
import { assistantColour } from "../../window/repo";
import type { Agent } from "../wire";
import { agentName, agentPlace } from "../words";
import { agentRowName, availability, machineInitials, pickerGroups, pickerOptionName, startLine } from "./words";
import "./picker.css";

/** an agent's mark at a size: the round mark in its palette, or a square with the machine's initials */
export function AgentMark(props: { agent: Agent; size: number }) {
  return (
    <Show
      when={props.agent.mark === "round"}
      fallback={
        <span class="ah-machine-mark" aria-hidden="true" style={{ "--mark": `${props.size}px` }}>
          {machineInitials(props.agent.label.machine)}
        </span>
      }
    >
      <RepoMark host={props.agent.key} root="" name={agentName(props.agent)} colour={assistantColour(props.agent.palette)} shape="round" size={props.size} />
    </Show>
  );
}

export type AgentRowProps = {
  agent: Agent;
  expanded: boolean;
  /** the id of the picker it opens, for aria-controls */
  controls?: string;
  onToggle?: () => void;
  ref?: (el: HTMLButtonElement) => void;
};

/** the agent row: cmx over "on vm-a", or "<name>" over "openclaw · vm-b" */
export function AgentRow(props: AgentRowProps) {
  return (
    <button
      ref={props.ref}
      class="ah-agent-row"
      type="button"
      aria-label={agentRowName(props.agent)}
      aria-expanded={props.expanded ? "true" : "false"}
      aria-controls={props.controls}
      onClick={() => props.onToggle?.()}
    >
      <AgentMark agent={props.agent} size={33} />
      <span class="ah-agent-text">
        <b>{agentName(props.agent)}</b>
        <span>{agentPlace(props.agent)}</span>
      </span>
      <Icon name="chevronDown" class="ah-chev" />
    </button>
  );
}

export type AgentPickerProps = {
  agents: readonly Agent[];
  /** the chosen agent's key */
  chosen: string;
  id?: string;
  onPick?: (agent: Agent) => void;
  onClose?: () => void;
};

/** the picker: a listbox the keyboard walks with arrows, home and end; focus stays on the list and the row the arrows
    are on is its active descendant */
export function AgentPicker(props: AgentPickerProps) {
  const id = props.id ?? createUniqueId();
  const groups = createMemo(() => pickerGroups(props.agents));
  const order = createMemo(() => [...groups().square, ...groups().round]);
  const startAt = () => Math.max(0, order().findIndex((a) => a.key === props.chosen));
  const [active, setActive] = createSignal(startAt());
  let list!: HTMLDivElement;
  onMount(() => list.focus({ preventScroll: true }));
  const optionId = (agent: Agent) => `${id}-${agent.key.replace(/[^a-z0-9_-]/gi, "-")}`;
  const take = (agent: Agent) => {
    if (availability(agent) !== "ready") return;
    props.onPick?.(agent);
  };
  const onKey = (event: KeyboardEvent) => {
    const n = order().length;
    if (!n) return;
    const go = (to: number) => {
      event.preventDefault();
      setActive((to + n) % n);
      list.querySelector(`#${CSS.escape(optionId(order()[active()] as Agent))}`)?.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "ArrowDown":
        return go(active() + 1);
      case "ArrowUp":
        return go(active() - 1);
      case "Home":
        return go(0);
      case "End":
        return go(n - 1);
      case "Enter":
      case " ": {
        event.preventDefault();
        const agent = order()[active()];
        if (agent) take(agent);
        return;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        props.onClose?.();
        return;
    }
  };
  const Option = (o: { agent: Agent }) => {
    const index = () => order().indexOf(o.agent);
    const can = () => availability(o.agent);
    return (
      <div
        id={optionId(o.agent)}
        class="ah-option"
        role="option"
        aria-label={pickerOptionName(o.agent)}
        aria-selected={o.agent.key === props.chosen ? "true" : "false"}
        aria-disabled={can() === "ready" ? undefined : "true"}
        data-active={index() === active() ? "" : undefined}
        data-dim={can() === "ready" ? undefined : ""}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          setActive(index());
          take(o.agent);
        }}
      >
        <AgentMark agent={o.agent} size={30} />
        <span class="ah-option-text">
          <b>{o.agent.mark === "round" ? agentName(o.agent) : o.agent.label.source}</b>
          <span>
            {o.agent.mark === "round" ? agentPlace(o.agent) : o.agent.label.machine}
            {can() === "ready" ? "" : ` · ${can()}`}
          </span>
        </span>
        <Show when={o.agent.key === props.chosen}>
          <span class="ah-check" aria-hidden="true">
            <Icon name="check" />
          </span>
        </Show>
      </div>
    );
  };
  return (
    <div
      ref={list}
      id={id}
      class="ah-picker plane-window"
      role="listbox"
      aria-label="agents"
      tabindex="0"
      aria-activedescendant={order()[active()] ? optionId(order()[active()] as Agent) : undefined}
      onKeyDown={onKey}
    >
      <For each={groups().square}>{(agent) => <Option agent={agent} />}</For>
      <Show when={groups().square.length > 0 && groups().round.length > 0}>
        <hr class="ah-rule" aria-hidden="true" />
      </Show>
      <For each={groups().round}>{(agent) => <Option agent={agent} />}</For>
    </div>
  );
}

/** the line under the composer with an assistant chosen: "<name> starts a new thread on vm-b." */
export function StartLine(props: { agent: Agent }) {
  return <p class="ah-start-line">{startLine(props.agent)}</p>;
}
