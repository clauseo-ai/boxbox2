/* the voice note stories (docs/thread.md, voice notes): one per state. `bun .ladle/shots.ts --prefix assistant-voice--`
   shoots them. written with createElement: this file is react (ladle's host) and the project's jsx is solid's. */

import { story } from "./host";
import * as m from "./voice-mount";

export default { title: "assistant-voice" };

export const MineSent = story(m.mineSent);
export const MineFromChannel = story(m.mineFromChannel);
export const MineSending = story(m.mineSending);
export const MineNotSent = story(m.mineNotSent);
export const MineTranscriptOpen = story(m.mineTranscriptOpen);
export const AgentSettled = story(m.agentSettled);
export const AgentNoPeaksYet = story(m.agentNoPeaksYet);
export const AgentSpokenOpen = story(m.agentSpokenOpen);
export const Pending = story(m.pending);
export const Missing = story(m.missing);
export const Evicted = story(m.evicted);
export const Playing = story(m.playing);
export const Paused = story(m.paused);
export const PlayOn = story(m.playOn);
