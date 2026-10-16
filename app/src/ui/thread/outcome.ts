/* what came of an answer to an ask, in terms the card can say (docs/design.md, the ask card). pure, so it is tested without a
   browser: asks.ts reads the response and hands it here. an answer that lost the race says who answered first and when, with
   nothing to retry; one for an ask that is gone says so, with nothing to retry; any other failure keeps the choice and says to
   tap to try again. */

import { goneLine, settledLine } from "../asks/words";

export type AskOutcome =
  | { ok: true }
  | { ok: false; problem: string; settled?: { by: string | null; at: number | null }; /** the ask is no longer there to answer */ gone?: true };

/** what boxbox's server writes for the device when the daemon did not say who answered (server/src/http/asks.rs): a placeholder, not
    a device, so the words treat it as no device named */
export const NOBODY = "someone";

/** what an answer's response says: boxbox's refusal in words (server/src/http/error.rs), and who settled the ask first. it reads the
    refusal's `code`, which is stable, and not the status, which other refusals share: a 409 `already-sent` is a message sent twice,
    and a 404 `unknown-host` or `no-such-session` is not an ask that went */
export function outcomeOf(a: { response: { ok: boolean; status: number }; error?: unknown }): AskOutcome {
  if (a.response.ok) return { ok: true };
  const body = (a.error ?? {}) as Record<string, unknown>;
  const error = body["error"] as Record<string, unknown> | undefined;
  const code = typeof error?.["code"] === "string" ? error["code"] : "";
  if (code === "settled") {
    const settled = error?.["settled"] as Record<string, unknown> | undefined;
    const by = typeof settled?.["by"] === "string" && settled["by"] !== NOBODY ? settled["by"] : null;
    const at = typeof settled?.["at"] === "number" ? settled["at"] : null;
    return { ok: false, problem: settledLine(by ?? "another device", at), settled: { by, at } };
  }
  if (code === "gone") return { ok: false, problem: goneLine(), gone: true };
  const message = (typeof error?.["message"] === "string" && error["message"]) || `the server answered ${a.response.status}`;
  return { ok: false, problem: `not sent: ${message}. tap to try again.` };
}
