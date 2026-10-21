/* far turns (docs/thread.md, the window: far turns): a filled turn more than FAR_SCREENS from the view, which holds nothing of the
   reader's, is let go to a text-only stand-in at the height it measured, and filled again when it comes back within range, when focus
   goes into it or when a pointer comes over it. this file is what the window reads at once; what of the reader's a turn holds, and the stand-in, are
   far-dom.ts and far-turn.tsx, chunks fetched when the first turn is let go. */

/** a filled turn this many screens from the view, above or below, becomes a stand-in */
export const FAR_SCREENS = 6;
/** how long a turn has been out of range before it is let go: a reader scrolling back and forth past the edge does not make it twice */
export const FAR_AFTER_MS = 1000;
/** turns let go in one task, so a long scroll does not make one long task of them */
export const FAR_PER_TASK = 4;

/** a copy control the turn had, which its stand-in keeps as a hidden mark: its namesakes on the rest of the page keep their names */
export type FarCopy = { kind: string; name: string };
/** what a stand-in is made at: the height the turn measured, and the copy controls it held, in order */
export type FarTurn = { height: number; copies: readonly FarCopy[] };

/** the bubble clamps a long prompt, which "show all" opens (thread.tsx, YouBubble) */
export const longPrompt = (prompt: string): boolean => prompt.length > 300 || prompt.split("\n").length > 6;
