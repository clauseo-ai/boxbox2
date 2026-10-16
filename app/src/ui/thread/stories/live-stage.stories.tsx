/* the real stage over a thread that fills in while you watch (docs/thread.md, live). two stories, both react hosts with
   solid inside. `LiveFollow` is the shell's thread story with its last turn's messages taken out and put back part by
   part. `LiveHeavyTurn` is a heavy recorded turn played the way a daemon would run it: a message, then its parts one at
   a time with thoughts and the reply growing by deltas, commands writing their output, every clock the real one, and a
   reply at the end that settles into the answer. the screenshot test for the stage's follow law drives them: pinned at
   the end while rows arrive, nothing moves once the reader has scrolled up, a row opened while pinned keeps its place,
   the tape stuck at the foot and landing into the page at the settle. */

import "../../../shell/stories/server";
import { type ReactElement, createElement, useEffect, useRef } from "react";
import { mountShell } from "../../../shell/stories/mount";
import { applyPatches, state } from "../../../store";
import type { Message, Part } from "../../../sync/protocol";
import northstarUrl from "../fixtures/northstar-heavy.json?url";

export default { title: "stage" };

/** a part lands this often */
const STEP_MS = 450;

export const LiveFollow = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = mountShell(el, "thread");
    let gone = false;
    const timers: number[] = [];
    void (async () => {
      while (!gone && !el.dataset["ready"]) await new Promise((r) => setTimeout(r, 100));
      const key = state.openThread;
      const held = key ? state.threads[key]?.messages : undefined;
      if (gone || !key || !held) return;
      const full = JSON.parse(JSON.stringify(held)) as Message[];
      // the last three messages arrive again, each part by part
      const from = Math.max(1, full.length - 3);
      applyPatches([{ path: ["threads", key, "messages"], value: full.slice(0, from) }]);
      const steps: Array<() => void> = [];
      full.slice(from).forEach((message, i) => {
        steps.push(() => applyPatches([{ path: ["threads", key, "messages", from + i], value: { ...message, parts: [] } }]));
        message.parts.forEach((_, k) => steps.push(() => applyPatches([{ path: ["threads", key, "messages", from + i], value: { ...message, parts: message.parts.slice(0, k + 1) } }])));
      });
      steps.forEach((run, n) => timers.push(window.setTimeout(() => { if (!gone) run(); }, 1500 + n * STEP_MS)));
      el.dataset["steps"] = String(steps.length);
    })();
    return () => { gone = true; timers.forEach(clearTimeout); stop(); };
  }, []);
  return createElement("div", { ref, className: "shell-story" });
};

/* ---------- a heavy turn, played ---------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** the page's `?speed=2` plays it twice as fast, `?pause=40` holds it after the 40th message until the host's `data-resume` is
    set, so a test can touch a quiet stream, and `?ask=40` has the agent ask a question there and wait for the person */
const param = (name: string): number => Number(new URLSearchParams(location.search).get(name)) || 0;
const speed = (): number => Math.max(0.25, param("speed") || 1);

const QUESTION = { question: "which upscale path should the device run use?", header: "upscale path", options: [{ label: "metal", description: "answer metal" }, { label: "software", description: "answer software" }], custom: true };

/** the agent asks and waits: a running question step in a new message, and the daemon's pending ask for it */
function askOn(key: string, at: number, last: Message): void {
  const sessionID = last.info.sessionID, messageID = "msg_ask", callID = "call_ask", id = "que_ask";
  const [host] = key.split(":");
  const start = Date.now();
  const message = { info: { ...last.info, id: messageID, time: { created: start } }, parts: [{ type: "tool", id: "prt_ask", sessionID, messageID, tool: "question", callID, state: { status: "running", input: { questions: [QUESTION] }, time: { start } } }] };
  applyPatches([
    { path: ["threads", key, "messages", at], value: message },
    { path: ["fleet", "asks", `${host}:${id}`], value: { key, host, id, kind: "question", request: { id, sessionID, questions: [QUESTION], tool: { messageID, callID } } } },
  ]);
}

/** what the agent says as the turn ends, which the recording of this turn does not have */
const ANSWER = "the tvOS build is done and the three streams now share one upscale path.\n\n- **upscaling**: the strategy lives in `UpscaleStrategy.swift`, 46 lines added and none removed\n- **tests**: all 54 pass on the simulator\n- **left for you**: a run on the device, which needs the tv on\n\nnothing is committed yet, so the working tree is the whole change.";

/** plays one message into the store: it is born with no parts, and each part arrives as the daemon would send it */
async function playMessage(key: string, at: number, source: Message, gone: () => boolean, rate = speed()): Promise<void> {
  const born = Date.now();
  const parts: Part[] = [];
  const put = (completed?: number) => applyPatches([{ path: ["threads", key, "messages", at], value: { info: { ...source.info, time: { created: born, ...(completed === undefined ? {} : { completed }) } }, parts: [...parts] } }]);
  put();
  for (const part of source.parts) {
    if (gone()) return;
    const start = Date.now();
    if ((part.type === "text" || part.type === "reasoning") && part.text !== "") {
      const words = part.text.split(/(\s+)/);
      const index = parts.push({ ...part, text: "", streaming: true, time: { start } } as Part) - 1;
      for (let w = 0; w < words.length; w += 10) {
        if (gone()) return;
        parts[index] = { ...part, text: words.slice(0, w + 10).join(""), streaming: true, time: { start } } as Part;
        put();
        await sleep(80 / rate);
      }
      parts[index] = { ...part, time: { start, end: Date.now() } } as Part;
    } else if (part.type === "tool") {
      const output = part.state.status === "completed" && part.tool.endsWith("exec_command") ? part.state.output.split("\n") : [];
      // a command that wrote a good deal of output writes it in eight pieces over its run
      const beats = output.length > 6 ? 8 : 1;
      const run = Math.min(2600, Math.max(200, spanOf(part) / 25)) / rate;
      const index = parts.push({ ...part, state: { status: "running", input: part.state.input, time: { start } } } as Part) - 1;
      for (let b = 1; b <= beats; b++) {
        parts[index] = { ...part, state: { status: "running", input: part.state.input, time: { start }, ...(output.length ? { metadata: { output: output.slice(0, Math.ceil((b / beats) * output.length)).join("\n") } } : {}) } } as Part;
        put();
        await sleep(run / beats);
      }
      parts[index] = { ...part, state: { ...part.state, time: { start, end: Date.now() } } } as Part;
    } else parts.push(part);
    put();
    await sleep(120 / rate);
  }
  put(Date.now());
}

const spanOf = (p: Part): number => { const t = (p as { state?: { time?: { start?: number; end?: number } } }).state?.time; return t?.start !== undefined && t.end !== undefined ? t.end - t.start : 0; };

export const LiveHeavyTurn = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = mountShell(el, "thread");
    let gone = false;
    void (async () => {
      while (!gone && !el.dataset["ready"]) await sleep(100);
      const key = state.openThread;
      if (gone || !key) return;
      const file = (await (await fetch(northstarUrl)).json()) as { messages: Message[] };
      const users = file.messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []));
      const from = users[1] ?? 0, to = users[2] ?? file.messages.length;
      const turn = file.messages.slice(from, to);
      const last = turn.at(-1);
      if (!last) return;
      const reply: Message = { info: { ...last.info, id: "msg_reply", time: { created: 0 } }, parts: [{ type: "text", id: "prt_reply", sessionID: last.info.sessionID, messageID: "msg_reply", text: ANSWER } as Part] } as Message;
      // the history above the turn is settled; the session is at work and nothing waits on the person
      applyPatches([
        { path: ["threads", key, "messages"], value: file.messages.slice(0, from) },
        { path: ["fleet", "asks"], value: {} },
        { path: ["fleet", "sessions", key, "status"], value: { type: "busy", since: Date.now() } },
      ]);
      // the stage lands at the end of the history it was given, as it does when it opens a thread, before the turn begins
      await sleep(600);
      el.querySelector<HTMLElement>(".stage-scroll")?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
      await sleep(900);
      const user = turn[0] as Message;
      applyPatches([{ path: ["threads", key, "messages", from], value: { info: { ...user.info, time: { created: Date.now() } }, parts: user.parts } }]);
      for (const [i, message] of [...turn.slice(1), reply].entries()) {
        if (gone) return;
        await playMessage(key, from + 1 + i, message, () => gone);
        el.dataset["message"] = String(i + 1);
        if (i + 1 === param("ask")) { askOn(key, from + 2 + i, message); el.dataset["asked"] = "1"; return; }
        while (i + 1 === param("pause") && !el.dataset["resume"] && !gone) await sleep(100);
      }
      applyPatches([{ path: ["fleet", "sessions", key, "status"], value: { type: "idle", since: Date.now() } }]);
      el.dataset["done"] = "1";
    })();
    return () => { gone = true; stop(); };
  }, []);
  return createElement("div", { ref, className: "shell-story" });
};

/* ---------- the foot room: a run folding whole keeps its room at the end ---------- */

/** watches the live turn while the reader is pinned to the end, each frame: how often (and how far) the turn's top moved down, which is
    what a pinned reader sees when the transcript gives room back above the end and nothing keeps it, and the most room the foot kept */
function watchDrops(el: HTMLElement): () => void {
  let before: { top: number; pinned: boolean } | null = null, drops = 0, most = 0, room = 0;
  const scroller = el.querySelector<HTMLElement>(".stage-scroll");
  const transcript = el.querySelector<HTMLElement>(".stage-scroll > .thread");
  if (!scroller || !transcript) return () => {};
  /* read in a resize observer made after the stage's, so in the same delivery and after it: the layout the frame paints, with the
     stage's answer to the change (the room it keeps, the end it follows) in it. a read from a frame callback can land between the
     patches the frame applies and that answer, a layout nobody saw */
  const read = () => {
    const turn = [...el.querySelectorAll<HTMLElement>("section.turn[data-turn]")].at(-1);
    if (!turn) return;
    const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    const top = turn.getBoundingClientRect().top;
    if (before?.pinned && pinned && top - before.top > 1) { drops++; most = Math.max(most, top - before.top); }
    before = { top, pinned };
    room = Math.max(room, parseFloat(scroller.style.getPropertyValue("--hold")) || 0);
    Object.assign(el.dataset, { drops: String(drops), dropMost: String(Math.round(most)), roomMost: String(Math.round(room)) });
  };
  const ro = new ResizeObserver(read);
  ro.observe(transcript);
  ro.observe(scroller);
  return () => ro.disconnect();
}

/** the heavy turn's opening, played until the agent first writes words after a run of steps: the run folds whole into its group as the
    words begin, and the room its open row had stays at the end (foot.ts). the host says how often the turn moved down under a pinned
    reader (`data-drops`, which must stay 0) and the most room kept (`data-room-most`) */
export const FootRoom = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = mountShell(el, "thread");
    let gone = false, unwatch = () => {};
    void (async () => {
      while (!gone && !el.dataset["ready"]) await sleep(100);
      const key = state.openThread;
      if (gone || !key) return;
      const file = (await (await fetch(northstarUrl)).json()) as { messages: Message[] };
      const users = file.messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []));
      const from = users[1] ?? 0, to = users[2] ?? file.messages.length;
      const turn = file.messages.slice(from, to);
      /* the messages up to the first one that writes words after a run of steps: the fold this story is about */
      const words = turn.findIndex((m, i) => i > 2 && m.parts.some((p) => p.type === "text" && p.text.trim() !== ""));
      const played = turn.slice(1, words < 0 ? turn.length : words + 1);
      applyPatches([
        { path: ["threads", key, "messages"], value: file.messages.slice(0, from) },
        { path: ["fleet", "asks"], value: {} },
        { path: ["fleet", "sessions", key, "status"], value: { type: "busy", since: Date.now() } },
      ]);
      await sleep(600);
      el.querySelector<HTMLElement>(".stage-scroll")?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
      await sleep(600);
      const user = turn[0] as Message;
      applyPatches([{ path: ["threads", key, "messages", from], value: { info: { ...user.info, time: { created: Date.now() } }, parts: user.parts } }]);
      unwatch = watchDrops(el);
      for (const [i, message] of played.entries()) {
        if (gone) return;
        // three times the recorded pace, so the shot's wait holds it; the fold is the same at any pace
        await playMessage(key, from + 1 + i, message, () => gone, 3 * speed());
      }
      await sleep(400);
      el.dataset["done"] = "1";
    })();
    return () => { gone = true; unwatch(); stop(); };
  }, []);
  return createElement("div", { ref, className: "shell-story" });
};
