/* home's stories (docs/home.md, verification): one per window state in
   design.md's table, each at deck, strip and rail sizes, then the whole of
   home as the journal ended, offline, after a protocol break, and with a
   repo name too long for a phone's bar. all of them paint from the journal
   recorded against a real daemon. written with createElement: this file is
   react (ladle's host) and the project's jsx is solid's. */

import { createElement, type ReactElement, useEffect, useRef } from "react";
import { type HomeStory, mountGlass, mountHome, mountMoments, mountReplay, mountState, type StateStory } from "./mount";
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
export const HomeNextQuiet = home("next-quiet");
export const HomeNextBusy = home("next-busy");
export const HomeNextEmpty = home("next-empty");
export const HomeNextOffline = home("next-offline");
export const HomeNextRepoMenu = home("next-menu");
export const HomeNextTypedToken = home("next-typed");
export const HomeNextFromThread = home("next-back");
export const HomeLongAsk = home("ask-long");
export const HomeAnswerSheet = home("answer");
export const HomeSpawnOnlyAgent = home("stray");
export const HomeAnswerSheetTwoQuestions = home("answer-two");
export const HomeTwoQuestions = home("ask-two");
export const HomeOffline = home("offline");
export const HomeUpdated = home("reload");
export const HomeLongRepoName = home("long");
export const HomeStaleThreadUrl = home("stale");
export const HomeCrowdedBar = home("crowd");
export const HomeFirstLeaves = home("gone");
export const HomeEmpty = home("empty");
export const HomeHeavyThreads = home("heavy");
export const HomeWindowsHidden = home("windows-hidden");
export const HomeInspectorFolded = home("inspector-folded");
export const HomeWindowsHiddenInspectorFolded = home("hidden-inspector-folded");
export const HomeInspectorTurns = home("inspector-turns");
export const HomeStripFolded = home("strip-folded");
export const HomeDetailsByWidth = home("details");
export const HomeWorkingFoldOpen = home("fold-open");
export const HomeWorkingFoldOff = home("fold-off");
export const HomeClearedWhileAway = home("away");
export const HomeClearedWhileAwaySheet = home("away-open");
export const HomeUndoToastOne = home("toast");
export const HomeUndoToastMany = home("toast-many");
export const HomeGlassControls = () => createElement(Host, { mount: mountGlass });
export const HomeLiveReplay = () => createElement(Host, { mount: mountReplay });
export const HomeLiveMoments = () => createElement(Host, { mount: mountMoments });

export default { title: "home" };
