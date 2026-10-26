/* what the composer says (docs/composer.md, the direction and every state):
   its placeholder, the word on send, the line that says what send will do,
   why each queued message waits and what sends it, and which menu a draft
   opens. pure, so every sentence is tested; the voice is design.md's. */

import type { Compaction } from "../../store";
import type { TailItem } from "../../sync/protocol";
import { lastSentences } from "../window/tail";
import { withoutBlockMarks } from "./inline";

/** how the thread stands, as the composer needs it */
export type Agent = "working" | "idle" | "wants" | "offline";

/** where the composer is mounted */
export type Mount = "bar" | "sheet";

/** what tapping send will do */
export type SendWord = "send" | "queue" | "steer" | "answer" | "run" | "start" | "ask";

export function placeholder(mount: Mount, agent: Agent, repo: string, shell: boolean): string {
  // offline is said first, wherever the words are: a first message waits in the outbox as a reply does
  if (agent === "offline") return "write now, it goes when you are back";
  if (mount === "sheet") return "what should it do?";
  if (shell) return "a command";
  if (agent === "working") return "queue a message";
  if (agent === "wants") return "or answer in your own words";
  return "reply";
}

export function sendWord(mount: Mount, agent: Agent, steering: boolean, shell: boolean): SendWord {
  if (mount !== "bar") return "start";
  if (shell) return "run";
  if (steering) return "steer";
  if (agent === "working" || agent === "offline") return "queue";
  if (agent === "wants") return "answer";
  return "send";
}

/** what a typed answer sends to a question that asks `questions` things: the daemon takes one list of answers per question
    (`POST /questions/{ask}`, `answers: string[][]`), and the words are the answer to each, so none is left unanswered */
export function typedAnswers(questions: number, text: string): string[][] {
  return Array.from({ length: Math.max(1, questions) }, () => [text]);
}

/** the line above the words while you write: what send will do, before you press it. `questions` is how many the pending
    ask holds, for the line that says what an answer in words answers */
export function fateLine(mount: Mount, agent: Agent, steering: boolean, shell: boolean, waiting: number, host: string, repo: string, questions = 1): string {
  if (mount === "sheet") return "the new thread starts on";
  if (shell) return `runs on ${host}, in ${repo}. the agent reads it next turn`;
  if (steering) return "lands in the running turn, after this step";
  if (agent === "offline") return "waits on this device, and goes when the connection is back";
  if (agent === "working") return waiting > 0 ? `after this turn and the ${waiting} waiting` : "after this turn, or hold to steer";
  if (agent === "wants") return questions > 1 ? "answers the questions above" : "answers the question above";
  return "starts the next turn";
}

/** a message on its way, as the queue shows it */
export type Card = {
  /** sending: posted, not echoed; queued: the daemon holds it behind the turn; steer: it holds it for the next step;
      waiting: still on this device; failed: it did not go */
  state: "sending" | "queued" | "steer" | "waiting" | "failed";
  /** where it stands among the queued ones, 0 first */
  place: number;
  error?: string | null;
  /** photos on the message: the card holds their count and not their bytes, so a verb that sends the message again from the card
      cannot carry them, and is not offered */
  photos?: number;
  /** photos that went back to the draft because the outbox held too many: the message has its words alone, so a retry is not offered */
  photosReturned?: number;
};

/** a steer card offers run now while the turn runs and its words can go again whole */
const runsNow = (card: Card, agent: Agent): boolean => card.state === "steer" && agent === "working" && !card.photos;

/** a card's words: its label, why it waits, and what sends it. a queued message that never says why it waits
    confuses people, so no card is ever without both */
export function cardWords(card: Card, agent: Agent): { label: string; why: string } {
  switch (card.state) {
    case "failed":
      // a message whose photos went back to the draft says what to do itself, and a retry would send its words alone
      if (card.photosReturned) return { label: "not sent", why: `${card.error ?? "it did not go"}` };
      return { label: "not sent", why: `${card.error ?? "it did not go"}. retry sends it once, never twice` };
    case "waiting":
      return { label: "on this device", why: "the connection is down. it goes on its own, in order, when it is back" };
    case "sending":
      return { label: "sending", why: "on its way to the agent; it settles when the agent has it" };
    case "steer":
      // a steer waits for the next tool boundary, which a long command or a wait on agents can put far off: while the turn
      // runs, the card says the way out. the verb's two words never part at a line's end (a no-break space)
      return { label: "steer", why: runsNow(card, agent) ? "the agent reads it at its next step, without stopping. run\u00a0now stops the turn and runs it." : "the agent reads it at its next step, without stopping" };
    case "queued":
      if (agent !== "working") return { label: card.place === 0 ? "next" : "then", why: "waiting to run. run now sends it, or it goes with the next turn" };
      return card.place === 0
        ? { label: "next", why: "waiting for this turn to end. it goes on its own then, or steer it in now" }
        : { label: "then", why: `waiting behind ${card.place === 1 ? "the one above" : `${card.place} others`}. it goes on its own, in order` };
    default:
      return card.state satisfies never;
  }
}

/** what a card offers, from its state and the agent's: a message that did not go can be retried or taken back to the draft; the
    first waiting one can be steered in or stopped for (run now), a steer can be stopped for; the daemon's own can be unsent,
    and, while the draft is empty, edited: taken back into the draft with the caret in its words (an unsend named for what it
    is for; a draft that holds words has no room for them). nothing that sends the message again from the card is offered for
    one with photos, since the card cannot carry them */
export type CardVerbs = { retry: boolean; edit: boolean; editWaiting: boolean; steerNow: boolean; runNow: boolean; unsend: boolean; apart: boolean };

export function cardVerbs(card: Card, agent: Agent, draftEmpty = false): CardVerbs {
  const first = card.state === "queued" && card.place === 0 && agent === "working";
  const steerNow = first && !card.photos;
  const runNow = first || runsNow(card, agent);
  const unsend = card.state === "queued" || card.state === "steer";
  return {
    retry: card.state === "failed" && !card.photosReturned,
    edit: card.state === "failed",
    editWaiting: unsend && draftEmpty,
    steerNow,
    runNow,
    unsend,
    // a card with a verb that stops the turn puts its verbs on a row of their own, so its words keep the width
    apart: steerNow || runNow,
  };
}

/** when a waiting message goes, in the fewest words, beside its label on the queue's strip ("steer, at its next step", "next,
    after this turn"): what will happen is never left to be inferred from the label alone. one that did not go has none: its
    second line says what went wrong */
export function cardWhen(card: Card, agent: Agent): string | null {
  switch (card.state) {
    case "steer":
      return agent === "working" ? "at its next step" : "with the next turn";
    case "queued":
      if (card.place > 0) return "after the one before it";
      return agent === "working" ? "after this turn" : "waiting to run";
    case "sending":
      return "on its way";
    case "waiting":
      return "when the connection is back";
    case "failed":
      return null;
    default:
      return card.state satisfies never;
  }
}

/** the message the strip shows: one that did not go comes first, since it needs the person; else the first in line. its index,
    or -1 when nothing is on its way */
export function leadOf(cards: readonly { card: Card }[]): number {
  const failed = cards.findIndex((c) => c.card.state === "failed");
  return failed >= 0 ? failed : cards.length > 0 ? 0 : -1;
}

/** the strip's name for a screen reader: how many are on their way, and the one it shows */
export function stripName(count: number, label: string, when: string | null, text: string): string {
  const lead = when ? `${label}, ${when}` : label;
  return count > 1 ? `${count} messages on their way. ${lead}: ${text}` : `${lead}: ${text}`;
}

/** a swipe left this far (px) takes the strip's message back on letting go, as does a fling that would carry it half as far
    again; short of both it springs back */
export const UNSEND_AT = 96;

export function swipeUnsends(offset: number, velocity: number, flingMs = 180): boolean {
  return offset <= -UNSEND_AT || Math.min(0, offset + velocity * flingMs) <= -UNSEND_AT * 1.5;
}

/** the line while a drag the composer can take is over it */
export const DROP_LINE = "drop a photo or a file to add it";

/** what a composer says while this device has no room to keep drafts: what is written stays only while the page is open */
export const DRAFTS_FULL = "this device has no room left to keep drafts, so what you write here stays only while this page is open. free some space and it saves again";

/** the menu a draft opens: `/` first is a command, `@` after a space is a file, `!` first is the shell */
export function menuOf(text: string): "/" | "@" | "!" | null {
  if (text.startsWith("/") && !/\s/.test(text.slice(1))) return "/";
  if (/(^|\s)@\S*$/.test(text)) return "@";
  if (text.startsWith("!")) return "!";
  return null;
}

/** what was typed after the trigger, for the menu's filter */
export function menuQuery(text: string, menu: "/" | "@"): string {
  if (menu === "/") return text.slice(1).toLowerCase();
  return (text.match(/@(\S*)$/)?.[1] ?? "").toLowerCase();
}

/** the draft with the file it names put in place of what was typed after the last `@` */
export function withFile(text: string, path: string): string {
  return text.replace(/@\S*$/, `@${path} `);
}

/** the characters the server keeps of a streamed part (its TAIL_TEXT): a part that long has lost its start, so its first
    word may be a piece of one */
const KEPT_BY_SERVER = 280;

/** prose for the line: the last two sentences, as the window's cards cut them, and never starting inside a word. the
    server keeps a part's last 280 characters, so a long part with no sentence end in them begins mid-word: that piece
    is left out */
export function proseOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const last = lastSentences(text, 2);
  if (last.length === flat.length && text.length >= KEPT_BY_SERVER) return last.replace(/^\S*\s+/, "");
  return last;
}

/** a tail as a string that changes when anything in it does: which parts it holds and how much each has said. the
    composer compares two to know whether the tail has moved since a moment */
export function tailPrint(tail: readonly TailItem[]): string {
  return tail.map((item) => `${item.messageID}/${item.partID}/${item.text.length}`).join("|");
}

/** the tools that are never the live line: a question (asked, then settled, it is the ask card's) and the agent's own list */
const LINELESS_TOOLS: ReadonlySet<string> = new Set(["question", "todowrite", "todoread"]);

/** the live line: the newest thing the agent is doing, from the window's tail. `key` names the row it is: the text of a
    row growing is the same line, and only a new row is a new one */
export function liveLine(tail: readonly TailItem[]): { kind: string; text: string; prose: boolean; key: string } | null {
  /* the newest thing the agent is doing in the running turn that has words: the person's own prompt is not it, and what
     came before that prompt is the last turn's, not what the agent is doing now; a part announced before its first word
     (contract 5) is not a line yet, so the line never goes blank between two rows of a turn and a new row rolls in with
     its first word */
  for (let i = tail.length - 1; i >= 0; i--) {
    const item = tail[i] as TailItem;
    if (item.role === "user") {
      /* another agent's report starts a turn too, and says who sent it; a prompt of the person's own is where the running
         turn began, and what is before it is the last turn's */
      if (item.from) return { kind: "agent", text: `${item.from} reported`, prose: false, key: `${item.messageID}/${item.partID}` };
      break;
    }
    const key = `${item.messageID}/${item.partID}`;
    if (item.kind === "tool") {
      // a question is the ask card's and the agent's own list is the window's to leave out: a settled question row is never
      // the line (the window's cards hide the same tools, tail.ts)
      if (LINELESS_TOOLS.has(item.tool ?? "")) continue;
      if (item.text.trim()) return { kind: item.tool ?? "tool", text: item.text, prose: false, key };
      continue;
    }
    if (item.kind === "reasoning" || item.kind === "text") {
      // the marks are read where the line is drawn (inline.ts); a line's block marks go first, before it is cut to its last sentences
      const text = proseOf(withoutBlockMarks(item.text));
      if (text) return { kind: item.kind === "reasoning" ? "thought" : "", text, prose: true, key };
      continue;
    }
    if (item.text.trim()) return { kind: "file", text: item.text, prose: false, key };
  }
  return null;
}

export type ListState = "ready" | "loading" | "failed";

/** the effort chip and what its dial can offer. with the list here it is the model's own accepted efforts, and a model
    that takes none has no chip. without it the chip stays: the thread's current effort is known from the session, and
    the dial offers that one with the reason the rest is missing, so reasoning is never unreachable by a failed read */
/** the effort chip: its word, the levels it offers, and a note while they are not here. a thread with no level of its own
    says "effort"; a thread not yet made says "default", since the daemon picks the model's own level and does not say which
    before the thread exists (its model list carries no default effort), so the chip names the choice rather than guess it */
export function effortChoices(input: { accepted: readonly string[]; current: string | null; list: ListState; fresh?: boolean }): { show: boolean; label: string; known: string[]; note: string | null } {
  const label = input.current ?? (input.fresh ? "default" : "effort");
  if (input.list === "ready") return { show: input.accepted.length > 0, label, known: [...input.accepted], note: null };
  return { show: true, label, known: input.current ? [input.current] : [], note: input.list === "failed" ? "the effort choices did not come." : "reading the effort choices." };
}

/** a thread's context as the daemon reports it (a10): tokens in it now, the model's window, and where automatic compaction runs */
export type ContextInfo = { used: number; limit: number; compactAt?: number | null | undefined };

export type ContextFill = {
  /** the share of the window in use, 0 to 100 */
  percent: number;
  /** where automatic compaction runs, as a share of the window, when the daemon says */
  mark: number | null;
  words: string;
};

/** tokens in few characters: 842, 38k, 1.2m */
export function tokensWords(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`;
  return String(Math.max(0, Math.round(tokens)));
}

/** how full the context is, or null when the daemon did not say (an imported thread, a model with no known window) */
export function contextFill(context: ContextInfo | null | undefined): ContextFill | null {
  if (!context || !(context.limit > 0) || !(context.used >= 0)) return null;
  const share = Math.min(1, context.used / context.limit);
  const compactAt = typeof context.compactAt === "number" && context.compactAt > 0 ? context.compactAt : null;
  const mark = compactAt === null ? null : Math.min(1, compactAt / context.limit);
  const auto = compactAt === null ? "" : `, it compacts by itself at ${tokensWords(compactAt)}`;
  return { percent: Math.round(share * 100), mark: mark === null ? null : Math.round(mark * 100) / 100, words: `${tokensWords(context.used)} of ${tokensWords(context.limit)} tokens${auto}` };
}

/** the plus menu's compact row: a turn that is running cannot be compacted (the daemon refuses it), and a running
    compaction says so rather than letting it be asked twice */
export function compactMeta(agent: Agent, running: boolean, fill: ContextFill | null): string {
  if (running) return "running";
  if (agent === "offline") return "when you are back";
  if (agent !== "idle") return "after this turn";
  return fill ? `${fill.percent}% full` : "frees the context";
}

/** a clock for a wait: 8s, 1m 05s */
export function waitedWords(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** the card above the window while a thread compacts, and after: what it is doing, why it takes a while, what to do. the
    clock is apart from the words so a screen reader is not told the time every second */
export function compactionWords(compaction: Compaction, now: number): { label: string; text: string; why: string; clock: string | null } {
  switch (compaction.state) {
    case "running":
      return { label: "compacting", text: "summarising the thread so far to free the context", why: "this can take a minute.", clock: waitedWords(now - compaction.since) };
    case "failed":
      // the host often says the thread is unchanged itself; it is not said twice
      return { label: "not compacted", text: compaction.message, why: /unchanged|as it was/.test(compaction.message) ? "retry compacts it again." : "the thread is as it was. retry compacts it again.", clock: null };
    case "done":
      return { label: "compacted", text: "the summary is in the thread", why: "the context has room again.", clock: null };
    default:
      return compaction satisfies never;
  }
}
