/* the composer's typed answer to a question, through boxbox's api (never
   straight to a daemon). the answer carries a clientID minted once for it, so
   a flaky network acts once (cmx2 a4); the daemon's 409 comes back as who
   answered first and when (a6). the cards in the thread answer through
   ui/thread/asks.ts. */

import type { components } from "../../api/boxbox";
import { api } from "../../api/client";
import { deviceClass, deviceId } from "../../push/device";
import type { Ask } from "../../sync/protocol";

/** what came of an answer, in terms the composer can say */
export type Outcome =
  | { kind: "answered" }
  | { kind: "settled"; by: string; at: number | null }
  | { kind: "gone" }
  | { kind: "failed"; message: string };

const UNREACHABLE = "not sent: the boxbox server is not answering. tap to retry";

export function answerQuestion(ask: Ask, clientID: string, answers: string[][]): Promise<Outcome> {
  return settle(
    api.POST("/api/hosts/{host}/questions/{ask}", {
      params: { path: { host: ask.host, ask: ask.id } },
      body: { device: deviceId(), deviceClass: deviceClass(), clientID, answers },
    }),
  );
}

type ErrorBody = components["schemas"]["ErrorBody"];
type Answered = { response: Response; error?: ErrorBody | undefined };

async function settle(call: Promise<Answered>): Promise<Outcome> {
  let answered: Answered;
  try {
    answered = await call;
  } catch {
    return { kind: "failed", message: UNREACHABLE };
  }
  const { response, error } = answered;
  if (response.ok) return { kind: "answered" };
  const detail = error?.error;
  if (detail?.code === "settled" && detail.settled) return { kind: "settled", by: detail.settled.by, at: detail.settled.at ?? null };
  if (detail?.code === "gone") return { kind: "gone" };
  return { kind: "failed", message: `not sent: ${detail?.message ?? `the server answered ${response.status}`}. tap to retry` };
}
