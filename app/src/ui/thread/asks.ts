/* answering an ask in place (docs/thread.md, every state: asks). each
   reply carries a clientID minted once per ask and action and kept for a
   retry, so a flaky network cannot answer twice (cmx2-asks a4). the send
   is honest: the card shows the reply as sent only when the daemon took it,
   and `perf.send` is stamped when the ask leaves the fleet's list, never
   from the local call. a reply the daemon took, or one that lost the race
   to another device, leaves this device's record of it (sync/replies.ts),
   which the settled row reads for who answered and when. */

import { api } from "../../api/client";
import { deviceIdentity, emit, keepReply } from "../../sync/client";
import { type Replied, replyOf } from "../../sync/replies";
import { state } from "../../store";
import { type AskOutcome, outcomeOf } from "./outcome";
import type { AskActions } from "./thread";

const UNREACHABLE = "not sent. the server is not answering; tap to try again.";

/** replies in flight or sent and not yet settled, by ask id, for the perf row */
export const replies = new Map<string, { verb: "reply"; startedAt: number; retries: number }>();
const clientIDs = new Map<string, string>();

function clientIdFor(askID: string, action: string): string {
  const key = `${askID}:${action}`;
  let id = clientIDs.get(key);
  if (!id) {
    id = crypto.randomUUID();
    clientIDs.set(key, id);
  }
  return id;
}

type Answer = { response: Response; error?: unknown };

function begin(askID: string): void {
  const held = replies.get(askID);
  if (held) held.retries++;
  else replies.set(askID, { verb: "reply", startedAt: performance.now(), retries: 0 });
  if (import.meta.env.DEV) console.debug("ask reply begins", askID, replies.get(askID));
}

function failed(askID: string): void {
  const held = replies.get(askID);
  if (!held) return;
  replies.delete(askID);
  emit("perf.send", { verb: "reply", retries: held.retries }, { ok: false, ms: Math.round(performance.now() - held.startedAt), surface: "thread" });
}

/** the ask left the fleet's list: the reply landed. called by the stage when it sees the ask go. */
export function settled(askID: string, session: string): void {
  const held = replies.get(askID);
  if (import.meta.env.DEV) console.debug("ask settled", askID, held ?? "(no reply of ours)");
  if (!held) return;
  replies.delete(askID);
  emit("perf.send", { verb: "reply", retries: held.retries }, { ok: true, ms: Math.round(performance.now() - held.startedAt), surface: "thread", session });
}

async function call(host: string, askID: string, replied: Replied, send: () => Promise<Answer>): Promise<AskOutcome> {
  begin(askID);
  /* the ask as the fleet holds it now: it leaves the list once settled, perhaps before the answer is back */
  const ask = state.fleet.asks[`${host}:${askID}`];
  try {
    const outcome = outcomeOf(await send());
    const record = replyOf(ask, replied, outcome, Date.now());
    if (record) keepReply(record);
    if (!outcome.ok && !outcome.settled) failed(askID);
    if (!outcome.ok && outcome.settled) replies.delete(askID);
    return outcome;
  } catch {
    failed(askID);
    return { ok: false, problem: UNREACHABLE };
  }
}

export function askActions(host: () => string): AskActions {
  const path = (askID: string) => ({ params: { path: { host: host(), ask: askID } } });
  return {
    answer: (askID, answers) => call(host(), askID, { k: "answers", answers }, () => api.POST("/api/hosts/{host}/questions/{ask}", { ...path(askID), body: { ...deviceIdentity(), clientID: clientIdFor(askID, "answer"), answers } })),
    reject: (askID) => call(host(), askID, { k: "dismissed" }, () => api.POST("/api/hosts/{host}/questions/{ask}/reject", { ...path(askID), body: { ...deviceIdentity(), clientID: clientIdFor(askID, "reject") } })),
    permit: (askID, reply, message) => call(host(), askID, { k: "permit", reply, ...(message ? { message } : {}) }, () => api.POST("/api/hosts/{host}/permissions/{ask}", { ...path(askID), body: { ...deviceIdentity(), clientID: clientIdFor(askID, reply), reply, message: message ?? null } })),
  };
}
