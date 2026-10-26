/* the place typed into the sentence (docs/design.md, home: what next): `@repo`, `on <machine>` and `/model` are tokens
   the field reads at the caret while they are typed, and a pick turns one into the field's own chip and takes its letters
   out of the words. pure, so tokens.test.ts is the whole story; the field (field.tsx) only draws what these say.

   a token is read only where it is being typed (it ends at the caret) and only once it is a token for certain: `@` at a
   word's start, `/` at a word's start with no second slash (a path in the prose is not a model), and `on ` followed by
   the start of a machine's name, offered only when there is more than one machine. a token that is never picked stays
   words: nothing resolves on a guess. */

import { modelName } from "../model-name";

export type TokenKind = "repo" | "machine" | "model";

/** the token at the caret: what kind, what is typed after its trigger, and where it sits in the words */
export type Typed = { kind: TokenKind; query: string; start: number; end: number };

const REPO = /(^|\s)@([^\s@]*)$/;
const MODEL = /(^|\s)\/([\w.:-]*)$/;
const MACHINE = /(^|\s)on\s+(\S+)$/i;

/** the token being typed at `caret` in `text`, or none. `machines` are the names `on` may complete */
export function typedToken(text: string, caret: number, machines: readonly string[]): Typed | null {
  // a token ends where the caret is: letters straight after it are a word being edited in the middle, not a token
  if (caret < text.length && !/\s/.test(text.charAt(caret))) return null;
  const before = text.slice(0, caret);
  const repo = REPO.exec(before);
  if (repo) return { kind: "repo", query: repo[2] ?? "", start: repo.index + (repo[1] ?? "").length, end: caret };
  const model = MODEL.exec(before);
  if (model) return { kind: "model", query: model[2] ?? "", start: model.index + (model[1] ?? "").length, end: caret };
  const machine = MACHINE.exec(before);
  if (machine && machines.length > 1) {
    const query = machine[2] ?? "";
    if (matchMachines(machines, query).length > 0) return { kind: "machine", query, start: machine.index + (machine[1] ?? "").length, end: caret };
  }
  return null;
}

/** the words with a picked token taken out, and where the caret goes: the gap it leaves closes to one space */
export function withoutToken(text: string, typed: Pick<Typed, "start" | "end">): { text: string; caret: number } {
  const head = text.slice(0, typed.start).replace(/[ \t]+$/, "");
  const tail = text.slice(typed.end).replace(/^[ \t]+/, "");
  const joint = head && tail && !/\n$/.test(head) && !/^\n/.test(tail) ? " " : "";
  return { text: `${head}${joint}${tail}`, caret: head.length + joint.length };
}

/** the machines a typed start names: the ones it begins first, then the ones it is in, each once */
export function matchMachines(machines: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return [...machines];
  const starts = machines.filter((name) => name.toLowerCase().startsWith(q));
  const inside = machines.filter((name) => !starts.includes(name) && name.toLowerCase().includes(q));
  return [...starts, ...inside];
}

/** the models a typed word names: by the name a person says ("opus 5.5"), names that start with it first, then by the
    provider the id begins with ("openai"). never by any letters of the id, where "op" is inside "anthropic" */
export function matchModels<M extends { id: string }>(models: readonly M[], query: string): M[] {
  const q = query.toLowerCase().replace(/[-_]/g, " ").trim();
  if (!q) return [...models];
  const said = (m: M) => modelName(m.id);
  const provider = (m: M) => (m.id.includes("/") ? (m.id.split("/")[0] ?? "").toLowerCase() : "");
  const starts = models.filter((m) => said(m).startsWith(q));
  const inside = models.filter((m) => !starts.includes(m) && said(m).includes(q));
  const from = models.filter((m) => !starts.includes(m) && !inside.includes(m) && provider(m).startsWith(q));
  return [...starts, ...inside, ...from];
}
