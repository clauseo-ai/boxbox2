/* what a stage says about reading its thread (docs/thread.md, reading). two lines, apart from the stage so their rules are
   tests: the stage that has shown nothing for a while says why, what happens next, and offers retry, never "reading the
   thread." for ever; and the stage that shows a thread it cannot bring up to date, or not all of it, says so below its
   newest turn. the words are the ios app's (ThreadWords, ThreadStageModel), which took them from here. */

import type { ReadTrouble } from "../../sync/read";

/** how long a stage with nothing to show reads before it says why */
export const READING_PATIENCE_MS = 10_000;

/** why a stage that has waited its patience still shows nothing; `gone` is said at once */
export type Reading =
  /** the server answered that it does not have the thread (a 404): an agent's thread the fleet does not hold, opened by its key */
  | { kind: "gone" }
  /** the stream is down: nothing can be read until the server answers again */
  | { kind: "offline" }
  /** the read failed and is being tried again, in the server's words when it gave any */
  | { kind: "failed"; problem: string }
  /** nothing failed and nothing came: the read is still out */
  | { kind: "waiting" }
  /** the worker does not hold the thread: the client's own fault, said as such so a report of it names it */
  | { kind: "undrawn" };

export type ReadingInput = {
  /** the stage shows no turn and is not sure the thread is empty (not held, or held and still reading with nothing) */
  empty: boolean;
  /** the stage has waited its patience since it opened or since the last retry */
  stalled: boolean;
  streamDown: boolean;
  held: boolean;
  hydrating: boolean;
  trouble: ReadTrouble | undefined;
};

/** the trouble a stage with nothing to show is in, or null while it shows rows, has not waited long enough, or is simply empty */
export function readingOf(s: ReadingInput): Reading | null {
  if (!s.empty) return null;
  if (s.trouble?.gone) return { kind: "gone" };
  if (!s.stalled) return null;
  if (s.streamDown) return { kind: "offline" };
  if (!s.held) return { kind: "undrawn" };
  if (s.trouble) return { kind: "failed", problem: s.trouble.problem ?? SERVER_SILENT };
  return s.hydrating ? { kind: "waiting" } : null;
}

/** a failed read the worker had no words for */
export const SERVER_SILENT = "the server did not answer";

/** the trouble in words: the line, what happens next under it, and the status line's short form */
export function readingWords(r: Reading): { line: string; next: string; status: string } {
  const next = "it is asked for again on its own. retry asks now.";
  switch (r.kind) {
    case "gone":
      return { line: "the server cannot find this thread.", next: "it is asked for again on its own, in case it comes.", status: "not found on the server" };
    case "offline":
      return { line: "offline. the thread loads once the server answers.", next, status: "offline" };
    case "failed":
      return { line: `${r.problem.replace(/^[\s.]+|[\s.]+$/g, "")}.`, next, status: "did not load" };
    case "waiting":
      return { line: "the server has not sent this thread yet.", next, status: "still reading" };
    case "undrawn":
      return { line: "the thread came, but this screen did not draw it.", next, status: "not drawn" };
    default:
      return r satisfies never;
  }
}

export type FreshnessInput = {
  /** turns on screen: with none, the line is the empty stage's to say */
  turns: number;
  /** the stream has been down for the offline wait (stage.tsx, OFFLINE_AFTER_MS) */
  offline: boolean;
  /** the stream is live */
  live: boolean;
  /** the thread's read is failing and being tried again */
  failing: boolean;
  /** the fleet holds the thread's session */
  followed: boolean;
  /** the stream is live and has replayed what it missed (ui/caught-up.ts): until then the fleet may still bring the session */
  caughtUp: boolean;
};

export const FRESH_OFFLINE = "offline. showing the saved copy.";
export const FRESH_READING = "showing the saved copy. reading the thread again.";
export const FRESH_UNFOLLOWED = "not on home: new turns show, but whether it is working is not followed live.";

/** the line under the newest turn, or null while the stage shows the server's truth. a read that is merely out says
    nothing: the thread shows what it had and every entry the stream brings meanwhile. offline outranks a failing read,
    which outranks a thread the fleet does not follow */
export function freshnessOf(s: FreshnessInput): string | null {
  if (!s.turns) return null;
  if (s.offline) return FRESH_OFFLINE;
  if (s.live && s.failing) return FRESH_READING;
  if (s.live && s.caughtUp && !s.followed) return FRESH_UNFOLLOWED;
  return null;
}
