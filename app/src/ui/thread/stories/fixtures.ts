/* the fixtures as the stories read them: fetched as recorded (never imported
   as a module, so the type checker never swallows megabytes of json), made
   neutral as the server's translate makes cmx2's shapes (sync/fixtures/
   neutral.ts), run through the model, and handed out as turns with their
   context. */

import { type Item, type Step, type Turn, joinAsks, projectRoot, turnsOf } from "../model";
import type { Child, RowCtx } from "../rows";
import type { WireMessage } from "../wire";
import { neutralMessage } from "../../../sync/fixtures/neutral";
import cmxUrl from "../fixtures/cmx-deploy.json?url";
import notesUrl from "../fixtures/notes-asks.json?url";
import northstarUrl from "../fixtures/northstar-heavy.json?url";
import { REPO_COLOURS } from "../../window/repo";

export type Tone = { name: string; top: string; bottom: string; tone: string };
/** a repo palette by its name (repo.ts), as the stage's tone: the stories wear the palettes the app ships */
const tone = (name: string): Tone => {
  const c = REPO_COLOURS.find((p) => p.name === name);
  if (!c) throw new Error(`no palette ${name}`);
  return { name, top: c.top, bottom: c.bottom, tone: c.light };
};
export const TONES: Record<"cobalt" | "violet" | "green", Tone> = { cobalt: tone("cobalt"), violet: tone("violet"), green: tone("green") };

type ImportedFile = { session: { id: string; directory: string; title: string }; messages: WireMessage[]; children: Array<{ session: { id: string }; messages: WireMessage[] }> };
type Snapshot = { label: string; at: number; messages: WireMessage[]; permissions: Array<{ id: string; permission: string; patterns: string[]; tool?: { messageID: string; callID: string } }>; questions: Array<{ id: string; questions: unknown[]; tool?: { messageID: string; callID: string } }>; status: Record<string, unknown> };
type NativeFile = { session: { id: string; directory: string; title: string }; messages: WireMessage[]; snapshots: Snapshot[] };

export type Loaded = { title: string; repo: string; tone: Tone; turns: Turn[]; ctx: RowCtx; snapshots?: Snapshot[] };

const cache = new Map<string, Promise<unknown>>();
const fetchJson = <T,>(url: string): Promise<T> => { let p = cache.get(url); if (!p) { p = fetch(url).then((r) => r.json()).then(neutralFile); cache.set(url, p); } return p as Promise<T>; };

type Recorded = { info: Record<string, unknown>; parts: Record<string, unknown>[] };
/** a recorded file with every message list in it neutral: its own, its children's and its snapshots' */
function neutralFile(file: { messages: Recorded[]; children?: Array<{ messages: Recorded[] }>; snapshots?: Array<{ messages: Recorded[] }> }): unknown {
  const each = (list: Recorded[]) => list.map(neutralMessage);
  return { ...file, messages: each(file.messages), ...(file.children ? { children: file.children.map((c) => ({ ...c, messages: each(c.messages) })) } : {}), ...(file.snapshots ? { snapshots: file.snapshots.map((s) => ({ ...s, messages: each(s.messages) })) } : {}) };
}

function childrenOf(file: ImportedFile, root: string): Map<string, Child> {
  const out = new Map<string, Child>();
  for (const c of file.children) {
    const turns = turnsOf(c.messages, root);
    const items: Item[] = turns.flatMap((t) => t.items);
    const steps = items.filter((x): x is Step => x.k === "step");
    const first = c.messages[0]?.info.created ?? 0;
    const end = c.messages.at(-1)?.info.completed ?? first;
    // a recorded child's turn is over: idle, its clock stopped where its last message completed
    out.set(c.session.id, { steps: steps.length, ms: Math.max(0, end - first), items, held: true, state: "idle", since: end, created: first, title: "" });
  }
  return out;
}

export async function loadImported(which: "northstar" | "cmx"): Promise<Loaded> {
  const file = await fetchJson<ImportedFile>(which === "northstar" ? northstarUrl : cmxUrl);
  const root = projectRoot(file.session.directory, file.messages);
  const turns = turnsOf(file.messages, root);
  const children = childrenOf(file, root);
  return { title: file.session.title, repo: which, tone: which === "northstar" ? TONES.cobalt : TONES.violet, turns, ctx: { turns, children, thinking: "rows" } };
}

/** the native session at one of its recorded moments, its pending asks joined onto their rows */
export async function loadNative(label?: string): Promise<Loaded & { snapshot: Snapshot }> {
  const file = await fetchJson<NativeFile>(notesUrl);
  const snapshot = (label ? file.snapshots.find((s) => s.label === label) : file.snapshots.at(-1)) ?? (file.snapshots.at(-1) as Snapshot);
  const turns = turnsOf(snapshot.messages, file.session.directory);
  joinAsks(turns, snapshot.permissions, snapshot.questions);
  return { title: file.session.title, repo: "notes", tone: TONES.green, turns, ctx: { turns, children: new Map(), thinking: "rows" }, snapshots: file.snapshots, snapshot };
}

/** every step of every turn, for picking examples */
export const stepsOf = (turns: readonly Turn[]): Step[] => turns.flatMap((t) => t.items.filter((x): x is Step => x.k === "step"));
