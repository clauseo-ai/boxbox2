/* the tail's grammar (docs/design.md, anatomy of a window): what a window
   shows of the agent's work, so it reads at a glance and never floods.

   the server keeps each session's last twelve parts (architecture.md, the
   fleet model); this turns them into display lines:

   - consecutive reads fold into one line ("read 12 files").
   - an edit is "edit <file>"; a command is its short form, with "failed"
     when it did.
   - prose shows its last two sentences; older lines fade under the mask.
   - your prompt is its own line, on the right; the server keeps its start
     and leaves out the context the daemon added to it.
   - the agent's questions are the ask's to show, not the tail's; its
     thinking and step markers are not work a window shows.

   pure, so tail.test.ts is the whole story. */

import type { TailItem } from "../../sync/protocol";
import { scriptTitle } from "../thread/script";

export type ToolStatus = "running" | "done" | "failed";

export type TailLine =
  /** `verb` in mono, `object` bright, `result` on the right */
  | { kind: "tool"; id: string; verb: string; object: string; result: string; status: ToolStatus }
  /** reads in a row, folded: the file while there is one, the count once there are more */
  | { kind: "reads"; id: string; count: number; object: string; status: ToolStatus }
  | { kind: "prose"; id: string; text: string }
  /** what you asked, whitespace flattened; the window clamps it */
  | { kind: "prompt"; id: string; text: string }
  /** another agent's report or note, named by who sent it; its first words after */
  | { kind: "report"; id: string; from: string; text: string }
  | { kind: "file"; id: string; name: string };

/** lines a window keeps; the mask hides what the window's height cannot show */
export const TAIL_LINES = 9;
/** a command's short form, in characters */
const COMMAND_CHARS = 48;

const READS = new Set(["read", "glob", "grep", "ls", "list"]);
const EDITS = new Set(["edit", "write", "patch", "multiedit"]);
const COMMANDS = new Set(["shell", "bash"]);
/** cmx2's `run`, whose input is a javascript script */
const SCRIPTS = new Set(["run"]);
/** starting an agent: "agent" and its name when the title carries one (the pinned daemon titles it "spawn", ask a24) */
const SPAWNS = new Set(["spawn", "spawn_agent", "spawn_pool"]);
/** a wait: the daemon titles every one "wait for agents", whatever it waits on, and the tail has no more than the
    title, so the line is the verb alone (the thread's row and status line say what it waits on) */
const WAITS = new Set(["wait", "wait_agent", "wait_for_reply"]);
/** tools whose work is shown elsewhere: the ask rises out of the window, todos are the agent's own notes */
const HIDDEN = new Set(["question", "todowrite", "todoread"]);

export function tailLines(items: readonly TailItem[]): TailLine[] {
  const lines: TailLine[] = [];
  for (const item of items) {
    const line = lineOf(item);
    if (line === null) continue;
    const last = lines[lines.length - 1];
    if (line.kind === "reads" && last?.kind === "reads") {
      lines[lines.length - 1] = { kind: "reads", id: line.id, count: last.count + 1, object: "", status: foldStatus(last.status, line.status) };
      continue;
    }
    lines.push(line);
  }
  return lines.slice(-TAIL_LINES);
}

function lineOf(item: TailItem): TailLine | null {
  const id = item.partID;
  switch (item.kind) {
    case "text": {
      if (item.role === "user") {
        const text = item.text.replace(/\s+/g, " ").trim();
        if (item.from) return { kind: "report", id, from: item.from, text };
        return text ? { kind: "prompt", id, text } : null;
      }
      const text = lastSentences(item.text, 2);
      return text ? { kind: "prose", id, text } : null;
    }
    // contract 1 sent images and audio as files: they read as a file did
    case "file":
    case "image":
    case "audio":
      return item.text ? { kind: "file", id, name: baseName(item.text) } : null;
    case "reasoning":
      return null;
    case "tool":
      return toolLine(id, item.tool ?? "", item.state ?? "", item.text);
    default:
      item.kind satisfies never;
      return null;
  }
}

function toolLine(id: string, tool: string, state: string, title: string): TailLine | null {
  const name = tool.toLowerCase();
  if (HIDDEN.has(name)) return null;
  const status: ToolStatus = state === "error" ? "failed" : state === "completed" ? "done" : "running";
  const result = status === "failed" ? "failed" : "";
  if (READS.has(name)) return { kind: "reads", id, count: 1, object: baseName(title), status };
  if (EDITS.has(name)) return { kind: "tool", id, verb: "edit", object: baseName(title), result, status };
  if (COMMANDS.has(name)) return { kind: "tool", id, verb: "run", object: shortCommand(title), result, status };
  if (SPAWNS.has(name)) return { kind: "tool", id, verb: "agent", object: SPAWNS.has(title.toLowerCase()) ? "" : title, result, status };
  if (WAITS.has(name)) return { kind: "tool", id, verb: "wait", object: "", result, status };
  /* cmx2's script: named by what it does, never its first line of code (thread/script.ts) */
  if (SCRIPTS.has(name)) return { kind: "tool", id, verb: "run", object: scriptTitle(title), result, status };
  return { kind: "tool", id, verb: name || "tool", object: title, result, status };
}

/** a folded line is running while its newest read runs, and failed if any read failed */
function foldStatus(held: ToolStatus, next: ToolStatus): ToolStatus {
  if (next === "running") return "running";
  return held === "failed" || next === "failed" ? "failed" : "done";
}

/** the last `count` sentences of prose: what the agent is saying now */
export function lastSentences(text: string, count: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // a sentence ends at . ! or ? followed by a space; the text's own end closes the last one, finished or not
  const ends: number[] = [];
  for (const match of flat.matchAll(/[.!?]["')\]]?(?= )/g)) ends.push((match.index ?? 0) + match[0].length);
  const starts = [0, ...ends.map((end) => end + 1)].filter((start) => start < flat.length);
  const from = starts[Math.max(0, starts.length - count)] ?? 0;
  return flat.slice(from);
}

export function baseName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

function shortCommand(command: string): string {
  const first = command.trim().split("\n")[0] ?? "";
  return first.length > COMMAND_CHARS ? `${first.slice(0, COMMAND_CHARS - 1)}…` : first;
}

/** how prose shown as `held` became `next` while it streamed: words added at the end, after
    `dropped` characters left the front (the oldest sentence, once a third began). null when
    `next` is not that, a rewrite or a new part, which paints in place */
export function growth(held: string, next: string): { dropped: number; added: string } | null {
  if (next.startsWith(held)) return next.length > held.length ? { dropped: 0, added: next.slice(held.length) } : null;
  // the front can only leave at a sentence's start, after a space
  for (let at = held.indexOf(" "); at >= 0; at = held.indexOf(" ", at + 1)) {
    const kept = held.slice(at + 1);
    if (kept && next.startsWith(kept) && next.length > kept.length) return { dropped: at + 1, added: next.slice(kept.length) };
  }
  return null;
}
