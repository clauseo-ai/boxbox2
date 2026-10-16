import { describe, expect, test } from "bun:test";
import { flatPeaks, peaksFor, reducePeaks, toBytes } from "./peaks";

describe("reducePeaks", () => {
  test("each slice is the loudest bin it covers", () => {
    const bins = Array.from({ length: 640 }, (_, i) => (i % 10 === 3 ? 1 : 0.1));
    const out = reducePeaks(bins);
    expect(out.length).toBe(64);
    expect([...out].every((v) => v === 1)).toBe(true);
  });

  test("equal slices keep the clip's shape", () => {
    const bins = Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0.8 : 0.01));
    const out = reducePeaks(bins, 64);
    expect([...out.subarray(0, 31)].every((v) => Math.abs(v - 0.8) < 1e-6)).toBe(true);
    expect([...out.subarray(33)].every((v) => Math.abs(v - 0.01) < 1e-6)).toBe(true);
  });

  test("fewer bins than slices are stretched; none gives zeros", () => {
    expect([...reducePeaks([0.2, 1], 4)].map((v) => Math.round(v * 10))).toEqual([2, 2, 10, 10]);
    expect([...reducePeaks([], 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(reducePeaks(new Float32Array([1, 2, 3]), 3)).toEqual(new Float32Array([1, 2, 3]));
  });
});

describe("toBytes", () => {
  test("the loudest slice is 255 and silence stays 0", () => {
    expect([...toBytes([0, 0.5, 1, 0.25])]).toEqual([0, 128, 255, 64]);
  });
  test("under the floor reads as silence; above it never rounds to 0", () => {
    expect([...toBytes([1, 0.01, 0.021])]).toEqual([255, 0, 5]);
    expect([...toBytes([1, 0.003], 0)]).toEqual([255, 1]);
  });
  test("all quiet is flat", () => {
    expect([...toBytes([0, 0, 0])]).toEqual([0, 0, 0]);
    expect(flatPeaks()).toEqual(new Uint8Array(64));
  });
});

describe("peaksFor", () => {
  /* bun has Worker but no AudioDecoder, so the worker answers null ("no AudioDecoder"): the round trip, the
     de-duping and the remembered null are what this checks; the decode itself is checked in a browser */
  test("one fetch for concurrent asks, a null remembered, no second fetch", async () => {
    let fetched = 0;
    const fetchBytes = async (): Promise<ArrayBuffer> => {
      fetched++;
      return new ArrayBuffer(64);
    };
    const [a, b] = await Promise.all([peaksFor("n1", fetchBytes, 1500), peaksFor("n1", fetchBytes, 1500)]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetched).toBe(1);
    expect(await peaksFor("n1", fetchBytes)).toBeNull();
    expect(fetched).toBe(1);
  });

  test("a failed fetch is not remembered", async () => {
    let tries = 0;
    const failing = async (): Promise<ArrayBuffer> => {
      tries++;
      throw new Error("offline");
    };
    expect(await peaksFor("n2", failing)).toBeNull();
    expect(await peaksFor("n2", failing)).toBeNull();
    expect(tries).toBe(2);
  });
});
