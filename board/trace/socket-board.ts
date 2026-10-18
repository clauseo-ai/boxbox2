/* the fake board on a unix socket, for the native daemon's seam
   (`BOXBOX_BOARD_HID=unix:<path>`, docs/board.md, the harness's seams).

   firmware.ts stays the pure state machine; this is its transport. the
   socket file exists only while the board is plugged in: plugging listens
   at the path, the daemon connects, and unplugging closes the connection
   and removes the file. each direction carries fixed 32-byte frames, with
   no length prefix and no report id: host writes are the protocol's 32
   bytes, opcode first, and board reports are the firmware's 32 bytes.

   the timing rules are preload.ts's, so a native daemon meets the same
   board v1's did: a report goes out 1ms after the write that caused it
   (a real board answers over its own endpoint, never inside the write), the
   hello ack after 40ms (docs/gotchas.md, the board trace harness), and the
   watchdog runs every 50ms against the firmware's 2000ms rule.

   records keep v1's shape: a host write is recorded with report id 0 in
   front, as node-hid carried it, so the normalizer reads both the same. */

import type { Socket, UnixSocketListener } from "bun";
import { rmSync } from "node:fs";
import { FakeFirmware, REPORT_LEN } from "./firmware";
import type { Record } from "./records";

export const REPORT_MS = 1;
export const HELLO_ACK_MS = 40;
const WATCHDOG_TICK_MS = 50;

export type SocketBoardOptions = {
  path: string;
  onRecord: (record: Record) => void;
  /** injectable for tests */
  now?: () => number;
};

type Conn = Socket<undefined>;

export class SocketBoard {
  private readonly firmware: FakeFirmware;
  private listener: UnixSocketListener<undefined> | null = null;
  private conn: Conn | null = null;
  private pending = new Uint8Array(0);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private readonly options: SocketBoardOptions) {
    this.now = options.now ?? Date.now;
    this.firmware = new FakeFirmware((bytes) => this.report(bytes));
    this.watchdog = setInterval(() => this.firmware.housekeeping(this.now()), WATCHDOG_TICK_MS);
  }

  get plugged(): boolean {
    return this.listener !== null;
  }

  get connected(): boolean {
    return this.conn !== null;
  }

  /** the board goes in: the socket appears and the daemon may connect */
  plug() {
    if (this.listener) return;
    rmSync(this.options.path, { force: true });
    this.listener = Bun.listen<undefined>({
      unix: this.options.path,
      socket: {
        open: (socket) => {
          /* one host at a time, as one usb device has one owner */
          if (this.conn) {
            socket.end();
            return;
          }
          this.conn = socket;
          this.pending = new Uint8Array(0);
        },
        data: (socket, data) => {
          if (socket !== this.conn) return;
          this.receive(data);
        },
        close: (socket) => {
          if (socket === this.conn) this.conn = null;
        },
        error: (socket) => {
          if (socket === this.conn) this.conn = null;
        },
      },
    });
  }

  /** the board comes out: the connection closes and the socket goes */
  unplug() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.conn?.end();
    this.conn = null;
    this.listener?.stop(true);
    this.listener = null;
    rmSync(this.options.path, { force: true });
  }

  /** a switch moved under a finger */
  press(wire: number, down: boolean) {
    const t = this.now();
    this.options.onRecord({ ch: "key", t, wire, down });
    this.firmware.press(wire, down, t);
  }

  stop() {
    this.unplug();
    clearInterval(this.watchdog);
  }

  private receive(data: Uint8Array) {
    const joined = new Uint8Array(this.pending.length + data.length);
    joined.set(this.pending);
    joined.set(data, this.pending.length);
    let at = 0;
    while (joined.length - at >= REPORT_LEN) {
      const frame = [...joined.subarray(at, at + REPORT_LEN)];
      at += REPORT_LEN;
      const t = this.now();
      const write = [0, ...frame];
      this.options.onRecord({ ch: "hid", t, bytes: write });
      this.firmware.receive(write, t);
    }
    this.pending = joined.slice(at);
  }

  private report(bytes: number[]) {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        /* a report with no host on the other end is lost, as on usb */
        if (!this.conn) return;
        this.options.onRecord({ ch: "board", t: this.now(), bytes });
        this.conn.write(new Uint8Array(bytes));
      },
      bytes[0] === 0x81 ? HELLO_ACK_MS : REPORT_MS,
    );
    this.timers.add(timer);
  }
}
