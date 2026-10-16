/* what a file's bed and the reader say of the lines they hold (docs/thread.md, code and copying): every line a read returned when
   the row has them, else the preview the thread keeps, and the words for each ("lines 1 to 40 of 300", "the read stopped at line
   40 of 300", "the thread keeps only the first 10 of the 40 lines read"). pure, so it is tested without a browser; code.tsx
   draws it. */

import { readLines } from "./evidence";
import { n, plural } from "./rows";

/** the lines of a file a read returned: where they start, how long the file is when the read said, the read's whole output when
    the row has it, and how many lines the read returned when it said */
export type FileText = { path: string; lines: readonly string[]; from: number; total?: number | undefined; raw?: string | undefined; read?: number | undefined };

/** a file as a bed shows it: `kept` says these are only the preview the thread keeps, fewer lines than the read returned */
export type ShownFile = FileText & { kept?: true };

/** the file whole: every line the read returned, from its output, when it is numbered lines; else the preview, marked kept when the
    read said it returned more. nothing is made up: a read whose output this cannot read shows what the thread holds and says so */
export function wholeFile(f: FileText): ShownFile {
  const whole = f.raw !== undefined ? readLines(f.raw) : null;
  if (whole) return { path: f.path, lines: whole.lines, from: whole.from, total: f.total, read: f.read };
  return f.read !== undefined && f.read > f.lines.length ? { ...f, kept: true } : f;
}

/** "lines 1 to 40 of 300", "lines 1 to 40", "12 lines", "the end of the file, 300 lines" */
export function fileFacts(f: FileText): string {
  const to = f.from + f.lines.length - 1;
  if (f.total !== undefined && f.from === 1 && to >= f.total) return `the end of the file, ${plural(f.total, "line")}`;
  if (f.total !== undefined) return `lines ${f.from} to ${to} of ${f.total}`;
  return f.from === 1 ? plural(f.lines.length, "line") : `lines ${f.from} to ${to}`;
}

/** what the reader says under the last line: that the thread keeps only part of the read, that the read stopped short of the file's
    end, or that this is the end of what was read */
export function readerEnd(f: ShownFile): string {
  if (f.kept && f.read !== undefined) return `the thread keeps only the first ${plural(f.lines.length, "line")} of the ${n(f.read)} read`;
  const to = f.from + f.lines.length - 1;
  if (f.total !== undefined && to < f.total) return `the read stopped at line ${to} of ${f.total}`;
  return "the end of what was read";
}

/** "show all 300 lines", "show the whole diff, 300 lines": the control at the foot of a bed showing its opening lines */
export const showAllWords = (count: number, diff: boolean): string => (diff ? `show the whole diff, ${plural(count, "line")}` : `show all ${plural(count, "line")}`);
