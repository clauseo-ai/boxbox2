/* the stage's lines about reading its thread (docs/thread.md, reading; ui/thread/reading.ts), on the real stage over the
   shell's thread story with the store moved by hand: a thread the server cannot find, one whose read keeps failing (said
   once the stage has waited its ten seconds), and the freshness line under the newest turn in each of its three cases. */

import { type ReactElement, createElement, useEffect, useRef } from "react";
import { applyPatches, setStream, state } from "../../../store";
import { onShell } from "./on-shell";
import { mountStageAlone } from "./stage-alone";

export default { title: "stage" };

const empty = (key: string, trouble: { gone: boolean; problem: string | null }) => applyPatches([{ path: ["threads", key], value: { key, status: "hydrating", messages: [], trouble } }]);

/** an agent's thread the fleet does not hold, opened by its key, that the server answered it does not have: said at once */
export const ReadingNotFound = onShell((key) => empty(key, { gone: true, problem: null }));

/** a read that keeps failing: after ten seconds the stage says why in the server's words, what happens next, and offers retry */
export const ReadingFailed = onShell((key) => empty(key, { gone: false, problem: "vm-a is not answering" }));

/** the stream has been down past the offline wait: the saved copy is what shows */
export const FreshOffline = onShell(() => setStream({ state: "down", since: Date.now() - 6000, lastEventAt: state.stream.lastEventAt }));

/** a read of a thread shown from the cache is failing and being tried again */
export const FreshReadingAgain = onShell((key) => applyPatches([{ path: ["threads", key, "status"], value: "hydrating" }, { path: ["threads", key, "trouble"], value: { gone: false, problem: "vm-a is not answering" } }]));

/** a thread the fleet does not hold (older than its host's newest 300, opened by a link): its working state is not followed.
    home draws a stage only for a window it has, so this is the stage alone */
export const FreshNotFollowed = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? mountStageAlone(ref.current, { followed: false }) : undefined), []);
  return createElement("div", { ref, className: "shell-story" });
};

/** the place line of a thread whose folder is the disk's root, or a home folder: a word (the machine, "home"), never a lone "/".
    its first turn alone, so the title block above it is in view */
const inFolder = (directory: string) => (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? mountStageAlone(ref.current, { followed: true, shape: (fleet, thread, key) => {
    const s = fleet.threads[key];
    /* cmx2's project id and directory both the folder: the place's root and directory, as the server's translate makes them */
    return { fleet: s ? { ...fleet, threads: { ...fleet.threads, [key]: { ...s, place: { ...(s.place ?? { name: "" }), root: directory, directory } } } } : fleet, thread: { ...thread, messages: thread.messages.slice(0, 2) } };
  } }) : undefined), []);
  return createElement("div", { ref, className: "shell-story" });
};
export const PlaceRoot = inFolder("/");
export const PlaceHome = inFolder("/Users/rohan");

/** an agent's thread the fleet does not hold, opened over its parent by its key: back and the title block name the parent */
export const AgentNotInFleet = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? mountStageAlone(ref.current, { followed: false, agent: true }) : undefined), []);
  return createElement("div", { ref, className: "shell-story" });
};
