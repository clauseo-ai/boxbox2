import { describe, expect, test } from "bun:test";
import { SseParser, type SseFrame } from "./sse";

const encoder = new TextEncoder();

function parseAll(chunks: Uint8Array[]): { frames: SseFrame[]; comments: number } {
  const parser = new SseParser();
  const frames = chunks.flatMap((chunk) => parser.push(chunk));
  return { frames, comments: parser.comments };
}

const STREAM = [
  'data: {"type":"hello","epoch":"e1","head":2}\n\n',
  ": hb\n\n",
  'id: e1:1\ndata: {"type":"order","seq":1,\ndata: "keys":[]}\n\n',
  'id: e1:2\r\ndata: {"type":"delta","text":"日本語 🙂"}\r\n\r\n',
].join("");

const EXPECTED: SseFrame[] = [
  { id: undefined, data: '{"type":"hello","epoch":"e1","head":2}' },
  { id: "e1:1", data: '{"type":"order","seq":1,\n"keys":[]}' },
  { id: "e1:2", data: '{"type":"delta","text":"日本語 🙂"}' },
];

describe("the sse parser", () => {
  test("reads ids, joined data lines, crlf lines and heartbeats", () => {
    const { frames, comments } = parseAll([encoder.encode(STREAM)]);
    expect(frames).toEqual(EXPECTED);
    expect(comments).toBe(1);
  });

  test("gives the same frames whatever byte the stream is split at", () => {
    const bytes = encoder.encode(STREAM);
    for (let at = 0; at <= bytes.length; at++) {
      const { frames } = parseAll([bytes.slice(0, at), bytes.slice(at)]);
      expect(frames).toEqual(EXPECTED);
    }
  });

  test("gives the same frames fed one byte at a time, multi-byte glyphs included", () => {
    const bytes = encoder.encode(STREAM);
    const { frames } = parseAll(Array.from(bytes, (b) => Uint8Array.of(b)));
    expect(frames).toEqual(EXPECTED);
  });

  test("dispatches nothing for a frame with no data, and holds an unfinished frame", () => {
    const parser = new SseParser();
    expect(parser.push(encoder.encode("id: e1:9\n\n"))).toEqual([]);
    expect(parser.push(encoder.encode("data: half"))).toEqual([]);
    expect(parser.push(encoder.encode("\n\n"))).toEqual([{ id: undefined, data: "half" }]);
  });
});
