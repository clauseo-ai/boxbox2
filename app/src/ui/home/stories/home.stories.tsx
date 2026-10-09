/* home's stories (docs/home.md, verification): one per window state in
   design.md's table, each at deck, strip and rail sizes, then the whole of
   home as the journal ended, offline, after a protocol break, and with a
   repo name too long for a phone's bar. all of them paint from the journal
   recorded against a real daemon. written with createElement: this file is
   react (ladle's host) and the project's jsx is solid's. */

import { createElement, type ReactElement, useEffect, useRef } from "react";
import { type HomeStory, mountHome, mountMoments, mountReplay, mountState, type StateStory } from "./mount";
import "./stories.css";

function Host(props: { mount: (el: HTMLElement) => () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    return el ? props.mount(el) : undefined;
  }, [props.mount]);
  return createElement("div", { ref, className: "story" });
}

const state = (story: StateStory) => () => createElement(Host, { mount: (el: HTMLElement) => mountState(el, story) });
const home = (story: HomeStory) => () => createElement(Host, { mount: (el: HTMLElement) => mountHome(el, story) });

export const StateWorking = state("working");
export const StateWantsYou = state("wants");
export const StateWantsYouLongAsk = state("wants-long");
export const StateWantsYouTwoQuestions = state("wants-two");
export const StateDoneUnseen = state("done");
export const StateReadyToMerge = state("review");
export const StateFailed = state("failed");
export const StateQueued = state("queued");
export const StateParked = state("parked");
export const StateIdleSeen = state("idle");
export const HomeAsRecorded = home("live");
export const HomeLongAsk = home("ask-long");
export const HomeTwoQuestions = home("ask-two");
export const HomeOffline = home("offline");
export const HomeUpdated = home("reload");
export const HomeLongRepoName = home("long");
export const HomeStaleThreadUrl = home("stale");
export const HomeCrowdedBar = home("crowd");
export const HomeFirstLeaves = home("gone");
export const HomeEmpty = home("empty");
export const HomeRailFolded = home("rail-folded");
export const HomeInspectorFolded = home("inspector-folded");
export const HomeBothFolded = home("both-folded");
export const HomeInspectorTurns = home("inspector-turns");
export const HomeLiveReplay = () => createElement(Host, { mount: mountReplay });
export const HomeLiveMoments = () => createElement(Host, { mount: mountMoments });

export default { title: "home" };
