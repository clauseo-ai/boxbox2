/* what a window's body shows of its tail (the native app's decision 25, on home): while the thread works, the run it is in,
   what you asked, then the turn's latest lines and its strip, a slot a step in order since the tail carries no clock; once it
   is done, only the agent's words. an asking window keeps its tail as it was, its tray says the rest. a done turn with no
   words anywhere (a stop, a failure on a tool) shows its run, settled, so a done window never draws an empty body over what
   its tail holds. pure, so run.test.ts is the whole story. */

import type { TailItem } from "../../sync/protocol";
import type { Strip, StripKind, StripMark, StripThought } from "../thread/groups";
import { type TailLine, tailLines } from "./tail";
import type { WindowState } from "./view";

export type Run = { lines: TailLine[]; strip: Strip | null };

/** the steps a strip has room for: the server's tail cap, so a run's marks fill it from the left as it goes */
export const RUN_SLOTS = 12;
/** the most of a turn's lines a working window keeps: its box shows what fits from the foot and fades the rest */
export const RUN_LINES = 8;
/** the words a done window keeps, from their end */
export const WORDS_CHARS = 640;

const asked = (item: TailItem): boolean => item.kind === "text" && item.role === "user" && !item.from;
const said = (item: TailItem): boolean => item.kind === "text" && item.role === "assistant";
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

export function runOf(items: readonly TailItem[], state: WindowState): Run {
  switch (state) {
    case "working":
    case "queued":
      return working(items, true);
    case "wants":
      return { lines: tailLines(items), strip: null };
    default: {
      const words = wordsOf(items);
      if (words.length) return { lines: words.map((text, i) => ({ kind: "prose", id: `words-${i}`, text })), strip: null };
      const settled = working(items, false);
      return settled.lines.length || settled.strip ? settled : { lines: [], strip: null };
    }
  }
}

function working(items: readonly TailItem[], live: boolean): Run {
  let from = -1;
  for (let i = items.length - 1; i >= 0; i--) if (asked(items[i] as TailItem)) { from = i; break; }
  const prompt = from >= 0 ? tailLines([items[from] as TailItem]) : [];
  const turn = items.slice(from + 1);
  const steps = turn.filter((item) => item.kind === "reasoning" || (item.kind === "tool" && tailLines([item]).length > 0));
  const lines = tailLines(turn.filter((item) => item.kind !== "reasoning")).slice(-RUN_LINES);
  return { lines: [...prompt, ...lines], strip: steps.length ? stripOf(steps, live) : null };
}

/** a step's mark on the strip, by the names the tail's lines know */
export function stripKindOf(tool: string): StripKind {
  switch (tool.toLowerCase()) {
    case "read": case "ls": case "list": return "read";
    case "glob": case "grep": return "search";
    case "edit": case "write": case "patch": case "multiedit": return "edit";
    case "shell": case "bash": return "run";
    case "webfetch": case "websearch": case "fetch": return "web";
    case "spawn": case "spawn_agent": case "spawn_pool": return "spawn";
    case "question": return "ask";
    default: return "other";
  }
}

/** the run's strip: each step one slot in order, a thought spanning most of its slot, a tool a mark by its kind. settled, nothing
    runs and no thought streams */
export function stripOf(run: readonly TailItem[], live: boolean): Strip {
  const shown = run.slice(-RUN_SLOTS);
  const thoughts: StripThought[] = [];
  const marks: StripMark[] = [];
  shown.forEach((item, i) => {
    const slot = i * 1000;
    if (item.kind === "reasoning") {
      thoughts.push({ at: slot + 150, ms: 700, streaming: live && i === shown.length - 1 });
      return;
    }
    const state = item.state ?? "";
    marks.push({ kind: stripKindOf(item.tool ?? ""), at: slot + 500, ms: 0, running: live && state !== "completed" && state !== "error", bad: state === "error", row: "", part: item.partID });
  });
  return { start: 0, end: Math.max(RUN_SLOTS, shown.length) * 1000, live, ordered: true, gaps: [], thoughts, marks };
}

/** the agent's words since your last message (else its last words anywhere in the tail), whitespace flattened, kept to
    `WORDS_CHARS` from their end */
export function wordsOf(items: readonly TailItem[]): string[] {
  let from = -1;
  for (let i = items.length - 1; i >= 0; i--) if (asked(items[i] as TailItem)) { from = i; break; }
  let texts = items.slice(from + 1).filter(said).map((item) => flat(item.text)).filter(Boolean);
  if (!texts.length) {
    const last = [...items].reverse().find(said);
    const text = last ? flat(last.text) : "";
    texts = text ? [text] : [];
  }
  const out: string[] = [];
  let room = WORDS_CHARS;
  for (const text of [...texts].reverse()) {
    if (room <= 0) break;
    if (text.length <= room) {
      out.push(text);
      room -= text.length;
    } else {
      out.push(cutToEnd(text, room));
      break;
    }
  }
  return out.reverse();
}

/** the end of `text` in at most `count` characters, cut at a word and opened with an ellipsis */
export function cutToEnd(text: string, count: number): string {
  if (text.length <= count) return text;
  const tail = text.slice(text.length - Math.max(0, count - 1));
  const space = tail.indexOf(" ");
  return `…${space >= 0 ? tail.slice(space + 1) : tail}`;
}
