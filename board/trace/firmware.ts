/* the fake board: the mf17's boxbox keymap (fw 5, protocol v1) as a pure
   state machine, so a board daemon can run against it with no hardware.

   it models what the daemon can observe through the raw hid endpoint and
   nothing else: the hello ack, key reports, the calc escape, the watchdog
   and the mode echo, with the firmware's own rules (the keymap's
   raw_hid_receive, process_record_user and housekeeping_task_user):

     - any host report is proof of life, handled before its payload;
     - layer = (user_calc || !host_present) ? calc : drive, re-applied on
       every change, and echoed unconditionally;
     - a double tap on nl flips calc locally, and the triggering press is
       never reported;
     - on the calc layer nothing is reported at all;
     - 2000ms with no host report and the watchdog drops to calc.

   the firmware's escape windows are fw-clock values pre-scaled for the
   mf17's fast clock; the wall-clock figures below are the ones its
   comments give. time is injected, so the tests own it. */

export const REPORT_LEN = 32;
export const KEY_COUNT = 17;
export const FW_VERSION = 5;
export const PROTO_VERSION = 1;

export const OP = {
  hello: 0x01,
  palette: 0x02,
  frame: 0x03,
  global: 0x04,
  ping: 0x05,
  mode: 0x06,
  helloAck: 0x81,
  key: 0x82,
  modeEcho: 0x83,
} as const;

export const LAYER = { drive: 0, calc: 1 } as const;
export const REASON = { host: 0, local: 1, watchdog: 2 } as const;

/** the mode key, wire 0 */
export const WIRE_NL = 0;
const CALC_DOUBLE_MS = 293;
const CALC_TAP_MS = 350;
export const WATCHDOG_MS = 2000;

/** what the board shows: the frame, palette and global scale it holds */
export type BoardFace = {
  layer: number;
  frame: number[];
  palette: [number, number, number][];
  global: number;
};

export class FakeFirmware {
  private hostPresent = false;
  private userCalc = false;
  private layer: number = LAYER.calc;
  private lastHostReport = 0;
  private nlDownAt = 0;
  private nlTapArmed = false;
  private nlTapUpAt = 0;
  private nlDoubleSpent = false;
  private frame: number[] = Array<number>(KEY_COUNT).fill(0);
  private palette: [number, number, number][] = Array.from({ length: 16 }, (): [number, number, number] => [0, 0, 0]);
  private global = 255;

  /** @param send a board to host report, 32 bytes, opcode first */
  constructor(private readonly send: (report: number[]) => void) {}

  face(): BoardFace {
    return { layer: this.layer, frame: [...this.frame], palette: this.palette.map((c) => [...c]), global: this.global };
  }

  /** a host to board write as node-hid carries it: report id 0, then the report */
  receive(write: readonly number[], now: number) {
    const data = write.slice(1);
    const op = data[0];
    if (op === undefined) return;
    this.noteHostReport(now);
    switch (op) {
      case OP.hello:
        this.send(report(OP.helloAck, [FW_VERSION, PROTO_VERSION, this.layer]));
        break;
      case OP.palette:
        if (data.length >= 5) this.palette[(data[1] ?? 0) & 0x0f] = [data[2] ?? 0, data[3] ?? 0, data[4] ?? 0];
        break;
      case OP.frame:
        if (data.length >= 1 + KEY_COUNT) this.frame = data.slice(1, 1 + KEY_COUNT);
        break;
      case OP.global:
        if (data.length >= 2) this.global = data[1] ?? 255;
        break;
      case OP.mode:
        if (data.length >= 2) {
          this.userCalc = data[1] === LAYER.calc;
          this.applyMode(REASON.host);
        }
        break;
      default:
        break;
    }
  }

  /** a switch moved under a finger */
  press(wire: number, down: boolean, now: number) {
    if (wire === WIRE_NL) {
      if (down) {
        const double = this.nlTapArmed && now - this.nlTapUpAt <= CALC_DOUBLE_MS;
        this.nlTapArmed = false;
        this.nlDownAt = now;
        this.nlDoubleSpent = double;
        if (double) {
          this.userCalc = !this.userCalc;
          this.applyMode(REASON.local);
          return;
        }
      } else {
        this.nlTapArmed = !this.nlDoubleSpent && now - this.nlDownAt < CALC_TAP_MS;
        this.nlTapUpAt = now;
        this.nlDoubleSpent = false;
      }
    }
    if (this.layer !== LAYER.drive) return;
    this.send(report(OP.key, [wire, down ? 0 : 1]));
  }

  /** the main loop's housekeeping: the watchdog */
  housekeeping(now: number) {
    if (!this.hostPresent || now - this.lastHostReport < WATCHDOG_MS) return;
    this.hostPresent = false;
    this.applyMode(REASON.watchdog);
  }

  private noteHostReport(now: number) {
    this.lastHostReport = now;
    if (this.hostPresent) return;
    this.hostPresent = true;
    this.applyMode(REASON.host);
  }

  private applyMode(reason: number) {
    const want = this.userCalc || !this.hostPresent ? LAYER.calc : LAYER.drive;
    if (this.layer !== want && want === LAYER.calc) this.frame = Array<number>(KEY_COUNT).fill(0);
    this.layer = want;
    this.send(report(OP.modeEcho, [want, reason]));
  }
}

export function report(op: number, payload: number[]): number[] {
  return [op, ...payload, ...Array<number>(REPORT_LEN - 1 - payload.length).fill(0)];
}
