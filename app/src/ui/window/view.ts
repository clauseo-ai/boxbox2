/* what one window shows, derived from the fleet model the server
   computed (decision 16). the server decides the facts (status, asks,
   tail, order); this decides only how they read: the state, the chip, the
   clock, the footer. pure, so view.test.ts pins every state in the table
   of docs/design.md (window states). */

import type { Ask, SessionEntry, SessionInfo, SessionStatus } from "../../sync/protocol";
import { headerWords, questionsOf, waitingWords } from "../asks/words";
import { type Need, needOf, permissionWhat } from "./need";
import { repoRootOf } from "../composer/place";
import { type ColourMap, colourOf, type RepoColour, repoName } from "./repo";
import type { Strip } from "../thread/groups";
import { runOf } from "./run";
import type { TailLine } from "./tail";

export type WindowState = "wants" | "failed" | "done" | "working" | "queued" | "parked" | "idle";

export type ChipTone = "plain" | "lit" | "fail";

/** what a window says of an ask, to preview it: the answer is given in the thread (design.md, the inbox in the windows) */
export type AskView = {
  /** `<host>:<ask id>` */
  key: string;
  /** the daemon's id for it, which a push tap and the window's pill name the ask by */
  id: string;
  kind: "question" | "permission";
  /** the question's own short label, when it has one; a permission's is "permission" */
  header: string | null;
  /** the question, or the permission in plain words */
  text: string;
  /** what is waiting, in the fewest words: "3 options", "2 questions", "allow once, always allow or deny" */
  waiting: string;
};

export type WindowView = {
  key: string;
  host: string;
  repo: string;
  /** the repo's project root, which its mark is read by: never a worktree's directory */
  root: string;
  colour: RepoColour;
  title: string;
  state: WindowState;
  /** null for idle, seen */
  chip: { text: string; tone: ChipTone } | null;
  /** what the clock counts from, ms: the turn's start, the ask's arrival, the park */
  since: number | null;
  /** what the body shows (run.ts): working, the run's latest lines under what you asked; done, the agent's words */
  tail: TailLine[];
  /** the working run's strip, a slot a step in order; null when the body shows words */
  strip: Strip | null;
  ask: AskView | null;
  /** what the thread needs, from every pending ask: the window's tray and the answer sheet say it (need.ts) */
  need: Need | null;
  /** queued prompts behind the running turn */
  queued: number;
  /** subagents with a turn running */
  agents: number;
  /** what a parked session waits on: agents under it still working or queued, and background jobs */
  parkedAgents: number;
  jobs: number;
  diff: { additions: number; deletions: number } | null;
  /** the reason, when the turn failed */
  failure: string | null;
  /** the note of a review waiting on a merge, the agent's own words or its branch */
  review: string | null;
  /** the retry the daemon is waiting out, in its own words */
  retry: string | null;
  /** when the session last changed, ms */
  updated: number;
};

/** facts the model does not carry yet, supplied where they are known (docs/home.md, gaps) */
export type Extra = { failure?: string; /** the note on a checkout waiting to be merged */ review?: string; seen?: boolean };

/** `colours` is the fleet's (window/colours.ts, `colourMap`), passed in by the reactive caller so the window repaints when a
    repo's colour changes */
export function windowView(entry: SessionEntry, asks: readonly Ask[], colours: ColourMap, extra: Extra = {}): WindowView {
  const info: SessionInfo = entry.info;
  const status: SessionStatus | null = entry.status;
  const ask = asks[0] ?? null;
  const busy = status?.type === "busy" || status?.type === "retry";
  const queued = status?.type === "busy" ? (status.queued ?? 0) : 0;
  const parked = status?.type === "idle" && status.parked ? status.parked : null;
  const state = stateOf({ ask: ask !== null, failure: extra.failure ?? null, busy, queued, parked: parked !== null, agents: parked?.agents ?? 0, seen: extra.seen ?? false });
  const summary = info.summary;
  const run = runOf(entry.tail, state);
  return {
    key: entry.key,
    host: entry.host,
    repo: repoName(info.projectID),
    root: repoRootOf(info),
    /* a copy: home and history hold views in stores of their own and reconcile the next one into them, which writes a
       changed colour's fields into the object the store holds. the table's own entry would be rewritten (teal becoming
       cobalt for every repo) the first time a repo's colour changes while its window is up, as the picker's preview does */
    colour: { ...colourOf({ host: entry.host, root: repoRootOf(info) }, colours) },
    title: info.title.trim() || "untitled",
    state,
    chip: chipOf(state, queued, extra.review !== undefined),
    since: sinceOf(state, status, info),
    tail: run.lines,
    strip: run.strip,
    ask: ask ? askView(ask) : null,
    need: needOf(asks),
    queued,
    agents: entry.agents,
    parkedAgents: parked?.agents ?? 0,
    jobs: parked?.jobs ?? 0,
    diff: summary && summary.additions + summary.deletions > 0 ? { additions: summary.additions, deletions: summary.deletions } : null,
    failure: state === "failed" ? (extra.failure ?? null) : null,
    review: extra.review ?? null,
    retry: status?.type === "retry" ? status.message : null,
    updated: info.time.updated,
  };
}

type Facts = { ask: boolean; failure: string | null; busy: boolean; queued: number; parked: boolean; /** agents under it at work while it waits on them */ agents: number; seen: boolean };

/** the order of these checks is the order of the inbox: an ask outranks everything, then a fault. a thread whose agents
    are at work is working, whatever the daemon calls its own turn: the person reads the work, not the scheduler */
export function stateOf(facts: Facts): WindowState {
  if (facts.ask) return "wants";
  if (facts.failure !== null) return "failed";
  if (facts.busy) return facts.queued > 0 ? "queued" : "working";
  if (facts.parked) return facts.agents > 0 ? "working" : "parked";
  return facts.seen ? "idle" : "done";
}

/** `review`: a checkout waits on a merge. a finished turn that is waiting on one is not "done", it is ready to merge: the
    chip says what the person has left to do */
export function chipOf(state: WindowState, queued: number, review = false): WindowView["chip"] {
  switch (state) {
    case "wants":
      return { text: "wants you", tone: "lit" };
    case "failed":
      return { text: "stopped", tone: "fail" };
    case "working":
      return { text: "working", tone: "plain" };
    case "queued":
      return { text: `working, ${queued} next`, tone: "plain" };
    case "parked":
      return { text: "parked", tone: "plain" };
    case "done":
      return { text: review ? "ready to merge" : "done", tone: "plain" };
    case "idle":
      return null;
    default:
      return state satisfies never;
  }
}

function sinceOf(state: WindowState, status: SessionStatus | null, info: SessionInfo): number | null {
  // working through its agents: the clock runs from when its own turn handed over to them
  if ((state === "working" || state === "queued") && status) return status.since ?? null;
  if (state === "parked" && status?.type === "idle") return status.since ?? null;
  if (state === "done" || state === "idle" || state === "failed") return info.time.updated;
  return null;
}

function askView(ask: Ask): AskView {
  const key = `${ask.host}:${ask.id}`;
  const base = { key, id: ask.id, header: headerWords(ask), waiting: waitingWords(ask) };
  if (ask.kind === "question") {
    const first = questionsOf(ask)[0]?.question;
    return { ...base, kind: "question", text: first || "the agent has a question" };
  }
  const permission = typeof ask.request.permission === "string" ? ask.request.permission : "something";
  const patterns = Array.isArray(ask.request.patterns) ? ask.request.patterns.filter((p): p is string => typeof p === "string") : [];
  return { ...base, kind: "permission", text: patterns.length > 0 ? permissionWhat(ask) : `wants to use ${permission}` };
}

/** m:ss, or h:mm:ss past an hour: the working clock and the ask's wait */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const clockFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** 23:41 */
export function clockOf(at: number): string {
  return clockFormat.format(at);
}

/** the footer's right edge: the running clock, the wait, or when it ended */
export function footClock(view: WindowView, now: number): string {
  switch (view.state) {
    case "working":
    case "queued":
      return view.since === null ? "" : elapsed(now - view.since);
    case "wants":
      return "waiting";
    case "parked":
      return view.since === null ? "" : `since ${clockOf(view.since)}`;
    case "done":
    case "failed":
    case "idle":
      return view.since === null ? "" : clockOf(view.since);
    default:
      return view.state satisfies never;
  }
}

/** what a parked window waits on, in words: "an agent", "2 agents", "a background job", "2 agents and a background job" */
export function parkedOn(view: Pick<WindowView, "parkedAgents" | "jobs">): string {
  const parts: string[] = [];
  if (view.parkedAgents) parts.push(view.parkedAgents === 1 ? "an agent" : `${view.parkedAgents} agents`);
  if (view.jobs || !parts.length) parts.push(view.jobs === 1 || !view.jobs ? "a background job" : `${view.jobs} background jobs`);
  return parts.join(" and ");
}

/** the window's accessible name: repo, title and state, so a screen reader and the drive both read it whole */
export function windowName(view: WindowView): string {
  const words: Record<WindowState, string> = {
    wants: "wants you",
    failed: view.failure ? `stopped: ${view.failure}` : "stopped",
    working: view.parkedAgents ? `working, ${view.parkedAgents === 1 ? "1 agent" : `${view.parkedAgents} agents`}` : "working",
    queued: `working, ${view.queued} next`,
    parked: `parked on ${parkedOn(view)}`,
    done: view.review !== null ? "ready to merge" : view.since === null ? "done" : `done at ${clockOf(view.since)}`,
    idle: "seen",
  };
  return `${view.repo}: ${view.title}. ${words[view.state]}`;
}
