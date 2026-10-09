/* the render loop: state → scene → FRAME diff at ≤60fps, PING whenever
   500ms passes with nothing else to say (4x margin on the firmware's 2s
   watchdog — a healthy quiet board must never dark itself), GLOBAL by
   hour. docs/scope-board.md §4's "rules that are not opcodes" live here. */

import { bindingFor } from "../../lib/board/contract";
import type { BoxboxClient } from "./client";
import type { BoardConfig } from "./config";
import type { Controller } from "./controller";
import type { BoardDevice } from "./device";
import type { Radio } from "./radio";
import type { FleetState } from "./state";
import {
  BREATH_SLOT, cell, DARK_FRAME, LIVE_BREATH_SLOT, RESERVED_RGB, SLOT, LEVEL,
  WIRE, type Cell,
} from "./protocol";
import {
  applyFloor, composite, deepWorkFilter, queueCells, renderDrive,
  renderFleet, renderPit, vuCells, type DriveModel,
} from "./scenes";

const FRAME_MS = 16;
const KEEPALIVE_MS = 500;
const BREATH_PERIOD_MS = 3400;
const LIVE_PERIOD_MS = 1800;
/** floor between writes per animated slot. the unthrottled loop pushed
    ~115 hid writes/s — including into a dark numpad whose firmware reads
    neither slot (19% cpu, 2026-07-27). a 3.4s breath at 25 updates/s is
    indistinguishable from 60 under a diffused cap. */
const ANIM_MIN_MS = 40;
/** the twin's cadence: frames only when changed, at most 5/s — a mirror
    across the tailnet, not a second render target */
const TWIN_MIN_MS = 200;
/** the seat map's cadence: recompute at 4hz (the seat memo's own grain),
    post on change plus a slow heartbeat so the glass can tell a quiet
    board from a dead daemon — badges expire on a stale stamp. */
const SEATS_CHECK_MS = 250;
const SEATS_HEARTBEAT_MS = 5000;

function rgbEq(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function hex([r, g, b]: [number, number, number]): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export class RenderLoop {
  private lastFrame: Cell[] = [...DARK_FRAME];
  private lastGlobalHour = -1;
  private lastBreathRgb: [number, number, number] = [0, 0, 0];
  private lastLiveRgb: [number, number, number] = [0, 0, 0];
  private lastBreathWriteAt = 0;
  private lastLiveWriteAt = 0;
  private lastTwinAt = 0;
  private twinDirty = true;
  private lastSeatsCheckAt = 0;
  private lastSeatsSentAt = 0;
  private lastSeatsJson = "";
  private stopped = false;
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private state: FleetState,
    private controller: Controller,
    private device: BoardDevice,
    private radio: Radio,
    private client: BoxboxClient,
    private cfg: BoardConfig,
  ) {}

  reconfigure(cfg: BoardConfig) {
    this.cfg = cfg;
    this.lastGlobalHour = -1; /* re-send GLOBAL from the new curve */
  }

  async run() {
    this.decayTimer = setInterval(() => this.state.decay(), 1000);
    this.decayTimer.unref?.();
    while (!this.stopped) {
      const started = Date.now();
      await this.frame(started);
      const elapsed = Date.now() - started;
      await new Promise((r) => setTimeout(r, Math.max(0, FRAME_MS - elapsed)));
    }
    if (this.decayTimer) clearInterval(this.decayTimer);
  }

  stop() {
    this.stopped = true;
  }

  private async frame(now: number) {
    if (!this.device.connected()) return;

    this.controller.tick(now);
    this.controller.observe(now);

    /* night: the GLOBAL byte follows the hour curve */
    const hour = new Date(now).getHours();
    if (hour !== this.lastGlobalHour) {
      this.lastGlobalHour = hour;
      await this.device.global(this.cfg.nightCurve[hour] ?? 255);
    }

    const cells = this.compose(now);

    /* the two animated slots: BREATH (the radio's violet float, slow)
       and LIVE_BREATH (lime working-pulse, faster — energy, not
       sleep). 8-bit palette space is smooth where 4-bit level space
       is a staircase. a write lands only when the face actually shows
       the slot, the quantized color moved, and ANIM_MIN_MS has passed —
       so a dark or calc board costs zero writes and the watchdog rides
       the 500ms PING instead. */
    if (now - this.lastBreathWriteAt >= ANIM_MIN_MS && usesSlot(cells, BREATH_SLOT)) {
      const phase = (now % BREATH_PERIOD_MS) / BREATH_PERIOD_MS;
      /* same deep perceptual curve as the live pulse ("constantly
         floating just feels cool", 2026-07-27) at the radio's own
         slower period: perceptual floor 0.30, squared into pwm. */
      const sweep = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
      const s = sweep * sweep;
      const you = RESERVED_RGB[SLOT.you];
      const breath: [number, number, number] = [
        Math.round(you[0] * s), Math.round(you[1] * s), Math.round(you[2] * s),
      ];
      if (!rgbEq(breath, this.lastBreathRgb)) {
        this.lastBreathRgb = breath;
        this.lastBreathWriteAt = now;
        await this.device.palette(BREATH_SLOT, breath);
      }
    }
    if (now - this.lastLiveWriteAt >= ANIM_MIN_MS && usesSlot(cells, LIVE_BREATH_SLOT)) {
      const livePhase = (now % LIVE_PERIOD_MS) / LIVE_PERIOD_MS;
      /* the sweep rides PERCEPTUAL space and squares into pwm — ws2812
         pwm is linear light, so the old 0.45 linear floor read as ~70%
         bright and the pulse barely moved ("should go way dimmer",
         2026-07-27). perceptual floor 0.30 → pwm floor ~0.09: a real
         dip, still unmistakably on. */
      const sweep = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * livePhase));
      const ls = sweep * sweep;
      const lime = RESERVED_RGB[SLOT.live];
      const liveBreath: [number, number, number] = [
        Math.round(lime[0] * ls), Math.round(lime[1] * ls), Math.round(lime[2] * ls),
      ];
      if (!rgbEq(liveBreath, this.lastLiveRgb)) {
        this.lastLiveRgb = liveBreath;
        this.lastLiveWriteAt = now;
        await this.device.palette(LIVE_BREATH_SLOT, liveBreath);
      }
    }

    if (!same(cells, this.lastFrame)) {
      this.lastFrame = cells;
      this.twinDirty = true;
      await this.device.frame(cells);
    } else if (this.device.msSinceWrite(now) >= KEEPALIVE_MS) {
      await this.device.ping();
    }

    /* the virtual twin: mirror the frame to the origin, throttled. the
       animated slots ride at full color — the twin breathes client-side
       (scope-board §7 C6). fire-and-forget: a dropped mirror frame is
       replaced by the next one. */
    if (this.twinDirty && now - this.lastTwinAt >= TWIN_MIN_MS) {
      this.twinDirty = false;
      this.lastTwinAt = now;
      void this.client.postFrame(this.lastFrame, this.paletteHex());
    }

    /* the seat map: which agent sits on which digit, for the glass's key
       badges (scope-board §7 C8). posts ride change plus the heartbeat;
       a dead daemon (or an unplugged board — frame() returned early)
       goes silent and the badges expire on the glass. */
    if (now - this.lastSeatsCheckAt >= SEATS_CHECK_MS) {
      this.lastSeatsCheckAt = now;
      const map = this.controller.seatMap();
      const encoded = JSON.stringify(map);
      if (
        encoded !== this.lastSeatsJson ||
        now - this.lastSeatsSentAt >= SEATS_HEARTBEAT_MS
      ) {
        this.lastSeatsJson = encoded;
        this.lastSeatsSentAt = now;
        void this.client.postSeats(map);
      }
    }
  }

  /** the palette as the twin should know it: reserved voices, current
      liveries, and the two animated slots at their full colors */
  private paletteHex(): string[] {
    const out = Array(16).fill("#000000");
    for (const [slot, rgb] of Object.entries(RESERVED_RGB)) {
      out[Number(slot)] = hex(rgb);
    }
    for (const l of this.controller.syncLiveries()) {
      out[l.slot] = hex(l.color);
    }
    out[LIVE_BREATH_SLOT] = hex(RESERVED_RGB[SLOT.live]);
    out[BREATH_SLOT] = hex(RESERVED_RGB[SLOT.you]);
    return out;
  }

  private compose(now: number): Cell[] {
    const c = this.controller;

    /* calc: the soul clause. the daemon sends nothing here, same as
       always, but the firmware now paints its own donor numpad pattern
       locally instead of leaving the leds dark. the daemon side of this
       is unchanged, only what the board does with the silence is new.
       the ONLY path that skips the floor: a numpad is a numpad. */
    if (c.calcMode) return [...DARK_FRAME];

    /* live overlays outrank banks: the voice meter while talking, the
       queue view while a seat is held */
    if (this.radio.meterActive()) {
      const base = [...DARK_FRAME];
      return applyFloor(composite(base, vuCells(this.radio.levels())));
    }
    if (c.heldSeat) {
      /* how many orders are parked behind the held seat, one lime key
         each; ent gold when a flush is armed. replaced the spend gauge
         2026-07-29 — zero seat-holds ever reached it, while the queue
         is the fact he acts on every day. */
      return applyFloor(queueCells(this.state.queueDepth(c.heldSeat.key)));
    }

    let base: Cell[];
    switch (c.bank) {
      case "pit": {
        const stage = c.pit;
        if (!stage) {
          base = [...DARK_FRAME];
          break;
        }
        base =
          stage.item.kind === "permission"
            ? renderPit({
                kind: "permission",
                hot: stage.seat.hot,
                rejectArmed: stage.rejectArmedUntil > now,
              })
            : renderPit({
                kind: "question",
                options: questionCount(stage.item),
              });
        break;
      }
      case "fleet": {
        const columns = this.cfg.machineOrder.map((h) => this.state.hostActivity(h));
        base = renderFleet({
          columns,
          odometer: this.state.spend.totalUsd / this.cfg.spendLineUsd,
        });
        break;
      }
      default:
        base = renderDrive(this.driveModel(now));
    }

    /* queue blinks: the working key flashes its depth every ~3s, riding
       on top of the drive base */
    if (c.bank === "drive") base = this.applyQueueBlinks(base, now);

    const overlay = c.transients.current(now, c.deepWork);
    let out = composite(base, overlay);
    if (c.deepWork) out = deepWorkFilter(out);
    /* the floor goes down LAST: deep work suppresses signals, not power.
       arrival gaps and the gantry blackout dip to the floor, never to
       black — the instrument is on. */
    return applyFloor(out);
  }

  private driveModel(now: number): DriveModel {
    const c = this.controller;
    const seats = c.seats(now);
    const bound = c.syncLiveries().map(({ wire, slot }) => {
      const held = bindingFor(this.state.bindings, wire);
      const seat = held ? seats.find((s) => s.key === held.agent) : undefined;
      const session = held ? this.state.session(held.agent) : undefined;
      const busy =
        session !== undefined &&
        this.state.seatInput().status[session.host]?.[session.sessionID] !== undefined;
      return {
        wire,
        slot,
        seat,
        working: busy,
        deltaFresh: held ? this.state.deltaAge(held.agent, now) < 2000 : false,
      };
    });
    const unbound = seats.filter(
      (s) => !bound.some((b) => b.seat?.key === s.key),
    );
    return {
      bound,
      hotSeats: unbound,
      liveSeats: c.liveSeats().map((seat) => ({
        seat,
        deltaFresh: this.state.deltaAge(seat.key, now) < 2000,
      })),
      page: c.page,
      machines: this.cfg.machineOrder.map((id) => ({
        reachable: this.state.hosts.find((h) => h.id === id)?.reachable ?? false,
      })),
      copyArmed: seats.length > 0,
    };
  }

  private applyQueueBlinks(base: Cell[], now: number): Cell[] {
    const queued = this.state.queuedSeats();
    if (queued.length === 0) return base;
    const out = [...base];
    for (const q of queued) {
      const wire = this.controller.wireForKey(q.key);
      if (wire === null) continue;
      /* a 3.2s cycle: `depth` short flashes then rest */
      const phase = now % 3200;
      const flash = Math.floor(phase / 220);
      if (flash < q.depth * 2 && flash % 2 === 0) {
        out[wire] = cell(SLOT.live, LEVEL.hot);
      }
    }
    return out;
  }
}

function questionCount(item: { raw: unknown }): number {
  const raw = item.raw as { questions?: { options?: unknown[] }[] } | undefined;
  const qs = raw?.questions ?? [];
  if (qs.length !== 1) return 0;
  return Math.min(9, qs[0].options?.length ?? 0);
}

function same(a: Cell[], b: Cell[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** does any cell on the face reference this palette slot? */
function usesSlot(cells: readonly Cell[], slot: number): boolean {
  for (const c of cells) if (c >> 4 === slot) return true;
  return false;
}

