/* board bindings, the contract.

   a livery is an agent's color plus one key on the board, and the binding
   lives SERVER-side for exactly the reason read state does: every device
   and the daemon hit ONE origin, one next process, one brain. this file is
   the shared half — the shapes and the merge rule — imported by the server
   store, the app, and the mac daemon, so a key can never mean two things
   at once. no node:fs, no next/server: a plain bun process imports it.

   the merge rule is last write per key wins, by timestamp, the same
   conflict-free shape lib/read/contract.ts uses for marks. clearing a key
   is a real, deliberate act (`board.bind` with bound = 0), so it cannot be
   a delete: a removed entry carries no stamp, and the next echo of the
   older bind would put the agent straight back. a cleared key keeps its
   slot with `agent: null`, a tombstone holding the time it was cleared.
   the map is bounded at 17 keys, so unlike read's stamps nothing here ever
   needs pruning. */

/** the board has 17 keys. wire index is the daemon + /board sim ordering,
    never the led or matrix ordering — all three differ, and mixing them
    lights the wrong key with no error (docs/scope-board.md §3). */
export const WIRE_KEY_COUNT = 17;

export function isWireIndex(wire: unknown): wire is number {
  return (
    typeof wire === "number" &&
    Number.isInteger(wire) &&
    wire >= 0 &&
    wire < WIRE_KEY_COUNT
  );
}

/** what one key holds. the device rides along so a surface can say where a
    binding came from and so telemetry gets provenance for free. */
export type Binding = {
  /** the agent that owns this key (`${host}:${sessionID}`), or null: the
      tombstone left behind when the key was deliberately cleared. */
  agent: string | null;
  /** her livery. absent on a tombstone. */
  color?: string;
  /** when the write landed, stamped by the origin. this is the whole
      merge rule. */
  at: number;
  device: string;
};

export type BindingState = {
  /** wire index, stringified, → what that key holds */
  keys: Record<string, Binding>;
};

export type BindingPatch = {
  keys?: Record<string, Binding>;
};

/** what a client POSTs to /api/board/bindings. no `at` on the wire: the
    origin stamps every write, so one device with a fast clock cannot pin a
    key nothing else can overwrite. */
export type BindingRequest = {
  device: string;
  binds?: { wire: number; agent: string | null; color?: string }[];
};

export type BindingResponse = BindingState;

export function emptyBindings(): BindingState {
  return { keys: {} };
}

/** fold a patch into a state. pure, order-independent, idempotent.
    returns the new state and whether anything actually moved — callers
    use `changed` to decide whether to persist and whether to fan out.

    strictly last write wins, with no comparison of the values themselves:
    re-binding the same agent to the same key is a new write and lands as
    one. comparing values instead would make the fold order-dependent (the
    loser of the race would keep its stamp), and a binding is rare enough
    that one extra fan-out costs nothing. */
export function mergeBindings(
  base: BindingState,
  patch: BindingPatch,
): { state: BindingState; changed: boolean } {
  let changed = false;
  const keys: Record<string, Binding> = { ...base.keys };

  for (const [key, held] of Object.entries(patch.keys ?? {})) {
    const existing = keys[key];
    if (existing && existing.at >= held.at) continue;
    keys[key] = held;
    changed = true;
  }

  return { state: { keys }, changed };
}

/* ——— the seat map: which agent sits on which digit ———

   the daemon is the only party that knows the true drive-bank assignment
   (rank order, the current page, bound keys), so it publishes the map
   and the glass wears it as a badge on every live row. re-deriving
   app-side would drift the moment he taps `.` — one source of truth:
   the thing driving the leds also declares who is on them. */

/** one session's seat: the digit printed on the physical key it sits on
    (1-9, digit = rank since 2026-07-29), and whether that key is showing
    on the page the board has up right now. */
export type BoardSeat = {
  /** `${host}:${sessionID}`, the same identity bindings ride */
  key: string;
  digit: number;
  visible: boolean;
};

/** what the daemon POSTs to /api/board/seats, on change plus a slow
    heartbeat — the origin stamps `at`, and the glass hides badges when
    the stamp goes stale (no daemon, no map, no badge). */
export type BoardSeatMap = {
  seats: BoardSeat[];
  page: number;
  pages: number;
};

/** the only question a surface asks: what does this key hold right now?
    tombstones read as free, which is what a cleared key is. */
export function bindingFor(
  state: BindingState,
  wire: number,
): (Binding & { agent: string }) | undefined {
  const held = state.keys[String(wire)];
  if (!held || held.agent === null) return undefined;
  const { agent } = held;
  return { ...held, agent };
}
