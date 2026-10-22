/* the asks the stories put to a thread: the recorded one ("which greeting", two options) and two a real agent writes,
   which the recording does not hold. a long question with options that each explain themselves is what an agent
   asks when a request is ambiguous, and it is the shape that broke the window when the window held the card; two
   questions in one ask is the other shape the daemon takes (cmx2's question tool: one list of answers per question).
   the words are written to be as long as the longest real ones, in neutral names (nothing identifies a real person or project). */

import type { Ask, Message, Thread } from "../../../sync/protocol";
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

/** a question an agent writes in markdown: a link to read first, code, emphasis, and a link the sanitiser must not let through (a
    `javascript:` one is drawn as its words, not as a link) */
export const MARKDOWN_ASK: Question[] = [
  {
    header: "re-auth",
    question:
      "The deploy is paused on a one-tap re-auth: visit [the login page](https://login.example.com/a/0001) from any logged-in device, then say when it's done. It retries `ssh deploy@build-1` after, **not before**. (Ignore [this link](javascript:alert(1)), it is not one.)",
    options: [
      { label: "Done, retry now", description: "The [status page](https://status.example.com) shows the host back." },
      { label: "Skip the deploy", description: "Leave it paused and carry on with the docs." },
    ],
    custom: true,
  },
];

/** four questions in one ask, each with its label, as a real agent asks a design's open choices: what a settled ask's record has to
    hold whole, each question's words with its answer under them (the bug of 2026-10-22 showed only the labels and the answers) */
export const FOUR_QUESTIONS: Question[] = [
  {
    header: "Newer-version entries",
    question: "When the cache holds an entry written by a newer version than this one, should the reader decode what it can or drop the entry? Decoding first keeps the cache warm across an upgrade and a rollback.",
    options: [
      { label: "Version-first decode (recommended)", description: "Read the version, decode the fields it knows, keep the rest as bytes." },
      { label: "Drop newer entries", description: "Simplest, but a rollback empties the cache." },
    ],
    custom: true,
  },
  {
    header: "Unit variant growth rule",
    question: "The `Unit` enum has grown a variant per release. Do we keep the catch-all `Other(String)` or drop it and add variants as they come?",
    options: [
      { label: "Drop it, add variants (recommended)", description: "Exhaustive matches catch every new unit at compile time." },
      { label: "Keep the catch-all", description: "No release needed for a new unit, but nothing checks them." },
    ],
    custom: true,
  },
  {
    header: "Command validation",
    question: "Where should a command be validated: once, into a `ValidatedCommand` type at the edge, or at each use?",
    options: [
      { label: "ValidatedCommand type (recommended)", description: "Validated once; the type proves it everywhere after." },
      { label: "At each use", description: "No new type, but every caller repeats the checks." },
    ],
    custom: true,
  },
  {
    header: "Scope of the change request",
    question: "Which of these go into this change request? See the [design notes](https://example.com/notes) for each.",
    options: [
      { label: "All of them (recommended)", description: "One review, one migration." },
      { label: "Only the decode", description: "The smallest change that unblocks the release." },
      { label: "Decode and validation", description: "Leave the enum for its own change." },
    ],
    custom: true,
  },
];

/** the fleet's ask with its questions replaced: the ask the window previews and the stage answers */
export function askWith(ask: Ask, questions: readonly Question[]): Ask {
  return { ...ask, questions: questions.map((q) => ({ header: q.header, question: q.question, options: q.options, custom: q.custom, multiple: q.multiple ?? false })) };
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
  const tool = ask.tool;
  const last = thread.messages.at(-1);
  if (!last || !tool?.callID) return thread;
  const messageID = tool.messageID || "msg_ask";
  const start = (last.info.completed ?? last.info.created) + 60_000;
  const { error: _stopped, finish: _finish, completed: _completed, ...now } = last.info;
  const { completed: _done, ...open } = last.info;
  const message: Message = {
    info: { ...(running ? now : open), id: messageID, created: start },
    parts: [{ type: "tool", id: `prt_${messageID}`, messageID, tool: "question", family: "ask", callID: tool.callID, state: { status: "running", input: { questions: ask.questions ?? [] }, time: { start } } }],
  };
  return { ...thread, messages: [...thread.messages, message] };
}

/** the agent a thread started in the stories that open its thread over its parent's: the id of its session */
export const AGENT_ID = "ses_agent_reads_notes";
/** its title, which the layer it opens in is named by ("thread: reads the notes") */
export const AGENT_TITLE = "reads the notes";

/** the fleet with an agent under `parentKey`: a session of its own that names the thread as its parent, which is how the stage finds
    the threads' agents and draws the doors to them (live.ts, childKeys). it has no window of its own, as no agent has */
export function withAgentSession(fleet: Fleet, parentKey: string): { fleet: Fleet; key: string } {
  const parent = fleet.threads[parentKey];
  if (!parent) throw new Error(`no session ${parentKey} to start an agent under`);
  const key = `${parent.agent}:${AGENT_ID}`;
  const at = parent.updated;
  const entry: Thread = { ...parent, id: AGENT_ID, key, parent: parent.id, title: AGENT_TITLE, created: at - 60_000, updated: at, activity: { state: "idle" }, tail: [], needs: [] };
  return { fleet: { ...fleet, threads: { ...fleet.threads, [key]: entry } }, key };
}

/** the thread with the step that started that agent: a spawn_agent tool part naming its session, which the stage draws as the
    agent's row, and opens, by its door, as the agent's own thread */
export function withAgentStep(thread: ThreadView): ThreadView {
  const last = thread.messages.at(-1);
  if (!last) return thread;
  const start = (last.info.completed ?? last.info.created) + 30_000;
  const message: Message = {
    info: { ...last.info, id: "msg_spawn", created: start, completed: start + 400 },
    parts: [
      {
        type: "tool",
        id: "prt_spawn",
        messageID: "msg_spawn",
        tool: "spawn_agent",
        family: "spawn",
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
  };
  return { ...thread, messages: [...thread.messages, message] };
}
