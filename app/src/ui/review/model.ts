/* the review card's words and shapes (docs/design.md, the earned moments; the
   needs table). an agent in a checkout asked for review; the server reads the
   checkout and merges or discards it. everything here is pure so it is tested
   without a browser: what the card says of the wire shapes (generated, in
   app/src/api), how a refusal reads, and the patch cut into lines to paint. */

import type { components } from "../../api/boxbox";

/* numbers and counts, here and not from the thread's rows: the card is a chunk of its own, and importing the thread's
   module graph from it would split that graph out of the first load's chunk */
const numbers = new Intl.NumberFormat("en-US");
export const n = (x: number): string => numbers.format(x);
export const plural = (k: number, one: string, many = `${one}s`): string => `${n(k)} ${k === 1 ? one : many}`;

type Schemas = components["schemas"];

/** GET .../review: what merging would do */
export type Review = Schemas["WorktreeReview"];
export type ReviewFile = Schemas["WorktreeFile"];
/** POST .../review/merge */
export type Merged = Schemas["WorktreeMerged"];
/** POST .../review/discard */
export type Discarded = Schemas["WorktreeDiscarded"];

/** why a call did not do its work, in words the card shows */
export type Problem = {
  /** `gone` is the checkout itself: the daemon no longer has it */
  kind: "busy" | "conflict" | "refused" | "gone" | "other" | "offline";
  text: string;
  /** the files a conflict names */
  files: string[];
};

/** the one line a card keeps when the daemon no longer has its checkout */
export const GONE_LINE = "this checkout is gone";

export const UNREACHABLE = "the boxbox server is not answering. check it is running, then try again.";

/** what the card shows as its state; `error` is a problem kept beside it, not a phase */
export type Phase = "reading" | "ready" | "merging" | "discarding" | "merged" | "discarded" | "gone";

/** the phases that must outlive the need: a merge serves it, and the card folds into its line instead of leaving. a checkout
    that is gone is one too: the server serves its need in the same answer that says so, so a line that left with the need
    would be painted for one frame, and the window that said "ready to merge" would open on nothing that says why */
export const holds = (phase: Phase): boolean => phase === "merging" || phase === "discarding" || phase === "merged" || phase === "discarded" || phase === "gone";

/** the folded line after a merge: "merged into main", and what it stopped on the way. `into` on the wire is the path where
    the base is checked out, not a name a person reads */
export function mergedLine(result: Merged): string {
  const stopped = result.stopped.length ? `, stopped ${plural(result.stopped.length, "process", "processes")}` : "";
  return `merged into ${result.base}${stopped}`;
}

/** the folded line after a discard: where the work went, when the server kept it */
export function discardedLine(result: Discarded): string {
  const kept = result.ref || result.snapshot;
  const stopped = result.stopped.length ? `, stopped ${plural(result.stopped.length, "process", "processes")}` : "";
  return `${kept ? `discarded. the work is kept at ${kept}` : "discarded"}${stopped}`;
}

/* ---------- a refusal in words ---------- */

type Body = Record<string, unknown> | null | undefined;

/** why the daemon refused a merge (`CheckoutRefusal.reason`), and what to do about it */
const REFUSALS: Record<string, string> = {
  dirty: "the checkout has changes that are not committed. the agent has to commit or drop them before this can merge.",
  nothing: "there is nothing to merge: the branch holds no commits beyond its base.",
  detached: "the checkout is not on a branch, so there is nothing to merge.",
  target_dirty: "the branch this merges into has changes that are not committed. commit or stash them there, then merge.",
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** the error body, in either shape the server speaks: `{ error: "busy", message }` or the house's `{ error: { code, message } }` */
export function problemOf(status: number, body: Body, action: "merge" | "discard" | "read" = "merge"): Problem {
  const error = body?.["error"];
  const nested = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const code = text(nested?.["code"]) ?? text(error) ?? "";
  const message = text(nested?.["message"]) ?? text(body?.["message"]);
  const reason = text(nested?.["reason"]) ?? text(body?.["reason"]);
  const rawFiles = nested?.["files"] ?? body?.["files"];
  const files = Array.isArray(rawFiles) ? rawFiles.filter((f): f is string => typeof f === "string") : [];
  // the daemon no longer has the checkout: it was merged or discarded already, here or from another device
  if (status === 404 && code === "no-such-checkout") return { kind: "gone", text: `${GONE_LINE}. it was merged or discarded already.`, files: [] };
  if (status === 404) return { kind: "other", text: message ?? "that thread is not on its machine any more. it may have been archived.", files: [] };
  if (status === 409 && code === "busy") return { kind: "busy", text: `the agent is mid-turn. let it finish or stop it, then ${action === "discard" ? "discard" : "merge"} again.`, files: [] };
  if (status === 409 && code === "conflict") return { kind: "conflict", text: files.length ? `the merge stopped on a conflict in ${plural(files.length, "file")}. nothing was merged.` : "the merge stopped on a conflict. nothing was merged.", files };
  if (status === 409 && code === "refused") return { kind: "refused", text: (reason && REFUSALS[reason]) || message || reason || `the ${action} was refused.`, files: [] };
  return { kind: "other", text: message ?? `the server answered ${status}. try again.`, files: [] };
}

/** nothing came back at all */
export const offline = (): Problem => ({ kind: "offline", text: UNREACHABLE, files: [] });
