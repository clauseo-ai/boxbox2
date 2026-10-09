/* type-only extraction of v1's lib/server/brain.ts at the commit in
   board/CHECKSUMS (decision 14). the board daemon imports BrainEvent as a
   type; the v1 module's runtime (the fleet brain, push, spend, telemetry)
   stays behind. every declaration below is verbatim from v1 and the
   checksum test holds it to those bytes. */

import type { BindingState, BoardSeat } from "@/lib/board/contract";
import type { GlobalEventFrame } from "@/lib/fleet/types";
import type { HostSnapshot, PendingItem } from "@/lib/fleet/watcher";
import type { ReadState } from "@/lib/read/contract";
import type { TermPinsDoc } from "./term-pins";

export type BrainEvent =
  | {
      kind: "snapshot";
      hosts: HostSnapshot[];
      pending: PendingItem[];
      status: Record<string, Record<string, Record<string, unknown>>>;
      read: ReadState;
      bindings: BindingState;
      /** the last seat map the daemon posted, when one has: the badges
          must not wait up to a heartbeat after every reconnect. the `at`
          stamp still governs staleness client-side. */
      boardSeats?: BoardSeatsEvent;
      /** every host's pinned lines. optional on the type for the same
          reason boardSeats is, but always sent: a reconnect that says
          nothing about pins leaves a card showing lines another device
          unpinned an hour ago. */
      termPins?: TermPinsDoc["hosts"];
    }
  | { kind: "hosts"; hosts: HostSnapshot[] }
  | { kind: "pending"; pending: PendingItem[] }
  | {
      kind: "status";
      status: Record<string, Record<string, Record<string, unknown>>>;
    }
  | { kind: "read"; read: ReadState }
  | { kind: "bindings"; bindings: BindingState }
  /* the machine room's pinned lines, the whole doc every time: the unit
     of change is one host but the unit of truth is small enough to send
     entire, and a client that never merges cannot drift. */
  | { kind: "termPins"; hosts: TermPinsDoc["hosts"]; at: number }
  /* focus is TRANSIENT: a fresh connection has no current focus to catch
     up on, so unlike read/bindings it never rides the snapshot */
  | { kind: "focus"; session: string; at: number }
  /* the board says START HERE: the machines-row key wants a fresh thread
     on that machine. transient, same law as focus. */
  | { kind: "compose"; machineId: string; at: number }
  /* the pairing ritual's arm: the next key pressed on the board binds
     this session. transient, same law as focus. */
  | { kind: "pinArm"; session: string; color: string; at: number }
  /* the daemon's rendered frame, for the machines screen's virtual twin.
     transient: a missed frame is replaced by the next one. */
  | { kind: "boardFrame"; cells: number[]; palette: string[]; at: number }
  /* the drive bank's seat map: which session sits on which digit. held
     in brain memory (not persisted) and echoed on the snapshot — a badge
     that lies about which button to press is worse than none. */
  | ({ kind: "boardSeats" } & BoardSeatsEvent)
  | { kind: "frame"; host: string; frame: GlobalEventFrame };

export type BoardSeatsEvent = {
  seats: BoardSeat[];
  page: number;
  pages: number;
  at: number;
};
