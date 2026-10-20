/* the dom write stories (docs/home.md, verification): the whole app at home, and at a thread with its composer, while a
   seeded fleet streams under it (fixtures/fleet-sim.ts, the reducer's changed-leaf frames, a step every 50 ms, merged
   into the recorded fleet) and, on the thread, a reply streams into the open thread by appends the way the worker sends
   them while the person types into the composer. a MutationObserver counts every attribute and text write and the ones that set the value already there
   (writes-probe.ts); the host publishes them as `data-total`, `data-same`, `data-text`, `data-same-text` and `data-by`
   (the same-value writes by element and attribute, as json), and `data-done` once the run has played. after every batch
   it reads the names those writes set against what the store says they must be (`landed`), renames a window now and then
   and settles the reply at the end, so a change that does happen is on the page in its own batch: `data-looked`,
   `data-renames`, and `data-stale-count` with the first few in `data-stale`. the shots' check holds the same-value writes
   and the stale names at 0 */

import "../../../shell/stories/server";
import { type ReactElement, createElement, useEffect, useRef } from "react";
import { mountShell } from "../../../shell/stories/mount";
import { applyPatches, state } from "../../../store";
import type { Message } from "../../../sync/protocol";
import type { Patch } from "../../../sync/reducer";
import journal from "../fixtures/journal.ndjson?raw";
import { simulate } from "../fixtures/fleet-sim";
import { clearName, doneLabel, doneName, nameSuffixes } from "../../window/clearing";
import { repoName } from "../../window/repo";
import { probeWrites } from "./writes-probe";

export default { title: "writes" };

const STEP_MS = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const param = (name: string): number => Number(new URLSearchParams(location.search).get(name) ?? "");

/** what the names a write now sets only on change must say, worked out from the store alone, read right after a batch: each
    window's clear (clear.tsx, the same windows and suffixes) and the bar's "clear N", whose name and words name one count.
    returns how many it looked at and what disagreed */
function landed(root: HTMLElement): { looked: number; stale: string[] } {
  const showHost = state.fleet.hostNames.length > 1;
  const windows = state.fleet.order.flatMap((key) => {
    const entry = state.fleet.sessions[key];
    return entry ? [{ key, host: entry.host, repo: repoName(entry.info.projectID), title: entry.info.title.trim() || "untitled" }] : [];
  });
  const suffixes = nameSuffixes(windows, showHost);
  const byKey = new Map(windows.map((w) => [w.key, w]));
  const stale: string[] = [];
  let looked = 0;
  for (const button of root.querySelectorAll<HTMLElement>(".win[data-key] .wclear")) {
    const key = button.closest<HTMLElement>(".win")?.dataset["key"] ?? "";
    const view = byKey.get(key);
    if (!view) continue;
    looked++;
    const want = clearName(view, showHost, suffixes.get(key) ?? "");
    if (button.getAttribute("aria-label") !== want) stale.push(`${want} read ${button.getAttribute("aria-label") ?? "nothing"}`);
  }
  for (const pill of root.querySelectorAll<HTMLElement>(".pill[data-clears=done]")) {
    looked++;
    const count = Number(/\d+/.exec(pill.textContent ?? "")?.[0] ?? "-1");
    if (pill.textContent?.trim() !== doneLabel(count) || pill.getAttribute("aria-label") !== doneName(count)) stale.push(`the pill says ${pill.textContent ?? ""} and is named ${pill.getAttribute("aria-label") ?? "nothing"}`);
  }
  return { looked, stale };
}

function run(story: "home" | "thread") {
  return (): ReactElement => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      const stop = mountShell(el, story);
      let gone = false;
      let probe: ReturnType<typeof probeWrites> | undefined;
      void (async () => {
        while (!gone && !el.dataset["ready"]) await sleep(100);
        if (gone) return;
        const steps = param("steps") || 400;
        const sim = simulate(journal, { sessions: 300, steps, seed: 11, fine: param("whole") !== 1 });
        const own = [...state.fleet.order];
        const sessions = Object.values(sim.start.sessions).map((s) => ({ path: ["fleet", "sessions", s.key], value: s }) as Patch);
        applyPatches([...sessions, { path: ["fleet", "order"], value: [...own, ...sim.start.order] }, { path: ["fleet", "hostNames"], value: [...new Set([...state.fleet.hostNames, ...sim.start.hostNames])] }]);
        await sleep(1000);
        const key = story === "thread" ? state.openThread : null;
        const thread = key ? state.threads[key] : undefined;
        const template = [...(thread?.messages ?? [])].reverse().find((m) => m.info.role === "assistant");
        const at = thread?.messages.length ?? 0;
        if (key && template) {
          const message = JSON.parse(JSON.stringify(template)) as Message;
          message.info = { ...message.info, id: "msg_writes", time: { created: Date.now() } } as Message["info"];
          message.parts = [{ ...(message.parts.find((p) => p.type === "text") ?? message.parts[0]), id: "prt_writes", messageID: "msg_writes", type: "text", text: "", streaming: true } as Message["parts"][number]];
          applyPatches([{ path: ["fleet", "sessions", key, "status"], value: { type: "busy", queued: 0, since: Date.now() } }, { path: ["threads", key, "messages", at], value: message }]);
        }
        probe = probeWrites(el);
        const began = performance.now();
        let text = "";
        let looked = 0;
        let renames = 0;
        const stale: string[] = [];
        for (const [n, step] of sim.steps.entries()) {
          if (gone) return;
          const patches = step.patches.map((p) => (p.path[1] === "order" && "value" in p ? { ...p, value: [...own, ...(p.value as string[])] } : p));
          if (key && template && n % 4 === 0) {
            const words = ` word ${n} and some more`;
            patches.push({ path: ["threads", key, "messages", at, "parts", 0, "text"], append: words, from: text.length });
            text += words;
          }
          /* the person types into the composer as the reply streams */
          const editor = story === "thread" && n % 8 === 2 ? el.querySelector("textarea") : null;
          if (editor) {
            editor.value += n % 64 === 2 ? "\n" : "a";
            editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "a", inputType: "insertText" }));
          }
          /* now and then a window on screen is renamed: a name that does change is written in the batch that changed it */
          const renamed = n % 25 === 5 ? el.querySelector<HTMLElement>(".win[data-key] .wclear")?.closest<HTMLElement>(".win")?.dataset["key"] : undefined;
          if (renamed && state.fleet.sessions[renamed]) patches.push({ path: ["fleet", "sessions", renamed, "info", "title"], value: `renamed at ${n}` });
          if (patches.length > 0) applyPatches(patches);
          const seen = landed(el);
          looked += seen.looked;
          stale.push(...seen.stale);
          if (renamed) {
            renames++;
            if (!el.querySelector(`.win[data-key="${CSS.escape(renamed)}"] .wclear`)?.getAttribute("aria-label")?.includes(`renamed at ${n}`)) stale.push(`${renamed}'s rename did not land`);
          }
          await sleep(STEP_MS);
        }
        /* the reply settles: its caret goes in the same batch */
        if (key && template) {
          applyPatches([{ path: ["threads", key, "messages", at, "parts", 0, "streaming"], value: false }]);
          const answer = [...el.querySelectorAll(".answer")].at(-1);
          looked++;
          if (!answer || answer.classList.contains("caret")) stale.push("the settled reply kept its caret");
        }
        await sleep(500);
        probe.stop();
        const c = probe.counts;
        const minutes = (performance.now() - began) / 60_000;
        Object.assign(el.dataset, {
          total: String(c.total),
          same: String(c.same),
          text: String(c.text),
          sameText: String(c.sameText),
          minutes: minutes.toFixed(3),
          looked: String(looked),
          renames: String(renames),
          stale: JSON.stringify(stale.slice(0, 5)),
          staleCount: String(stale.length),
          rebuilt: JSON.stringify(Object.fromEntries(Object.entries(c.rebuilt).sort((a, b) => b[1] - a[1]).slice(0, 12))),
          by: JSON.stringify(Object.fromEntries(Object.entries(c.by).sort((a, b) => b[1] - a[1]))),
          done: "1",
        });
      })();
      return () => {
        gone = true;
        probe?.stop();
        stop();
      };
    }, []);
    return createElement("div", { ref, className: "shell-story" });
  };
}

export const Home = run("home");
export const Thread = run("thread");
