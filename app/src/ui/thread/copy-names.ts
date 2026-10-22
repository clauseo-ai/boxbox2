/* the names of the copy controls (docs/thread.md, accessibility). a control's base name says what it copies; the page tells namesakes
   apart the way the ledger's rows are told apart (ledger.ts, namesOf): the first keeps its plain name, then "again", "third time", in
   document order (copy-run.ts, renameAll): code blocks are told apart that way, and so is anything else that shares a name, which a row's and a turn's names make rare. pure; no dom. */

/** the closed set of what a copy control copies: telemetry would carry one of these and never the text, if boxbox ever counted copies (it does not: schema.ts has no kind for a client's own action of this sort) */
export type CopyKind = "code" | "reply" | "report" | "command" | "output" | "file" | "brief" | "message" | "question";

/** "copy the typescript code"; "copy the elixir code" for a word hljs does not know (as the author wrote it); "copy the code" for a fence with no word */
export const nameOf = (label: string | undefined): string => (label ? `copy the ${label} code` : "copy the code");

/** a command's and its output's controls take their row's name, which the page already tells apart from every other row's and which holds still ("run bun test, 54 passed", then "run bun test, 54 passed, again") */
export const commandLabel = (row: string): string => `copy the command, ${row}`;
export const outputLabel = (row: string): string => `copy the output, ${row}`;
/** a reply is named by its turn the way the turns list is: its clock and the first line of the prompt */
export const replyLabel = (clock: string, prompt: string): string => `copy the reply, ${clock}, ${prompt.split("\n").find((l) => l.trim())?.trim().slice(0, 40) || "an image"}`;
/** an ask's question, by its words as a reader hears them (asks/words.ts, plainWords): "copy the question, which models should the eval run..."; several questions in one ask are one control each, told apart by their own words */
export const questionCopyLabel = (plain: string): string => {
  const flat = plain.replace(/\s+/g, " ").trim();
  if (!flat) return "copy the question";
  const cut = flat.length <= 48 ? flat : `${flat.slice(0, 48).replace(/\s+\S*$/, "").replace(/[\s,;:.]+$/, "")}...`;
  return `copy the question, ${cut}`;
};
/** a report card's, or a note's, copy control: "copy helper's report" */
export const reportLabel = (agent: string, note: boolean): string => `copy ${agent}'s ${note ? "note" : "report"}`;
