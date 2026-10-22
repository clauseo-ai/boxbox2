/* an agent's report or note as its row, its chip and its sheet say it
   (docs/thread.md, arrivals): the outcome read from the report's first word,
   the first line as its gist without an outcome word that only labels it, and
   the agent's letter for a report whose first word says no outcome. the
   daemon's own first line ("agent /root/x reached status: parked") is told
   apart from the agent's words: alone, the mail is a status, said as the
   status; above a report, it is left out of the gist. and a job's notice read
   into its command, how it ended and its output. read from the words that
   came, never computed state. pure; no dom. */

import { clock } from "./rows";

export type Outcome = "ready" | "blocked" | "failed" | "none";

const WORDS: Record<Exclude<Outcome, "none">, readonly string[]> = {
  ready: ["ready", "done", "merged", "landed", "shipped", "fixed", "complete", "completed", "finished", "passed", "green"],
  blocked: ["blocked", "waiting", "stuck", "paused", "needs", "question"],
  failed: ["failed", "failing", "broken", "error", "crashed", "aborted", "red"],
};

/** how a report went, from its first word: the agents' reports open with it by convention ("ready to merge", "blocked:", "failed:") */
export function outcomeOf(line: string): Outcome {
  const word = (/^\p{L}*/u.exec(line)?.[0] ?? "").toLowerCase();
  for (const [outcome, words] of Object.entries(WORDS) as Array<[Exclude<Outcome, "none">, readonly string[]]>) if (words.includes(word)) return outcome;
  return "none";
}

/** the report's first line with words in it, without its markdown marks (a heading's hashes, a bullet, a quote's bar, a list's number,
    emphasis and code ticks). reads its first lines only, never the whole report */
export function firstLine(text: string): string {
  let seen = 0;
  for (const raw of text.split("\n", 40)) {
    if (!raw.trim()) continue;
    if (++seen > 12) break;
    let line = raw.slice(0, 240).trimStart();
    if (line.startsWith("```") || /^[-*_=|: ]+$/.test(line)) continue;
    line = line.replace(/^[#>\-*+ ]+/, "").replace(/^\d+\.\s*/, "");
    const plain = line.replace(/[*`]/g, "").trim();
    if (plain) return plain;
  }
  return "";
}

/** the line without a leading outcome word that only labels it ("blocked: the zoom shots wait" reads "the zoom shots wait"); "ready
    to merge cd16978" stays whole */
export function unlabelled(line: string): string {
  const word = /^\p{L}*/u.exec(line)?.[0] ?? "";
  if (!word || outcomeOf(word) === "none") return line;
  const rest = line.slice(word.length).trimStart();
  if (!rest || !":-.,".includes(rest[0] as string)) return line;
  const after = rest.slice(1).replace(/^[\s-]+/, "");
  return after || line;
}

/** the daemon's line above a child's report (cmx2's actors: "agent /root/x reached status: parked", a failure's "(why)" after it), and
    its closing line ("[child session: …; to continue: message(…)]"): what the daemon says of the mail, not what the agent said */
const STATUS_LINE = /^agent (\/root\S*) reached status: ([\w-]+)(?: \((.*)\))?[.;]?[ \t]*(?:\n|$)/;
const DAEMON_TAIL = /\n*\[child session: [^\]]*\]\s*$/;

/** a mail's daemon status line, if it opens with one: the status, what the daemon added in brackets, and the words after it (the
    agent's own, without the daemon's closing line), empty for a mail that is the status alone */
export function statusOf(text: string): { status: string; detail?: string; body: string } | undefined {
  const m = STATUS_LINE.exec(text.trimStart());
  if (!m) return undefined;
  const body = text.trimStart().slice(m[0].length).replace(DAEMON_TAIL, "").trim();
  const detail = m[3]?.replace(/\/root\/(?=\S)/g, "").replace(/\/root\b/g, "root").trim();
  return { status: (m[2] ?? "").toLowerCase(), ...(detail ? { detail } : {}), body };
}

/** one report as its row, its chip and its sheet show it. `kind` is a status when the mail is the daemon's status line alone (a child
    parked, closed, stopped): it reads as that status, never as a report. `verb` is what the sheet says it did at its clock */
export type Report = { name: string; text: string; at: number; note: boolean; kind: "report" | "note" | "status"; status?: string; outcome: Outcome; gist: string; verb: string; initial: string; spoken: string };

export function reportOf(t: { from?: string | undefined; prompt: string; at: number; note?: boolean | undefined }): Report {
  const name = t.from || "an agent";
  const note = t.note === true;
  const last = name.split("/").filter(Boolean).at(-1) ?? name;
  const initial = (last[0] ?? "?").toUpperCase();
  const daemon = note ? undefined : statusOf(t.prompt);
  if (daemon && !daemon.body) {
    const gist = daemon.detail ? `${daemon.status}, ${daemon.detail}`.slice(0, 160) : daemon.status;
    const outcome: Outcome = daemon.status === "failed" ? "failed" : "none";
    return { name, text: t.prompt, at: t.at, note, kind: "status", status: daemon.status, outcome, gist, verb: daemon.status, initial, spoken: [`status of ${name}`, gist, clock(t.at)].join(", ") };
  }
  const first = firstLine(daemon ? daemon.body : t.prompt);
  const said = outcomeOf(first);
  /* a report whose words open with no outcome takes the daemon's word for a failure */
  const outcome: Outcome = said === "none" && daemon?.status === "failed" ? "failed" : said;
  const gist = unlabelled(first);
  const spoken = [`${note ? "note" : "report"} from ${name}`, ...(outcome !== "none" ? [outcome] : []), clock(t.at), ...(gist ? [gist] : [])].join(", ");
  return { name, text: t.prompt, at: t.at, note, kind: note ? "note" : "report", ...(daemon ? { status: daemon.status } : {}), outcome, gist, verb: note ? "wrote" : "reported", initial, spoken };
}

/* ---------- a job's notice ---------- */

/** a background job's notice as the runtime words it (cmx2's procs and server: "job <id>: exited with code 0; no output", or "; last
    output:" and its last lines, then "(started by you: <command>)"), read into its parts. none for words of another shape, which the
    row says as they came */
export type JobNotice = { id: string; command: string; exit?: number; signal?: string; output: string; who?: string };

export function jobOf(text: string): JobNotice | undefined {
  const head = /^job (\S+?):[ \t]*([^\n]*)/.exec(text);
  if (!head) return undefined;
  const how = head[2] ?? "";
  const code = /^exited with code (-?\d+)/.exec(how), killed = /^killed by ([\w-]+)/.exec(how);
  if (!code && !killed) return undefined;
  let rest = text.slice(head[0].length);
  const by = /\n\((started by [^:\n)]+): ([^\n]*)\)\s*$/.exec(rest);
  if (by) rest = rest.slice(0, by.index);
  const output = /last output:\s*$/.test(how) ? rest.replace(/^\n+/, "").trimEnd() : "";
  return { id: head[1] ?? "", command: by?.[2]?.trim() ?? "", ...(code ? { exit: Number(code[1]) } : {}), ...(killed ? { signal: killed[1] ?? "" } : {}), output, ...(by?.[1] ? { who: by[1] } : {}) };
}
