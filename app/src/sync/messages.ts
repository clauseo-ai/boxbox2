/* what the ui thread and the sync worker say to each other. the worker
   owns the stream, the cursor, the reducer and indexeddb; the ui sends
   intents and receives patches, once a frame. */

import type { DeviceClass, EventEnvelope, EventKind, PropsOf } from "../../../telemetry/schema";
import type { Draft, DraftMessage, OutboxView, Photo, Target, Verb } from "./outbox";
import type { BoardFrame } from "./protocol";
import type { Counters, Fleet, Patch, ThreadView } from "./reducer";
import type { AskReply } from "./replies";

/** one telemetry event as the ui hands it to the worker, which owns the only emitter: the kind and its props agree */
export type Emit = { [K in EventKind]: { kind: K; props: PropsOf<K>; envelope: EventEnvelope } }[EventKind];

export type StreamState = "connecting" | "live" | "down";

export type StreamStatus = {
  state: StreamState;
  /** when `state` last changed, ms since the epoch */
  since: number;
  /** when the last journal entry was applied, for "offline, last update 23:41" */
  lastEventAt: number | null;
};

/** everything the ui renders from the worker, sent whole once at boot */
export type UiSync = {
  fleet: Fleet;
  threads: Record<string, ThreadView>;
  stream: StreamStatus;
  /** the composer's drafts by target key, as indexeddb held them */
  drafts: Record<string, Draft>;
  /** sends the daemon has not echoed yet */
  outbox: OutboxView[];
  /** this device's replies to asks, as indexeddb held them, oldest first (replies.ts); the worker always sends them, a story's
      boot (which has no worker) may not */
  replies?: AskReply[];
};

/** a send as the composer hands it to the worker */
export type Outgoing = { clientID: string; verb: Verb; target: Target; text: string; photos: Photo[]; model: string | null; effort: string | null; at: number };

/** the reducer's counters and the stream's, for the verification driver */
export type SyncCounters = Counters & {
  cursor: string | null;
  epoch: string | null;
  /** connections opened, the first included */
  connects: number;
  /** reconnects the server replayed from the cursor, with no reset */
  resumes: number;
  /** journal entries replayed from a cursor before the stream was live */
  replayed: number;
  /** the longest the stream was down between two live connections, ms */
  maxDownMs: number;
};

export type Query = { query: "counters" } | { query: "transcript"; key: string };

export type ToWorker =
  /** `open` is the thread the url names, whose pages boot reads for the first frame */
  /** `board`: a desktop-class device, whose stream asks for board frames (docs/board.md) */
  | { type: "start"; device: string; deviceClass: DeviceClass; open: string | null; board: boolean; hidden: boolean }
  /** the page was hidden or shown: hidden, the worker holds what it would post (gate.ts) and posts it, in order, when shown */
  | { type: "visibility"; hidden: boolean }
  /** the person opens a thread: it is cached up to the caps, evicted last, and its recency is the person's */
  | { type: "open"; key: string }
  /** keep a thread current for another one on stage (a child under its parent). it leases one of 16 places of its own,
      beside the person's 40, for as long as it is held and not released: with all 16 leased the hold is refused and
      reads nothing. it never refreshes the recency of a thread the person opened, and goes first when the bytes pass the cap */
  | { type: "hold"; key: string }
  /** a held thread is not needed now: its place is free at once, and the thread stays cached, first to be evicted. an
      opened thread is not changed by it */
  | { type: "release"; key: string }
  /** the ui shows a thread (the stage, a layer under it, a child it holds) and its store takes the thread's patches; `hide`:
      it no longer does, its store lets the thread go, and the worker cools it in time */
  | { type: "show"; key: string }
  | { type: "hide"; key: string }
  /** a stage with nothing to show asks for its thread again now (its retry): a read that waits on its backoff starts over */
  | { type: "reread"; key: string }
  /** write the cache and the telemetry queue now: the page is being hidden */
  | { type: "flush" }
  /** the same, and close the stream's socket now: the page is leaving (`pagehide`), to be unloaded or frozen */
  | { type: "pause" }
  /** the page came back from the back/forward cache: dial again at once */
  | { type: "resume" }
  /** stop, and forget everything cached: the person signed out */
  | { type: "sign-out"; id: number }
  | ({ type: "ask"; id: number } & Query)
  /** a telemetry event from the ui, queued and flushed with the worker's own */
  | ({ type: "telemetry" } & Emit)
  /** keep a target's draft on every keystroke, or forget it (null); a keystroke's carries its photos as "kept" (outbox.ts, DraftMessage) */
  | { type: "draft"; key: string; draft: DraftMessage | null; abandoned: boolean }
  | { type: "send"; outgoing: Outgoing }
  /** post a failed send again, with its own client id */
  | { type: "retry"; clientID: string }
  /** forget a failed send (its text went back to the draft) */
  | { type: "discard"; clientID: string; photosToDraft: boolean }
  /** take back a queued message by its provisional id; `clientID` names this device's own send when it is one. `toDraft`
      says the person means to write it again: its words and photos come back to the draft (`returned`). a steer or a run
      now that sends the words itself does not ask for that */
  | { type: "unsend"; key: string; messageID: string; clientID: string | null; toDraft: boolean }
  /** keep the record of a reply this device made to an ask, once the daemon settled it (replies.ts): the ui's store has it already */
  | { type: "replied"; record: AskReply }
  /** a draft's composer opened and the draft's photos are on the device, not read (`Draft.held`): read them */
  | { type: "photos"; key: string };

/** what the ui lands in its store in order, at its frame (landing.ts) */
export type Landed = { type: "patches"; patches: Patch[] } | { type: "stream"; stream: StreamStatus };

export type FromWorker =
  | { type: "boot"; sync: UiSync }
  | Landed
  /** what the worker held while the page was hidden, in the order it was sent, landed in one go (gate.ts) */
  | { type: "held"; messages: Landed[] }
  | { type: "signed-out" }
  /** the server speaks another protocol: only a reload can continue */
  | { type: "reload" }
  /** the cache's upgrade is waiting on another tab running an older build (`blocked`), or is through */
  | { type: "cache"; blocked: boolean }
  | { type: "reply"; id: number; value: unknown }
  /** telemetry rows the server took, by id, so the ui can drop its copies of the ones it emitted */
  | { type: "flushed"; ids: string[] }
  | { type: "outbox"; outbox: OutboxView[] }
  /** a new thread's first send has its own session: from the server's answer, or from its echo. said once, because the
      outbox drops the entry when the echo lands, often before the ui has drawn the thread */
  | { type: "born"; clientID: string; key: string }
  /** what came of an unsend: taken back, or why not. `returned` says the message's words and photos came back to the draft
      by a `returned` of their own, sent just before this, so the ui does not put the words back a second time */
  | { type: "unsent"; key: string; messageID: string; ok: boolean; message: string | null; returned: boolean }
  /** a message the person took back (an unsend, an edit of a failed send) or one the outbox could not keep its photos with
      goes back to that target's draft: the ui holds the draft, and the outbox entry that held them is gone or has none.
      `text` is its words when they are to come back too (an unsend; the words go to a draft that held nothing, in the same
      step as the photos), null when the ui puts them back itself */
  | { type: "returned"; key: string; photos: Photo[]; text: string | null }
  /** the worker's writes of drafts to indexeddb have failed several times in a row (`kept: false`: the device is out of
      room), or are working again */
  | { type: "drafts"; kept: boolean }
  /** a board frame, as the stream had it; and a `board.gone` of the worker's own when a connection that carried one ends, since
      the next may come from a mac the board has left, or never come */
  | { type: "board"; frame: BoardFrame }
  /** a draft's photos, read for its composer; null when the read failed and the draft still holds them unread */
  | { type: "photos"; key: string; photos: Photo[] | null };
