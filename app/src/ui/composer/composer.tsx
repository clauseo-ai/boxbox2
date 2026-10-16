/* the composer (docs/composer.md): one component with a target, an open
   session or a new thread in a repo, and three mounts: the bar under a
   thread (and the dock on the phone's home), the sheet for a new thread,
   and the full stage a draft grows into past six lines.

   the direction is the window: the composer is made of a window's own
   material in the target repo's colour, carries one live line of what the
   agent is doing (only when that is not already on screen), and says in
   words what send will do. motion comes from real events only: a step
   rolls the line, a send flies into its place, a queued card rises into
   the thread when it lands. nothing loops.

   drafts and sends go through the worker (sync/client.ts): drafts are kept
   in indexeddb per target on every keystroke; a send is honest, shown as
   sending until the daemon echoes its client id. its mount stands it on the
   keyboard; it reads the visual viewport only to fit what floats above it (a
   menu) and how many lines its words may grow to, on the viewport's own
   resize events, never in a frame loop. */

import { For, Show, createComputed, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { flyInto } from "../../motion/fly";
import { flip, play } from "../../motion/animate";
import { ROLL_IN, SNAP } from "../../motion/springs";
import { state, setCompaction, setComposerNotice } from "../../store";
import { discardSend, retrySend, saveDraft, sendMessage, unsendQueued } from "../../sync/client";
import { type Draft, type OutboxView, type Photo, photoBytes, type Target, targetKey, type Verb } from "../../sync/outbox";
import { api } from "../../api/client";
import { deviceClass, deviceId } from "../../push/device";
import { answerQuestion } from "../asks/answer";
import { questionsOf } from "../asks/words";
import { type RepoColour, colourOf, colourStyle, repoName } from "../window/repo";
import { bytesOfUrl, megabytes, noRoomFor } from "./fit";
import { isOriginal, kindOf } from "./heic";
import { clampPhoto, MAX_PHOTOS } from "./photo";
import { compactThread } from "./compact";
import { ContextRing } from "./context";
import { EffortDial, EffortMeter } from "./dial";
import { scaleOf } from "./effort";
import { favorites, refreshFavorites, toggleFavorite } from "./favorites";
import { Icon, type IconName } from "./icons";
import { MarkGlyph } from "./mark";
import { providerKey } from "./marks";
import { ModelMenu } from "./model-menu";
import { type CommandChoice, commands, ensureModels, files } from "./reads";
import { modelName } from "../model-name";
import { fileDrop, withMention, withWords } from "./drop";
import { inlineRuns } from "./inline";
import { QueueStrip, type QueueVerb } from "./queue";
import { type Agent, type Card, compactionWords, compactMeta, contextFill, DRAFTS_FULL, DROP_LINE, effortChoices, fateLine, type ListState, liveLine, menuOf, menuQuery, type Mount, placeholder, sendWord, tailPrint, typedAnswers, withFile } from "./words";
import "./composer.css";

/** a draft past this many lines offers the full stage */
const TALL_LINES = 6;
/** holding send this long steers instead of queueing */
const HOLD_MS = 420;
/** the stream may be down this long before the composer says offline (design.md, honesty) */
const OFFLINE_AFTER_MS = 5000;
/** a send's "sending" card is shown only when its echo takes longer than this after the tap: on a good connection the message is in the
    thread within a frame or a few of the post returning, and a card that came and went would move the dock by its own height */
const SENDING_GRACE_MS = 600;
/** a pause in typing after `@` this long reads the files */
const FILES_PAUSE_MS = 140;
/** a menu is at most this tall, at least this tall (it scrolls inside), and keeps this far from the top of the screen */
const MENU_MAX = 440;
const MENU_MIN = 168;
const MENU_MARGIN = 20;

export type ComposerProps = {
  target: Target;
  mount: Mount;
  /** the thread's title, for names and the full stage */
  title?: string;
  /** a new thread's first message went: the sheet closes into its window */
  onStarted?: (clientID: string, from: HTMLElement) => void;
  /** the element whose visibility means the agent's newest step is already on screen */
  onScreen?: () => Element | null | undefined;
  /** the person's own send went, or their typed answer to a question (not a card sent again after it was taken back): the stage takes them to the end, where it lands */
  onSent?: () => void;
  /** take focus when mounted (the sheet) */
  autofocus?: boolean;
  /** why a send cannot go yet (the sheet before a folder is picked); the words are still kept */
  blocked?: string | undefined;
  /** the thread's agents (docs/thread.md, the agents panel): how many it started, and what its row in the plus menu opens */
  agents?: { count: number; open: () => void };
  /** the colour the thread is painted in, so the composer on a stage is the stage's own; without it, the repo's */
  colour?: RepoColour;
  /** a wider drop target than the composer itself (the thread's stage): a photo or a file dropped anywhere on it lands here */
  dropZone?: () => HTMLElement | null | undefined;
};

const EMPTY: Draft = { text: "", photos: [], model: null, effort: null, at: 0 };

/** a row of the slash menu: the daemon's commands, and the few boxbox runs itself */
type SlashChoice = CommandChoice & { local?: boolean };

export function Composer(props: ComposerProps) {
  const key = () => targetKey(props.target);
  const host = () => props.target.host;
  const directory = () => props.target.directory;
  const repo = () => repoName(directory());
  const draft = () => state.composer.drafts[key()] ?? EMPTY;
  const entry = () => (props.target.kind === "session" ? state.fleet.sessions[key()] : undefined);
  /* a session's colour is its project root's, as its window's is (window/view.ts): its directory may be a worktree,
     which would hash to another hue */
  const colour = createMemo(() => props.colour ?? colourOf({ host: host(), root: entry()?.info.projectID || directory() }));
  const asks = createMemo(() => Object.values(state.fleet.asks).filter((ask) => ask.key === key()));
  /** how many questions the ask waiting on this thread holds: words typed here answer each of them */
  const questionCount = createMemo(() => { const ask = asks().find((a) => a.kind === "question"); return ask ? questionsOf(ask).length : 1; });

  const [now, setNow] = createSignal(Date.now());
  const agent = createMemo<Agent>(() => {
    if (state.stream.state === "down" && now() - state.stream.since > OFFLINE_AFTER_MS) return "offline";
    if (asks().some((ask) => ask.kind === "question")) return "wants";
    const status = entry()?.status;
    return status && status.type !== "idle" ? "working" : "idle";
  });
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  const [focused, setFocused] = createSignal(false);
  const [steering, setSteering] = createSignal(false);
  const [menu, setMenu] = createSignal<"/" | "@" | "!" | "model" | "tools" | null>(null);
  /* the effort dial: the line's row turns into the model's efforts, one tap each, and turns back when one is picked */
  const [dial, setDial] = createSignal(false);
  // opened from a keyboard: focus lands on the dial's pick, so arrows work at once; a finger leaves focus where it was
  const [dialByKey, setDialByKey] = createSignal(false);
  /* the room above the composer, for the menus: read when one opens and when the keyboard moves the visual viewport */
  const [room, setRoom] = createSignal<number | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  const [full, setFull] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  // news from the worker for this target's composer (photos handed back that did not fit the draft) is said in its own line
  createEffect(() => {
    const notice = state.composer.notice;
    if (notice?.key !== key()) return;
    setProblem(notice.text);
    setComposerNotice(notice.key, null);
  });
  const [onScreen, setOnScreen] = createSignal(false);
  /* a drag the composer can take is over it (drops, below). the composer and the stage count their drags apart: a drag moving
     from the stage onto the composer leaves one as it enters the other */
  const [overSelf, setOverSelf] = createSignal(false);
  const [overZone, setOverZone] = createSignal(false);
  const dropping = () => overSelf() || overZone();

  const shell = () => draft().text.startsWith("!");
  const has = () => draft().text.trim().length > 0 || draft().photos.length > 0;
  const word = () => sendWord(props.mount, agent(), steering(), shell());
  const worded = () => has() && word() !== "send" && props.mount === "bar";

  /* —— the queue: this device's sends and the daemon's provisional messages, in order —— */
  const outbox = createMemo(() => state.composer.outbox.filter((e) => e.key === key()));
  const foreign = createMemo(() => {
    const mine = new Set(outbox().map((e) => e.clientID));
    return (state.threads[key()]?.messages ?? []).filter((m) => m.info.queued === true && !(m.info.clientID && mine.has(m.info.clientID)));
  });
  /* the sends that have waited past the grace: only these show their "sending" card */
  const [graced, setGraced] = createSignal<ReadonlySet<string>>(new Set());
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  createEffect(() => {
    for (const e of outbox()) {
      if ((e.state !== "sending" && e.state !== "landed") || graced().has(e.clientID) || graceTimers.has(e.clientID)) continue;
      const id = e.clientID;
      graceTimers.set(id, setTimeout(() => { graceTimers.delete(id); setGraced((was) => new Set([...was, id])); }, Math.max(0, SENDING_GRACE_MS - (Date.now() - e.at))));
    }
  });
  onCleanup(() => { for (const t of graceTimers.values()) clearTimeout(t); });
  type Shown = { id: string; text: string; card: Card; entry: OutboxView | null; messageID: string | null; photos: number };
  const cards = createMemo<Shown[]>(() => {
    const shown: Shown[] = [];
    let place = 0;
    for (const e of outbox()) {
      if (e.verb === "start" || e.target.kind === "new") continue;
      const stands = e.state === "queued" ? (e.verb === "steer" ? "steer" : "queued") : e.state === "landed" ? "sending" : e.state;
      if (stands === "sending" && !graced().has(e.clientID) && Date.now() - e.at < SENDING_GRACE_MS) continue;
      shown.push({ id: e.clientID, text: e.verb === "shell" ? `!${e.text}` : e.text, card: { state: stands, place: stands === "queued" ? place++ : 0, error: e.error, photos: e.photos, ...(e.photosReturned ? { photosReturned: e.photosReturned } : {}) }, entry: e, messageID: e.provisional, photos: e.photos });
    }
    for (const m of foreign()) {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim() || "a message from another device";
      shown.push({ id: m.info.id, text, card: { state: "queued", place: place++ }, entry: null, messageID: m.info.id, photos: 0 });
    }
    return shown;
  });
  const waitingCount = () => cards().filter((c) => c.card.state === "queued").length;
  /* the list above is built again whenever the thread's messages change, and a working turn changes them at every step: the
     strip and its list (queue.tsx) never key an element by that list's objects, and a verb finds its message here by id */
  const cardOf = createMemo(() => new Map(cards().map((c) => [c.id, c])));

  /* —— the live line: what the agent is doing, when that is not already on screen —— */
  /* a turn that has just begun: the session's busy status can land a few milliseconds before the update that puts the new
     prompt in the tail, and in that gap the newest row with words is still the last turn's answer. from the moment a
     session known to be idle goes busy the line shows nothing until the tail has moved; a thread opened mid-turn has no
     such moment (its session was not known idle) and its line shows at once */
  const phase = (): "idle" | "busy" | null => {
    const held = entry();
    if (!held) return null;
    return held.status && held.status.type !== "idle" ? "busy" : "idle";
  };
  const tailNow = createMemo(() => tailPrint(entry()?.tail ?? []));
  const [begun, setBegun] = createSignal<string | null>(null);
  createComputed(on(phase, (now, before) => {
    if (before === "idle" && now === "busy") setBegun(untrack(tailNow));
    else if (now !== "busy") setBegun(null);
  }, { defer: true }));
  createEffect(() => { const from = begun(); if (from !== null && tailNow() !== from) setBegun(null); });
  const line = createMemo<{ kind: string; text: string; prose: boolean; key?: string } | null>(() => {
    if (dropping()) return { kind: "", text: DROP_LINE, prose: true };
    // the sheet's place line already says where the new thread starts: its row is the chips alone, and never repeats it
    if (props.mount !== "bar") return null;
    if (focused() || has() || steering()) return { kind: "", text: fateLine(props.mount, agent(), steering(), shell(), waitingCount(), host(), repo(), questionCount()), prose: true };
    if (agent() === "offline") return { kind: "", text: `offline, last update ${clockOf(state.stream.lastEventAt)}`, prose: true };
    if (agent() !== "working" || onScreen()) return null;
    if (begun() !== null && tailNow() === begun()) return null;
    return liveLine(entry()?.tail ?? []);
  });

  let lineEl: HTMLDivElement | undefined;
  createEffect(
    on(
      () => { const l = line(); return l && l.text ? (l.key ?? l.text) : undefined; },
      (now, before) => {
        // a new step or row rolls in; the same row's text growing changes in place, and anything painted from cache or
        // replay just changes (the motion law)
        if (!lineEl || !now || !before || now === before || state.stream.state !== "live") return;
        play(lineEl, [{ transform: "translateY(60%)", opacity: 0 }, { transform: "none", opacity: 1 }], ROLL_IN);
      },
      { defer: true },
    ),
  );

  // the sheet opens on a tap: focus here, inside that gesture, is what raises the phone's keyboard
  onMount(() => {
    if (props.autofocus) editor?.focus({ preventScroll: true });
  });
  onMount(() => {
    const target = props.onScreen?.();
    if (!target) return;
    /* the newest report: a first look and the scroll that follows it can arrive together (a thread opened cold lands at its
       end in the frame after it is observed), and the first is stale */
    const observer = new IntersectionObserver((seen) => setOnScreen((seen.at(-1)?.intersectionRatio ?? 0) > 0.4), { threshold: [0, 0.4, 1] });
    observer.observe(target);
    onCleanup(() => observer.disconnect());
  });

  /* —— the draft —— */
  const write = (next: Partial<Draft>) => {
    const before = draft();
    const merged = { ...before, ...next, at: Date.now() };
    // only the person's own edits come through here, so emptying it is throwing it away (friction.abandon)
    const abandoned = Boolean(before.text || before.photos.length) && !merged.text && !merged.photos.length;
    // words, a model or an effort changed and the photos did not: only the words go to the worker (a photo can be megabytes)
    saveDraft(key(), merged.text || merged.photos.length || merged.model || merged.effort ? merged : null, abandoned, "photos" in next ? "changed" : "kept");
  };
  let editor: HTMLTextAreaElement | undefined;
  /* —— the words' shape (docs/composer.md, the layout): one line sits between the plus and send; a second line (a wrap at the
     room between the keys, or a return) puts the words the window's full width with the keys on a row of their own under
     them, so no line is ever under a key. the wrap is measured by a ruler at the one-row width, so the shape never flips
     back and forth at the width in between —— */
  let bodyEl: HTMLDivElement | undefined;
  let ruler: HTMLDivElement | undefined;
  const [stacked, setStacked] = createSignal(false);
  const reshape = () => {
    if (!ruler || !editor) return;
    ruler.textContent = `${draft().text}\u200b`;
    const style = getComputedStyle(ruler);
    const line = parseFloat(style.lineHeight) || 24;
    // the sheet's words are two lines tall before they type a word, the keys in the corners under them: a third line is the one
    // that would run under a key
    const room = props.mount === "sheet" ? 2 : 1;
    const next = full() || ruler.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) > line * (room + 0.5);
    if (next === stacked()) return;
    // the keys move to their row and back on the snap spring, and the words glide sideways from where they were; the
    // window's own height changes at once (only transform animates)
    const glide = parseFloat(getComputedStyle(editor).paddingLeft);
    const keys = [plusKey, bodyEl?.querySelector(".cz-send")].filter((el): el is HTMLElement => Boolean(el));
    const live = state.stream.state === "live" && document.visibilityState === "visible";
    flip(keys, () => setStacked(next), SNAP, live);
    const dx = glide - parseFloat(getComputedStyle(editor).paddingLeft);
    if (Math.abs(dx) > 0.5) play(editor, [{ transform: `translateX(${dx}px)` }, { transform: "none" }], SNAP, { live });
  };
  createEffect(on(() => [draft().text, worded(), full()], () => reshape()));
  onMount(() => {
    if (!bodyEl) return;
    // a new width (a rotation, the rail opening) moves where the words wrap
    let width = bodyEl.clientWidth;
    const observer = new ResizeObserver(() => {
      if (!bodyEl || bodyEl.clientWidth === width) return;
      width = bodyEl.clientWidth;
      reshape();
    });
    observer.observe(bodyEl);
    onCleanup(() => observer.disconnect());
  });
  /* the words grow to six lines, or fewer when the screen above the keyboard cannot hold the whole composer with six: the
     largest type, a short landscape screen. whole lines, so the last line in sight is whole and the keys stay above the keyboard */
  const [lines, setLines] = createSignal(TALL_LINES);
  const fitLines = () => {
    if (!rootEl || !editor || full()) return;
    const top = window.visualViewport?.offsetTop ?? 0;
    const box = rootEl.getBoundingClientRect();
    const words = editor.getBoundingClientRect().height;
    const style = getComputedStyle(editor);
    const line = parseFloat(style.lineHeight) || 24;
    const pads = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const room = box.bottom - top - MENU_MARGIN - (box.height - words) - pads;
    setLines(Math.min(TALL_LINES, Math.max(1, Math.floor(room / line))));
  };
  createEffect(() => {
    if (!focused() || !window.visualViewport) return;
    fitLines();
    window.visualViewport.addEventListener("resize", fitLines);
    onCleanup(() => window.visualViewport?.removeEventListener("resize", fitLines));
  });
  const tall = () => draft().text.split("\n").length > TALL_LINES || (editor?.scrollHeight ?? 0) > editor!.clientHeight + 4; // editor is bound by ref before any draft paints

  const onInput = (event: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    const text = event.currentTarget.value;
    write({ text });
    const opened = menuOf(text);
    setMenuIndex(0);
    if (opened !== menu() && (opened || (menu() !== "model" && menu() !== "tools"))) setMenu(opened);
    if (opened === "@") readFiles(text);
  };

  /* —— menus —— */
  const [commandList, setCommandList] = createSignal<CommandChoice[] | null>(null);
  const [fileList, setFileList] = createSignal<string[] | null>(null);
  const [menuProblem, setMenuProblem] = createSignal<string | null>(null);
  // the sheet changes the target in place (a repo picked): what was read for the last one does not hold for this one
  createEffect(
    on(
      key,
      () => {
        setCommandList(null);
        setFileList(null);
        setMenu(null);
        setProblem(null);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(menu, async (open) => {
      setMenuProblem(null);
      if (open === "/" && commandList() === null) {
        const read = await commands(host(), directory());
        if (read.ok) setCommandList(read.value);
        else setMenuProblem(read.message);
      }
      if (open === "model") {
        void ensureModels(host());
        // the stars another device made are there when the menu opens
        void refreshFavorites();
      }
    }),
  );
  /* a menu fits the room it has: the space above the composer, read once as it opens and again when the keyboard moves
     the visual viewport (an event, never a frame loop). in the sheet a menu sits in the flow and the sheet scrolls */
  let rootEl: HTMLDivElement | undefined;
  const measureRoom = () => {
    if (!rootEl || props.mount === "sheet") return setRoom(null);
    setRoom(Math.max(MENU_MIN, Math.min(MENU_MAX, rootEl.getBoundingClientRect().top - MENU_MARGIN)));
  };
  createEffect(() => {
    if (!menu() || !window.visualViewport) return;
    measureRoom();
    window.visualViewport.addEventListener("resize", measureRoom);
    onCleanup(() => window.visualViewport?.removeEventListener("resize", measureRoom));
  });
  let filesTimer: ReturnType<typeof setTimeout> | undefined;
  const readFiles = (text: string) => {
    clearTimeout(filesTimer);
    filesTimer = setTimeout(async () => {
      const read = await files(host(), directory(), menuQuery(text, "@"));
      if (read.ok) setFileList(read.value);
      else setMenuProblem(read.message);
    }, FILES_PAUSE_MS);
  };
  onCleanup(() => clearTimeout(filesTimer));

  /* the slash menu's own entries, which boxbox runs itself: under an open thread, compact. a daemon command of the same name
     does not shadow it */
  const LOCAL: SlashChoice[] = [{ name: "compact", description: "summarise to free the context", hints: [], source: "command", local: true }];
  const commandOptions = createMemo<SlashChoice[]>(() => {
    const q = menu() === "/" ? menuQuery(draft().text, "/") : "";
    const mine = props.target.kind === "session" ? LOCAL.filter((c) => c.name.startsWith(q)) : [];
    const theirs = (commandList() ?? []).filter((c) => c.name.toLowerCase().startsWith(q) && !mine.some((m) => m.name === c.name));
    return [...mine, ...theirs].slice(0, 8);
  });
  const models = () => state.models[host()];
  /* the host's list: here, being read, or did not come. the chip names the thread's model from it, so it is read once per
     host, not when the menu opens; one that did not come is read again when the stream comes back, when the app returns to
     the foreground, and when the person asks (the menu's retry, or a tap on the effort chip) */
  const list = (): ListState => (models() ? "ready" : state.modelsRead[host()] === "failed" ? "failed" : "loading");
  const retryModels = () => void ensureModels(host());
  createEffect(() => void ensureModels(host()));
  createEffect(
    on(
      () => [state.stream.state, state.stream.since],
      () => {
        if (state.stream.state === "live" && list() === "failed") retryModels();
      },
      { defer: true },
    ),
  );
  const onForeground = () => {
    if (document.visibilityState === "visible" && list() === "failed") retryModels();
  };
  document.addEventListener("visibilitychange", onForeground);
  onCleanup(() => document.removeEventListener("visibilitychange", onForeground));
  /* cmx2 makes a message's model and effort the thread's from that turn on, so the chip shows the
     thread's as the daemon reports them, and the draft holds only a pick that has not gone yet */
  const threadModel = () => {
    const model = entry()?.info.model;
    return model ? `${model.providerID}/${model.id}` : null;
  };
  const chosenModel = () => draft().model ?? threadModel() ?? models()?.default ?? null;
  const modelChoice = () => models()?.models.find((m) => m.id === chosenModel()) ?? null;
  // the chip's mark: from the host's list when it is here, else from the thread's own model id
  const chosenProvider = () => {
    const choice = modelChoice();
    return choice ? providerKey(choice) : (chosenModel()?.split("/")[0] ?? "");
  };
  // with no pick and none on the thread, the daemon chooses the model's own default; the chip does not guess it
  const chosenEffort = () => draft().effort ?? entry()?.info.effort ?? null;
  const effortChip = createMemo(() => effortChoices({ accepted: modelChoice()?.efforts ?? [], current: chosenEffort(), list: list() }));
  const efforts = () => effortChip().known;
  // while the list is not here the chip says the thread's model in words (never the raw id) and wears the quiet mark
  const modelLabel = () => { const id = chosenModel(); return id ? modelName(id) : "model"; };
  const listWhy = () => (list() === "ready" ? "" : list() === "failed" ? ", the model list did not come" : ", reading the model list");
  /* a pick that is the thread's own is no pick: the draft holds only what would change it */
  const pickModel = (id: string, accepted: readonly string[], fromFilter: boolean) => {
    const effort = draft().effort && accepted.includes(draft().effort ?? "") ? draft().effort : null;
    write({ model: id === threadModel() ? null : id, effort });
    setMenu(null);
    // picked from the filter: back to the words, so typing goes on where it was
    if (fromFilter) editor?.focus({ preventScroll: true });
  };
  // the dial folds itself back into the chip once its thumb has landed
  const pickEffort = (effort: string) => write({ effort: effort === (entry()?.info.effort ?? null) ? null : effort });
  /* a star on a model row: on screen at once, kept by the server, put back with the reason when it is not */
  const star = async (id: string) => {
    const kept = await toggleFavorite(id);
    if (!kept.ok) setProblem(kept.error);
  };
  // a pick that cannot ride the next send (the agent is working: cmx2 a18) waits for the next idle one, and says so
  const waits = () => props.target.kind === "session" && agent() !== "idle" && Boolean(draft().model || draft().effort);
  const toggleDial = (event: MouseEvent) => {
    setMenu(null);
    const open = !dial();
    // a keyboard opens the dial onto its current pick; a finger leaves focus where it was, so no keyboard rises. said
    // first, since the dial reads it as it is made
    setDialByKey(open && event.detail === 0);
    setDial(open);
    // a list that did not come is read again by the tap that wants it
    if (open && list() === "failed") retryModels();
  };
  // a dial that a keyboard opened hands focus back to its chip when it folds, so the keyboard does not fall to the page
  const closeDial = () => {
    const byKey = dialByKey();
    setDial(false);
    if (byKey) queueMicrotask(() => rootEl?.querySelector<HTMLElement>('.cz-chip[aria-label^="effort"]')?.focus({ preventScroll: true }));
  };
  let plusKey: HTMLButtonElement | undefined;
  const toggleMenu = (which: "model" | "tools", byKey = false) => {
    setDial(false);
    const open = menu() !== which;
    setMenu(open ? which : null);
    // a keyboard that opened the plus menu lands on its first row, so arrows work at once (a finger leaves focus where it was)
    if (open && byKey && which === "tools") queueMicrotask(() => rootEl?.querySelector<HTMLElement>(".cz-menu .cz-option.tool")?.focus({ preventScroll: true }));
  };
  /* the plus menu is a menu of buttons: arrows walk its rows, escape closes it and hands focus back to the plus key */
  const onToolsKey = (event: KeyboardEvent) => {
    if (menu() !== "tools") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      plusKey?.focus({ preventScroll: true });
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const rows = [...(rootEl?.querySelectorAll<HTMLElement>(".cz-menu .cz-option.tool") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[(at + step + rows.length) % rows.length]?.focus({ preventScroll: true });
  };

  const pick = (index: number) => {
    const open = menu();
    if (open === "/") {
      const choice = commandOptions()[index];
      if (choice?.local) {
        // a compaction that cannot start leaves what was typed where it was
        const blocked = compactBlock();
        if (blocked) {
          setMenu(null);
          setProblem(blocked);
          return;
        }
        clearSlash();
        startCompact();
      } else if (choice) setText(`/${choice.name} `);
    } else if (open === "@") {
      const path = fileList()?.[index];
      if (path) setText(withFile(draft().text, path));
    }
    setMenu(null);
  };
  /* the slash that opened the menu was only a way to ask for the command: it goes, and what else the draft holds stays */
  const clearSlash = () => {
    const d = draft();
    saveDraft(key(), d.photos.length || d.model || d.effort ? { ...d, text: "", at: Date.now() } : null);
    if (editor) {
      editor.value = "";
      editor.focus({ preventScroll: true });
    }
  };

  /* —— compacting: the daemon summarises the thread so far, and answers once the summary is in —— */
  const compaction = () => state.composer.compacting[key()];
  const compacting = () => compaction()?.state === "running";
  const fill = createMemo(() => contextFill(entry()?.info.context));
  /* why a compaction cannot start now, or null. the daemon refuses a thread with a turn running, so the composer says so before asking */
  const compactBlock = (): string | null => (agent() === "idle" ? null : agent() === "offline" ? "the connection is down. compact when it is back" : "a turn is running. wait for it to end, then compact");
  const startCompact = () => {
    const target = props.target;
    if (target.kind !== "session" || compacting()) return;
    const blocked = compactBlock();
    if (blocked) return setProblem(blocked);
    // a keyboard on a row of the plus menu keeps its place: the menu goes, focus goes back to the plus key
    const held = rootEl?.querySelector(".cz-menu")?.contains(document.activeElement) ?? false;
    setMenu(null);
    if (held) plusKey?.focus({ preventScroll: true });
    setProblem(null);
    void compactThread(host(), target.session);
  };
  const setText = (text: string) => {
    write({ text });
    if (editor) editor.value = text;
    caretToEnd();
  };
  /** the words are being fixed: focus on them, the caret at their end */
  const caretToEnd = () => {
    if (!editor) return;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
  };

  /* —— photos —— */
  let picker: HTMLInputElement | undefined;
  const addPhotos = async (list: FileList | readonly File[] | null) => {
    if (!list) return;
    // the draft the photos were picked for: clamping awaits, and the person may have moved to another thread meanwhile
    const at = key();
    const held = (): Draft => state.composer.drafts[at] ?? EMPTY;
    const say = (words: string) => key() === at && setProblem(words);
    const room = MAX_PHOTOS - held().photos.length;
    const picked = [...list].slice(0, Math.max(0, room));
    if (list.length > room) say(`${MAX_PHOTOS} photos is the most one message carries`);
    const added: Photo[] = [];
    // what the device holds that has not gone: every draft's photos and every unsent message's (one cap; AGENTS.md, memory and latency)
    const onDevice = () => Object.values(state.composer.drafts).reduce((sum, d) => sum + photoBytes(d.photos), 0) + state.composer.outbox.reduce((sum, e) => sum + e.photoBytes, 0);
    for (const file of picked) {
      const clamped = await clampPhoto(file);
      if (!clamped.ok) {
        say(clamped.reason);
        continue;
      }
      const taken = photoBytes(added);
      const why = noRoomFor(clamped.photo.filename, clamped.photo.url.length, photoBytes(held().photos) + taken, onDevice() + taken);
      if (why) say(why);
      else added.push(clamped.photo);
    }
    // to the draft they were picked for, as it stands now (words typed while the photos were read are kept)
    if (added.length) saveDraft(at, { ...held(), photos: [...held().photos, ...added], at: Date.now() }, false, "changed");
  };

  /* —— drops (docs/composer.md, attachments): a photo joins the photos, any other file is mentioned by its name, words join the
     draft; on the composer, and on the stage around it when its mount offers one —— */
  const takeDrop = (dropped: { photos: File[]; mentions: string[]; words: string }) => {
    if (dropped.photos.length) void addPhotos(dropped.photos);
    if (!dropped.mentions.length && !dropped.words) return;
    const text = dropped.mentions.reduce(withMention, withWords(draft().text, dropped.words));
    setText(text);
  };
  onMount(() => {
    if (rootEl) fileDrop(rootEl, setOverSelf, takeDrop);
  });
  createEffect(() => {
    const zone = props.dropZone?.();
    if (zone) fileDrop(zone, setOverZone, takeDrop);
  });

  /* —— sending —— */
  let windowEl: HTMLDivElement | undefined;
  const send = async (mode?: "steer") => {
    if (!has() || props.blocked) return;
    const text = draft().text.trim();
    if (text === "/compact" && props.target.kind === "session" && !draft().photos.length) {
      const blocked = compactBlock();
      if (blocked) return setProblem(blocked);
      clearSlash();
      return startCompact();
    }
    const steer = mode === "steer" && agent() === "working";
    const firstAsk = asks().find((ask) => ask.kind === "question");
    if (agent() === "wants" && firstAsk && !shell() && draft().photos.length === 0) {
      // the composer answers the question in your own words (the ask card offers the options); an ask of several questions
      // is answered with the same words for each, one list per question as the daemon takes them
      const outcome = await answerQuestion(firstAsk, crypto.randomUUID(), typedAnswers(questionsOf(firstAsk).length, text));
      if (outcome.kind === "failed") return setProblem(outcome.message);
      // an answer carries no model or effort, so a pick made meanwhile still waits for the next message
      const picked = draft().model || draft().effort;
      saveDraft(key(), picked ? { ...EMPTY, model: draft().model, effort: draft().effort, at: Date.now() } : null);
      if (editor) editor.value = "";
      props.onSent?.();
      return;
    }
    const isCommand = text.startsWith("/") && (commandList() ?? []).some((c) => text.slice(1).split(" ")[0] === c.name);
    const verb: Verb = props.target.kind === "new" ? "start" : shell() ? "shell" : isCommand ? "command" : steer ? "steer" : "prompt";
    // a queued or steered message cannot carry its own model yet (cmx2 a18): only an idle send does
    const carriesChoice = verb === "start" || (verb === "prompt" && agent() === "idle");
    const clientID = crypto.randomUUID();
    sendMessage({
      clientID,
      verb,
      target: props.target,
      text: verb === "shell" ? text.slice(1).trim() : text,
      photos: draft().photos,
      model: carriesChoice ? draft().model : null,
      effort: carriesChoice ? draft().effort : null,
      at: Date.now(),
    });
    props.onSent?.();
    setSteering(false);
    setMenu(null);
    // a pick that went is the thread's now; one a queued message could not carry waits for the next idle send
    const kept = !carriesChoice && (draft().model || draft().effort);
    saveDraft(key(), kept ? { ...EMPTY, model: draft().model, effort: draft().effort, at: Date.now() } : null);
    if (editor) editor.value = "";
    if (verb === "start" && windowEl) props.onStarted?.(clientID, windowEl);
    if (full()) setFull(false);
  };

  /* hold to steer: the word turns to steer and the line says where it lands; letting go sends it */
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  const holdStart = () => {
    if (!has() || agent() !== "working" || props.mount !== "bar" || shell()) return;
    holdTimer = setTimeout(() => {
      held = true;
      setSteering(true);
    }, HOLD_MS);
  };
  const holdEnd = (fire: boolean) => {
    clearTimeout(holdTimer);
    if (!held) return;
    held = false;
    if (fire) void send("steer");
    else setSteering(false);
  };
  onCleanup(() => clearTimeout(holdTimer));

  const onKeyDown = (event: KeyboardEvent) => {
    const list = menu() === "/" ? commandOptions().length : menu() === "@" ? (fileList()?.length ?? 0) : 0;
    if (list && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setMenuIndex((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + list) % list);
      return;
    }
    if (list && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      pick(menuIndex());
      return;
    }
    // escape closes the dial from the words too (the dial's own handler only hears keys while focus is inside the top row)
    if (event.key === "Escape" && dial()) {
      event.preventDefault();
      event.stopPropagation();
      closeDial();
      return;
    }
    if (event.key === "Escape" && (menu() || full())) {
      event.preventDefault();
      if (menu()) setMenu(null);
      else setFull(false);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send("steer");
      return;
    }
    // return sends with a keyboard; on touch it is a newline and the button sends (design.md, input)
    if (event.key === "Enter" && !event.shiftKey && matchMedia("(hover: hover) and (pointer: fine)").matches) {
      event.preventDefault();
      void send();
    }
  };

  /* —— the queue's verbs —— */
  /* the messages being taken back: the strip and the list fade them and turn their cross off until the daemon answers */
  const [unsending, setUnsending] = createSignal<ReadonlySet<string>>(new Set());
  const unsend = async (card: Shown) => {
    if (!card.messageID || unsending().has(card.id)) return;
    setUnsending((was) => new Set([...was, card.id]));
    const result = await unsendQueued(key(), card.messageID, card.entry?.clientID ?? null, true);
    setUnsending((was) => new Set([...was].filter((id) => id !== card.id)));
    if (!result.ok) return setProblem(result.message ?? "it could not be taken back");
    // a message of this device's own comes back from the worker with its photos and, into a draft that held nothing, its
    // words, in one step (so the photos coming back cannot make the draft look written): the caret goes where it ends. one
    // from another device has no photos here, and its words come back to an empty draft the same way
    if (result.returned) caretToEnd();
    else if (!has()) setText(card.text);
  };
  const steerNow = async (card: Shown) => {
    if (!card.messageID) return;
    const result = await unsendQueued(key(), card.messageID, card.entry?.clientID ?? null);
    if (!result.ok) return setProblem(result.message ?? "it already went");
    sendMessage({ clientID: crypto.randomUUID(), verb: "steer", target: props.target, text: card.text, photos: [], model: null, effort: null, at: Date.now() });
  };

  /* —— the strip settles in from slightly small when you send; one restored with the thread, or arriving before the composer
     has been up for a moment (a replay), just shows —— */
  const mountedAt = performance.now();

  /* —— a queued card rises into the thread when it lands (design.md, the earned moments) —— */
  const cardEls = new Map<string, HTMLElement>();
  createEffect(
    on(
      () => outbox().map((e) => e.clientID),
      (ids, before) => {
        if (!before) return;
        const gone = before.filter((id) => !ids.includes(id));
        for (const id of gone) {
          const from = cardEls.get(id);
          const landed = (state.threads[key()]?.messages ?? []).find((m) => m.info.clientID === id && m.info.queued !== true);
          // the thread renders a turn per prompt, keyed by the prompt's message id, with the prompt in its bubble
          const to = landed ? document.querySelector<HTMLElement>(`[data-turn="${CSS.escape(landed.info.id)}"] .you`) : null;
          if (from?.isConnected && to) void flyInto(from, to, state.stream.state === "live");
        }
      },
    ),
  );

  /* stops the running turn (the daemon answers once it has stopped): null when it did, else why not, in words */
  const stopTurn = async (): Promise<string | null> => {
    if (props.target.kind !== "session") return "there is no turn here to stop";
    const path = { host: host(), session: props.target.session };
    const who = { device: deviceId(), deviceClass: deviceClass() };
    try {
      const stopped = await api.POST("/api/hosts/{host}/sessions/{session}/abort", { params: { path }, body: { ...who, clientID: crypto.randomUUID() } });
      return stopped.response.ok ? null : `the turn did not stop: ${stopped.error?.error.message ?? stopped.response.status}`;
    } catch {
      return "not sent: the boxbox server is not answering. try again";
    }
  };

  /* run now: stop the turn, then run what is queued. it settles on the echo of the message it ran (cmx2 a21) */
  const runNow = async () => {
    if (props.target.kind !== "session") return;
    const stopped = await stopTurn();
    if (stopped) return setProblem(stopped);
    try {
      const ran = await api.POST("/api/hosts/{host}/sessions/{session}/loop", { params: { path: { host: host(), session: props.target.session } } });
      if (!ran.response.ok) setProblem(`the queue did not start: the daemon answered ${ran.response.status}. try again`);
    } catch {
      setProblem("not sent: the boxbox server is not answering. try again");
    }
  };

  /* run now on a steer. a steer waits for the next tool boundary, which a long command or a wait on agents can put far off, and a
     stop alone does not run it: the pinned daemon takes a waiting steer into the thread at the boundary the stop lands on (driven
     against it, e493302), so the thread holds it, nothing is left for loop to run, and the agent never answers it. so the steer is
     taken back first, the turn stopped, and its words sent as a prompt: the turn that follows is the answer. what waits behind it
     still waits. one that already went is the agent's, and nothing is stopped for it */
  let runningSteer = false;
  const runSteerNow = async (card: Shown) => {
    const target = props.target;
    if (target.kind !== "session" || !card.messageID || runningSteer) return;
    runningSteer = true;
    try {
      const back = await unsendQueued(key(), card.messageID, card.entry?.clientID ?? null);
      if (!back.ok) return setProblem(back.message ?? "it already went");
      const stopped = await stopTurn();
      if (stopped) {
        // the turn is still running: the steer goes back to waiting, so nothing the person wrote is lost
        sendMessage({ clientID: crypto.randomUUID(), verb: "steer", target, text: card.text, photos: [], model: null, effort: null, at: Date.now() });
        return setProblem(`${stopped}. your message is waiting again. try again`);
      }
      sendMessage({ clientID: crypto.randomUUID(), verb: "prompt", target, text: card.text, photos: [], model: null, effort: null, at: Date.now() });
    } finally {
      runningSteer = false;
    }
  };

  const retry = (card: Shown) => card.entry && retrySend(card.entry.clientID);
  /* edit a waiting message: taken back, its words come into the empty draft with the caret in them (offered only while the
     draft is empty, so nothing written is mixed into it) */
  const editWaiting = async (card: Shown) => {
    if (has()) return;
    await unsend(card);
    if (draft().text) caretToEnd();
  };
  const onQueueVerb = (verb: QueueVerb, id: string) => {
    const card = cardOf().get(id);
    if (!card) return;
    if (verb === "retry") retry(card);
    else if (verb === "edit") backToDraft(card);
    else if (verb === "editWaiting") void editWaiting(card);
    else if (verb === "steerNow") void steerNow(card);
    else if (verb === "runNow") void (card.card.state === "steer" ? runSteerNow(card) : runNow());
    else void unsend(card);
  };
  const registerCard = (id: string, el: HTMLElement) => {
    cardEls.set(id, el);
    return () => {
      if (cardEls.get(id) === el) cardEls.delete(id);
    };
  };
  const backToDraft = (card: Shown) => {
    if (!card.entry) return;
    // the photos it held come back with its words, to the draft this composer is writing
    discardSend(card.entry.clientID, true);
    setText(card.text);
  };

  /* the sheet and the bar under an open thread can be on screen together (strip and rail), so their controls are named for what they change */
  const ofThread = () => (props.mount === "sheet" ? " for the new thread" : "");

  /* when a pick takes effect, in the words of the a18 rule */
  const when = () => (props.target.kind === "new" ? "the new thread starts on it" : agent() === "idle" ? "changes from this message on" : "changes from your next message when the agent is done");

  const label = () =>
    props.mount === "sheet" ? `first message for a new thread in ${repo()}` : `message to ${props.title ?? repo()}`;

  return (
    <div class="composer" ref={rootEl} data-mount={props.mount} data-full={full() ? "" : undefined} style={{ ...colourStyle(colour()), ...(room() === null ? {} : { "--room": `${room()}px` }) }}>
      <Show when={props.mount === "bar" ? compaction() : undefined}>
        {(compact) => {
          const words = () => compactionWords(compact(), now());
          return (
            <div class="cz-queue">
              <div class="cz-card cz-compaction" role={compact().state === "failed" ? "alert" : "status"} data-state={compact().state}>
                <div class="cz-card-text">
                  <small><Icon name={compact().state === "failed" ? "alert" : "compact"} />{words().label}</small>
                  <p>{words().text}</p>
                  <span class="cz-why">{words().why}<Show when={words().clock}>{(clock) => <span class="cz-clock" aria-hidden="true"> {clock()}</span>}</Show></span>
                </div>
                <Show when={compact().state === "failed"}>
                  <div class="cz-card-acts">
                    <button class="cz-pill on" type="button" aria-label="retry compacting" onClick={startCompact}>retry</button>
                    <button class="cz-pill" type="button" aria-label="dismiss the compact message" onClick={() => setCompaction(key(), null)}>dismiss</button>
                  </div>
                </Show>
              </div>
            </div>
          );
        }}
      </Show>

      <Show when={props.mount === "bar" && cards().length > 0}>
        <QueueStrip items={cards()} agent={agent()} draftEmpty={!has()} unsending={unsending()} onVerb={onQueueVerb} register={registerCard} live={() => performance.now() - mountedAt > 600 && state.stream.state === "live"} />
      </Show>

      <Show when={menu()}>
        <div class="cz-menu" role={menu() === "model" ? "group" : menu() === "tools" ? "menu" : "listbox"} onKeyDown={onToolsKey} aria-label={menu() === "model" ? `model${ofThread()}` : menu() === "tools" ? "add to the message" : `suggestions${ofThread()}`}>
          <Show when={menu() === "/"}>
            <p class="cz-menu-head">commands in {repo()}</p>
            <For each={commandOptions()} fallback={<p class="cz-note">{menuProblem() ?? (commandList() === null ? "reading the commands." : `no command starts with "${menuQuery(draft().text, "/")}". it will go as a message.`)}</p>}>
              {(choice, index) => (
                <button type="button" class="cz-option" role="option" aria-selected={index() === menuIndex() ? "true" : "false"} data-on={index() === menuIndex() ? "" : undefined} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(index())}>
                  <b>/{choice.name}</b>
                  <span>{choice.description ?? ""}</span>
                  <em class="cz-ctx">
                    <Show when={choice.local ? fill() : null}>{(f) => <><ContextRing fill={f()} />{f().percent}%</>}</Show>
                    {choice.hints.join(" ")}
                  </em>
                </button>
              )}
            </For>
            <Show when={commandOptions().length > 0 && (commandList() === null || menuProblem())}>
              <p class="cz-note">{menuProblem() ?? "reading the commands."}</p>
            </Show>
          </Show>
          <Show when={menu() === "@"}>
            <p class="cz-menu-head">files in {repo()}</p>
            <For each={fileList() ?? []} fallback={<p class="cz-note">{menuProblem() ?? (fileList() === null ? "looking." : "no file matches.")}</p>}>
              {(path, index) => (
                <button type="button" class="cz-option file" role="option" aria-selected={index() === menuIndex() ? "true" : "false"} data-on={index() === menuIndex() ? "" : undefined} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(index())}>
                  <b>{path.split("/").at(-1)}</b>
                  <span>{path.split("/").slice(0, -1).join("/") || "."}</span>
                </button>
              )}
            </For>
          </Show>
          <Show when={menu() === "!"}>
            <p class="cz-note">runs <b>{draft().text.slice(1).trim() || "a command"}</b> on {host()}, in {repo()}, as its own row in the thread. it starts no turn; the agent reads the output on its next one.</p>
          </Show>
          <Show when={menu() === "model"}>
            <ModelMenu
              models={models()}
              list={list()}
              favorites={favorites()}
              inUse={chosenModel()}
              when={when()}
              ofThread={ofThread()}
              fine={matchMedia("(pointer: fine)").matches}
              onPick={(model, fromFilter) => pickModel(model.id, model.efforts, fromFilter)}
              onStar={(id) => void star(id)}
              onRetry={retryModels}
              onEscape={() => {
                setMenu(null);
                editor?.focus({ preventScroll: true });
              }}
            />
          </Show>
          <Show when={menu() === "tools"}>
            <button type="button" class="cz-option tool" role="menuitem" aria-label="add a photo" onPointerDown={(e) => e.preventDefault()} onClick={() => { setMenu(null); picker?.click(); }}>
              <ToolTile icon="photo" />
              <b>photo</b>
              <em>{MAX_PHOTOS} at most</em>
            </button>
            <button type="button" class="cz-option tool" role="menuitem" aria-label="commands" onPointerDown={(e) => e.preventDefault()} onClick={() => { setText(`/${draft().text.replace(/^[/!]/, "")}`); setMenu("/"); }}>
              <ToolTile icon="command" />
              <b>commands</b>
              <em>this directory's</em>
            </button>
            <button type="button" class="cz-option tool" role="menuitem" aria-label="mention a file" onPointerDown={(e) => e.preventDefault()} onClick={() => { const t = `${draft().text}${draft().text && !draft().text.endsWith(" ") ? " " : ""}@`; setText(t); setMenu("@"); readFiles(t); }}>
              <ToolTile icon="file" />
              <b>a file</b>
              <em>the agent reads it</em>
            </button>
            <button type="button" class="cz-option tool" role="menuitem" aria-label="run in the shell" onPointerDown={(e) => e.preventDefault()} onClick={() => { setText(`!${draft().text.replace(/^[/!]/, "")}`); setMenu("!"); }}>
              <ToolTile icon="terminal" />
              <b>shell</b>
              <em>runs on {host()}</em>
            </button>
            <Show when={props.target.kind === "session"}>
              <button
                type="button"
                class="cz-option tool"
                role="menuitem"
                aria-label={`compact the thread${fill() ? `, the context is ${fill()?.percent}% full` : ""}`}
                aria-disabled={compacting() || agent() !== "idle" ? "true" : undefined}
                title={fill()?.words}
                onPointerDown={(e) => e.preventDefault()}
                onClick={startCompact}
              >
                <ToolTile icon="compact" />
                <span class="cz-tool-text">
                  <b>compact</b>
                  <small>summarises the thread so far to free the context</small>
                </span>
                <em class="cz-ctx">
                  <Show when={agent() === "idle" && !compacting() ? fill() : null}>{(f) => <ContextRing fill={f()} />}</Show>
                  {compactMeta(agent(), compacting(), fill())}
                </em>
              </button>
            </Show>
            <Show when={props.agents}>
              {(agents) => (
                <button type="button" class="cz-option tool" role="menuitem" aria-label={`agents, ${agents().count}`} onPointerDown={(e) => e.preventDefault()} onClick={() => { setMenu(null); agents().open(); }}>
                  <ToolTile icon="agents" />
                  <b>agents</b>
                  <em>{agents().count ? `${agents().count} started` : "none yet"}</em>
                </button>
              )}
            </Show>
            <Show when={tall() && !full()}>
              <button type="button" class="cz-option tool" role="menuitem" aria-label="write on the full stage" onPointerDown={(e) => e.preventDefault()} onClick={() => { setMenu(null); setFull(true); }}>
                <ToolTile icon="expand" />
                <b>full stage</b>
                <em>the draft as the page</em>
              </button>
            </Show>
          </Show>
        </div>
      </Show>

      <div class="cz-window" ref={windowEl} data-focus={focused() || menu() ? "" : undefined} data-shell={shell() ? "" : undefined} data-bad={problem() ? "" : undefined} data-drop={dropping() ? "" : undefined}>
        <Show when={full()}>
          <div class="cz-full-head">
            <button class="cz-back" type="button" aria-label="back to the thread" onClick={() => setFull(false)} />
            <b>{props.title ?? repo()}</b>
            <span>{draft().text.length.toLocaleString("en-US")} characters</span>
          </div>
        </Show>
        {/* the top row is always there and always one height: the line says what send will do or what the agent is doing,
            and the model and the effort sit beside it, visible and changeable with the keyboard down. nothing here
            appears on focus, so focusing moves nothing */}
        <div class="cz-top" data-lit={steering() ? "" : undefined} onKeyDown={(e) => e.key === "Escape" && dial() && (e.stopPropagation(), closeDial())}>
          <Show
            when={dial()}
            fallback={
              <>
                <Show when={props.mount === "bar" || line()}>
                <div class="cz-line" ref={lineEl} aria-live="polite">
                  <Show when={line()}>
                    {(l) => (
                      <>
                        <Show when={l().kind}><span class="cz-k">{l().kind}</span></Show>
                        <span class="cz-t" data-prose={l().prose ? "" : undefined} data-live={l().key ? "" : undefined}>
                          {/* the agent's own words are markdown: drawn inline, the marks gone (one element, so the end-anchored line stays one block) */}
                          <Show when={l().prose && l().key} fallback={l().text}>
                            <span>
                              <For each={inlineRuns(l().text)}>{(run) => (run.code ? <code>{run.text}</code> : run.strong ? <b>{run.em ? <em>{run.text}</em> : run.text}</b> : run.em ? <em>{run.text}</em> : run.text)}</For>
                            </span>
                          </Show>
                        </span>
                      </>
                    )}
                  </Show>
                </div>
                </Show>
                <button class="cz-key me cz-chip" type="button" aria-label={`model${ofThread()}: ${modelLabel()}${listWhy()}${waits() && draft().model ? ", waits for your next message" : ""}`} aria-expanded={menu() === "model" ? "true" : "false"} data-pending={waits() && draft().model ? "" : undefined} data-quiet={list() === "ready" ? undefined : ""} onPointerDown={(e) => e.preventDefault()} onClick={() => toggleMenu("model")}>
                  <MarkGlyph provider={chosenProvider()} class="cz-chip-mark" />
                  <span class="cz-chip-label">{modelLabel()}</span>
                </button>
                <Show when={effortChip().show}>
                  <button class="cz-key me cz-chip" type="button" aria-label={`effort${ofThread()}: ${chosenEffort() ?? "the model's own"}${list() === "ready" ? "" : ", the choices are not here"}${waits() && draft().effort ? ", waits for your next message" : ""}`} aria-expanded="false" data-pending={waits() && draft().effort ? "" : undefined} data-quiet={list() === "ready" ? undefined : ""} onPointerDown={(e) => e.preventDefault()} onClick={toggleDial}>
                    <EffortMeter levels={list() === "ready" ? scaleOf(efforts()).levels : []} effort={chosenEffort()} />
                    <em class="cz-chip-label">{effortChip().label}</em>
                  </button>
                </Show>
              </>
            }
          >
            <EffortDial scale={scaleOf(efforts())} ladder={list() === "ready" ? scaleOf(efforts()).levels : []} current={chosenEffort()} name={`effort${ofThread()}`} keyboard={dialByKey()} onPick={pickEffort} onClose={closeDial} />
            <Show when={list() === "failed"}>
              <button class="cz-key me" type="button" aria-label="read the models again" onPointerDown={(e) => e.preventDefault()} onClick={retryModels}>
                <Icon name="retry" />
                retry
              </button>
            </Show>
            <button class="cz-key close" type="button" aria-label={`close effort${ofThread()}`} onPointerDown={(e) => e.preventDefault()} onClick={closeDial}>
              <Icon name="close" />
            </button>
          </Show>
        </div>
        <Show when={dial() && effortChip().note}>{(note) => <p class="cz-dial-note" role="status">{note()}</p>}</Show>
        <Show when={dial() && props.target.kind === "session" && agent() !== "idle"}>
          <p class="cz-dial-note">from your next message, when the agent is done</p>
        </Show>
        <Show when={draft().photos.length > 0}>
          <div class="cz-tray" role="list" aria-label="photos">
            <For each={draft().photos}>
              {(photo, index) => (
                <div class="cz-photo" role="listitem">
                  {/* an original the browser could not draw has nothing to show: a tile that says what it is, in the same box */}
                  <Show when={isOriginal(photo.mime)} fallback={<img src={photo.url} alt={photo.filename} width={60} height={60} />}>
                    <div class="cz-heic" role="img" aria-label={`${photo.filename}, a ${kindOf(photo.mime)} photo of ${megabytes(bytesOfUrl(photo.url))} mb, converted on the host when it is sent`}>
                      <Icon name="photo" />
                      <b aria-hidden="true">{kindOf(photo.mime)}</b>
                    </div>
                  </Show>
                  <button type="button" aria-label={`remove ${photo.filename}`} onClick={() => write({ photos: draft().photos.filter((_, i) => i !== index()) })}>
                    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" /></svg>
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="cz-body" ref={bodyEl} data-stacked={stacked() ? "" : undefined} data-worded={worded() ? "" : undefined} style={{ "--cz-lines": String(lines()) }}>
          <div class="cz-ruler" ref={ruler} aria-hidden="true" />
          {/* one key for everything that is not words, always in the same place: a photo, a command, a file, the shell */}
          <button
            class="cz-key plus"
            ref={plusKey}
            type="button"
            aria-label={props.mount === "sheet" ? "add a photo to the new thread" : "add to the message"}
            aria-expanded={props.mount === "sheet" ? undefined : menu() === "tools" ? "true" : "false"}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(event) => (props.mount === "sheet" ? picker?.click() : toggleMenu("tools", event.detail === 0))}
          >
            <Icon name="plus" />
          </button>
          <textarea
            ref={editor}
            rows={1}
            value={draft().text}
            aria-label={label()}
            placeholder={placeholder(props.mount, agent(), repo(), shell())}
            enterkeyhint="enter"
            spellcheck={true}
            autofocus={props.autofocus}
            onInput={onInput}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(document.activeElement === editor), 120)}
            onPaste={(event) => {
              const photos = event.clipboardData?.files;
              if (photos?.length) {
                event.preventDefault();
                void addPhotos(photos);
              }
            }}
          />
          {/* send never moves: it is here whether the words have focus or not */}
          <SendButton word={word()} worded={worded()} has={has() && !props.blocked} steering={steering()} onSend={() => void send()} onHold={holdStart} onRelease={holdEnd} />
        </div>
        <Show when={problem() || props.blocked || (state.composer.draftsFull && has() ? DRAFTS_FULL : undefined)}>
          {(said) => (
            <p class="cz-problem" role={problem() ? "alert" : undefined} data-quiet={problem() ? undefined : ""}>
              <Icon name="alert" />
              <span>{said()}</span>
              <Show when={problem()}>
                <button type="button" aria-label="dismiss" onClick={() => setProblem(null)}><Icon name="close" /></button>
              </Show>
            </p>
          )}
        </Show>
        <input ref={picker} class="cz-picker" type="file" accept="image/*,.heic,.heif" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => { void addPhotos(event.currentTarget.files); event.currentTarget.value = ""; }} />
      </div>
    </div>
  );
}

/** a tool row's icon, in its quiet tile */
function ToolTile(props: { icon: IconName }) {
  return (
    <span class="cz-tile" aria-hidden="true">
      <Icon name={props.icon} />
    </span>
  );
}

function SendButton(props: { word: string; worded: boolean; has: boolean; steering: boolean; onSend: () => void; onHold: () => void; onRelease: (fire: boolean) => void }) {
  let face: HTMLSpanElement | undefined;
  // the button's box is what is drawn (44 wide as a disc, 96 worded), so a click on its middle, or a tap, is a click on it.
  // the disc opens into its word by clip on the face, never by width (the motion law); on closing the box stays wide until
  // the clip has closed
  const [closing, setClosing] = createSignal(false);
  createEffect(
    on(
      () => props.worded,
      (worded, before) => {
        if (!face || before === undefined || worded === before) return;
        if (worded) {
          setClosing(false);
          play(face, [{ clipPath: "inset(0 0 0 52px round 22px)" }, { clipPath: "inset(0 0 0 0 round 22px)" }], SNAP);
          return;
        }
        setClosing(true);
        const shut = play(face, [{ clipPath: "inset(0 0 0 0 round 22px)" }, { clipPath: "inset(0 0 0 52px round 22px)" }], SNAP, { fill: "forwards" });
        const done = () => {
          setClosing(false);
          shut?.cancel();
        };
        if (shut) void shut.finished.then(done).catch(done);
        else done();
      },
    ),
  );
  return (
    <button
      class="cz-send"
      type="button"
      data-worded={props.worded || closing() ? "" : undefined}
      data-steering={props.steering ? "" : undefined}
      disabled={!props.has}
      aria-label={props.word === "queue" ? "queue, or hold to steer" : props.word}
      onPointerDown={(e) => {
        e.preventDefault();
        props.onHold();
      }}
      onPointerUp={() => props.onRelease(true)}
      onPointerLeave={() => props.onRelease(false)}
      onClick={() => !props.steering && props.onSend()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span class="cz-face" ref={face}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {props.steering ? <path d="M7 19v-5a6 6 0 0 1 6-6h5M14.5 4.5 18 8l-3.5 3.5" /> : <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />}
        </svg>
        <span class="cz-word">{props.word}</span>
      </span>
    </button>
  );
}

function clockOf(at: number | null): string {
  if (!at) return "unknown";
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

