/* the fake board is only worth its traces if it behaves like the keymap:
   these pin the rules board/trace/firmware.ts carries from the mf17's
   boxbox keymap (fw 5), with the clock in the test's hands. */

import { describe, expect, test } from "bun:test";
import { FakeFirmware, KEY_COUNT, LAYER, OP, REASON, WATCHDOG_MS, WIRE_NL } from "../trace/firmware";

function board() {
  const sent: number[][] = [];
  const firmware = new FakeFirmware((report) => sent.push(report));
  return { firmware, sent, ops: () => sent.map((r) => r.slice(0, 3)) };
}

const hostWrite = (op: number, ...payload: number[]) => [0, op, ...payload];

describe("the fake board", () => {
  test("boots as a numpad and moves to drive on the first host report, echoing before the hello ack", () => {
    const { firmware, ops } = board();
    expect(firmware.face().layer).toBe(LAYER.calc);
    firmware.receive(hostWrite(OP.hello, 1), 0);
    expect(ops()).toEqual([
      [OP.modeEcho, LAYER.drive, REASON.host],
      [OP.helloAck, 5, 1],
    ]);
    expect(firmware.face().layer).toBe(LAYER.drive);
  });

  test("reports a key as down then up, by wire index", () => {
    const { firmware, sent } = board();
    firmware.receive(hostWrite(OP.hello, 1), 0);
    sent.length = 0;
    firmware.press(11, true, 10);
    firmware.press(11, false, 80);
    expect(sent.map((r) => r.slice(0, 3))).toEqual([
      [OP.key, 11, 0],
      [OP.key, 11, 1],
    ]);
    expect(sent.every((r) => r.length === 32)).toBe(true);
  });

  test("a double tap on nl flips to calc locally, and the second press is never reported", () => {
    const { firmware, ops, sent } = board();
    firmware.receive(hostWrite(OP.hello, 1), 0);
    sent.length = 0;
    firmware.press(WIRE_NL, true, 1000);
    firmware.press(WIRE_NL, false, 1070);
    firmware.press(WIRE_NL, true, 1180);
    firmware.press(WIRE_NL, false, 1250);
    expect(ops()).toEqual([
      [OP.key, WIRE_NL, 0],
      [OP.key, WIRE_NL, 1],
      [OP.modeEcho, LAYER.calc, REASON.local],
    ]);
    expect(firmware.face().frame).toEqual(Array(KEY_COUNT).fill(0));
  });

  test("on the calc layer nothing is reported, and the double tap back reports only the release", () => {
    const { firmware, ops, sent } = board();
    firmware.receive(hostWrite(OP.hello, 1), 0);
    for (const [down, at] of [[true, 0], [false, 70], [true, 180], [false, 250]] as const) firmware.press(WIRE_NL, down, 1000 + at);
    sent.length = 0;
    firmware.press(11, true, 3000);
    firmware.press(11, false, 3070);
    expect(sent).toEqual([]);
    for (const [down, at] of [[true, 0], [false, 70], [true, 180], [false, 250]] as const) firmware.press(WIRE_NL, down, 5000 + at);
    expect(ops()).toEqual([
      [OP.modeEcho, LAYER.drive, REASON.local],
      [OP.key, WIRE_NL, 1],
    ]);
  });

  test("a slow second nl press is two taps, not a double", () => {
    const { firmware, ops, sent } = board();
    firmware.receive(hostWrite(OP.hello, 1), 0);
    sent.length = 0;
    firmware.press(WIRE_NL, true, 1000);
    firmware.press(WIRE_NL, false, 1070);
    firmware.press(WIRE_NL, true, 1400);
    firmware.press(WIRE_NL, false, 1470);
    expect(ops().every((r) => r[0] === OP.key)).toBe(true);
    expect(firmware.face().layer).toBe(LAYER.drive);
  });

  test("the watchdog drops to calc after 2000ms of silence, and the next host report brings drive back", () => {
    const { firmware, ops, sent } = board();
    firmware.receive(hostWrite(OP.hello, 1), 0);
    sent.length = 0;
    firmware.housekeeping(WATCHDOG_MS - 1);
    expect(sent).toEqual([]);
    firmware.housekeeping(WATCHDOG_MS);
    firmware.receive(hostWrite(OP.ping), WATCHDOG_MS + 10);
    expect(ops()).toEqual([
      [OP.modeEcho, LAYER.calc, REASON.watchdog],
      [OP.modeEcho, LAYER.drive, REASON.host],
    ]);
  });

  test("holds the frame, palette and global scale it is sent", () => {
    const { firmware } = board();
    const cells = Array.from({ length: KEY_COUNT }, (_, i) => i);
    firmware.receive(hostWrite(OP.hello, 1), 0);
    firmware.receive(hostWrite(OP.frame, ...cells), 1);
    firmware.receive(hostWrite(OP.palette, 7, 180, 255, 0), 2);
    firmware.receive(hostWrite(OP.global, 60), 3);
    const face = firmware.face();
    expect(face.frame).toEqual(cells);
    expect(face.palette[7]).toEqual([180, 255, 0]);
    expect(face.global).toBe(60);
  });

  test("MODE from the host is a deliberate calc that survives, echoed every time", () => {
    const { firmware, ops, sent } = board();
    firmware.receive(hostWrite(OP.hello, 1), 0);
    sent.length = 0;
    firmware.receive(hostWrite(OP.mode, 1), 5);
    firmware.receive(hostWrite(OP.mode, 1), 6);
    expect(ops()).toEqual([
      [OP.modeEcho, LAYER.calc, REASON.host],
      [OP.modeEcho, LAYER.calc, REASON.host],
    ]);
  });
});
