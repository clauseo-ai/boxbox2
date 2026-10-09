import { describe, expect, test } from "bun:test";
import { outcomeOf } from "./outcome";

const refused = (status: number, error?: unknown) => ({ response: { ok: false, status }, ...(error === undefined ? {} : { error }) });

describe("what came of an answer", () => {
  test("an answer the daemon took is ok", () => {
    expect(outcomeOf({ response: { ok: true, status: 200 } })).toEqual({ ok: true });
  });

  test("an answer that lost the race says who answered first and when, and offers no retry", () => {
    const at = new Date(2026, 9, 1, 23, 49).getTime();
    const out = outcomeOf(refused(409, { error: { code: "settled", message: "already answered", settled: { by: "iphone", at } } }));
    expect(out).toEqual({ ok: false, problem: "answered on iphone at 23:49", settled: { by: "iphone", at } });
  });

  test("a loss with nothing said of the winner still says it was answered, and not by whom", () => {
    const out = outcomeOf(refused(409, { error: { code: "settled", message: "x" } }));
    expect(out).toMatchObject({ ok: false, problem: "answered on another device", settled: { by: null, at: null } });
  });

  test("the server's placeholder for a winner the daemon did not name is no device named", () => {
    // server/src/http/asks.rs fills a missing `by` with "someone"
    const at = new Date(2026, 9, 1, 23, 49).getTime();
    const out = outcomeOf(refused(409, { error: { code: "settled", message: "x", settled: { by: "someone", at } } }));
    expect(out).toEqual({ ok: false, problem: "answered on another device at 23:49", settled: { by: null, at } });
  });

  test("an ask that is gone says so, and offers no retry", () => {
    const out = outcomeOf(refused(404, { error: { code: "gone", message: "gone" } }));
    expect(out).toEqual({ ok: false, problem: "this is gone: it was answered, or its turn ended.", gone: true });
  });

  test("a 409 or a 404 that is not the ask's own is not read as one: it is a refusal to try again", () => {
    // a message sent twice (cmx2's BusyError) is 409 `already-sent`; a host or a session boxbox does not know is 404
    expect(outcomeOf(refused(409, { error: { code: "already-sent", message: "that message was already sent" } }))).toEqual({ ok: false, problem: "not sent: that message was already sent. tap to try again." });
    expect(outcomeOf(refused(404, { error: { code: "unknown-host", message: "no host is called that" } }))).toEqual({ ok: false, problem: "not sent: no host is called that. tap to try again." });
    expect(outcomeOf(refused(404, { error: { code: "no-such-session", message: "that thread is not here" } }))).toEqual({ ok: false, problem: "not sent: that thread is not here. tap to try again." });
  });

  test("a refusal that says nothing of what it is reads by its status alone, as a refusal to try again", () => {
    expect(outcomeOf(refused(409))).toEqual({ ok: false, problem: "not sent: the server answered 409. tap to try again." });
    expect(outcomeOf(refused(404))).toEqual({ ok: false, problem: "not sent: the server answered 404. tap to try again." });
  });

  test("any other refusal keeps the choice and says to try again, in the server's words", () => {
    expect(outcomeOf(refused(502, { error: { code: "host-said", message: "the host did not answer" } }))).toEqual({ ok: false, problem: "not sent: the host did not answer. tap to try again." });
    expect(outcomeOf(refused(500))).toEqual({ ok: false, problem: "not sent: the server answered 500. tap to try again." });
  });
});
