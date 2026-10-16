import { describe, expect, test } from "bun:test";
import { barOf, bitrateOf, byteCap, cancelLine, dragOf, LOCK_LINE, leftMs, MAX_BYTES, MAX_MS, PeakBins, pickKind, releaseOf, takes } from "./recorder-model";

describe("what to record in", () => {
  const chrome = (m: string) => m.startsWith("audio/webm");
  const safari = (m: string) => m.startsWith("audio/mp4");
  const newChrome = (m: string) => m.startsWith("audio/webm") || m.startsWith("audio/mp4");
  const firefox = (m: string) => m.startsWith("audio/ogg") || m.startsWith("audio/webm");
  test("aac in mp4 where the recorder offers it, else opus in webm, else ogg (agents.md, the upload)", () => {
    expect(pickKind(safari, ["audio/*"])).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickKind(newChrome, ["audio/*"])).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickKind(chrome, ["audio/*"])).toBe("audio/webm;codecs=opus");
    expect(pickKind((m) => m.startsWith("audio/ogg"), ["audio/*"])).toBe("audio/ogg;codecs=opus");
    expect(pickKind(firefox, ["audio/*"])).toBe("audio/webm;codecs=opus");
  });
  test("a kind the agent does not take is skipped, and with none left the mic is not offered", () => {
    expect(pickKind(newChrome, ["audio/webm"])).toBe("audio/webm;codecs=opus");
    expect(pickKind(chrome, ["image/png", "application/pdf"])).toBeNull();
    expect(takes(["audio/*"], "audio/mp4;codecs=mp4a.40.2")).toBe(true);
    expect(takes(["image/*"], "audio/mp4")).toBe(false);
  });
});

describe("the encoder's rate", () => {
  test("aac at 64 kbps (chromium refuses 32), opus at 32", () => {
    expect(bitrateOf("audio/mp4;codecs=mp4a.40.2")).toBe(64_000);
    expect(bitrateOf("audio/webm;codecs=opus")).toBe(32_000);
  });
});

describe("the caps", () => {
  test("12 mb, or the agent's maxBytes when less", () => {
    expect(byteCap(undefined)).toBe(MAX_BYTES);
    expect(byteCap(20 * 1024 * 1024)).toBe(MAX_BYTES);
    expect(byteCap(5_000_000)).toBe(5_000_000);
  });
  test("time left is the nearer of the time cap and the byte cap at the rate so far", () => {
    expect(leftMs(0, 0, MAX_BYTES)).toBe(MAX_MS);
    // 4 kb a second against a 400 kb cap, 10 s in: 90 s left
    expect(Math.round(leftMs(10_000, 40_000, 400_000))).toBe(90_000);
    expect(leftMs(MAX_MS - 30_000, 1000, MAX_BYTES)).toBe(30_000);
  });
});

describe("the gestures", () => {
  test("the cancel line is 120 px, or a third of the composer, whichever is less", () => {
    expect(cancelLine(600)).toBe(120);
    expect(cancelLine(300)).toBe(100);
  });
  test("a release past the cancel line cancels, past the lock line locks, early is a tap, else it sends", () => {
    expect(releaseOf(-130, 0, 2000, 600)).toBe("cancel");
    expect(releaseOf(0, LOCK_LINE, 2000, 600)).toBe("lock");
    expect(releaseOf(-20, 10, 400, 600)).toBe("too-short");
    expect(releaseOf(-20, 10, 1200, 600)).toBe("send");
  });
  test("the finger goes one way at a time: the leading axis takes it", () => {
    expect(dragOf(-60, 10, 600)).toEqual({ slide: 0.5, lock: 0 });
    expect(dragOf(-10, 36, 600)).toEqual({ slide: 0, lock: 0.5 });
    expect(dragOf(-500, 0, 600).slide).toBe(1);
  });
});

describe("the note's peaks, reduced as it records", () => {
  test("a loud first half and a quiet second come out as such, the loudest at 255", () => {
    const bins = new PeakBins();
    for (let i = 0; i < 300; i++) bins.push(i < 150 ? 0.8 : 0.02);
    const p = bins.peaks();
    expect(p).toHaveLength(64);
    expect(Math.max(...p)).toBe(255);
    expect(p.slice(0, 30).every((v) => v === 255)).toBe(true);
    expect(p.slice(34).every((v) => v < 60)).toBe(true);
  });
  test("however long the note, the memory is fixed and every slice still lands in order", () => {
    const bins = new PeakBins();
    // 15 minutes of 100 ms slices, a loud blip a third of the way in
    const n = 9000;
    for (let i = 0; i < n; i++) bins.push(i === 3000 ? 1 : 0.01);
    const p = bins.peaks();
    const at = p.indexOf(255);
    expect(at).toBeGreaterThanOrEqual(19);
    expect(at).toBeLessThanOrEqual(23);
  });
  test("a short note is spread over the 64, and silence is all zeros", () => {
    const bins = new PeakBins();
    for (let i = 0; i < 8; i++) bins.push(i % 2 ? 0.5 : 0.1);
    expect(bins.peaks()).toHaveLength(64);
    expect(new PeakBins().peaks().every((v) => v === 0)).toBe(true);
    expect(barOf(1)).toBe(255);
    expect(barOf(0)).toBe(0);
  });
});
