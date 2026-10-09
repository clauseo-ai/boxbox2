/* what a command came to, read from its output and never guessed from its
   name alone (docs/thread.md, the row). pure; no dom. */

export type Evidence =
  | { kind: "tests"; passed: number; failed: number; total?: number }
  | { kind: "build"; ok: boolean; errors: number; warnings: number }
  | { kind: "commit"; hash?: string; subject?: string; files?: number; add?: number; del?: number }
  | { kind: "push"; from: string; to: string }
  | { kind: "clean" }
  | { kind: "line"; text: string };

const num = (m: RegExpMatchArray | null, i = 1): number | undefined => (m?.[i] !== undefined ? Number(m[i]) : undefined);
const count = (out: string, re: RegExp): number => (out.match(re) ?? []).length;

/** tests: bun, swift testing, xctest, cargo, pytest, jest */
function tests(out: string): Evidence | undefined {
  const bunPass = out.match(/^\s*(\d+) pass\b/m), bunFail = out.match(/^\s*(\d+) fail\b/m), bunRan = out.match(/Ran (\d+) tests? across/);
  if (bunRan || (bunPass && bunFail)) return { kind: "tests", passed: num(bunPass) ?? 0, failed: num(bunFail) ?? 0, ...(bunRan ? { total: num(bunRan) ?? 0 } : {}) };
  const swift = out.match(/Test run with (\d+) tests? in \d+ suites? (passed|failed)/);
  if (swift) {
    const total = Number(swift[1]);
    const failed = swift[2] === "failed" ? Number(out.match(/with (\d+) (?:issue|failure)/)?.[1] ?? 1) : 0;
    return { kind: "tests", passed: total - failed, failed, total };
  }
  const xct = [...out.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].at(-1);
  if (xct) { const total = Number(xct[1]), failed = Number(xct[2]); return { kind: "tests", passed: total - failed, failed, total }; }
  const cargo = out.match(/test result: \w+\. (\d+) passed; (\d+) failed/);
  if (cargo) return { kind: "tests", passed: Number(cargo[1]), failed: Number(cargo[2]) };
  const py = out.match(/=+ (?:(\d+) failed, )?(\d+) passed/);
  if (py) return { kind: "tests", passed: Number(py[2]), failed: Number(py[1] ?? 0) };
  const jest = out.match(/Tests:\s+(?:(\d+) failed, )?(\d+) passed/);
  if (jest) return { kind: "tests", passed: Number(jest[2]), failed: Number(jest[1] ?? 0) };
  return undefined;
}

const BUILD_LEAD = /^(tsc|tsgo|xcodebuild|swiftc)\b|^(bun|npm|pnpm|yarn) (run )?(typecheck|check|build|tsc)\b|^(cargo|swift|go) (check|build|vet)\b/;

/** what a command produced: tests, a build, a commit, a push, a clean exit, or its last line */
export function evidenceOf(command: string, lead: string, output: string, exit: number | undefined): Evidence | undefined {
  const out = output.replace(/\r/g, "");
  const t = tests(out);
  if (t) return t;
  if (/\*\* (BUILD|TEST) SUCCEEDED \*\*/.test(out)) return { kind: "build", ok: true, errors: 0, warnings: count(out, /: warning: /g) };
  if (/\*\* (BUILD|TEST) FAILED \*\*/.test(out) || /error: build failed|Compiling failed/i.test(out)) return { kind: "build", ok: false, errors: count(out, /: error: /g), warnings: count(out, /: warning: /g) };
  const tsc = out.match(/Found (\d+) errors?/);
  if (tsc) return { kind: "build", ok: false, errors: Number(tsc[1]), warnings: 0 };
  /* a clean exit only means "no errors" when the command itself is the build: in a chain, the lead program decides */
  if (BUILD_LEAD.test(lead) && exit === 0) {
    const errors = count(out, /: error: |error\[E\d+\]/g);
    return { kind: "build", ok: errors === 0, errors, warnings: count(out, /: warning: |^warning: /gm) };
  }
  if (/\bgit (commit|am)\b/.test(command)) {
    const head = out.match(/^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$/m);
    const stat = out.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (head || stat) return { kind: "commit", ...(head ? { hash: head[2] ?? "", subject: head[3] ?? "" } : {}), ...(stat ? { files: Number(stat[1]), add: Number(stat[2] ?? 0), del: Number(stat[3] ?? 0) } : {}) };
  }
  if (/\bgit push\b/.test(command)) {
    const ref = out.match(/^\s*[+*]?\s*[0-9a-f.]+\s+(\S+) -> (\S+)$/m) ?? out.match(/\* \[new branch\]\s+(\S+) -> (\S+)/);
    if (ref) return { kind: "push", from: ref[1] ?? "", to: ref[2] ?? "" };
  }
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && !/^(\(no output\)|Process exited|Session ID|Original token count|Wall time)/.test(l));
  const last = lines.at(-1);
  if (last === undefined) return exit === 0 || exit === undefined ? { kind: "clean" } : undefined;
  return { kind: "line", text: last.slice(0, 160) };
}

export type Span = { start: number; end: number; total?: number };

/** a read's span of the file and the file's length, from its input and its output's own footer */
export function spanOf(input: { offset?: number; limit?: number }, meta: { startLine?: number; endLine?: number; totalLines?: number }, output: string): Span | undefined {
  const total = meta.totalLines ?? num(output.match(/\(End of file - total (\d+) lines\)/)) ?? num(output.match(/total (\d+) lines/));
  const numbered = [...output.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
  const start = meta.startLine ?? input.offset ?? numbered[0] ?? 1;
  const end = meta.endLine ?? (numbered.length ? numbered.at(-1) : input.limit !== undefined ? start + input.limit - 1 : total);
  if (end === undefined) return total !== undefined ? { start: 1, end: total, total } : undefined;
  return { start, end, ...(total !== undefined ? { total } : {}) };
}

export type Hunk = { start: number; add: number; del: number };

/** where an edit landed, from its hunk headers or the line the tool reported */
export function hunksOf(patch: string | undefined, line: number | undefined): Hunk[] {
  const out: Hunk[] = [];
  if (patch) {
    let cur: Hunk | undefined;
    for (const l of patch.split("\n")) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
      if (h) { cur = { start: Number(h[2]), add: 0, del: 0 }; out.push(cur); continue; }
      if (!cur) continue;
      if (l.startsWith("+") && !l.startsWith("+++")) cur.add++;
      else if (l.startsWith("-") && !l.startsWith("---")) cur.del++;
    }
  }
  if (!out.length && line !== undefined) out.push({ start: line, add: 0, del: 0 });
  return out;
}

/** a command's output as the daemon sent it, less the wall-time preamble some tools put before it and the whitespace that ends it */
export const cleanOutput = (out: string): string => out.replace(/^Wall time:[\s\S]*?Output:\n/, "").replace(/\s+$/, "");

/** the most of an output a copy puts on the clipboard, in characters. the output itself is the store's, already in memory as the daemon sent it; the step holds a second reference to it (`Step.output.raw`) and cleans it at the press, so no second 256 kb string lives on for every command a thread ran. past the cap a copy stops, and says so */
export const COPY_OUTPUT_CAP = 256_000;

/** the longest line a bed shows, in characters: a longer one is cut there and ends in an ellipsis */
export const LINE_MAX = 220;

/** the first 8 and last 16 lines of an output, each capped at LINE_MAX characters, the cut marked by what it left out. `clipped` says a line that is shown was cut at the cap, so what is on screen is not all of what the output holds, though its lines are all there */
export function headTail(s: string): { lines: string[]; cut: number; cutAt: number; clipped: boolean } {
  const all = s.split("\n");
  const whole = all.length <= 26;
  const shown = whole ? all : [...all.slice(0, 8), ...all.slice(-16)];
  const clipped = shown.some((l) => l.length > LINE_MAX);
  const lines = shown.map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l));
  return whole ? { lines, cut: 0, cutAt: -1, clipped } : { lines, cut: all.length - 24, cutAt: 8, clipped };
}
