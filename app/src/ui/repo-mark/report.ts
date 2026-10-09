/* the telemetry row for one read of a repo's favicon (telemetry/schema.ts, repo.icon). no host or repo name travels
   (rule 10): the outcome and how long it took. a clean "no icon" is no failure, so it carries no ok; a read that came to
   nothing does. kept out of probe.ts so the probe holds no worker import and its states can be tested */

import { emit } from "../../sync/client";
import type { IconOutcome } from "./probe";

export function reportIconRead(outcome: IconOutcome, attempts: number, ms: number): void {
  if (outcome === "image") emit("repo.icon", { outcome, attempts }, { ms, ok: true });
  else if (outcome === "retry" || outcome === "unreadable") emit("repo.icon", { outcome, attempts }, { ms, ok: false });
  else emit("repo.icon", { outcome, attempts }, { ms });
}
