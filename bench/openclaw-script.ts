/* the scripted model's control file, in named scenarios: boxbox's side of
   the pinned tree's scripts/e2e/mock-openai-server.mjs (docs/openclaw.md,
   11.5), in the style of bench/model.ts. the mock re-reads the file on
   every model request and consumes one entry of `responses` per request,
   then serves `default` (a short reply) for anything past the end.

   scenarios (each a list of model steps for one turn):

     words N MS     N words of text, MS ms between chunks
     long N         N words as fast as the gateway reads them (a long stream)
     big KIB        one reply of KIB kibibytes of text, sent as raw events
                    (past the mock's 100000-character text limit), for the
                    oversized-row proof
     tools          a `read` of notes.md, then a reply
     approval       an `exec` (tools.exec.mode "ask" raises an approval),
                    then a reply once it ran or was denied
     question       an `ask_user` with two options, then a reply
     image          a reply carrying `MEDIA: ./dot.png` (the bench writes the png
                    into each workspace), which the gateway turns into an image block
     voice          a reply with a `[[tts:text]]` block (tts.auto "tagged"),
                    which the speech stub voices
     reply          a reply quoting the person (`[[reply_to_current]]`)
     remind         the `automations` tool adding a one-shot reminder two
                    minutes out, then a reply (the reminder test)
     hold           the next response waits until the file is rewritten
     drop           the provider drops the socket mid-request
     fail STATUS    the provider answers STATUS (500 by default)

   run: bun bench/openclaw-script.ts <scenario> [args]  (writes .openclaw/bench/script.json)
   or import { script } and call script("approval") before a send. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** the bench's control file: OPENCLAW_BENCH names a bench dir, or OPENCLAW_PORT a bench other than 4740's
    (the pairing bench), as scripts/openclaw-pinned.ts names them */
const PORT = Number(process.env.OPENCLAW_PORT ?? 4740);
export const CONTROL = join(process.env.OPENCLAW_BENCH ?? join(ROOT, ".openclaw", PORT === 4740 ? "bench" : `bench-${PORT}`), "script.json");

type Event = Record<string, unknown>;
type Entry = { text: string; chunkDelayMs?: number } | { events: Event[] } | { fail: { mode: "drop" } | { status: number; message?: string } };
export interface Control {
  scriptVersion: string;
  responses: Entry[];
  default: Entry;
  hold?: boolean;
}

const WORDS = (
  "the gateway is real and only the model is scripted, so every row, event and approval here is the gateway's own. " +
  "the bench repeats the same turn every run, costs nothing and needs no key."
).split(" ");


let serial = 0;

/** a complete responses-api stream for one function call (the mock adds nothing to an `events` list) */
export function call(name: string, args: unknown): Entry {
  const n = `${Date.now().toString(36)}_${++serial}`;
  const item = { type: "function_call", id: `fc_bench_${n}`, call_id: `call_bench_${n}`, name, arguments: JSON.stringify(args) };
  return {
    events: [
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: { id: `resp_bench_${n}`, status: "completed", output: [item], usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 } },
      },
    ],
  };
}

/** a call to a tool behind the compact prompt surface: at 2026.10.1 the model sees read, write, edit, exec
    and a few more directly, and every other tool (ask_user, automations, ...) only through
    `tool_call {id, args}` ("tool-search: cataloged 56 tools behind compact prompt surface"); calling
    ask_user by name answers "Tool ask_user not found" */
export function catalogCall(name: string, args: unknown): Entry {
  return call("tool_call", { id: name, args });
}

/** a complete responses-api stream for a text reply in pieces of `size` characters */
export function rawText(text: string, size = 4096): Entry {
  const n = `${Date.now().toString(36)}_${++serial}`;
  const id = `msg_bench_${n}`;
  const done = { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const deltas: Event[] = [];
  for (let at = 0; at < text.length; at += size) {
    deltas.push({ type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text.slice(at, at + size) });
  }
  return {
    events: [
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id, role: "assistant", content: [], status: "in_progress" } },
      ...deltas,
      { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text },
      { type: "response.output_item.done", output_index: 0, item: done },
      { type: "response.completed", response: { id: `resp_bench_${n}`, status: "completed", output: [done], usage: { input_tokens: 64, output_tokens: 64, total_tokens: 128 } } },
    ],
  };
}

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => WORDS[i % WORDS.length] ?? "word").join(" ");
}

/** the model steps of one scenario */
export function steps(name: string, args: string[] = []): { responses: Entry[]; hold?: boolean } {
  const num = (i: number, fallback: number) => {
    const value = Number(args[i] ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name}: argument ${i + 1} must be a number, not ${args[i]}`);
    return value;
  };
  switch (name) {
    case "words":
      return { responses: [{ text: words(num(0, 40)), chunkDelayMs: num(1, 20) }] };
    case "long":
      return { responses: [{ text: words(num(0, 2000)), chunkDelayMs: 0 }] };
    case "big": {
      const bytes = num(0, 160) * 1024;
      const line = "the oversized row: a scripted reply past the history cap, so chat.history answers a placeholder.\n";
      return { responses: [rawText(line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes))] };
    }
    case "tools":
      return { responses: [call("read", { path: "notes.md" }), { text: "read the notes: one greeting line, nothing else." }] };
    case "approval":
      return { responses: [call("exec", { command: "echo bench-approval" }), { text: "the command ran, or was refused; either way the turn is over." }] };
    case "question":
      return {
        responses: [
          catalogCall("ask_user", {
            questions: [
              {
                id: "greeting",
                header: "greeting",
                question: "which greeting should the notes use?",
                options: [{ label: "hello", description: "the plain one" }, { label: "hi", description: "the short one" }],
              },
            ],
            timeoutSeconds: 600,
          }),
          { text: "noted the greeting you picked." },
        ],
      };
    case "image":
      return { responses: [{ text: "here is the picture.\nMEDIA: ./dot.png" }] };
    case "voice":
      return { responses: [{ text: "a voice reply follows.\n[[tts:text]]the bench speaks this line.[[/tts:text]]" }] };
    case "reply":
      return { responses: [{ text: "[[reply_to_current]] answering the message you sent." }] };
    case "remind": {
      const at = new Date(Date.now() + 2 * 60_000).toISOString();
      return {
        responses: [
          catalogCall("automations", {
            action: "add",
            job: { name: "bench reminder", schedule: { kind: "at", at }, payload: { kind: "systemEvent", text: "reminder: the bench asked two minutes ago." } },
          }),
          { text: "i will remind you in two minutes." },
        ],
      };
    }
    case "hold":
      return { responses: [{ text: words(num(0, 40)), chunkDelayMs: 20 }], hold: true };
    case "drop":
      return { responses: [{ fail: { mode: "drop" } }] };
    case "fail":
      return { responses: [{ fail: { status: num(0, 500), message: "the scripted provider failed on purpose" } }] };
    default:
      throw new Error(`unknown scenario ${name}: words, long, big, tools, approval, question, image, voice, reply, remind, hold, drop, fail`);
  }
}

/** writes the control file for one scenario; a fresh scriptVersion restarts the mock's slot counter */
export function script(name: string, ...args: string[]): Control {
  const { responses, hold } = steps(name, args);
  const control: Control = {
    scriptVersion: `${name}-${Date.now()}-${++serial}`,
    responses,
    default: { text: "ok, noted." },
    ...(hold ? { hold: true } : {}),
  };
  write(control);
  return control;
}

/** releases a held response, keeping the script and its position */
export function release(control: Control) {
  write({ ...control, hold: false });
}

function write(control: Control) {
  mkdirSync(dirname(CONTROL), { recursive: true });
  writeFileSync(CONTROL, `${JSON.stringify(control, null, 2)}\n`);
}

if (import.meta.main) {
  const [name, ...args] = process.argv.slice(2);
  if (!name) {
    console.error("usage: bun bench/openclaw-script.ts <scenario> [args]");
    process.exit(2);
  }
  try {
    const control = script(name, ...args);
    console.log(`script: ${name} (${control.responses.length} steps${control.hold ? ", held" : ""}) -> ${CONTROL}`);
  } catch (error) {
    console.error(`script: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
