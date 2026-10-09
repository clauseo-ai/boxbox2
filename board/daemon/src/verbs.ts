/* verb derivation: raw down/up + a clock in, the four-verb grammar out.
   tap looks, hold listens, double-tap speaks, chords extend — one grammar,
   all seventeen keys, and the firmware knows none of it (timings are
   daemon config, tunable without a reflash).

   pure state machine with an injected clock so the tests own time. the
   rules, from docs/scope-board.md §9:

   - tap: down→up under holdMs. REPORTED AFTER the double window closes,
     because a second tap inside it upgrades to a double. keys where a
     double means nothing can be listed tapImmediate to skip the wait.
   - hold: down held past holdMs. holdStart fires AT the threshold (the
     fuel gauge starts painting while the key is still down), holdEnd on
     release.
   - double: two taps where the second down lands inside doubleMs of the
     first up.
   - chord: a second key goes down while another is held — both keys leave
     the grammar and the pair fires as one chord event. order-agnostic.
     release order does not matter; the chord ends when either releases. */

export type VerbTimings = {
  holdMs: number;
  doubleMs: number;
};

export const DEFAULT_TIMINGS: VerbTimings = { holdMs: 350, doubleMs: 300 };

export type VerbEvent =
  | { kind: "tap"; wire: number; at: number }
  | { kind: "double"; wire: number; at: number }
  | { kind: "holdStart"; wire: number; at: number }
  | { kind: "holdEnd"; wire: number; at: number; heldMs: number }
  | { kind: "chord"; wires: [number, number]; at: number }
  | { kind: "chordEnd"; wires: [number, number]; at: number };

type KeyState =
  | { phase: "down"; downAt: number }
  | { phase: "held"; downAt: number } /* holdStart already fired */
  | { phase: "tapPending"; upAt: number } /* waiting out the double window */
  | { phase: "secondDown"; downAt: number }; /* double confirmed on this up */

export class VerbEngine {
  private keys = new Map<number, KeyState>();
  private chord: [number, number] | null = null;
  private timings: VerbTimings;
  private tapImmediate: Set<number>;

  constructor(timings: VerbTimings = DEFAULT_TIMINGS, tapImmediate: number[] = []) {
    this.timings = timings;
    this.tapImmediate = new Set(tapImmediate);
  }

  retime(timings: VerbTimings) {
    this.timings = timings;
  }

  /** feed a raw switch event. returns any verbs it settles. */
  feed(wire: number, down: boolean, at: number): VerbEvent[] {
    const out: VerbEvent[] = [];
    const state = this.keys.get(wire);

    if (down) {
      /* a second key while one is held (or still down) = chord */
      if (this.chord === null) {
        for (const [other, s] of this.keys) {
          if (other === wire) continue;
          if (s.phase === "down" || s.phase === "held") {
            this.chord = [other, wire];
            /* the first key leaves the grammar: cancel its pending life */
            this.keys.delete(other);
            this.keys.delete(wire);
            out.push({ kind: "chord", wires: [other, wire], at });
            return out;
          }
        }
      }

      if (state?.phase === "tapPending") {
        /* second down inside the double window */
        if (at - state.upAt <= this.timings.doubleMs) {
          this.keys.set(wire, { phase: "secondDown", downAt: at });
          return out;
        }
        /* window actually expired but tick() has not run: flush the tap */
        out.push({ kind: "tap", wire, at: state.upAt });
      }
      this.keys.set(wire, { phase: "down", downAt: at });
      return out;
    }

    /* up */
    if (this.chord) {
      const [a, b] = this.chord;
      if (wire === a || wire === b) {
        out.push({ kind: "chordEnd", wires: [a, b], at });
        this.chord = null;
        /* the surviving key of the pair is spent; ignore its later up */
        this.keys.delete(a);
        this.keys.delete(b);
      }
      return out;
    }

    if (!state) return out;

    if (state.phase === "held") {
      out.push({ kind: "holdEnd", wire, at, heldMs: at - state.downAt });
      this.keys.delete(wire);
      return out;
    }
    if (state.phase === "secondDown") {
      out.push({ kind: "double", wire, at });
      this.keys.delete(wire);
      return out;
    }
    if (state.phase === "down") {
      if (at - state.downAt >= this.timings.holdMs) {
        /* release after threshold but before tick noticed: a hold */
        out.push({ kind: "holdStart", wire, at: state.downAt + this.timings.holdMs });
        out.push({ kind: "holdEnd", wire, at, heldMs: at - state.downAt });
        this.keys.delete(wire);
        return out;
      }
      if (this.tapImmediate.has(wire)) {
        out.push({ kind: "tap", wire, at });
        this.keys.delete(wire);
        return out;
      }
      this.keys.set(wire, { phase: "tapPending", upAt: at });
    }
    return out;
  }

  /** advance time: fires holdStarts at threshold and settles taps whose
      double window closed. call every render tick. */
  tick(at: number): VerbEvent[] {
    const out: VerbEvent[] = [];
    for (const [wire, state] of this.keys) {
      if (state.phase === "down" && at - state.downAt >= this.timings.holdMs) {
        this.keys.set(wire, { phase: "held", downAt: state.downAt });
        out.push({ kind: "holdStart", wire, at: state.downAt + this.timings.holdMs });
      } else if (state.phase === "tapPending" && at - state.upAt > this.timings.doubleMs) {
        this.keys.delete(wire);
        out.push({ kind: "tap", wire, at: state.upAt });
      }
    }
    return out;
  }

  /** drop all in-flight state. called on a mode echo: a layer flip hides
      key events from the daemon, so every open press, hold, and pending
      tap is a lie the next real event would settle wrongly. */
  reset() {
    this.keys.clear();
    this.chord = null;
  }

  /** is this wire currently held down (post-threshold)? the fuel gauge
      and the vu meter both key off this. */
  isHeld(wire: number): boolean {
    return this.keys.get(wire)?.phase === "held";
  }

  activeChord(): [number, number] | null {
    return this.chord;
  }
}
