/* compacting a thread (docs/composer.md, the plus menu): the daemon summarises the thread so far and answers once the summary
   is in, which can take tens of seconds. where it stands lives in the store by session key, so the composer says "compacting"
   again if the stage is left and come back to, and a refusal stays until it is dismissed or retried. */

import { api } from "../../api/client";
import { deviceClass, deviceId } from "../../push/device";
import { setCompaction, state } from "../../store";
import { said, UNREACHABLE } from "../machines/said";

/** the host bounds the wait at 300 s (server/src/http/compose.rs); the page gives it a little longer to say so itself */
const WAIT_MS = 330_000;
/** "compacted" stays this long, then goes: it is a receipt, not a state */
const DONE_SHOWN_MS = 4000;

/** compacts the thread on the model it already uses. one at a time per thread */
export async function compactThread(host: string, session: string): Promise<void> {
  const key = `${host}:${session}`;
  if (state.composer.compacting[key]?.state === "running") return;
  setCompaction(key, { state: "running", since: Date.now() });
  const failed = (message: string) => setCompaction(key, { state: "failed", message });
  try {
    const { response, error } = await api.POST("/api/hosts/{host}/sessions/{session}/compact", {
      params: { path: { host, session } },
      body: { device: deviceId(), deviceClass: deviceClass(), clientID: crypto.randomUUID() },
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!response.ok) return failed(said(error, response.status));
    const at = Date.now();
    setCompaction(key, { state: "done", at });
    // only this receipt goes: a compaction that finished and began again inside the four seconds has a card of its own
    setTimeout(() => {
      const now = state.composer.compacting[key];
      if (now?.state === "done" && now.at === at) setCompaction(key, null);
    }, DONE_SHOWN_MS);
  } catch (error) {
    // the page gave up before the host did: that is a slow summary, not a server that is not there
    failed(error instanceof DOMException && error.name === "TimeoutError" ? "no answer in five minutes. it may still be working: look at the thread before you try again" : UNREACHABLE);
  }
}
