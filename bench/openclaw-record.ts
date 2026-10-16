/* records the wire fixtures the rust decoders are held to
   (docs/openclaw.md, 2.3 and 2.4), from the running dev gateway, into
   server/tests/fixtures/openclaw/, one file per scenario:

     hello-ok.json                 the connect response frame
     sessions-list.json            a sessions.list answer with rows of both agents
     transcript-<scenario>.json    chat.history of a session that ran the
                                   scenario: text, thinking, tools (call and
                                   result), image, attachment (an inbound image
                                   and voice note), tts (a voice reply), reply-to,
                                   reset (a /new boundary), compaction
     approval-events.json          every event frame of an exec approval, raised,
                                   resolved and settled
     question-events.json          every event frame of an ask_user question
     chat-events-<scenario>.json   the live chat frames of a scenario

   every file is scrubbed before it is written: the checkout path, the home
   dir, the user and host names and the bench token become placeholders
   (rule 12). run: bun bench/openclaw-record.ts [scenario...] */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { DOT_PNG, ROOT } from "../scripts/openclaw-pinned";
import { BENCH, connect, print, readToken, turn } from "./openclaw-bench";
import { CONTROL, rawText } from "./openclaw-script";
import { type EventFrame, field, type GatewayClient, type Json } from "./openclaw-client";

const OUT = join(ROOT, "server/tests/fixtures/openclaw");
mkdirSync(OUT, { recursive: true });

const SCRUB: [string, string][] = [
  [readToken(), "<bench-token>"],
  [ROOT, "/bench/checkout"],
  [homedir(), "/home/bench"],
  [hostname(), "bench-host"],
  [hostname().replace(/\.local$/, ""), "bench-host"],
  [userInfo().username, "bench"],
];

/** the private patterns scripts/check-public.sh reads: $BOXBOX_PRIVATE_PATTERN or private/check-patterns.txt
    (gitignored), one extended regex per line, so the words never live in tracked code */
const PRIVATE: RegExp[] = (() => {
  const file = join(ROOT, "private/check-patterns.txt");
  const source = process.env.BOXBOX_PRIVATE_PATTERN ?? (existsSync(file) ? readFileSync(file, "utf8") : "");
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => new RegExp(line, "i"));
})();

export function scrub(text: string): string {
  let out = text;
  for (const [from, to] of SCRUB) if (from.length > 2) out = out.split(from).join(to);
  /* the presence snapshot names the machine: its lan address and hardware model */
  out = out.replace(/\b(?!127\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (ip) => (/^(10|172|192|100)\./.test(ip) ? "192.0.2.10" : ip));
  out = out.replace(/"modelIdentifier": "[^"]*"/g, '"modelIdentifier": "Mac00,0"');
  return out;
}

export function save(name: string, value: unknown) {
  const text = scrub(`${JSON.stringify(value, null, 2)}\n`);
  for (const pattern of PRIVATE) {
    if (pattern.test(text)) throw new Error(`${name} still matches a private pattern after scrubbing; not written`);
  }
  writeFileSync(join(OUT, name), text);
  console.log(`record: wrote server/tests/fixtures/openclaw/${name} (${text.length} bytes)`);
}

function writeControl(control: object) {
  writeFileSync(CONTROL, `${JSON.stringify({ scriptVersion: `record-${Date.now()}`, default: { text: "ok, noted." }, ...control }, null, 2)}\n`);
}

/** a reasoning item before the answer, as a reasoning model streams it */
function thinkingEntry(): Json {
  const n = Date.now().toString(36);
  const reasoning = { type: "reasoning", id: `rs_bench_${n}`, summary: [{ type: "summary_text", text: "the person wants a short answer, so one line will do." }] };
  const text = (rawText("one line, after thinking.") as { events: Record<string, Json>[] }).events;
  const message = text.find((e) => e.type === "response.output_item.done")?.item ?? null;
  return {
    events: [
      { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: reasoning.id, output_index: 0, summary_index: 0, delta: reasoning.summary[0]?.text ?? "" },
      { type: "response.reasoning_summary_text.done", item_id: reasoning.id, output_index: 0, summary_index: 0, text: reasoning.summary[0]?.text ?? "" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      ...text.filter((e) => e.type !== "response.completed").map((e) => ({ ...e, output_index: 1 })),
      { type: "response.completed", response: { id: `resp_bench_${n}`, status: "completed", output: [reasoning, message], usage: { input_tokens: 64, output_tokens: 32, total_tokens: 96 } } },
    ],
  };
}

async function session(client: GatewayClient, label: string, agentId = "main"): Promise<string> {
  const created = await client.request("sessions.create", { agentId, label: `record ${label} ${Date.now()}` });
  const key = field(created, "key");
  if (typeof key !== "string") throw new Error(`sessions.create answered no key: ${JSON.stringify(created)}`);
  return key;
}

async function history(client: GatewayClient, key: string): Promise<Json> {
  return client.request("chat.history", { sessionKey: key, limit: 200, maxChars: 500000 });
}

/** media blocks (a tts voice, a MEDIA image) join the assistant row after the run's final event, so wait for one */
async function historyWith(client: GatewayClient, key: string, block: string): Promise<Json> {
  for (let i = 0; i < 40; i++) {
    const page = await history(client, key);
    if (JSON.stringify(field(page, "messages")).includes(`"type":"${block}"`)) return page;
    await Bun.sleep(500);
  }
  throw new Error(`no ${block} block reached ${key} within 20 s`);
}

/** a maintenance verb right after a final event can meet "has an active run"; retry for a while */
async function whenIdle(client: GatewayClient, method: string, params: Json): Promise<Json> {
  for (let i = 0; ; i++) {
    const res = await client.raw(method, params, 60_000);
    if (res.ok) return res.payload ?? null;
    if (i >= 40 || !JSON.stringify(res.error).includes("active run")) throw new Error(`${method} failed: ${JSON.stringify(res.error)}`);
    await Bun.sleep(500);
  }
}

type Scenario = (client: GatewayClient) => Promise<void>;

function chatEvents(events: EventFrame[]): EventFrame[] {
  return events.filter((e) => e.event === "chat" || e.event === "session.message" || e.event.startsWith("sessions."));
}

const scenarios: Record<string, Scenario> = {
  async text(client) {
    const key = await session(client, "text");
    const t = await turn(client, key, "say a few words", { scenario: ["words", "16", "5"] });
    save("chat-events-text.json", chatEvents(t.events));
    save("transcript-text.json", await history(client, key));
  },
  async thinking(client) {
    const key = await session(client, "thinking");
    writeControl({ responses: [thinkingEntry()] });
    await turn(client, key, "think, then answer");
    save("transcript-thinking.json", await history(client, key));
  },
  async tools(client) {
    const key = await session(client, "tools");
    await turn(client, key, "read the notes", { scenario: ["tools"] });
    save("transcript-tools.json", await history(client, key));
  },
  async image(client) {
    const key = await session(client, "image");
    await turn(client, key, "show me a picture", { scenario: ["image"] });
    save("transcript-image.json", await historyWith(client, key, "image"));
  },
  async attachment(client) {
    const key = await session(client, "attachment");
    const ogg = readFileSync(join(BENCH, "speech/clip.ogg")).toString("base64");
    await turn(client, key, "here is a picture and a voice note", {
      scenario: ["words", "6", "5"],
      extra: {
        attachments: [
          { type: "image", mimeType: "image/png", fileName: "dot.png", content: DOT_PNG },
          { type: "audio", mimeType: "audio/ogg", fileName: "note.ogg", content: ogg, durationMs: 1200 },
        ],
      },
    });
    save("transcript-attachment.json", await history(client, key));
  },
  async tts(client) {
    const key = await session(client, "tts");
    const t = await turn(client, key, "answer with your voice", { scenario: ["voice"] });
    save("chat-events-tts.json", chatEvents(t.events));
    save("transcript-tts.json", await historyWith(client, key, "audio"));
  },
  async reply(client) {
    const key = await session(client, "reply");
    await turn(client, key, "quote me", { scenario: ["reply"] });
    /* and boxbox's own quote: a send with replyToId naming the agent's row (docs/openclaw.md, 7.12) */
    const rows = field(await history(client, key), "messages");
    const quoted = Array.isArray(rows) ? field(rows.at(-1), "__openclaw", "id") : undefined;
    await turn(client, key, "replying to your answer", { scenario: ["words", "4", "0"], extra: { replyToId: typeof quoted === "string" ? quoted : "" } });
    save("transcript-reply.json", await history(client, key));
  },
  async reset(client) {
    const key = await session(client, "reset");
    await turn(client, key, "before the reset", { scenario: ["words", "6", "5"] });
    const reset = await whenIdle(client, "sessions.reset", { key, reason: "new" });
    print("record: sessions.reset", reset);
    await turn(client, key, "after the reset", { scenario: ["words", "6", "5"] });
    save("transcript-reset.json", await history(client, key));
  },
  async compaction(client) {
    const key = await session(client, "compaction");
    for (let i = 0; i < 3; i++) await turn(client, key, `turn ${i}`, { scenario: ["words", "20", "0"] });
    writeControl({ responses: [{ text: "## summary\nthree scripted turns of words; nothing else happened." }] });
    const compacted = await whenIdle(client, "sessions.compact", { key });
    print("record: sessions.compact", compacted);
    await turn(client, key, "after compaction", { scenario: ["words", "6", "5"] });
    save("transcript-compaction.json", await history(client, key));
  },
  async approval(client) {
    const key = await session(client, "approval");
    const t = await turn(client, key, "run the bench command", {
      scenario: ["approval"],
      during: async (since) => {
        const event = await client.waitFor((e) => e.event === "exec.approval.requested" || e.event === "session.approval", 30_000, "approval", since);
        const id = field(event.payload, "id") ?? field(event.payload, "approval", "id");
        await client.request("approval.resolve", { id: id ?? "", kind: "exec", decision: "allow-once" });
      },
    });
    await Bun.sleep(500);
    const since = client.events.indexOf(t.events[0] ?? (client.events.at(-1) as EventFrame));
    save("approval-events.json", client.events.slice(Math.max(0, since)).filter((e) => e.event.includes("approval")));
    save("transcript-approval.json", await history(client, key));
  },
  async question(client) {
    const key = await session(client, "question");
    const t = await turn(client, key, "ask me something", {
      scenario: ["question"],
      during: async (since) => {
        const event = await client.waitFor((e) => e.event === "question.requested", 30_000, "question", since);
        const id = field(event.payload, "id");
        await client.request("question.resolve", { id: id ?? "", answers: { answers: { greeting: ["hello"] } } });
      },
    });
    await Bun.sleep(500);
    const since = client.events.indexOf(t.events[0] ?? (client.events.at(-1) as EventFrame));
    save("question-events.json", client.events.slice(Math.max(0, since)).filter((e) => e.event.startsWith("question.")));
    save("transcript-question.json", await history(client, key));
  },
};

const client = await connect();
try {
  const helloFrame = { type: "res", ok: true, payload: client.hello };
  save("hello-ok.json", helloFrame);
  const wanted = process.argv.slice(2);
  for (const [name, run] of Object.entries(scenarios)) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    try {
      await run(client);
    } catch (error) {
      console.error(`record: ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  /* a second agent's session, so the rows show both */
  const helper = await session(client, "helper", "helper");
  await turn(client, helper, "hello helper", { scenario: ["words", "4", "5"] });
  save("sessions-list.json", await client.request("sessions.list", { limit: 50, includeLastMessage: true }));
} finally {
  client.close();
}
