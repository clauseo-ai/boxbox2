/* the words of a settled question's record (docs/thread.md, every state:
   asks): what was answered ("you answered **hi**", "you dismissed it", "not
   answered: its turn ended"), where and when ("on this iphone at 17:18", "on
   ipad at 23:49" for the device the daemon named, "at 17:18" when nothing
   says who), the line a settled permission leaves ("you allowed it once",
   "you denied it: \u201cnot now\u201d"), and the control that shows the
   options as they were offered.
   pure, so they are tested without a browser. */

import type { DeviceClass } from "../../../../telemetry/schema";
import type { AskReply } from "../../sync/replies";

/** a question as its record reads it: its words, its options as offered, and what was answered (labels, or typed words) */
export type Asked = { header: string; question: string; options: ReadonlyArray<{ label: string }>; answer?: readonly string[] | undefined };

export const YOU_ANSWERED = "you answered";
export const YOU_DISMISSED = "you dismissed it";
export const NOT_ANSWERED = "not answered: its turn ended";

/** how a settled question ended */
export type Settled = "answered" | "dismissed" | "ended";

/** who settled it, as far as this device knows: this device (its reply was the one taken), the device the daemon named when another
    answered first (null when it named none), or nobody known */
export type Who = { here: true } | { by: string | null } | undefined;

/** this device as the record names it */
export function deviceName(device: DeviceClass): string {
  switch (device) {
    case "iphone": return "this iphone";
    case "ipad": return "this ipad";
    case "mac": return "this mac";
    case "android": return "this phone";
    default: return "this computer";
  }
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** the person typed these words: they are not one of the options offered */
export const typed = (answer: string, q: Asked): boolean => !q.options.some((o) => o.label === answer);

/** an answer as the record says it: the chosen labels joined, the words typed in quotes, "nothing" for none */
export function answerWords(q: Asked): string {
  const answer = q.answer ?? [];
  if (!answer.length) return "nothing";
  return answer.map((a) => (typed(a, q) ? `\u201c${a}\u201d` : a)).join(", ");
}

/** what one question of several is called in its line of the record: its short label, else its words cut short */
export function questionLabel(q: Asked): string {
  const header = q.header.trim();
  if (header) return header;
  const flat = q.question.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 47).replace(/\s+\S*$/, "")}...` : flat;
}

/** where and when it was settled: "on this iphone at 17:18", "on ipad at 23:49", "on another device", "at 17:18", or nothing */
export function recordFacts(who: Who, at: number | null | undefined, device: DeviceClass): string {
  const place = who === undefined ? undefined : "here" in who ? `on ${deviceName(device)}` : `on ${who.by ?? "another device"}`;
  const when = at !== null && at !== undefined ? `at ${clock.format(at)}` : undefined;
  return [place, when].filter((x): x is string => x !== undefined).join(" ");
}

/** what this device replied to a permission, in the record's words: "you allowed it once", "you always allowed it", "you denied
    it: \u201cnot now\u201d", "you denied it"; another device's answer is only "answered", since this device does not know what it was */
export function permitWords(record: Pick<AskReply, "reply" | "who">): string {
  if (!("here" in record.who) || record.reply.k !== "permit") return "answered";
  if (record.reply.reply === "once") return "you allowed it once";
  if (record.reply.reply === "always") return "you always allowed it";
  const words = record.reply.message?.trim() ?? "";
  return words ? `you denied it: \u201c${words}\u201d` : "you denied it";
}

/** who settled it, as a reply's record says (sync/replies.ts), in the terms recordFacts reads */
export const whoOf = (record: Pick<AskReply, "who">): Who => ("here" in record.who ? { here: true } : { by: record.who.by });

/** "show the 3 options", "show the option", "hide the options": the record opens to the options as they were offered */
export const optionsControl = (count: number, shown: boolean): string => (shown ? "hide the options" : count === 1 ? "show the option" : `show the ${count} options`);

/** what a settled question's record draws, in order: every question in its own block (its label, its words, and under them what was
    answered to it, when it was answered), then one line for an ask that was not answered. the question's words are always there,
    however it settled and however many questions it held: the record never stands in for them (bug of 2026-10-22, when several
    questions showed only their labels and the answers) */
export type RecordShape = { blocks: Array<{ header: string; question: string; answer: string | null }>; lead: string | null };
export function recordShape(how: Settled, questions: readonly Asked[]): RecordShape {
  return {
    blocks: questions.map((q) => ({ header: q.header.trim(), question: q.question, answer: how === "answered" ? answerWords(q) : null })),
    lead: how === "dismissed" ? YOU_DISMISSED : how === "ended" ? NOT_ANSWERED : null,
  };
}

/** the record in one sentence, for a screen reader and a test: "you answered hi, on this iphone at 17:18" */
export function spokenRecord(how: Settled, questions: readonly Asked[], facts: string): string {
  const tail = facts ? `, ${facts}` : "";
  if (how === "dismissed") return `${YOU_DISMISSED}${tail}`;
  if (how === "ended") return `${NOT_ANSWERED}${tail}`;
  const only = questions.length === 1 ? questions[0] : undefined;
  if (only) return `${YOU_ANSWERED} ${answerWords(only)}${tail}`;
  return `${YOU_ANSWERED} ${questions.map((q) => `${questionLabel(q)}: ${answerWords(q)}`).join("; ")}${tail}`;
}
