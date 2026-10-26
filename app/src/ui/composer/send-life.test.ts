import { describe, expect, test } from "bun:test";
import type { OutboxView } from "../../sync/outbox";
import { blockedWords, bornKey, makingWords, orphanOf, refusedOf, SLOW_MS, slowIn } from "./send-life";

const SENT = { clientID: "c1", at: 1_000, host: "mini", directory: "/w/ledger" };

function entry(clientID: string, state: OutboxView["state"], extra: Partial<OutboxView> = {}): OutboxView {
  return {
    clientID,
    verb: "start",
    target: { kind: "new", host: "mini", directory: "/w/ledger", place: "checkout" },
    key: "new:mini:/w/ledger",
    text: "fix the invoice tests",
    photos: 0,
    files: 0,
    photoBytes: 0,
    model: null,
    effort: null,
    state,
    provisional: null,
    session: null,
    error: state === "failed" ? "nothing at /w/ledger on mini" : null,
    attempts: 1,
    at: 1_000,
    ackAt: null,
    unsending: false,
    ...extra,
  };
}

describe("the thread a send made", () => {
  test("is the one born of its client id, once the fleet holds it", () => {
    expect(bornKey(SENT, { c1: "mini:ses_new" }, { "mini:ses_new": {} })).toBe("mini:ses_new");
    // named, but not in the fleet yet: the field keeps waiting
    expect(bornKey(SENT, { c1: "mini:ses_new" }, {})).toBeNull();
  });

  test("is never a thread that merely appeared, or one another send made", () => {
    expect(bornKey(SENT, { c2: "mini:ses_other" }, { "mini:ses_other": {}, "mini:ses_stray": {} })).toBeNull();
    expect(bornKey(null, { c1: "mini:ses_new" }, { "mini:ses_new": {} })).toBeNull();
  });
});

describe("a refused send", () => {
  test("is the send's own entry, failed", () => {
    expect(refusedOf(SENT, [entry("c1", "failed")])?.clientID).toBe("c1");
    expect(refusedOf(SENT, [entry("c1", "sending")])).toBeUndefined();
    expect(refusedOf(SENT, [entry("c2", "failed")])).toBeUndefined();
    expect(refusedOf(null, [entry("c1", "failed")])).toBeUndefined();
  });

  test("nobody holds (an orphan) is a failed start that is not this field's send and was not given back yet", () => {
    const outbox = [entry("c1", "failed"), entry("c9", "sending"), entry("c3", "failed", { verb: "prompt", target: { kind: "session", host: "mini", session: "ses_x", directory: "/w/ledger" } }), entry("c4", "failed")];
    expect(orphanOf(outbox, "c1", [])?.clientID).toBe("c4");
    expect(orphanOf(outbox, "c1", ["c4"])).toBeUndefined();
    expect(orphanOf(outbox, null, [])?.clientID).toBe("c1");
  });
});

describe("why a send cannot go yet", () => {
  const base = { refused: false, making: false, drafted: true, host: "mini", directory: "/w/ledger" };

  test("a refusal waits for retry or edit", () => {
    expect(blockedWords({ ...base, refused: true })).toBe("retry or edit the message below first.");
  });

  test("one thread is made at a time: words typed meanwhile wait, and nothing is said until there are some", () => {
    expect(blockedWords({ ...base, making: true })).toBe("one thread at a time. this one can start once the first is open.");
    expect(blockedWords({ ...base, making: true, drafted: false })).toBeUndefined();
  });

  test("no machine, or no folder, says so; with both it can go", () => {
    expect(blockedWords({ ...base, host: "" })).toBe("no machine is connected yet. add one from agents.");
    expect(blockedWords({ ...base, directory: null })).toBe("pick a repo or a folder on mini to start in");
    expect(blockedWords(base)).toBeUndefined();
  });
});

describe("the words while the thread is being made", () => {
  test("say where, then that the machine is slow, or that the connection is down", () => {
    const at = { sent: SENT, host: "desk", directory: "/w/other", waiting: false, slow: false };
    expect(makingWords(at)).toBe("making the thread in ledger on mini.");
    expect(makingWords({ ...at, slow: true })).toBe("still making the thread in ledger. the machine is slow to answer; it opens when it is there.");
    expect(makingWords({ ...at, waiting: true })).toBe("the connection is down. the thread starts on its own when it is back.");
  });

  test("slow is counted from when the send went, so a field mounted again says it at the same moment", () => {
    expect(slowIn(1_000, 1_000)).toBe(SLOW_MS);
    expect(slowIn(1_000, 1_000 + SLOW_MS - 10)).toBe(10);
    expect(slowIn(1_000, 1_000 + SLOW_MS + 500)).toBe(0);
  });
});
