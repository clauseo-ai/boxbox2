import { describe, expect, test } from "bun:test";
import {
  cell, DARK_FRAME, frameReport, globalReport, helloReport, KEY_COUNT,
  LEVEL, modeReport, OP_FRAME, OP_GLOBAL, OP_HELLO, OP_HELLO_ACK, OP_KEY,
  OP_MODE, OP_MODE_ECHO, OP_PALETTE, OP_PING, paletteReport,
  parseBoardReport, pingReport, REPORT_LEN, SLOT, WIRE, WIRE_NAMES,
} from "../src/protocol";

describe("outbound reports", () => {
  test("every report is exactly 1 report-id byte + 32 data bytes", () => {
    for (const r of [
      helloReport(),
      paletteReport(1, [180, 122, 255]),
      frameReport(DARK_FRAME),
      globalReport(128),
      pingReport(),
      modeReport(true),
    ]) {
      expect(r.length).toBe(1 + REPORT_LEN);
      expect(r[0]).toBe(0);
    }
  });

  test("frame golden: slot and level pack as palette<<4 | level", () => {
    const cells = [...DARK_FRAME];
    cells[WIRE.k5] = cell(SLOT.permHot, LEVEL.hot);
    cells[WIRE.k0] = cell(SLOT.you, LEVEL.idle);
    const r = frameReport(cells);
    expect(r[1]).toBe(OP_FRAME);
    expect(r[2 + WIRE.k5]).toBe((5 << 4) | 15);
    expect(r[2 + WIRE.k0]).toBe((1 << 4) | 3);
    /* dark keys are 0x00, off slot at off level */
    expect(r[2 + WIRE.div]).toBe(0);
  });

  test("frame refuses the wrong cell count", () => {
    expect(() => frameReport([1, 2, 3])).toThrow();
  });

  test("palette golden", () => {
    const r = paletteReport(6, [255, 59, 48]);
    expect(r.slice(1, 6)).toEqual([OP_PALETTE, 6, 255, 59, 48]);
  });

  test("global clamps", () => {
    expect(globalReport(9000)[2]).toBe(255);
    expect(globalReport(-4)[2]).toBe(0);
  });

  test("opcodes are the spec's table, both directions", () => {
    expect([OP_HELLO, OP_PALETTE, OP_FRAME, OP_GLOBAL, OP_PING, OP_MODE]).toEqual([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    ]);
    expect([OP_HELLO_ACK, OP_KEY, OP_MODE_ECHO]).toEqual([0x81, 0x82, 0x83]);
  });
});

describe("inbound reports", () => {
  test("hello ack carries fw, proto and the boot mode", () => {
    expect(parseBoardReport(new Uint8Array([0x81, 1, 1, 1]))).toEqual({
      kind: "hello", fw: 1, proto: 1, mode: 1,
    });
  });

  test("key report: 0 is down, 1 is up", () => {
    expect(parseBoardReport(new Uint8Array([0x82, 15, 0]))).toEqual({
      kind: "key", wire: 15, down: true,
    });
    expect(parseBoardReport(new Uint8Array([0x82, 0, 1]))).toEqual({
      kind: "key", wire: 0, down: false,
    });
  });

  test("mode echo reasons: host, local, watchdog", () => {
    expect(parseBoardReport(new Uint8Array([0x83, 1, 2]))).toEqual({
      kind: "mode", mode: 1, reason: "watchdog",
    });
  });

  test("unknown ops surface instead of vanishing", () => {
    expect(parseBoardReport(new Uint8Array([0x7f]))).toEqual({
      kind: "unknown", op: 0x7f,
    });
  });
});

describe("geometry", () => {
  test("seventeen wires, named in sim order", () => {
    expect(WIRE_NAMES.length).toBe(KEY_COUNT);
    expect(WIRE_NAMES[0]).toBe("nl");
    expect(WIRE_NAMES[15]).toBe("k0");
    expect(WIRE.dot).toBe(16);
  });
});
