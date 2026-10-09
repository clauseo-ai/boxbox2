/* seat derivation for the board — the app's triage order, in shareable code.

   the web client derives need/state inline inside `rebuild()`
   (`lib/store/fleet.tsx:2394-2462`), a 4000-line react module the board
   daemon (a plain bun process) cannot import. this file is that precedence
   chain as a pure function, so the hardware ranks EXACTLY what the lanes
   rank. it imports `needRank` from `model.ts` rather than keeping a second
   copy of the table — the table is the one thing that must never fork.

   nothing here may import react, next/server or node:fs. the daemon
   imports it directly. */

import type { NeedKind, SessionState } from "../store/model";
import { needRank } from "../store/model";
import type { CheckoutSnapshot, PendingItem } from "../fleet/watcher";
import type { SessionStatusMap } from "../fleet/types";
import { readAtFor, type ReadState } from "../read/contract";

/** the throttle, pinned to `lib/store/selectors.ts:33` (design v2): a need
    escalates word → chip at ten minutes waiting; fault is born hot. the
    led law's rest-to-hot rule is this same number. */
export const CHIP_THRESHOLD_MS = 10 * 60_000;

/** a session as the daemon knows it: the wire row plus the one fact that
    lives outside it — the fault, which arrives as a `session.error` frame
    and is held in a map keyed by exactly this session. */
export type SeatSession = {
  /** composite key `${host}:${sessionID}` — the same identity the app's
      store uses, and the key `read` is indexed by */
  key: string;
  host: string;
  sessionID: string;
  title?: string;
  /** the server's working directory, verbatim (macos /private and all) */
  directory?: string;
  /** set when another session spawned this one */
  parentID?: string;
  /** `time.updated ?? time.created`, ms epoch */
  updatedAt: number;
  /** a `session.error` frame landed for this session */
  fault?: { at: number };
};

/** host id → the host's live checkouts (`HostSnapshot.checkouts`) */
export type SeatCheckouts = Record<string, CheckoutSnapshot[]>;

/** host id → `GET /session/status` map. presence means busy, exactly as
    the store reads it. */
export type SeatStatus = Record<string, SessionStatusMap>;

export type Seat = {
  key: string;
  host: string;
  sessionID: string;
  title?: string;
  directory?: string;
  state: SessionState;
  need: NeedKind;
  /** when this need started wanting him. absent only when a pending item
      carried an unparseable arrival stamp — the app has the same hole. */
  needSinceMs?: number;
  updatedAt: number;
  /** earned the chip: fault always, any other need after ten minutes */
  hot: boolean;
  /** a subagent's session. it still earns a seat — attention inversion
      does not care who spawned the agent that is blocked. */
  child: boolean;
};

/** path forms normalize the way the store's checkout join does */
function normDir(directory: string): string {
  return directory.replace(/^\/private(?=\/)/, "");
}

/** pending items carry ISO arrival stamps; a bad parse means unknown */
function parseWhen(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** how long this seat has been waiting — the app's own fallback chain */
function waitingSince(seat: Seat): number {
  return seat.needSinceMs ?? seat.updatedAt;
}

/**
 * every session that wants him, in the app's triage order: `needRank`
 * first, oldest-waiting second.
 *
 * the precedence chain is `fleet.tsx:2430-2462` verbatim — permission,
 * question, fault (session error OR a failed checkout), declared review,
 * unread — and the two suppressions that ride with it: a busy session is
 * never unread, and a child never nags as unread (its words flow to its
 * parent). real blockers on a child still speak.
 *
 * read forgives a session fault (2026-07-27): a fault born before the
 * session's read stamp has been seen and acknowledged — the + copy verb,
 * opening the thread, any device's mark. before this rule a crashed
 * subagent's fault was undismissable: its only exits were "moves again"
 * or "deleted", and a dead child does neither. checkout wreckage is NOT
 * read-forgivable — a failed checkout stays a fault lane until the work
 * is rescued or discarded, because the broken thing is still on disk.
 */
export function deriveSeats(
  sessions: SeatSession[],
  pending: PendingItem[],
  status: SeatStatus,
  read: ReadState,
  checkouts: SeatCheckouts,
  now: number,
): Seat[] {
  const pendingBySession = new Map<string, PendingItem[]>();
  for (const item of pending) {
    const k = `${item.host}:${item.sessionID}`;
    pendingBySession.set(k, [...(pendingBySession.get(k) ?? []), item]);
  }

  const checkoutByDir = new Map<string, CheckoutSnapshot>();
  for (const [host, list] of Object.entries(checkouts)) {
    for (const checkout of list) {
      checkoutByDir.set(`${host}\u0000${normDir(checkout.directory)}`, checkout);
    }
  }

  const seats: Seat[] = [];
  for (const session of sessions) {
    const checkout = session.directory
      ? checkoutByDir.get(`${session.host}\u0000${normDir(session.directory)}`)
      : undefined;
    const pendingHere = pendingBySession.get(session.key) ?? [];
    const busy = status[session.host]?.[session.sessionID] !== undefined;
    const child = session.parentID !== undefined && session.parentID !== null;
    const readAt = readAtFor(read, session.key);
    const unread = session.updatedAt > readAt && !busy;
    /* read forgives: a fault he has read past is acknowledged */
    const fault = session.fault !== undefined && session.fault.at > readAt;

    let state: SessionState = busy ? "working" : "idle";
    let need: NeedKind | undefined;
    let needSinceMs: number | undefined;
    const firstPermission = pendingHere.find((p) => p.kind === "permission");
    const firstQuestion = pendingHere.find((p) => p.kind === "question");
    /* checkout phases color the base state: preparing until ready is
       alive, failed is a fault lane. */
    if (!busy && checkout?.phase === "preparing") state = "preparing";
    const checkoutFault = checkout?.phase === "failed";
    /* review is DECLARED, never derived: `CheckoutSnapshot.requested` is
       the agent's own request_review, and the ONLY thing besides wreckage
       that raises this need. mirrors `reviewNeeded` (fleet.tsx:148-164)
       minus the later-snooze, which is device-local app state the daemon
       has no copy of. */
    const requested = checkout?.requested;
    const wantsReview =
      !busy &&
      checkout?.phase === "ready" &&
      requested !== undefined &&
      checkout.review !== undefined &&
      !child;

    if (firstPermission) {
      state = "needsYou";
      need = "permission";
      needSinceMs = parseWhen(firstPermission.receivedAt);
    } else if (firstQuestion) {
      state = "needsYou";
      need = "question";
      needSinceMs = parseWhen(firstQuestion.receivedAt);
    } else if (fault || checkoutFault) {
      state = "fault";
      need = "fault";
      needSinceMs = (fault ? session.fault?.at : undefined) ?? session.updatedAt;
    } else if (wantsReview) {
      state = "needsYou";
      need = "review";
      needSinceMs = requested.at;
    } else if (unread && !busy && !child) {
      state = "needsYou";
      need = "unread";
      needSinceMs = session.updatedAt;
    }

    if (!need) continue;
    const since = needSinceMs ?? session.updatedAt;
    seats.push({
      key: session.key,
      host: session.host,
      sessionID: session.sessionID,
      title: session.title,
      directory: session.directory,
      state,
      need,
      needSinceMs,
      updatedAt: session.updatedAt,
      hot: need === "fault" || now - since >= CHIP_THRESHOLD_MS,
      child,
    });
  }

  return seats.sort((a, b) => {
    const rank = needRank[a.need] - needRank[b.need];
    return rank !== 0 ? rank : waitingSince(a) - waitingSince(b);
  });
}

/** a session that is WORKING right now — no need, but reachable from the
    board ("go to live sessions", first light). */
export type LiveSeat = {
  key: string;
  host: string;
  sessionID: string;
  title?: string;
  directory?: string;
  updatedAt: number;
};

/**
 * every busy session, newest first. live seats rank BELOW every need (a
 * working agent has not asked for him) — the board fills its rows with
 * `deriveSeats` first, these after, deduped by key. children are
 * suppressed the way unread suppresses them: their work flows to the
 * parent, and a blocked child earns a NEED seat through deriveSeats
 * instead.
 */
export function deriveLiveSeats(
  sessions: SeatSession[],
  status: SeatStatus,
): LiveSeat[] {
  return sessions
    .filter(
      (s) =>
        status[s.host]?.[s.sessionID] !== undefined &&
        (s.parentID === undefined || s.parentID === null),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ key, host, sessionID, title, directory, updatedAt }) => ({
      key, host, sessionID, title, directory, updatedAt,
    }));
}
