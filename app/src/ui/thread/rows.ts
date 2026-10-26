/* the ledger's rows: a turn's items folded into what a reader takes in, and
   what each row shows (docs/thread.md, the row, folding, display rules).
   pure; no dom. the components paint these. */

import type { Ask } from "../../sync/protocol";
import type { AskReply } from "../../sync/replies";
import { plainWords } from "../asks/words";
import type { Evidence } from "./evidence";
import { type Arrival, type Item, type Picture, type Question, type Say, type Step, type Think, type Turn, homeAsTilde } from "./model";
import { type Report, jobOf, reportOf } from "./report";
import { type Token, base, commandTokens, dirOf, firstLine, shortCommand } from "./shell";

/* ---------- folding ---------- */

export type FoldRow = { k: "fold"; family: "read" | "search" | "web"; tool: string; at: number; end: number; steps: Step[] };
export type ThinkRow = { k: "think"; at: number; end: number; ms: number; thoughts: Think[] };
export type SayRow = { k: "say"; at: number; end: number; say: Say };
export type StepRow = { k: "step"; at: number; end: number; step: Step };
/** a report, a note or a notice that came into the turn (model.ts, Arrival): a row of its own at its place in time */
export type ArriveRow = { k: "arrive"; at: number; end: number; arrival: Arrival };
export type Row = SayRow | ThinkRow | FoldRow | StepRow | ArriveRow;

const foldable = (s: Step): s is Step & { family: "read" | "search" | "web" } => s.status === "completed" && (s.family === "read" || s.family === "search" || s.family === "web");

/** consecutive thoughts fold into one row; consecutive reads, searches or web lookups of one tool fold into one row.
    commands, edits, agents, asks and failures never fold; anything between two reads keeps them apart. */
export function rowsOf(items: readonly Item[]): Row[] {
  const rows: Row[] = [];
  for (const it of items) {
    const prev = rows.at(-1);
    if (it.k === "say") { rows.push({ k: "say", at: it.at, end: it.at, say: it }); continue; }
    if (it.k === "arrive") { rows.push({ k: "arrive", at: it.at, end: it.at, arrival: it }); continue; }
    if (it.k === "think") {
      if (prev?.k === "think" && !prev.thoughts.at(-1)?.streaming) { prev.thoughts.push(it); prev.ms += it.ms; prev.end = it.at + it.ms; }
      else rows.push({ k: "think", at: it.at, end: it.at + it.ms, ms: it.ms, thoughts: [it] });
      continue;
    }
    if (foldable(it)) {
      if (prev?.k === "fold" && prev.tool === it.tool) { prev.steps.push(it); prev.end = Math.max(prev.end, it.at + it.ms); continue; }
      rows.push({ k: "fold", family: it.family, tool: it.tool, at: it.at, end: it.at + it.ms, steps: [it] });
      continue;
    }
    rows.push({ k: "step", at: it.at, end: it.at + it.ms, step: it });
  }
  return rows;
}

/* ---------- words and numbers ---------- */

const numbers = new Intl.NumberFormat("en-US");
export const n = (x: number): string => numbers.format(x);
export const plural = (k: number, one: string, many = `${one}s`): string => `${n(k)} ${k === 1 ? one : many}`;
export function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export function clockDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}
const clockFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const clockSFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const clock = (t: number): string => clockFmt.format(t);
export const clockS = (t: number): string => clockSFmt.format(t);
export const minuteOf = (t: number): number => Math.floor(t / 60_000);

/** the first sentence of a thought, at least 24 characters, as its teaser */
export function firstSentence(t: string): string {
  const flat = t.replace(/\s+/g, " ").trim();
  const m = /^(.{24,}?[.!?])(\s|$)/.exec(flat);
  return m?.[1] ?? flat;
}
export const isBad = (s: Step): boolean => s.status === "error" && !s.interrupted;
export const isRunning = (s: Step): boolean => s.status === "running" || s.status === "pending";

/* ---------- kinds and results ---------- */

export type Kind = "run" | "watch" | "type" | "commit" | "push" | "edit" | "write" | "read" | "grep" | "find" | "recall" | "fetch" | "search" | "agent" | "ask" | "plan" | "skill" | "note" | "wait" | "agents" | "tool" | "thought" | "files" | "stopped" | "failed" | "report" | "status" | "job" | "notice";

export function kindOf(s: Step): Kind {
  switch (s.family) {
    case "search": return s.tool === "glob" ? "find" : s.tool === "grep" ? "grep" : "recall";
    case "edit": return s.tool === "write" ? "write" : "edit";
    case "web": return s.tool === "webfetch" ? "fetch" : "search";
    case "shell":
      if (s.polls !== undefined) return s.typed ? "type" : "watch";
      if (s.evidence?.kind === "commit") return "commit";
      if (s.evidence?.kind === "push") return "push";
      return "run";
    case "read": return "read";
    case "spawn": return "agent";
    case "message": return "note";
    case "wait": return "wait";
    case "agents": return "agents";
    case "ask": return "ask";
    case "plan": return "plan";
    case "skill": return "skill";
    default: return s.script ? "run" : "tool";
  }
}

/** what the result column shows: its words, its tone, and any figure beside them */
export type Result = {
  text: string;
  tone: "quiet" | "lit" | "bad" | "faint";
  /** a pass/fail meter, 0 to 1 passed */
  meter?: { passed: number; failed: number };
  hash?: string;
  tick?: boolean;
  /** a running clock from this moment */
  clockFrom?: number;
  add?: number;
  del?: number;
};
const quiet = (text: string): Result => ({ text, tone: "quiet" });
const none: Result = { text: "", tone: "quiet" };

export function readout(s: Step, now?: number): Result {
  if (isRunning(s)) return { text: now !== undefined ? clockDur(Math.max(0, now - s.at)) : "running", tone: "lit", clockFrom: s.at };
  if (s.interrupted) return { text: "stopped", tone: "faint" };
  if (isBad(s)) return { text: s.family === "shell" && s.exit !== undefined ? `exit ${s.exit}` : "failed", tone: "bad" };
  const took = s.ms >= 1500 ? dur(s.ms) : "";
  const e: Evidence | undefined = s.evidence;
  if (e?.kind === "tests") return { text: e.failed ? `${n(e.failed)} failed` : `${n(e.passed)} passed`, tone: e.failed ? "bad" : "lit", meter: { passed: e.passed, failed: e.failed } };
  if (e?.kind === "build") return { text: e.ok ? (e.warnings ? `built, ${n(e.warnings)} warnings` : "no errors") : (e.errors ? `${n(e.errors)} errors` : "build failed"), tone: e.ok ? "lit" : "bad" };
  if (e?.kind === "commit") return e.hash ? { text: e.hash.slice(0, 7), tone: "lit", hash: e.hash.slice(0, 7) } : { text: "committed", tone: "lit" };
  if (e?.kind === "push") return { text: "pushed", tone: "lit", tick: true };
  if (s.family === "shell") return quiet(took);
  if (s.family === "edit") {
    if (s.tool === "write") return { text: `+${n(s.add)}${/^new/.test(s.result) ? " new" : ""}`, tone: "quiet", add: s.add };
    return s.diff === undefined ? none : { text: `+${n(s.add)} -${n(s.del)}`, tone: "quiet", add: s.add, del: s.del };
  }
  if (s.family === "read") {
    const sp = s.span;
    if (!sp) return none;
    const k = sp.end - sp.start + 1;
    return quiet(sp.total !== undefined && k < sp.total ? `${n(k)} of ${n(sp.total)}` : plural(sp.total ?? k, "line"));
  }
  if (s.family === "spawn" || s.family === "ask") return none;
  return quiet(s.result || took);
}

/* ---------- what a row shows ---------- */

/** one piece of a row's content */
export type Inline =
  | { t: "text"; s: string }
  | { t: "lead"; s: string }
  | { t: "fn"; s: string }
  | { t: "dir"; s: string }
  | { t: "str"; s: string }
  | { t: "brief"; s: string }
  | { t: "prose"; s: string }
  | { t: "cmd"; tokens: Token[] };

/** the model of one row as painted: kind, content, result, and what opens beneath */
export type RowModel = {
  key: string;
  kind: Kind;
  /** the row's face: mono for the machine, sans for language */
  face: "mono" | "sans";
  content: Inline[];
  /** the open thought row's lead ("for 20 s") in place of the teaser */
  opened?: string;
  /** a question's own short label, above its words in the head (an ask of several questions has each one's in its card) */
  header?: string;
  result: Result;
  body: Body | undefined;
  /** open when first painted: failures, pending asks */
  open: boolean;
  bad: boolean;
  stopped: boolean;
  running: boolean;
  /** the accessible name */
  label: string;
  at: number;
  end: number;
  /** the row is a two-line clamp while closed */
  clamps: boolean;
  /** the daemon's part ids this row shows, for links */
  partIDs: string[];
  /** the result is a link: to the report an agent sent, the turn that holds it, and the part that shows it there (the arrival's
      message id, or the turn's own for a report that started a turn) */
  link?: { report: string; turn: string; part: string };
  /** an agent row's name, so a report can link back to it */
  agent?: string;
  /** an agent row's child session, which the stage holds once the row is on screen */
  child?: string;
  /** a settled permission's record, when this device replied to it: the line above the tool's own body ("you allowed it once") */
  permit?: AskReply;
};

export type Bed = { lines: string[]; cut?: { at: number; n: number }; /** lines past what a bed opens to, said under the last */ rest?: number; /** a line shown was cut at the cap: the bed is not all of what the output holds, whatever it says it cut */ clipped?: boolean };
export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk" | "tail"; text: string };
/** how many thumbnails one open row draws: a row of eight is a screen of them on a phone, and every one is an image the browser decodes */
export const MAX_PICTURES = 8;

/** the pictures of a row's groups (one group for each file it names), the first MAX_PICTURES of them in order, and how many are
    left: the ones past the cap and the ones the daemon dropped past its own. the pictures are the same objects, and so the
    same data url strings, as the steps hold */
export function capPictures(groups: ReadonlyArray<readonly Picture[]>, dropped = 0): { groups: Picture[][]; more: number } {
  let room = MAX_PICTURES, all = 0;
  const kept = groups.map((g) => { all += g.length; const keep = g.slice(0, room); room -= keep.length; return keep; });
  return { groups: kept, more: all - (MAX_PICTURES - room) + dropped };
}
/** the accessible names of a row's thumbnails, in order: "image foo.png". a name that comes more than once says its place among
    them ("image foo.png, 2 of 3"), so every control in a row has a name of its own */
export function pictureNames(pics: readonly Pick<Picture, "filename">[]): string[] {
  const names = pics.map((p) => (p.filename ? `image ${p.filename}` : "image"));
  const total = new Map<string, number>();
  for (const name of names) total.set(name, (total.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((name) => {
    const of = total.get(name) ?? 1;
    if (of === 1) return name;
    const at = (seen.get(name) ?? 0) + 1;
    seen.set(name, at);
    return `${name}, ${at} of ${of}`;
  });
}
const imagesSaid = (shown: number, dropped: number): string => plural(shown + dropped, "image");

export type FileLine = { path: string; note: string; /** what the read returned as images, for the thumbnails under the file's line */ images?: Picture[]; bar?: { total: number; reads: Array<{ start: number; end: number }>; hunks: Array<{ start: number; add: number; del: number }> }; diff?: DiffLine[]; created?: boolean; add?: number; del?: number };

export type Body =
  | { k: "shell"; facts: Fact[]; /** the command in its bed, as it is shown (home as ~): every open shell row has one, so its copy control is always on the command */ command?: string[]; /** the command as the agent sent it, which its copy control copies */ commandRaw?: string | undefined; output?: Bed; /** how many lines the output has, which its bed's header says */ outputLines?: number | undefined; /** the output as the store holds it, for its copy control to clean and copy at the press */ outputRaw?: string | undefined; /** what the command returned as images, and how many more there were */ images?: Picture[]; more?: number; error?: string }
  /** a script's open row (cmx2's `run`): the code whole in its own bed, its facts, then what it printed and returned in the output's bed, as a command's */
  | { k: "script"; /** the code as the agent sent it, which its bed shows and its copy control copies */ code: string; facts: Fact[]; output?: Bed; outputLines?: number | undefined; outputRaw?: string | undefined; /** still running: no output yet is not "no output" */ running?: true; images?: Picture[]; more?: number; error?: string }
  | { k: "diff"; bar?: FileLine["bar"]; lines?: DiffLine[]; /** a write's whole content, which "show the whole diff" opens when its lines stop at 80 */ wrote?: string; none?: string; error?: string }
  | { k: "read"; files: FileLine[]; preview?: Bed; /** the preview as the file's own lines, numbered from where the read began, for its bed and the reader */ file?: { path: string; lines: string[]; from: number; total?: number | undefined; /** the read's whole output, which its bed and the reader take every line from (evidence.ts, readLines) */ raw?: string | undefined; /** how many lines the read returned, when it said */ read?: number | undefined }; /** images the row does not draw: past its cap, or dropped by the daemon */ more?: number; error?: string }
  | { k: "images"; images: Picture[]; more?: number }
  | { k: "hits"; files: Array<{ path: string; hits: Array<{ line: string; text: string }> }>; list: string[]; spread: Array<{ name: string; n: number }>; error?: string }
  | { k: "message"; to: string; text: string }
  | { k: "agent"; facts: Fact[]; brief: string; name: string; /** its session, when it started: the door to its thread */ child?: string }
  | { k: "ask"; askID?: string; questions: AskQuestion[]; dismissed: boolean; pending: boolean; /** what came of it once it is not pending: answered, dismissed (the daemon's words for a dismissal), or ended (any other error: its turn stopped under it), and when the daemon settled it */ settled?: { how: "answered" | "dismissed" | "ended"; at?: number }; /** this device's record of its reply, once settled: who answered and when, which the transcript does not keep (sync/replies.ts) */ record?: Pick<AskReply, "who" | "at"> }
  | { k: "permission"; askID?: string; what: string; permission: string; patterns: string[]; diff?: DiffLine[] }
  | { k: "plan"; todos: Array<{ content: string; status: "done" | "now" | "later" }> }
  | { k: "thoughts"; thoughts: Array<{ at: number; ms: number; text: string; streaming: boolean }> }
  | { k: "files"; files: FileLine[] }
  | { k: "error"; error: string }
  /** a report or note that arrived: the row's press raises it in its sheet (report-sheet.tsx), as a report's chip does */
  | { k: "report"; report: Report }
  /** a notice whose words have no shape the row reads (a system line, a job's of another shape): its facts and its whole words */
  | { k: "notice"; facts: Fact[]; text: string };

export type Fact = { text: string; strong?: boolean; bad?: boolean };

export function diffLines(diff: string): DiffLine[] {
  return diff.split("\n").filter((l) => !l.startsWith("@@")).map((l): DiffLine => l.startsWith("+\u0002") ? { kind: "tail", text: `and ${plural(Number(l.slice(2)), "more line", "more lines")}` } : l === "\u0001" ? { kind: "hunk", text: "then" } : { kind: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx", text: l });
}
const bedOf = (o: { lines: string[]; cut: number; cutAt: number; clipped?: boolean } | undefined): Bed | undefined => (o ? { lines: o.lines, ...(o.cut ? { cut: { at: o.cutAt, n: o.cut } } : {}), ...(o.clipped ? { clipped: true } : {}) } : undefined);
const file = (path: string): Inline[] => [{ t: "fn", s: base(path) }, ...(dirOf(path) ? [{ t: "dir", s: dirOf(path) } as const] : [])];

/** where an agent's child session is now, from the fleet: in a turn, waiting on the person, parked on its own agents or
    jobs, idle (its turn ended; its report follows, or never came), or gone (archived or deleted: no thread to open) */
export type ChildState = "working" | "wants" | "parked" | "idle" | "gone";

/** an agent's child session as the parent reads it: its counts, its span, its items for the tape's lane, and where it is
    now. `since` is when its current state began (the daemon's `status.since`), for the live clock; `created` when the
    session was made, the start of an agent no spawn row names */
export type Child = {
  /** its steps, from its held thread: 0 while it is not held, which `held` says (the count is left off then, never shown as zero) */
  steps: number;
  ms: number;
  items: readonly Item[];
  /** its thread is held, so `steps` and `items` are its own; else all of this is read from the fleet's session info alone */
  held: boolean;
  state: ChildState;
  since: number;
  created: number;
  title: string;
};

/** the daemon titles a child "name (seat)" (`actors.ts`): the two apart, for an agent no spawn row names */
export function agentTitle(title: string): { name: string; seat?: string } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(title.trim());
  return m ? { name: m[1] || title.trim(), ...(m[2] ? { seat: m[2] } : {}) } : { name: title.trim() };
}

/** one question of an ask, as its card asks it: the daemon takes one answer (a list of labels or words) for each */
export type AskQuestion = { header: string; question: string; options: Array<{ label: string; description: string }>; custom: boolean; multiple: boolean; answer?: string[] };

/** an ask the daemon is waiting on, keyed by the tool call that raised it (the fleet's `asks`) */
/** a pending ask as the fleet holds it (sync/protocol.ts, `Ask`): a permission's words, or a question's */
export type PendingAsk = { id: string; kind: "permission" | "question"; permission: Ask["permission"]; questions: Ask["questions"] };

/** what a running wait waits on, in words, from what is known while it runs: the agents under it at work, a reply it
    asked for (by correlation id, or the agent it just messaged), else a background job's notice or a message. the daemon
    says nothing of the wait's own target, so this never names agents that are not at work (docs/thread.md, the status line) */
export function waitingOn(w: { agents: number; reply: boolean; replyFrom?: string }): string {
  if (w.agents) return plural(w.agents, "agent");
  if (w.replyFrom) return `a reply from ${w.replyFrom}`;
  if (w.reply) return "a reply";
  return "a job or a message";
}

/** the context a row is painted in */
export type RowCtx = {
  /** the reports that came into the thread, so an agent row can find its own (`mailsOf`) */
  reports: readonly Mail[];
  /** the agents' child sessions by id */
  children: ReadonlyMap<string, Child>;
  /** the asks still pending, by the call id of the step that raised them */
  asks?: ReadonlyMap<string, PendingAsk>;
  /** this device's records of the asks it replied to in this thread, by the call id of the step that raised them */
  replies?: ReadonlyMap<string, AskReply>;
  /** the moment, while the turn runs */
  now?: number;
  /** the moment, while any of the turn's agents still works after the turn itself ended: the agent rows' clock */
  tick?: number;
  thinking: "open" | "rows";
};

function hitsBody(s: Step): Extract<Body, { k: "hits" }> {
  const files = new Map<string, Array<{ line: string; text: string }>>();
  if (s.tool === "grep") for (const h of s.hits ?? []) {
    const m = /^(.*?):(\d+)\s{2}(.*)$/.exec(h);
    if (!m) continue;
    const f = files.get(m[1] ?? "") ?? [];
    f.push({ line: m[2] ?? "", text: m[3] ?? "" });
    files.set(m[1] ?? "", f);
  }
  return { k: "hits", files: [...files].map(([path, hits]) => ({ path, hits })), list: s.tool === "grep" ? [] : (s.hits ?? []), spread: s.spread ?? [], ...(isBad(s) && s.error ? { error: s.error } : {}) };
}

/** a report an agent row can link to: one that arrived inside a turn, or one that started a turn of its own (it came before
    anything from the person). `part` is what shows it, the arrival's row or the turn's chip, and `status` says it is the
    daemon's status line alone (report.ts, statusOf) */
export type Mail = { part: string; turn: string; from?: string; fromID?: string; at: number; status: boolean };

const mailOfArrival = new WeakMap<Arrival, Mail>();
const mailsOfTurn = new WeakMap<Turn, readonly Mail[]>();
const NO_MAIL: readonly Mail[] = [];
const isStatus = (text: string): boolean => reportOf({ prompt: text, at: 0 }).kind === "status";

/** a turn's reports, by turn object and by arrival object: a turn that did not change is read once, and an arrival kept through a
    rebuild (model.ts, arrivalIn) keeps its object here too, so the list an agent row reads changes only when a report comes */
export function mailsOf(t: Turn): readonly Mail[] {
  let found = mailsOfTurn.get(t);
  if (found) return found;
  const out: Mail[] = [];
  if (t.by === "mail" && !t.note) out.push({ part: t.id, turn: t.id, ...(t.from ? { from: t.from } : {}), ...(t.fromID ? { fromID: t.fromID } : {}), at: t.at, status: isStatus(t.prompt) });
  for (const x of t.items) {
    if (x.k !== "arrive" || x.kind !== "report") continue;
    let m = mailOfArrival.get(x);
    if (!m || m.turn !== t.id) { m = { part: x.id, turn: t.id, ...(x.from ? { from: x.from } : {}), ...(x.fromID ? { fromID: x.fromID } : {}), at: x.at, status: isStatus(x.text) }; mailOfArrival.set(x, m); }
    out.push(m);
  }
  found = out.length ? out : NO_MAIL;
  mailsOfTurn.set(t, found);
  return found;
}

/** the report an agent row links to: the first its agent sent after it started (by its session when the daemon named the sender,
    else by its name), and by now when the turn runs. a report with words is preferred to a status line alone (a child that parked
    on agents of its own reports later); the status stands in while it is all that came */
export function reportFor(ctx: RowCtx, s: Step): Mail | undefined {
  const a = s.agent;
  if (!a?.child) return undefined;
  let status: Mail | undefined;
  for (const m of ctx.reports) {
    if (!(m.fromID ? m.fromID === a.child : m.from === a.name) || m.at < s.at || (ctx.now !== undefined && m.at > ctx.now)) continue;
    if (!m.status) return m;
    status ??= m;
  }
  return status;
}

/** the pending ask on a step, from the step itself (a fixture's join) or from the fleet's list by call id */
function askOn(s: Step, ctx: RowCtx): { permission?: { id: string; permission: string; patterns: string[] }; question?: { id: string; questions: Question[] } } {
  const pending = ctx.asks?.get(s.callID);
  if (pending?.kind === "permission") {
    /* `title` holds cmx2's `permission` key unchanged (the server's translate) */
    const r: Record<string, unknown> = pending.permission ?? {};
    return { permission: { id: pending.id, permission: typeof r["title"] === "string" ? r["title"] : "use", patterns: Array.isArray(r["patterns"]) ? r["patterns"].filter((p): p is string => typeof p === "string") : [] } };
  }
  if (pending?.kind === "question") {
    const list: readonly unknown[] = pending.questions ?? [];
    const questions: Question[] = list.flatMap((q) => {
      if (q === null || typeof q !== "object") return [];
      const r = q as Record<string, unknown>;
      const options = Array.isArray(r["options"]) ? r["options"].flatMap((o) => (o !== null && typeof o === "object" ? [{ label: String((o as Record<string, unknown>)["label"] ?? ""), description: String((o as Record<string, unknown>)["description"] ?? "") }] : [])) : [];
      return [{ question: String(r["question"] ?? ""), header: String(r["header"] ?? ""), options, custom: r["custom"] !== false, multiple: r["multiple"] === true, answer: undefined }];
    });
    return { question: { id: pending.id, questions } };
  }
  if (s.permission) return { permission: s.permission };
  if (s.question && s.questions?.length) return { question: { id: s.question.id, questions: s.questions } };
  return {};
}

export function stepModel(s: Step, ctx: RowCtx): RowModel {
  const bad = isBad(s), running = isRunning(s), kind = kindOf(s);
  const rep = s.family === "spawn" ? reportFor(ctx, s) : undefined;
  let result = readout(s, ctx.now);
  let content: Inline[] = [], body: Body | undefined, face: RowModel["face"] = "mono", text = "", header = "";
  const error = bad && s.error ? { error: s.error } : {};
  const ask = askOn(s, ctx);
  /* this device's reply to the ask the step raised, once it settled */
  const replied = running ? undefined : ctx.replies?.get(s.callID);
  const permit = replied?.kind === "permission" ? replied : undefined;
  /* the images the tool returned, as many as a row draws, and the count of the rest */
  const capped = capPictures([s.images ?? []], s.imagesDropped);
  const shown = capped.groups[0] ?? [];
  const pictured = shown.length ? { images: shown, ...(capped.more ? { more: capped.more } : {}) } : capped.more ? { more: capped.more } : {};
  switch (s.family) {
    case "shell": {
      const e = s.evidence;
      const facts: Fact[] = [];
      /* where it ran is in the facts unless the command's own bed says so (a leading `cd dir &&`), and how many lines it wrote is its output bed's header */
      if (s.cwd && !(s.command && firstLine(s.command).cwd !== undefined)) facts.push({ text: `in ${s.cwd}`, strong: true });
      if (s.exit !== undefined) facts.push(s.exit === 0 ? { text: "exit 0" } : { text: `exit ${s.exit}`, bad: true });
      if (s.ms >= 1000) facts.push({ text: dur(s.ms) });
      // the ledger's clock hangs in a margin the phone has no room for: an open row says exactly when it ran
      facts.push({ text: `at ${clockS(s.at)}` });
      if (kind === "commit" && e?.kind === "commit") {
        content = [{ t: "prose", s: e.subject ?? "committed" }]; face = "sans"; text = e.subject ?? "committed";
        if (e.files !== undefined) facts.unshift({ text: `+${n(e.add ?? 0)} -${n(e.del ?? 0)} in ${plural(e.files, "file")}` });
      } else if (kind === "push" && e?.kind === "push") {
        content = [{ t: "text", s: e.from }, { t: "lead", s: " to " }, { t: "text", s: e.to === e.from ? "origin" : e.to }]; text = `${e.from} to origin`;
      } else if (kind === "watch" || kind === "type") {
        const watched: Inline = s.polls ? { t: "cmd", tokens: commandTokens(s.polls).tokens } : { t: "lead", s: "a running command" };
        content = s.typed ? [{ t: "str", s: JSON.stringify(s.typed).slice(1, -1) }, { t: "lead", s: " into " }, watched] : [watched];
        text = s.polls || "a running command";
      } else {
        content = [{ t: "cmd", tokens: commandTokens(s.object).tokens }]; text = s.object.split("\n")[0] ?? "";
      }
      body = { k: "shell", facts, ...(s.command ? { command: homeAsTilde(s.command).split("\n") } : {}), commandRaw: s.command || undefined, ...(s.output ? { output: bedOf(s.output) as Bed } : {}), outputLines: s.output ? s.outputLines : undefined, outputRaw: s.output?.raw, ...pictured, ...error };
      break;
    }
    case "edit": {
      content = file(s.object); text = s.object;
      const bar = s.total !== undefined && s.hunks?.length ? { total: s.total, reads: [], hunks: s.hunks } : undefined;
      if (ask.permission) {
        body = { k: "permission", askID: ask.permission.id, what: `${ask.permission.permission} ${ask.permission.patterns[0] ?? base(s.object)}`, permission: ask.permission.permission, patterns: ask.permission.patterns, ...(s.diff !== undefined ? { diff: diffLines(s.diff) } : {}) };
        result = { text: "wants you", tone: "lit" };
      } else body = { k: "diff", ...(bar ? { bar } : {}), ...(s.diff !== undefined ? { lines: diffLines(s.diff), ...(s.wrote !== undefined ? { wrote: s.wrote } : {}) } : { none: s.tool === "write" ? `wrote ${plural(s.add, "line")}` : "no diff was recorded for this edit" }), ...error };
      break;
    }
    case "read": {
      content = file(s.object); text = s.object;
      const partial = s.span?.total !== undefined && s.span.end - s.span.start + 1 < s.span.total;
      // a failed read has no file line: the row already names the file and the result, and the error bed says why
      const files = s.status === "error" ? [] : [{ path: s.object, note: result.text || (s.images?.length ? plural(s.images.length, "image") : ""), ...(shown.length ? { images: shown } : {}), ...(partial && s.span ? { bar: { total: s.span.total as number, reads: [s.span], hunks: [] } } : {}) }];
      body = { k: "read", files, ...(s.output ? { preview: bedOf(s.output) as Bed, file: { path: s.object, lines: s.output.lines, from: s.span?.start ?? 1, total: s.span?.total, raw: s.readRaw, read: s.span ? s.span.end - s.span.start + 1 : undefined } } : {}), ...(capped.more ? { more: capped.more } : {}), ...error };
      // a read of a picture has no lines to count: the row says how many images instead, so a closed row says it opens
      if (!result.text && s.status === "completed" && (s.images?.length || s.imagesDropped)) result = quiet(imagesSaid(s.images?.length ?? 0, s.imagesDropped ?? 0));
      if (ask.permission) { body = { k: "permission", askID: ask.permission.id, what: `read ${ask.permission.patterns[0] ?? base(s.object)}`, permission: ask.permission.permission, patterns: ask.permission.patterns }; result = { text: "wants you", tone: "lit" }; }
      break;
    }
    case "search": {
      content = s.tool === "glob" ? [{ t: "text", s: s.object }] : [{ t: "str", s: s.object }, ...(s.cwd ? [{ t: "lead", s: ` in ${s.cwd}` } as const] : [])]; text = s.object;
      body = hitsBody(s);
      break;
    }
    case "web": {
      if (s.tool === "webfetch") {
        let u: URL | null = null;
        try { u = new URL(s.object); } catch { u = null; }
        content = u ? [{ t: "text", s: u.host.replace(/^www\./, "") }, { t: "dir", s: u.pathname.length > 1 ? u.pathname : "" }] : [{ t: "text", s: s.object }];
      } else content = [{ t: "str", s: s.object }];
      text = s.object; body = hitsBody(s);
      break;
    }
    case "spawn": {
      const a = s.agent ?? { name: "agent", brief: "" };
      const child = a.child ? ctx.children.get(a.child) : undefined;
      const clock = ctx.now ?? ctx.tick;
      /* the child's own state decides the row once it exists: a live clock while it works (from when it was started),
         "wants you" while the daemon waits on the person for it, "parked" while it waits on agents of its own, its
         report once that came, and its step count when its turn ended without one */
      const busy = child?.state === "working";
      content = [{ t: "fn", s: a.name }, { t: "brief", s: firstSentence(a.brief) }]; text = a.name;
      if (rep) result = quiet("reported");
      else if (!a.child) result = none;
      else if (busy) result = { text: clockDur(Math.max(0, (clock ?? s.at) - s.at)), tone: "lit", clockFrom: s.at };
      else if (child?.state === "wants") result = { text: "wants you", tone: "lit" };
      else if (child?.state === "parked") result = quiet("parked");
      else if (child?.state === "gone") result = quiet("archived");
      else if (child) result = quiet(child.held ? plural(child.steps, "step") : "");
      else result = ctx.now !== undefined ? { text: clockDur(Math.max(0, ctx.now - s.at)), tone: "lit", clockFrom: s.at } : none;
      const took = rep ? rep.at - s.at : busy ? Math.max(0, (clock ?? s.at) - s.at) : child?.ms;
      const facts: Fact[] = [{ text: rep ? `reported after ${dur(took ?? 0)}` : !a.child ? "did not start" : busy ? `working for ${dur(took ?? 0)}` : child?.state === "wants" ? "waiting on you" : child?.state === "parked" ? "parked on agents of its own" : child?.state === "gone" ? "its thread was archived" : child ? "its turn ended, no report" : "starting", strong: !!rep }];
      if (child?.held && child.state !== "gone") facts.push({ text: plural(child.steps, "step") });
      if (a.type) facts.push({ text: a.type });
      facts.push({ text: `started ${clockS(s.at)}` });
      // the whole brief opens beneath; a one-sentence brief is already the teaser, and nothing is shown twice. the door
      // opens only a thread that is still there
      body = { k: "agent", facts, brief: firstSentence(a.brief) === a.brief.replace(/\s+/g, " ").trim() ? "" : a.brief, name: a.name, ...(a.child && child && child.state !== "gone" ? { child: a.child } : {}) };
      break;
    }
    case "ask": {
      const asked = ask.question?.questions ?? s.questions ?? [];
      const questions: AskQuestion[] = asked.map((q) => ({ header: q.header, question: q.question, options: q.options, custom: q.custom, multiple: q.multiple, ...(q.answer?.some(Boolean) ? { answer: q.answer.filter(Boolean) } : {}) }));
      // several questions have no one question to head the row: it says how many, and the card asks each. the head is a button and its
      // name: the question as plain words (its markdown is the card's, with its links and its copy control)
      const head = questions.length > 1 ? `${questions.length} questions` : (plainWords(questions[0]?.question ?? "") || "a question");
      content = [{ t: "prose", s: head }]; face = "sans"; text = head;
      if (questions.length === 1) header = questions[0]?.header.trim() ?? "";
      const how = s.status !== "error" ? "answered" : /dismiss/i.test(s.error ?? "") ? "dismissed" : "ended";
      body = { k: "ask", ...(ask.question ? { askID: ask.question.id } : {}), questions, dismissed: bad || (s.status === "error" && !!s.interrupted), pending: running, ...(running ? {} : { settled: { how, ...(s.ms > 0 ? { at: s.at + s.ms } : {}) } }), ...(replied?.kind === "question" ? { record: { who: replied.who, at: replied.at } } : {}) };
      result = running ? (ask.question ? { text: "wants you", tone: "lit" } : { text: "waiting", tone: "faint" }) : s.status === "error" ? quiet("dismissed") : questions.some((q) => q.answer) ? quiet("answered") : none;
      break;
    }
    case "plan": {
      const todos = s.todos ?? [];
      const now = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status !== "completed");
      content = [{ t: "brief", s: now ? now.content : "all done" }]; text = now?.content ?? "plan";
      body = { k: "plan", todos: todos.map((t) => ({ content: t.content, status: t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : "later" })) };
      break;
    }
    case "skill": content = [{ t: "text", s: s.object }]; text = s.object; break;
    case "message": content = [{ t: "lead", s: "to " }, { t: "text", s: s.object || "parent" }]; text = `to ${s.object || "parent"}`; if (s.words) body = { k: "message", to: s.object || "parent", text: s.words }; break;
    case "wait": {
      /* what it waits on while it runs, who it heard from once it has (docs/thread.md, the rows) */
      let working = 0;
      if (running) for (const c of ctx.children.values()) if (c.state === "working") working++;
      if (running) { text = `for ${waitingOn({ agents: working, reply: !!s.reply })}`; content = [{ t: "lead", s: text }]; }
      else if (s.object) { content = [{ t: "lead", s: "from " }, { t: "text", s: s.object }]; text = `from ${s.object}`; }
      else if (s.result === "timed out") { content = [{ t: "lead", s: "nothing came" }]; text = "nothing came"; }
      break;
    }
    default: {
      content = [{ t: "text", s: s.object }]; text = s.object;
      if (s.script && s.code !== undefined) {
        const facts: Fact[] = [];
        if (s.ms >= 1000) facts.push({ text: dur(s.ms) });
        facts.push({ text: `at ${clockS(s.at)}` });
        body = { k: "script", code: s.code, facts, ...(s.output ? { output: bedOf(s.output) as Bed } : {}), outputLines: s.output ? s.outputLines : undefined, outputRaw: s.output?.raw, ...(running ? { running: true } : {}), ...pictured, ...error };
      }
    }
  }
  if (body === undefined && shown.length) body = { k: "images", images: shown, ...(capped.more ? { more: capped.more } : {}) };
  if (bad && s.error && body === undefined) body = { k: "error", error: s.error };
  /* a running question the daemon has not raised yet waits closed; a raised ask is open */
  const pendingAsk = running && (ask.permission !== undefined || ask.question !== undefined);
  return {
    key: s.id, kind, face, content, ...(header ? { header } : {}), result, body, open: bad || pendingAsk || (permit !== undefined && body !== undefined), bad, stopped: !!s.interrupted, running,
    label: `${kind} ${text}${result.text ? `, ${result.text}` : ""}`, at: s.at, end: s.at + s.ms,
    clamps: !(s.family === "read" || s.family === "edit" || s.family === "ask"),
    partIDs: [s.id],
    ...(permit ? { permit } : {}),
    ...(s.family === "spawn" && s.agent ? { agent: s.agent.name } : {}),
    ...(s.family === "spawn" && s.agent?.child ? { child: s.agent.child } : {}),
    ...(s.family === "spawn" && s.agent && rep ? { link: { report: s.agent.name, turn: rep.turn, part: rep.part } } : {}),
  };
}

/** a fold of reads, searches or lookups: the names inline up to six, the count past that, every one listed beneath */
export function foldModel(f: FoldRow, ctx: RowCtx): RowModel {
  const steps = f.steps;
  const kind = kindOf(steps[0] as Step);
  if (f.family === "read") {
    const byFile = new Map<string, { path: string; spans: Array<{ start: number; end: number }>; total?: number; preview?: Bed; images: Picture[] }>();
    let dropped = 0;
    for (const s of steps) {
      const x = byFile.get(s.object) ?? { path: s.object, spans: [], images: [], ...(s.output ? { preview: bedOf(s.output) as Bed } : {}) };
      if (s.span) { x.spans.push(s.span); if (s.span.total !== undefined) x.total = s.span.total; }
      if (s.images) x.images.push(...s.images);
      dropped += s.imagesDropped ?? 0;
      byFile.set(s.object, x);
    }
    const files = [...byFile.values()];
    // the pictures of the whole fold, grouped under the file that returned them, up to what a row draws
    const capped = capPictures(files.map((x) => x.images), dropped);
    const pictures = files.reduce((a, x) => a + x.images.length, 0);
    const one = files.length === 1 ? files[0] : undefined;
    const lines: FileLine[] = files.map((x, i) => {
      const read = x.spans.reduce((a, sp) => a + (sp.end - sp.start + 1), 0);
      const partial = x.total !== undefined && (x.spans.length > 1 || read < x.total);
      const note = !x.spans.length && x.images.length ? plural(x.images.length, "image") : x.spans.length > 1 ? `${x.spans.length} reads` : x.total !== undefined && read < x.total ? `${n(read)} of ${n(x.total)}` : plural(x.total ?? read, "line");
      const images = capped.groups[i] ?? [];
      return { path: x.path, note, ...(images.length ? { images } : {}), ...(partial && x.total !== undefined ? { bar: { total: x.total, reads: x.spans, hunks: [] } } : {}) };
    });
    const content: Inline[] = one ? file(one.path) : files.length <= 6 ? files.flatMap((x, i) => [...(i ? [{ t: "text", s: ", " } as const] : []), { t: "fn", s: base(x.path) } as const]) : [{ t: "text", s: plural(files.length, "file") }];
    const base0 = one ? readout(steps[0] as Step) : none;
    // pictures have no lines to count: the row says how many images there are instead, so a closed row says it opens
    const result = !base0.text && (pictures || dropped) ? quiet(imagesSaid(pictures, dropped)) : base0;
    return { key: `fold:${f.at}`, kind, face: "mono", content, result, body: { k: "read", files: lines, ...(one?.preview ? { preview: one.preview, file: { path: one.path, lines: one.preview.lines, from: one.spans[0]?.start ?? 1, total: one.total, ...(steps.length === 1 ? { raw: steps[0]?.readRaw, read: one.spans[0] ? one.spans[0].end - one.spans[0].start + 1 : undefined } : {}) } } : {}), ...(capped.more ? { more: capped.more } : {}) }, open: false, bad: false, stopped: false, running: false, label: `read ${one ? one.path : plural(files.length, "file")}${result.text ? `, ${result.text}` : ""}`, at: f.at, end: f.end, clamps: !one, partIDs: steps.map((s) => s.id) };
  }
  const objs = [...new Set(steps.map((s) => s.object))];
  const hits = steps.reduce((a, s) => a + (Number(/^(\d+)/.exec(s.result)?.[1]) || 0), 0);
  const content: Inline[] = objs.length <= 4
    ? objs.flatMap((o, i) => [...(i ? [{ t: "text", s: ", " } as const] : []), (f.tool === "webfetch" ? { t: "text", s: o.replace(/^https?:\/\/(www\.)?/, "") } : { t: "str", s: o }) as Inline])
    : [{ t: "text", s: plural(objs.length, kind === "fetch" ? "page" : "search", kind === "fetch" ? "pages" : "searches") }];
  const result = steps.length === 1 ? readout(steps[0] as Step) : hits ? quiet(plural(hits, "hit")) : quiet(plural(steps.length, "search", "searches"));
  const body: Body = steps.length === 1 ? hitsBody(steps[0] as Step) : { k: "read", files: steps.map((s) => ({ path: s.object, note: readout(s).text })) };
  return { key: `fold:${f.at}`, kind, face: "mono", content, result, body, open: false, bad: false, stopped: false, running: false, label: `${kind} ${objs.join(", ")}${result.text ? `, ${result.text}` : ""}`, at: f.at, end: f.end, clamps: true, partIDs: steps.map((s) => s.id) };
}

export function thinkModel(r: ThinkRow, ctx: RowCtx): RowModel {
  const many = r.thoughts.length > 1;
  const first = r.thoughts[0] as Think;
  const last = r.thoughts[r.thoughts.length - 1] as Think;
  const live = ctx.now !== undefined && last.streaming;
  const content: Inline[] = live
    ? [{ t: "lead", s: many ? `${plural(r.thoughts.length - 1, "thought")}, then thinking` : "thinking" }]
    : [...(many ? [{ t: "lead", s: `${plural(r.thoughts.length, "thought")}: ` } as const] : []), { t: "prose", s: firstSentence(first.text) }];
  const result: Result = live ? { text: clockDur(Math.max(0, (ctx.now ?? last.at) - last.at)), tone: "lit", clockFrom: last.at } : r.ms >= 1000 ? quiet(dur(r.ms)) : none;
  return {
    key: `think:${r.at}`, kind: "thought", face: "sans", content,
    ...(live ? {} : { opened: many ? `${plural(r.thoughts.length, "thought")} over ${dur(r.ms)}` : r.ms >= 1000 ? `for ${dur(r.ms)}` : "briefly" }),
    result, body: { k: "thoughts", thoughts: r.thoughts.map((t) => ({ at: t.at, ms: t.ms, text: t.text, streaming: t.streaming })) },
    open: ctx.thinking === "open", bad: false, stopped: false, running: live,
    label: `${plural(r.thoughts.length, "thought")}${r.ms >= 1000 ? `, ${dur(r.ms)}` : ""}`, at: r.at, end: r.end, clamps: !live,
    partIDs: r.thoughts.map((t) => t.id),
  };
}

/** what a result column says of a report's outcome, in the tone its glyph is drawn in */
const OUTCOME_TONE: Record<Report["outcome"], Result["tone"]> = { ready: "lit", blocked: "lit", failed: "bad", none: "quiet" };

/** a report, a note or a notice that came into the turn, as a row (docs/thread.md, arrivals). a report or a note: the agent's name
    and the gist its chip says, the outcome its glyph says, and a press raises the whole of it in its sheet. a status (the daemon's
    "reached status" alone): the agent's name and the status. a job's notice: its command's short form and how it ended, its id and
    its output inside. anything else: its first line, and its words whole inside */
export function arrivalModel(a: Arrival, _ctx?: RowCtx): RowModel {
  const common = { key: `arrive:${a.id}`, open: false, bad: false, stopped: false, running: false, at: a.at, end: a.at, clamps: true, partIDs: [a.id] };
  if (a.kind === "report" || a.kind === "note") {
    const r = reportOf({ ...(a.from ? { from: a.from } : {}), prompt: a.text, at: a.at, note: a.kind === "note" });
    const kind: Kind = r.kind === "status" ? "status" : r.kind === "note" ? "note" : "report";
    const result: Result = r.kind === "status" ? quiet(r.gist) : r.outcome !== "none" ? { text: r.outcome, tone: OUTCOME_TONE[r.outcome] } : none;
    const content: Inline[] = [...(r.kind === "note" ? [{ t: "lead", s: "from " } as const] : []), { t: "fn", s: r.name }, ...(r.kind !== "status" && r.gist ? [{ t: "brief", s: r.gist } as const] : [])];
    /* mono, as the agent rows that started them are: the name in the machine face, the gist under it in sans */
    return { ...common, kind, face: "mono", content, result, body: { k: "report", report: r }, label: r.spoken };
  }
  const job = a.kind === "job" ? jobOf(a.text) : undefined;
  if (job) {
    const short = job.command ? shortCommand(job.command) : `job ${job.id}`;
    const ended = job.signal !== undefined ? `killed by ${job.signal}` : `exit ${job.exit ?? 0}`;
    const ok = job.signal === undefined && (job.exit ?? 0) === 0;
    const facts: Fact[] = [{ text: `job ${job.id}`, strong: true }, ok ? { text: ended } : { text: ended, bad: true }, ...(job.who ? [{ text: job.who }] : []), { text: `at ${clockS(a.at)}` }];
    const output = job.output ? job.output.split("\n") : [];
    const content: Inline[] = [{ t: "cmd", tokens: commandTokens(short).tokens }, ...(job.output ? [] : [{ t: "lead", s: " no output" } as const])];
    return {
      ...common, kind: "job", face: "mono", content, result: ok ? quiet(ended) : { text: job.signal !== undefined ? "killed" : ended, tone: "bad" },
      body: { k: "shell", facts, ...(job.command ? { command: homeAsTilde(job.command).split("\n"), commandRaw: job.command } : {}), ...(output.length ? { output: { lines: output }, outputLines: output.length, outputRaw: job.output } : {}) },
      bad: !ok, label: `job ${short}, ${ended}${job.output ? "" : ", no output"}, ${clock(a.at)}`,
    };
  }
  const line = a.text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const kind: Kind = a.kind === "job" ? "job" : "notice";
  return { ...common, kind, face: "sans", content: [{ t: "prose", s: line.slice(0, 240) }], result: none, body: { k: "notice", facts: [{ text: `at ${clockS(a.at)}` }], text: a.text }, label: `${kind} ${line.slice(0, 80)}, ${clock(a.at)}` };
}

export function modelOf(r: Exclude<Row, SayRow>, ctx: RowCtx): RowModel {
  if (r.k === "arrive") return arrivalModel(r.arrival, ctx);
  if (r.k === "think") return thinkModel(r, ctx);
  if (r.k === "fold") return foldModel(r, ctx);
  return stepModel(r.step, ctx);
}

/** the files a turn changed, with their counts, hunks and diffs, largest first */
export function filesOf(t: Turn): FileLine[] {
  const files = new Map<string, { path: string; add: number; del: number; diffs: string[]; hunks: Array<{ start: number; add: number; del: number }>; total?: number; created: boolean }>();
  for (const x of t.items) {
    if (x.k !== "step" || x.family !== "edit" || x.status !== "completed") continue;
    const f = files.get(x.object) ?? { path: x.object, add: 0, del: 0, diffs: [], hunks: [], created: false };
    f.add += x.add; f.del += x.del;
    if (x.diff !== undefined) f.diffs.push(x.diff);
    f.hunks.push(...(x.hunks ?? []));
    if (x.total !== undefined) f.total = x.total;
    if (x.tool === "write" && /^new/.test(x.result)) f.created = true;
    files.set(x.object, f);
  }
  return [...files.values()].sort((a, b) => b.add + b.del - (a.add + a.del)).map((f) => ({
    path: f.path, note: `+${n(f.add)} -${n(f.del)}`, add: f.add, del: f.del, created: f.created,
    ...(f.total !== undefined && f.hunks.length ? { bar: { total: f.total, reads: [], hunks: f.hunks } } : {}),
    ...(f.diffs.length ? { diff: diffLines(f.diffs.join("\n\u0001\n")) } : {}),
  }));
}

/** the turn's last rows: its files, and how it ended when it did not end well */
export function endRows(t: Turn): RowModel[] {
  const out: RowModel[] = [];
  const files = filesOf(t);
  if (files.length) {
    const add = files.reduce((a, f) => a + (f.add ?? 0), 0), del = files.reduce((a, f) => a + (f.del ?? 0), 0);
    out.push({ key: `files:${t.id}`, kind: "files", face: "mono", content: [{ t: "text", s: `changed ${plural(files.length, "file")}` }], result: { text: `+${n(add)} -${n(del)}`, tone: "quiet", add, del }, body: { k: "files", files }, open: false, bad: false, stopped: false, running: false, label: `changed ${plural(files.length, "file")}, +${add} -${del}`, at: t.end, end: t.end, clamps: false, partIDs: [] });
  }
  if (t.status === "aborted") out.push({ key: `stopped:${t.id}`, kind: "stopped", face: "mono", content: [{ t: "lead", s: `you stopped it after ${dur(t.end - t.at)}` }], result: none, body: undefined, open: false, bad: false, stopped: true, running: false, label: "", at: t.end, end: t.end, clamps: false, partIDs: [] });
  if (t.status === "failed") out.push({ key: `failed:${t.id}`, kind: "failed", face: "mono", content: [{ t: "text", s: t.error ?? "the turn failed" }], result: none, body: undefined, open: false, bad: true, stopped: false, running: false, label: "", at: t.end, end: t.end, clamps: false, partIDs: [] });
  return out;
}
