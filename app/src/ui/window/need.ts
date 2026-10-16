/* what a window that wants you needs, said in one line (the native app's decision 24): the question itself when there is
   one, "asks 3 questions" when there are several, "wants permission to run bun test" for a permission, both halves when a
   thread asks both. read from every pending ask of the thread, not only the first, so the window never under-reports what
   the answer sheet holds. pure, so need.test.ts is the whole story. */

import type { Ask } from "../../sync/protocol";
import { headerWords, type Question, questionsOf, shortWords, waitingWords } from "../asks/words";

export type Need = {
  /** the small label above the line: the one question's header, or "permission"; none when several things wait */
  eyebrow: string | null;
  line: string;
  /** the quiet words under the line: what answering takes ("2 options", "allow once, always allow or deny"), or the several
      questions' headers */
  detail: string;
  questions: number;
  permissions: number;
  /** how many asks wait: the sheet's cards */
  asks: number;
};

/** a permission in plain words, as a verb phrase: "run bun test", "edit src/app.ts", "use webfetch" */
export function permissionWhat(ask: Ask): string {
  const permission = typeof ask.request["permission"] === "string" ? ask.request["permission"] : "something";
  const raw = ask.request["patterns"];
  const patterns = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  return patterns.length > 0 ? `${verbOf(permission)} ${patterns.join(", ")}` : `use ${permission}`;
}

function verbOf(permission: string): string {
  switch (permission) {
    case "shell":
    case "bash":
      return "run";
    case "edit":
    case "write":
      return "edit";
    case "read":
      return "read";
    case "webfetch":
      return "fetch";
    default:
      return `use ${permission} on`;
  }
}

export const asksWords = (questions: number): string => (questions === 1 ? "asks a question" : `asks ${questions} questions`);
export const wantsPermission = (what: string): string => `wants permission to ${what}`;
export const wantsPermissions = (count: number): string => `wants ${count} permissions`;

/** the several questions' headers, "models, where it runs"; the first question's words when any has none */
function headers(questions: readonly Question[]): string {
  const all = questions.map((q) => q.header.trim());
  if (all.every((h) => h !== "")) return shortWords(all.join(", "), 80);
  return shortWords(questions[0]?.question ?? "", 80);
}

/** a question with no words of its own still waits: the line says so */
const UNSAID = "the agent has a question";

export function needOf(asks: readonly Ask[]): Need | null {
  if (asks.length === 0) return null;
  const permits = asks.filter((a) => a.kind === "permission");
  const questionAsks = asks.filter((a) => a.kind !== "permission");
  // an ask whose questions do not parse is still one question waiting
  const list: Question[] = questionAsks.flatMap((a) => {
    const parsed = questionsOf(a);
    return parsed.length ? parsed : [{ header: "", question: "", options: [], multiple: false, custom: true }];
  });
  const questions = list.length;
  const permissions = permits.length;
  const base = { questions, permissions, asks: asks.length };
  if (permissions === 0) {
    const only = questionAsks[0];
    if (questions === 1 && only) return { ...base, eyebrow: headerWords(only), line: list[0]?.question || UNSAID, detail: waitingWords(only) };
    return { ...base, eyebrow: null, line: asksWords(questions), detail: headers(list) };
  }
  if (questions === 0) {
    const only = permits[0];
    if (permissions === 1 && only) return { ...base, eyebrow: "permission", line: wantsPermission(permissionWhat(only)), detail: waitingWords(only) };
    return { ...base, eyebrow: null, line: wantsPermissions(permissions), detail: shortWords(permits.map(permissionWhat).join(", "), 80) };
  }
  const half = permissions === 1 && permits[0] ? wantsPermission(permissionWhat(permits[0])) : wantsPermissions(permissions);
  return { ...base, eyebrow: null, line: `${asksWords(questions)} and ${half}`, detail: `${asks.length} asks waiting` };
}
