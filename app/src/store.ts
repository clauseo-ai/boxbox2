/* the app's state, in one store. components read paths from it and hold no
   copies; everything that changes it is an action here. the sync worker
   owns the stream and posts patches into this same store (sync/client.ts). */

import { batch, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { components } from "./api/boxbox";
import { api, type HostStatus, type PushKind } from "./api/client";
import { evictions, type RepoIcon } from "./ui/repo-mark/icons";
import type { Link, PtyInfo, Shell, TerminalRef } from "./ui/term/types";
import type { StreamStatus, UiSync } from "./sync/messages";
import type { Draft, OutboxView } from "./sync/outbox";
import { appended, EMPTY_FLEET, type Fleet, isAppend, type Patch, type ThreadView } from "./sync/reducer";
import { type AskReply, keepReply, replyKey, restoreReplies } from "./sync/replies";
import { createThreadCaches } from "./ui/thread/memo-cache";
import { dropped, failed, offered, type Offers, settled, TOAST_MS } from "./ui/home/offers";

/** what a thread's finished parts cost to make, kept between stages (ui/thread/memo-cache.ts). it lives here with the rest of the app's
    state: a thread the worker lets go drops its entries (`applyPatches`), and signing out empties it */
export const threadCaches = createThreadCaches();

export type Gate = "checking" | "signed-out" | "signed-in";

/** the screen behind the gate: home (the windows, and a thread on its stage), the machines, history, or settings. the
    terminal opens over the machines. the shell's navigation is the one writer (app/src/shell/navigation.ts) */
export type Screen = "home" | "machines" | "history" | "settings";

export type Prefs = components["schemas"]["Prefs"];
export type DevicePrefs = components["schemas"]["DevicePrefs"];
export type RepoPrefs = components["schemas"]["RepoPrefs"];
export type ModelPrefs = components["schemas"]["ModelPrefs"];
/** the person's home prefs, one document for every device (settings, home): auto-clear, the working fold, job notices */
export type HomePrefs = components["schemas"]["HomePrefs"];
export type HostModels = components["schemas"]["HostModels"];
export type PushDevice = components["schemas"]["PushDevice"];

/** notifications on this device. `unsupported` covers a browser without
    web push, and safari outside an installed home-screen app. */
export type PushPermission = "unsupported" | "default" | "granted" | "denied";

/** where a push tap asked to go: a thread, and the ask to put in front */
export type Focus = { thread: string; ask: string | null; push: string | null };

/** a board key asked for a thread on this mac (docs/board.md): home opens it as a tap would and puts the caret in its composer,
    so dictation lands there. each carries its own serial, so a second press of the same key is a new request */
export type BoardFocus = { key: string; serial: number };

/** a pairing this window armed (docs/board.md, the app): the board takes the next digit pressed for `key`. `armed` until a
    `board.here` shows the key bound, `paired` once one does, `missed` when no digit came in time, `refused` when the server
    would not arm it (`why` says what to do) */
export type BoardPin =
  /** `was`: the paired key it already had when armed, which a later here showing it again does not settle */
  | { key: string; phase: "armed"; until: number; was: number | null }
  | { key: string; phase: "paired"; digit: number }
  | { key: string; phase: "missed" }
  | { key: string; phase: "refused"; why: string };

/** the board, when one is plugged into this mac (docs/board.md). nothing here moves on a device without one */
export type Board = {
  /** a board is here: its daemon's stream is open and matched this window's mac */
  here: boolean;
  /** the digit each seated thread wears, by key, as the last `board.here` had them; replaced whole by each */
  digits: Record<string, number>;
  /** the keys whose digit is a paired key, not a seat by order */
  bound: Record<string, true>;
  /** a board has been here since the page opened: its chunk is in, and its pieces stay mounted, so a digit leaves by motion */
  met: boolean;
  /** when the board last arrived, ms since the epoch: a key drawn with its arrival arrives, one drawn later paints in place */
  since: number;
  focus: BoardFocus | null;
  /** a machine key asked for a new thread on that machine */
  compose: { machine: string; serial: number } | null;
  pin: BoardPin | null;
  /** the server takes pairings; false once it answered that it has no `[board]`, and the menu stops offering one */
  pairing: boolean;
};

export type State = {
  gate: Gate;
  hosts: HostStatus[];
  /** when the hosts were last read, ms since the epoch */
  hostsAt: number | null;
  /** the last thing that failed, in the interface's voice */
  problem: string | null;
  /** the fleet model as the sync worker holds it */
  fleet: Fleet;
  /** transcripts the worker holds, by `host:session` */
  threads: Record<string, ThreadView>;
  stream: StreamStatus;
  /** the thread on stage, mirrored into the url */
  openThread: string | null;
  /** the server speaks a newer protocol; only a reload continues */
  needsReload: boolean;
  /** the worker's cache is waiting on a tab running an older build, so nothing is read or kept until that tab lets go */
  cacheBlocked: boolean;
  push: {
    permission: PushPermission;
    /** true once the server holds this device's subscription */
    subscribed: boolean;
    /** a turn-on or turn-off is in flight */
    busy: boolean;
    /** what went wrong with notifications, in the interface's voice */
    problem: string | null;
    /** the kinds this device is pushed, as the server holds them */
    kinds: PushKind[];
  };
  /** the deep link a push opened, until the thread ui takes it */
  focus: Focus | null;
  /** threads whose windows are in view, written by the windows and read by
      presence */
  windowsInView: string[];
  terminals: Terminals;
  /** mirrored into the url, like the terminal */
  screen: Screen;
  /** the thread that was on stage when the windows were left for the machines, put back when they come back;
      not mirrored, since the url names the screen that is up */
  behind: string | null;
  /** every preference as the server holds it; null until first read */
  prefs: Prefs | null;
  /** each host's models, as it last listed them */
  models: Record<string, HostModels>;
  /** a host's models that are being read or did not come; absent once they are in `models`. the picker says which */
  modelsRead: Record<string, "loading" | "failed">;
  /** every subscribed device and the kinds it is pushed, as last read */
  pushDevices: PushDevice[];
  /** each repo's favicon as it was last read, by `iconKey`: what every repo mark on screen draws from, so a repo is
      asked about once. bounded: the oldest answers go past `ICON_CAP` */
  repoIcons: Record<string, RepoIcon>;
  /** how many marks on screen hold each repo's icon verdict, by `iconKey`: a held one is never forgotten */
  repoIconHolds: Record<string, number>;
  /** what this device replied to the asks it settled, by `replyKey` (the thread and the tool call), oldest first, at most
      `REPLY_CAP`: what lets a settled row say "you allowed it once, on this iphone at 17:18" (sync/replies.ts). the worker keeps
      them in indexeddb */
  replies: Record<string, AskReply>;
  composer: {
    /** each target's draft, by target key, kept in indexeddb by the worker */
    drafts: Record<string, Draft>;
    /** sends the daemon has not echoed yet, oldest first */
    outbox: OutboxView[];
    /** a new thread's session key by the client id of its first send: what a sheet waiting for its thread reads */
    born: Record<string, string>;
    /** a thread's compaction, by session key: running (the daemon answers once the summary is in, which can take a
        while, so the composer says so even after the stage was left and came back), refused, or just done */
    compacting: Record<string, Compaction>;
    /** the worker could not write drafts to indexeddb several times in a row: the device is out of room, and what a person
        writes is kept only while the page is open. said where they write, and cleared when a write lands */
    draftsFull: boolean;
    /** a line the worker's news for a target's composer says in its own problem line (photos that did not fit a draft they
        were handed back to); the composer takes it and clears it */
    notice: { key: string; text: string } | null;
  };
  board: Board;
  /** a repo colour the picker is showing before the person settles on it: while set, that repo wears it everywhere
      (the stage, the windows behind the sheet). this device's ui alone, never sent; the choice itself goes to the
      server and comes back as a `colour` frame (ui/window/colours.ts) */
  colourPreview: ColourPreview | null;
  /** the clear the undo toast offers back (home/toast.tsx), or null while no toast is up. this device's ui alone */
  undo: Undo | null;
  /** the clears waiting for the toast on screen to end (an auto-clear behind a hand clear's toast; home/undo.ts, `offered`) */
  undoNext: Undo[];
};

/** one repo, by host and root, shown in one of the ten by name */
export type ColourPreview = { host: string; root: string; name: string };

export type Compaction = { state: "running"; since: number } | { state: "failed"; message: string } | { state: "done"; at: number };

export type Terminals = {
  /** each host's open terminals, as it last listed them */
  byHost: Record<string, PtyInfo[]>;
  /** each host's login shells, the host user's own first */
  shells: Record<string, Shell[]>;
  /** the terminal on screen, mirrored into the url */
  open: TerminalRef | null;
  /** its connection to the relay, and since when */
  link: { state: Link; since: number; detail: string | null };
};

const [state, setState] = createStore<State>({
  gate: "checking",
  hosts: [],
  hostsAt: null,
  problem: null,
  fleet: EMPTY_FLEET,
  threads: {},
  stream: { state: "connecting", since: Date.now(), lastEventAt: null },
  openThread: null,
  needsReload: false,
  cacheBlocked: false,
  push: { permission: "unsupported", subscribed: false, busy: false, problem: null, kinds: [] },
  focus: null,
  windowsInView: [],
  terminals: { byHost: {}, shells: {}, open: null, link: { state: "connecting", since: Date.now(), detail: null } },
  screen: "home",
  behind: null,
  prefs: null,
  models: {},
  modelsRead: {},
  pushDevices: [],
  repoIcons: {},
  repoIconHolds: {},
  replies: {},
  composer: { drafts: {}, outbox: [], born: {}, compacting: {}, draftsFull: false, notice: null },
  board: { here: false, digits: {}, bound: {}, met: false, since: 0, focus: null, compose: null, pin: null, pairing: true },
  colourPreview: null,
  undo: null,
  undoNext: [],
});

export { state };

const UNREACHABLE = "the boxbox server is not answering. check it is running, then try again.";

/** reads the hosts; a 401 means the gate is closed. */
export async function refreshHosts(): Promise<void> {
  try {
    const { data, response } = await api.GET("/api/hosts");
    if (response.status === 401) {
      setState({ gate: "signed-out", problem: null });
      return;
    }
    if (!data) {
      setState("problem", `the server answered ${response.status} for the hosts.`);
      return;
    }
    // reconciled by name, so each machine window (and what it holds open) survives the reread
    setState({ gate: "signed-in", hostsAt: Date.now(), problem: null });
    setState("hosts", reconcile(data, { key: "name" }));
  } catch {
    setState("problem", UNREACHABLE);
  }
}

/** true when the password was right */
export async function signIn(password: string): Promise<boolean> {
  try {
    const { response } = await api.POST("/api/login", { body: { password } });
    if (response.ok) {
      await refreshHosts();
      return true;
    }
    setState("problem", response.status === 401 ? "wrong password" : `sign in failed (${response.status}). try again.`);
  } catch {
    setState("problem", UNREACHABLE);
  }
  return false;
}

export async function signOut(): Promise<void> {
  try {
    await api.POST("/api/logout");
  } finally {
    threadCaches.clear();
    setState({ gate: "signed-out", hosts: [], hostsAt: null, problem: null, fleet: EMPTY_FLEET, threads: {}, openThread: null, colourPreview: null, undo: null, undoNext: [] });
    setState("terminals", { byHost: {}, shells: {}, open: null });
    setState({ prefs: null, models: {}, modelsRead: {}, behind: null });
    setState("replies", reconcile({}));
    boardGone();
  }
}

export function clearProblem(): void {
  setState("problem", null);
}

/* —— the sync worker's side (sync/client.ts calls these) —— */

export function bootSync(sync: UiSync): void {
  /* a record kept on this page before the worker booted (an answer in the first moments) outlives what the cache read back */
  let replies = restoreReplies(sync.replies ?? []).book;
  for (const record of Object.values(state.replies)) replies = keepReply(replies, record).book;
  // set whole, in the book's order: a plain object here would be merged into the one the store holds
  setState("replies", produce((book) => {
    for (const key of Object.keys(book)) delete book[key];
    Object.assign(book, replies);
  }));
  setState({ fleet: sync.fleet, threads: sync.threads, stream: sync.stream, composer: { drafts: sync.drafts, outbox: sync.outbox, born: state.composer.born, compacting: state.composer.compacting, draftsFull: state.composer.draftsFull, notice: state.composer.notice } });
}

/** keeps the record of a reply this device made to an ask (sync/client.ts, keepReply, which hands it to the worker too) */
export function setReply(record: AskReply): void {
  const { dropped } = keepReply(state.replies, record);
  const key = replyKey(record.thread, record.callID);
  setState("replies", produce((book) => {
    // deleted first, so a record kept again moves to the end of the book's order, as keepReply has it
    delete book[key];
    book[key] = record;
    for (const old of dropped) delete book[old];
  }));
}

/** the outbox as the worker holds it */
export function setOutbox(outbox: OutboxView[]): void {
  setState("composer", "outbox", reconcile(outbox, { key: "clientID" }));
}

/** a new thread's session, named by the worker; the newest 32 are kept, so the map stays small */
export function setBorn(clientID: string, key: string): void {
  setState(
    "composer",
    "born",
    produce((born) => {
      born[clientID] = key;
      const ids = Object.keys(born);
      for (const id of ids.slice(0, Math.max(0, ids.length - 32))) delete born[id];
    }),
  );
}

/** a target's draft, as typed; the worker keeps it in indexeddb (sync/client.ts saveDraft) */
export function setDraft(key: string, draft: Draft | null): void {
  setState(
    "composer",
    "drafts",
    produce((drafts) => {
      if (draft) drafts[key] = draft;
      else delete drafts[key];
    }),
  );
}

/** applies one frame's patches: each sets a value at a path (undefined deletes it), or adds words to the text there */
/* one beat per applied batch that wrote any fleet thread (or the fleet whole): what a reader that wants "the fleet moved"
   reads, in place of walking every thread to be woken by each (home's streaming label) */
const [sessionsBeat, setSessionsBeat] = createSignal(0);
export { sessionsBeat };

export function applyPatches(patches: readonly Patch[]): void {
  let sessions = false;
  for (const patch of patches) {
    const [top, second] = patch.path;
    // a thread the worker let go (evicted, or the cache reset): what is kept for it goes too. one the ui stopped showing lets go
    // of its turn models and keeps its measured heights, for when it is shown again
    if (top === "threads" && patch.path.length === 2 && !isAppend(patch) && patch.value === undefined) {
      if (patch.closed) threadCaches.dropModels(String(second));
      else threadCaches.dropThread(String(second));
    }
    else if (top === "fleet" && (second === undefined || second === "threads")) sessions = true;
  }
  batch(() => {
    setState(
      produce((draft) => {
        for (const patch of patches) setPath(draft as unknown as Record<string, unknown>, patch);
      }),
    );
    if (sessions) setSessionsBeat((n) => n + 1);
  });
}

type Node = Record<string | number, unknown>;

function setPath(root: Node, patch: Patch): void {
  const path = patch.path;
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string | number; // i stops before the last segment
    let child = node[segment];
    if (child === null || typeof child !== "object") {
      child = typeof path[i + 1] === "number" ? [] : {};
      node[segment] = child;
    }
    node = child as Node;
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  if (isAppend(patch)) node[last] = appended(node[last], patch);
  else if (patch.value === undefined) delete node[last];
  else node[last] = patch.value;
}

export function setStream(stream: StreamStatus): void {
  setState("stream", stream);
}

export function setOpenThread(key: string | null): void {
  setState("openThread", key);
}

export function syncSignedOut(): void {
  threadCaches.clear();
  setState({ gate: "signed-out", fleet: EMPTY_FLEET, threads: {}, openThread: null, colourPreview: null, undo: null, undoNext: [] });
  boardGone();
}

export function syncNeedsReload(): void {
  setState("needsReload", true);
}

/** the worker's cache is waiting for another tab, on an older build, to close or reload */
export function setCacheBlocked(blocked: boolean): void {
  setState("cacheBlocked", blocked);
}

/** notifications on this device changed (app/src/push/notifications.ts). */
export function updatePush(patch: Partial<State["push"]>): void {
  setState("push", patch);
}

/** the threads whose windows are in view, for presence (app/src/ui/home). */
export function setWindowsInView(keys: string[]): void {
  if (keys.length === state.windowsInView.length && keys.every((key, i) => key === state.windowsInView[i])) return;
  setState("windowsInView", keys);
}

/** how long a stage waits for the ask a focus names once it has its thread: the row comes with the thread, and the ask with the
    stream. an ask answered elsewhere before this device got there never comes, and the focus is let go rather than left to send
    the stage somewhere at its next turn (ui/thread/focus-lapse.ts). the wait is the stage's, and starts when it has the thread:
    a cold launch can take longer than this to get the gate, the sign-in and the thread, all before any stage is there to wait */
export const FOCUS_FOR_MS = 4000;

/** a push tap, or a window's "answer", asked to open a thread with an ask in front (app/src/push/links.ts, ui/home). it is
    replaced as a whole: merged into the one before it, its reference never changed and nothing watching it was told. the stage
    that finds the ask clears it (`openFocus(null)`); one that never does lets it go by `releaseFocus` */
export function openFocus(focus: Focus | null): void {
  setState({ focus });
}

/** lets go of `held`, if it is still the focus: a newer one, set while a stage waited on this, is not this one's to clear */
export function releaseFocus(held: Focus | null): void {
  if (held && state.focus === held) setState({ focus: null });
}

/* —— terminals (ui/term calls these) —— */

export function setTerminalList(host: string, list: PtyInfo[]): void {
  setState("terminals", "byHost", host, reconcile(list, { key: "id" }));
}

export function setShells(host: string, shells: Shell[]): void {
  setState("terminals", "shells", host, shells);
}

export function setOpenTerminal(ref: TerminalRef | null): void {
  setState("terminals", "open", ref);
}

export function setTerminalLink(state: Link, detail: string | null = null): void {
  setState("terminals", "link", { state, since: Date.now(), detail });
}

/* —— machines and settings (ui/machines, ui/settings call these) —— */

export function setScreen(screen: Screen): void {
  setState("screen", screen);
}

export function setBehind(key: string | null): void {
  setState("behind", key);
}

export function setPrefs(prefs: Prefs): void {
  setState("prefs", reconcile(prefs));
  keepHome(homePrefs());
}

/** the server's defaults for the home prefs, which hold until the prefs are read */
export const DEFAULT_HOME: HomePrefs = { autoClear: "seen1h", foldWorking: true, jobsAsNeeds: false };
const HOME_KEY = "boxbox.home";

/* a copy of the home prefs rides in localStorage, so a cold launch draws the fold and the job filter as the person chose
   them before the prefs are read (the server's are the truth, as the appearance's copy is: settings/appearance.ts) */
function keptHome(): HomePrefs {
  try {
    const text = typeof localStorage === "undefined" ? null : localStorage.getItem(HOME_KEY);
    return text ? readHome(JSON.parse(text)) : DEFAULT_HOME;
  } catch {
    return DEFAULT_HOME;
  }
}

/** the copy as it was last kept, read field by field: one missing or of the wrong shape (another build wrote it, or someone
    edited it) takes the default, as the server's own read does */
export function readHome(value: unknown): HomePrefs {
  const kept = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const autoClear = kept["autoClear"];
  return {
    autoClear: autoClear === "seen1h" || autoClear === "any3h" || autoClear === "never" ? autoClear : DEFAULT_HOME.autoClear,
    foldWorking: typeof kept["foldWorking"] === "boolean" ? kept["foldWorking"] : DEFAULT_HOME.foldWorking,
    jobsAsNeeds: typeof kept["jobsAsNeeds"] === "boolean" ? kept["jobsAsNeeds"] : DEFAULT_HOME.jobsAsNeeds,
  };
}

function keepHome(value: HomePrefs): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(HOME_KEY, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the next launch reads the server's prefs a moment later, as before */
  }
}

const launchHome = keptHome();

/** the home prefs: the server's once read, this device's copy of them before */
export function homePrefs(): HomePrefs {
  return state.prefs?.home ?? launchHome;
}

/** the home prefs as chosen (settings, optimistic) or as the server saved them */
export function setHomePrefs(value: HomePrefs): void {
  if (!state.prefs) return;
  setState("prefs", "home", reconcile(value));
  keepHome(value);
}

/** the undo toast's one clear: the keys the server cleared, the title of the one thread when there is one, a serial so a
    newer clear replaces the toast and its timer (home/toast.tsx owns the 6 s), whose clear it was, and when its offer runs
    out (performance.now ms; Infinity while the toast holds it), so an offer is gone when home comes back after it */
export type Undo = {
  keys: string[];
  title: string | null;
  serial: number;
  /** a clear by hand on this device, or the server's own (`autoCleared`) */
  cause: "hand" | "auto";
  until: number;
  /** the unclear is out */ busy: boolean;
  /** why it did not come back */ error: string | null;
};
let undoSerial = 0;

const offers = (): Offers => ({ now: state.undo, next: state.undoNext });
function setOffers(next: Offers): void {
  if (next.now === state.undo && next.next === state.undoNext) return;
  batch(() => {
    setState("undo", next.now);
    setState("undoNext", next.next);
  });
}

/** a clear from this device (`hand`), or one the server made while this page was in front (`auto`): the toast offers it back */
export function offerUndo(keys: readonly string[], cause: Undo["cause"] = "hand", now = performance.now()): void {
  if (keys.length === 0) return;
  const only = keys.length === 1 ? state.fleet.threads[keys[0] ?? ""] : undefined;
  const offer: Undo = { keys: [...keys], title: only ? only.title.trim() || "untitled" : null, serial: ++undoSerial, cause, until: now + TOAST_MS, busy: false, error: null };
  setOffers(offered(offers(), offer, now));
}

/** the offer on screen as it stands now: one whose time ran out while home was away is dropped here, and the next one
    waiting takes its place. home reads it as it mounts the toast, ⌘z before it undoes */
export function liveUndo(now = performance.now()): Undo | null {
  setOffers(settled(offers(), now));
  return state.undo;
}

/** the toast is done with this clear (undone, timed out, dismissed); a newer one stays, and one waiting shows */
export function dropUndo(serial: number, now = performance.now()): void {
  setOffers(dropped(offers(), serial, now));
}

/** the toast's undo is out, or back with nothing to say */
export function undoBusy(serial: number, busy: boolean): void {
  if (state.undo?.serial === serial) setState("undo", { busy });
}

/** the toast's undo came back refused or failed (`error` says why): the line shows, even when a newer toast took over */
export function undoFailed(undo: Undo, error: string, now = performance.now()): void {
  setOffers(failed(offers(), undo, error, now));
}

/** when the toast on screen runs out, as its time hears it (`Lifetime`) */
export function undoUntil(serial: number, until: number): void {
  if (state.undo?.serial === serial && state.undo.until !== until) setState("undo", { until });
}

/** the server cleared threads on its own while a device was looking (`autoCleared`): only a page in front offers it back */
export function autoCleared(keys: readonly string[]): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  offerUndo(keys, "auto");
}

export function setDevicePrefs(device: string, value: DevicePrefs): void {
  if (state.prefs) setState("prefs", "devices", device, value);
}

/** a repo's defaults; with neither a model nor an effort the entry goes */
export function setRepoPrefs(value: RepoPrefs): void {
  if (!state.prefs) return;
  const others = state.prefs.repos.filter((r) => r.host !== value.host || r.directory !== value.directory);
  const cleared = value.model == null && value.effort == null;
  setState("prefs", "repos", reconcile(cleared ? others : [...others, value]));
}

/** the models a person keeps at the top of every picker. a server older than the favorites has no `models` in its answer, so
    the entry is made here when the first star lands */
export function setModelPrefs(value: ModelPrefs): void {
  if (!state.prefs) return;
  setState("prefs", "models", reconcile(value));
}

/** whether the worker is keeping drafts: false when its writes have failed several times in a row */
export function setDraftsKept(kept: boolean): void {
  setState("composer", "draftsFull", !kept);
}

/** a line for a target's composer to say; null clears it */
export function setComposerNotice(key: string, text: string | null): void {
  setState("composer", "notice", text === null ? null : { key, text });
}

/** where a thread's compaction stands; null clears it. the newest 16 threads are kept (a running one never leaves), so a
    refusal nobody dismissed does not stay for good */
export function setCompaction(key: string, compaction: Compaction | null): void {
  setState(
    "composer",
    "compacting",
    produce((all) => {
      if (compaction) {
        delete all[key];
        all[key] = compaction;
      } else delete all[key];
      const keys = Object.keys(all);
      for (const old of keys.slice(0, Math.max(0, keys.length - 16))) if (all[old]?.state !== "running") delete all[old];
    }),
  );
}

export function setModels(host: string, models: HostModels): void {
  setState("models", host, models);
  setModelsRead(host, null);
}

/** where a host's model list stands: being read, did not come, or (null) in the store */
export function setModelsRead(host: string, read: "loading" | "failed" | null): void {
  setState(
    "modelsRead",
    produce((reads) => {
      if (read) reads[host] = read;
      else delete reads[host];
    }),
  );
}

/** what came of reading a repo's favicon; the oldest answers beyond the cap are forgotten with it */
export function setRepoIcon(key: string, icon: RepoIcon): void {
  setState(
    "repoIcons",
    produce((icons) => {
      icons[key] = icon;
      for (const old of evictions(icons, state.repoIconHolds)) delete icons[old];
    }),
  );
}

/** a mark on screen holds its repo's icon verdict; the returned release is called when the mark goes */
export function holdRepoIcon(key: string): () => void {
  setState("repoIconHolds", key, (n) => (n ?? 0) + 1);
  return () =>
    setState(
      "repoIconHolds",
      produce((holds) => {
        const left = (holds[key] ?? 1) - 1;
        if (left > 0) holds[key] = left;
        else delete holds[key];
      }),
    );
}

/* —— the board (sync/client.ts hands its frames here; docs/board.md) —— */

/** a `board.here`: the board is on this mac and shows these digits. each replaces the last whole; a seat the wire could not
    mean (a digit outside 1 to 9, a key seated twice) is left out rather than drawn wrong */
export function boardHere(seats: readonly { key: string; digit: number; bound?: boolean }[]): void {
  const digits: Record<string, number> = {};
  const bound: Record<string, true> = {};
  const taken = new Set<number>();
  for (const seat of seats) {
    if (!Number.isInteger(seat.digit) || seat.digit < 1 || seat.digit > 9 || taken.has(seat.digit) || digits[seat.key] !== undefined) continue;
    taken.add(seat.digit);
    digits[seat.key] = seat.digit;
    if (seat.bound) bound[seat.key] = true;
  }
  // a pin settles on its thread's seat turning paired, or a paired seat moving to another digit (`Seat.bound`), never on an
  // unpaired seat by order nor on the paired key it already had
  const pin = state.board.pin;
  const digit = pin?.phase === "armed" ? digits[pin.key] : undefined;
  const paired = pin?.phase === "armed" && digit !== undefined && bound[pin.key] !== undefined && (pin.was === null || digit !== pin.was) ? digit : undefined;
  batch(() => {
    if (!state.board.here) setState("board", "since", Date.now());
    setState("board", { here: true, met: true });
    setState("board", "digits", reconcile(digits));
    setState("board", "bound", reconcile(bound));
    if (pin && paired !== undefined) setBoardPin({ key: pin.key, phase: "paired", digit: paired });
  });
}

/** the board left this mac, or the stream that carried it ended: every digit goes, and a pairing waiting on it with them */
export function boardGone(): void {
  batch(() => {
    setState("board", "here", false);
    boardFocus(null);
    boardCompose(null);
    setState("board", "digits", reconcile({}));
    setState("board", "bound", reconcile({}));
    if (state.board.pin?.phase === "armed") setBoardPin(null);
  });
}

/* a store merges a new object into the one it replaces, so a request carries its own serial (a second press of one key is a
   new request to whatever watches it) and a pin is reconciled (it keeps no field of the phase before it) */
let requests = 0;

export function boardFocus(key: string | null): void {
  setState("board", "focus", key === null ? null : { key, serial: ++requests });
}

export function boardCompose(machine: string | null): void {
  setState("board", "compose", machine === null ? null : { machine, serial: ++requests });
}

export function setBoardPin(pin: BoardPin | null): void {
  setState("board", "pin", pin === null ? null : reconcile(pin));
}

export function setBoardPairing(pairing: boolean): void {
  setState("board", "pairing", pairing);
}

/** the picker's preview of a repo colour, or null when it closes or the choice is made */
export function setColourPreview(preview: ColourPreview | null): void {
  setState("colourPreview", preview);
}

export function setPushDevices(devices: PushDevice[]): void {
  setState("pushDevices", reconcile(devices, { key: "device" }));
}
