/* the react host of a stage story over the shell's thread story (shell/stories/mount.tsx): `then` runs on the store, and on the
   page, once the shell is up. ladle's hosts are react; the stage inside is solid */

import "../../../shell/stories/server";
import { type ReactElement, createElement, useEffect, useRef } from "react";
import { mountShell } from "../../../shell/stories/mount";
import { state } from "../../../store";

export function onShell(then: (key: string, el: HTMLElement) => void): () => ReactElement {
  return () => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      const stop = mountShell(el, "thread");
      let gone = false;
      void (async () => {
        while (!gone && !el.dataset["ready"]) await new Promise((r) => setTimeout(r, 50));
        const key = state.openThread;
        if (!gone && key) then(key, el);
      })();
      return () => { gone = true; stop(); };
    }, []);
    return createElement("div", { ref, className: "shell-story" });
  };
}
