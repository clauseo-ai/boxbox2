/* the composer's btw mode (docs/composer.md, btw): the rules that put a draft into it and take it out, and what the
   composer says while it is in it. pure, so every rule is tested (mode.test.ts); the composer reads them. */

/** the composer is offered the mode only on a thread whose agent answers btws (`capabilities.btw`), in the bar under
    it, once the thread has a turn: a new thread, or one with no message yet, has no context to ask about (and a card
    has no turn to sit in), and the sheet starts one. `turns` absent is not known here, and does not withhold it */
export function btwOffered(input: { capable: boolean; target: "session" | "new"; mount: "bar" | "sheet"; turns?: number }): boolean {
  return input.capable && input.target === "session" && input.mount === "bar" && input.turns !== 0;
}

/** the command that enters the mode, typed first in the draft and followed by white space */
export const BTW_COMMAND = "btw";
const TYPED = /^\/btw(\s)/;

/** a draft typed into the mode: `/btw ` at its start (a space, a tab or a new line after it) enters it and the prefix is
    eaten, so what follows is the question. answers the words left, or null when the draft does not enter the mode. a
    paste of `/btw why is it slow` enters it with "why is it slow". `/btwx`, `/btw` alone (still being typed) and a `/btw`
    later in the words do not */
export function typedIntoBtw(text: string): string | null {
  const m = TYPED.exec(text);
  if (!m) return null;
  // one white space is the command's end; a new line typed after it is the person's and is kept
  return m[1] === " " || m[1] === "\t" ? text.slice(5) : text.slice(4);
}

/** backspace leaves the mode when nothing is selected and the caret is before the first word: the chip is what it deletes */
export function backspaceLeaves(key: string, start: number | null, end: number | null): boolean {
  return key === "Backspace" && start === 0 && end === 0;
}

/** what the draft sends in the mode: its words alone, trimmed, or null when there is nothing to ask */
export function btwQuestion(text: string): string | null {
  const q = text.trim();
  return q ? q : null;
}

/** the words' placeholder in the mode */
export const BTW_PLACEHOLDER = "ask on the side. the agent won't see this";

/** the line above the words in the mode, where the model and effort chips stand otherwise: what answers it. short enough
    for one line at 390 px; the chip, the placeholder and the tint already say it is a btw */
export const BTW_FATE = "on this thread's model, no tools";

/** send's word in the mode */
export const BTW_SEND = "ask";

/** the chip before the words: its word, and its name, which says what a tap does */
export const BTW_CHIP = "btw";
export const BTW_CHIP_NAME = "btw, leave btw mode";

/** the slash menu's row and the plus menu's row */
export const BTW_ROW = { name: BTW_COMMAND, description: "ask on the side. the agent won't see it" } as const;
