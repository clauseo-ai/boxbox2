/* what a fork and a lineage link do once pressed (docs/thread.md, fork): the fork verb with its client id, history's adopt
   for a parent the fleet does not hold, and the wait for a thread to reach this device. loaded at the first press, never
   in the first load (architecture.md, the script budget): the stage keeps the state the controls show (forking, the
   notes) and asks this module for the rest. */

import { createEffect, createRoot } from "solid-js";
import { api } from "../../api/client";
import { deviceIdentity } from "../../sync/client";
import { cutKey, forkDone, forkId, settles, tabShelf } from "./fork-ids";

export { cutAfter } from "./fork-cut";

/** a fork made, or a parent adopted, that has not come on the stream within the wait */
export const FORK_NOT_HERE = "the fork was made and has not reached this device yet. it shows on home when it does.";
export const ADOPTED_NOT_HERE = "it was found, but has not reached this device yet. try again in a moment.";

const UNANSWERED = "the boxbox server is not answering. check it is running, then try again.";

/** a refusal in the server's words, else its status */
const refusal = (error: unknown, status: number): string => {
  const said = (error as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof said === "string" ? said : `the server answered ${status}. try again.`;
};

/** forks `threadKey` (`agent:thread`) through the server's fork verb (POST /api/agents/:agent/threads/:thread/fork, cmx2's
    /session/:id/fork), cut before `before` or whole. one client id per cut until its fork is made, so a retry, a reload or
    a second tap is the same fork (fork-ids.ts). answers the new thread's key, or what to say */
export async function forkThread(agent: string, threadKey: string, before: string | undefined): Promise<{ key: string } | { say: string }> {
  const cutAt = cutKey(threadKey, before);
  try {
    const { data: born, error, response } = await api.POST("/api/agents/{agent}/threads/{thread}/fork", {
      params: { path: { agent, thread: threadKey.slice(agent.length + 1) } },
      body: { ...deviceIdentity(), clientID: forkId(tabShelf, cutAt, () => crypto.randomUUID()), ...(before ? { before } : {}) },
    });
    if (settles(response.status)) forkDone(tabShelf, cutAt);
    if (!response.ok || !born) return { say: refusal(error, response.status) };
    return { key: born.key };
  } catch {
    return { say: UNANSWERED };
  }
}

/** asks history's adopt for a thread the fleet does not hold (cleared from home's twelve hours, or archived, which it
    answers is gone): null when it was taken, else what to say */
export async function adoptThread(agent: string, threadKey: string): Promise<string | null> {
  try {
    const { error, response } = await api.POST("/api/agents/{agent}/threads/{thread}/adopt", { params: { path: { agent, thread: threadKey.slice(agent.length + 1) } }, body: { ...deviceIdentity(), clientID: crypto.randomUUID() } });
    return response.ok ? null : refusal(error, response.status);
  } catch {
    return UNANSWERED;
  }
}

/** the waits for threads to reach this device: each answers true once `has` sees the thread, false after `ms` or when
    stopped (the stage went), its timer and its effect with it */
export function createArrivals(has: (key: string) => boolean, ms: number): { arrives: (key: string) => Promise<boolean>; stop: () => void } {
  const waiting = new Set<(arrived: boolean) => void>();
  let stopped = false;
  const arrives = (key: string): Promise<boolean> => new Promise((resolve) => {
    if (has(key)) return resolve(true);
    if (stopped) return resolve(false);
    createRoot((dispose) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const end = (arrived: boolean) => {
        if (!waiting.delete(end)) return;
        clearTimeout(timer);
        dispose();
        resolve(arrived);
      };
      waiting.add(end);
      timer = setTimeout(() => end(false), ms);
      createEffect(() => { if (has(key)) end(true); });
    });
  });
  return { arrives, stop: () => { stopped = true; for (const end of [...waiting]) end(false); } };
}
