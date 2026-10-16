/* the stories of an assistant on home, on the agents screen and in start something (docs/home.md, assistants on home
   and the agents; docs/composer.md, start something with an agent): one per state. written with createElement through
   the shared host, since this file is react (ladle's) and the project's jsx is solid's; the solid trees are in
   ../home/stories.tsx. */

import { mountCard, mountPalettes, mountRuns, mountScreen, mountSheet, mountWantsStale, mountWindow } from "../home/stories";
import { story } from "./host";

export const WindowWantsYou = story((el) => mountWindow(el, "wants"));
export const WindowWorking = story((el) => mountWindow(el, "working"));
export const WindowDone = story((el) => mountWindow(el, "done"));
export const WindowVoicePlaying = story((el) => mountWindow(el, "playing"));
export const WindowStepFailed = story((el) => mountWindow(el, "failed"));
export const WindowFromBoxbox = story((el) => mountWindow(el, "boxbox"));
export const WindowScheduled = story((el) => mountWindow(el, "scheduled"));
export const WindowStale = story((el) => mountWindow(el, "stale"));
export const WindowWantsYouStale = story(mountWantsStale);
export const WindowRuns = story(mountRuns);
export const WindowPalettes = story(mountPalettes);

export const CardPairing = story((el) => mountCard(el, "pairing"));
export const CardSyncing = story((el) => mountCard(el, "syncing"));
export const CardReady = story((el) => mountCard(el, "ready"));
export const CardReadyAdmin = story((el) => mountCard(el, "admin"));
export const CardReadyUntested = story((el) => mountCard(el, "untested"));
export const CardConnecting = story((el) => mountCard(el, "connecting"));
export const CardDown = story((el) => mountCard(el, "down"));
export const CardRefusedProtocol = story((el) => mountCard(el, "protocol"));
export const CardRefusedMethods = story((el) => mountCard(el, "methods"));
export const CardRefusedAuth = story((el) => mountCard(el, "auth"));
export const CardRefusedKey = story((el) => mountCard(el, "key"));
export const CardRestartConfirm = story((el) => mountCard(el, "restart"));
export const CardForgetConfirm = story((el) => mountCard(el, "forget"));
export const CardReloaded = story((el) => mountCard(el, "reloaded"));
export const AgentsScreen = story((el) => mountScreen(el, false));
export const AgentsScreenEmpty = story((el) => mountScreen(el, true));

export const StartWithAssistant = story((el) => mountSheet(el, "sheet-assistant"));
export const StartWithCmx = story((el) => mountSheet(el, "sheet-cmx"));
export const StartPickerOpen = story((el) => mountSheet(el, "picker"));
export const StartPickerCmxChosen = story((el) => mountSheet(el, "picker-cmx"));
export const StartPickerWalked = story((el) => mountSheet(el, "picker-walked"));

export default { title: "assistant-home" };
