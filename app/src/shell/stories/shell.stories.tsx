/* the shell's stories (docs/architecture.md, the route table): the whole
   app at each route, home, a thread open, the machines, settings and the
   terminal, opened at the phone, ipad and mac widths by the screenshot test
   (`bun run shots:shell`, app/.ladle/shell-shots.ts). written with
   createElement: this file is react (ladle's host) and the project's jsx is
   solid's. the recorded server loads first, before anything creates the
   api client. */

import "./server";
import { createElement, type ReactElement, useEffect, useRef } from "react";
import { mountShell, type ShellStory } from "./mount";

function Host(props: { story: ShellStory }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    return el ? mountShell(el, props.story) : undefined;
  }, [props.story]);
  // the story stands as the app does: #root is the viewport and the frame is its scroller (styles.css), so what opens
  // past the content (the shell picker's menu) is not cut at the content's height
  return createElement("div", { ref, className: "shell-story", style: { height: "100vh" } });
}

const at = (story: ShellStory) => () => createElement(Host, { story });

export const Home = at("home");
export const ThreadOpen = at("thread");
export const ThreadLongAsk = at("thread-ask-long");
export const ThreadTwoQuestions = at("thread-ask-two");
export const ThreadAskSettles = at("thread-ask-settles");
export const ThreadAskUnderAgent = at("thread-ask-under-agent");
export const ThreadAskSlow = at("thread-ask-slow");
export const ThreadAskCached = at("thread-ask-cached");
export const ThreadAskReset = at("thread-ask-reset");
export const ThreadAskUnseen = at("thread-ask-unseen");
export const ThreadAskGone = at("thread-ask-gone");
export const ThreadReview = at("thread-review");
export const ThreadReviewMerged = at("thread-review-merged");
export const ThreadReviewLinked = at("thread-review-linked");
export const ThreadReviewScrolled = at("thread-review-scrolled");
export const Machines = at("machines");
export const MachinesMany = at("machines-many");
export const MachinesStats = at("machines-stats");
export const MachinesStrain = at("machines-strain");
export const MachinesPairing = at("machines-pairing");
export const Settings = at("settings");
export const Terminal = at("terminal");
export const History = at("history");
export const HistoryEmpty = at("history-empty");
export const HistoryUnreached = at("history-unreached");

export default { title: "shell" };
