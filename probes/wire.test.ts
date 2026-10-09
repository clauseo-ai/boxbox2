import { describe, expect, test } from "bun:test";
import { findValue, landedAsks, parseCursor, parseFrames } from "./wire";

describe("parseFrames", () => {
  test("splits complete frames and keeps the unfinished tail for the next chunk", () => {
    const { frames, rest } = parseFrames('id: e:1\ndata: {"a":1}\n\ndata: {"b"');
    expect(frames).toEqual([{ raw: 'id: e:1\ndata: {"a":1}', id: "e:1", event: undefined, data: '{"a":1}' }]);
    expect(rest).toBe('data: {"b"');
  });

  test("reads crlf line ends, comments, event names and multi-line data", () => {
    const { frames } = parseFrames(": keepalive\r\nevent: note\r\ndata: one\r\ndata: two\r\n\r\n");
    expect(frames[0]?.event).toBe("note");
    expect(frames[0]?.data).toBe("one\ntwo");
    expect(frames[0]?.id).toBeUndefined();
  });

  test("a frame without an id line has no id, which a1 treats as unsequenced", () => {
    expect(parseFrames('data: {"type":"server.heartbeat"}\n\n').frames[0]?.id).toBeUndefined();
  });
});

describe("parseCursor", () => {
  test("reads <epoch>:<seq>", () => {
    expect(parseCursor("ep_7f3a:42")).toEqual({ epoch: "ep_7f3a", seq: 42 });
  });

  test("refuses anything that is not one epoch and one integer seq", () => {
    for (const id of [undefined, "", "42", "ep:", ":42", "ep:4.2", "ep:-1", "a:b:1", "ep 1:2", "ep:99999999999999999999"]) {
      expect(parseCursor(id)).toBeUndefined();
    }
  });
});

describe("landedAsks", () => {
  const table = [
    "| # | ask | owner | shape |",
    "|---|---|---|---|",
    "| a1 | durable event sequence | m6, landed at abc1234 | a seq |",
    "| a2 | reads carry the seq | m6 | the header; landed only with a1 |",
    "| a3 | bounded sse buffers | Landed | a cap |",
    "| a4 | client ids | m6, not landed | ids |",
    "| a13 | something new | unassigned | shape |",
  ].join("\n");

  test("an ask is landed when its owner cell says landed, never from the shape's prose", () => {
    expect([...landedAsks(table)].sort()).toEqual(["a1", "a3"]);
  });

  test("a missing ASKS.md means nothing has landed", () => {
    expect(landedAsks(undefined).size).toBe(0);
  });
});

describe("findValue", () => {
  test("names where a value sits in an event's properties", () => {
    expect(findValue({ sessionID: "s", info: { id: "m", clientID: "c-1" } }, "c-1")).toBe("info.clientID");
    expect(findValue({ a: [1, { b: "c-1" }] }, "c-1")).toBe("a.1.b");
    expect(findValue({ a: "other" }, "c-1")).toBeUndefined();
  });
});
