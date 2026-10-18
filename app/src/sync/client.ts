/* the ui thread's side of the sync worker: starts it, hands its patches
   to the store once a frame, tells it which thread is on stage, and asks
   it to write its cache when the page is hidden or unloaded.

   `window.boxbox` is the verification driver's handle (docs/verification.md,
   the exactly-once suite). it reads only what the ui already has: the
   worker's held transcript and counters, and the text in the dom. */

import { unwrap } from "solid-js/store";
import type { DeviceClass, EventEnvelope, EventKind, PropsOf } from "../../../telemetry/schema";
import { boardCapable, deviceClass, deviceId } from "../push/device";
import { applyPatches, boardCompose, boardFocus, boardGone, boardHere, bootSync, setCacheBlocked, setComposerNotice, setDraft, setDraftsKept, setBorn, setOpenThread, setOutbox, setReply, setStream, state, syncNeedsReload, syncSignedOut } from "../store";
import type { Emit, FromWorker, Outgoing, Query, StreamStatus, SyncCounters, ToWorker } from "./messages";
import type { BoardFrame } from "./protocol";
import { type Draft, type DraftMessage, type Photo, photosNotFitted, takeBackDraft } from "./outbox";
import { coalesce, type Patch } from "./reducer";
import type { AskReply } from "./replies";
import { mintId } from "./telemetry";

const THREAD_PARAM = "thread";

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (value: unknown) => void>();
/** unsends waiting for the worker's word, by `key messageID` */
type Unsent = { ok: boolean; message: string | null; returned: boolean };
const unsending = new Map<string, (result: Unsent) => void>();
let queued: Patch[] = [];
let frame: number | undefined;
let sampled = 0;
/* the rows this thread emitted and the worker has not yet reported sent: on the way out they go by beacon, since a
   navigation can end the worker before its flush. the server keys rows by id, so a row both sent is counted once */
const device: { id: string; deviceClass: DeviceClass } = { id: "", deviceClass: "desktop" };
const unsent = new Map<string, Record<string, unknown>>();

function send(message: ToWorker) {
  worker?.postMessage(message);
}

function onMessage(event: MessageEvent<FromWorker>) {
  const message = event.data;
  switch (message.type) {
    case "boot":
      bootSync(message.sync);
      return;
    case "patches":
      // a hidden page runs no animation frames, so waiting for one would queue every patch of a long
      // absence; nothing paints while hidden, so apply at once, and otherwise on the ui's own frame,
      // so two messages paint once.
      // the queue is coalesced as it grows, bounded by the paths it touches, not by the time away
      if (document.visibilityState === "hidden") {
        applyPatches(coalesce([...queued, ...message.patches]));
        queued = [];
        return;
      }
      queued = coalesce([...queued, ...message.patches]);
      // one patch in twenty-five for the open thread is timed from its arrival here to the frame after it painted:
      // the worker-to-glyph part of the stream budget (perf.thread, event)
      const open = state.openThread;
      const timed = open !== null && frame === undefined && ++sampled % 25 === 0 && message.patches.some((p) => p.path[0] === "threads" && p.path[1] === open) ? { at: performance.now(), key: open } : null;
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        const patches = queued;
        queued = [];
        applyPatches(patches);
        if (timed) requestAnimationFrame(() => { const ms = performance.now() - timed.at; emit("perf.thread", { what: "event" }, { ms: Math.round(ms), ok: ms <= 150, surface: "thread", session: timed.key }); });
      });
      return;
    case "stream":
      setStream(message.stream);
      return;
    case "signed-out":
      stopSync();
      syncSignedOut();
      return;
    case "reload":
      syncNeedsReload();
      return;
    case "cache":
      setCacheBlocked(message.blocked);
      return;
    case "reply":
      waiting.get(message.id)?.(message.value);
      waiting.delete(message.id);
      return;
    case "flushed":
      for (const id of message.ids) unsent.delete(id);
      return;
    case "outbox":
      setOutbox(message.outbox);
      return;
    case "born":
      setBorn(message.clientID, message.key);
      return;
    case "returned":
      takeBack(message.key, message.photos, message.text);
      return;
    case "drafts":
      setDraftsKept(message.kept);
      return;
    case "board":
      onBoard(message.frame);
      return;
    case "unsent": {
      const id = `${message.key} ${message.messageID}`;
      unsending.get(id)?.({ ok: message.ok, message: message.message, returned: message.returned });
      unsending.delete(id);
      return;
    }
    default:
      message satisfies never;
  }
}

/** a board frame (docs/board.md, the app). a focus or a compose is for the window the person is looking at: a hidden one
    (another tab, a minimised window) lets it pass, so it never opens a thread or a sheet nobody sees */
function onBoard(frame: BoardFrame) {
  switch (frame.type) {
    case "board.here":
      boardHere(frame.seats);
      return;
    case "board.gone":
      boardGone();
      return;
    case "board.focus":
      if (document.visibilityState === "visible") boardFocus(frame.key);
      return;
    case "board.compose":
      if (document.visibilityState === "visible") boardCompose(frame.machine);
      return;
    default:
      frame satisfies never;
  }
}

/** the page is going away or out of sight: the worker flushes, and what it may not get to goes by beacon */
function leaving(how: "flush" | "pause") {
  send({ type: how });
  if (!unsent.size || typeof navigator.sendBeacon !== "function") return;
  const events = [...unsent.values()];
  unsent.clear();
  navigator.sendBeacon("/api/telemetry", new Blob([JSON.stringify({ device: device.id, deviceClass: device.deviceClass, events })], { type: "text/plain" }));
}

function onVisibility() {
  if (document.visibilityState === "hidden") leaving("flush");
}

/* a leaving page closes its stream itself: the browser kept a departed page's socket open for a minute, and with six
   per host the next page's hydration waited behind them (docs/gotchas.md). a page the browser brings back dials again */
function onPageHide() {
  leaving("pause");
}

function onPageShow(event: PageTransitionEvent) {
  if (event.persisted) send({ type: "resume" });
}

/** starts the worker once; it paints the cache, then resumes the stream */
export function startSync(): void {
  if (worker) return;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "boxbox sync" });
  worker.addEventListener("message", onMessage);
  device.id = deviceId();
  device.deviceClass = deviceClass();
  const key = new URLSearchParams(location.search).get(THREAD_PARAM);
  send({ type: "start", device: device.id, deviceClass: device.deviceClass, open: key, board: boardCapable() });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  if (key) openThread(key, placeInUrl());
}

function detach() {
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("pageshow", onPageShow);
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  queued = [];
  for (const resolve of waiting.values()) resolve(null);
  waiting.clear();
  for (const resolve of unsending.values()) resolve({ ok: false, message: "not connected", returned: false });
  unsending.clear();
}

/** stops the worker without touching its cache (the stream said the session ended) */
export function stopSync(): void {
  worker?.terminate();
  worker = null;
  detach();
}

/** stops the worker and has it forget everything it cached first: the person signed out */
export async function forgetSync(): Promise<void> {
  if (!worker) return;
  const id = nextId++;
  const forgotten = new Promise((resolve) => waiting.set(id, resolve));
  send({ type: "sign-out", id });
  await Promise.race([forgotten, new Promise((resolve) => setTimeout(resolve, 2000))]);
  stopSync();
}

const AT_PARAM = "at";
const PART_PARAM = "part";

/** where a link points inside a thread: the turn at the top of the view, and a row to open and light */
export type ThreadPlace = { at: string | null; part: string | null };

export function openThread(key: string, place: Partial<ThreadPlace> = {}): void {
  send({ type: "open", key });
  setOpenThread(key);
  const url = new URL(location.href);
  url.searchParams.set(THREAD_PARAM, key);
  for (const [name, value] of [[AT_PARAM, place.at], [PART_PARAM, place.part]] as const) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  history.replaceState(history.state, "", url);
}

/** asks the worker to hold a thread (read it and keep it current) without putting it on stage: an agent's child session, for
    the tape's lanes. a hold is not an open: it leases one of 16 places of its own beside the person's 40, for as long as it
    is held and not released (so a release must follow, or the place stays leased until the page is reloaded). with all 16
    leased the hold is refused, reads nothing and costs nothing, and asking again is cheap. it never touches an opened
    thread's recency, and a held thread is the first to go when the bytes pass the cap (docs/architecture.md, indexeddb
    layout). a thread the person opens later is promoted, with what the hold read */
export function holdThread(key: string): void {
  send({ type: "hold", key });
}

/** says a held thread is not needed now (its parent left the stage, or it is off screen): its place is free at once for another
    hold, and the thread stays cached, first in line to be evicted. nothing else changes */
export function releaseThread(key: string): void {
  send({ type: "release", key });
}

/** a stage's retry, when it has had nothing to show for a while: the thread is read again now, without the wait the last
    failed read was sitting out, or opened again if the worker let go of it. a thread that is read already is left alone */
export function rereadThread(key: string): void {
  send({ type: "reread", key });
}

/** the place the url names inside the open thread */
export function placeInUrl(): ThreadPlace {
  const params = new URLSearchParams(location.search);
  return { at: params.get(AT_PARAM), part: params.get(PART_PARAM) };
}

/** keeps the url current with the turn at the top of the view (design.md: replaceState only, never a history entry) */
export function markPlace(place: ThreadPlace): void {
  const url = new URL(location.href);
  if (!url.searchParams.has(THREAD_PARAM)) return;
  for (const [name, value] of [[AT_PARAM, place.at], [PART_PARAM, place.part]] as const) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

export function closeThread(): void {
  setOpenThread(null);
  const url = new URL(location.href);
  url.searchParams.delete(THREAD_PARAM);
  url.searchParams.delete(AT_PARAM);
  url.searchParams.delete(PART_PARAM);
  history.replaceState(history.state, "", url);
}

/** what the worker hands back (an unsend, an edit of a failed send, photos the outbox would not take) joins the draft of the
    target it came from in one step: its photos after any the draft already holds, and its words, when it brings them, into a
    draft that held nothing. the ones that do not fit are said, in the composer's own line */
function takeBack(key: string, photos: Photo[], text: string | null): void {
  const back = takeBackDraft(state.composer.drafts[key], { photos, text }, Date.now());
  const d = back.draft;
  // nothing came back and nothing was held: there is no draft to keep, as when the composer empties one
  saveDraft(key, d.text || d.photos.length || d.model || d.effort ? d : null, false, back.kept ? "kept" : "changed");
  if (back.lost) setComposerNotice(key, photosNotFitted(back.lost));
}

/** this browser's id and class, as the verbs on asks and turns carry them (server/src/http/asks.rs) */
export function deviceIdentity(): { device: string; deviceClass: DeviceClass } {
  return { device: device.id, deviceClass: device.deviceClass };
}

/** a telemetry event measured on the ui thread, handed to the worker's queue (the only emitter) */
export function emit<K extends EventKind>(kind: K, props: PropsOf<K>, envelope: EventEnvelope = {}): void {
  const at = envelope.at ?? Date.now();
  const stamped: EventEnvelope = { ...envelope, at, id: envelope.id ?? mintId(at) };
  // in dev, every row shows in the console as it leaves the ui, so a missing row is found on the ui side or the worker's
  if (import.meta.env.DEV) console.debug("telemetry", kind, props, stamped);
  unsent.set(stamped.id as string, { ...stamped, kind, props });
  // the kind and its props agree by the signature; the pair type (`Emit`) is what crosses the boundary
  send({ type: "telemetry", kind, props, envelope: stamped } as ToWorker & Emit);
}

/* —— the composer: drafts and sends go through the worker, which owns indexeddb and the outbox —— */

/** keeps a target's draft; `abandoned` says the person emptied what they had written, not a send. an edit that leaves the
    photos as they were says `photos: "kept"`, and only its words cross to the worker (and reach indexeddb): the photos can
    be 24 mb, and a key is not the time to copy them */
export function saveDraft(key: string, draft: Draft | null, abandoned = false, photos: "kept" | "changed" = "changed"): void {
  setDraft(key, draft);
  // a draft is built from the store's own, whose arrays are proxies; a worker message must be plain data
  const plain = draft ? unwrap(draft) : null;
  const carried: DraftMessage | null = plain ? structuredClone({ ...plain, photos: photos === "kept" ? ("kept" as const) : plain.photos }) : null;
  send({ type: "draft", key, draft: carried, abandoned });
}

/** keeps the record of a reply this device made to an ask, once the daemon settled it: the store has it at once, so the row says
    who and when as it settles, and the worker writes it to indexeddb, so it still does after a reload (sync/replies.ts) */
export function keepReply(record: AskReply): void {
  setReply(record);
  send({ type: "replied", record: structuredClone(record) });
}

/** hands a send to the worker's outbox; it is honest from here: faded until the daemon echoes its client id */
export function sendMessage(outgoing: Outgoing): void {
  send({ type: "send", outgoing: structuredClone(unwrap(outgoing)) });
}

export function retrySend(clientID: string): void {
  send({ type: "retry", clientID });
}

/** forgets a failed send; `photosToDraft` hands the photos it held back to the draft the person is editing */
export function discardSend(clientID: string, photosToDraft = false): void {
  send({ type: "discard", clientID, photosToDraft });
}

/** takes back a queued message; resolves when the daemon has, or says why not. `toDraft` asks for its words and photos to come
    back to the draft (this device's own message; `returned` says they did, so the caller does not put the words back too) */
export function unsendQueued(key: string, messageID: string, clientID: string | null, toDraft = false): Promise<Unsent> {
  if (!worker) return Promise.resolve({ ok: false, message: "not connected", returned: false });
  const answer = new Promise<Unsent>((resolve) => unsending.set(`${key} ${messageID}`, resolve));
  send({ type: "unsend", key, messageID, clientID, toDraft });
  return answer;
}

function ask(query: Query): Promise<unknown> {
  if (!worker) return Promise.resolve(null);
  const id = nextId++;
  const answer = new Promise<unknown>((resolve) => waiting.set(id, resolve));
  send({ type: "ask", id, ...query });
  return answer;
}

/** the utf-16 length of the text parts painted for the open thread, read from the dom nodes */
function painted(): number {
  let length = 0;
  for (const node of document.querySelectorAll('[aria-label="transcript"] [data-part-text]')) length += node.textContent?.length ?? 0;
  return length;
}

export type BoxboxHandle = {
  /** JSON.stringify of the thread's messages exactly as the worker holds them; "null" when it holds none */
  transcript(key: string): Promise<string>;
  counters(): Promise<SyncCounters | null>;
  open(key: string): void;
  painted(): number;
  stream(): Pick<StreamStatus, "state" | "since">;
  /** the asks the store holds as pending, by `host:id` */
  asks(): string[];
  /** the threads the ui's store holds, with their status and message count: what the worker sent, as applied */
  threads(): Array<{ key: string; status: string; messages: number }>;
};

declare global {
  interface Window {
    boxbox: BoxboxHandle;
  }
}

window.boxbox = {
  transcript: async (key) => String(await ask({ query: "transcript", key })),
  counters: async () => (await ask({ query: "counters" })) as SyncCounters | null,
  open: openThread,
  painted,
  stream: () => ({ state: state.stream.state, since: state.stream.since }),
  asks: () => Object.keys(state.fleet.asks),
  threads: () => Object.values(state.threads).map((t) => ({ key: t.key, status: t.status, messages: t.messages.length })),
};
