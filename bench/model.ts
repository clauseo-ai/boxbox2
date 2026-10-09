/* the bench model: a scripted stand-in for the anthropic messages api.

   boxbox never talks to it. the cmx2 dev daemon does, in place of a real
   provider, so the scripted session in docs/verification.md is the same
   run every time, costs nothing, and needs no key. everything boxbox sees
   (events, routes, the daemon's tool calls, its asks and queue) is the real
   daemon's; only the model's words and choices are scripted.

   the script is picked by a marker in the turn's prompt:

     [bench:tools]            read notes.md, edit it, run a shell command,
                              ask a question, then answer in prose once the
                              question is answered
     [bench:words N MS]       stream N words, one every MS milliseconds
     [bench:glyphs N MS]      the same with words outside ascii, some past
                              the basic plane, so utf-16 offsets differ
                              from code points and bytes
     [bench:bulk N SIZE]      N deltas of SIZE characters, as fast as the
                              daemon reads them
     [bench:asks]             read one.env and two.env (each asks
                              permission) and ask two questions, all as
                              parallel calls in one step, then answer
     [bench:slow]             a shell command printing a 900 byte line a
                              second for 6 seconds, then answer
     [bench:park]             start `sleep 30` as a background job, then
                              end the turn, which parks the session on it
     [bench:work N MS FILE]   a window's worth of work: read README.md and
                              FILE, edit FILE, run `wc -l FILE`, each step
                              a second apart, then stream N words, one
                              every MS milliseconds (home's fixtures and
                              budget run, bench/windows.ts)
     [bench:code MS]          run `ls README.md notes.md | sort` (a command with
                              output), then stream a reply with fenced code (a
                              typescript block, a bash one, a diff and one with
                              no language), a few characters every MS
                              milliseconds, so a block is written under the
                              reader's eye (the code blocks' real loop,
                              docs/thread.md)
     [bench:agent]            spawn a subagent whose brief streams three
                              words, then answer; the subagent's turn ends
                              on its own (the push matrix's subagent row)
     [bench:think N MS]       a native turn with extended thinking: a step
                              that streams N thinking words, one every MS
                              milliseconds, then runs `git status`; then a
                              step that thinks the same way and streams N
                              words of answer, so reasoning and text parts
                              share one message as they do with a real model
     [bench:agent N MS]       the same, the subagent streaming N words one
                              every MS milliseconds, so the parent sits
                              parked on it long enough to watch
     [bench:agent-wait N MS]  spawn that subagent, then sit in `wait` for
                              its report (the parent stays busy, waiting
                              on agents, not parked), then answer
     [bench:pack N MS]        start two such subagents from one `run`
                              script (`agents.spawn` twice), as a lead
                              starting a pack does, then answer
     [bench:review FILE]      in a checkout: commit FILE, start a helper
                              that reports after the turn ends, then call
                              request_review with a note (the review card)
     [bench:long K A T]       turn K of a long thread (bench/long.ts), shaped
                              from K, A and T alone so the same turn is the
                              same every run: two to four tool steps (read,
                              grep, shell, glob), every third turn also writes
                              a 20 to 60 KB file, reads it back and edits it,
                              every fourth thinks first, K % 10 = 7 also reads
                              a file that is not there (a failed, open row),
                              and the answer is long markdown with fenced
                              code, 2 to 7 KB, as fast as it is read. A
                              subagents, each running `[bench:steps N]`, are
                              spawned evenly over the T turns but the last 12
                              (none without A and T), which stay ordinary
     [bench:steps N]          N small tool steps (read, shell, grep, glob in
                              turn, a thought on every fourth), then a short
                              answer: a subagent that lives for ~N messages
     anything else            a one-line reply

   a request to compact the context (the daemon asks with a summary
   instruction as the last user message) is answered with a fixed summary
   under the sections it asks for, so a thread long enough to compact is
   not left with a degenerate summary.

   the probes for cmx2's asks (probes/) use think, agent N MS, agent-wait,
   pack and review.

   run: bun bench/model.ts --port 4841 */

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: string };

type Message = { role: "user" | "assistant"; content: string | Block[] };

type MessagesRequest = { messages?: Message[]; model?: string };

type Call = { name: string; input: unknown };

/** a thinking block streamed before the step's other blocks, as extended thinking sends it */
type Think = { words: string[]; everyMs: number };

/** what the model does this turn: tool calls (run in parallel by the daemon), or words; either may think first.
    a tool step with an empty lead sends no text block, as a model that only thinks before its call does */
type Step = ({ kind: "tool"; lead: string; calls: Call[]; pauseMs?: number } | { kind: "words"; words: string[]; everyMs: number; /** the pieces are sent as they are, with no space put between them */ raw?: boolean }) & { think?: Think };

const THOUGHTS = (
  "the person wants the current state. the quickest honest answer comes from git, so i will read the " +
  "status first, then say what is committed, what is not, and what still needs a decision from them."
).split(" ");

const WORDS = (
  "the notes now greet in the voice you picked. the edit touched one line, the shell run " +
  "counted the file, and nothing else changed. the change is small on purpose: one file, " +
  "one greeting, easy to review and easy to undo if the other greeting reads better later."
).split(" ");

/* a two-unit utf-16 glyph (the treble clef, past the basic plane) beside
   accented and cjk words, so offsets in utf-16 units, code points and bytes
   all disagree */
const GLYPHS = ["naïve", "\u{1D11E}", "clef", "résumé", "日本語", "plain"];

/* a reply with code in it, sent a few characters at a time: what an agent says after a command, with the fenced blocks a thread has to dress */
const CODE_REPLY = [
  "the retry now backs off instead of hammering the daemon. the change is one function:",
  "",
  "```ts",
  "export async function withRetry<T>(run: () => Promise<T>, tries = 4): Promise<T> {",
  "  for (let attempt = 1; ; attempt++) {",
  "    try {",
  "      return await run();",
  "    } catch (error) {",
  "      if (attempt >= tries) throw error;",
  "      await new Promise((r) => setTimeout(r, 125 * 2 ** attempt));",
  "    }",
  "  }",
  "}",
  "```",
  "",
  "run the suite, then the one test that covers it:",
  "",
  "```bash",
  "bun test app/src/net  # 118 pass",
  "bun test app/src/net/retry.test.ts -t \"backs off\"",
  "```",
  "",
  "and the call site:",
  "",
  "```diff",
  "-  const res = await fetch(url);",
  "+  const res = await withRetry(() => fetch(url));",
  "```",
  "",
  "the line the log prints when it gives up:",
  "",
  "```",
  "net: desk did not answer after 4 tries (250 ms, 500 ms, 1 s)",
  "```",
  "",
  "that is all of it.",
].join("\n");

const SLOW_SHELL = "for i in 1 2 3 4 5 6; do printf 'tick %s %0900d\\n' \"$i\" 0; sleep 1; done";

function question(text: string, header: string, labels: [string, string]): unknown {
  return {
    questions: [
      {
        question: text,
        header,
        options: labels.map((label) => ({ label, description: `answer ${label}` })),
      },
    ],
  };
}

function cycle(pool: string[], count: number, everyMs: number): Step {
  return { kind: "words", words: Array.from({ length: count }, (_, i) => pool[i % pool.length] ?? "word"), everyMs };
}

/** one step of tool calls, then prose once every result is back */
function calls(messages: Message[], index: number, lead: string, list: Call[], after: string[]): Step {
  return resultsSince(messages, index) === 0 ? { kind: "tool", lead, calls: list } : { kind: "words", words: after, everyMs: 5 };
}

/** the prompt that started this turn: the last user message with text */
function prompt(messages: Message[]): { text: string; index: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    if (text.trim().length > 0) return { text, index: i };
  }
  return { text: "", index: -1 };
}

/** tool results the daemon has sent back since the prompt */
function resultsSince(messages: Message[], index: number): number {
  let n = 0;
  for (const message of messages.slice(index + 1)) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    n += message.content.filter((b) => b.type === "tool_result").length;
  }
  return n;
}

/* ---------- the long thread (bench/long.ts) ---------- */

/** what the daemon asks for when it compacts: the last user message starts with this (cmx2's SUMMARY_INSTRUCTION) */
const SUMMARY_ASK = "the context is about to be compacted";

const SUMMARY = [
  "## goal",
  "- keep the long bench thread going: scripted turns that read, search, write and answer.",
  "## constraints and preferences",
  "- answers are lowercase and plain; files go under scratch/; nothing leaves the project directory.",
  "## done",
  "- many turns of reading notes.md, searching it, writing scratch files and editing them; each answered in markdown.",
  "## in progress",
  "- the next scripted turn.",
  "## blocked",
  "- (none)",
  "## key decisions",
  "- scratch files are written whole and edited once, at their first line.",
  "## ruled out",
  "- (none)",
  "## live state",
  "- the project directory holds notes.md and a scratch/ folder of generated files; no job is running.",
  "## next steps",
  "- answer the next prompt the same way.",
  "## critical context",
  "- this is a stand-in model: its words are scripted, the daemon's tools are real.",
  "## relevant files",
  "- notes.md, scratch/",
].join("\n");

/** a deterministic pseudo-random number from a seed: the same turn is the same turn on every run */
function hash(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** a file of about `bytes` characters that reads like source, first line `# long K` (the edit's anchor) */
function bigFile(k: number, bytes: number): string {
  const lines = [`# long ${k}`, ""];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `export function step${k}_${i}(input: Record<string, number>, scale = ${(i % 7) + 1}): number { return Object.values(input).reduce((sum, value) => sum + value * scale + ${hash(k * 977 + i) % 1000}, 0); }`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

const FENCES: string[] = [
  "```ts\nexport function window<T>(items: T[], from: number, count: number): T[] {\n  const start = Math.max(0, Math.min(from, items.length - count));\n  return items.slice(start, start + count);\n}\n```",
  "```bash\nbun test app/src/sync --bail\ncargo test --locked -p boxbox transcript\n```",
  "```diff\n-  for (const turn of turns()) mount(turn);\n+  for (const turn of visibleTurns()) mount(turn);\n```",
  "```json\n{ \"turns\": 150, \"messages\": 760, \"children\": 30, \"bytes\": 3400000 }\n```",
  "```rust\nfn page(messages: &[Message], from: usize, count: usize) -> &[Message] {\n    let end = (from + count).min(messages.len());\n    &messages[from.min(end)..end]\n}\n```",
];

const SENTENCES: string[] = [
  "the transcript is read once and kept in the worker, so the page asks for a thread only when someone opens it.",
  "a turn outside the viewport is one empty box of its measured height, which keeps the scroll bar honest.",
  "nothing here is cached by guess: each page of messages carries the epoch it was read under.",
  "the first frame comes from the cache and the fetch behind it replaces what changed, in place, with no motion.",
  "a long answer is mostly prose, with a table or a block where the numbers or the code are easier to read than to describe.",
  "the agents this thread started are held by the worker while it is on stage, so the tape can draw their lanes.",
  "that is the whole change, and it is small enough to review in one sitting.",
];

/** a long markdown answer, 2 to 7 KB, headings, lists, a table and fenced code, from K alone */
function answer(k: number): string {
  const parts: string[] = [`## turn ${k}: what changed`, ""];
  const sections = 2 + (hash(k) % 4);
  for (let s = 0; s < sections; s++) {
    parts.push(`### part ${s + 1}`, "");
    for (let i = 0; i < 4 + (hash(k * 31 + s) % 4); i++) parts.push(SENTENCES[hash(k * 131 + s * 17 + i) % SENTENCES.length] ?? "");
    parts.push("");
    parts.push(...Array.from({ length: 3 + (hash(k + s) % 3) }, (_, i) => `- point ${i + 1} of part ${s + 1}: ${SENTENCES[hash(k * 7 + s * 5 + i) % SENTENCES.length] ?? ""}`), "");
    parts.push(FENCES[hash(k * 3 + s) % FENCES.length] ?? "", "");
  }
  parts.push("| step | ms | long tasks |", "|---|---|---|", ...Array.from({ length: 4 }, (_, i) => `| ${i + 1} | ${20 + (hash(k + i) % 400)} | ${hash(k * 5 + i) % 3} |`), "");
  parts.push("that is all of it.");
  return parts.join("\n");
}

/** a long answer sent in pieces, as fast as the daemon reads them */
function poured(text: string): Step {
  return { kind: "words", words: text.match(/[\s\S]{1,64}/g) ?? [], everyMs: 0, raw: true };
}

function thoughtOf(k: number, words: number): Think {
  return { words: Array.from({ length: words }, (_, i) => THOUGHTS[(i + k) % THOUGHTS.length] ?? "thought"), everyMs: 0 };
}

/** the small tool call a step kind stands for; the reads and searches all land on notes.md */
function small(kind: string, k: number): Call {
  switch (kind) {
    case "grep":
      return { name: "grep", input: { pattern: "greeting", path: "notes.md", literal: true } };
    case "shell":
      return { name: "shell", input: { command: `wc -l notes.md && echo turn ${k}` } };
    case "glob":
      return { name: "glob", input: { pattern: "*.md" } };
    default:
      return { name: "read", input: { path: "notes.md" } };
  }
}

const SMALL_KINDS = ["read", "grep", "shell", "glob"];

/** the ordinary turns a long thread ends with: no agent is started in them (bench/long.ts's TAIL) */
const LONG_TAIL = 12;

/** turn K of the long thread: its tool steps, then its answer */
function longTurn(k: number, agents: number, turns: number, done: number): Step {
  const steps: Step[] = [];
  const file = `scratch/long-${k}.md`;
  // `agents` subagents spread evenly over the thread's turns but its last TAIL, which are ordinary turns, so a thread opened
  // at its end shows real rows and not a run of reports (bench/long.ts has the same span: it waits for the agents to report
  // between blocks, so the reports land in the middle of the thread)
  const span = turns > 2 * LONG_TAIL ? turns - LONG_TAIL : turns;
  const spawns = k < span && Math.floor(((k + 1) * agents) / span) > Math.floor((k * agents) / span);
  if (spawns) steps.push({ kind: "tool", lead: "handing the sweep to a helper.", calls: [{ name: "spawn", input: { brief: "[bench:steps 105] a subagent's turn", name: `helper_${k}` } }] });
  const count = [2, 3, 3, 4][k % 4] ?? 3;
  if (k % 3 === 0) {
    const bytes = 20_000 + (hash(k) % 40_000);
    steps.push({ kind: "tool", lead: "writing it down in full.", calls: [{ name: "write", input: { path: file, content: bigFile(k, bytes) } }] });
    steps.push({ kind: "tool", lead: "reading it back.", calls: [{ name: "read", input: { path: file } }] });
    steps.push({ kind: "tool", lead: "marking it revised.", calls: [{ name: "edit", input: { path: file, old_text: `# long ${k}`, new_text: `# long ${k}, revised` } }] });
  }
  for (let i = steps.length; i < count + (spawns ? 1 : 0); i++) {
    const kind = SMALL_KINDS[(k + i) % SMALL_KINDS.length] ?? "read";
    steps.push({ kind: "tool", lead: `checking with ${kind}.`, calls: [small(kind, k)] });
  }
  // a step that fails, as real threads have: the daemon answers a tool error and the row is red and open
  if (k % 10 === 7) steps.push({ kind: "tool", lead: "looking for the old notes.", calls: [{ name: "read", input: { path: `missing-${k}.md` } }] });
  const first = steps[0];
  if (k % 4 === 0 && first?.kind === "tool") steps[0] = { ...first, think: thoughtOf(k, 14) };
  return steps[done] ?? { ...poured(answer(k)), ...(k % 4 === 0 ? { think: thoughtOf(k, 20) } : {}) };
}

/** the subagent's turn: N small steps, a thought on every fourth, then a short answer */
function stepsTurn(n: number, done: number): Step {
  if (done >= n) return { kind: "words", words: ["swept", "every", "step.", "nothing", "needs", "you."], everyMs: 0 };
  const kind = SMALL_KINDS[done % SMALL_KINDS.length] ?? "read";
  return { kind: "tool", lead: `step ${done + 1}.`, calls: [small(kind, done)], ...(done % 4 === 3 ? { think: thoughtOf(done, 10) } : {}) };
}

function script(request: MessagesRequest): Step {
  const messages = request.messages ?? [];
  const { text, index } = prompt(messages);
  if (text.startsWith(SUMMARY_ASK)) return poured(SUMMARY);
  const long = /\[bench:long (\d+)(?: (\d+) (\d+))?\]/.exec(text);
  if (long) return longTurn(Number(long[1]), Number(long[2] ?? 0), Number(long[3] ?? 1), resultsSince(messages, index));
  const sweep = /\[bench:steps (\d+)\]/.exec(text);
  if (sweep) return stepsTurn(Number(sweep[1]), resultsSince(messages, index));
  if (text.includes("[bench:tools]")) {
    const one = (lead: string, name: string, input: unknown): Step => ({ kind: "tool", lead, calls: [{ name, input }] });
    const tools: Step[] = [
      one("reading the notes first.", "read", { path: "notes.md" }),
      one("changing the greeting line.", "edit", { path: "notes.md", old_text: "greeting: hello", new_text: "greeting: pending" }),
      one("checking the file.", "shell", { command: "wc -l notes.md" }),
      one("one choice is yours.", "question", question("which greeting should the notes use?", "greeting", ["hello", "hi"])),
    ];
    return tools[resultsSince(messages, index)] ?? { kind: "words", words: WORDS, everyMs: 15 };
  }
  if (text.includes("[bench:asks]")) {
    const list = [
      { name: "read", input: { path: "one.env" } },
      { name: "read", input: { path: "two.env" } },
      { name: "question", input: question("which greeting?", "greeting", ["hello", "hi"]) },
      { name: "question", input: question("which closing?", "closing", ["bye", "later"]) },
    ];
    return calls(messages, index, "two files and two choices.", list, ["every", "ask", "settled."]);
  }
  if (text.includes("[bench:slow]")) {
    const list = [{ name: "shell", input: { command: SLOW_SHELL } }];
    return calls(messages, index, "a slow command.", list, ["the", "command", "finished."]);
  }
  const agent = /\[bench:agent(?: (\d+) (\d+))?\]/.exec(text);
  if (agent) {
    const brief = `[bench:words ${agent[1] ?? 3} ${agent[2] ?? 5}] a subagent's turn`;
    const list = [{ name: "spawn", input: { brief, name: "helper" } }];
    return calls(messages, index, "handing this to a helper.", list, ["the", "helper", "is", "on", "it."]);
  }
  const held = /\[bench:agent-wait (\d+) (\d+)\]/.exec(text);
  if (held) {
    const brief = `[bench:words ${held[1]} ${held[2]}] a subagent's turn`;
    const steps: Step[] = [
      { kind: "tool", lead: "handing this to a helper.", calls: [{ name: "spawn", input: { brief, name: "helper" } }] },
      { kind: "tool", lead: "waiting for it.", calls: [{ name: "wait", input: { timeout_ms: 600_000 } }] },
    ];
    return steps[resultsSince(messages, index)] ?? { kind: "words", words: ["the", "helper", "reported."], everyMs: 5 };
  }
  const pack = /\[bench:pack (\d+) (\d+)\]/.exec(text);
  if (pack) {
    /* the agents started from inside a run script, as a lead does for a pack: the daemon records one run part whose
       nested calls are the spawns, and no spawn part at all */
    const brief = `[bench:words ${pack[1]} ${pack[2]}] a subagent's turn`;
    const code = `const out = [];\nfor (const name of ["ink", "chrome"]) out.push((await agents.spawn({ brief: ${JSON.stringify(brief)}, seat: "engineer", name })).path);\nreturn out;`;
    const list = [{ name: "run", input: { code } }];
    return calls(messages, index, "starting the pack.", list, ["the", "pack", "is", "on", "it."]);
  }
  if (text.includes("[bench:park]")) {
    const list = [{ name: "shell", input: { command: "sleep 30", background: true } }];
    return calls(messages, index, "starting a job.", list, ["parked", "on", "the", "job."]);
  }
  const review = /\[bench:review (\S+)\]/.exec(text);
  if (review) {
    /* a checkout's agent commits a file, starts a helper that reports after this turn has ended (so the agent wakes on
       its own), then asks for review: the need must outlive that waking */
    const file = review[1] ?? "review.txt";
    const steps: Step[] = [
      { kind: "tool", lead: "committing the change.", calls: [{ name: "shell", input: { command: `printf 'from the checkout\\n' > ${file} && git add ${file} && git commit -qm 'add ${file}' && git log --oneline -1` } }] },
      { kind: "tool", lead: "a helper checks it.", calls: [{ name: "spawn", input: { brief: "[bench:words 20 250] a subagent's turn", name: "checker" } }] },
      { kind: "tool", lead: "ready for you.", calls: [{ name: "request_review", input: { note: `adds ${file}` } }] },
    ];
    return steps[resultsSince(messages, index)] ?? { kind: "words", words: ["asked", "for", "review."], everyMs: 5 };
  }
  const think = /\[bench:think (\d+) (\d+)\]/.exec(text);
  if (think) {
    const count = Number(think[1]);
    const thought: Think = { words: Array.from({ length: count }, (_, i) => THOUGHTS[i % THOUGHTS.length] ?? "thought"), everyMs: Number(think[2]) };
    if (resultsSince(messages, index) === 0) return { kind: "tool", lead: "", calls: [{ name: "shell", input: { command: "git status --short" } }], think: thought };
    return { ...cycle(WORDS, count, Number(think[2])), think: thought };
  }
  const work = /\[bench:work (\d+) (\d+) (\S+)\]/.exec(text);
  if (work) {
    const [, count, everyMs, file] = work as unknown as [string, string, string, string]; // three groups matched
    const steps: Step[] = [
      { kind: "tool", lead: "reading first.", calls: [{ name: "read", input: { path: "README.md" } }], pauseMs: 1000 },
      { kind: "tool", lead: "and the notes.", calls: [{ name: "read", input: { path: file } }], pauseMs: 1000 },
      { kind: "tool", lead: "changing the status line.", calls: [{ name: "edit", input: { path: file, old_text: "status: draft", new_text: "status: done" } }], pauseMs: 1000 },
      { kind: "tool", lead: "checking the file.", calls: [{ name: "shell", input: { command: `wc -l ${file}` } }], pauseMs: 1000 },
    ];
    return steps[resultsSince(messages, index)] ?? cycle(WORDS, Number(count), Number(everyMs));
  }
  const coded = /\[bench:code (\d+)\]/.exec(text);
  if (coded) {
    if (resultsSince(messages, index) === 0) return { kind: "tool", lead: "listing the files.", calls: [{ name: "shell", input: { command: "ls README.md notes.md | sort" } }] };
    return { kind: "words", words: CODE_REPLY.match(/[\s\S]{1,6}/g) ?? [], everyMs: Number(coded[1]), raw: true };
  }
  const glyphs = /\[bench:glyphs (\d+) (\d+)\]/.exec(text);
  if (glyphs) return cycle(GLYPHS, Number(glyphs[1]), Number(glyphs[2]));
  const bulk = /\[bench:bulk (\d+) (\d+)\]/.exec(text);
  if (bulk) return cycle(["x".repeat(Number(bulk[2]))], Number(bulk[1]), 0);
  const words = /\[bench:words (\d+) (\d+)\]/.exec(text);
  if (words) return cycle(WORDS, Number(words[1]), Number(words[2]));
  return { kind: "words", words: ["ok,", "noted."], everyMs: 5 };
}

let serial = 0;

function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function stream(step: Step, model: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `msg_bench_${++serial}`;
  return new ReadableStream({
    async start(controller) {
      const send = (type: string, data: Record<string, unknown>) => {
        if (!signal.aborted) controller.enqueue(encoder.encode(frame(type, data)));
      };
      const usage = { input_tokens: 64, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      send("message_start", {
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
      });
      let output = 0;
      /* extended thinking comes first, as its own block; the blocks after it are numbered on from it */
      let first = 0;
      if (step.think) {
        send("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
        for (const [i, word] of step.think.words.entries()) {
          if (signal.aborted) break;
          send("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: i === 0 ? word : ` ${word}` } });
          output += 1;
          if (step.think.everyMs > 0) await Bun.sleep(step.think.everyMs);
        }
        send("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: `bench-signature-${serial}` } });
        send("content_block_stop", { index: 0 });
        first = 1;
      }
      if (step.kind === "tool") {
        // a pause before the step reads like an agent thinking, and spaces the window's lines out in time
        if (step.pauseMs) await Bun.sleep(step.pauseMs);
        if (step.lead) {
          send("content_block_start", { index: first, content_block: { type: "text", text: "" } });
          send("content_block_delta", { index: first, delta: { type: "text_delta", text: step.lead } });
          send("content_block_stop", { index: first });
          first += 1;
        }
        for (const [i, call] of step.calls.entries()) {
          const index = first + i;
          const toolId = `toolu_bench_${serial}_${index}`;
          send("content_block_start", { index, content_block: { type: "tool_use", id: toolId, name: call.name, input: {} } });
          send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
          send("content_block_stop", { index });
        }
        output = 24;
      } else {
        send("content_block_start", { index: first, content_block: { type: "text", text: "" } });
        for (const [i, word] of step.words.entries()) {
          if (signal.aborted) break;
          send("content_block_delta", { index: first, delta: { type: "text_delta", text: i === 0 || step.raw ? word : ` ${word}` } });
          output += 1;
          if (step.everyMs > 0) await Bun.sleep(step.everyMs);
        }
        send("content_block_stop", { index: first });
      }
      const stop = step.kind === "tool" ? "tool_use" : "end_turn";
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } });
      send("message_stop", {});
      if (!signal.aborted) controller.close();
    },
  });
}

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}

const port = Number(arg("--port", "4841"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response("the bench model answers POST /v1/messages\n", { status: 404 });
    const body = (await req.json()) as MessagesRequest;
    const step = script(body);
    const shape = step.kind === "tool" ? `tools ${step.calls.map((c) => c.name).join(", ")}` : `${step.words.length} words`;
    console.log(`bench model: ${new URL(req.url).pathname} turn with ${body.messages?.length ?? 0} messages -> ${shape}`);
    return new Response(stream(step, body.model ?? "bench", req.signal), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
console.log(`bench model listening on http://127.0.0.1:${server.port}`);
