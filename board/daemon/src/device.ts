/* the hid transport: find the board, keep it found, speak protocol v1.
   hotplug is a 2s poll while disconnected; selection is vid/pid/usagePage,
   NEVER product string or path (paths do not survive a replug). the bench
   tools (bench/hello.ts) proved this exact surface against the hardware
   before this file existed. */

import HID from "node-hid";
import {
  frameReport, globalReport, helloReport, KEY_COUNT, modeReport,
  paletteReport, parseBoardReport, pingReport, type BoardMessage, type Cell,
} from "./protocol";
import type { Logger } from "./log";

const VID = 0x3a54;
const PID = 0x4f5d;
const USAGE_PAGE = 0xff60;
const RESCAN_MS = 2000;

/** HIDAsync's constructor is private; its instance type comes off open() */
type HidDevice = Awaited<ReturnType<typeof HID.HIDAsync.open>>;

export type DeviceEvents = {
  onConnect: (fw: number, proto: number, mode: number) => void;
  onKey: (wire: number, down: boolean, at: number) => void;
  onMode: (mode: number, reason: "host" | "local" | "watchdog") => void;
  onDisconnect: () => void;
};

export class BoardDevice {
  private dev: HidDevice | null = null;
  private stopped = false;
  private lastWriteAt = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private events: DeviceEvents,
    private log: Logger,
  ) {}

  connected(): boolean {
    return this.dev !== null;
  }

  msSinceWrite(now: number): number {
    return now - this.lastWriteAt;
  }

  async start() {
    while (!this.stopped) {
      if (!this.dev) await this.tryOpen();
      await new Promise((r) => setTimeout(r, RESCAN_MS));
    }
  }

  stop() {
    this.stopped = true;
    void this.close("stopped");
  }

  private async tryOpen() {
    try {
      const all = await HID.devicesAsync();
      const found = all.find(
        (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE,
      );
      if (!found?.path) return;

      const dev = await HID.HIDAsync.open(found.path);
      this.dev = dev;
      dev.on("data", (buf: Buffer) => this.onReport(parseBoardReport(buf)));
      dev.on("error", (e: Error) => {
        this.log.warn("hid.error", { message: e.message });
        void this.close("hid error");
      });

      await this.write(helloReport());
      /* if HELLO goes unanswered the firmware is wrong or ancient —
         drop and rescan rather than driving blind */
      this.helloTimer = setTimeout(() => {
        this.log.warn("hid.hello_timeout", {});
        void this.close("hello timeout");
      }, 2000);
      this.log.info("hid.opened", { path: found.path });
    } catch (e) {
      this.log.warn("hid.open_failed", { message: String(e) });
      this.dev = null;
    }
  }

  private onReport(msg: BoardMessage) {
    switch (msg.kind) {
      case "hello":
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.events.onConnect(msg.fw, msg.proto, msg.mode);
        break;
      case "key":
        this.events.onKey(msg.wire, msg.down, Date.now());
        break;
      case "mode":
        this.events.onMode(msg.mode, msg.reason);
        break;
      case "unknown":
        this.log.warn("hid.unknown_op", { op: msg.op });
        break;
    }
  }

  private async close(why: string) {
    const dev = this.dev;
    this.dev = null;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    if (dev) {
      try {
        await dev.close();
      } catch {
        /* already gone */
      }
      this.log.info("hid.closed", { why });
      this.events.onDisconnect();
    }
  }

  private async write(report: number[]): Promise<boolean> {
    const dev = this.dev;
    if (!dev) return false;
    try {
      await dev.write(report);
      this.lastWriteAt = Date.now();
      return true;
    } catch (e) {
      this.log.warn("hid.write_failed", { message: String(e) });
      void this.close("write failed");
      return false;
    }
  }

  async frame(cells: readonly Cell[]) {
    if (cells.length !== KEY_COUNT) return;
    await this.write(frameReport(cells));
  }

  async palette(slot: number, rgb: [number, number, number]) {
    await this.write(paletteReport(slot, rgb));
  }

  async global(scale: number) {
    await this.write(globalReport(scale));
  }

  async ping() {
    await this.write(pingReport());
  }

  async mode(calc: boolean) {
    await this.write(modeReport(calc));
  }
}
