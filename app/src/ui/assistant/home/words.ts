/* the words of an assistant on home, on the agents screen and in start something, pure, so a test pins them (docs/home.md,
   assistants on home and the agents; docs/composer.md, start something with an agent; docs/design.md, accessible names
   for agent surfaces). every string is made from the wire's fields, and never from the runtime's name. */

import { shortWords } from "../../asks/words";
import type { WindowState } from "../../window/view";
import type { Agent } from "../wire";
import { agentName, agentSpoken, timeOf } from "../words";

/* —— the window —— */

/** what the window's state is, in the words its accessible name ends on, as a cmx window's (window/view.ts, windowName) */
export function stateWords(state: WindowState, since: number | null): string {
  switch (state) {
    case "wants":
      return "wants you";
    case "failed":
      return "stopped";
    case "working":
    case "queued":
      return "working";
    case "parked":
      return "waiting";
    case "done":
      return since === null ? "done" : `done at ${timeOf(since)}`;
    case "idle":
      return "seen";
    default:
      return state satisfies never;
  }
}

/** an assistant's window, named whole: "<name>: <title>. wants you" */
export function assistantWindowName(name: string, title: string, state: WindowState, since: number | null): string {
  return `${name}: ${title}. ${stateWords(state, since)}`;
}

/** the ask preview's pill: "answer <name>: <question>" */
export function answerName(name: string, question: string): string {
  return `answer ${name}: ${shortWords(question, 60)}`;
}

/** m:ss, or h:mm:ss past an hour */
export function elapsedOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** the footer's right edge (home.md, the footer): "waiting", "working 0:40", "done 11:40"; a window of an agent that is
    away holds still and says when boxbox last read it: "stale, 11:40" (home.md, when the gateway is away) */
export function footState(state: WindowState, since: number | null, now: number, staleAt: number | null): string {
  if (staleAt !== null) return `stale, ${timeOf(staleAt)}`;
  switch (state) {
    case "wants":
      return "waiting";
    case "working":
    case "queued":
      return since === null ? "working" : `working ${elapsedOf(now - since)}`;
    case "parked":
      return since === null ? "waiting" : `waiting since ${timeOf(since)}`;
    case "done":
      return since === null ? "done" : `done ${timeOf(since)}`;
    case "failed":
      return since === null ? "stopped" : `stopped ${timeOf(since)}`;
    case "idle":
      return since === null ? "" : timeOf(since);
    default:
      return state satisfies never;
  }
}

/** the footer's left edge: where the conversation is when it is somewhere else ("via whatsapp"), else "3 steps" when the
    last turn stepped, else nothing */
export function footOrigin(channel: string | null, steps: number): string {
  if (channel) return `via ${channel === "control-ui" ? "the control ui" : channel}`;
  if (steps > 0) return steps === 1 ? "1 step" : `${steps} steps`;
  return "";
}

/** the folded steps line's tail: "and 2 more" */
export function moreWords(hidden: number): string {
  return hidden > 0 ? `and ${hidden} more` : "";
}

/** a voice note's line: "voice note 0:22" */
export function voiceLine(durationMs: number | undefined): string {
  if (durationMs === undefined) return "voice note";
  const s = Math.max(0, Math.round(durationMs / 1000));
  return `voice note ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* —— the runs window —— */

/** its title: "<name>'s runs" */
export const runsTitle = (name: string): string => `${name}'s runs`;

/** its chip: "3 runs", "1 run" */
export const runsChip = (unseen: number): string => (unseen === 1 ? "1 run" : `${unseen} runs`);

/** its accessible name: "<name>'s runs: 3 since 08:00" (the earliest unseen run's time) */
export function runsName(name: string, unseen: number, earliest: number | null): string {
  return earliest === null ? `${name}'s runs: ${unseen}` : `${name}'s runs: ${unseen} since ${timeOf(earliest)}`;
}

/** one run's words after its time: "morning check: two meetings moved" */
export function runWords(name: string | undefined, preview: string): string {
  return name ? `${name}: ${preview}` : preview;
}

/* —— the agents screen —— */

/** a span of time in the largest unit that fits it, whole: "12 s", "4 min", "3 h", "2 days" (machines/host.tsx) */
export function durationOf(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  const days = Math.floor(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export type ChipLook = "on" | "ring" | "half" | "fail";

/** the card's chip (home.md, the agents: pairing states) and how its dot is drawn */
export function cardChip(agent: Pick<Agent, "status">): { text: string; look: ChipLook } {
  switch (agent.status) {
    case "pairing":
      return { text: "waiting", look: "ring" };
    case "syncing":
      return { text: "syncing", look: "half" };
    case "ready":
      return { text: "connected", look: "on" };
    case "connecting":
      return { text: "connecting", look: "ring" };
    case "down":
      return { text: "not answering", look: "fail" };
    case "refused":
      return { text: "refused", look: "fail" };
    default:
      return agent.status satisfies never;
  }
}

/** one piece of the mono line; `lit` is set in the light tone (the untested version's word) */
export type MetaPart = { text: string; lit?: boolean };

/** the card's mono line, by state (home.md's table, the one source of the copy), joined with " · " */
export function cardMeta(agent: Pick<Agent, "status" | "connection" | "label">, now: number): MetaPart[] {
  const c = agent.connection;
  const runtime = c.version ? `${agent.label.source} ${c.version}` : agent.label.source;
  const paired = c.origin === "paired" ? [{ text: "paired" }] : [];
  switch (agent.status) {
    case "pairing":
      return [{ text: runtime }, { text: "waiting for approval" }];
    case "ready":
      if (c.untested) return [{ text: runtime }, { text: "untested", lit: true }];
      return [{ text: runtime }, { text: `up ${durationOf((now - c.since) / 1000)}` }, ...paired];
    case "refused":
      switch (c.refused) {
        case "protocol":
          return [{ text: runtime }, { text: c.protocol === null ? "another protocol" : `protocol ${c.protocol}` }];
        case "auth":
          return [{ text: runtime }, { text: "not paired" }];
        case "key":
          return [{ text: agent.label.source }, { text: agent.label.machine }];
        default:
          return [{ text: runtime }, { text: "refused" }];
      }
    default:
      return [{ text: runtime }, ...paired];
  }
}

/** the protocol boxbox speaks to an openclaw gateway (docs/openclaw.md, the handshake) */
export const OPENCLAW_PROTOCOL = 4;

/** what the card says under its mono line, and whether it is a failure (red) or a note (second ink); null for nothing */
export function cardSays(agent: Pick<Agent, "status" | "connection" | "label" | "key">): { text: string; failed: boolean } | null {
  const c = agent.connection;
  const name = agentName(agent);
  const machine = agent.label.machine;
  const again = "pair it again from add an agent.";
  const said = (words: string | null) => (words ? `${words.trim().replace(/[.\s]+$/, "")}. ` : "");
  switch (agent.status) {
    case "syncing":
      return { text: `reading ${name}'s threads.`, failed: false };
    case "ready":
      return c.untested
        ? { text: `${agent.label.source}${c.version ? ` ${c.version}` : ""} on ${machine} is untested; boxbox is pinned to ${c.pinned ?? "another version"}. anything that does not work says so where it fails.`, failed: false }
        : null;
    case "down":
      return { text: `${said(c.lastError) || `${machine} is not answering. `}since ${timeOf(c.since)}`, failed: true };
    case "refused":
      switch (c.refused) {
        case "protocol":
          return {
            text: `${machine} speaks ${agent.label.source} protocol ${c.protocol ?? "another"}; boxbox speaks ${OPENCLAW_PROTOCOL}. update boxbox, or run the ${agent.label.source} it is pinned to (${c.pinned ?? "the pinned version"}).`,
            failed: true,
          };
        case "key":
          return { text: `another agent already has the key ${agent.key}. pin a key for this one in boxbox.toml, then reload.`, failed: true };
        default:
          return { text: `${said(c.lastError)}${again}`, failed: true };
      }
    default:
      return null;
  }
}

/** the restart's consequence, confirmed in place */
export const restartWords = (name: string): string => `restart stops ${name}'s running turns, then its gateway starts fresh.`;

/** the forget's consequence, confirmed in place */
export const forgetWords = (name: string, machine: string): string => `boxbox deletes its pairing with ${name} on ${machine} and stops reading its threads.`;

/** the ghost's line */
export const GHOST_LINE = "pair a machine's cmx, or an assistant's gateway.";

/** the screen with no agents */
export const NO_AGENTS = "no agents yet. pair one, or add one to boxbox.toml.";

/* —— start something —— */

/** a machine's initials for its square mark: two letters, "va" for vm-a */
export function machineInitials(machine: string): string {
  const parts = machine.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`;
  return (parts[0] ?? machine).slice(0, 2);
}

/** whether an agent can take a new thread now, and the words for why not */
export function availability(agent: Pick<Agent, "status">): "ready" | "not answering" | "waiting for approval" {
  if (agent.status === "ready" || agent.status === "syncing") return "ready";
  if (agent.status === "pairing") return "waiting for approval";
  return "not answering";
}

/** the agent row, a disclosure: "agent for the new thread: <name>, openclaw on vm-b" */
export const agentRowName = (agent: Pick<Agent, "label">): string => `agent for the new thread: ${agentSpoken(agent)}`;

/** a picker option: "cmx on vm-a", "<name>, openclaw on vm-b, not answering" */
export function pickerOptionName(agent: Pick<Agent, "label" | "status">): string {
  const can = availability(agent);
  return can === "ready" ? agentSpoken(agent) : `${agentSpoken(agent)}, ${can}`;
}

/** the picker's own list, in its order: cmx (square marks) first, then assistants (round), each only with `threads` */
export function pickerGroups<A extends Pick<Agent, "mark" | "capabilities">>(agents: readonly A[]): { square: A[]; round: A[] } {
  const listed = agents.filter((a) => a.capabilities.threads);
  return { square: listed.filter((a) => a.mark === "square"), round: listed.filter((a) => a.mark === "round") };
}

/** the line under the composer with an assistant chosen: "<name> starts a new thread on vm-b." */
export const startLine = (agent: Pick<Agent, "label">): string => `${agentName(agent)} starts a new thread on ${agent.label.machine}.`;
