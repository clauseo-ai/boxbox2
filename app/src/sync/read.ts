/* the worker's read of a whole transcript, apart from the worker so its rules are tests: it asks until it has the
   messages and the upstream seq they reflect, and gives up the moment the thread is no longer the one the read is for. */

import { type Cursor, type Message, parseCursor } from "./protocol";

export type Transcript = { messages: Message[]; at: Cursor; /** the body's length: the size the byte cap counts */ bytes: number };

export type ReadPlan = {
  path: string;
  /** one request; null when it never got an answer (the network, an abort) */
  get(path: string): Promise<Response | null>;
  /** false once the thread this read is for is gone or has been read again since (evicted and held again, a reset):
      nothing more is downloaded or parsed for it */
  wanted(): boolean;
  /** a pause between tries, in ms from the backoff */
  wait(ms: number): Promise<void>;
  nextDelay(): number;
};

/** a transcript from a body, or null when the body is not a list of messages */
export function parseMessages(body: string): Message[] | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? (parsed as Message[]) : null;
  } catch {
    return null;
  }
}

/** the transcript, `"signed-out"` when the server says the session ended, or null when the read is no longer wanted. a
    failed try (no answer, an error status, no seq, a body that is not a transcript: a proxy's page) is tried again after
    the backoff's wait */
export async function readTranscript(plan: ReadPlan): Promise<Transcript | "signed-out" | null> {
  while (plan.wanted()) {
    const res = await plan.get(plan.path);
    if (!plan.wanted()) {
      void res?.body?.cancel().catch(() => undefined);
      return null;
    }
    const at = parseCursor(res?.headers.get("x-cmx2-seq"));
    if (res?.ok && at) {
      const body = await res.text().catch(() => null);
      if (!plan.wanted()) return null;
      const messages = body === null ? null : parseMessages(body);
      if (messages) return { messages, at, bytes: body?.length ?? 0 };
    } else {
      // an answer that is not a transcript (an error, or no seq to read it against) is not downloaded either
      void res?.body?.cancel().catch(() => undefined);
    }
    if (res?.status === 401) return "signed-out";
    await plan.wait(plan.nextDelay());
  }
  return null;
}
