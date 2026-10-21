/* the real stage over a thread that fills in while you watch (docs/thread.md, live). react hosts with solid inside. `LiveFollow` is the shell's thread story with its last turn's messages taken out and put back part by
   part. `LiveHeavyTurn` is a heavy recorded turn played the way a daemon would run it: a message, then its parts one at
   a time with thoughts and the reply growing by deltas, commands writing their output, every clock the real one, and a
   reply at the end that settles into the answer. the screenshot test for the stage's follow law drives them: pinned at
   the end while rows arrive, nothing moves once the reader has scrolled up, a row opened while pinned keeps its place,
   the tape stuck at the foot and landing into the page at the settle. `PhotoAboveLive` plays the heavy turn under a message with
   a photo and counts what the page made again while the reply streamed (the shots' check holds it at 0). `FootRoom` and
   `OpenLive` check the foot room: nothing the reader sees moves down, and a pinned stage never shows a screen of the room under
   its end. */

import "../../../shell/stories/server";
import { type ReactElement, createElement, useEffect, useRef } from "react";
import { mountShell } from "../../../shell/stories/mount";
import { applyPatches, state } from "../../../store";
import type { Ask, Message, Part } from "../../../sync/protocol";
import { neutralMessage } from "../../../sync/fixtures/neutral";
import { isToolPart, string } from "../wire";
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

const QUESTION = { question: "which upscale path should the device run use?", header: "upscale path", options: [{ label: "metal", description: "answer metal" }, { label: "software", description: "answer software" }], custom: true, multiple: false };

type Recorded = { info: Record<string, unknown>; parts: Record<string, unknown>[] };
/** the heavy session's messages, recorded in cmx2's shapes, made neutral as the server's translate makes them */
const northstar = async (): Promise<{ messages: Message[] }> => ({ messages: ((await (await fetch(northstarUrl)).json()) as { messages: Recorded[] }).messages.map(neutralMessage) });
/** a message's info born again at `created`, not yet completed */
const bornAt = (info: Message["info"], created: number, completed?: number): Message["info"] => { const { completed: _was, ...rest } = info; return { ...rest, created, ...(completed === undefined ? {} : { completed }) }; };

/** the agent asks and waits: a running question step in a new message, and the daemon's pending ask for it */
function askOn(key: string, at: number, last: Message): void {
  const messageID = "msg_ask", callID = "call_ask", id = "que_ask";
  const [host = ""] = key.split(":");
  const start = Date.now();
  const message: Message = { info: { ...bornAt(last.info, start), id: messageID }, parts: [{ type: "tool", id: "prt_ask", messageID, tool: "question", family: "ask", callID, state: { status: "running", input: { questions: [QUESTION] }, time: { start } } }] };
  const ask: Ask = { key, agent: host, id, thread: key, kind: "question", questions: [QUESTION], tool: { messageID, callID } };
  applyPatches([
    { path: ["threads", key, "messages", at], value: message },
    { path: ["fleet", "asks", `${host}:${id}`], value: ask },
  ]);
}

/** what the agent says as the turn ends, which the recording of this turn does not have */
const ANSWER = "the tvOS build is done and the three streams now share one upscale path.\n\n- **upscaling**: the strategy lives in `UpscaleStrategy.swift`, 46 lines added and none removed\n- **tests**: all 54 pass on the simulator\n- **left for you**: a run on the device, which needs the tv on\n\nnothing is committed yet, so the working tree is the whole change.";

/** plays one message into the store: it is born with no parts, and each part arrives as the daemon would send it */
async function playMessage(key: string, at: number, source: Message, gone: () => boolean, rate = speed()): Promise<void> {
  const born = Date.now();
  const parts: Part[] = [];
  const put = (completed?: number) => applyPatches([{ path: ["threads", key, "messages", at], value: { info: bornAt(source.info, born, completed), parts: [...parts] } }]);
  put();
  for (const part of source.parts) {
    if (gone()) return;
    const start = Date.now();
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string" && part.text !== "") {
      const words = part.text.split(/(\s+)/);
      const index = parts.push({ ...part, text: "", streaming: true, time: { start } } as Part) - 1;
      for (let w = 0; w < words.length; w += 10) {
        if (gone()) return;
        parts[index] = { ...part, text: words.slice(0, w + 10).join(""), streaming: true, time: { start } } as Part;
        put();
        await sleep(80 / rate);
      }
      parts[index] = { ...part, time: { start, end: Date.now() } } as Part;
    } else if (isToolPart(part)) {
      const output = part.state.status === "completed" && part.tool.endsWith("exec_command") ? (part.state.output ?? "").split("\n") : [];
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

export const LiveHeavyTurn = (): ReactElement => heavyTurn({});

type HeavyOptions = {
  /** the person's message carries a photo, a data url of a phone photo's size, above the turn that streams */
  photo?: boolean;
  /** plays only this many of the turn's messages, then says it is done */
  messages?: number;
  /** watches the page while the turn plays: the returned function stops it */
  watch?: (el: HTMLElement) => () => void;
};

function heavyTurn(options: HeavyOptions): ReactElement {
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
      const file = await northstar();
      const users = file.messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []));
      const from = users[1] ?? 0, to = users[2] ?? file.messages.length;
      const turn = file.messages.slice(from, to);
      const last = turn.at(-1);
      if (!last) return;
      const reply: Message = { info: { ...bornAt(last.info, 0), id: "msg_reply" }, parts: [{ type: "text", id: "prt_reply", messageID: "msg_reply", text: ANSWER }] };
      // the history above the turn is settled; the session is at work and nothing waits on the person
      applyPatches([
        { path: ["threads", key, "messages"], value: file.messages.slice(0, from) },
        { path: ["fleet", "asks"], value: {} },
        { path: ["fleet", "threads", key, "activity"], value: { state: "busy", since: Date.now() } },
      ]);
      // the stage lands at the end of the history it was given, as it does when it opens a thread, before the turn begins
      await sleep(600);
      el.querySelector<HTMLElement>(".stage-scroll")?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
      await sleep(900);
      const user = turn[0] as Message;
      const parts = options.photo ? [...user.parts, photoPart(user)] : user.parts;
      applyPatches([{ path: ["threads", key, "messages", from], value: { info: bornAt(user.info, Date.now()), parts } }]);
      await sleep(300);
      if (options.watch) unwatch = options.watch(el);
      const played = [...turn.slice(1), reply].slice(0, options.messages ?? Number.POSITIVE_INFINITY);
      for (const [i, message] of played.entries()) {
        if (gone) return;
        await playMessage(key, from + 1 + i, message, () => gone);
        el.dataset["message"] = String(i + 1);
        if (i + 1 === param("ask")) { askOn(key, from + 2 + i, message); el.dataset["asked"] = "1"; return; }
        while (i + 1 === param("pause") && !el.dataset["resume"] && !gone) await sleep(100);
      }
      unwatch();
      unwatch = () => {};
      if (options.messages === undefined) applyPatches([{ path: ["fleet", "threads", key, "activity"], value: { state: "idle" } }]);
      el.dataset["done"] = "1";
    })();
    return () => { gone = true; unwatch(); stop(); };
  }, []);
  return createElement("div", { ref, className: "shell-story" });
}

/* ---------- a sent photo above the turn that streams ---------- */

/** a photo the person sent, as the daemon holds it: a file part with a jpeg data url of a phone photo's weight (noise, so it does not
    compress to nothing), drawn when the story plays so no picture is a file in the repo */
function photoPart(user: Message): Part {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1200;
  const g = canvas.getContext("2d");
  if (g) {
    const pixels = g.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) { const v = (i * 2654435761) >>> 24; pixels.data[i] = v; pixels.data[i + 1] = (v * 7) & 255; pixels.data[i + 2] = 200; pixels.data[i + 3] = 255; }
    g.putImageData(pixels, 0, 0);
  }
  return { type: "image", id: "prt_photo", messageID: user.info.id, mime: "image/jpeg", filename: "whiteboard.jpg", url: canvas.toDataURL("image/jpeg", 0.85), flavour: "attached" };
}

/** counts, while the turn streams, how often the page made again what was already on it: thumbnails (an img node added, each one a
    fresh load and decode of its data url), and element nodes taken out of a turn above the live one or out of the live turn's own
    bubble (its photos and words), which a delta to the reply must not touch. the host says them: `data-img-mounts`, `data-img-loads`,
    `data-above-removed`, `data-bubble-removed` and `data-ms`, the time watched */
function watchRemounts(el: HTMLElement): () => void {
  const transcript = el.querySelector<HTMLElement>(".stage-scroll > .thread");
  if (!transcript) return () => {};
  const started = performance.now();
  let mounts = 0, loads = 0, above = 0, bubble = 0;
  const live = (): Element | undefined => [...transcript.querySelectorAll("section.turn[data-turn]")].at(-1);
  const say = () => Object.assign(el.dataset, { imgMounts: String(mounts), imgLoads: String(loads), aboveRemoved: String(above), bubbleRemoved: String(bubble), ms: String(Math.round(performance.now() - started)) });
  const mo = new MutationObserver((records) => {
    const turn = live();
    for (const r of records) {
      for (const n of r.addedNodes) if (n instanceof Element) mounts += (n.tagName === "IMG" ? 1 : 0) + n.querySelectorAll("img").length;
      const removed = [...r.removedNodes].filter((n) => n instanceof Element).length;
      if (!removed || !(r.target instanceof Element)) continue;
      const home = r.target.closest("section.turn[data-turn]");
      if (home && home !== turn) above += removed;
      else if (r.target.closest(".you-photos, .you") ?? (r.target === turn && [...r.removedNodes].some((n) => n instanceof Element && n.matches(".you-photos, .you")))) bubble += removed;
    }
    say();
  });
  mo.observe(transcript, { childList: true, subtree: true });
  const onLoad = (e: Event) => { if (e.target instanceof HTMLImageElement) { loads++; say(); } };
  transcript.addEventListener("load", onLoad, true);
  say();
  return () => { mo.disconnect(); transcript.removeEventListener("load", onLoad, true); say(); };
}

/** the heavy turn's first messages streaming under the person's message with a photo: the thumbnail must load once and stay the same
    node, and nothing above the reply is made again (`data-img-mounts` and `data-bubble-removed` stay 0 once it has drawn) */
export const PhotoAboveLive = (): ReactElement => heavyTurn({ photo: true, messages: 12, watch: watchRemounts });

/* ---------- the foot room: a run folding whole keeps its room at the end ---------- */

/** watches the live turn while the reader is pinned to the end, each frame: how often (and how far) what the reader sees moved down, which
    is what a pinned reader sees when the transcript gives room back above the end and nothing keeps it, how often the view showed next to
    none of the thread (a screen of kept room), and the most room the foot kept. what the reader sees is the first box of the live turn whose
    top is in the view (a row, a block of one), read again after the change if it is still there: a box that began above the view and lost
    the part the reader saw has nothing in view to have moved */
function watchDrops(el: HTMLElement): () => void {
  let before: { box: Element; top: number; pinned: boolean } | null = null, drops = 0, most = 0, room = 0, empties = 0;
  const scroller = el.querySelector<HTMLElement>(".stage-scroll");
  const transcript = el.querySelector<HTMLElement>(".stage-scroll > .thread");
  if (!scroller || !transcript) return () => {};
  /** the first box of `root`, down to four levels, whose top is at or under `line` and above the view's foot */
  const firstIn = (root: Element, line: number, foot: number, depth = 4): Element | null => {
    for (const kid of root.children) {
      const b = kid.getBoundingClientRect();
      if (b.height === 0 || b.bottom <= line) continue;
      if (b.top >= line) return b.top < foot ? kid : null;
      const inner = depth > 1 ? firstIn(kid, line, foot, depth - 1) : null;
      if (inner) return inner;
    }
    return null;
  };
  /* read in a resize observer made after the stage's, so in the same delivery and after it: the layout the frame paints, with the
     stage's answer to the change (the room it keeps, the end it follows) in it. a read from a frame callback can land between the
     patches the frame applies and that answer, a layout nobody saw */
  const read = () => {
    const turn = [...el.querySelectorAll<HTMLElement>("section.turn[data-turn]")].at(-1);
    if (!turn) return;
    const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    const view = scroller.getBoundingClientRect();
    const line = Math.max(view.top, el.querySelector(".stage-bar")?.getBoundingClientRect().bottom ?? view.top);
    if (before?.pinned && pinned && before.box.isConnected) {
      const moved = before.box.getBoundingClientRect().top - before.top;
      if (moved > 1) { drops++; most = Math.max(most, moved); }
    }
    /* next to none of the thread under the bar: the view is the room */
    if (pinned && transcript.getBoundingClientRect().bottom - line < 48) empties++;
    const box = firstIn(turn, line, view.bottom);
    before = box ? { box, top: box.getBoundingClientRect().top, pinned } : null;
    room = Math.max(room, parseFloat(scroller.style.getPropertyValue("--hold")) || 0);
    Object.assign(el.dataset, { drops: String(drops), dropMost: String(Math.round(most)), roomMost: String(Math.round(room)), empties: String(empties) });
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
      const file = await northstar();
      const users = file.messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []));
      const from = users[1] ?? 0, to = users[2] ?? file.messages.length;
      const turn = file.messages.slice(from, to);
      /* the messages up to the first one that writes words after a run of steps: the fold this story is about */
      const words = turn.findIndex((m, i) => i > 2 && m.parts.some((p) => p.type === "text" && (string(p.text) ?? "").trim() !== ""));
      const played = turn.slice(1, words < 0 ? turn.length : words + 1);
      applyPatches([
        { path: ["threads", key, "messages"], value: file.messages.slice(0, from) },
        { path: ["fleet", "asks"], value: {} },
        { path: ["fleet", "threads", key, "activity"], value: { state: "busy", since: Date.now() } },
      ]);
      await sleep(600);
      el.querySelector<HTMLElement>(".stage-scroll")?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
      await sleep(600);
      const user = turn[0] as Message;
      applyPatches([{ path: ["threads", key, "messages", from], value: { info: bornAt(user.info, Date.now()), parts: user.parts } }]);
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

/* ---------- opening a live thread: it opens drawn at its end, and stays drawn ---------- */

/** counts, each frame, the frames a pinned stage on top showed next to none of its thread under its bar (the view in the room kept under
    the end, or past the transcript), from the moment its layer has rows: what the person opening a working thread saw as a blank stage
    until they scrolled */
function watchBlank(el: HTMLElement): () => void {
  let on = true, blank = 0, frames = 0;
  const tick = () => {
    if (!on) return;
    const layer = [...el.querySelectorAll<HTMLElement>(".stage .layer")].at(-1);
    const scroller = layer?.querySelector<HTMLElement>(".stage-scroll");
    const transcript = scroller?.querySelector<HTMLElement>(":scope > .thread");
    if (layer && scroller && transcript && layer.querySelector("section.turn")) {
      frames++;
      const view = scroller.getBoundingClientRect();
      const line = Math.max(view.top, layer.querySelector(".stage-bar")?.getBoundingClientRect().bottom ?? view.top);
      const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      if (pinned && transcript.getBoundingClientRect().bottom - line < 48) blank++;
    }
    Object.assign(el.dataset, { blank: String(blank), frames: String(frames) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { on = false; };
}

/** home, and a working thread opened from its windows (the strip at the ipad's and the mac's widths, the deck on the phone): the heavy turn
    of the recorded session is running, and its newest step is a read whose open body fills most of a screen. the thread is opened cold (the
    read lands after the stage is up), the run goes on and the read's body closes to its opening lines as the agent writes, another working
    thread is opened, and the first one again from its cache. the host counts the frames the stage on top showed next to none of its thread
    while pinned to the end (`data-blank`, which must stay 0) */
export const OpenLive = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = mountShell(el, "home");
    let gone = false, unwatch = () => {};
    void (async () => {
      while (!gone && !el.dataset["ready"]) await sleep(100);
      const [first, second] = Object.keys(state.fleet.threads).filter((k) => !state.threads[k]);
      if (gone || !first || !second) return;
      const file = await northstar();
      const users = file.messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []));
      const from = users[1] ?? 0, to = users[2] ?? file.messages.length;
      const turn = file.messages.slice(from, to);
      const words = turn.findIndex((m, i) => i > 2 && m.parts.some((p) => p.type === "text" && (string(p.text) ?? "").trim() !== ""));
      const played = turn.slice(1, words < 0 ? turn.length : words + 1);
      /* the thread as it stands when it is opened: the turns before, the prompt, and the run up to `held` of its messages, working */
      const held = Math.max(1, played.length - (param("left") || 6));
      /* its clocks moved to now, so the run's strip reads the recorded part and the part played after it on one clock */
      const last = played[held - 1]?.info.created ?? Date.now();
      const shift = Date.now() - last;
      const opening = JSON.parse(JSON.stringify([...file.messages.slice(0, from + 1), ...played.slice(0, held)]).replace(/"(created|completed|start|end)":(\d{13})/g, (_s, k: string, v: string) => `"${k}":${Number(v) + shift}`)) as Message[];
      const busy = (key: string) => ({ path: ["fleet", "threads", key, "activity"], value: { state: "busy", since: Date.now() - 200_000 } });
      const open = (key: string) => el.querySelector<HTMLElement>(`.win[data-key="${CSS.escape(key)}"] .win-open`)?.click();
      applyPatches([
        busy(first),
        busy(second),
        { path: ["threads", second], value: { key: second, status: "live", messages: file.messages.slice(0, users[3] ?? file.messages.length) } },
      ]);
      unwatch = watchBlank(el);
      // cold: the stage is up before its thread is read
      applyPatches([{ path: ["threads", first], value: { key: first, status: "hydrating", messages: [] } }]);
      open(first);
      await sleep(700);
      applyPatches([{ path: ["threads", first], value: { key: first, status: "live", messages: opening } }]);
      for (const [i, message] of played.slice(held).entries()) {
        if (gone) return;
        await playMessage(first, from + 1 + held + i, message, () => gone, 3 * speed());
      }
      await sleep(600);
      // another working thread, from its cache, and back to the first
      open(second);
      await sleep(1500);
      open(first);
      await sleep(1500);
      el.dataset["done"] = "1";
    })();
    return () => { gone = true; unwatch(); stop(); };
  }, []);
  return createElement("div", { ref, className: "shell-story" });
};
