/* the composer's story fixtures: one thread on one host, its prompts
   taken from the scrubbed thread fixtures (../../thread/fixtures,
   cmx-deploy.json and northstar-heavy.json), its models, commands and files
   in the shapes boxbox's routes answer. every story paints from these
   through the real store, so a story is the app in that state. */

import type { components } from "../../../api/boxbox";
import type { Draft, OutboxView, Photo, Target } from "../../../sync/outbox";
import { thread } from "../../../sync/fixtures/neutral";
import type { Ask, Thread, TailItem } from "../../../sync/protocol";

export const HOST = "desk";
export const OTHER = "render";
export const SESSION = "ses_composer";
export const KEY = `${HOST}:${SESSION}`;
export const DIRECTORY = "/Users/dev/code/boxy-web";
export const AT = Date.UTC(2026, 9, 1, 18, 11, 0);

export const TARGET: Target = { kind: "session", host: HOST, session: SESSION, directory: DIRECTORY };

/** prompts, as the scrubbed fixtures hold them */
export const PROMPTS = {
  deploy: "okay i started this session again in the tui, free to deploy across all machines after pushing",
  docs: "have you updated all the documentation as necessary, the changes, rpompt iterations readme etc",
  push: "ok push",
  perf: "i just played a whole game, better but still not there yet. what can we do to improve perf",
  steer: "commit push and deploy to my tv",
  long: "yeah it’s after connecting, it shows connected, but - on frame rate, nitrate and packet loss and render delay, input and output both still show 1920x1080\n\nthe gpu shows 15.8 ms btw\n\n30 fps 18 Mbps 8 ms\nFrame Rate Bitrate RTT Packet Loss\n1920x1080 3840x2160 metalfx 32.5 ms\nInput Output Upscaler Render Delay\nmetalfx 19 Hz",
  first: "okay now go ahead and implement everything. i want a buttery smooth gameplay experience",
} as const;

const tail: TailItem[] = [
  { kind: "tool", tool: "read", text: "docs/deploy.md", messageID: "msg_a", partID: "prt_1", role: "assistant", state: "completed" },
  { kind: "tool", tool: "bash", text: "bun test", messageID: "msg_a", partID: "prt_2", role: "assistant", state: "running" },
];

function session(activity: Thread["activity"]): Thread {
  return thread(KEY, {
    agent: HOST,
    activity,
    tail,
    needs: [],
    read: null,
    agents: 0,
    processes: 0,
    title: "deploy across the machines",
    created: AT - 3_600_000,
    updated: AT,
    // the project id is not a path, so the root is the directory (translate.rs)
    place: { root: DIRECTORY, directory: DIRECTORY, name: "prj_boxbox" },
    effort: "max",
  });
}

/** the thread's own model, as the daemon reports it: for the stories where the host's list is not here, and where the model in use is not a favorite */
function withModel(entry: Thread, model = "anthropic/claude-opus-5-5"): Thread {
  return { ...entry, model };
}

/** the context fill the daemon reports (a10): tokens in the window now, the window, and where it compacts by itself */
function withContext(entry: Thread, used: number): Thread {
  return { ...entry, context: { used, limit: 200_000, compactAt: 170_000 } };
}

export const WORKING = session({ state: "busy", since: AT - 222_000 });
export const IDLE = session({ state: "idle" });
export const IDLE_ON_OPUS = withModel(IDLE);
export const IDLE_ON_SONNET = withModel(IDLE, "anthropic/claude-sonnet-5-5");
export const IDLE_WITH_CONTEXT = withContext(IDLE, 128_000);
export const IDLE_NEARLY_FULL = withContext(IDLE, 184_000);
export const WORKING_WITH_CONTEXT = withContext(WORKING, 128_000);
/** a turn writing markdown, with a strong mark still open at its end (the line drops it), after a question it settled */
export const WORKING_MARKDOWN: Thread = {
  ...WORKING,
  tail: [
    ...tail,
    { kind: "tool", tool: "question", text: "push to main or open a branch?", messageID: "msg_a", partID: "prt_3", role: "assistant", state: "completed" },
    { kind: "text", text: "## the fix\nthe health check now runs **before** the swap, and `deploy.sh` waits for it. next the **rollback", messageID: "msg_a", partID: "prt_4", role: "assistant" },
  ],
};

export const QUESTION: Ask = {
  id: "que_1",
  key: KEY,
  agent: HOST,
  thread: KEY,
  kind: "question",
  questions: [{ question: "push to main or open a branch?", header: "where", multiple: false, custom: true, options: [{ label: "main" }, { label: "a branch" }] }],
};

type Models = components["schemas"]["HostModels"];
const LEVELS_4 = ["low", "medium", "high", "max"];
const LEVELS_5 = ["low", "medium", "high", "xhigh", "max"];

/** the host's models, as a person with a few providers sees them */
export const MODELS: Models = {
  default: "anthropic/claude-fable-5-1",
  models: [
    { id: "anthropic/claude-fable-5-1", name: "Fable 5.1", provider: "Anthropic", efforts: LEVELS_4 },
    { id: "anthropic/claude-opus-5-5", name: "Opus 5.5", provider: "Anthropic", efforts: LEVELS_4 },
    { id: "anthropic/claude-sonnet-5-5", name: "Sonnet 5.5", provider: "Anthropic", efforts: ["low", "medium", "high"] },
    { id: "openai/gpt-5-2-codex", name: "GPT-5.2 Codex", provider: "OpenAI", efforts: LEVELS_5 },
    { id: "openai/gpt-5-2", name: "GPT-5.2", provider: "OpenAI", efforts: LEVELS_5 },
    { id: "google/gemini-3-pro", name: "Gemini 3 Pro", provider: "Google", efforts: ["low", "high"] },
    { id: "google/gemini-3-flash", name: "Gemini 3 Flash", provider: "Google", efforts: [] },
  ],
};

/** the same host with the models that pile up: 25 across six providers, one with named efforts after its levels, one with
    none, and a name as long as real ones get */
export const MODELS_MANY: Models = {
  default: "anthropic/claude-fable-5-1",
  models: [
    { id: "anthropic/claude-fable-5-1", name: "Fable 5.1", provider: "Anthropic", efforts: LEVELS_4 },
    { id: "anthropic/claude-opus-5-5", name: "Opus 5.5", provider: "Anthropic", efforts: LEVELS_4 },
    { id: "anthropic/claude-opus-5-1", name: "Opus 5.1", provider: "Anthropic", efforts: LEVELS_4 },
    { id: "anthropic/claude-sonnet-5-5", name: "Sonnet 5.5", provider: "Anthropic", efforts: ["low", "medium", "high"] },
    { id: "anthropic/claude-haiku-5", name: "Haiku 5", provider: "Anthropic", efforts: [] },
    { id: "openai/gpt-5-2-codex", name: "GPT-5.2 Codex", provider: "OpenAI", efforts: ["minimal", ...LEVELS_5, "careful", "quick"] },
    { id: "openai/gpt-5-2", name: "GPT-5.2", provider: "OpenAI", efforts: LEVELS_5 },
    { id: "openai/gpt-5-2-mini", name: "GPT-5.2 Mini", provider: "OpenAI", efforts: ["minimal", "low", "medium", "high"] },
    { id: "openai/gpt-5-1", name: "GPT-5.1", provider: "OpenAI", efforts: LEVELS_5 },
    { id: "openai/o5", name: "o5", provider: "OpenAI", efforts: ["low", "medium", "high"] },
    { id: "openai/o5-mini", name: "o5 Mini", provider: "OpenAI", efforts: ["low", "medium", "high"] },
    { id: "google/gemini-3-pro", name: "Gemini 3 Pro", provider: "Google", efforts: ["low", "high"] },
    { id: "google/gemini-3-flash", name: "Gemini 3 Flash", provider: "Google", efforts: [] },
    { id: "google/gemini-3-flash-lite", name: "Gemini 3 Flash Lite", provider: "Google", efforts: [] },
    { id: "google/gemini-2-5-pro", name: "Gemini 2.5 Pro", provider: "Google", efforts: ["low", "medium", "high"] },
    { id: "mistral/mistral-large-3", name: "Mistral Large 3", provider: "Mistral AI", efforts: [] },
    { id: "mistral/codestral-2", name: "Codestral 2", provider: "Mistral AI", efforts: [] },
    { id: "mistral/devstral-medium", name: "Devstral Medium", provider: "Mistral AI", efforts: [] },
    { id: "deepseek/deepseek-v4", name: "DeepSeek V4", provider: "DeepSeek", efforts: [] },
    { id: "deepseek/deepseek-v4-reasoner", name: "DeepSeek V4 Reasoner", provider: "DeepSeek", efforts: ["low", "medium", "high"] },
    { id: "deepseek/deepseek-coder-v3", name: "DeepSeek Coder V3 Instruct Extended Context 128k", provider: "DeepSeek", efforts: [] },
    { id: "xai/grok-5", name: "Grok 5", provider: "xAI", efforts: ["low", "high"] },
    { id: "xai/grok-5-fast", name: "Grok 5 Fast", provider: "xAI", efforts: [] },
    { id: "xai/grok-4-1", name: "Grok 4.1", provider: "xAI", efforts: ["low", "high"] },
    { id: "xai/grok-code", name: "Grok Code", provider: "xAI", efforts: [] },
  ],
};

/** the ones this person starred, in the order they starred them */
export const FAVORITES = ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-5-2-codex", "google/gemini-3-pro"];

export const COMMANDS: components["schemas"]["CommandChoice"][] = [
  { name: "init", description: "write an AGENTS.md for this project", hints: [], source: "command" },
  { name: "release", description: "cut a release and write its notes", hints: ["$1"], source: "command" },
  { name: "review", description: "review the uncommitted changes", hints: ["$ARGUMENTS"], source: "command" },
];

export const FILES = ["docs/deploy.md", "ops/deploy.sh", "ops/install.sh", "docs/deploy-checklist.md"];

export function draft(text: string, extra: Partial<Draft> = {}): Draft {
  return { text, photos: [], model: null, effort: null, at: AT, ...extra };
}

export function sent(clientID: string, text: string, state: OutboxView["state"], extra: Partial<OutboxView> = {}): OutboxView {
  return {
    clientID,
    verb: "prompt",
    target: TARGET,
    key: KEY,
    text,
    photos: 0,
    files: 0,
    photoBytes: 0,
    model: null,
    effort: null,
    state,
    provisional: state === "queued" ? `msg_q_${clientID}` : null,
    session: null,
    error: null,
    attempts: 1,
    at: AT,
    ackAt: state === "queued" ? AT + 180 : null,
    unsending: false,
    ...extra,
  };
}

/** a file in a draft (docs/composer.md, attachments: any file) of about `bytes`, as the composer holds one: its own bytes as a
    data url of its kind, with no dimensions */
export function fileOf(filename: string, mime: string, bytes: number): Photo {
  return { mime, filename, url: `data:${mime};base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`, width: null, height: null };
}

/** what a story's drop brings: a spec and a pdf the agent takes, and an archive it does not */
export function DROPPED(): File[] {
  return [
    new File(["# the spec"], "deploy spec.md", { type: "text/markdown" }),
    new File(["%PDF-1.4\n%the brief\n"], "q3 brief.pdf", { type: "application/pdf" }),
    new File(["PK"], "logs.zip", { type: "application/zip" }),
  ];
}

/** a small jpeg, drawn on a canvas the way the composer clamps a picked photo */
export function photoUrl(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 520;
  const g = canvas.getContext("2d");
  if (g) {
    const fill = g.createLinearGradient(0, 0, 0, 520);
    fill.addColorStop(0, "#1b4a33");
    fill.addColorStop(0.6, "#0b0c0f");
    g.fillStyle = fill;
    g.fillRect(0, 0, 240, 520);
    g.fillStyle = "rgba(255,255,255,.75)";
    for (const [y, w] of [[60, 180], [90, 140], [120, 100]] as const) g.fillRect(24, y, w, 10);
    g.fillStyle = "rgba(255,255,255,.12)";
    g.fillRect(16, 420, 208, 40);
    g.fillStyle = "rgba(255,107,107,.85)";
    g.fillRect(16, 470, 208, 4);
  }
  return canvas.toDataURL("image/jpeg", 0.86);
}

/** what the folders route answers for a path, as boxbox shapes cmx2's `/global/fs` */
export function browse(path: string): components["schemas"]["Folders"] {
  const at = path.replace(/\/+$/, "") || "/";
  const names = at === "/Users/dev/code" ? [["boxy-web", true], ["cmx2", true], ["scratch", false], ["northstar", true], ["notes", false]] : at === "/Users/dev" ? [["code", false], ["downloads", false]] : [];
  return {
    path: at,
    parent: at === "/" ? null : at.slice(0, at.lastIndexOf("/")) || "/",
    home: "/Users/dev",
    children: names.map(([name, repo]) => ({ name: name as string, directory: `${at}/${name}`, repo: repo as boolean })),
    truncated: false,
  };
}
