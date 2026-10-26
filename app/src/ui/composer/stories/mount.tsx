/* the solid side of the composer's stories (docs/composer.md, every state):
   each story boots the real store from the fixtures, answers the menus'
   reads the way boxbox's routes do, and renders the real composer in its
   mount: the bar under a thread, and home's field. a story that needs
   focus or a menu gets it the way a person would, by focusing the words
   and typing. */

import type { Middleware } from "openapi-fetch";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { api } from "../../../api/client";
import { installMotionProperties } from "../../../motion/animate";
import { bootSync, DEFAULT_HOME, setCompaction, setModels, setNewThread, setOutbox, setPrefs, state } from "../../../store";
import type { StreamStatus } from "../../../sync/messages";
import type { Draft, OutboxView } from "../../../sync/outbox";
import { EMPTY_FLEET } from "../../../sync/reducer";
import type { Ask, Thread } from "../../../sync/protocol";
import { colourStyle, hashColour, REPO_COLOURS } from "../../window/repo";
import { Composer } from "../composer";
import type { BtwActions, BtwDone } from "../../btw/types";
import { Field } from "../../next/field";
import { AT, browse, COMMANDS, DIRECTORY, DROPPED, draft, FAVORITES, FILES, fileOf, HOST, IDLE, IDLE_NEARLY_FULL, IDLE_ON_OPUS, IDLE_WITH_CONTEXT, KEY, MODELS, MODELS_MANY, OTHER, PROMPTS, photoUrl, QUESTION, SESSION, sent, TARGET, WORKING, WORKING_MARKDOWN, WORKING_WITH_CONTEXT } from "./fixtures";

export type ComposerStory =
  | "empty-done"
  | "empty-working"
  | "empty-wants"
  | "live-markdown"
  | "draft"
  | "draft-line"
  | "long"
  | "full"
  | "shell"
  | "photo"
  | "photo-heic"
  | "file"
  | "file-long"
  | "file-refused"
  | "sending"
  | "queued"
  | "steer"
  | "steer-run-now"
  | "failed"
  | "queue-three"
  | "queue-failed-lead"
  | "queue-list"
  | "queue-list-draft"
  | "queue-verbs"
  | "offline"
  | "drop-over"
  | "glass"
  | "glass-queue"
  | "glass-shell"
  | "glass-rest"
  | "glass-rest-focus"
  | "glass-rest-line"
  | "glass-rest-empty"
  | "glass-rest-working"
  | "glass-rest-violet"
  | "glass-rest-violet-focus"
  | "glass-rest-violet-line"
  | "glass-rest-magenta"
  | "dropped"
  | "model"
  | "slash"
  | "at"
  | "keyboard"
  | "dial"
  | "dial-named"
  | "dial-keys"
  | "tools-keys"
  | "tools"
  | "tools-context"
  | "tools-busy"
  | "context-full"
  | "compact-running"
  | "compact-failed"
  | "compact-done"
  | "slash-compact"
  | "models-favorites"
  | "models-pinned"
  | "models-all"
  | "models-none"
  | "models-search"
  | "models-long"
  | "models-star-refused"
  | "models-empty"
  | "models-loading"
  | "models-failed"
  | "models-failed-dial"
  | "field"
  | "field-nowhere"
  | "field-hosts"
  | "field-finder"
  | "field-browse"
  | "field-typed"
  | "field-typed-model"
  | "field-typed-machine"
  | "field-starting"
  | "field-failed"
  | "field-fresh"
  | "field-model"
  | "field-dial"
  | "btw"
  | "btw-working"
  | "btw-empty"
  | "btw-failed"
  | "btw-slash"
  | "btw-tools";

const HOME_STORIES = ["field", "field-nowhere", "field-hosts", "field-finder", "field-browse", "field-typed", "field-typed-model", "field-typed-machine", "field-starting", "field-failed", "field-fresh", "field-model", "field-dial"] as const;
type HomeStory = (typeof HOME_STORIES)[number];
const isHome = (story: ComposerStory): story is HomeStory => (HOME_STORIES as readonly string[]).includes(story);

/** what a story does after it is painted, the way a person does: press by name, type into the words or a finder, wait */
type Drive = {
  /** a tap: the click of a pointer, which leaves focus where it was */
  press: (label: string) => void;
  /** the click a keyboard makes (return on a focused key), which moves focus into what it opens */
  key: (label: string) => void;
  /** a key pressed where focus is */
  hit: (key: string) => void;
  type: (selector: string, text: string) => void;
  later: (ms: number, then: () => void) => void;
  /** a long press or a right click on what the selector finds */
  menu: (selector: string) => void;
  /** a drag of files entering, or dropped on, what the selector finds: a spec, a pdf and an archive unless `files` says */
  drag: (type: "dragenter" | "drop", selector: string, files?: File[]) => void;
};

/** a steer, then two waiting for the turn to end */
const three = (): OutboxView[] => [sent("c3", PROMPTS.steer, "queued", { verb: "steer" }), sent("c1", PROMPTS.docs, "queued", { at: AT + 5000 }), sent("c2", PROMPTS.push, "queued", { at: AT + 9000 })];

type Setup = {
  entry: Thread;
  /** the host's model list: here (the default), being read for good, or refused */
  models?: "loading" | "failed";
  /** the host with the models that pile up (25 across six providers) */
  many?: boolean;
  /** a host that lists no models at all */
  none?: boolean;
  /** the models this person starred; none by default */
  favorites?: string[];
  /** how the daemon answers a compact: not at all (it is taking its time), with a refusal, or at once */
  compact?: "hang" | "refuse" | "ok";
  /** the server does not keep a star */
  starsRefused?: boolean;
  /** what the story does once it is painted */
  drive?: (go: Drive) => void;
  asks?: Ask[];
  draft?: Draft;
  outbox?: OutboxView[];
  stream?: StreamStatus["state"];
  /** focus the words, then type this after what the draft holds */
  type?: string;
  focus?: boolean;
  full?: boolean;
  keyboard?: boolean;
  /** the log runs on under the bar, as a long thread does, so the glass has something to bend */
  under?: boolean;
  /** the repo palette by its name (repo.ts), where the story is about how the glass sits on one hue; the fixture's own otherwise */
  palette?: string;
  /** the thread's agent answers btws (docs/composer.md, btw): the composer is handed these verbs; "refuse" answers every ask with a refusal */
  btw?: "ok" | "refuse";
};

/** the btw verbs a story hands the composer: an ask that lands, or one the server refused, in the words the worker would use */
const fakeBtw = (how: "ok" | "refuse"): BtwActions => {
  const done = (): Promise<BtwDone> => Promise.resolve(how === "ok" ? { ok: true } : { ok: false, message: "the btw was not asked: the desk host did not answer. try again" });
  return { ask: done, dismiss: done, promote: done };
};

const LIVE: StreamStatus = { state: "live", since: AT - 600_000, lastEventAt: AT };

const SETUPS: Record<Exclude<ComposerStory, HomeStory>, () => Setup> = {
  "empty-done": () => ({ entry: IDLE }),
  "empty-working": () => ({ entry: WORKING }),
  "empty-wants": () => ({ entry: WORKING, asks: [QUESTION] }),
  // the agent's markdown in the live line: strong drawn strong, code in mono, the open mark at the end dropped
  "live-markdown": () => ({ entry: WORKING_MARKDOWN }),
  draft: () => ({ entry: WORKING, draft: draft(PROMPTS.perf), focus: true }),
  // one line: the words between the plus and send, inset clear of both
  "draft-line": () => ({ entry: IDLE, draft: draft("ship it"), focus: true }),
  long: () => ({ entry: WORKING, draft: draft(PROMPTS.long), focus: true }),
  full: () => ({ entry: WORKING, draft: draft(PROMPTS.long), focus: true, full: true }),
  shell: () => ({ entry: IDLE, draft: draft(""), type: "!git log --oneline -5" }),
  photo: () => ({ entry: IDLE, draft: draft("see the gap right?", { photos: [{ mime: "image/jpeg", filename: "gap.jpg", url: photoUrl(), width: 240, height: 520 }] }), focus: true }),
  // files beside a photo (docs/composer.md, attachments: any file): each a type tile, its name and its size, with remove
  file: () => ({
    entry: IDLE,
    draft: draft("check the dates against the plan", {
      photos: [
        { mime: "image/jpeg", filename: "gap.jpg", url: photoUrl(), width: 240, height: 520 },
        fileOf("booking.pdf", "application/pdf", 1_240_000),
        fileOf("plan.md", "text/markdown", 6_100),
      ],
    }),
    focus: true,
  }),
  // four files with long names: each cut in its middle so its kind still shows, and the tray wraps rather than run off a phone
  "file-long": () => ({
    entry: IDLE,
    draft: draft("", {
      photos: [
        fileOf("booking-confirmation-lisbon-final.pdf", "application/pdf", 8_900_000),
        fileOf("quarterly-numbers-by-region.csv", "text/csv", 212_000),
        fileOf("openapi.json", "application/json", 48_000),
        fileOf("notes from the planning call.txt", "text/plain", 900),
      ],
    }),
    focus: true,
  }),
  // a text file past what one may be, dropped: refused before it goes, in the agent's own numbers
  "file-refused": () => ({
    entry: IDLE,
    draft: draft("summarise this", { photos: [fileOf("plan.md", "text/markdown", 6_100)] }),
    drive: (go) => go.drag("drop", ".cz-story-stage", [new File(["a,b\n".repeat(160_000)], "export.csv", { type: "text/csv" })]),
  }),
  // a heic the browser could not draw, beside a photo it could: the tile reads as a heic photo and not as a broken image
  "photo-heic": () => ({
    entry: IDLE,
    draft: draft("what is this plant?", {
      photos: [
        { mime: "image/jpeg", filename: "gap.jpg", url: photoUrl(), width: 240, height: 520 },
        { mime: "image/heic", filename: "IMG_4021.heic", url: `data:image/heic;base64,${"A".repeat(4_000_000)}`, width: null, height: null },
      ],
    }),
    focus: true,
  }),
  sending: () => ({ entry: IDLE, outbox: [sent("c1", PROMPTS.deploy, "sending")] }),
  queued: () => ({ entry: WORKING, outbox: [sent("c1", PROMPTS.docs, "queued"), sent("c2", PROMPTS.push, "queued", { at: AT + 5000 })] }),
  steer: () => ({ entry: WORKING, outbox: [sent("c3", PROMPTS.steer, "queued", { verb: "steer" })] }),
  // a steer waiting for its boundary and a message waiting for the turn to end: the two cards that can stop the turn, one above the other
  "steer-run-now": () => ({ entry: WORKING, outbox: [sent("c3", PROMPTS.steer, "queued", { verb: "steer" }), sent("c1", PROMPTS.docs, "queued", { at: AT + 5000 })] }),
  failed: () => ({ entry: IDLE, outbox: [sent("c4", PROMPTS.deploy, "failed", { error: "the desk host did not answer", attempts: 3 })] }),
  // three on their way: the strip shows the first with +2 and the edges of two behind it
  "queue-three": () => ({ entry: WORKING, outbox: three() }),
  // one that did not go leads the strip, whatever its place
  "queue-failed-lead": () => ({ entry: WORKING, outbox: [sent("c1", PROMPTS.docs, "queued"), sent("c4", PROMPTS.deploy, "failed", { error: "the desk host did not answer", attempts: 3, at: AT + 3000 })] }),
  // a tap on the strip: every message with its verbs, over the thread; an empty draft offers edit on the waiting ones
  "queue-list": () => ({ entry: WORKING, outbox: three(), drive: (go) => go.press("3 messages on their way") }),
  // with words in the draft a waiting message has nowhere to go back to, so edit is not offered
  "queue-list-draft": () => ({ entry: WORKING, draft: draft("and the readme"), outbox: three(), drive: (go) => go.press("3 messages on their way") }),
  // a long press (or a right click): every verb the strip's message has
  "queue-verbs": () => ({ entry: WORKING, outbox: three(), drive: (go) => go.menu(".cz-strip") }),
  // the bar is clear glass over the log: the thread's words run under it, and the shade behind its words keeps them legible
  glass: () => ({ entry: WORKING, draft: draft("and the readme too"), focus: true, under: true }),
  "glass-queue": () => ({ entry: WORKING, outbox: three(), under: true }),
  "glass-shell": () => ({ entry: IDLE, draft: draft(""), type: "!git log --oneline -5", under: true }),
  // the glass at rest, the words not focused, in a few hues: a two-line draft on violet (the state the owner saw), the
  // same draft focused, one line on cobalt, nothing on teal, and the agent working with nothing typed on rose
  "glass-rest": () => ({ entry: IDLE, draft: draft(PROMPTS.perf), under: true, palette: "violet" }),
  "glass-rest-focus": () => ({ entry: IDLE, draft: draft(PROMPTS.perf), focus: true, under: true, palette: "violet" }),
  "glass-rest-line": () => ({ entry: IDLE, draft: draft("ship it"), under: true, palette: "cobalt" }),
  "glass-rest-empty": () => ({ entry: IDLE, draft: draft(""), under: true, palette: "teal" }),
  "glass-rest-working": () => ({ entry: WORKING, draft: draft(""), under: true, palette: "rose" }),
  // the rim at rest, the state the owner saw next: nothing typed, unfocused, on violet; then focused, one line, and on magenta
  "glass-rest-violet": () => ({ entry: IDLE, draft: draft(""), under: true, palette: "violet" }),
  "glass-rest-violet-focus": () => ({ entry: IDLE, draft: draft(""), focus: true, under: true, palette: "violet" }),
  "glass-rest-violet-line": () => ({ entry: IDLE, draft: draft("ship it"), under: true, palette: "violet" }),
  "glass-rest-magenta": () => ({ entry: IDLE, draft: draft(""), under: true, palette: "magenta" }),
  // a file dragged over the stage: the composer's edge lights and its line says what a drop does
  "drop-over": () => ({ entry: IDLE, draft: draft(""), drive: (go) => go.drag("dragenter", ".cz-story-stage") }),
  // a spec, a pdf and an archive dropped on the stage: the spec and the pdf join the draft as files, the archive is mentioned
  // by its name after what the draft held, and the line says the agent does not take it
  "dropped": () => ({ entry: IDLE, draft: draft("compare these"), drive: (go) => go.drag("drop", ".cz-story-stage") }),
  offline: () => ({ entry: WORKING, stream: "down", outbox: [sent("c5", PROMPTS.push, "waiting", { attempts: 0 })] }),
  model: () => ({ entry: IDLE_ON_OPUS, draft: draft(PROMPTS.perf), focus: true, type: "", favorites: FAVORITES.slice(0, 2), drive: (go) => go.press("model") }),
  "models-favorites": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), many: true, favorites: FAVORITES, drive: (go) => go.press("model") }),
  "models-pinned": () => ({ entry: IDLE, draft: draft(""), many: true, favorites: FAVORITES, drive: (go) => go.press("model") }),
  "models-all": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), many: true, favorites: FAVORITES, drive: (go) => { go.press("model"); go.later(60, () => go.press("show all")); } }),
  "models-none": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), many: true, drive: (go) => go.press("model") }),
  "models-search": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), many: true, favorites: FAVORITES, drive: (go) => { go.press("model"); go.later(60, () => go.type(".cz-model-find input", "gpt")); } }),
  "models-star-refused": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), many: true, favorites: FAVORITES, starsRefused: true, drive: (go) => { go.press("model"); go.later(80, () => go.press("favorite gemini 3 pro")); } }),
  "models-empty": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), none: true, drive: (go) => go.press("model") }),
  "models-long": () => ({ entry: IDLE, draft: draft(""), many: true, favorites: ["deepseek/deepseek-coder-v3", ...FAVORITES], drive: (go) => go.press("model") }),
  dial: () => ({ entry: IDLE_ON_OPUS, draft: draft(""), focus: false, favorites: FAVORITES, drive: (go) => go.press("effort:") }),
  "dial-keys": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), focus: false, favorites: FAVORITES, drive: (go) => { go.key("effort:"); go.later(80, () => go.hit("ArrowLeft")); } }),
  "tools-keys": () => ({ entry: IDLE_WITH_CONTEXT, draft: draft(""), drive: (go) => { go.key("add to the message"); go.later(80, () => { go.hit("ArrowDown"); go.hit("ArrowDown"); go.hit("ArrowDown"); go.hit("ArrowDown"); }); } }),
  "dial-named": () => ({ entry: IDLE, draft: draft(""), many: true, favorites: FAVORITES, drive: (go) => { go.press("model"); go.later(40, () => go.press("gpt-5.2 codex")); go.later(200, () => go.press("effort:")); } }),
  "models-loading": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), models: "loading" }),
  "models-failed": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), models: "failed" }),
  "models-failed-dial": () => ({ entry: IDLE_ON_OPUS, draft: draft(""), models: "failed" }),
  tools: () => ({ entry: IDLE, draft: draft(""), drive: (go) => go.press("add to the message") }),
  "tools-context": () => ({ entry: IDLE_WITH_CONTEXT, draft: draft(""), drive: (go) => go.press("add to the message") }),
  "tools-busy": () => ({ entry: WORKING_WITH_CONTEXT, draft: draft(""), drive: (go) => go.press("add to the message") }),
  "context-full": () => ({ entry: IDLE_NEARLY_FULL, draft: draft(""), drive: (go) => go.press("add to the message") }),
  "compact-running": () => ({ entry: IDLE_WITH_CONTEXT, draft: draft(""), compact: "hang", drive: (go) => { go.press("add to the message"); go.later(60, () => go.press("compact the thread")); } }),
  "compact-failed": () => ({ entry: IDLE_WITH_CONTEXT, draft: draft(""), compact: "refuse", drive: (go) => { go.press("add to the message"); go.later(60, () => go.press("compact the thread")); } }),
  "compact-done": () => ({ entry: IDLE_WITH_CONTEXT, draft: draft(""), drive: () => setCompaction(KEY, { state: "done", at: AT }) }),
  slash: () => ({ entry: IDLE, draft: draft(""), type: "/re" }),
  "slash-compact": () => ({ entry: IDLE_WITH_CONTEXT, draft: draft(""), type: "/c" }),
  at: () => ({ entry: WORKING, draft: draft(""), type: "look at @dep" }),
  keyboard: () => ({ entry: WORKING, draft: draft("add logging instead of speculating"), focus: true, keyboard: true }),
  // btw mode (docs/composer.md, btw): typed in with /btw, the prefix eaten; the chip, the citron window, "ask"
  btw: () => ({ entry: IDLE, draft: draft(""), type: "/btw why does the deploy wait for the health check?", btw: "ok" }),
  // mid-turn: the same, never queued and never a steer; the live line says what an ask does
  "btw-working": () => ({ entry: WORKING, draft: draft(""), type: "/btw is the retry loop bounded?", btw: "ok" }),
  // just entered, nothing asked yet: the placeholder says what a btw is
  "btw-empty": () => ({ entry: IDLE, draft: draft(""), type: "/btw ", btw: "ok" }),
  // a refusal keeps the draft and says why in the problem line
  "btw-failed": () => ({ entry: IDLE, draft: draft(""), type: "/btw why is the deploy slow?", btw: "refuse", drive: (go) => go.later(80, () => go.press("ask")) }),
  // the slash menu offers btw first, where the agent answers btws
  "btw-slash": () => ({ entry: IDLE, draft: draft(""), type: "/b", btw: "ok" }),
  // the plus menu's btw row
  "btw-tools": () => ({ entry: IDLE, btw: "ok", drive: (go) => go.press("add to the message") }),
};

/** the menus' reads, answered as boxbox's routes answer them. the api client holds the fetch it was made with,
    so the answers go in as its middleware, which can answer before any request leaves */
function answerReads(models: "loading" | "failed" | undefined, compact: "hang" | "refuse" | "ok" | undefined, many: boolean, starsRefused = false, none = false): () => void {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const answers: Middleware = {
    async onRequest({ request }) {
      const url = new URL(request.url, location.href);
      // the prefs as the server keeps them: read back whole, and the favorites kept as they are sent
      if (url.pathname === "/api/prefs" && request.method === "GET") return json(state.prefs ?? { devices: {}, repos: [], models: { favorites: [] }, home: DEFAULT_HOME });
      if (url.pathname === "/api/prefs/models" && request.method === "PUT") {
        if (starsRefused) return new Response(JSON.stringify({ error: { code: "unavailable", message: "the prefs could not be written. try again" } }), { status: 503, headers: { "content-type": "application/json" } });
        return json(await request.json());
      }
      if (url.pathname === `/api/hosts/${HOST}/sessions/${SESSION}/compact` && request.method === "POST") {
        // the daemon answers once the summary is in: here it is never, or a refusal, or at once
        if (compact === "hang") return new Promise<Response>(() => undefined);
        if (compact === "refuse") return new Response(JSON.stringify({ error: { code: "host-said", message: "the compaction did not happen: the summary came back empty. the session is unchanged" } }), { status: 502, headers: { "content-type": "application/json" } });
        return json({ ok: true });
      }
      if (url.pathname === `/api/hosts/${HOST}/commands`) return json(COMMANDS);
      if (url.pathname === `/api/hosts/${HOST}/files`) return json(FILES.filter((f) => f.includes(url.searchParams.get("query") ?? "")));
      if (url.pathname === `/api/hosts/${HOST}/models`) {
        // the models route held for good (being read), or refused, or answered
        if (models === "loading") return new Promise<Response>(() => undefined);
        if (models === "failed") return new Response(JSON.stringify({ error: { code: "host-unreachable", message: "the host did not answer" } }), { status: 502, headers: { "content-type": "application/json" } });
        return json(none ? { default: null, models: [] } : many ? MODELS_MANY : MODELS);
      }
      if (url.pathname === `/api/hosts/${HOST}/folders`) return json(browse(url.searchParams.get("path") ?? ""));
      if (url.pathname === `/api/hosts/${OTHER}/projects`) return json([{ directory: "/srv/render", updated: AT }]);
      if (url.pathname === `/api/hosts/${HOST}/projects`) return json([{ directory: DIRECTORY, updated: AT }, { directory: "/Users/dev/code/cmx2", updated: AT - 86_400_000 }, { directory: "/Users/dev/code/northstar", updated: AT - 172_800_000 }]);
      return undefined;
    },
  };
  api.use(answers);
  return () => api.eject(answers);
}

function boot(setup: Pick<Setup, "entry" | "asks" | "draft" | "outbox" | "stream" | "models" | "many" | "none" | "favorites">): void {
  const asks: Record<string, Ask> = {};
  for (const ask of setup.asks ?? []) asks[`${ask.agent}:${ask.id}`] = ask;
  bootSync({
    fleet: { ...EMPTY_FLEET, threads: { [KEY]: setup.entry }, order: [KEY], agentNames: [HOST], asks },
    threads: {},
    stream: setup.stream === "down" ? { state: "down", since: Date.now() - 64_000, lastEventAt: Date.now() - 64_000 } : LIVE,
    drafts: setup.draft ? { [KEY]: setup.draft } : {},
    outbox: setup.outbox ?? [],
  });
  if (!setup.models) setModels(HOST, setup.none ? { default: null, models: [] } : setup.many ? MODELS_MANY : MODELS);
  // the prefs are read at launch; a story has them from the start, the favorites as the server holds them
  setPrefs({ devices: {}, repos: [], models: { favorites: setup.favorites ?? [] }, home: DEFAULT_HOME });
}

/** the way a story acts on the page after it is painted */
function driving(el: HTMLElement): Drive {
  return {
    press: (label) => el.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })),
    key: (label) => el.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)?.click(),
    hit: (key) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    type: (selector, text) => {
      const field = el.querySelector<HTMLInputElement>(selector);
      if (!field) return;
      field.value = text;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    },
    later: (ms, then) => void setTimeout(then, ms),
    menu: (selector) => el.querySelector(selector)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })),
    drag: (type, selector, files) => {
      const data = new DataTransfer();
      for (const file of files ?? DROPPED()) data.items.add(file);
      el.querySelector(selector)?.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    },
  };
}

/** types into the composer's words the way a person does: focus, then an input event per change */
function typeInto(el: HTMLElement, text: string | undefined, focus: boolean): void {
  const words = el.querySelector("textarea");
  if (!words || (!focus && text === undefined)) return;
  words.focus();
  if (text) {
    words.value += text;
    words.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }
}

export function mountComposer(el: HTMLElement, story: ComposerStory): () => void {
  if (isHome(story)) return mountHome(el, story, answerReads(undefined, undefined, story === "field-model" || story === "field-typed-model"));
  const setup = SETUPS[story]();
  const restore = answerReads(setup.models, setup.compact, setup.many ?? false, setup.starsRefused, setup.none);
  installMotionProperties();
  boot(setup);
  const colour = colourStyle(REPO_COLOURS.find((c) => c.name === setup.palette) ?? hashColour({ host: HOST, root: DIRECTORY }));
  const dispose = render(
    () => (
      <div class="cz-story" data-keyboard={setup.keyboard ? "" : undefined} data-under={setup.under ? "" : undefined} style={colour}>
        <div class="cz-story-stage">
          <div class="cz-story-log">
            <p class="cz-story-you" data-message="msg_you">{PROMPTS.first}</p>
            <p class="cz-story-say">four files changed, the tests pass, and the deploy script now waits for the health check before it moves on.</p>
            {setup.under ? <p class="cz-story-say">the rollback keeps the last two builds on each machine, and the health check reads the same endpoint the load balancer does, so a build that passes here passes there. the logs for the run are in the deploy folder, one file per machine, and the summary at the top says which steps were skipped and why.</p> : null}
            {setup.under ? <p class="cz-story-say"><b>what changed:</b> the deploy waits for <code>/healthz</code> on every machine, <b>retries twice</b> with a backoff, and stops the rollout at the first machine that never answers.</p> : null}
          </div>
          <Composer target={TARGET} mount="bar" title="deploy across the machines" agents={{ count: 2, open: () => undefined }} dropZone={() => el.querySelector<HTMLElement>(".cz-story-stage")} btw={setup.btw ? fakeBtw(setup.btw) : undefined} />
        </div>
        {setup.keyboard ? <div class="cz-story-keyboard" aria-hidden="true" /> : null}
      </div>
    ),
    el,
  );
  queueMicrotask(() => {
    typeInto(el, setup.type, setup.focus ?? setup.type !== undefined);
    const press = (label: string) => el.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)?.click();
    if (story === "models-failed") press("model");
    if (story === "models-failed-dial") setTimeout(() => press("effort"), 120);
    setup.drive?.(driving(el));
    if (setup.full) {
      press("add to the message");
      setTimeout(() => press("write on the full stage"), 60);
    }
    setTimeout(() => el.querySelector(".cz-story")?.setAttribute("data-ready", ""), 600);
  });
  return () => {
    dispose();
    restore();
  };
}

function mountHome(el: HTMLElement, story: HomeStory, restore: () => void): () => void {
  installMotionProperties();
  const many = story === "field-model" || story === "field-typed-model";
  boot({ entry: IDLE, many, favorites: FAVORITES });
  const hosts = story === "field-hosts" || story === "field-typed-machine";
  if (hosts) bootSync({ fleet: { ...EMPTY_FLEET, threads: { [KEY]: IDLE }, order: [KEY], agentNames: [HOST, OTHER], asks: {} }, threads: {}, stream: LIVE, drafts: {}, outbox: [] });
  const starts = story === "field-failed" || story === "field-starting";
  const nowhere = story === "field-nowhere";
  // the place and the send live in the store for the page: each story's field takes its own place, with nothing sent
  setNewThread({ place: null, sent: null, restored: [] });
  const dispose = render(
    () => (
      <div class="nx-story" data-ready>
        <div class="nx">
          <Field start={{ host: HOST, directory: nowhere ? null : starts ? "/Users/dev/code/new-thing" : DIRECTORY }} onBorn={() => undefined} />
        </div>
      </div>
    ),
    el,
  );
  // the chips, the menus and the sends are driven the way a person drives them
  queueMicrotask(() => {
    // a tap, like the bar's stories: a click with no keyboard behind it leaves focus where it was
    const press = driving(el).press;
    const words = () => el.querySelector<HTMLTextAreaElement>(".cz-body textarea");
    const typeWords = (text: string) => {
      const field = words();
      if (!field) return;
      field.focus();
      field.value = text;
      field.setSelectionRange(text.length, text.length);
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    };
    const typeFinder = (text: string) => {
      const field = el.querySelector<HTMLInputElement>(".nx-find input");
      if (!field) return;
      field.value = text;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    };
    if (story === "field-model") setTimeout(() => press("model for the new thread"), 80);
    if (story === "field-dial") setTimeout(() => press("effort for the new thread"), 80);
    if (story === "field-hosts") setTimeout(() => press("machine for the new thread"), 60);
    if (story === "field-fresh") {
      setTimeout(() => press("repo for the new thread"), 40);
      setTimeout(() => press("a fresh worktree"), 100);
    }
    // the finder is behind the repo chip: it is opened first, as a finger would
    if (story === "field-finder" || story === "field-browse") {
      setTimeout(() => press("repo for the new thread"), 20);
      setTimeout(() => typeFinder(story === "field-browse" ? "/Users/dev/code/" : "stra"), 60);
    }
    // the place typed into the sentence: the menu opens at the caret
    if (story === "field-typed") setTimeout(() => typeWords("fix the three failing invoice tests @str"), 60);
    if (story === "field-typed-model") setTimeout(() => typeWords("port the queue to sqlite /op"), 60);
    if (story === "field-typed-machine") setTimeout(() => typeWords(`run the migration on ${OTHER.slice(0, 2)}`), 60);
    if (starts) {
      typeWords(PROMPTS.first);
      // no worker runs in a story: the send goes nowhere, and a refusal is put in the outbox the way the worker would
      const id = "c-new-thread";
      const real = crypto.randomUUID.bind(crypto);
      crypto.randomUUID = (() => id) as unknown as typeof crypto.randomUUID;
      setTimeout(() => {
        el.querySelector<HTMLButtonElement>(".cz-send")?.click();
        crypto.randomUUID = real;
        if (story === "field-failed") setTimeout(() => setOutbox([sent(id, PROMPTS.first, "failed", { verb: "start", target: { kind: "new", host: HOST, directory: "/Users/dev/code/new-thing", place: "checkout" }, key: "new:desk:/Users/dev/code/new-thing", error: `nothing at /Users/dev/code/new-thing on ${HOST}, so the thread did not start. pick another folder, or make it and retry.` })]), 120);
      }, 80);
    }
  });
  return () => {
    dispose();
    restore();
  };
}
