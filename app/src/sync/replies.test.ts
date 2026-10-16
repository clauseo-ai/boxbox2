/* this device's records of its replies to asks (replies.ts): made only for a reply the daemon settled, kept under the thread and
   the tool call, at most the cap with the oldest gone first, and read back from the cache in the order they were settled */

import { describe, expect, test } from "bun:test";
import { type AskReply, keepReply, REPLY_CAP, replyKey, replyOf, restoreReplies } from "./replies";

const ask = { id: "per_1", key: "desk:ses_a", kind: "permission" as const, request: { permission: "edit", tool: { messageID: "m", callID: "call_1" } } };
const record = (callID: string, at: number | null, thread = "desk:ses_a"): AskReply => ({ thread, callID, askID: `a_${callID}`, kind: "permission", reply: { k: "permit", reply: "once" }, who: { here: true }, at });

describe("a reply's record", () => {
  test("a reply the daemon took is this device's, at the moment it was taken", () => {
    expect(replyOf(ask, { k: "permit", reply: "reject", message: "not now" }, { ok: true }, 42)).toEqual({ thread: "desk:ses_a", callID: "call_1", askID: "per_1", kind: "permission", reply: { k: "permit", reply: "reject", message: "not now" }, who: { here: true }, at: 42 });
  });

  test("a reply that lost the race names the device that answered first, and its time", () => {
    const r = replyOf({ ...ask, kind: "question" }, { k: "answers", answers: [["hi"]] }, { ok: false, settled: { by: "ipad", at: 7 } }, 42);
    expect(r?.who).toEqual({ by: "ipad" });
    expect(r?.at).toBe(7);
  });

  test("a reply that failed, an ask that went, or an ask on no tool call keeps nothing", () => {
    expect(replyOf(ask, { k: "dismissed" }, { ok: false }, 42)).toBeNull();
    expect(replyOf(undefined, { k: "dismissed" }, { ok: true }, 42)).toBeNull();
    expect(replyOf({ ...ask, request: {} }, { k: "dismissed" }, { ok: true }, 42)).toBeNull();
    expect(replyOf({ ...ask, request: { tool: { callID: "" } } }, { k: "dismissed" }, { ok: true }, 42)).toBeNull();
  });
});

describe("the book", () => {
  test("a record replaces an earlier one for the same call and goes to the end", () => {
    let book = keepReply({}, record("a", 1)).book;
    book = keepReply(book, record("b", 2)).book;
    const again = { ...record("a", 3), reply: { k: "permit" as const, reply: "always" as const } };
    const kept = keepReply(book, again);
    expect(Object.keys(kept.book)).toEqual([replyKey("desk:ses_a", "b"), replyKey("desk:ses_a", "a")]);
    expect(kept.book[replyKey("desk:ses_a", "a")]).toBe(again);
    expect(kept.dropped).toEqual([]);
  });

  test("past the cap the oldest go first, and are named so the cache lets them go", () => {
    let book: Record<string, AskReply> = {};
    for (let i = 0; i < REPLY_CAP; i++) book = keepReply(book, record(`c${i}`, i)).book;
    const kept = keepReply(book, record("new", 999));
    expect(Object.keys(kept.book)).toHaveLength(REPLY_CAP);
    expect(kept.dropped).toEqual([replyKey("desk:ses_a", "c0")]);
    expect(kept.book[replyKey("desk:ses_a", "new")]).toBeDefined();
  });

  test("the same call in another thread is another record", () => {
    const book = keepReply(keepReply({}, record("a", 1)).book, record("a", 2, "desk:ses_b")).book;
    expect(Object.keys(book)).toHaveLength(2);
  });

  test("read back, the records are ordered by when they were settled, capped, and what does not read as a record is dropped", () => {
    const { book, dropped } = restoreReplies([record("late", 30), { junk: true }, record("early", 10), null, record("unknown", null), { ...record("bad", 5), who: "me" }], 2);
    expect(Object.keys(book)).toEqual([replyKey("desk:ses_a", "early"), replyKey("desk:ses_a", "late")]);
    expect(dropped).toEqual([replyKey("desk:ses_a", "unknown")]);
  });
});
