/* the solid side of the composer's stories (docs/composer.md, every state):
   each story boots the real store from the fixtures, answers the menus'
   reads the way boxbox's routes do, and renders the real composer in its
   mount: the bar under a thread, the dock, the sheet. a story that needs
   focus or a menu gets it the way a person would, by focusing the words
   and typing. */

import type { Middleware } from "openapi-fetch";
import { render } from "solid-js/web";
import { api } from "../../../api/client";
import { installMotionProperties } from "../../../motion/animate";
import { bootSync, setCompaction, setModels, setOutbox, setPrefs, state } from "../../../store";
import type { StreamStatus } from "../../../sync/messages";
import type { Draft, OutboxView } from "../../../sync/outbox";
import { EMPTY_FLEET } from "../../../sync/reducer";
import type { Ask, SessionEntry } from "../../../sync/protocol";
import { colourOf, colourStyle } from "../../window/repo";
import { Composer } from "../composer";
import { NewThreadDock } from "../dock";
import { NewThreadSheet } from "../sheet";
import { AT, browse, COMMANDS, DIRECTORY, draft, FAVORITES, FILES, HOST, IDLE, IDLE_NEARLY_FULL, IDLE_ON_OPUS, IDLE_WITH_CONTEXT, KEY, MODELS, MODELS_MANY, OTHER, PROMPTS, photoUrl, QUESTION, SESSION, sent, TARGET, WORKING, WORKING_WITH_CONTEXT } from "./fixtures";

export type ComposerStory =
  | "empty-done"
  | "empty-working"
  | "empty-wants"
  | "draft"
  | "long"
  | "full"
  | "shell"
  | "photo"
  | "photo-heic"
  | "sending"
  | "queued"
  | "steer"
  | "steer-run-now"
  | "failed"
  | "offline"
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
  | "dock"
  | "dock-nowhere"
  | "sheet"
  | "sheet-hosts"
  | "sheet-finder"
  | "sheet-browse"
  | "sheet-starting"
  | "sheet-failed"
  | "sheet-fresh"
  | "sheet-model"
  | "sheet-dial";

const HOME_STORIES = ["dock", "dock-nowhere", "sheet", "sheet-hosts", "sheet-finder", "sheet-browse", "sheet-starting", "sheet-failed", "sheet-fresh", "sheet-model", "sheet-dial"] as const;
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
};

type Setup = {
  entry: SessionEntry;
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
};

const LIVE: StreamStatus = { state: "live", since: AT - 600_000, lastEventAt: AT };

const SETUPS: Record<Exclude<ComposerStory, HomeStory>, () => Setup> = {
  "empty-done": () => ({ entry: IDLE }),
  "empty-working": () => ({ entry: WORKING }),
  "empty-wants": () => ({ entry: WORKING, asks: [QUESTION] }),
  draft: () => ({ entry: WORKING, draft: draft(PROMPTS.perf), focus: true }),
  long: () => ({ entry: WORKING, draft: draft(PROMPTS.long), focus: true }),
  full: () => ({ entry: WORKING, draft: draft(PROMPTS.long), focus: true, full: true }),
  shell: () => ({ entry: IDLE, draft: draft(""), type: "!git log --oneline -5" }),
  photo: () => ({ entry: IDLE, draft: draft("see the gap right?", { photos: [{ mime: "image/jpeg", filename: "gap.jpg", url: photoUrl(), width: 240, height: 520 }] }), focus: true }),
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
};

/** the menus' reads, answered as boxbox's routes answer them. the api client holds the fetch it was made with,
    so the answers go in as its middleware, which can answer before any request leaves */
function answerReads(models: "loading" | "failed" | undefined, compact: "hang" | "refuse" | "ok" | undefined, many: boolean, starsRefused = false, none = false): () => void {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const answers: Middleware = {
    async onRequest({ request }) {
      const url = new URL(request.url, location.href);
      // the prefs as the server keeps them: read back whole, and the favorites kept as they are sent
      if (url.pathname === "/api/prefs" && request.method === "GET") return json(state.prefs ?? { devices: {}, repos: [], models: { favorites: [] } });
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
  for (const ask of setup.asks ?? []) asks[ask.id] = ask;
  bootSync({
    fleet: { ...EMPTY_FLEET, sessions: { [KEY]: setup.entry }, order: [KEY], hostNames: [HOST], asks },
    threads: {},
    stream: setup.stream === "down" ? { state: "down", since: Date.now() - 64_000, lastEventAt: Date.now() - 64_000 } : LIVE,
    drafts: setup.draft ? { [KEY]: setup.draft } : {},
    outbox: setup.outbox ?? [],
  });
  if (!setup.models) setModels(HOST, setup.none ? { default: null, models: [] } : setup.many ? MODELS_MANY : MODELS);
  // the prefs are read at launch; a story has them from the start, the favorites as the server holds them
  setPrefs({ devices: {}, repos: [], models: { favorites: setup.favorites ?? [] } });
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
  if (isHome(story)) return mountHome(el, story, answerReads(undefined, undefined, story === "sheet-model"));
  const setup = SETUPS[story]();
  const restore = answerReads(setup.models, setup.compact, setup.many ?? false, setup.starsRefused, setup.none);
  installMotionProperties();
  boot(setup);
  const colour = colourStyle(colourOf({ host: HOST, root: DIRECTORY }));
  const dispose = render(
    () => (
      <div class="cz-story" data-keyboard={setup.keyboard ? "" : undefined} style={colour}>
        <div class="cz-story-stage">
          <div class="cz-story-log">
            <p class="cz-story-you" data-message="msg_you">{PROMPTS.first}</p>
            <p class="cz-story-say">four files changed, the tests pass, and the deploy script now waits for the health check before it moves on.</p>
          </div>
          <Composer target={TARGET} mount="bar" title="deploy across the machines" agents={{ count: 2, open: () => undefined }} />
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
  boot({ entry: IDLE, many: story === "sheet-model", favorites: FAVORITES });
  if (story === "sheet-hosts") bootSync({ fleet: { ...EMPTY_FLEET, sessions: { [KEY]: IDLE }, order: [KEY], hostNames: [HOST, OTHER], asks: {} }, threads: {}, stream: LIVE, drafts: {}, outbox: [] });
  const nowhere = story === "dock-nowhere";
  const dispose = render(
    () => (
      <div class="cz-story home-story" data-ready>
        <div class="cz-story-deck plane-window" aria-hidden="true" />
        <NewThreadDock host={HOST} directory={nowhere ? null : DIRECTORY} showHost={false} onOpen={() => undefined} />
        {story.startsWith("sheet") ? <NewThreadSheet host={HOST} directory={story === "sheet-failed" || story === "sheet-starting" ? "/Users/dev/code/new-thing" : DIRECTORY} onOpened={() => undefined} onClose={() => undefined} /> : null}
      </div>
    ),
    el,
  );
  // the finder and the sends are driven the way a person drives them
  queueMicrotask(() => {
    // a tap, like the bar's stories: a click with no keyboard behind it leaves focus where it was
    const press = driving(el).press;
    const typeFinder = (text: string) => {
      const field = el.querySelector<HTMLInputElement>(".cz-find");
      if (!field) return;
      field.value = text;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    };
    if (story === "sheet-model") setTimeout(() => press("model for the new thread"), 80);
    if (story === "sheet-dial") setTimeout(() => press("effort for the new thread"), 80);
    if (story === "sheet-fresh") setTimeout(() => press("a fresh worktree"), 80);
    if (story === "sheet-finder" || story === "sheet-browse") {
      setTimeout(() => typeFinder(story === "sheet-browse" ? "/Users/dev/code/" : "stra"), 40);
    }
    if (story === "sheet-starting" || story === "sheet-failed") {
      const words = el.querySelector<HTMLTextAreaElement>(".cz-body textarea");
      if (words) {
        words.value = PROMPTS.first;
        words.dispatchEvent(new InputEvent("input", { bubbles: true, data: PROMPTS.first, inputType: "insertText" }));
        // no worker runs in a story: the send goes nowhere, and a refusal is put in the outbox the way the worker would
        const id = "c-new-thread";
        const real = crypto.randomUUID.bind(crypto);
        crypto.randomUUID = (() => id) as unknown as typeof crypto.randomUUID;
        setTimeout(() => {
          el.querySelector<HTMLButtonElement>(".cz-send")?.click();
          crypto.randomUUID = real;
          if (story === "sheet-failed") setTimeout(() => setOutbox([sent(id, PROMPTS.first, "failed", { verb: "start", target: { kind: "new", host: HOST, directory: "/Users/dev/code/new-thing", place: "checkout" }, key: "new:desk:/Users/dev/code/new-thing", error: `nothing at /Users/dev/code/new-thing on ${HOST}, so the thread did not start. pick another folder, or make it and retry.` })]), 120);
        }, 80);
      }
    }
  });
  return () => {
    dispose();
    restore();
  };
}
