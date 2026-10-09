/* the review card's stories (docs/design.md, the needs table and the earned
   moments), one per state: ready, with a note and with only the branch, dirty,
   a merge that will not be clean, the patch open and cut, a merge in flight, the
   conflict, busy, refused and unreachable answers, the question before a
   discard, a discard in flight, and the two folded lines. the card is the real
   one over the real control; only the server is made up (host.tsx). this file
   is react (ladle's host) and mounts the solid tree. */

import { type ReactElement, createElement, useEffect, useRef } from "react";
import { type Scenario, mountReview } from "./host";
import { merged, NOTE, review } from "./fixtures";

export default { title: "review" };

type Story = (() => ReactElement) & { storyName?: string };

function story(name: string, scenario: Scenario): Story {
  const S: Story = () => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = ref.current;
      return el ? mountReview(el, scenario) : undefined;
    }, []);
    return createElement("div", { ref, "data-story": name });
  };
  S.storyName = name;
  return S;
}

export const Ready = story("ready", { review, note: NOTE });
export const ReadyWide = story("ready, wide", { review, note: NOTE, wide: true });
export const OnlyTheBranch = story("no note, only the branch", { review });
export const Dirty = story("dirty checkout", { review: { ...review, dirty: true }, note: NOTE });
export const NotClean = story("will not merge cleanly", { review: { ...review, mergeable: false }, note: NOTE });
export const PatchOpen = story("the patch open", { review, note: NOTE, play: ["patch"] });
export const PatchCut = story("the patch cut by the server", { review: { ...review, truncated: true }, note: NOTE, play: ["patch"] });
export const Empty = story("nothing to merge yet", { review: { ...review, commits: 0, files: [], additions: 0, deletions: 0, diff: "" }, note: NOTE });
export const Reading = story("reading the checkout", { review: null, note: NOTE });
export const Merging = story("merging", { review, note: NOTE, play: ["merge"] });
export const Merged_ = story("merged", { review, note: NOTE, merge: { ok: true, value: merged }, play: ["merge"] });
export const MergedStopped = story("merged, stopped a process", { review, note: NOTE, merge: { ok: true, value: { ...merged, stopped: ["dev server"] } }, play: ["merge"] });
export const Conflict = story("conflict", { review, note: NOTE, merge: { ok: false, problem: { kind: "conflict", text: "the merge stopped on a conflict in 2 files. nothing was merged.", files: ["src/ui/pricing/toggle.tsx", "docs/pricing.md"] } }, play: ["merge"] });
export const Busy = story("error, the agent is mid-turn", { review, note: NOTE, merge: { ok: false, problem: { kind: "busy", text: "the agent is mid-turn. let it finish or stop it, then merge again.", files: [] } }, play: ["merge"] });
export const Refused = story("error, refused", { review, note: NOTE, merge: { ok: false, problem: { kind: "refused", text: "the base branch has changes that are not committed. commit or stash them on main, then merge.", files: [] } }, play: ["merge"] });
export const Unreachable = story("error, server not answering", { review, note: NOTE, merge: { ok: false, problem: { kind: "offline", text: "the boxbox server is not answering. check it is running, then try again.", files: [] } }, play: ["merge"] });
export const ReadFailed = story("error, the checkout could not be read", { review: { problem: { kind: "other", text: "the host \"desk\" did not answer (timed out). check its daemon is running", files: [] } }, note: NOTE });
export const StaleChunk = story("the review did not load (a page from before an update)", { review, note: NOTE, stale: true });
export const Gone = story("the checkout is gone", { review, note: NOTE, merge: { ok: false, problem: { kind: "gone", text: "this checkout is gone. it was merged or discarded already.", files: [] } }, play: ["merge"] });
export const ReadGone = story("the checkout is gone, found on the read", { review: { problem: { kind: "gone", text: "this checkout is gone. it was merged or discarded already.", files: [] } }, note: NOTE });
export const AskingToDiscard = story("asking before a discard", { review, note: NOTE, play: ["ask"] });
export const Discarding = story("discarding", { review, note: NOTE, play: ["ask", "discard"] });
export const Discarded = story("discarded", { review, note: NOTE, discard: { ok: true, value: { discarded: true, stopped: [] } }, play: ["ask", "discard"] });
export const DiscardedKept = story("discarded, the work kept", { review, note: NOTE, discard: { ok: true, value: { discarded: true, ref: "refs/boxbox/site-fix", stopped: [] } }, play: ["ask", "discard"] });
