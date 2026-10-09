/* the asks the stories put to a thread: the recorded one ("which greeting", two options) and two a real agent writes,
   which the recording does not hold. a long question with options that each explain themselves is what an agent
   asks when a request is ambiguous, and it is the shape that broke the window when the window held the card; two
   questions in one ask is the other shape the daemon takes (cmx2's question tool: one list of answers per question).
   the words are written to be as long as the longest real ones, in neutral names (nothing identifies a real person or project). */

import type { Ask, Message, SessionEntry } from "../../../sync/protocol";
import type { Fleet, ThreadView } from "../../../sync/reducer";

export type Question = { header: string; question: string; options: Array<{ label: string; description: string }>; custom: boolean; multiple?: boolean };

/** a header, a question of four lines at a phone's width, and three options that each take three to five lines */
export const LONG_ASK: Question[] = [
  {
    header: "message got cut off",
    question:
      "Your message stopped at \"we don't have access to...\". What can't we access? It changes what I tell the scouts that are reading code right now, and how I plan the integration and the evals.",
    options: [
      {
        label: "The vendor's docx skill",
        description: "It's under a proprietary licence, so drop it from the research completely, not even as a source of ideas, and focus only on code we can actually use.",
      },
      {
        label: "The vendor's features in our harness",
        description:
          "The harness can't use features the vendor runs on its own servers, such as code execution or tools the model calls from code (e.g. through a cloud provider). The integration has to rely only on our own sandbox and tools.",
      },
      {
        label: "The vendor's models at all",
        description: "No access for now (vendor or quota). Drop the vendor from the eval model list and from assumptions about the harness, and use the other vendors.",
      },
    ],
    custom: true,
  },
];

/** two questions in one ask: each is answered, then one tap sends both */
export const TWO_QUESTIONS: Question[] = [
  {
    header: "models",
    question: "Which models should the eval run against first, given that the quota resets on the first of the month?",
    options: [
      { label: "The two cheapest", description: "A full pass costs a tenth of the budget, so a bad prompt shows up before it costs anything." },
      { label: "All four", description: "One pass over everything now. It uses most of this month's quota and leaves nothing for a rerun." },
      { label: "Only the newest", description: "The one the product will ship with. Quick, but it says nothing about the others." },
    ],
    custom: true,
  },
  {
    header: "where it runs",
    question: "Where should the eval run?",
    options: [
      { label: "On this machine", description: "Slower, and the laptop is busy while it runs." },
      { label: "On the build machine", description: "Faster, but it needs the sandbox image pushed there first." },
    ],
    custom: true,
  },
];

/** the fleet's ask with its questions replaced: the ask the window previews and the stage answers */
export function askWith(ask: Ask, questions: readonly Question[]): Ask {
  return { ...ask, request: { ...ask.request, questions } };
}

/** the fleet with every pending ask asking `questions` instead of what was recorded; no questions, the fleet as it was */
export function fleetAsking(fleet: Fleet, questions?: readonly Question[]): Fleet {
  if (!questions) return fleet;
  return { ...fleet, asks: Object.fromEntries(Object.entries(fleet.asks).map(([id, ask]) => [id, askWith(ask, questions)])) };
}

/** the thread as the daemon holds it while it waits: a question step running at its end, joined to the ask by the
    callID the ask names (rows.ts, askOn). the recorded transcript ends before the question was put, and its last message is a
    turn that was stopped. with `running`, the step is the turn that is running now and the stop is not copied onto it, so the
    stage's live turn is this one, and its newest row, the ask, opens by itself when its ask is raised */
export function asking(thread: ThreadView, ask: Ask, running = false): ThreadView {
  const tool = ask.request["tool"] as { messageID?: string; callID?: string } | undefined;
  const last = thread.messages.at(-1);
  if (!last || !tool?.callID) return thread;
  const messageID = tool.messageID ?? "msg_ask";
  const start = (last.info.time.completed ?? last.info.time.created) + 60_000;
  const { error: _stopped, finish: _finish, ...now } = last.info as Record<string, unknown>;
  const message = {
    info: { ...(running ? now : last.info), id: messageID, time: { created: start } },
    parts: [{ type: "tool", id: `prt_${messageID}`, sessionID: last.info.sessionID, messageID, tool: "question", callID: tool.callID, state: { status: "running", input: { questions: ask.request["questions"] }, time: { start } } }],
  } as unknown as Message;
  return { ...thread, messages: [...thread.messages, message] };
}

/** the agent a thread started in the stories that open its thread over its parent's: the id of its session */
export const AGENT_ID = "ses_agent_reads_notes";
/** its title, which the layer it opens in is named by ("thread: reads the notes") */
export const AGENT_TITLE = "reads the notes";

/** the fleet with an agent under `parentKey`: a session of its own that names the thread as its parent, which is how the stage finds
    the threads' agents and draws the doors to them (live.ts, childKeys). it has no window of its own, as no agent has */
export function withAgentSession(fleet: Fleet, parentKey: string): { fleet: Fleet; key: string } {
  const parent = fleet.sessions[parentKey];
  if (!parent) throw new Error(`no session ${parentKey} to start an agent under`);
  const key = `${parent.host}:${AGENT_ID}`;
  const at = parent.info.time.updated;
  const entry: SessionEntry = {
    ...parent,
    id: AGENT_ID,
    key,
    info: { ...parent.info, id: AGENT_ID, slug: "reads-notes", parentID: parent.id, title: AGENT_TITLE, time: { created: at - 60_000, updated: at }, status: { type: "idle" } },
    status: { type: "idle", since: at },
    tail: [],
    needs: [],
  };
  return { fleet: { ...fleet, sessions: { ...fleet.sessions, [key]: entry } }, key };
}

/** the thread with the step that started that agent: a spawn_agent tool part naming its session, which the stage draws as the
    agent's row, and opens, by its door, as the agent's own thread */
export function withAgentStep(thread: ThreadView): ThreadView {
  const last = thread.messages.at(-1);
  if (!last) return thread;
  const start = (last.info.time.completed ?? last.info.time.created) + 30_000;
  const message = {
    info: { ...last.info, id: "msg_spawn", time: { created: start, completed: start + 400 } },
    parts: [
      {
        type: "tool",
        id: "prt_spawn",
        sessionID: last.info.sessionID,
        messageID: "msg_spawn",
        tool: "spawn_agent",
        callID: "call_spawn",
        state: {
          status: "completed",
          input: { task_name: "reads_the_notes", message: "read the notes and say what they hold" },
          output: "started reads_the_notes",
          metadata: { child_session_id: AGENT_ID, agents: [{ name: "reads_the_notes", seat: "worker", id: AGENT_ID }] },
          time: { start, end: start + 400 },
        },
      },
    ],
  } as unknown as Message;
  return { ...thread, messages: [...thread.messages, message] };
}
