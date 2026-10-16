/* the recorder's stories (docs/composer.md, recording): the mic key and every state of the recorder, on the real
   MediaRecorder fed by a stream the page makes. `bun .ladle/shots.ts --prefix assistant-composer--` shoots them. */

import * as m from "./composer-mount";
import { story } from "./host";

export default { title: "assistant-composer" };

export const MicIdle = story(m.micIdle);
export const DraftSends = story(m.draftSends);
export const NoVoiceNotes = story(m.noVoiceNotes);
export const NoRecorder = story(m.noRecorder);
export const Sheet = story(m.sheet);
export const Holding = story(m.holding);
export const SlidingToCancel = story(m.slidingToCancel);
export const Locking = story(m.locking);
export const Locked = story(m.locked);
export const LockedByShortcut = story(m.lockedByShortcut);
export const NearTheCap = story(m.nearTheCap);
export const AtTheCap = story(m.atTheCap);
export const Interrupted = story(m.interrupted);
export const TooShort = story(m.tooShort);
export const Refused = story(m.refused);
export const SentNote = story(m.sentNote);
export const HoldReleasedSends = story(m.holdReleasedSends);
export const ThinkingDial = story(m.thinkingDial);
export const RealMicrophone = story(m.realMicrophone);
