/* the "pinned by the first dev-gateway run" items (docs/openclaw.md, 12),
   each answered with printed evidence from the running dev gateway:

     loopback      a gateway-client/backend connect on loopback with the
                   shared token: paired or not, device token or not
     lan           the pairing bench (`just openclaw --port 4745 --pairing
                   manual`, which binds the lan address): a device-less
                   connect to the machine's own lan address is classed local
                   (admitted) or remote (refused, pairing required)
     tags          the content block types in the recorded transcripts
     seq           whether tail rows carry __openclaw.seq (and a delta
                   answer activeLeafEntryId)
     message-get   a reply over 128 kib: chat.history's placeholder, then
                   chat.message.get {maxChars: 1000000} returns it whole or not
     create-retry  sessions.create retried with the same key keeps the first
                   create's model and thinking level, or not
     dashboard     stale-dashboard auto-archive driven from the chaos client
                   (needs the bench started with --archive-dashboard-after 20s)
     reminder      "remind me in 2 minutes" from an operator send with
                   suppression on creates the cron job, and it fires

   run: bun bench/openclaw-open-items.ts [item...] */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { benchDir, MODEL_REF, PIN, ROOT } from "../scripts/openclaw-pinned";
import { BENCH, connect, print, turn } from "./openclaw-bench";
import { staleDashboard } from "./openclaw-chaos";
import { spawnSync } from "node:child_process";
import { benchPaths, cliArgs, gatewayEnv } from "../scripts/openclaw-pinned";
import { field, GatewayClient, isObject, type Json, newDevice } from "./openclaw-client";

const answers: string[] = [];
function answer(item: string, text: string) {
  answers.push(`${item}: ${text}`);
  console.log(`ANSWER ${item}: ${text}`);
}

function rowsOf(value: Json): Json[] {
  const messages = field(value, "messages");
  return Array.isArray(messages) ? messages : [];
}

async function newSession(client: GatewayClient, label: string): Promise<string> {
  const created = await client.request("sessions.create", { agentId: "main", label: `${label} ${Date.now()}` });
  return String(field(created, "key"));
}

const items: Record<string, (client: GatewayClient) => Promise<void>> = {
  async loopback(client) {
    const auth = field(client.hello ?? {}, "auth");
    print("loopback: hello-ok.auth", auth);
    const device = field(auth, "deviceToken");
    answer(
      "loopback pairing",
      `gateway-client/backend with the shared token on loopback is admitted with no device and no pairing; deviceToken ${device === undefined ? "absent" : "present"}; scopes ${JSON.stringify(field(auth, "scopes"))}`,
    );
  },

  async lan() {
    const port = 4745;
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!lan) return answer("lan classed remote", "untested: this machine has no non-loopback ipv4 address");
    const token = readFileSync(join(benchDir(port), "token"), "utf8").trim();
    const tryConnect = async (host: string) => {
      try {
        const c = await GatewayClient.connect({ url: `ws://${host}:${port}`, token, protocol: PIN.protocol });
        const auth = field(c.hello ?? {}, "auth");
        c.close();
        return { admitted: true, auth };
      } catch (e) {
        return { admitted: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    const viaLoopback = await tryConnect("127.0.0.1");
    const viaLan = await tryConnect(lan);
    print("lan: device-less gateway-client/backend via 127.0.0.1", viaLoopback);
    print("lan: device-less gateway-client/backend via the lan address (placeholder <lan>)", JSON.parse(JSON.stringify(viaLan).split(lan).join("<lan>")));
    /* connect-auth.ts keeps a device-less backend's scopes only when the connect is loopback-local
       (skipLocalBackendSelfPairing); anything else has them cleared */
    const lanScopes = field(viaLan.auth ?? null, "scopes");
    const stripped = viaLan.admitted && Array.isArray(lanScopes) && lanScopes.length === 0;
    /* the pairing path: a fresh device over the lan address, approved with `devices approve` */
    const device = newDevice();
    const scrubbed = (v: unknown) => JSON.parse(JSON.stringify(v ?? null).split(lan).join("<lan>")) as unknown;
    let firstTry: unknown;
    let requestId: string | undefined;
    try {
      const c = await GatewayClient.connect({ url: `ws://${lan}:${port}`, token, protocol: PIN.protocol, device });
      firstTry = { admitted: true, auth: field(c.hello ?? {}, "auth") };
      c.close();
    } catch (e) {
      const err = e instanceof Error && "error" in e ? (e as { error: Json }).error : String(e);
      firstTry = { admitted: false, error: err };
      const found = JSON.stringify(err).match(/"requestId":"([^"]+)"/);
      requestId = found?.[1];
    }
    print("lan: a new device via the lan address", scrubbed(firstTry));
    let approved: unknown = "no requestId to approve";
    let secondTry: unknown;
    if (requestId) {
      const paths = benchPaths(benchDir(port));
      const out = spawnSync("node", cliArgs(["devices", "approve", requestId, "--token", token, "--url", `ws://127.0.0.1:${port}`]), { env: gatewayEnv(paths), encoding: "utf8" });
      approved = { exit: out.status, out: `${out.stdout}${out.stderr}`.trim().split("\n").slice(-4).join(" / ") };
      print("lan: devices approve <requestId>", scrubbed(approved));
      try {
        const c = await GatewayClient.connect({ url: `ws://${lan}:${port}`, token, protocol: PIN.protocol, device });
        const auth = field(c.hello ?? {}, "auth");
        secondTry = { admitted: true, scopes: field(auth, "scopes"), deviceToken: field(auth, "deviceToken") === undefined ? "absent" : "present" };
        c.close();
      } catch (e) {
        secondTry = { admitted: false, error: e instanceof Error ? e.message : String(e) };
      }
      print("lan: the same device after approval", scrubbed(secondTry));
    }
    answer(
      "lan classed remote",
      `${stripped ? "yes" : "unclear"}: a device-less backend via the lan address is admitted with scopes ${JSON.stringify(lanScopes)} (loopback keeps all five), so it is not loopback-local; a new device there gets ${requestId ? "pairing required with a requestId" : JSON.stringify(scrubbed(firstTry)).slice(0, 120)}${requestId ? `, and after \`devices approve\` reconnects ${JSON.stringify(secondTry)}` : ""}`,
    );
  },

  async tags() {
    const dir = join(ROOT, "server/tests/fixtures/openclaw");
    const tags = new Map<string, Set<string>>();
    const kinds = new Set<string>();
    const extras = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.startsWith("transcript-"))) {
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as Json;
      for (const row of rowsOf(doc)) {
        const role = String(field(row, "role"));
        const content = field(row, "content");
        const set = tags.get(role) ?? new Set<string>();
        if (Array.isArray(content)) for (const block of content) set.add(String(field(block, "type")));
        else set.add(typeof content);
        tags.set(role, set);
        const kind = field(row, "__openclaw", "kind");
        if (typeof kind === "string") kinds.add(`${role} __openclaw.kind=${kind}`);
        if (field(row, "__openclaw", "media") !== undefined) extras.add(`${role} __openclaw.media[].kind=${JSON.stringify((field(row, "__openclaw", "media") as Json[]).map((m) => field(m, "kind")))}`);
        const delivery = field(row, "openclawDelivery");
        if (isObject(delivery)) extras.add(`${role} openclawDelivery.{${Object.keys(delivery).join(",")}}`);
        for (const k of ["replyToId", "replyToPreview"]) if (field(row, k) !== undefined) extras.add(`${role} ${k}`);
      }
    }
    const summary = Object.fromEntries([...tags].map(([role, set]) => [role, [...set].sort()]));
    print("tags: block types per role across the recorded transcripts", summary);
    print("tags: row kinds and extras", { kinds: [...kinds], extras: [...extras] });
    answer("transcript block tags", `${JSON.stringify(summary)}; boundaries ${[...kinds].join(", ")}; ${[...extras].join("; ")}`);
  },

  async seq(client) {
    const key = await newSession(client, "seq");
    await turn(client, key, "a turn for the tail", { scenario: ["words", "5", "0"] });
    const tail = await client.request("chat.history", { sessionKey: key, limit: 20 });
    const seqs = rowsOf(tail).map((m) => field(m, "__openclaw", "seq"));
    print("seq: tail rows' __openclaw", rowsOf(tail).map((m) => field(m, "__openclaw")));
    await turn(client, key, "one more", { scenario: ["words", "3", "0"] });
    const delta = await client.request("chat.history", { sessionKey: key, cursor: String(field(tail, "deltaCursor")) });
    const where = ["activeLeafEntryId", "sessionInfo.activeLeafEntryId", "metadata.activeLeafEntryId"].find((p) => field(delta, ...p.split(".")) !== undefined);
    const leaf = where ? field(delta, ...where.split(".")) : undefined;
    print("seq: delta answer top-level keys", isObject(delta) ? Object.keys(delta) : delta);
    answer(
      "__openclaw.seq on tail rows",
      `${seqs.every((s) => typeof s === "number") ? "yes" : "no"}, seqs ${JSON.stringify(seqs)}; a delta answer's activeLeafEntryId ${leaf === undefined ? "absent" : `present at ${where} (${JSON.stringify(leaf)})`}`,
    );
  },

  async "message-get"(client) {
    const key = await newSession(client, "message get");
    await turn(client, key, "send the oversized reply", { scenario: ["big", "160"], timeoutMs: 120_000 });
    const page = await client.request("chat.history", { sessionKey: key, limit: 20, maxChars: 500000 });
    const placeholder = rowsOf(page).find((m) => field(m, "__openclaw", "reason") === "oversized");
    print("message-get: the placeholder in chat.history", placeholder ?? "no oversized row");
    const id = field(placeholder, "__openclaw", "id");
    if (typeof id !== "string") return answer("chat.message.get proof", "fails: chat.history gave no oversized placeholder with an id");
    const got = await client.request("chat.message.get", { sessionKey: key, agentId: "main", messageId: id, maxChars: 1000000 }, 30_000);
    const content = field(got, "message", "content");
    const text = Array.isArray(content) ? content.map((b) => (typeof field(b, "text") === "string" ? String(field(b, "text")) : "")).join("") : "";
    print("message-get: chat.message.get", { ok: field(got, "ok"), unavailableReason: field(got, "unavailableReason"), textChars: text.length, bytes: JSON.stringify(got).length });
    answer(
      "chat.message.get proof",
      field(got, "ok") === true && text.length >= 160 * 1024
        ? `passes: the ${JSON.stringify(placeholder).length}-byte placeholder's id returns the row whole (${text.length} chars of text)`
        : `fails: ok ${String(field(got, "ok"))}, reason ${String(field(got, "unavailableReason"))}, ${text.length} chars; chat.message.get leaves the allowlist`,
    );
  },

  async "create-retry"(client) {
    const key = `agent:main:bench-create-${randomUUID().slice(0, 8)}`;
    /* no idempotencyKey: a device-less shared-token client is refused one ("idempotent session creation
       requires an authenticated principal or device identity"), printed below; the retry is by key */
    const params = { key, agentId: "main", model: MODEL_REF, thinkingLevel: "low" };
    const keyed = await client.raw("sessions.create", { ...params, key: `${key}-idem`, idempotencyKey: randomUUID() });
    print("create-retry: sessions.create with an idempotencyKey from a device-less client", { ok: keyed.ok, error: keyed.error });
    const first = await client.request("sessions.create", params);
    print("create-retry: first sessions.create", first);
    const row = async () => {
      const listed = await client.request("sessions.list", { limit: 200 });
      const sessions = field(listed, "sessions");
      const found = Array.isArray(sessions) ? sessions.find((s) => field(s, "key") === key) : undefined;
      return {
        sessionId: field(found, "sessionId"),
        model: field(found, "model"),
        modelProvider: field(found, "modelProvider"),
        thinkingLevel: field(found, "thinkingLevel") ?? field(found, "thinking"),
      };
    };
    const before = await row();
    const same = await client.raw("sessions.create", params);
    const afterSame = await row();
    const bare = await client.raw("sessions.create", { key, agentId: "main" });
    const afterBare = await row();
    const writer = await connect({ scopes: ["operator.read", "operator.write"] });
    const changed = await writer.raw("sessions.create", { key, agentId: "main", thinkingLevel: "high" });
    writer.close();
    const afterChanged = await row();
    const adminChanged = await client.raw("sessions.create", { key, agentId: "main", thinkingLevel: "high" });
    const afterAdmin = await row();
    print("create-retry: row after the first create", before);
    print("create-retry: retry with the same params", { ok: same.ok, key: field(same.payload, "key"), error: same.error, row: afterSame });
    print("create-retry: retry with only key and agent", { ok: bare.ok, error: bare.error, row: afterBare });
    print("create-retry: retry asking thinking high, write scope only", { ok: changed.ok, error: changed.error, row: afterChanged });
    print("create-retry: retry asking thinking high, with operator.admin", { ok: adminChanged.ok, error: adminChanged.error, row: afterAdmin });
    const kept = JSON.stringify(afterSame) === JSON.stringify(before) && JSON.stringify(afterBare) === JSON.stringify(before);
    answer(
      "sessions.create retry keeps model and thinking",
      `${kept ? "yes" : "no"}: a retry with the same key adopts session ${String(before.sessionId).slice(0, 8)} (same or bare params keep model ${String(before.model)} and thinking ${String(before.thinkingLevel)}); a retry asking a different thinking level without admin is ${changed.ok ? "accepted" : `refused (${JSON.stringify(field(changed.error ?? null, "message") ?? changed.error).slice(0, 100)})`}, and with admin ${adminChanged.ok ? `applied (thinking now ${String(afterAdmin.thinkingLevel)})` : "refused"}`,
    );
  },

  async dashboard(client) {
    const config = JSON.parse(readFileSync(join(BENCH, "openclaw.json"), "utf8")) as { session?: { maintenance?: { archiveDashboardAfter?: string } } };
    const after = config.session?.maintenance?.archiveDashboardAfter;
    if (!after) return answer("stale-dashboard auto-archive", "not run: start the bench with --archive-dashboard-after 20s");
    const { facts, beforeCleanup } = await staleDashboard(client, 30_000);
    const reason = isObject(facts ?? null) ? JSON.stringify(facts) : "row not archived";
    const how = beforeCleanup
      ? "the gateway's own maintenance archived it before the chaos client's sessions.cleanup ran"
      : "archived by the chaos client's sessions.cleanup {allAgents, enforce}";
    answer(
      "stale-dashboard auto-archive",
      `${reason.includes("stale-dashboard") ? "drivable" : "not drivable"}: bench config archiveDashboardAfter ${after} (no sessions.patch can write that reason), a dashboard session created by the chaos client and left 30 s; ${how}; row archive facts ${reason}`,
    );
  },

  async reminder(client) {
    await reminder(client, "reminder from a suppressed send (loopback bench)");
  },

  /* the remote-path bench: run with OPENCLAW_PORT=4745 against `just openclaw --port 4745 --pairing manual`;
     boxbox's side is a paired device over the lan address, as a remote boxbox is */
  async "reminder-remote"() {
    const lanClient = await pairedLanClient(PORT_FROM_ENV);
    try {
      await reminder(lanClient, "reminder from a suppressed send (remote-path bench, paired device over the lan address)");
    } finally {
      lanClient.close();
    }
  },
};

const PORT_FROM_ENV = Number(process.env.OPENCLAW_PORT ?? 4740);

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
}

/** a new device over the lan address, paired with `devices approve` on the bench's state dir */
async function pairedLanClient(port: number): Promise<GatewayClient> {
  const lan = lanAddress();
  if (!lan) throw new Error("no non-loopback ipv4 address");
  const token = readFileSync(join(benchDir(port), "token"), "utf8").trim();
  const device = newDevice();
  const url = `ws://${lan}:${port}`;
  let requestId: string | undefined;
  try {
    return await GatewayClient.connect({ url, token, protocol: PIN.protocol, device });
  } catch (e) {
    requestId = JSON.stringify(e instanceof Error && "error" in e ? (e as { error: Json }).error : null).match(/"requestId":"([^"]+)"/)?.[1];
  }
  if (!requestId) throw new Error("the lan connect neither paired nor asked for pairing");
  const out = spawnSync("node", cliArgs(["devices", "approve", requestId, "--token", token, "--url", `ws://127.0.0.1:${port}`]), { env: gatewayEnv(benchPaths(benchDir(port))), encoding: "utf8" });
  if (out.status !== 0) throw new Error(`devices approve failed: ${out.stderr}`);
  print("pairing: approved a lan device", { requestId });
  return GatewayClient.connect({ url, token, protocol: PIN.protocol, device });
}

async function reminder(client: GatewayClient, label: string) {
  {
    const key = await newSession(client, "reminder");
    const t = await turn(client, key, "remind me in 2 minutes", { scenario: ["remind"], timeoutMs: 60_000 });
    print("reminder: the turn", { final: t.final.payload });
    const jobs = await client.request("cron.list", { includeDisabled: true, limit: 200 });
    const list = field(jobs, "jobs");
    const job = Array.isArray(list) ? list.find((j) => field(j, "name") === "bench reminder" && JSON.stringify(j).includes(key.split(":").pop() ?? "")) ?? list.find((j) => field(j, "name") === "bench reminder") : undefined;
    print("reminder: the job", job ?? "no job named `bench reminder`");
    if (!job) return answer(label, "no: the automations call did not create the job");
    const id = String(field(job, "id"));
    let fired: Json | undefined;
    for (let i = 0; i < 30 && fired === undefined; i++) {
      await Bun.sleep(6000);
      const runs = await client.raw("cron.runs", { id, limit: 5 });
      const got = await client.raw("cron.get", { id });
      const state = field(got.payload, "state") ?? field(got.payload, "job", "state");
      const last = field(state, "lastRunStatus") ?? field(state, "lastStatus");
      if (last !== undefined || (Array.isArray(field(runs.payload, "entries")) && (field(runs.payload, "entries") as Json[]).length > 0)) {
        fired = { state: state ?? null, runs: (runs.ok ? runs.payload : runs.error) ?? null };
      }
    }
    print("reminder: after the due time", fired ?? "no run recorded within 3 min");
    answer(
      label,
      `job created (${id.slice(0, 8)}, owner ${JSON.stringify(field(job, "owner") ?? null)}, sessionTarget ${String(field(job, "sessionTarget"))}); ${fired === undefined ? "it did not fire within 3 minutes" : `it fired: ${JSON.stringify(field(fired, "runs", "entries")).slice(0, 220)}`}`,
    );
  }
}

const wanted = process.argv.slice(2);
const client = await connect();
try {
  for (const [name, run] of Object.entries(items)) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    try {
      await run(client);
    } catch (error) {
      answer(name, `error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
} finally {
  client.close();
}
console.log("\nopen items:");
for (const line of answers) console.log(`- ${line}`);
