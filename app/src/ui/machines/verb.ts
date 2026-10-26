/* one `verb` telemetry row for each thing a person asks the machines or
   settings screens to do (telemetry/schema.ts: verb). `ok` and `ms` come
   from the call's own outcome; `arg` is a host name or a setting's value,
   never free text. these verbs are rare,
   so each row goes out as it happens, best effort. */

import { deviceClass, deviceId } from "../../push/device";
import type { Outcome } from "./said";

export { type Outcome, said, UNREACHABLE } from "./said";

export type VerbName =
  | "pairMachine"
  | "forgetMachine"
  | "reloadMachine"
  | "restartMachine"
  | "setTheme"
  | "setMotion"
  | "setPushKinds"
  | "setRepoDefaults"
  | "setAutoClear"
  | "setFoldWorking"
  | "setJobsAsNeeds";

type Where = { surface: "machines" | "settings"; host?: string; arg?: string };

export async function verb<T>(name: VerbName, where: Where, run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  const started = performance.now();
  const outcome = await run();
  const props: Record<string, string> = { name };
  if (where.arg !== undefined) props.arg = where.arg;
  if (!outcome.ok) props.error = outcome.error;
  const event = {
    kind: "verb",
    at: Date.now(),
    surface: where.surface,
    ...(where.host !== undefined ? { host: where.host } : {}),
    ok: outcome.ok,
    ms: Math.round(performance.now() - started),
    props,
  };
  void fetch("/api/telemetry", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: deviceId(), deviceClass: deviceClass(), events: [event] }),
  }).catch(() => {
    /* offline: the server's own log line for the verb still stands */
  });
  return outcome;
}
