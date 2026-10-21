/* the worker's read of a whole transcript (docs/protocol.md, thread reads), apart from the worker so its rules are tests: it
   asks until it has the messages, the journal head the read started at and the source event they reflect, and gives up the
   moment the thread is no longer the one the read is for. */

import { type Cursor, type Message, parseCursor } from "./protocol";

/** an answer. `messages` null is a 304: the read the client holds (the etag it sent) is still the thread, and stands as this
    read. `seq` is `x-boxbox-seq`, the journal head when the server started the read (the no-gap rule); `at` is
    `x-boxbox-upstream`, the source event it reflects (the upstream gate); `etag` its version, when the server gave one */
export type Transcript = { messages: Message[] | null; at: Cursor; seq: Cursor; /** the body's length: the size the byte cap counts */ bytes: number; etag?: string };

/** why a try failed, for a stage that has nothing to show (docs/thread.md, reading): `gone` when the server answered that
    it does not have the thread (a 404), `problem` in the server's words when it said any, null when it did not answer */
export type ReadTrouble = { gone: boolean; problem: string | null };

export type ReadPlan = {
  path: string;
  /** the etag of the read the client holds, sent as `If-None-Match`; absent when it holds none (a server without versions
      never gives one, and every read is then whole) */
  etag?: string | undefined;
  /** one request with these headers; null when it never got an answer (the network, an abort) */
  get(path: string, headers: Record<string, string>): Promise<Response | null>;
  /** false once the thread this read is for is gone or has been read again since (evicted and held again, a reset):
      nothing more is downloaded or parsed for it */
  wanted(): boolean;
  /** a pause between tries, in ms from the backoff */
  wait(ms: number): Promise<void>;
  nextDelay(): number;
  /** a try failed and the read waits to try again: what went wrong, said before the wait */
  failed(trouble: ReadTrouble): void;
  /** the epoch of the stream the read is for, null before its hello. an answer stamped with another epoch (the server's
      journal started over) is not taken: `otherEpoch` hears of it (the stream reconnects, and its reset reads the thread
      again), and the read waits its backoff and asks again, saying nothing on the thread */
  epoch?(): string | null;
  otherEpoch?(): void;
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
  if (res.ok || res.status === 304) {
    void res.body?.cancel().catch(() => undefined);
    return { gone: false, problem: "the server sent something that is not this thread" };
  }
  return { gone: false, problem: (await problemOf(res)) ?? `the server answered ${res.status}` };
}

/** a transcript from a body (`{messages, older, total, turns}`, the messages oldest first), or null when the body is not one */
export function parseMessages(body: string): Message[] | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { messages?: unknown }).messages : undefined;
    return Array.isArray(messages) ? (messages as Message[]) : null;
  } catch {
    return null;
  }
}

/** the transcript, `"signed-out"` when the server says the session ended, or null when the read is no longer wanted. a
    failed try (no answer, an error status, no seq or upstream stamp, a body that is not a transcript: a proxy's page) is
    said to `failed`, with a 404 as `gone`, and tried again after the backoff's wait. a 304 stands only for a read that sent
    an etag */
export async function readTranscript(plan: ReadPlan): Promise<Transcript | "signed-out" | null> {
  while (plan.wanted()) {
    const res = await plan.get(plan.path, plan.etag ? { "if-none-match": plan.etag } : {});
    if (!plan.wanted()) {
      void res?.body?.cancel().catch(() => undefined);
      return null;
    }
    if (res?.status === 401) {
      void res.body?.cancel().catch(() => undefined);
      return "signed-out";
    }
    const seq = parseCursor(res?.headers.get("x-boxbox-seq"));
    const at = parseCursor(res?.headers.get("x-boxbox-upstream"));
    const unchanged = res?.status === 304 && plan.etag !== undefined;
    const answered = res !== null && (res.ok || unchanged) && seq !== null && at !== null;
    const epoch = plan.epoch?.() ?? null;
    if (answered && epoch !== null && seq.epoch !== epoch) {
      void res.body?.cancel().catch(() => undefined);
      plan.otherEpoch?.();
      await plan.wait(plan.nextDelay());
      continue;
    }
    let trouble: ReadTrouble;
    if (answered && unchanged) {
      void res.body?.cancel().catch(() => undefined);
      const etag = res.headers.get("etag") ?? plan.etag;
      return { messages: null, at, seq, bytes: 0, ...(etag ? { etag } : {}) };
    }
    if (answered) {
      const body = await res.text().catch(() => null);
      if (!plan.wanted()) return null;
      const messages = body === null ? null : parseMessages(body);
      const etag = res.headers.get("etag");
      if (messages) return { messages, at, seq, bytes: body?.length ?? 0, ...(etag ? { etag } : {}) };
      trouble = { gone: false, problem: "the server sent something that is not this thread" };
    } else {
      // an answer that is not a transcript (an error, or no stamps to read it against) is not downloaded, past an error's own words
      trouble = await troubleOf(res);
      if (!plan.wanted()) return null;
    }
    plan.failed(trouble);
    await plan.wait(plan.nextDelay());
  }
  return null;
}
