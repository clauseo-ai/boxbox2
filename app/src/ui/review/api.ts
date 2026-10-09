/* the review routes, called through the app's one typed client (api/client.ts): same origin, the session cookie riding
   along, a refusal read into words (model.ts, problemOf). the stage hands the client in, because the review is a chunk of
   its own and a module it shares with the first load is one the bundler hoists out of the first load's chunk, with the
   solid runtime beside it (stage.tsx). the server owns the telemetry rows for a merge and a discard (review.merged,
   review.discarded), stamped from the daemon's answer. */

import type { api } from "../../api/client";
import { type Discarded, type Merged, offline, type Problem, problemOf, type Review } from "./model";

type Client = typeof api;

export type Result<T> = { ok: true; value: T } | { ok: false; problem: Problem };

/** what the card calls, so a story can stand in for the server and a test can watch the calls */
export type ReviewApi = {
  read: (host: string, session: string) => Promise<Result<Review>>;
  merge: (host: string, session: string, message?: string) => Promise<Result<Merged>>;
  discard: (host: string, session: string) => Promise<Result<Discarded>>;
};

type Answer<T> = { data?: T | undefined; error?: unknown; response: Response };

/** one answer as a result: data when the call did its work, else the refusal in words; a call that never answered is offline */
async function result<T>(action: "read" | "merge" | "discard", call: () => Promise<Answer<T>>): Promise<Result<T>> {
  try {
    const { data, error, response } = await call();
    if (response.ok && data !== undefined) return { ok: true, value: data };
    return { ok: false, problem: problemOf(response.status, (error ?? null) as Record<string, unknown> | null, action) };
  } catch {
    return { ok: false, problem: offline() };
  }
}

const at = (host: string, session: string) => ({ params: { path: { host, session } } });

export const reviewApiOver = (api: Client): ReviewApi => ({
  read: (host, session) => result("read", () => api.GET("/api/hosts/{host}/sessions/{session}/review", at(host, session))),
  merge: (host, session, message) => result("merge", () => api.POST("/api/hosts/{host}/sessions/{session}/review/merge", { ...at(host, session), body: message ? { message } : {} })),
  discard: (host, session) => result("discard", () => api.POST("/api/hosts/{host}/sessions/{session}/review/discard", at(host, session))),
});
