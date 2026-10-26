/* the life of a first message, as pure rules (docs/composer.md, a first message does not close on a guess): which thread
   it made, whether it was refused, which refused send nobody holds any more, why another cannot go yet, and the words the
   field says while it waits. new-thread.ts reads the store through these, so send-life.test.ts is the whole story of
   the send's decisions. */

import type { OutboxView } from "../../sync/outbox";
import { repoName } from "../window/repo";

/** how long a send waits for its thread before it says it is taking long (it keeps waiting) */
export const SLOW_MS = 8000;

/** the send in flight as the store holds it (store.ts, `NewSent`) */
export type Sending = { clientID: string; at: number; host: string; directory: string };

/** the thread this send made, once the fleet holds it: named by the worker from the server's answer to this client id
    (or from its echo). never a thread that merely appeared on the machine meanwhile: another phone's, a subagent's */
export function bornKey(sent: Sending | null, born: Readonly<Record<string, string>>, threads: Readonly<Record<string, unknown>>): string | null {
  if (!sent) return null;
  const key = born[sent.clientID];
  return key !== undefined && threads[key] !== undefined ? key : null;
}

/** the send's outbox entry while it is refused */
export function refusedOf(sent: Sending | null, outbox: readonly OutboxView[]): OutboxView | undefined {
  if (!sent) return undefined;
  const entry = outbox.find((e) => e.clientID === sent.clientID);
  return entry?.state === "failed" ? entry : undefined;
}

/** a first message refused after its field let go of it (a reload, another tab): the first such entry that is not this
    field's own send and whose words have not gone back yet */
export function orphanOf(outbox: readonly OutboxView[], sentID: string | null, restored: readonly string[]): OutboxView | undefined {
  return outbox.find((e) => e.verb === "start" && e.state === "failed" && e.target.kind === "new" && e.clientID !== sentID && !restored.includes(e.clientID));
}

/** why a send cannot go yet, or undefined when it can; the words are kept whatever it says */
export function blockedWords(at: { refused: boolean; making: boolean; drafted: boolean; host: string; directory: string | null }): string | undefined {
  if (at.refused) return "retry or edit the message below first.";
  // one thread is made at a time: words typed meanwhile wait for the first to open
  if (at.making) return at.drafted ? "one thread at a time. this one can start once the first is open." : undefined;
  if (!at.host) return "no machine is connected yet. add one from agents.";
  return at.directory ? undefined : `pick a repo or a folder on ${at.host} to start in`;
}

/** what the field says while the thread is being made: where, then that the machine is slow, or that the connection is down */
export function makingWords(at: { sent: Sending | null; host: string; directory: string | null; waiting: boolean; slow: boolean }): string {
  const repo = repoName(at.sent?.directory ?? at.directory ?? "");
  if (at.waiting) return "the connection is down. the thread starts on its own when it is back.";
  if (at.slow) return `still making the thread in ${repo}. the machine is slow to answer; it opens when it is there.`;
  return `making the thread in ${repo} on ${at.sent?.host ?? at.host}.`;
}

/** how long until a send that went at `at` is slow, from `now`: 0 when it already is (a field mounted again mid-send) */
export function slowIn(at: number, now: number): number {
  return Math.max(0, at + SLOW_MS - now);
}
