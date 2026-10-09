/* the daemon's mirror of the fleet: everything the render loop reads,
   fed by the one multiplexed sse stream plus the same REST reconcile the
   web client runs. reconnect means resync, never resume — on snapshot we
   reset every inference and let truth rebuild (docs/scope-board.md §2).

   runtime imports are pure modules only. server/react types arrive as
   `import type`, which the transpiler erases — the daemon never loads
   next code. */

import type { BrainEvent } from "../../lib/server/brain";
import type {
  CheckoutSnapshot,
  HostSnapshot,
  PendingItem,
} from "../../lib/fleet/watcher";
import type { GlobalEventFrame } from "../../lib/fleet/types";
import { emptyBindings, type BindingState } from "../../lib/board/contract";
import { emptyReadState, type ReadState } from "../../lib/read/contract";
import type { SeatCheckouts, SeatSession, SeatStatus } from "../../lib/board/seats";

/** one cmx session row as the proxy returns it — only what we read. */
type WireSession = {
  id?: string;
  title?: string;
  directory?: string;
  parentID?: string;
  time?: { created?: number; updated?: number };
};

export type SpendToday = { totalUsd: number };

const SEEN_CAP = 4000;

export class FleetState {
  hosts: HostSnapshot[] = [];
  pending: PendingItem[] = [];
  status: SeatStatus = {};
  read: ReadState = emptyReadState();
  bindings: BindingState = emptyBindings();
  spend: SpendToday = { totalUsd: 0 };

  private sessions = new Map<string, SeatSession>();
  private queue = new Map<string, number>();
  /** message ids already seen — "born" detection for queue inference */
  private seen = new Set<string>();
  /** sessionKey → last message.part.delta, the breathing scene's pulse */
  private deltaAt = new Map<string, number>();
  /** host → decaying delta rate, the fleet waterfall's fuel */
  private hostRate = new Map<string, number>();
  /** checkouts that could earn a lap: `${host}\u0000${dir}` present while
      phase ready + review requested. a disappearance is a verdict. */
  private lappable = new Set<string>();
  private verdicts = 0;

  /* ——— brain events ——— */

  applyBrain(event: BrainEvent, now = Date.now()) {
    switch (event.kind) {
      case "snapshot":
        this.hosts = [...event.hosts];
        this.pending = [...event.pending];
        this.status = event.status as SeatStatus;
        this.read = event.read;
        this.bindings = event.bindings ?? emptyBindings();
        /* the inference cannot survive a gap it did not see */
        this.queue.clear();
        this.rebuildLappable(false);
        break;
      case "hosts":
        this.hosts = [...event.hosts];
        this.rebuildLappable(true);
        break;
      case "pending":
        this.pending = [...event.pending];
        break;
      case "status":
        this.status = event.status as SeatStatus;
        break;
      case "read":
        this.read = event.read;
        break;
      case "bindings":
        this.bindings = event.bindings;
        break;
      case "frame":
        this.applyFrame(event.host, event.frame, now);
        break;
    }
  }

  /* ——— raw cmx frames, host-tagged by the brain ——— */

  private applyFrame(host: string, frame: GlobalEventFrame, now: number) {
    const type = frame.payload?.type;
    const props = (frame.payload?.properties ?? {}) as Record<string, unknown>;
    if (!type) return;

    switch (type) {
      case "session.status": {
        const sessionID = props.sessionID as string | undefined;
        if (!sessionID) return;
        const statusObj = props.status as { type?: string } | undefined;
        const statusType = statusObj?.type;
        const key = `${host}:${sessionID}`;
        const hostMap = (this.status[host] ??= {});
        if (statusType === "idle" || statusType === undefined) {
          delete hostMap[sessionID];
          this.queue.delete(key);
        } else {
          /* keep the WHOLE status object: when cmx grows `queued` on the
             busy variant (workstream D), the exact count rides here and
             queueDepth prefers it over the inference */
          hostMap[sessionID] = { ...statusObj };
          /* moving again forgives the fault, the brain's own rule */
          const row = this.sessions.get(key);
          if (row?.fault) this.sessions.set(key, { ...row, fault: undefined });
        }
        break;
      }
      case "session.error": {
        const sessionID = props.sessionID as string | undefined;
        if (!sessionID) return;
        const key = `${host}:${sessionID}`;
        const row = this.sessions.get(key);
        if (row) this.sessions.set(key, { ...row, fault: { at: now } });
        break;
      }
      case "session.updated": {
        const info = props.info as WireSession | undefined;
        if (info?.id) this.upsertSession(host, info);
        break;
      }
      case "session.deleted": {
        const info = props.info as WireSession | undefined;
        if (info?.id) {
          const key = `${host}:${info.id}`;
          this.sessions.delete(key);
          this.queue.delete(key);
          this.deltaAt.delete(key);
        }
        break;
      }
      case "message.updated": {
        const info = props.info as
          | { id?: string; sessionID?: string; role?: string }
          | undefined;
        if (!info?.id || !info.sessionID) return;
        const key = `${host}:${info.sessionID}`;
        if (info.role === "assistant") {
          this.queue.set(key, 0);
          this.remember(info.id);
          return;
        }
        if (info.role !== "user" || this.seen.has(info.id)) return;
        this.remember(info.id);
        /* a user message born while the loop is busy is a queued order —
           cmx's own definition (canUnsendWhileBusy), inferred client-side
           because the wire carries no depth (scope-board §6) */
        if (this.status[host]?.[info.sessionID] !== undefined) {
          this.queue.set(key, (this.queue.get(key) ?? 0) + 1);
        }
        break;
      }
      case "message.part.delta": {
        const sessionID = props.sessionID as string | undefined;
        if (!sessionID) return;
        this.deltaAt.set(`${host}:${sessionID}`, now);
        this.hostRate.set(host, Math.min(60, (this.hostRate.get(host) ?? 0) + 1));
        break;
      }
    }
  }

  /* ——— REST reconcile ——— */

  setSessions(host: string, rows: unknown[]) {
    /* union, never replace: child sessions do not ride roots=true lists
       and a fetch race must not vaporize a row mid-render */
    for (const raw of rows) {
      const info = raw as WireSession;
      if (info?.id) this.upsertSession(host, info);
    }
  }

  private upsertSession(host: string, info: WireSession) {
    const key = `${host}:${info.id}`;
    const prev = this.sessions.get(key);
    this.sessions.set(key, {
      key,
      host,
      sessionID: info.id as string,
      title: info.title ?? prev?.title,
      directory: info.directory ?? prev?.directory,
      parentID: info.parentID ?? prev?.parentID,
      updatedAt: info.time?.updated ?? info.time?.created ?? prev?.updatedAt ?? 0,
      fault: prev?.fault,
    });
  }

  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > SEEN_CAP) {
      for (const old of this.seen) {
        this.seen.delete(old);
        if (this.seen.size <= SEEN_CAP / 2) break;
      }
    }
  }

  /* ——— the victory lap's source: a reviewable checkout vanishing.
     merge and discard are indistinguishable on this wire (nothing
     publishes a verdict event); both are a verdict delivered, and v1
     accepts that a discard also earns the lap — documented, not hidden. */

  private rebuildLappable(detectVerdicts: boolean) {
    const next = new Set<string>();
    for (const h of this.hosts) {
      for (const c of h.checkouts ?? []) {
        if (c.phase === "ready" && c.requested !== undefined) {
          next.add(`${h.id}\u0000${c.directory}`);
        }
      }
    }
    if (detectVerdicts) {
      for (const key of this.lappable) {
        if (!next.has(key)) this.verdicts += 1;
      }
    }
    this.lappable = next;
  }

  /** verdicts since last drain — the controller turns these into laps */
  drainVerdicts(): number {
    const n = this.verdicts;
    this.verdicts = 0;
    return n;
  }

  /* ——— render-facing getters ——— */

  seatInput(): {
    sessions: SeatSession[];
    pending: PendingItem[];
    status: SeatStatus;
    read: ReadState;
    checkouts: SeatCheckouts;
  } {
    const checkouts: SeatCheckouts = {};
    for (const h of this.hosts) checkouts[h.id] = (h.checkouts ?? []) as CheckoutSnapshot[];
    return {
      sessions: [...this.sessions.values()],
      pending: this.pending,
      status: this.status,
      read: this.read,
      checkouts,
    };
  }

  /** busy on the wire, no row held. the reconcile is PROJECT-scoped and
      `session.status` carries no row of its own, so a working agent
      outside the default project is invisible until someone fetches it.
      NEVER synthesize one: a made-up row has no parentID, and the board
      would seat subagents as if they were threads. the daemon backfills
      these by id (unscoped, never spawns) and learns real parentage. */
  unknownBusy(): { host: string; sessionID: string }[] {
    const out: { host: string; sessionID: string }[] = [];
    for (const [host, map] of Object.entries(this.status)) {
      for (const sessionID of Object.keys(map)) {
        if (!this.sessions.has(`${host}:${sessionID}`)) out.push({ host, sessionID });
      }
    }
    return out;
  }

  session(key: string): SeatSession | undefined {
    return this.sessions.get(key);
  }

  queueDepth(key: string): number {
    /* the exact count when cmx sends it (workstream D's busy.queued),
       the event-driven inference until then */
    const idx = key.indexOf(":");
    const exact = this.status[key.slice(0, idx)]?.[key.slice(idx + 1)]?.queued;
    if (typeof exact === "number") return exact;
    return this.queue.get(key) ?? 0;
  }

  /** busy sessions with a non-empty queue, for the queue blink scene */
  queuedSeats(): { key: string; depth: number }[] {
    const out = new Map<string, number>();
    for (const [key, depth] of this.queue) {
      if (depth > 0) out.set(key, depth);
    }
    /* exact counts override or add */
    for (const [host, sessions] of Object.entries(this.status)) {
      for (const [sessionID, s] of Object.entries(sessions)) {
        const exact = (s as { queued?: unknown }).queued;
        if (typeof exact === "number") {
          const key = `${host}:${sessionID}`;
          if (exact > 0) out.set(key, exact);
          else out.delete(key);
        }
      }
    }
    return [...out.entries()].map(([key, depth]) => ({ key, depth }));
  }

  /** ms since the last token landed for this session, Infinity if never */
  deltaAge(key: string, now: number): number {
    const at = this.deltaAt.get(key);
    return at === undefined ? Number.POSITIVE_INFINITY : now - at;
  }

  /** decaying per-host token rate — call decay() once per second */
  hostActivity(host: string): number {
    return this.hostRate.get(host) ?? 0;
  }

  decay() {
    for (const [host, rate] of this.hostRate) {
      const next = rate * 0.7;
      if (next < 0.05) this.hostRate.delete(host);
      else this.hostRate.set(host, next);
    }
  }
}
