/* the conductor: derived verbs in, actions + scene changes out. this is
   where the four-verb grammar meets the fleet, where the pit stages and
   fires, and where §10's rule is enforced: every keypress that serves a
   need emits BOTH board.key and the generic verb, or the bet cannot be
   measured.

   destructive law: reject cascades to every pending request in the
   session (cmx permission/index.ts:216-272), so the reject key ARMS
   fault-red for rejectArmMs and fires only on the second press. */

import { bindingFor, type BoardSeat, type BoardSeatMap } from "../../lib/board/contract";
import {
  deriveLiveSeats, deriveSeats, type LiveSeat, type Seat,
} from "../../lib/board/seats";
import type { PendingItem } from "../../lib/fleet/watcher";
import type { BoxboxClient } from "./client";
import type { BoardConfig } from "./config";
import type { BoardDevice } from "./device";
import type { Logger } from "./log";
import { LIVERY_SLOTS, WIRE } from "./protocol";
import {
  arrivalPulse, briefing, formationLap,
  redFlag, TransientPlayer, victoryLap, DIGIT_WIRES,
} from "./scenes";
import type { FleetState } from "./state";
import type { Radio } from "./radio";
import { VerbEngine, type VerbEvent } from "./verbs";

export type Bank = "drive" | "pit" | "fleet";

type PitStage = {
  item: PendingItem;
  seat: Seat;
  rejectArmedUntil: number;
  enteredAt: number;
};

type QuestionOption = { label: string };

function questionOptions(item: PendingItem): QuestionOption[] {
  const raw = item.raw as
    | { questions?: { options?: { label?: string }[] }[] }
    | undefined;
  const qs = raw?.questions ?? [];
  if (qs.length !== 1) return []; /* multi-question asks are voice-only */
  return (qs[0].options ?? [])
    .map((o) => ({ label: o.label ?? "" }))
    .filter((o) => o.label.length > 0);
}

export class Controller {
  bank: Bank = "drive";
  deepWork = false;
  page = 0;
  calcMode = false;
  transients = new TransientPlayer();
  verbs: VerbEngine;

  /** seat held down right now: the queue view while the finger is on it,
      and the target the ent chord flushes */
  heldSeat: { key: string; wire: number } | null = null;
  /** the seat key the board points at (seat double-tap, radio chord) */
  pointed: string | null = null;
  /** wispr hands-free: a double-tap on the radio opened the mic without
      a hold (wispr's own double-tap lock, verified against its docs
      2026-07-29). dead reckoning — the daemon never sees wispr's state,
      only the same keypresses wispr watches. */
  handsFree = false;
  private handsFreeSince = 0;
  /** swallow radio presses briefly after a hands-free stop: wispr's
      triple-tap DISMISSES a session, and its tail taps would otherwise
      read as a fresh double — re-arming a session wispr just cancelled */
  private radioQuietUntil = 0;
  pit: PitStage | null = null;
  /** the pairing ritual, daemon half: the next key down binds this */
  pinArm: { session: string; color: string } | null = null;

  private prevNeedKeys = new Map<string, string>(); /* key → need */
  private lastSnapshotAt = 0;
  private seatsCache: Seat[] = [];
  private liveCache: LiveSeat[] = [];
  private seatsDerivedAt = 0;
  private liveryByAgent = new Map<string, number>();

  constructor(
    private state: FleetState,
    private client: BoxboxClient,
    private device: BoardDevice,
    private radio: Radio,
    private cfg: BoardConfig,
    private log: Logger,
  ) {
    this.verbs = new VerbEngine(
      { holdMs: cfg.holdMs, doubleMs: cfg.doubleMs },
      /* pit option keys answer on the FIRST press — a decision key that
         waits out a double window feels broken */
      [],
    );
  }

  reconfigure(cfg: BoardConfig) {
    this.cfg = cfg;
    this.verbs.retime({ holdMs: cfg.holdMs, doubleMs: cfg.doubleMs });
  }

  /* ——— livery slots: bound agents get stable palette slots 9-15 ——— */

  syncLiveries(): { wire: number; slot: number; color: [number, number, number] }[] {
    const out: { wire: number; slot: number; color: [number, number, number] }[] = [];
    const wires = Object.keys(this.state.bindings.keys)
      .map(Number)
      .sort((a, b) => a - b);
    let next = 0;
    for (const wire of wires) {
      const held = bindingFor(this.state.bindings, wire);
      if (!held || next >= LIVERY_SLOTS.length) continue;
      let slot = this.liveryByAgent.get(held.agent);
      if (slot === undefined) {
        slot = LIVERY_SLOTS[next];
        this.liveryByAgent.set(held.agent, slot);
      }
      next += 1;
      out.push({ wire, slot, color: parseColor(held.color) });
    }
    return out;
  }

  seats(now: number): Seat[] {
    /* derivation walks and sorts every session, and the render loop asks
       twice per frame (observe + driveModel) — ~125 full passes/s, the
       daemon's biggest cpu line once the hid flood was gated (2026-07-27).
       4hz is indistinguishable on a face where an arrival pulses for
       hundreds of ms; a snapshot resets the clock so reconnects repaint
       immediately. */
    if (this.seatsDerivedAt > 0 && now - this.seatsDerivedAt < 250) {
      return this.seatsCache;
    }
    this.seatsDerivedAt = now;
    const input = this.state.seatInput();
    this.seatsCache = deriveSeats(
      input.sessions, input.pending, input.status, input.read, input.checkouts, now,
    );
    /* live seats: busy sessions that neither hold a need seat nor live on
       a bound key (bound working agents already pulse on their own key) */
    const seated = new Set(this.seatsCache.map((s) => s.key));
    this.liveCache = deriveLiveSeats(input.sessions, input.status).filter(
      (l) => !seated.has(l.key) && !this.isBoundAgent(l.key),
    );
    return this.seatsCache;
  }

  liveSeats(): LiveSeat[] {
    return this.liveCache;
  }

  /** row 3's full addressable list: needs in triage order, then live */
  rowKeys(): string[] {
    return [
      ...this.seatsCache.map((s) => s.key),
      ...this.liveCache.map((l) => l.key),
    ];
  }

  /* ——— lifecycle moments ——— */

  onBoardConnect() {
    const bound = this.syncLiveries().map(({ wire, slot }) => ({ wire, slot }));
    this.transients.push(formationLap(bound), Date.now());
    this.log.info("board.formation", { bound: bound.length });
    this.client.emit("board.connect", { fw: 1, proto: 1 });
  }

  /** the board's mode echo (or the hello ack's mode byte): sync, and drop
      every in-flight verb. a layer flip hides key events from the daemon
      — the calc layer reports nothing — so any open press, hold, or
      pending tap is now a lie. the 2026-07-27 wedge was exactly this: a
      stale nl hold surviving a calc round-trip, closing minutes later
      against the exit-hold's orphaned key-up, and shoving the board
      straight back into numpad. */
  onModeEcho(mode: number) {
    this.calcMode = mode === 1;
    this.verbs.reset();
    this.heldSeat = null;
    if (this.handsFree) this.stopHandsFree("mode");
  }

  onSnapshot(now: number) {
    this.seatsDerivedAt = 0; /* fresh truth: repaint without the memo lag */
    if (this.lastSnapshotAt > 0 && now - this.lastSnapshotAt > this.cfg.awayMs) {
      this.transients.push(briefing(), now);
      this.log.info("board.briefing", { awayMs: now - this.lastSnapshotAt });
    }
    this.lastSnapshotAt = now;
  }

  /** per-tick bookkeeping: arrivals pulse, verdicts lap, pit auto-exits */
  observe(now: number) {
    const seats = this.seats(now);

    /* arrivals: a key that newly wants him pulses once, then stillness */
    const nextNeeds = new Map<string, string>();
    for (const seat of seats) nextNeeds.set(seat.key, seat.need);
    for (const [key, need] of nextNeeds) {
      if (this.prevNeedKeys.get(key) === need) continue;
      const wire = this.wireForKey(key);
      if (wire === null) continue;
      if (need === "fault") {
        this.transients.push(redFlag(wire), now);
      } else if (need === "permission") {
        this.transients.push(arrivalPulse(wire, 5, true), now); /* permHot */
      } else if (this.prevNeedKeys.size > 0) {
        this.transients.push(arrivalPulse(wire, 3), now); /* needsHot */
      }
    }
    this.prevNeedKeys = nextNeeds;

    /* verdicts: a reviewable checkout left the board */
    const verdicts = this.state.drainVerdicts();
    for (let i = 0; i < verdicts; i++) this.transients.push(victoryLap(), now);

    /* pit truth: the authoritative clear is the pending list dropping
       the id, never our own POST's 200 */
    if (this.pit) {
      const alive = this.state.pending.some((p) => p.id === this.pit?.item.id);
      if (!alive) {
        this.log.info("pit.cleared", { id: this.pit.item.id });
        this.pit = null;
        this.bank = "drive";
      } else if (this.pit.rejectArmedUntil > 0 && now > this.pit.rejectArmedUntil) {
        this.pit.rejectArmedUntil = 0;
      }
    }

    /* paging truth: the list shrank under the page (or a binding freed
       keys). a page past the end is a dark board lying about an empty
       fleet — snap home instead. */
    if (this.page >= this.pageCount()) this.page = 0;
  }

  /* ——— raw key events from the device ——— */

  onKey(wire: number, down: boolean, at: number) {
    /* the pairing ritual outranks the grammar: while armed, the very
       next key DOWN is the answer to "where does she live" */
    if (this.pinArm && down) {
      const { session, color } = this.pinArm;
      this.pinArm = null;
      void this.client.postBinding(wire, session, color).then((ok) => {
        this.log.info("pin.bound", { wire, session, ok });
        this.client.emit("board.bind", { wire, agent: session, bound: 1 }, { ok, session });
      });
      /* confirm in violet now; the livery settles when the bindings
         event echoes back and syncLiveries repaints the palette */
      this.transients.push(arrivalPulse(wire, 1), Date.now());
      return;
    }
    if (wire === WIRE.k0) {
      /* hands-free: this press is wispr's STOP control (press the ptt
         key once again → stop and paste, its docs 2026-07-29). the
         daemon's whole job is to shut the meter up and get out of the
         way — no verb, no readback spoken over the pasted words. */
      if (this.handsFree && down) {
        this.stopHandsFree("key");
        this.radioQuietUntil = at + this.cfg.doubleMs * 2;
        this.client.emit(
          "board.key",
          { wire, verb: "tap", target: "handsfree", bank: this.bank },
          { ok: true },
        );
        return;
      }
      /* refractory: the tail presses of wispr's triple-tap dismissal
         land here and must not derive verbs */
      if (at < this.radioQuietUntil) return;
    }
    for (const verb of this.verbs.feed(wire, down, at)) this.act(verb);
    /* the radio meter tracks the raw switch, not the derived verb: push
       to talk needs proof of hearing from the first millisecond. while
       hands-free is up the FLAG owns the meter — a release must not
       silence a mic wispr is still listening through. */
    if (wire === WIRE.k0 && !this.handsFree) {
      if (down) this.radio.startMeter();
      else this.radio.stopMeter();
    }
  }

  armPin(session: string, color: string) {
    this.pinArm = { session, color };
    this.log.info("pin.armed", { session });
  }

  tick(at: number) {
    for (const verb of this.verbs.tick(at)) this.act(verb);
    /* hands-free is dead reckoning: if wispr stopped without us (its
       own ui, esc, a dismissal the refractory missed), the meter must
       not draw a listening board forever. sustained silence clears the
       flag; with no ear (meter disabled or sox dead) the same window
       acts as a hard cap from the double-tap. */
    if (this.handsFree && this.cfg.handsFreeSilenceMs > 0) {
      const quiet = this.radio.meterActive()
        ? this.radio.msSinceVoice(at)
        : at - this.handsFreeSince;
      if (quiet >= this.cfg.handsFreeSilenceMs) this.stopHandsFree("silence");
    }
  }

  private stopHandsFree(reason: "key" | "silence" | "mode") {
    this.handsFree = false;
    this.radio.stopMeter();
    this.log.info("radio.handsfree", { on: false, reason });
  }

  /* ——— the grammar, resolved per bank ——— */

  private act(verb: VerbEvent) {
    const started = Date.now();
    const done = (verbName: string | null, target: string, ok: boolean) => {
      this.client.emit(
        "board.key",
        { wire: wireOf(verb), verb: verb.kind, target, bank: this.bank },
        { ok, ms: Date.now() - started },
      );
      if (verbName) {
        /* §10: the generic verb event is what closes a need in v_needs.
           board.key alone is invisible to the bet. */
        this.client.emit("verb", { name: verbName }, {
          ok,
          ms: Date.now() - started,
          session: this.verbSession ?? undefined,
        });
        this.verbSession = null;
      }
    };

    this.log.info("verb", { kind: verb.kind, wire: wireOf(verb), bank: this.bank });

    if (this.bank === "pit" && this.pit) {
      this.actPit(verb, done);
      return;
    }
    switch (this.bank) {
      case "drive":
        this.actDrive(verb, done);
        break;
      case "fleet":
        if (verb.kind === "tap" && verb.wire === WIRE.nl) this.cycleBank(done);
        else done(null, "fleet", true);
        break;
    }
  }

  private verbSession: string | null = null;

  private actDrive(verb: VerbEvent, done: Done) {
    if (verb.kind === "chord") {
      const [a, b] = verb.wires;
      /* hold a seat, press ent: flush that session's queue — the same
         abort-then-loop the glass fires ~12 times a day (2026-07-29:
         189 of 574 prompts queued, flushQueued × 58 in the log). gated
         on depth: with nothing parked, abort+loop is a bare interrupt.
         the firmware still types a real enter — the same stray-enter
         class every ent use already accepts. */
      const entPartner = a === WIRE.ent ? b : b === WIRE.ent ? a : null;
      if (entPartner !== null) {
        const entry = this.resolveWire(entPartner);
        const depth = entry ? this.state.queueDepth(entry.key) : 0;
        if (entry && depth > 0) {
          const idx = entry.key.indexOf(":");
          const row = this.state.session(entry.key);
          this.verbSession = entry.key;
          this.log.info("queue.flush", { session: entry.key, depth });
          void this.client
            .flushQueue(entry.key.slice(0, idx), entry.key.slice(idx + 1), row?.directory)
            .then((ok) => done("flushQueued", "flush", ok));
          return;
        }
        done(null, "chord", true);
        return;
      }
      const seatWire = a === WIRE.k0 ? b : b === WIRE.k0 ? a : null;
      if (seatWire !== null) {
        const entry = this.resolveWire(seatWire);
        if (entry) {
          this.pointed = entry.key;
          this.radio.startMeter();
          this.log.info("radio.chord", { session: entry.key });
        }
      }
      done(null, "chord", true);
      return;
    }
    if (verb.kind === "chordEnd") {
      this.heldSeat = null;
      if (!this.handsFree) this.radio.stopMeter();
      done(null, "chord", true);
      return;
    }

    switch (verb.kind) {
      case "tap": {
        if (verb.wire === WIRE.nl) return this.cycleBank(done);
        if (verb.wire === WIRE.dot) {
          this.page = (this.page + 1) % this.pageCount();
          return done(null, "page", true);
        }
        if (verb.wire === WIRE.plus) return this.copy(done);
        if (verb.wire === WIRE.k0) return this.readback(done);
        if (verb.wire === WIRE.ent) {
          /* ent is a REAL enter key: the firmware types KC_PENT into
             whatever has focus (the composer wispr just filled), same
             soul clause as the radio's ctrl+F18. the daemon only
             witnesses it for telemetry — no channel, no target guess
             (the send channel died 2026-07-27; focus is the truth). */
          return done(null, "enter", true);
        }
        /* the machines row: the key that shows a serve's pulse also
           starts a thread on it. tap opens the compose sheet on the
           glass with the machine picked — the same door as the app's
           plus, pre-aimed. order is cfg.machineOrder (div, mul, min). */
        const machineIdx = [WIRE.div, WIRE.mul, WIRE.min].indexOf(verb.wire);
        if (machineIdx >= 0) {
          const host = this.cfg.machineOrder[machineIdx];
          if (!host) return done(null, "empty", true);
          void this.client
            .composeMachine(host)
            .then((ok) => done(null, "compose", ok));
          return;
        }
        const entry = this.resolveWire(verb.wire);
        if (!entry) return done(null, "empty", true);
        if (entry.seat?.need === "permission" || entry.seat?.need === "question") {
          return this.enterPit(entry.seat, done);
        }
        /* a live session or a soft need: point and focus the glass */
        this.pointed = entry.key;
        this.verbSession = entry.key;
        void this.client.focus(entry.key);
        return done(null, "focus", true);
      }
      case "double": {
        if (verb.wire === WIRE.nl) {
          /* calc is the firmware's verb (a double-tap since fw 5 — it
             traded verbs with deep work 2026-08-01: the log showed ~3
             calc round-trips a day against 3 lifetime deep-work
             toggles). the flip arrives as a mode echo, never as a verb
             we act on: two detectors on one key is the numpad-wedge
             scar. */
          return done(null, "mode", true);
        }
        if (verb.wire === WIRE.k0) {
          /* wispr locked into hands-free on the same two ctrl+F18 taps
             the firmware just delivered; the daemon's only job is to
             keep the meter honest until the stop press. radio.point
             died here (2026-07-29): telemetry showed every double-tap
             on the radio was an accident. */
          this.handsFree = true;
          this.handsFreeSince = verb.at;
          this.radio.startMeter();
          this.log.info("radio.handsfree", { on: true });
          return done(null, "handsfree", true);
        }
        const entry = this.resolveWire(verb.wire);
        if (entry) {
          this.pointed = entry.key;
          void this.client.focus(entry.key);
          this.log.info("dictation.armed", { session: entry.key });
        }
        return done(null, "dictate", entry !== undefined);
      }
      case "holdStart": {
        if (verb.wire === WIRE.nl) {
          /* deep work: the hold half of the 2026-08-01 verb swap. fires
             at the threshold, not the release — a filter you are
             flicking should answer under the finger. */
          this.deepWork = !this.deepWork;
          this.log.info("deepwork", { on: this.deepWork });
          return done(null, "deepwork", true);
        }
        /* push to talk: the raw switch already opened the meter. named
           honestly at last — the old generic "gauge" label hid the
           instrument's most-used verb from the log (2026-07-29). */
        if (verb.wire === WIRE.k0) return done(null, "talk", true);
        const entry = this.resolveWire(verb.wire);
        if (!entry) return done(null, "empty", true);
        /* the queue view: how many orders are parked behind this seat,
           readable while the finger is down. ent (a chord now) flushes. */
        this.heldSeat = { key: entry.key, wire: verb.wire };
        return done(null, "queue", true);
      }
      case "holdEnd": {
        this.heldSeat = null;
        return done(
          null,
          verb.wire === WIRE.k0 ? "talk" : verb.wire === WIRE.nl ? "deepwork" : "queue",
          true,
        );
      }
    }
  }

  private actPit(verb: VerbEvent, done: Done) {
    const stage = this.pit;
    if (!stage) return;
    if (verb.kind !== "tap" && verb.kind !== "double") {
      return done(null, "pit", true);
    }
    const wire = wireOf(verb);
    const { item, seat } = stage;
    this.verbSession = seat.key;

    if (wire === WIRE.min) {
      /* skip: back to drive, next need surfaces by rank */
      this.pit = null;
      this.bank = "drive";
      return done(null, "skip", true);
    }

    if (item.kind === "permission") {
      const reply =
        wire === WIRE.k1 ? "once" : wire === WIRE.k2 ? "always" : wire === WIRE.k3 ? "reject" : null;
      if (!reply) return done(null, "pit", true);
      if (reply === "reject") {
        if (stage.rejectArmedUntil === 0 || Date.now() > stage.rejectArmedUntil) {
          /* first press arms: reject cascades to the whole session */
          stage.rejectArmedUntil = Date.now() + this.cfg.rejectArmMs;
          return done(null, "arm", true);
        }
      }
      void this.client
        .replyPermission(seat.host, item.id, reply, item.directory)
        .then((ok) => done("replyPermission", "permission", ok));
      return;
    }

    /* question: digit keys answer single-question asks by option index */
    const options = questionOptions(item);
    const idx = DIGIT_WIRES.indexOf(wire);
    if (idx < 0 || idx >= options.length) return done(null, "pit", true);
    void this.client
      .replyQuestion(seat.host, item.id, [[options[idx].label]], item.directory)
      .then((ok) => done("answerQuestion", "question", ok));
  }

  /* ——— small moves ——— */

  /** two banks in the cycle since 2026-07-29: the grid died with 7
      lifetime presses (6 of them passing through), and launching lives
      on the glass — machine tap → compose sheet → dictate → ent. */
  private cycleBank(done: Done) {
    this.bank = this.bank === "drive" ? "fleet" : "drive";
    this.log.info("bank", { bank: this.bank });
    done(null, "bank", true);
  }

  private enterPit(seat: Seat, done: Done) {
    const item = this.state.pending.find(
      (p) => `${p.host}:${p.sessionID}` === seat.key,
    );
    if (!item) return done(null, "pit", false);
    this.pit = { item, seat, rejectArmedUntil: 0, enteredAt: Date.now() };
    this.bank = "pit";
    this.log.info("pit.entered", { kind: item.kind, id: item.id });
    done(null, "pit", true);
  }

  private copy(done: Done) {
    const call = this.seatsCache[0];
    if (!call) return done(null, "copy", true);
    const at = Math.max(Date.now(), call.updatedAt);
    this.verbSession = call.key;
    void this.client.markRead(call.key, at).then((ok) => done("markRead", "copy", ok));
  }

  private readback(done: Done) {
    const call = this.seatsCache[0];
    if (!call) {
      const working = this.liveCache.length;
      this.radio.say(
        working === 0
          ? "all quiet"
          : `all quiet, ${working} thread${working === 1 ? "" : "s"} working`,
      );
      return done(null, "radio", true);
    }
    const minutes = Math.round((Date.now() - (call.needSinceMs ?? call.updatedAt)) / 60_000);
    const what =
      call.need === "permission" ? "wants permission"
      : call.need === "question" ? "has a question"
      : call.need === "fault" ? "hit a fault"
      : call.need === "review" ? "wants review"
      : "has news";
    this.radio.say(
      `${call.title ?? "a thread"} ${what}, waiting ${minutes} minute${minutes === 1 ? "" : "s"}`,
    );
    done(null, "radio", true);
  }

  /* ——— geometry helpers ——— */

  /** the 3×3 wires the automatic queue may seat on: every grid key not
      held by a pinned livery, in DIGIT order (rank 1 = the key whose cap
      says 1; 2026-07-29, "order it 123456789" — the glass badges each
      thread's digit, and a badge only answers "which button" if rank and
      digit agree). the queue fills the whole block — rows 1-2 are not
      reserved (2026-07-27, "use all nine keys"). */
  private seatWires(): number[] {
    return DIGIT_WIRES.filter(
      (w) => bindingFor(this.state.bindings, w) === undefined,
    );
  }

  /** the queue without the bound agents (they render on their own keys) */
  private unboundRows(): string[] {
    return this.rowKeys().filter((k) => !this.isBoundAgent(k));
  }

  pageCount(): number {
    const per = this.seatWires().length;
    if (per === 0) return 1;
    return Math.max(1, Math.ceil(this.unboundRows().length / per));
  }

  /** which wire renders this key right now: its bound key, else its
      grid slot on the current page, else nowhere (paged out). */
  wireForKey(key: string): number | null {
    for (const wire of Object.keys(this.state.bindings.keys).map(Number)) {
      const held = bindingFor(this.state.bindings, wire);
      if (held?.agent === key) return wire;
    }
    const wires = this.seatWires();
    const idx = this.unboundRows().indexOf(key) - this.page * wires.length;
    if (idx >= 0 && idx < wires.length) return wires[idx];
    return null;
  }

  /** what a wire addresses right now: a need seat, a live session, or
      nothing. live entries carry no `seat` — tapping them focuses. */
  resolveWire(wire: number): { key: string; seat?: Seat } | undefined {
    const held = bindingFor(this.state.bindings, wire);
    if (held) {
      const seat = this.seatsCache.find((s) => s.key === held.agent);
      return { key: held.agent, ...(seat ? { seat } : {}) };
    }
    const wires = this.seatWires();
    const slot = wires.indexOf(wire);
    if (slot < 0) return undefined;
    const key = this.unboundRows()[this.page * wires.length + slot];
    if (key === undefined) return undefined;
    return { key, seat: this.seatsCache.find((s) => s.key === key) };
  }

  /** the glass's key badges: every seated session with the digit printed
      on its key. bound agents hold their key on every page; queue slots
      report `visible` against the page the board is showing, and a paged
      out entry still carries the digit it will land on after `.`. call
      after seats() — it reads the same caches the render does. */
  seatMap(): BoardSeatMap {
    const seats: BoardSeat[] = [];
    for (const wire of Object.keys(this.state.bindings.keys).map(Number)) {
      const held = bindingFor(this.state.bindings, wire);
      if (!held) continue;
      const digit = DIGIT_WIRES.indexOf(wire) + 1;
      if (digit > 0) seats.push({ key: held.agent, digit, visible: true });
    }
    const wires = this.seatWires();
    if (wires.length > 0) {
      for (const [i, key] of this.unboundRows().entries()) {
        const digit = DIGIT_WIRES.indexOf(wires[i % wires.length]) + 1;
        if (digit === 0) continue;
        seats.push({
          key,
          digit,
          visible: Math.floor(i / wires.length) === this.page,
        });
      }
    }
    return { seats, page: this.page, pages: this.pageCount() };
  }

  private isBoundAgent(key: string): boolean {
    for (const wire of Object.keys(this.state.bindings.keys).map(Number)) {
      if (bindingFor(this.state.bindings, wire)?.agent === key) return true;
    }
    return false;
  }
}

type Done = (verbName: string | null, target: string, ok: boolean) => void;

function wireOf(verb: VerbEvent): number {
  return "wire" in verb ? verb.wire : verb.wires[1];
}

function parseColor(hex: string | undefined): [number, number, number] {
  if (!hex) return [180, 122, 255];
  const m = hex.replace("#", "");
  if (m.length !== 6) return [180, 122, 255];
  return [
    Number.parseInt(m.slice(0, 2), 16),
    Number.parseInt(m.slice(2, 4), 16),
    Number.parseInt(m.slice(4, 6), 16),
  ];
}
