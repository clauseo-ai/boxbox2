/* the trace model: a scripted stand-in for the anthropic messages api, for
   the harness cmx serve the board traces are recorded against.

   the board only ever sees what the server makes of a session: a reply that
   leaves it unread, a permission it waits on, a question with options, a
   turn still streaming. this model produces exactly those, the same way
   every run, so the only thing that differs between a recording and its
   replay is the build under test. it speaks v1 cmx's tool names
   (`exec_command` asks the `bash` permission, `question` needs
   OPENCODE_ENABLE_QUESTION_TOOL); a world for another daemon passes its own
   with --shell-tool.

   the script is picked by a marker in the turn's prompt:

     [trace:reply]          a one-line reply, which leaves the thread unread
     [trace:permission]     one shell command that has to be allowed, then
                            a one-line reply once it has run or been refused
     [trace:question N]     one question with N options (1 to 9), then a
                            one-line reply once it is answered
     [trace:work N MS]      stream N words, one every MS milliseconds
     anything else          a one-line reply (cmx's own title and summary
                            calls land here)

   run: bun board/trace/model.ts --port 4881 [--shell-tool exec_command] */

/* a module, not a script: its names stay out of the global scope the rest
   of the typecheck shares */
export {};

type Block = { type: string; text?: string };
type Message = { role: "user" | "assistant"; content: string | Block[] };
type MessagesRequest = { messages?: Message[]; model?: string };
type Call = { name: string; input: unknown };
type Step = { kind: "tool"; lead: string; call: Call } | { kind: "words"; words: string[]; everyMs: number };

/** every reply starts this long after the request: a fixed think time,
    so the board's working frame for a turn holds long enough to be
    compared, the same on every run, instead of for however long the
    first token happened to take */
const THINK_MS = 400;
/** and a tool call follows its lead sentence after this pause, for the
    same reason: the key lifts on the sentence's tokens, and that frame has
    to hold before the ask replaces it */
const LEAD_MS = 300;

const OPTION_LABELS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}

const SHELL_TOOL = arg("--shell-tool", "exec_command");

/** the prompt that started this turn, and where it sits */
function prompt(messages: Message[]): { text: string; index: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
    if (text.trim().length > 0) return { text, index: i };
  }
  return { text: "", index: -1 };
}

/** has the daemon answered this turn's tool call yet */
function answered(messages: Message[], index: number): boolean {
  return messages
    .slice(index + 1)
    .some((m) => m.role === "user" && typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result"));
}

const words = (text: string): Step => ({ kind: "words", words: text.split(" "), everyMs: 5 });

function script(request: MessagesRequest): Step {
  const messages = request.messages ?? [];
  const { text, index } = prompt(messages);
  if (text.includes("[trace:permission]")) {
    if (answered(messages, index)) return words("the command ran.");
    return { kind: "tool", lead: "one command first.", call: { name: SHELL_TOOL, input: { cmd: "echo trace" } } };
  }
  const question = /\[trace:question (\d)\]/.exec(text);
  if (question) {
    if (answered(messages, index)) return words("noted, thanks.");
    const count = Math.max(1, Math.min(9, Number(question[1])));
    const options = OPTION_LABELS.slice(0, count).map((label) => ({ label, description: `pick ${label}` }));
    return {
      kind: "tool",
      lead: "one choice is yours.",
      call: { name: "question", input: { questions: [{ question: "which one?", header: "pick", options }] } },
    };
  }
  const work = /\[trace:work (\d+) (\d+)\]/.exec(text);
  if (work) {
    const count = Number(work[1]);
    return { kind: "words", words: Array.from({ length: count }, (_, i) => `word${i + 1}`), everyMs: Number(work[2]) };
  }
  return words("done, the thread is yours.");
}

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

let serial = 0;

function stream(step: Step, model: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `msg_trace_${++serial}`;
  return new ReadableStream({
    async start(controller) {
      await Bun.sleep(THINK_MS);
      const send = (type: string, data: Record<string, unknown>) => {
        if (!signal.aborted) controller.enqueue(encoder.encode(sse(type, data)));
      };
      const usage = { input_tokens: 64, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      send("message_start", {
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
      });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      let output = 0;
      if (step.kind === "tool") {
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: step.lead } });
        send("content_block_stop", { index: 0 });
        await Bun.sleep(LEAD_MS);
        const toolId = `toolu_trace_${serial}`;
        send("content_block_start", { index: 1, content_block: { type: "tool_use", id: toolId, name: step.call.name, input: {} } });
        send("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.call.input) } });
        send("content_block_stop", { index: 1 });
        output = 16;
      } else {
        for (const [i, word] of step.words.entries()) {
          if (signal.aborted) break;
          send("content_block_delta", { index: 0, delta: { type: "text_delta", text: i === 0 ? word : ` ${word}` } });
          output += 1;
          if (step.everyMs > 0) await Bun.sleep(step.everyMs);
        }
        send("content_block_stop", { index: 0 });
      }
      send("message_delta", {
        delta: { stop_reason: step.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: output },
      });
      send("message_stop", {});
      if (!signal.aborted) controller.close();
    },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(arg("--port", "4881")),
  idleTimeout: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response("the trace model answers POST /v1/messages\n", { status: 404 });
    const body = (await req.json()) as MessagesRequest;
    const step = script(body);
    const shape = step.kind === "tool" ? `tool ${step.call.name}` : `${step.words.length} words`;
    console.log(`trace model: turn with ${body.messages?.length ?? 0} messages -> ${shape}`);
    return new Response(stream(step, body.model ?? "trace", req.signal), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
console.log(`trace model listening on http://127.0.0.1:${server.port}`);
