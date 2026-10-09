/* how a shell line is read for the ledger (docs/thread.md, display rules):
   split into words and into a chain, each command's short form, and the
   tokens a row paints. pure; no dom. */

/** a shell line split into words, quotes and $( ) kept whole */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0, quote = "";
  for (const ch of line) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** a chain split at `&&`, `||` and `;` outside quotes and parentheses */
export function chainOf(line: string): string[] {
  const segs: string[] = [];
  let cur = "", depth = 0, quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ((ch === "&" && line[i + 1] === "&") || (ch === "|" && line[i + 1] === "|"))) {
      segs.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (depth === 0 && ch === ";") {
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

const SUBCOMMANDS = new Set(["bun", "bunx", "npm", "npx", "pnpm", "yarn", "git", "cargo", "just", "gh", "gcloud", "docker", "kubectl", "uv", "go", "xcrun", "swift", "brew", "pip"]);
/** words that are not commands a person came to see */
const QUIET = new Set(["echo", "printf", "cd", "export", "true", "sleep", "set", "source", "for", "while", "if", "done", "fi", "esac", "case", "exit"]);
const FILTERS = new Set(["head", "tail", "grep", "wc", "sort", "uniq", "cut", "awk", "sed", "tr", "xargs", "tee", "cat", "jq", "column", "less"]);

const CD = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/;
export const base = (p: string): string => { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; };
export const dirOf = (p: string): string => { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(0, i) : ""; };

/** an env assignment, `time`, `sudo` and the like, or a `do`/`then` that opens a body: not the program */
export const isPrefix = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^(time|sudo|nohup|exec|env|command|do|then|else)$/.test(w);

/** one segment's short form: its program and subcommand, nothing else; "" for a segment nobody came to see */
export function shortSeg(seg: string): string {
  const ws = shellWords(seg.replace(/^[\s({]+/, ""));
  while (ws.length && isPrefix(ws[0] ?? "")) ws.shift();
  const prog = base(ws[0] ?? "");
  if (!prog || QUIET.has(prog)) return "";
  const sub = SUBCOMMANDS.has(prog) ? ws.slice(1).find((w) => !w.startsWith("-") && !w.startsWith("$(")) : undefined;
  return sub ? `${prog} ${base(sub)}` : prog;
}

/** the first line with a leading `cd dir &&` dropped, and the dir it named */
export function firstLine(cmd: string): { line: string; cwd?: string; more: number } {
  const lines = cmd.split("\n");
  const head = lines[0] ?? "";
  const cd = CD.exec(head);
  return { line: cd ? head.slice(cd[0].length) : head, ...(cd ? { cwd: (cd[1] ?? "").replace(/^["']|["']$/g, "") } : {}), more: lines.length - 1 };
}

/** the short form of a whole command: "git status" for one, "git status, bun test" for a chain */
export function shortCommand(cmd: string): string {
  const { line } = firstLine(cmd);
  const segs = chainOf(line);
  const shorts = [...new Set(segs.map(shortSeg).filter(Boolean))];
  if (shorts.length) return shorts.join(", ");
  return base(shellWords(line)[0] ?? "") || "shell";
}
export const isChain = (cmd: string): boolean => cmd.includes("\n") || chainOf(firstLine(cmd).line).length > 1;

export type Token = { kind: "prog" | "arg" | "flag" | "str" | "lead" | "pipe" | "space"; text: string };

/** the tokens a run row paints: a chain as "N commands: " and each short form; one command word by word,
    the program lit, flags and prefixes and everything after the first pipe toned down */
export function commandTokens(cmd: string): { tokens: Token[]; chain: boolean; more: number } {
  const { line, more } = firstLine(cmd);
  const segs = chainOf(line);
  const all = segs.length > 1 ? segs.map(shortSeg).filter(Boolean) : [];
  if (all.length) {
    const shorts = [...new Set(all)];
    const shown = shorts.length > 5 ? shorts.slice(0, 4) : shorts;
    const tokens: Token[] = [];
    if (all.length > 1) tokens.push({ kind: "lead", text: `${all.length} commands: ` });
    shown.forEach((s, i) => { if (i) tokens.push({ kind: "arg", text: ", " }); tokens.push({ kind: "prog", text: s }); });
    if (shorts.length > 5) tokens.push({ kind: "lead", text: ` and ${shorts.length - 4} more` });
    return { tokens, chain: true, more };
  }
  const words = line.match(/'[^']*'|"[^"]*"|\S+|\s+/g) ?? [];
  let seenProg = false, piped = false;
  const tokens: Token[] = words.map((w): Token => {
    if (/^\s+$/.test(w)) return { kind: "space", text: w };
    if (piped) return { kind: "flag", text: w };
    if (w === "|") { piped = true; return { kind: "pipe", text: w }; }
    if (/^['"]/.test(w)) return { kind: "str", text: w };
    if (/^-/.test(w) || /^\d*>/.test(w) || /^[<>&]/.test(w)) return { kind: "flag", text: w };
    if (!seenProg && isPrefix(w)) return { kind: "flag", text: w };
    if (!seenProg) { seenProg = true; return { kind: "prog", text: w }; }
    return { kind: "arg", text: w };
  });
  return { tokens, chain: false, more };
}

/** the program that decides what a command's clean exit means: the first that is not a filter */
export function leadProgram(cmd: string): string {
  const { line } = firstLine(cmd);
  for (const seg of chainOf(line)) {
    const s = shortSeg(seg);
    if (s && !FILTERS.has(s.split(" ")[0] ?? "")) return s;
  }
  return "";
}
