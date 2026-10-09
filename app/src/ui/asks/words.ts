/* what an ask says, read loosely from the daemon's request as it wrote
   it: a question's header, text and options, the words a window's preview
   uses for what is waiting, and the card's words for an answer that lost the
   race. pure, so it is tested without a browser. the card that answers is the thread's (ui/thread/thread.tsx);
   a window only says that an ask is there and opens the thread to it. */

import type { Ask } from "../../sync/protocol";

export type QuestionOption = { label: string; description: string | null };
export type Question = { header: string; question: string; options: QuestionOption[]; multiple: boolean; custom: boolean };

export function questionsOf(ask: Ask): Question[] {
  const raw = ask.request["questions"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q: unknown) => {
    if (typeof q !== "object" || q === null) return [];
    const item = q as Record<string, unknown>;
    const options = Array.isArray(item["options"])
      ? item["options"].flatMap((o: unknown) => {
          if (typeof o !== "object" || o === null) return [];
          const option = o as Record<string, unknown>;
          if (typeof option["label"] !== "string") return [];
          return [{ label: option["label"], description: typeof option["description"] === "string" ? option["description"] : null }];
        })
      : [];
    return [
      {
        header: typeof item["header"] === "string" ? item["header"] : "",
        question: typeof item["question"] === "string" ? item["question"] : "",
        options,
        multiple: item["multiple"] === true,
        // cmx2 always accepts a typed answer; an older daemon says so or not
        custom: item["custom"] !== false,
      },
    ];
  });
}

/** "1 option", "3 options": a count and its noun */
const counted = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** the quiet line under a window's preview: what is waiting, in the fewest words. a permission has only its three
    replies; a question says how many questions, or how many options, or that only words will do */
export function waitingWords(ask: Ask): string {
  // the card's own words for its three replies (thread.tsx, PermissionCard)
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

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "answered on iphone at 23:49": who answered first, when the daemon said who and when */
export function settledLine(by: string, at: number | null): string {
  return at === null ? `answered on ${by}` : `answered on ${by} at ${clock.format(at)}`;
}

/** an answer to an ask that is no longer there */
export function goneLine(): string {
  return "this is gone: it was answered, or its turn ended.";
}
