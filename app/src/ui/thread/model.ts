/* the thread's view model: the daemon's messages turned into turns of items
   (said, thought, step) a reader can take in (docs/thread.md, from the
   wire). pure; no dom. the rows fold from these in rows.ts. */

import { type Evidence, type Hunk, type Span, cleanOutput, evidenceOf, headTail, hunksOf, spanOf } from "./evidence";
import { scriptName } from "./script";
import { base, firstLine, leadProgram, shortCommand } from "./shell";
import { type MessageInfo, type ToolPart, type ToolStatus, type WireMessage, type WirePart, boolean, isToolPart, list, number, record, spanMs, string, strings, timeOf } from "./wire";

export type Family = "read" | "search" | "edit" | "shell" | "web" | "spawn" | "message" | "wait" | "agents" | "ask" | "plan" | "skill" | "other";

export type Question = { question: string; header: string; options: Array<{ label: string; description: string }>; custom: boolean; multiple: boolean; answer: string[] | undefined };
export type Todo = { content: string; status: string };
export type Agent = { name: string; nickname?: string; type?: string; brief: string; child?: string };
/** an image a tool returned (a read of a picture, a screenshot a command wrote): its mime, the name it carries and its bytes as a
    data url. the url is the string the wire held, never a copy: it is megabytes, and everything that passes a picture on passes
    this object */
export type Picture = { mime: string; filename: string; url: string };

export interface Step {
  k: "step";
  /** the tool part's id and call id, for links and for matching asks */
  id: string;
  callID: string;
  family: Family;
  tool: string;
  status: ToolStatus;
  /** the object alone: a path, a pattern, a command, an agent's name */
  object: string;
  /** the result in words when the tool said one: "12 hits", "new, 46 lines" */
  result: string;
  add: number;
  del: number;
  ms: number;
  /** when it started, ms since the epoch */
  at: number;
  error?: string;
  /** the error was an interrupt (an abort, a denied permission), not a fault */
  interrupted?: boolean;
  /** a command's output, head and tail; a read's opening lines. `raw` is the command's whole output as the store holds it (the same string, not a copy), which its copy control cleans and copies at the press: the lines above are cut (a head, a tail, each line at 220 characters) */
  output?: { lines: string[]; cut: number; cutAt: number; /** a line shown was cut at the cap (evidence.ts, LINE_MAX) */ clipped?: boolean; raw?: string };
  /** a completed read's whole output as the store holds it (the same string, not a copy): its bed and the reader take every line
      from it when the row opens (evidence.ts, readLines) */
  readRaw?: string;
  /** a write's whole content as the agent sent it (the same string): its diff keeps 80 lines, and "show the whole diff" opens
      the rest from this */
  wrote?: string;
  /** a script (cmx2's `run`): `object` is its name in words (script.ts), not its code */
  script?: true;
  /** the command as the agent sent it, whole (`object` has the leading `cd` taken off), what its copy control copies */
  command?: string;
  outputLines?: number;
  cwd?: string;
  /** a poll or a write to a running command: the command it acted on, and what it typed */
  polls?: string;
  typed?: string;
  exit?: number;
  /** a search's hits, a glob's files, a web search's titles: the first few */
  hits?: string[];
  /** a search's hits by file, or the domains a web search consulted */
  spread?: Array<{ name: string; n: number }>;
  evidence?: Evidence;
  /** a read's lines, and the file's length when known */
  span?: Span;
  /** the images the tool returned, the ones a browser draws (png, jpeg, gif, webp) and whose data url says the same: a read of a
      picture, a command that wrote one. in the order the daemon sent them */
  images?: Picture[];
  /** how many more the daemon left out (its cap), which the row says */
  imagesDropped?: number;
  /** where an edit landed */
  hunks?: Hunk[];
  /** the file's length after the edit, when a read in this session told us */
  total?: number;
  /** an edit's hunk, a write's content as additions */
  diff?: string;
  agent?: Agent;
  /** what a message to another agent said */
  words?: string;
  /** a wait for one reply (cmx2's `correlation_id`), not for whatever comes */
  reply?: boolean;
  todos?: Todo[];
  questions?: Question[];
  /** a permission the daemon is waiting on for this call (joined from the pending list) */
  permission?: { id: string; permission: string; patterns: string[] };
  /** the question request the daemon raised for this call, when it has (a running question is not an ask until then) */
  question?: { id: string };
}
export interface Say { k: "say"; id: string; text: string; at: number; streaming: boolean }
export interface Think { k: "think"; id: string; text: string; ms: number; at: number; streaming: boolean }
export type Item = Step | Say | Think;

export type Origin = "you" | "queued" | "steer" | "brief" | "mail" | "notice" | "compaction";
export type TurnStatus = "done" | "working" | "aborted" | "failed";

export interface Turn {
  id: string;
  /** what started it: you typed it, it was queued, a steer, the brief that started this agent, an agent's report or
      note, a runtime notice, a compaction */
  by: Origin;
  prompt: string;
  /** a report's sender: the agent's name, and its session when the daemon said (`mail.fromID`) */
  from?: string;
  fromID?: string;
  /** the mail was a note from another agent, not its report */
  note?: boolean;
  at: number;
  end: number;
  items: Item[];
  /** the prose after the last step: what the turn came to */
  answer?: Say;
  status: TurnStatus;
  error?: string;
  cost: number;
  /** files the turn edited, with their counts */
  files: Map<string, { add: number; del: number }>;
  compacted: boolean;
  /** a compaction's summary: the text of the assistant message cmx2 marks `summary: true` after the compaction part. it is the card the
      mark opens, never a row or the answer; what follows it is the turn's own work. a compaction recorded with no such message has none,
      and its last words are its summary (the old reading) */
  summary?: string;
  model?: string;
  effort?: string;
  /** parts the contract does not name, dropped (ask a15); counted so the gap is visible */
  unknownParts: number;
  /** the photos the person sent with the message (its `file` parts a browser draws), drawn above its words; the same data url strings
      the store holds */
  photos?: Picture[];
  /** the files the person sent with the message that are not photos (`sentFilesOf`), named above its words */
  sentFiles?: SentFile[];
}

/** a file a person sent with a message that is not a photo: its name and its kind */
export type SentFile = { filename: string; mime: string };

const HOME = /^\/Users\/[^/]+|^\/home\/[^/]+/;
/** the same two places inside a command, which names them anywhere in its words: the name ends where a word does in a shell (HOME is for a whole path, whose name ends only at its next slash), and the path starts a word, not the middle of another path */
const HOME_IN_WORDS = /(?<![\w~.-])\/(?:Users|home)\/[^/\s"'`;&|<>()]+/g;

/** a command as it is shown: the home directory it names is ~, as it is everywhere in the thread (shortPath). what is copied is the command as it was sent */
export const homeAsTilde = (command: string): string => command.replace(HOME_IN_WORDS, "~");

/** a path relative to the project root; outside it, with ~ for home */
export function shortPath(path: string, root: string): string {
  if (!path) return "";
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path.replace(HOME, "~");
}

const FAMILY: Record<string, Family> = {
  read: "read",
  grep: "search", glob: "search", recall: "search",
  edit: "edit", write: "edit",
  shell: "shell", bash: "shell", exec_command: "shell", write_stdin: "shell", proc_spawn: "shell", proc_write: "shell", proc_read: "shell", proc_kill: "shell", proc_list: "shell",
  webfetch: "web", websearch: "web",
  spawn: "spawn", spawn_agent: "spawn", spawn_pool: "spawn",
  message: "message", send_message: "message", followup_task: "message",
  wait: "wait", wait_agent: "wait",
  agents: "agents", list_agents: "agents", close_agent: "agents",
  question: "ask",
  todowrite: "plan",
  skill: "skill",
};
/** who a finished wait heard from, in words, from cmx2's `items` (each a `kind` and a `from` path): "helper",
    "a, b and 2 more agents", "a background job", "root", "helper and a background job". a report with no sender is
    a pool's, a system note is the daemon's. empty when nothing came or the daemon said nothing */
export function arrivalsOf(items: readonly unknown[]): string {
  const name = (from: string) => from.replace(/^\/root\/?/, "") || "root";
  const senders: string[] = [];
  let jobs = 0, daemon = false;
  for (const it of items) {
    const r = record(it);
    if (!r) continue;
    const kind = string(r["kind"]) ?? "", from = string(r["from"]);
    if (kind === "job") jobs++;
    else if (from) { if (!senders.includes(name(from))) senders.push(name(from)); }
    else if (kind === "report") { if (!senders.includes("a pool")) senders.push("a pool"); }
    else daemon = true;
  }
  const parts = senders.length > 3 ? [...senders.slice(0, 2), `${senders.length - 2} more agents`] : [...senders];
  if (jobs) parts.push(jobs === 1 ? "a background job" : `${jobs} background jobs`);
  if (daemon) parts.push("the daemon");
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

export const familyOf = (tool: string): Family => FAMILY[tool] ?? (/search/.test(tool) ? "web" : "other");

const lineCount = (s: string | undefined): number => (s ? s.split("\n").length : 0);

/** the running context of one session's turns: the commands by session id so a poll can name what it watches, and each file's length */
type Ctx = { root: string; commands: Map<string, string>; lengths: Map<string, number> };

/** what one tool part says on its own, before the parts around it add what they know: a poll's command and a file's
    length. `starts` is a command session this part opened, `watches` the one it polls or types into */
type Base = { step: Step; starts?: { session: string; command: string }; watches?: string };

/** the image types a browser draws from a data url in an img: no svg (a document), no heic (not every browser) */
const DRAWABLE = /^image\/(?:png|jpe?g|gif|webp)$/i;
const DRAWABLE_URL = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i;

/** the images a completed tool's state carries (`attachments`, each a `file` with a mime, a filename and a data url) and how many
    the daemon dropped past its cap. an attachment whose mime or whose url is not an image the browser draws is not one: a
    non-image data url never reaches an img. read through the loose readers, so it works with a contract that does not name the
    field yet */
export function picturesOf(state: unknown): { images: Picture[]; dropped: number } {
  const s = record(state);
  const images: Picture[] = [];
  if (s?.["status"] === "completed") for (const a of list(s["attachments"])) {
    const r = record(a);
    const mime = string(r?.["mime"]), url = string(r?.["url"]);
    if (mime === undefined || url === undefined || !DRAWABLE.test(mime) || !DRAWABLE_URL.test(url)) continue;
    images.push({ mime, filename: string(r?.["filename"]) ?? "", url });
  }
  return { images, dropped: Math.max(0, Math.floor(number(s?.["attachmentsDropped"]) ?? 0)) };
}

/** the photos a person sent with a message: its `image` and `file` parts whose mime and data url are an image a browser draws, in
    order (the server makes a png, jpeg, gif or webp file an `image`; any other picture stays a `file`) */
export function photosOf(parts: readonly WirePart[]): Picture[] {
  return parts.flatMap((p) => {
    if (p.type !== "file" && p.type !== "image") return [];
    const r = p as Record<string, unknown>;
    const mime = string(r["mime"]), url = string(r["url"]);
    return mime !== undefined && url !== undefined && DRAWABLE.test(mime) && DRAWABLE_URL.test(url) ? [{ mime, filename: string(r["filename"]) ?? "", url }] : [];
  });
}

/** a text file the host put into a message whole (cmx2's parts.ts): `<file path="name">`, with no directory in the name, as an
    upload has it and a path in the repo does not */
const UPLOADED = /^<file path="([^"/\n]+)">\n/;

/** the files a person sent with a message that are not photos (docs/composer.md, attachments: any file), in order: a pdf, which
    comes back as its own `file` part, and a text or json file, which the host put into the message as a synthetic `<file`
    block. a block a mention made is named in the words already (`@notes.md`), so it is left to them */
export function sentFilesOf(parts: readonly WirePart[], prompt: string): SentFile[] {
  return parts.flatMap((p): SentFile[] => {
    const r = p as Record<string, unknown>;
    if (p.type === "file") {
      const mime = string(r["mime"]);
      return mime !== undefined && !mime.startsWith("image/") ? [{ filename: string(r["filename"]) || "a file", mime }] : [];
    }
    if (p.type !== "text" || r["synthetic"] !== true) return [];
    const name = UPLOADED.exec(string(r["text"]) ?? "")?.[1];
    return name && !prompt.includes(`@${name}`) ? [{ filename: name, mime: "text/plain" }] : [];
  });
}

/** when a step started: its own start, else its end, else the message it rides in. cmx2 leaves `time.start` null on native tool parts (gotchas.md) */
function stepOf(part: ToolPart, root: string, messageAt: number): Base {
  const state = part.state;
  const input = record(state.input) ?? {};
  const meta = record((state as { metadata?: unknown }).metadata) ?? {};
  const time = timeOf((state as { time?: unknown }).time);
  const tool = part.tool;
  const family = familyOf(tool);
  const made: Base = { step: { k: "step", id: part.id, callID: part.callID, family, tool, status: state.status, object: "", result: "", add: 0, del: 0, ms: spanMs(time), at: time?.start ?? time?.end ?? messageAt } };
  const step = made.step;
  const out = state.status === "completed" ? (string(state.output) ?? "") : state.status === "running" ? string(meta["output"]) ?? "" : "";
  if (state.status === "error") {
    const error = string(state.error);
    if (error !== undefined) step.error = error;
    step.interrupted = boolean(meta["interrupted"]) || /aborted|interrupt|denied/i.test(error ?? "");
  }
  const path = shortPath(string(input["filePath"]) ?? string(input["path"]) ?? string(meta["path"]) ?? string(meta["filepath"]) ?? "", root);
  switch (family) {
    case "read": {
      step.object = path;
      const offset = number(input["offset"]), limit = number(input["limit"]);
      const startLine = number(meta["startLine"]), endLine = number(meta["endLine"]), totalLines = number(meta["totalLines"]);
      const span = spanOf({ ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }, { ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}), ...(totalLines !== undefined ? { totalLines } : {}) }, out);
      if (span) step.span = span;
      const preview = (string(meta["preview"]) ?? out).replace(/^<path>[\s\S]*?<content>\n/, "").split("\n").slice(0, 10).join("\n").slice(0, 900);
      if (preview.trim()) step.output = { lines: preview.split("\n"), cut: 0, cutAt: -1 };
      if (state.status === "completed" && out) step.readRaw = out;
      break;
    }
    case "search": {
      step.object = string(input["pattern"]) ?? string(input["query"]) ?? "";
      const cwd = string(input["path"]);
      if (cwd) step.cwd = shortPath(cwd, root);
      if (tool === "glob") {
        const n = number(meta["count"]) ?? number(meta["total"]) ?? (Array.isArray(meta["paths"]) ? list(meta["paths"]).length : undefined);
        if (n !== undefined) step.result = `${n} file${n === 1 ? "" : "s"}`;
        step.hits = strings(meta["files"] ?? meta["paths"]).slice(0, 8).map((f) => shortPath(f, root));
      } else if (tool === "grep") {
        const hits = list(meta["hits"]).flatMap((h) => { const r = record(h); return r ? [r] : []; });
        step.hits = hits.slice(0, 8).map((h) => `${shortPath(string(h["path"]) ?? "", root)}:${number(h["line"]) ?? ""}  ${(string(h["text"]) ?? "").trim().slice(0, 120)}`);
        const byFile = new Map<string, number>();
        for (const h of hits) { const f = base(string(h["path"]) ?? ""); byFile.set(f, (byFile.get(f) ?? 0) + 1); }
        if (!byFile.size) for (const m of out.matchAll(/^(\/[^\n:]+):$/gm)) byFile.set(base(m[1] ?? ""), 0);
        step.spread = [...byFile].map(([name, n]) => ({ name, n }));
        const n = number(meta["matches"]) ?? number(meta["total"]);
        if (n !== undefined) step.result = `${n} hit${n === 1 ? "" : "s"}`;
      }
      break;
    }
    case "edit": {
      step.object = path;
      const fd = record(meta["filediff"]);
      if (tool === "write") {
        const content = string(input["content"]) ?? "";
        step.add = lineCount(content);
        if (content) step.wrote = content;
        const body = content.split("\n");
        step.diff = body.slice(0, 80).map((l) => `+${l}`).join("\n") + (body.length > 80 ? `\n+\u0002${body.length - 80}` : "");
        step.result = meta["exists"] === false || boolean(meta["created"]) ? `new, ${step.add} lines` : `${step.add} lines`;
      } else {
        const patch = string(fd?.["patch"]) ?? string(meta["diff"]);
        if (fd && (number(fd["additions"]) !== undefined || patch)) {
          const lines = (patch ?? "").split("\n");
          step.add = number(fd["additions"]) ?? lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
          step.del = number(fd["deletions"]) ?? lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
          step.diff = lines.filter((l) => !/^(Index:|====|---|\+\+\+)/.test(l)).join("\n");
        } else {
          const old = string(input["oldString"]) ?? string(input["old_text"]);
          const neu = string(input["newString"]) ?? string(input["new_text"]);
          if (old !== undefined && neu !== undefined) {
            step.del = lineCount(old);
            step.add = lineCount(neu);
            step.diff = [...old.split("\n").map((l) => `-${l}`), ...neu.split("\n").map((l) => `+${l}`)].join("\n");
          }
        }
        if (step.diff !== undefined) step.result = `+${step.add} -${step.del}`;
        step.hunks = hunksOf(patch, number(meta["line"]));
      }
      break;
    }
    case "shell": {
      const cmd = string(input["command"]) ?? string(input["cmd"]) ?? string(meta["cmd"]) ?? "";
      step.object = cmd;
      step.command = cmd;
      /* imported history numbers its command sessions; native cmx2 names them */
      const idOf = (v: unknown): string | undefined => (typeof v === "number" ? String(v) : string(v));
      const sid = idOf(input["session_id"]) ?? idOf(input["id"]) ?? idOf(meta["session_id"]) ?? "";
      if (tool === "exec_command" && sid) made.starts = { session: sid, command: cmd };
      if (tool === "write_stdin" || tool === "proc_read" || tool === "proc_write") {
        made.watches = sid;
        step.polls = "";
        step.typed = string(input["chars"]) ?? string(input["data"]) ?? "";
      }
      const { line, cwd } = firstLine(cmd);
      if (cwd !== undefined) { step.object = line; step.cwd = shortPath(cwd, root) || "~"; }
      const exit = number(meta["exit_code"]) ?? number(meta["exit"]);
      if (exit !== undefined) { step.exit = exit; step.result = exit === 0 ? "ok" : `exit ${exit}`; }
      if (boolean(meta["timed_out"])) step.result = "timed out";
      if (record(meta["job"]) || boolean(input["background"])) step.result = "in the background";
      const clean = cleanOutput(out);
      step.outputLines = clean ? clean.split("\n").length : 0;
      if (clean) step.output = { ...headTail(clean), raw: out };
      const workdir = string(input["workdir"]) ?? string(meta["workdir"]);
      if (workdir && step.cwd === undefined) step.cwd = shortPath(workdir, root) || "~";
      if (state.status === "completed" || state.status === "error") { const ev = evidenceOf(cmd, leadProgram(cmd), clean, exit); if (ev) step.evidence = ev; }
      break;
    }
    case "web": {
      step.object = string(input["url"]) ?? string(input["query"]) ?? "";
      if (tool !== "webfetch") {
        step.hits = [...out.matchAll(/^Title: (.+)$/gm)].slice(0, 6).map((m) => (m[1] ?? "").slice(0, 120));
        const domains = new Map<string, number>();
        for (const m of out.matchAll(/^URL: (\S+)$/gm)) { try { const h = new URL(m[1] ?? "").host.replace(/^www\./, ""); domains.set(h, (domains.get(h) ?? 0) + 1); } catch { /* not a url */ } }
        step.spread = [...domains].map(([name, n]) => ({ name, n }));
        const n = list(meta["results"]).length;
        if (n) step.result = `${n} results`;
      }
      break;
    }
    case "spawn": {
      /* the pinned daemon's spawn answers with the agents it started (`agents`, each with its name, seat and session)
         and names the first in `child_session_id` and `path`; v1's spawn_agent carried `task_name` and `nickname` */
      const first = record(list(meta["agents"])[0]);
      const name = (string(first?.["name"]) ?? string(meta["path"]) ?? string(meta["task_name"]) ?? string(input["task_name"]) ?? string(input["name"]) ?? "agent").replace(/^\/root\//, "");
      const nickname = string(meta["nickname"]), type = string(first?.["seat"]) ?? string(input["agent_type"]) ?? string(input["seat"]), child = string(meta["child_session_id"]) ?? string(first?.["id"]);
      step.agent = { name, brief: string(input["message"]) ?? string(input["brief"]) ?? "", ...(nickname ? { nickname } : {}), ...(type ? { type } : {}), ...(child ? { child } : {}) };
      step.object = name;
      break;
    }
    case "message": {
      step.object = (string(input["target"]) ?? string(input["to"]) ?? string(meta["target"]) ?? "").replace(/^\/root\/?/, "");
      const words = string(input["message"]) ?? string(input["body"]) ?? string(input["text"]);
      if (words) step.words = words;
      break;
    }
    case "wait":
      step.result = boolean(meta["timed_out"]) ? "timed out" : "";
      step.object = arrivalsOf(list(meta["items"]));
      if (string(input["correlation_id"])) step.reply = true;
      break;
    case "agents":
      step.object = tool === "close_agent" ? `close ${(string(meta["target"]) ?? "").replace(/^\/root\//, "")}` : "list agents";
      break;
    case "ask": {
      const answers = list(meta["answers"]);
      step.questions = list(input["questions"]).flatMap((q, i) => {
        const r = record(q);
        if (!r) return [];
        const a = answers[i];
        return [{ question: string(r["question"]) ?? "", header: string(r["header"]) ?? "", options: list(r["options"]).flatMap((o) => { const x = record(o); return x ? [{ label: string(x["label"]) ?? "", description: string(x["description"]) ?? "" }] : []; }), custom: r["custom"] !== false, multiple: r["multiple"] === true, answer: Array.isArray(a) ? strings(a) : typeof a === "string" ? [a] : undefined }];
      });
      step.object = step.questions[0]?.question ?? "a question";
      break;
    }
    case "plan": {
      step.todos = list(input["todos"]).flatMap((t) => { const r = record(t); return r ? [{ content: string(r["content"]) ?? "", status: string(r["status"]) ?? "" }] : []; });
      const done = step.todos.filter((t) => t.status === "completed").length;
      step.result = `${done} of ${step.todos.length}`;
      break;
    }
    case "skill":
      step.object = string(input["name"]) ?? "";
      break;
    default: {
      /* cmx2's `run` is a script of helper calls: the row names it by what it does (script.ts: its description, its leading
         comment, else "a script"), never its first line of code, and says when the script started agents (`metadata.nested`,
         one entry per helper call; the entries carry no child ids, cmx2 ask a27) */
      const command = string(input["command"]);
      const code = string(input["code"]);
      const spawned = list(meta["nested"]).filter((n) => string(record(n)?.["tool"]) === "spawn").length;
      if (command) step.object = shortCommand(command);
      else if (code !== undefined) { step.object = scriptName(code, string(input["description"])); step.script = true; }
      else step.object = tool.replace(/_/g, " ");
      if (spawned) step.result = `started ${spawned === 1 ? "an agent" : `${spawned} agents`}`;
    }
  }
  const pictures = picturesOf(state);
  if (pictures.images.length) step.images = pictures.images;
  if (pictures.dropped) step.imagesDropped = pictures.dropped;
  return made;
}

/** the parts contract 6 names for imported (cmx) history only (cmx2 a15), `marker` parts now (or raw ones of these types, when the
    server passed one on as it was): skipped by the ledger, never counted unknown */
const IMPORTED_ONLY: ReadonlySet<string> = new Set(["step-start", "step-finish", "patch", "subtask"]);
const importedOnly = (p: WirePart): boolean => IMPORTED_ONLY.has(p.type) || (p.type === "marker" && IMPORTED_ONLY.has(string((p as Record<string, unknown>)["marker"]) ?? ""));

/** a said or thought part's words: the store always holds a part's text (sync/reducer.ts), so none is no words */
const wordsOf = (p: WirePart): string => string((p as { text?: unknown }).text) ?? "";

/** a user message's origin: typed, queued, an agent's report (with who sent it, by name and by session), a runtime notice */
function originOf(info: MessageInfo, parts: readonly WirePart[]): { by: Origin; text: string; from?: string; fromID?: string; note?: boolean } {
  const texts = parts.filter((p) => p.type === "text");
  const marked = (k: string) => texts.some((p) => boolean((p as Record<string, unknown>)[k]));
  const typed = texts.filter((p) => !boolean((p as Record<string, unknown>)["synthetic"]) && !boolean((p as Record<string, unknown>)["mail"]) && !boolean((p as Record<string, unknown>)["notice"]));
  const extra = info as Record<string, unknown>;
  if (boolean(extra["notice"]) || marked("notice")) return { by: "notice", text: texts.map(wordsOf).join("\n") };
  const mail = record(extra["mail"]) ?? texts.map((p) => record((p as Record<string, unknown>)["mail"])).find((m) => m !== undefined);
  const mailFrom = string(mail?.["from"])?.replace(/^\/root(?:\/|$)/, "") || (mail ? "root" : undefined), mailFromID = string(mail?.["fromID"]);
  const kind = string(mail?.["kind"]);
  /* the daemon's mail kinds (cmx2's MailKind): a task is the brief that started an agent, a report and a message come
     from another agent, a job's notice and a system line are runtime notices */
  if (kind === "task") return { by: "brief", text: texts.filter((p) => !boolean((p as Record<string, unknown>)["synthetic"])).map(wordsOf).join("\n"), ...(mailFrom !== undefined ? { from: mailFrom } : {}), ...(mailFromID !== undefined ? { fromID: mailFromID } : {}) };
  if (kind === "job" || kind === "system") return { by: "notice", text: texts.map(wordsOf).join("\n") };
  if (mail !== undefined || marked("mail")) return { by: "mail", text: texts.map(wordsOf).join("\n"), ...(kind === "message" ? { note: true } : {}), ...(mailFrom !== undefined ? { from: mailFrom } : {}), ...(mailFromID !== undefined ? { fromID: mailFromID } : {}) };
  /* imported history marks a report as a synthetic text that starts with [from /root/name]: */
  const imported = texts.find((p) => boolean((p as Record<string, unknown>)["synthetic"]) && /^\[from \/root[^\]]*\]:/.test(wordsOf(p)));
  if (!typed.length && imported) {
    const m = /^\[from (\/root[^\]]*)\]:\s*/.exec(wordsOf(imported));
    const from = m?.[1]?.replace(/^\/root\//, "");
    return { by: "mail", text: texts.map((p) => wordsOf(p).replace(/^\[from \/root[^\]]*\]:\s*/, "")).join("\n\n"), ...(from ? { from } : {}) };
  }
  return { by: boolean(extra["queued"]) ? "queued" : "you", text: typed.map(wordsOf).join("\n") };
}

/* ---------- remembering parts between passes ---------- */

/** what each part became last pass, by part id, so a delta to one part rebuilds that part's item alone and every
    other item keeps its object (and so its row and its dom). owned by whoever builds the turns again (live.ts keeps
    one per turn); `turnsOf` drops the parts a pass no longer sees, so it holds only the parts it was last given */
export type PartMemo = Map<string, Remembered>;
type Remembered =
  | { k: "text"; item: Say | Think }
  | { k: "photos"; photos: Picture[] }
  | { k: "sent"; files: SentFile[] }
  | { k: "tool"; state: object; messageAt: number; root: string; base: Base; context: string; item: Step };

/** the same value, by its json: a part the store replaced with an equal copy (a message's info changed) keeps its step */
const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** two reads of a part as the same step: the images are told by their strings (equal strings compare without making a copy),
    and the json is of everything else, so a step with pictures never serialises megabytes of data url to be compared */
function sameBase(a: Base, b: Base): boolean {
  const x = a.step.images, y = b.step.images;
  if (x?.length !== y?.length) return false;
  if (x && y) for (let i = 0; i < x.length; i++) if (x[i]?.url !== y[i]?.url || x[i]?.mime !== y[i]?.mime || x[i]?.filename !== y[i]?.filename) return false;
  const bare = (v: Base): Base => { const step = { ...v.step }; delete step.images; return { ...v, step }; };
  return a === b || sameJson(bare(a), bare(b));
}

/** a user message's photos, the array from last pass when every photo in it is the same (its mime, its name, its url string): the
    turn is built again at every delta of its reply, and a new array of new objects made the strip above the reply load and decode
    its data urls again at every one (docs/gotchas.md, a sent photo flickering). remembered under the message's id */
function photosIn(memo: PartMemo, seen: Set<string>, id: string, fresh: Picture[]): Picture[] {
  if (!fresh.length) return fresh;
  seen.add(id);
  const held = memo.get(id);
  const same = (x: Picture, y: Picture | undefined): boolean => y !== undefined && x.url === y.url && x.mime === y.mime && x.filename === y.filename;
  if (held?.k === "photos" && held.photos.length === fresh.length && held.photos.every((x, i) => same(x, fresh[i]))) return held.photos;
  memo.set(id, { k: "photos", photos: fresh });
  return fresh;
}

/** a user message's files that are not photos, the array from last pass when every file in it is the same (its name and kind),
    as `photosIn` keeps its photos: a new array at every delta of the reply would draw the row above the words again. remembered
    under the message's id with `:files` after it, beside its photos */
function sentFilesIn(memo: PartMemo, seen: Set<string>, id: string, fresh: SentFile[]): SentFile[] {
  if (!fresh.length) return fresh;
  const key = `${id}:files`;
  seen.add(key);
  const held = memo.get(key);
  if (held?.k === "sent" && held.files.length === fresh.length && held.files.every((x, i) => x.filename === fresh[i]?.filename && x.mime === fresh[i]?.mime)) return held.files;
  memo.set(key, { k: "sent", files: fresh });
  return fresh;
}

/** a said or thought part's item, the one from last pass when nothing it shows changed */
function textItem(memo: PartMemo, seen: Set<string>, fresh: Say | Think): Say | Think {
  seen.add(fresh.id);
  const held = memo.get(fresh.id);
  if (held?.k === "text" && held.item.k === fresh.k && held.item.text === fresh.text && held.item.at === fresh.at && held.item.streaming === fresh.streaming && (fresh.k === "say" || (held.item as Think).ms === fresh.ms)) return held.item;
  memo.set(fresh.id, { k: "text", item: fresh });
  return fresh;
}

/** a tool part's step: read again only when the store replaced its state object (it keeps the object while nothing
    in it changes, and replaces it when the part is sent again), and placed in what the earlier parts of the
    turn know (the command a poll watches, a file's length), which is cheap and decides whether the step is a new object */
function stepIn(part: ToolPart, messageAt: number, ctx: Ctx, memo: PartMemo, seen: Set<string>): Step {
  seen.add(part.id);
  const held = memo.get(part.id);
  const prior = held?.k === "tool" ? held : undefined;
  let base: Base;
  if (prior && prior.state === part.state && prior.messageAt === messageAt && prior.root === ctx.root) base = prior.base;
  else {
    const fresh = stepOf(part, ctx.root, messageAt);
    base = prior && sameBase(prior.base, fresh) ? prior.base : fresh;
  }
  const s = base.step;
  if (base.starts) ctx.commands.set(base.starts.session, base.starts.command);
  const polls = base.watches !== undefined ? (ctx.commands.get(base.watches) ?? "") : undefined;
  let known: number | undefined;
  let total: number | undefined;
  if (s.family === "read" && s.span) {
    if (s.span.total !== undefined) ctx.lengths.set(s.object, s.span.total);
    else known = ctx.lengths.get(s.object);
  }
  if (s.family === "edit") {
    const length = ctx.lengths.get(s.object);
    if (length !== undefined) total = length + s.add - s.del;
    if (total !== undefined) ctx.lengths.set(s.object, total);
    if (s.tool === "write") ctx.lengths.set(s.object, s.add);
  }
  const context = `${polls ?? "\u0000"}|${known ?? ""}|${total ?? ""}`;
  if (prior && prior.base === base && prior.context === context) {
    if (prior.state !== part.state) memo.set(part.id, { ...prior, state: part.state });
    return prior.item;
  }
  const item: Step =
    polls === undefined && known === undefined && total === undefined
      ? s
      : { ...s, ...(polls !== undefined ? { polls } : {}), ...(known !== undefined && s.span ? { span: { ...s.span, total: known } } : {}), ...(total !== undefined ? { total } : {}) };
  memo.set(part.id, { k: "tool", state: part.state, messageAt, root: ctx.root, base, context, item });
  return item;
}

/** the turns of a session: each user message and the assistant messages that follow it. given the memo of an earlier
    pass over the same messages, an item whose part did not change is the same object as before */
export function turnsOf(messages: readonly WireMessage[], root: string, steered: ReadonlySet<string> = new Set(), memo: PartMemo = new Map()): Turn[] {
  const turns: Turn[] = [];
  const ctx: Ctx = { root, commands: new Map(), lengths: new Map() };
  const seen = new Set<string>();
  let cur: Turn | undefined;
  for (const { info, parts } of messages) {
    const extra = info as Record<string, unknown>;
    if (info.role === "user") {
      const o = originOf(info, parts);
      const compacted = parts.some((p) => p.type === "compaction");
      const photos = photosIn(memo, seen, info.id, photosOf(parts));
      const sentFiles = sentFilesIn(memo, seen, info.id, sentFilesOf(parts, o.text));
      cur = { id: info.id, by: compacted ? "compaction" : steered.has(info.id) ? "steer" : o.by, prompt: o.text, ...(o.from ? { from: o.from } : {}), ...(o.fromID ? { fromID: o.fromID } : {}), ...(o.note ? { note: true } : {}), at: info.created, end: info.created, items: [], status: "done", cost: 0, files: new Map(), compacted, unknownParts: 0, ...(photos.length ? { photos } : {}), ...(sentFiles.length ? { sentFiles } : {}) };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (cur.compacted && boolean(extra["summary"])) {
      const said = parts.filter((p) => p.type === "text" && !boolean((p as Record<string, unknown>)["synthetic"])).map(wordsOf).join("\n\n");
      cur.summary = cur.summary === undefined ? said : `${cur.summary}\n\n${said}`;
      continue;
    }
    cur.cost += number(extra["cost"]) ?? 0;
    cur.end = info.completed ?? cur.end;
    /* the model is "provider/model"; the turn names the model alone, as cmx2's `modelID` did */
    const named = string(extra["model"]), effort = string(extra["effort"]);
    const model = named?.slice(named.indexOf("/") + 1);
    if (model) cur.model = model;
    if (effort) cur.effort = effort;
    if (info.completed === undefined || info.completed === null) cur.status = "working";
    const err = record(extra["error"]);
    if (err) {
      cur.status = err["name"] === "MessageAbortedError" || extra["finish"] === "aborted" ? "aborted" : "failed";
      /* as cmx2's `data.message ?? name` read: an empty message stays empty, an absent one gives way to the name */
      cur.error = string(err["message"]) ?? string(err["name"]) ?? "failed";
    } else if (extra["finish"] === "aborted") cur.status = "aborted";
    /* a part with no start of its own (cmx2 leaves `time.start` null on native tool parts, gotchas.md) starts no earlier than the
       part before it in the message: else a call made after the agent's words is dated to the message's creation, reads above
       them in time (the words at 15:19, the call at 15:18) and its run's clock counts from before it began */
    let floor = info.created;
    for (const p of parts) {
      const pt = timeOf((p as { time?: unknown }).time);
      const at = pt?.start ?? floor;
      floor = Math.max(floor, pt?.start ?? 0, pt?.end ?? 0);
      const streaming = boolean((p as Record<string, unknown>)["streaming"]);
      if (p.type === "text") {
        /* a part announced and still empty is kept while it streams: its row opens at the announcement, with its caret */
        if (boolean((p as Record<string, unknown>)["synthetic"]) || (!wordsOf(p).trim() && !streaming)) continue;
        cur.items.push(textItem(memo, seen, { k: "say", id: string(p["id"]) ?? "", text: wordsOf(p), at, streaming }));
      } else if (p.type === "reasoning") {
        if (!wordsOf(p).trim() && !streaming) continue;
        cur.items.push(textItem(memo, seen, { k: "think", id: string(p["id"]) ?? "", text: wordsOf(p), ms: spanMs(timeOf((p as { time?: unknown }).time)), at, streaming }));
      } else if (isToolPart(p)) {
        const step = stepIn(p, at, ctx, memo, seen);
        floor = Math.max(floor, step.at);
        if (step.family === "edit" && step.status === "completed" && step.object) {
          const f = cur.files.get(step.object) ?? { add: 0, del: 0 };
          f.add += step.add; f.del += step.del;
          cur.files.set(step.object, f);
        }
        cur.items.push(step);
      } else if (p.type === "compaction" || p.type === "file" || p.type === "image") {
        /* a compaction rides the user message (handled above); an attached file or picture is drawn from the message itself */
      } else if (importedOnly(p)) {
        /* a step's start and finish (with its cost and tokens), the files it changed and a subtask someone started: parts
           only imported (cmx) history carries (cmx2 a15, contract 6). nothing draws them yet, and they are not unknown */
      } else cur.unknownParts++;
    }
  }
  for (const t of turns) {
    const last = t.items.at(-1);
    if (last?.k === "say") {
      t.answer = last;
      t.items = t.items.slice(0, -1);
    }
  }
  for (const id of memo.keys()) if (!seen.has(id)) memo.delete(id);
  return turns;
}

/* the spawn steps of a turn, by turn object: a turn that did not change is the same object, so what reads every turn's
   agents (the roster, the kin, the child keys) reads each unchanged turn once */
const spawns = new WeakMap<Turn, readonly Step[]>();
export function spawnsOf(t: Turn): readonly Step[] {
  let found = spawns.get(t);
  if (!found) { found = t.items.filter((x): x is Step => x.k === "step" && x.family === "spawn"); spawns.set(t, found); }
  return found;
}

/** the messages the thread shows. a user message is announced a moment before its text arrives (its parts follow as their
    own events): painted alone it is an empty bubble that grows by its first line, and everything below it is pushed
    down. the newest message waits, unshown, until it has a part, so a turn appears whole */
export function shownMessages<T extends WireMessage>(all: readonly T[]): readonly T[] {
  const n = shownCount(all);
  return n === all.length ? all : all.slice(0, n);
}

/** how many of the messages are shown: all of them, or all but a newest user message that has no part yet. read by index, so it
    can be taken from a store's array without reading every message */
export function shownCount(all: ArrayLike<WireMessage>): number {
  const n = all.length;
  const last = n ? all[n - 1] : undefined;
  return last && last.info.role === "user" && last.parts.length === 0 ? n - 1 : n;
}

/** a turn's items as they stand while it runs: the prose after the last step is not yet what the turn came to, it is
    the newest row of the live window, and it streams there. settled, it is `turn.answer` and the ledger leaves it out */
export const liveItemsOf = (t: Turn): readonly Item[] => (t.answer ? [...t.items, t.answer] : t.items);

/** the pending asks joined onto their steps, so a waiting row can show its card */
export function joinAsks(turns: Turn[], permissions: readonly { id: string; permission: string; patterns: string[]; tool?: { messageID: string; callID: string } }[], questions: readonly { id: string; questions: readonly unknown[]; tool?: { messageID: string; callID: string } }[]): void {
  const byCall = new Map<string, Step>();
  for (const t of turns) for (const it of t.items) if (it.k === "step") byCall.set(it.callID, it);
  for (const p of permissions) { const s = p.tool && byCall.get(p.tool.callID); if (s) s.permission = { id: p.id, permission: p.permission, patterns: p.patterns }; }
  for (const q of questions) {
    const s = q.tool && byCall.get(q.tool.callID);
    if (s) s.question = { id: q.id };
    if (s && !s.questions?.length) s.questions = q.questions.flatMap((x) => { const r = record(x); return r ? [{ question: string(r["question"]) ?? "", header: string(r["header"]) ?? "", options: list(r["options"]).flatMap((o) => { const y = record(o); return y ? [{ label: string(y["label"]) ?? "", description: string(y["description"]) ?? "" }] : []; }), custom: r["custom"] !== false, multiple: r["multiple"] === true, answer: undefined }] : []; });
  }
}

/** the deepest directory holding 85% of the files a session touched, for imported sessions whose directory is `/` */
export function projectRoot(directory: string, messages: readonly WireMessage[]): string {
  if (directory && directory !== "/") return directory;
  const counts = new Map<string, number>();
  let files = 0;
  for (const m of messages) for (const p of m.parts) {
    if (!isToolPart(p)) continue;
    const fp = string(record(p.state.input)?.["filePath"]);
    if (fp === undefined) continue;
    files++;
    const parts = fp.split("/");
    for (let i = 3; i < parts.length; i++) { const k = parts.slice(0, i).join("/"); counts.set(k, (counts.get(k) ?? 0) + 1); }
  }
  return [...counts].filter(([, c]) => c >= files * 0.85).sort((a, b) => b[0].length - a[0].length)[0]?.[0] ?? directory;
}
