/* the worker's read of a whole transcript, apart from the worker so its rules are tests: it asks until it has the
   messages and the upstream seq they reflect, and gives up the moment the thread is no longer the one the read is for. */

import { type Cursor, type Message, parseCursor } from "./protocol";

export type Transcript = { messages: Message[]; at: Cursor; /** the body's length: the size the byte cap counts */ bytes: number };

/** why a try failed, for a stage that has nothing to show (docs/thread.md, reading): `gone` when the server answered that
    it does not have the thread (a 404), `problem` in the server's words when it said any, null when it did not answer */
export type ReadTrouble = { gone: boolean; problem: string | null };

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
  /** a try failed and the read waits to try again: what went wrong, said before the wait */
  failed(trouble: ReadTrouble): void;
};

/** an error body's own words: the server's `{ error: { message } }`, read only from a json answer, which is a few bytes;
    any other body (a proxy's page) is not downloaded */
async function problemOf(res: Response): Promise<string | null> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  const body: unknown = await res.json().catch(() => null);
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

/** a failed try in words: the server's when it gave any, else what it answered */
async function troubleOf(res: Response | null): Promise<ReadTrouble> {
  if (!res) return { gone: false, problem: null };
  if (res.status === 404) {
    void res.body?.cancel().catch(() => undefined);
    return { gone: true, problem: null };
  }
  if (res.ok) {
    void res.body?.cancel().catch(() => undefined);
    return { gone: false, problem: "the server sent something that is not this thread" };
  }
  return { gone: false, problem: (await problemOf(res)) ?? `the server answered ${res.status}` };
}

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
    failed try (no answer, an error status, no seq, a body that is not a transcript: a proxy's page) is said to `failed`, with a
    404 as `gone`, and tried again after the backoff's wait */
export async function readTranscript(plan: ReadPlan): Promise<Transcript | "signed-out" | null> {
  while (plan.wanted()) {
    const res = await plan.get(plan.path);
    if (!plan.wanted()) {
      void res?.body?.cancel().catch(() => undefined);
      return null;
    }
    if (res?.status === 401) {
      void res.body?.cancel().catch(() => undefined);
      return "signed-out";
    }
    const at = parseCursor(res?.headers.get("x-cmx2-seq"));
    let trouble: ReadTrouble;
    if (res?.ok && at) {
      const body = await res.text().catch(() => null);
      if (!plan.wanted()) return null;
      const messages = body === null ? null : parseMessages(body);
      if (messages) return { messages, at, bytes: body?.length ?? 0 };
      trouble = { gone: false, problem: "the server sent something that is not this thread" };
    } else {
      // an answer that is not a transcript (an error, or no seq to read it against) is not downloaded, past an error's own words
      trouble = await troubleOf(res);
      if (!plan.wanted()) return null;
    }
    plan.failed(trouble);
    await plan.wait(plan.nextDelay());
  }
  return null;
}
