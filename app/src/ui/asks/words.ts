/* what an ask says, read from the server's ask as it sends it: a question's header, text and options, the words a window's preview
   uses for what is waiting, and the card's words for an answer that lost the
   race. pure, so it is tested without a browser. the card that answers is ui/asks/card.tsx, drawn by the thread and by home;
   a window only says that an ask is there and opens the thread to it. */

import type { Ask } from "../../sync/protocol";

export type QuestionOption = { label: string; description: string | null };
export type Question = { header: string; question: string; options: QuestionOption[]; multiple: boolean; custom: boolean };

export function questionsOf(ask: Ask): Question[] {
  const raw = ask.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    header: item.header,
    question: item.question,
    options: item.options.map((option) => ({ label: option.label, description: option.description ?? null })),
    multiple: item.multiple,
    // the server says whether a typed answer is taken: cmx2 always takes one, and a question that does not say is taken too
    custom: item.custom,
  }));
}

/** "1 option", "3 options": a count and its noun */
const counted = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** the quiet line under a window's preview: what is waiting, in the fewest words. a permission has only its three
    replies; a question says how many questions, or how many options, or that only words will do */
export function waitingWords(ask: Ask): string {
  // the card's own words for its three replies (card.tsx, PermissionCard)
  if (ask.kind === "permission") return "allow once, always allow or deny";
  const questions = questionsOf(ask);
  if (questions.length > 1) return counted(questions.length, "question");
  const only = questions[0];
  if (!only || only.options.length === 0) return "type an answer";
  const options = counted(only.options.length, "option");
  return only.multiple ? `${options}, pick any` : options;
}

/** the question's own short label, when the daemon gave one: a permission's is "permission" */
export function headerWords(ask: Ask): string | null {
  if (ask.kind === "permission") return "permission";
  return questionsOf(ask)[0]?.header.trim() || null;
}

/** a name that stays short enough to be read aloud and listed: the words cut at the last whole word before `limit`
    characters, with "..." after them */
export function shortWords(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const at = cut.lastIndexOf(" ");
  return `${(at > limit / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}...`;
}

/** a question's markdown as the words a reader hears and a row's head shows: a link is its text, an image its alt, code and emphasis
    lose their marks, html tags go, and the lines run together. the card paints the markdown itself (question.tsx); this is for names
    and teasers, which are plain text */
export function plainWords(md: string): string {
  // an escaped mark is the mark itself, set aside first so no rule below reads it as markdown, and put back last
  return md
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)))
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:|mailto:)[^>\s]+)>/gi, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/(`+)([^`]*?)\1/g, "$2")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/^ {0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .replace(/[\ue000-\ue07f]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000))
    .trim();
}

/** what a question's copy control copies (question.tsx): the question as the agent wrote it, markdown and all, never the painted text */
export const copyOfQuestion = (q: { question: string }): string => q.question;

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "answered on iphone at 23:49": who answered first, when the daemon said who and when */
export function settledLine(by: string, at: number | null): string {
  return at === null ? `answered on ${by}` : `answered on ${by} at ${clock.format(at)}`;
}

/** an answer to an ask that is no longer there */
export function goneLine(): string {
  return "this is gone: it was answered, or its turn ended.";
}
