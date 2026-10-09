import { describe, expect, test } from "bun:test";
import { clickTarget, parsePayload, readLink, tapName } from "./payload";

/** a payload exactly as server/src/push/payload.rs writes one for an ask */
const ask = {
  v: 1,
  id: "ask:que_1",
  kind: "ask",
  need: "question",
  tag: "thread:desk:ses_1",
  thread: "desk:ses_1",
  ask: "que_1",
  title: "ledger wants you",
  body: "which greeting?",
  url: "/?thread=desk:ses_1&ask=que_1&push=ask:que_1",
  actions: [
    { action: "answer", title: "answer", url: "/?thread=desk:ses_1&ask=que_1&push=ask:que_1" },
    { action: "open", title: "open", url: "/?thread=desk:ses_1&push=ask:que_1" },
  ],
  device: "d1",
  deviceClass: "mac",
  sentAt: 1_790_000_000_000,
  badge: 2,
};

describe("the push payload", () => {
  test("a server payload parses whole", () => {
    expect(parsePayload(ask) as unknown).toEqual(ask);
  });

  test("a payload from a newer server, or a broken one, is refused rather than guessed at", () => {
    expect(parsePayload({ ...ask, v: 2 })).toBeNull();
    expect(parsePayload({ ...ask, kind: "gossip" })).toBeNull();
    expect(parsePayload({ ...ask, title: 3 })).toBeNull();
    expect(parsePayload({ ...ask, actions: [{ action: "delete", title: "x", url: "/" }] })).toBeNull();
    expect(parsePayload(null)).toBeNull();
  });

  test("links only ever point inside the app", () => {
    expect(parsePayload({ ...ask, url: "https://elsewhere.example/" })).toBeNull();
    expect(parsePayload({ ...ask, url: "//elsewhere.example/" })).toBeNull();
    const outward = [{ action: "open", title: "open", url: "https://elsewhere.example/" }];
    expect(parsePayload({ ...ask, actions: outward })).toBeNull();
  });
});

describe("a click", () => {
  const payload = parsePayload(ask);
  if (!payload) throw new Error("the fixture parses");

  test("answer focuses the ask, open opens the thread", () => {
    expect(clickTarget(payload, "answer")).toBe("/?thread=desk:ses_1&ask=que_1&push=ask:que_1");
    expect(clickTarget(payload, "open")).toBe("/?thread=desk:ses_1&push=ask:que_1");
  });

  test("a plain tap, the only kind ios has, lands where the banner points", () => {
    expect(clickTarget(payload, "")).toBe(payload.url);
    expect(tapName("")).toBe("banner");
    expect(tapName("answer")).toBe("answer");
  });
});

describe("a deep link", () => {
  test("names a thread and maybe an ask", () => {
    expect(readLink("?thread=desk:ses_1&ask=que_1&push=ask:que_1")).toEqual({
      thread: "desk:ses_1",
      ask: "que_1",
      push: "ask:que_1",
    });
    expect(readLink("?thread=vm:ses_2")).toEqual({ thread: "vm:ses_2", ask: null, push: null });
  });

  test("that does not parse as host:session is ignored", () => {
    expect(readLink("")).toBeNull();
    expect(readLink("?thread=Desk:ses")).toBeNull();
    expect(readLink("?thread=desk")).toBeNull();
    expect(readLink("?thread=desk:ses/../x")).toBeNull();
  });
});
