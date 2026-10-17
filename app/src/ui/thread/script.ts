/* how a script step is named (docs/thread.md, the step group): cmx2's `run` takes a javascript script, and its first line of code
   ("const cmds = {") says nothing of what it does. a script is named by its description when the call carries one, else by its
   own leading comment, else "a script". pure; the thread's rows and a home window's tail lines both name it here. */

/** the generic name, when a script says nothing of itself */
export const A_SCRIPT = "a script";

const MAX = 72;
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const capped = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/** the words of a script's leading comment (a `//` run or a block comment before any code), else undefined */
export function leadingComment(code: string): string | undefined {
  const lines = code.split("\n");
  let i = 0;
  while (i < lines.length && !(lines[i] ?? "").trim()) i++;
  const first = (lines[i] ?? "").trim();
  if (first.startsWith("//")) {
    const words: string[] = [];
    for (; i < lines.length; i++) {
      const l = (lines[i] ?? "").trim();
      if (!l.startsWith("//")) break;
      words.push(l.replace(/^\/\/+\s?/, ""));
    }
    return flat(words.join(" ")) || undefined;
  }
  if (first.startsWith("/*")) {
    const rest = lines.slice(i).join("\n");
    const end = rest.indexOf("*/");
    const body = (end >= 0 ? rest.slice(2, end) : rest.slice(2)).split("\n").map((l) => l.replace(/^\s*\*+\s?/, "")).join(" ");
    return flat(body) || undefined;
  }
  return undefined;
}

/** what a script does, in a few words: its description, else its leading comment, else "a script" */
export function scriptName(code: string | undefined, description?: string | undefined): string {
  const said = flat(description ?? "");
  if (said) return capped(said);
  const note = code ? leadingComment(code) : undefined;
  return note ? capped(note) : A_SCRIPT;
}

/** reads as code, not words: an assignment, a call, a brace, or a keyword that opens a statement */
const CODE = /[=;{}()[\]`]|=>|^\s*(?:const|let|var|await|return|for|while|if|import|export|function|async|try)\b/;

/** a script's name from a title the daemon gave it (a home window's tail carries only that): a comment's words, a title that is
    words, or "a script" for a line of code */
export function scriptTitle(title: string): string {
  const t = title.trim();
  if (!t) return A_SCRIPT;
  const note = leadingComment(t);
  if (note) return capped(note);
  const line = (t.split("\n")[0] ?? "").trim();
  return t.includes("\n") || CODE.test(line) ? A_SCRIPT : capped(flat(line));
}
