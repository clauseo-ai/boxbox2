/* a long thread on the real stage, for the far turns (docs/thread.md, the window: far turns): the tvos session's excerpt told eight
   times over (transcript.ts, heavyTranscripts), so a scroll through it leaves filled turns many screens behind the view. the stage
   alone (stage-alone.tsx), as a link to a thread the fleet does not hold would put it */

import { type ReactElement, createElement, useEffect, useRef } from "react";
import { mountStageAlone } from "./stage-alone";
import { heavyTranscripts } from "./transcript";

export default { title: "stage far" };

export const LongThread = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void heavyTranscripts(["long"]).then((held) => {
      const messages = held["long"]?.messages ?? [];
      if (!gone && ref.current) stop = mountStageAlone(ref.current, { followed: false, shape: (fleet, thread) => ({ fleet, thread: { ...thread, messages } }) });
    });
    return () => { gone = true; stop?.(); };
  }, []);
  return createElement("div", { ref, className: "shell-story" });
};
