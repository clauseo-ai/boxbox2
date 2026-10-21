/* what this device replied to the asks it settled (docs/thread.md, every
   state: asks). the transcript keeps a question, its options and its answers,
   but never who gave them, and a permission leaves nothing of its reply but
   the tool's end: the daemon says who settled an ask only to a reply that
   lost the race (409 `settled` with `by` and `at`), and the stream's settle
   carries only the ask's id. so the device that replies keeps a record, keyed
   by the thread and the tool call the ask was raised on (the one id a settled
   row still has), and the row says "you allowed it once, on this iphone at
   17:18" for as long as the record is kept, a reload included.

   the store holds the records (`state.replies`) and the worker keeps them in
   indexeddb's outbox store under `ask:` beside the sends and the telemetry
   rows. pure, so the book's rules are tested without a browser. */

import type { Ask } from "./protocol";

/** what was replied: one list of answers per question (chosen labels or typed words), a dismissal, or a permission's reply with
    the words the person typed when they denied it */
export type Replied =
  | { k: "answers"; answers: string[][] }
  | { k: "dismissed" }
  | { k: "permit"; reply: "once" | "always" | "reject"; message?: string };

/** one record: this device's reply, who settled the ask (this device, or the device the daemon named when another answered first,
    null when it named none) and when, ms since the epoch (null when the daemon did not say) */
export type AskReply = {
  /** the thread's key, `<host>:<session>` */
  thread: string;
  /** the tool call the ask was raised on (`tool.callID`) */
  callID: string;
  askID: string;
  kind: "permission" | "question";
  reply: Replied;
  who: { here: true } | { by: string | null };
  at: number | null;
};

/** what an answer came to, as the cards' outcome says it (ui/thread/outcome.ts) */
export type ReplyOutcome = { ok: true } | { ok: false; settled?: { by: string | null; at: number | null } };

/** the most records kept: each is a few hundred bytes, so the whole book is tens of kilobytes */
export const REPLY_CAP = 200;

/** a record's key in the book: a tool call is unique within its thread */
export const replyKey = (thread: string, callID: string): string => `${thread} ${callID}`;

/** the record of a reply once the daemon has settled the ask: taken here, or answered first elsewhere. a reply whose ask is gone, or
    that was not taken for any other reason, says nothing of who settled it; nor does an ask that names no tool call */
export function replyOf(ask: Pick<Ask, "id" | "key" | "kind" | "tool"> | undefined, reply: Replied, outcome: ReplyOutcome, now: number): AskReply | null {
  if (!ask) return null;
  const callID = ask.tool?.callID;
  if (typeof callID !== "string" || !callID) return null;
  const base = { thread: ask.key, callID, askID: ask.id, kind: ask.kind, reply };
  if (outcome.ok) return { ...base, who: { here: true }, at: now };
  if (outcome.settled) return { ...base, who: { by: outcome.settled.by }, at: outcome.settled.at };
  return null;
}

/** the book with `record` kept, newest last, and the keys that fell out past the cap. a record replaces an earlier one for the same
    call (a retry, or a second reply that lost the race); the oldest go first. the book's own order is its keys' (string keys keep
    the order they were set in) */
export function keepReply(book: Readonly<Record<string, AskReply>>, record: AskReply, cap = REPLY_CAP): { book: Record<string, AskReply>; dropped: string[] } {
  const key = replyKey(record.thread, record.callID);
  const next: Record<string, AskReply> = {};
  for (const [k, r] of Object.entries(book)) if (k !== key) next[k] = r;
  next[key] = record;
  const keys = Object.keys(next);
  const dropped = keys.slice(0, Math.max(0, keys.length - cap));
  for (const k of dropped) delete next[k];
  return { book: next, dropped };
}

/** the book a launch reads back from the cache, oldest first by when each was settled, and the keys past the cap, which the cache
    lets go. a record that does not read as one is dropped too */
export function restoreReplies(loaded: readonly unknown[], cap = REPLY_CAP): { book: Record<string, AskReply>; dropped: string[] } {
  const records = loaded.filter(isReply).sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || replyKey(a.thread, a.callID).localeCompare(replyKey(b.thread, b.callID)));
  let book: Record<string, AskReply> = {};
  const dropped: string[] = [];
  for (const record of records) {
    const kept = keepReply(book, record, cap);
    book = kept.book;
    dropped.push(...kept.dropped);
  }
  return { book, dropped };
}

/** a record as it was written: a build that changes the shape must not paint a half-read one */
function isReply(value: unknown): value is AskReply {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const reply = r["reply"] as Record<string, unknown> | null | undefined;
  const who = r["who"] as Record<string, unknown> | null | undefined;
  return typeof r["thread"] === "string" && typeof r["callID"] === "string" && typeof r["askID"] === "string"
    && (r["kind"] === "permission" || r["kind"] === "question")
    && reply !== null && typeof reply === "object" && (reply["k"] === "answers" || reply["k"] === "dismissed" || reply["k"] === "permit")
    && who !== null && typeof who === "object" && ("here" in who || "by" in who)
    && (r["at"] === null || typeof r["at"] === "number");
}
