/* what the bench tools share: connecting to the running dev gateway with
   the bench token, and driving one scripted turn to its end. */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchDir, PIN } from "../scripts/openclaw-pinned";
import { type ConnectOptions, type EventFrame, field, GatewayClient, isObject, type Json, type JsonObject } from "./openclaw-client";
import { script } from "./openclaw-script";

export const PORT = Number(process.env.OPENCLAW_PORT ?? 4740);
export const BENCH = benchDir(PORT);

export function benchUrl(): string {
  return `ws://127.0.0.1:${PORT}`;
}

export function readToken(): string {
  const file = join(BENCH, "token");
  if (!existsSync(file)) throw new Error(`no bench token at ${file}: start the gateway with \`just openclaw\` first`);
  return readFileSync(file, "utf8").trim();
}

export function connect(extra: Partial<ConnectOptions> = {}): Promise<GatewayClient> {
  return GatewayClient.connect({ url: benchUrl(), token: readToken(), protocol: PIN.protocol, ...extra });
}

/** one line of evidence: the step and a compact json of what came back */
export function print(step: string, value: unknown, max = 600) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`${step}: ${text.length > max ? `${text.slice(0, max)}... (${text.length} chars)` : text}`);
}

export interface Turn {
  runId: string | undefined;
  send: Json;
  final: EventFrame;
  events: EventFrame[];
}

function chatOf(event: EventFrame, sessionKey: string): JsonObject | undefined {
  if (event.event !== "chat" || !isObject(event.payload)) return undefined;
  return event.payload.sessionKey === sessionKey ? event.payload : undefined;
}

/** sends `text` as an operator turn with suppression on and the followup queue (docs/openclaw.md, 7.1 and
    7.2), then waits for the run's final, aborted or error chat event. `during` runs once the send is
    acknowledged, for a turn that needs an answer (an approval, a question) before it can end */
export async function turn(
  client: GatewayClient,
  sessionKey: string,
  text: string,
  options: { scenario?: [string, ...string[]]; timeoutMs?: number; during?: (since: number) => Promise<void>; extra?: JsonObject } = {},
): Promise<Turn> {
  if (options.scenario) script(...options.scenario);
  const since = client.events.length;
  const send = await client.request("chat.send", {
    sessionKey,
    message: text,
    idempotencyKey: randomUUID(),
    queueMode: "followup",
    suppressCommandInterpretation: true,
    ...(options.extra ?? {}),
  });
  const runId = typeof field(send, "runId") === "string" ? (field(send, "runId") as string) : undefined;
  if (options.during) await options.during(since);
  const final = await client.waitFor(
    (e) => {
      const chat = chatOf(e, sessionKey);
      if (!chat) return false;
      if (runId && chat.runId !== runId) return false;
      return chat.state === "final" || chat.state === "aborted" || chat.state === "error";
    },
    options.timeoutMs ?? 60_000,
    `end of the turn in ${sessionKey}`,
    since,
  );
  return { runId, send, final, events: client.events.slice(since) };
}
