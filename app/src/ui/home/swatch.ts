/* a swatch is a window folded to its colour: two letters of its repo and what state it is in, which is all
   the folded rail has room for (design.md, why the stage never empties). what it says is decided here, pure,
   so a test pins it; fold.tsx draws it. */

import { clockOf, type WindowState, type WindowView } from "../window/view";

/** the first two letters of a repo's name, lowercase: "ledger" is "le", ".github" is "gi". a name with fewer than two
    letters or digits keeps what it has, and one with none ("--") falls back to its first two characters */
export function initialsOf(repo: string): string {
  const letters = [...repo].filter((c) => /[\p{L}\p{N}]/u.test(c));
  return (letters.length > 0 ? letters : [...repo]).slice(0, 2).join("").toLowerCase();
}

/** the mark on a swatch's top right corner, in the window chip's vocabulary (design.md, window states): the badge for
    a window that wants you, a tick for a finished turn nobody has seen, a dot while it works, a cross for a failure; a
    window that is parked or seen has none. form carries the state, never the colour alone */
export type Mark = "badge" | "tick" | "dot" | "cross";

export function markOf(state: WindowState): Mark | null {
  switch (state) {
    case "wants":
      return "badge";
    case "done":
      return "tick";
    case "working":
    case "queued":
      return "dot";
    case "failed":
      return "cross";
    case "parked":
    case "idle":
      return null;
    default:
      return state satisfies never;
  }
}

/** the state in words, for the card beside a swatch: the chip's own words, with the time a finished turn ended and the
    reason a failed one stopped, and "seen" where the chip says nothing */
export function stateWords(view: Pick<WindowView, "state" | "chip" | "since" | "failure" | "review">): string {
  if (view.state === "done" && view.review !== null) return "ready to merge";
  if (view.state === "done" && view.since !== null) return `done at ${clockOf(view.since)}`;
  if (view.state === "failed" && view.failure) return `stopped: ${view.failure}`;
  return view.chip?.text ?? "seen";
}
