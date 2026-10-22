/* a promoted message's words as the thread shows them (docs/thread.md, btw: the promoted message). apart from words.ts,
   which only the lazily loaded card reads: every turn's bubble, copy name, ruler and stand-in read this, so it is in the
   first load and the card's words are not (architecture.md, the script budget) */
/* what cmx2 puts in the thread when a btw is promoted (packages/server/src/btw.ts, promotedText): a plain framing for the
   agent, then the question, then the answer as markdown */
const PROMOTED = /^btw, i asked this on the side[^\n]*\n\nmy question:\n([\s\S]*?)\n\nthe answer:\n([\s\S]*)$/;

/** a promoted message's question and answer, read out of that framing; null when the words are not in it (another
    source's framing, or a message edited since). the bubble shows the question; the answer is the card's, a tap away */
export function promotedParts(prompt: string): { question: string; answer: string } | null {
  const m = PROMOTED.exec(prompt);
  return m ? { question: (m[1] ?? "").trim(), answer: (m[2] ?? "").trim() } : null;
}

/** what a turn's prompt reads as wherever it is shown or named (the bubble, the reply's copy name, the turns list and the
    ruler, a far turn's stand-in): a message added from a btw is its question, never cmx2's framing for the agent */
export function shownPrompt(turn: { prompt: string; btw?: string | undefined }): string {
  return (turn.btw ? promotedParts(turn.prompt)?.question : undefined) ?? turn.prompt;
}
