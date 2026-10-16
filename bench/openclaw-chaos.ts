/* the chaos client (docs/openclaw.md, 11.7): a separate raw websocket with
   the bench token as gateway-client/backend, which may call anything, plus
   the process-level switches. boxbox's server is bound by the allowlist;
   this harness is not.

     hold [N]                    script a held turn of N words (released by `release`)
     release                     release the held turn
     drop | fail [STATUS]        the provider drops the socket, or answers STATUS
     kill9                       kill -9 the gateway (the supervisor in `just
                                 openclaw` starts it again on the same state
                                 dir) and wait for hello-ok; prints both bootIds
     restart                     SIGUSR2: the gateway restarts in place
     compact KEY                 sessions.compact
     reset KEY [new|reset]       sessions.reset
     rewind KEY ENTRY_ID         sessions.rewind
     archive KEY                 sessions.patch {archived: true}
     resolve ID [DECISION]       approval.resolve {id, kind: "exec", decision}
     cron-run [NAME]             cron.run on the named job (the fixture's
                                 `bench scheduled` by default), forced
     stale-dashboard             a dashboard session left past the bench's
                                 session.maintenance.archiveDashboardAfter
                                 (start the gateway with
                                 --archive-dashboard-after 20s), then
                                 sessions.cleanup; prints the row's archive facts
     long-gap N                  N scripted turns of words in one session while
                                 nobody else watches (more than 200 events)

   run: bun bench/openclaw-chaos.ts <switch> [args] */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH, connect, print, turn } from "./openclaw-bench";
import { field, type GatewayClient, isObject, type Json } from "./openclaw-client";
import { release as releaseScript, script } from "./openclaw-script";

function gatewayPid(): number {
  const state = JSON.parse(readFileSync(join(BENCH, "gateway.json"), "utf8")) as { pids?: Record<string, number> };
  const pid = state.pids?.gateway;
  if (!pid) throw new Error(`no gateway pid in ${join(BENCH, "gateway.json")}`);
  return pid;
}

function bootId(client: GatewayClient): Json | undefined {
  return field(client.hello ?? {}, "server", "bootId");
}

async function reconnect(timeoutMs: number): Promise<GatewayClient> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      return await connect();
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await Bun.sleep(500);
    }
  }
  throw new Error(`the gateway did not come back within ${timeoutMs} ms (${last})`);
}

export async function kill9(): Promise<{ before: Json | undefined; after: Json | undefined }> {
  const first = await connect();
  const before = bootId(first);
  first.close();
  const pid = gatewayPid();
  process.kill(pid, "SIGKILL");
  print("chaos: kill -9", { pid });
  await Bun.sleep(1500);
  const second = await reconnect(120_000);
  const after = bootId(second);
  second.close();
  print("chaos: back", { before, after, newPid: gatewayPid() });
  return { before, after };
}

/** a dashboard session aged past the bench's archiveDashboardAfter, then a maintenance pass */
export async function staleDashboard(client: GatewayClient, waitMs = 30_000): Promise<{ facts: Json | undefined; beforeCleanup: boolean }> {
  const key = `agent:main:dashboard:${crypto.randomUUID()}`;
  const created = await client.request("sessions.create", { key, agentId: "main", label: `stale dashboard ${Date.now()}` });
  print("chaos: dashboard session", created);
  await turn(client, key, "one turn so the row has activity", { scenario: ["words", "3", "0"] });
  print("chaos: waiting past archiveDashboardAfter", { waitMs });
  await Bun.sleep(waitMs);
  const cleanupAt = Date.now();
  const before = field(await client.request("sessions.list", { archived: "all", limit: 200 }), "sessions");
  const early = Array.isArray(before) ? before.find((s) => field(s, "key") === key) : undefined;
  print("chaos: the row before sessions.cleanup", { archiveReason: field(early, "archiveReason") ?? null, archivedAt: field(early, "archivedAt") ?? null, cleanupAt });
  const cleanup = await client.request("sessions.cleanup", { allAgents: true, enforce: true }, 60_000);
  print("chaos: sessions.cleanup", cleanup);
  const listed = await client.request("sessions.list", { archived: "all", limit: 200 });
  const sessions = field(listed, "sessions");
  const row = Array.isArray(sessions) ? sessions.find((s) => field(s, "key") === key) : undefined;
  const facts = isObject(row)
    ? Object.fromEntries(Object.entries(row).filter(([k]) => k.toLowerCase().includes("archiv")))
    : undefined;
  print("chaos: the dashboard row's archive facts", facts ?? "row not listed");
  return { facts: facts ?? undefined, beforeCleanup: field(early, "archiveReason") === "stale-dashboard" };
}

export async function cronRun(client: GatewayClient, name: string): Promise<Json> {
  const jobs = await client.request("cron.list", { includeDisabled: true, limit: 200 });
  const list = field(jobs, "jobs");
  const job = Array.isArray(list) ? list.find((j) => field(j, "name") === name) : undefined;
  const id = field(job, "id");
  if (typeof id !== "string") throw new Error(`no cron job named ${name}`);
  return client.request("cron.run", { id, mode: "force" }, 60_000);
}

async function main(args: string[]) {
  const [name, a, b] = args;
  switch (name) {
    case "hold":
      script("hold", a ?? "40");
      return print("chaos: hold", "the next model response waits for `release`");
    case "release": {
      const control = JSON.parse(readFileSync(join(BENCH, "script.json"), "utf8"));
      releaseScript(control);
      return print("chaos: release", "released");
    }
    case "drop":
      script("drop");
      return print("chaos: drop", "the next model request is dropped");
    case "fail":
      script("fail", a ?? "500");
      return print("chaos: fail", `the next model request answers ${a ?? "500"}`);
    case "kill9":
      await kill9();
      return;
    case "restart": {
      const pid = gatewayPid();
      process.kill(pid, "SIGUSR2");
      print("chaos: SIGUSR2", { pid });
      await Bun.sleep(1500);
      const client = await reconnect(120_000);
      print("chaos: back", { bootId: bootId(client) });
      client.close();
      return;
    }
  }
  const client = await connect();
  try {
    switch (name) {
      case "compact":
        return print("chaos: sessions.compact", await client.request("sessions.compact", { key: a ?? "" }, 60_000));
      case "reset":
        return print("chaos: sessions.reset", await client.request("sessions.reset", { key: a ?? "", reason: b ?? "new" }));
      case "rewind":
        return print("chaos: sessions.rewind", await client.request("sessions.rewind", { sessionKey: a ?? "", entryId: b ?? "" }));
      case "archive":
        return print("chaos: sessions.patch", await client.request("sessions.patch", { key: a ?? "", archived: true }));
      case "resolve":
        return print("chaos: approval.resolve", await client.request("approval.resolve", { id: a ?? "", kind: "exec", decision: b ?? "allow-once" }));
      case "cron-run":
        return print("chaos: cron.run", await cronRun(client, a ?? "bench scheduled"));
      case "stale-dashboard":
        await staleDashboard(client, Number(a ?? 30_000));
        return;
      case "long-gap": {
        const created = await client.request("sessions.create", { agentId: "main", label: `long gap ${Date.now()}` });
        const key = String(field(created, "key"));
        let events = 0;
        for (let i = 0; i < Number(a ?? 4); i++) events += (await turn(client, key, `gap turn ${i}`, { scenario: ["words", "80", "0"] })).events.length;
        return print("chaos: long gap", { key, events });
      }
      default:
        throw new Error(`unknown switch ${String(name)}; see the header of bench/openclaw-chaos.ts`);
    }
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`chaos: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
