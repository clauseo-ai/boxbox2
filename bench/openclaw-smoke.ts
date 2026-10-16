/* the openclaw smoke: one pass over the verbs boxbox uses, against the
   running dev gateway (`just openclaw`), printing each step's evidence.

     1. connect as an operator with the bench token (gateway-client/backend,
        which loopback admits without a device) and print hello-ok
     2. sessions.list
     3. sessions.create, then chat.send with a scripted turn
        (queueMode "followup", suppressCommandInterpretation true) to its end
     4. chat.history, a second turn, chat.history with the first answer's
        deltaCursor (a delta holding exactly the new rows), and once more
        with the delta's own cursor (an empty delta)
     5. an exec approval raised by the script and resolved with exactly
        {id, kind, decision}
     6. an ask_user question raised by the script and resolved

   exits 1 at the first step that fails. run: bun bench/openclaw-smoke.ts
   (OPENCLAW_PORT for a bench on another port). */

import { connect, print, turn } from "./openclaw-bench";
import { type EventFrame, field, type GatewayClient, type Json } from "./openclaw-client";

function check(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

function rows(history: Json): Json[] {
  const messages = field(history, "messages");
  return Array.isArray(messages) ? messages : [];
}

function approvalId(event: EventFrame): string | undefined {
  if (event.event === "exec.approval.requested") {
    const id = field(event.payload, "id");
    return typeof id === "string" ? id : undefined;
  }
  if (event.event === "session.approval" && field(event.payload, "phase") === "pending") {
    const id = field(event.payload, "approval", "id");
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

async function smoke(client: GatewayClient) {
  const hello = client.hello ?? {};
  print("1 connect: hello-ok", {
    type: hello.type,
    protocol: hello.protocol,
    server: hello.server,
    auth: hello.auth,
    methods: Array.isArray(field(hello, "features", "methods")) ? (field(hello, "features", "methods") as Json[]).length : null,
  });
  check(hello.type === "hello-ok", "connect did not answer hello-ok");

  const list = await client.request("sessions.list", { limit: 50 });
  const sessions = field(list, "sessions");
  print("2 sessions.list", { count: Array.isArray(sessions) ? sessions.length : null, keys: Array.isArray(sessions) ? sessions.map((s) => field(s, "key")) : list });
  check(Array.isArray(sessions), "sessions.list answered no sessions array");

  const created = await client.request("sessions.create", { agentId: "main", label: `bench smoke ${Date.now()}` });
  const key = field(created, "key");
  print("3 sessions.create", created);
  check(typeof key === "string", "sessions.create answered no key");

  const first = await turn(client, key, "say a few words", { scenario: ["words", "12", "5"] });
  const deltas = first.events.filter((e) => e.event === "chat" && field(e.payload, "state") === "delta").length;
  print("3 chat.send", { send: first.send, deltas, final: first.final.payload });
  check(field(first.final.payload, "state") === "final", "the scripted turn did not end final");

  const page = await client.request("chat.history", { sessionKey: key, limit: 50 });
  const cursor = field(page, "deltaCursor");
  print("4 chat.history", { rows: rows(page).length, roles: rows(page).map((m) => field(m, "role")), seqs: rows(page).map((m) => field(m, "__openclaw", "seq")), deltaCursor: cursor });
  check(typeof cursor === "string", "chat.history answered no deltaCursor");

  const second = await turn(client, key, "and a few more", { scenario: ["words", "6", "5"] });
  check(field(second.final.payload, "state") === "final", "the second turn did not end final");
  const delta = await client.request("chat.history", { sessionKey: key, cursor });
  const next = field(delta, "deltaCursor");
  print("4 chat.history {cursor}", {
    kind: field(delta, "kind"),
    rows: rows(delta).length,
    /* a delta row is an envelope: {sessionKey, message, messageId, messageSeq, session, ...} */
    roles: rows(delta).map((m) => field(m, "message", "role")),
    messageSeqs: rows(delta).map((m) => field(m, "messageSeq")),
    deltaCursor: next,
  });
  check(field(delta, "kind") === "delta" && rows(delta).length === 2, "the delta did not hold exactly the two new rows");
  const empty = await client.request("chat.history", { sessionKey: key, cursor: next ?? "" });
  print("4 chat.history {cursor: the delta's}", { kind: field(empty, "kind"), rows: rows(empty).length, deltaCursor: field(empty, "deltaCursor") });
  check(field(empty, "kind") === "delta" && rows(empty).length === 0, "the round trip's last delta was not empty");

  let resolved: Json = null;
  const approval = await turn(client, key, "run the bench command", {
    scenario: ["approval"],
    during: async (since) => {
      const event = await client.waitFor((e) => approvalId(e) !== undefined, 30_000, "approval request", since);
      const id = approvalId(event) ?? "";
      print("5 approval raised", { event: event.event, payload: event.payload });
      const params = { id, kind: "exec", decision: "allow-once" };
      resolved = await client.request("approval.resolve", params);
      print("5 approval.resolve", { params, result: resolved });
    },
  });
  print("5 approval turn", { final: approval.final.payload });
  check(field(resolved, "applied") === true, "approval.resolve did not apply");

  let answered: Json = null;
  const question = await turn(client, key, "ask me something", {
    scenario: ["question"],
    during: async (since) => {
      const event = await client.waitFor((e) => e.event === "question.requested", 30_000, "question request", since);
      const id = field(event.payload, "id") ?? field(event.payload, "question", "id");
      print("6 question raised", { event: event.event, payload: event.payload });
      check(typeof id === "string", "question.requested carried no id");
      const params = { id, answers: { answers: { greeting: ["hello"] } } };
      answered = await client.request("question.resolve", params);
      print("6 question.resolve", { params, result: answered });
    },
  });
  print("6 question turn", { final: question.final.payload });
  check(field(answered, "status") === "answered", "question.resolve did not answer the question");
  return key;
}

const client = await connect();
try {
  const key = await smoke(client);
  console.log(`smoke: passed (session ${key})`);
} catch (error) {
  console.error(`smoke: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  client.close();
}
