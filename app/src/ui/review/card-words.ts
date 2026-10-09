/* what only the card says: the route, the size, the warnings, a file's status, the question before a discard, and the
   patch cut for painting. a file of its own so that the card, which is a chunk loaded when a review waits, carries them,
   and the first load does not (model.ts keeps what the controller needs: the shapes, the folds and a refusal in words). */

import type { Review } from "./model";

/* counts, here and not from model.ts or the thread's rows: a value the card shares with the controller's modules is a
   value the bundler may hoist out of the first load's chunk into a chunk of its own, with the solid runtime beside it */
const numbers = new Intl.NumberFormat("en-US");
export const n = (x: number): string => numbers.format(x);
const plural = (k: number, one: string, many = `${one}s`): string => `${n(k)} ${k === 1 ? one : many}`;

/** "feature/x into main": the branch, else the checkout, then where it goes */
export function routeOf(review: Review): { from: string; to: string } {
  return { from: review.branch || review.checkout || "the checkout", to: review.base };
}

/** "3 commits, 12 files": what the change is made of */
export function sizeLine(review: Review): string {
  return `${plural(review.commits, "commit")}, ${plural(review.files.length, "file")}`;
}

/** what the card warns of before a merge, most pressing first */
export function warningsOf(review: Review): string[] {
  const out: string[] = [];
  if (review.mergeable === false) out.push(`this does not merge into ${review.base} cleanly. merging will stop on the files that clash.`);
  if (review.dirty) out.push("the checkout has changes that are not committed. the merge is refused until the agent commits or drops them.");
  if (review.commits === 0 && review.files.length === 0) out.push(`nothing here differs from ${review.base} yet.`);
  return out;
}

/** a file's change as one letter and a word: servers say "added" or "A", and an unknown status is kept as it came */
export function statusOf(status: string): { mark: string; word: string } {
  const key = status.trim().toLowerCase();
  const table: Array<[RegExp, string, string]> = [
    [/^(a|added|new|create[d]?|untracked|\?\??)$/, "A", "added"],
    [/^(m|modified|changed|edit(ed)?)$/, "M", "modified"],
    [/^(d|deleted|removed)$/, "D", "deleted"],
    [/^(r|renamed|moved)$/, "R", "renamed"],
    [/^(c|copied)$/, "C", "copied"],
  ];
  for (const [pattern, mark, word] of table) if (pattern.test(key)) return { mark, word };
  return { mark: key.slice(0, 1).toUpperCase() || "M", word: key || "changed" };
}

/** the question before a discard: what goes, and what stays */
export function discardQuestion(review: Review | null): string {
  const lost = review && (review.commits > 0 || review.files.length > 0) ? `its ${plural(review.commits, "commit")} and ${plural(review.files.length, "changed file")} leave with the checkout` : "the checkout goes";
  return `discard this checkout? ${lost}, and the agent's thread stays.`;
}

/* ---------- the patch, cut for painting ---------- */

export type PatchLine = { kind: "add" | "del" | "hunk" | "file" | "ctx"; text: string };

/** the most lines the card paints of a patch; the server caps the bytes, this caps the dom */
export const PATCH_LINES = 600;

/** a unified patch as painted lines: a line per file, hunks, additions, deletions, context. the headers between a file's
    line and its first hunk (index, ---, +++, modes) say nothing the file line does not, and are dropped. cut at `limit`
    painted lines, and says how many it left */
export function patchLines(diff: string, limit = PATCH_LINES): { lines: PatchLine[]; left: number } {
  if (!diff) return { lines: [], left: 0 };
  const lines: PatchLine[] = [];
  let left = 0;
  let header = false;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    let painted: PatchLine | null;
    if (line.startsWith("diff --git")) {
      header = true;
      painted = { kind: "file", text: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") };
    } else if (line.startsWith("@@")) {
      header = false;
      painted = { kind: "hunk", text: line };
    } else if (header) {
      painted = null;
    } else {
      painted = { kind: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx", text: line };
    }
    if (!painted) continue;
    if (lines.length < limit) lines.push(painted);
    else left++;
  }
  return { lines, left };
}

/** the totals as the card writes them: "+42 -7" */
export const totalsOf = (additions: number, deletions: number): { add: string; del: string } => ({ add: `+${n(additions)}`, del: `-${n(deletions)}` });
