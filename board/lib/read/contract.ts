/* read state, the contract.

   read state used to be device-local: a `bb-read` map plus a `bb-baseline`
   stamped the first time the store ran ON THAT DEVICE. the consequence
   landed 2026-07-25 — an ipad that had been opened once weeks earlier
   showed ~100 phantom unread threads, every one of them already read on
   the mac, none of them tappable in any reasonable amount of time.

   so read state moves to the server, which is trivially the right place:
   every device hits ONE origin, one next process, one brain. this file is
   the shared half — the shapes and the merge rule — imported by both the
   server store and the client store so the two can never disagree about
   what "read" means.

   the merge rule is MAX, per key. monotonic max is conflict-free: two
   devices marking the same thread cannot produce a wrong answer, an echo
   can never un-read something, and an offline device replaying its spool
   late cannot regress a newer stamp. this is also the fix for the
   clock-domain scar (GOTCHAS): a stamp is `max(now, the row's own
   updatedAt)`, so a fast server clock cannot immediately re-flag what he
   just read. */

/** who marked it, and when. the device rides along so a surface can say
    "read on ipad" and so telemetry gets provenance for free. */
export type ReadStamp = { at: number; device: string };

export type ReadState = {
  /** everything older than this is read by definition. ONE baseline for
      the account now, not one per device — a new device inherits the
      fleet's history instead of inventing its own epoch. */
  baselineAt: number;
  /** session key (`${host}:${sessionID}`) → stamp */
  readAt: Record<string, ReadStamp>;
};

export type ReadPatch = {
  baselineAt?: number;
  readAt?: Record<string, ReadStamp>;
};

/** what a client POSTs to /api/read */
export type ReadRequest = {
  device: string;
  /** individual threads he read */
  marks?: { session: string; at: number }[];
  /** the escape valve: everything currently known is read as of `at` */
  markAllAt?: number;
};

export type ReadResponse = ReadState;

export function emptyReadState(baselineAt = 0): ReadState {
  return { baselineAt, readAt: {} };
}

/** fold a patch into a state. pure, order-independent, idempotent.
    returns the new state and whether anything actually moved — callers
    use `changed` to decide whether to persist and whether to fan out. */
export function mergeRead(
  base: ReadState,
  patch: ReadPatch,
): { state: ReadState; changed: boolean } {
  let changed = false;
  const baselineAt = Math.max(base.baselineAt, patch.baselineAt ?? 0);
  if (baselineAt !== base.baselineAt) changed = true;

  const readAt: Record<string, ReadStamp> = { ...base.readAt };
  for (const [key, stamp] of Object.entries(patch.readAt ?? {})) {
    const existing = readAt[key];
    if (existing && existing.at >= stamp.at) continue;
    readAt[key] = stamp;
    changed = true;
  }

  /* a stamp at or below the baseline says nothing the baseline doesn't
     already say. pruning here is what keeps the map from growing one key
     per session forever. */
  for (const [key, stamp] of Object.entries(readAt)) {
    if (stamp.at <= baselineAt) {
      delete readAt[key];
      changed = true;
    }
  }

  return { state: { baselineAt, readAt }, changed };
}

/** the only question surfaces ask: how far has this thread been read? */
export function readAtFor(state: ReadState, sessionKey: string): number {
  return Math.max(state.readAt[sessionKey]?.at ?? 0, state.baselineAt);
}

/** which device last read it, if any is on record above the baseline.
    note a sweep (markAllAt) prunes every stamp, so this goes quiet
    fleet-wide right after one — provenance for a sweep lives in the
    telemetry log's read.mark row, which keeps the device and the count. */
export function readDeviceFor(
  state: ReadState,
  sessionKey: string,
): string | undefined {
  const stamp = state.readAt[sessionKey];
  return stamp && stamp.at > state.baselineAt ? stamp.device : undefined;
}
