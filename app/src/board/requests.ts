/* how the app answers a board's request (docs/design.md, the board): the rules, pure, so they are tested apart from the
   motion that carries them out (home.tsx, shell.tsx). part of the first load: a request can arrive before the board's chunk */

import type { Fleet } from "../sync/reducer";
import { windowKeys } from "../ui/home/membership";

/** a sheet holds someone's words: text typed into any of its fields, or a photo waiting in it */
export function holdsWords(sheet: Pick<Element, "querySelectorAll" | "querySelector"> | null): boolean {
  if (!sheet) return false;
  const fields = sheet.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input[type=text]");
  for (let i = 0; i < fields.length; i++) if ((fields[i]?.value ?? "").trim() !== "") return true;
  return sheet.querySelector(".cz-photo") !== null;
}

/** what is over home when a focus comes: a sheet that holds words, an empty one, or none */
export type Over = "words" | "empty" | "none";

/** a focus never discards or buries typed words: while a sheet (the new-thread one or the answer sheet) holds words, the
    thread opens behind it and the sheet keeps the screen and its caret. an empty sheet is put away, and the caret goes to
    the thread's composer (a draft in another thread's composer is kept per thread, so moving it loses nothing) */
export function focusPlan(newThread: Over, answer: Over): { closeNewThread: boolean; closeAnswer: boolean; caret: boolean } {
  const words = newThread === "words" || answer === "words";
  return { closeNewThread: !words && newThread === "empty", closeAnswer: !words && answer === "empty", caret: !words };
}

/** a focus the app can take: home draws a window for the key now */
export const focusable = (fleet: Fleet, key: string, now: number): boolean => windowKeys(fleet, now).includes(key);

/** the host the new-thread sheet starts a thread on for a board's machine light. the light names a `label.machine`, which for
    cmx2 is the host's name, and the sheet starts threads on the fleet's hosts alone: anything else it cannot compose on */
export const composeHost = (hostNames: readonly string[], machine: string): string | null => (hostNames.includes(machine) ? machine : null);
