/* what a thread's details say, as pure functions of its turns and its session's
   info (docs/design.md, the thread menu and details): the agents it started,
   the files it changed, the models it ran on, and the facts line under its
   title. the panel that draws them is ./details.tsx. */

import type { Thread } from "../../sync/protocol";
import { modelName } from "../model-name";
import type { Turn } from "./model";
import { agentTitle, type Child, plural } from "./rows";

/* ---------- the agents this thread started ---------- */

export type AgentRow = {
  id: string;
  child: Child;
  name: string;
  type?: string;
  at: number;
  /** its report has come back to this thread */
  reported: boolean;
  /** the name, told apart from another agent of the same name by the end of its id */
  label: string;
};

const RANK: Record<string, number> = { working: 0, wants: 1, parked: 2, idle: 3, gone: 4 };

/** the fleet's children, named by the rows that started them (docs/thread.md, agents), the ones at work first */
export function rosterOf(turns: readonly Turn[], children: ReadonlyMap<string, Child>): AgentRow[] {
  const started = new Map<string, { name: string; type?: string; at: number }>();
  for (const t of turns) {
    for (const it of t.items) {
      if (it.k !== "step" || it.family !== "spawn") continue;
      const agent = it.agent;
      if (!agent?.child) continue;
      started.set(agent.child, { name: agent.name, ...(agent.type ? { type: agent.type } : {}), at: it.at });
    }
  }
  /* an agent with no spawn row (started from a run script, cmx2 ask a27) is named by the daemon's title, "name (seat)";
     a report from one is found by its session, else by its name, from the time it was started */
  const rows = [...children].map(([id, child]) => {
    const s = started.get(id);
    const titled = agentTitle(child.title);
    const name = s?.name ?? (titled.name || id);
    const type = s?.type ?? titled.seat;
    const at = s?.at ?? child.created;
    const reported = turns.some((r) => r.by === "mail" && !r.note && (r.fromID ? r.fromID === id : r.from === name) && r.at >= at);
    return { id, child, name, ...(type ? { type } : {}), at, reported };
  });
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
  return rows
    .sort((a, b) => (RANK[a.child.state] ?? 9) - (RANK[b.child.state] ?? 9) || b.at - a.at)
    .map((r) => ({ ...r, label: (seen.get(r.name) ?? 0) > 1 ? `${r.name} ${r.id.slice(-4)}` : r.name }));
}

/** a row's word, and its name for assistive technology without the clock, so the name does not change every second */
export function agentState(a: AgentRow): string {
  const s = a.child.state;
  return s === "working" ? "working" : s === "wants" ? "wants you" : s === "parked" ? "parked" : s === "gone" ? "archived" : a.reported ? "reported" : a.child.held ? plural(a.child.steps, "step") : "no report";
}

/* ---------- a list's rows, kept ---------- */

/** `next` with each row that says what the row of the same key in `prev` said put back as that row, and `prev` itself when
    every row is: a keyed list (solid's For) drawn from rows worked out again on every frame then keeps the nodes of the rows
    that did not change and makes again only the ones that did. rows compare by their own fields, which must be plain values */
export function kept<T extends object>(next: readonly T[], prev: readonly T[] | undefined, keyOf: (row: T) => string): readonly T[] {
  if (!prev) return next;
  const before = new Map(prev.map((row) => [keyOf(row), row]));
  let all = next.length === prev.length;
  const out = next.map((row, i) => {
    const old = before.get(keyOf(row));
    const same = old !== undefined && Object.keys(row).length === Object.keys(old).length && Object.entries(row).every(([k, v]) => (old as Record<string, unknown>)[k] === v);
    if (!same || old !== prev[i]) all = false;
    return same ? old : row;
  });
  return all ? prev : out;
}

/* ---------- the files it changed ---------- */

export type FileChange = { path: string; dir: string; base: string; add: number; del: number };

/** every file the turns edited with its counts summed, the one edited last first; the paths are already short
    against the project root (the rows shorten them as they are read) */
export function filesChanged(turns: readonly Turn[]): { files: FileChange[]; add: number; del: number } {
  const sums = new Map<string, { add: number; del: number }>();
  /* the newest turn first, and inside a turn the last-inserted first (its map keeps the order of the first edit): a
     path takes its place in the list the first time it is met, and the older turns add their counts to it */
  for (const t of [...turns].reverse()) {
    for (const [path, f] of [...t.files].reverse()) {
      const sum = sums.get(path);
      if (sum) { sum.add += f.add; sum.del += f.del; } else sums.set(path, { add: f.add, del: f.del });
    }
  }
  let add = 0, del = 0;
  const files = [...sums].map(([path, sum]) => {
    add += sum.add; del += sum.del;
    const cut = path.lastIndexOf("/") + 1;
    return { path, dir: path.slice(0, cut), base: path.slice(cut), add: sum.add, del: sum.del };
  });
  return { files, add, del };
}

/* ---------- the models it ran on, and what it cost ---------- */

/** the turns that ran: a runtime notice is the daemon talking, not the agent working, so it has no steps, no model and
    no spend, and no count or sum below includes it */
export const ranOf = (turns: readonly Turn[]): Turn[] => turns.filter((t) => t.by !== "notice");

/** what the thread has cost: its turns' own spend summed, so every figure on the panel adds up to this one. the
    session's own total stands in only while no turn carries a cost (a thread read before its messages are here) */
export function spentOf(turns: readonly Turn[], info: Thread | undefined): number {
  const sum = ranOf(turns).reduce((n, t) => n + t.cost, 0);
  return sum > 0 ? sum : (info?.cost ?? 0);
}

/* ---------- what its agents cost ---------- */

/** a session under this thread at any depth (its agents, and theirs): who started it and what it cost. the cost is the
    daemon's account of that session (`info.cost`, which counts its own messages and never its children's), else the
    sum of its messages while its thread is held, else not known: an agent the fleet has let go (archived, or past its
    cap) with no thread held says nothing about its spend */
export type Kin = { id: string; parent: string; title: string; at: number; cost: number | null; gone: boolean };

export type SpendRow = { id: string; name: string; type?: string; depth: number; cost: number | null; gone: boolean };

/** the thread's whole spend: its own turns, and every agent under it */
export type Spend = { own: number; agents: number; total: number; rows: SpendRow[]; unknown: number };

/** the thread's spend with its agents': one row per agent at any depth, each under the agent that started it, the
    dearest first among siblings. the direct agents take the roster's names (the rows that started them); deeper ones the
    daemon's title, "name (seat)". `total` is what the thread and every agent whose spend is known have cost; `unknown`
    counts the agents whose spend is not known, so the total is never read as whole when it is not */
export function spendOf(turns: readonly Turn[], info: Thread | undefined, kin: readonly Kin[], roster: readonly AgentRow[]): Spend {
  const own = spentOf(turns, info);
  const named = new Map(roster.map((a) => [a.id, a]));
  const under = new Map<string, Kin[]>();
  const ids = new Set(kin.map((k) => k.id));
  const root: Kin[] = [];
  for (const k of kin) {
    // an agent whose parent is not among the kin is this thread's own
    if (!ids.has(k.parent)) { root.push(k); continue; }
    const list = under.get(k.parent) ?? [];
    list.push(k);
    under.set(k.parent, list);
  }
  const order = (a: Kin, b: Kin): number => (b.cost ?? -1) - (a.cost ?? -1) || a.at - b.at;
  const rows: SpendRow[] = [];
  const seen = new Set<string>();
  const walk = (list: readonly Kin[], depth: number): void => {
    for (const k of [...list].sort(order)) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      const started = depth === 0 ? named.get(k.id) : undefined;
      const titled = agentTitle(k.title);
      const type = started?.type ?? titled.seat;
      rows.push({ id: k.id, name: started?.label ?? (titled.name || k.id), ...(type ? { type } : {}), depth, cost: k.cost, gone: k.gone });
      walk(under.get(k.id) ?? [], depth + 1);
    }
  };
  walk(root, 0);
  let agents = 0, unknown = 0;
  for (const r of rows) { if (r.cost === null) unknown++; else agents += r.cost; }
  return { own, agents, total: own + agents, rows, unknown };
}

/** the model, and the effort it ran at when there was one: "opus 5.5, high" */
const modelWords = (model: string, effort?: string): string => (effort ? `${modelName(model)}, ${effort}` : modelName(model));

export type ModelUse = { model: string; effort?: string; name: string; turns: number; cost: number; at: number };

/** one row per model and effort the turns ran on, the one used last first */
export function modelsOf(turns: readonly Turn[]): ModelUse[] {
  const uses = new Map<string, ModelUse>();
  for (const t of ranOf(turns)) {
    if (!t.model) continue;
    const key = `${t.model}\u0000${t.effort ?? ""}`;
    const use = uses.get(key) ?? { model: t.model, ...(t.effort ? { effort: t.effort } : {}), name: modelName(t.model), turns: 0, cost: 0, at: 0 };
    use.turns++; use.cost += t.cost; use.at = Math.max(use.at, t.at);
    uses.set(key, use);
  }
  return [...uses.values()].sort((a, b) => b.at - a.at);
}

/** the model and effort the newest turn that ran one used */
function currentModel(turns: readonly Turn[]): { model: string; effort?: string } | undefined {
  const t = ranOf(turns).reverse().find((x) => x.model);
  return t?.model ? { model: t.model, ...(t.effort ? { effort: t.effort } : {}) } : undefined;
}

/** the turns whose model or effort differs from the turn before that ran one, by turn id: where a switch happened */
export function switches(turns: readonly Turn[]): Map<string, string> {
  const out = new Map<string, string>();
  let before: string | undefined;
  for (const t of ranOf(turns)) {
    if (!t.model) continue;
    const key = `${t.model}\u0000${t.effort ?? ""}`;
    if (before !== undefined && key !== before) out.set(t.id, modelWords(t.model, t.effort));
    before = key;
  }
  return out;
}

/* ---------- the figures ---------- */

/** a count in few characters: 940, 1.3k, 12k, 1.3m */
export function figure(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units = ["k", "m", "b"];
  let value = n, unit = -1;
  while (value >= 999.5 && unit < units.length - 1) { value /= 1000; unit++; }
  const text = value < 9.95 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  return `${text}${units[unit]}`;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const spend = (cost: number): string => dollars.format(cost);

type Tokens = Thread["tokens"];

/** every token the thread has moved, cached or not; none when the thread says nothing of its tokens */
export const tokensIn = (t: Tokens): number => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);

/** the share of what went in that came from the cache, as a whole percent; none before anything went in */
export function cachedShare(t: Tokens): number | null {
  const total = t ? t.input + t.cacheRead : 0;
  return t && total > 0 ? Math.round((t.cacheRead / total) * 100) : null;
}

/** a share in words: a whole percent, and "under 1%" for what there is a little of, so a trace is never written as a zero */
export function percentWords(part: number, whole: number): string {
  const share = whole > 0 ? (part / whole) * 100 : 0;
  return share > 0 && share < 0.5 ? "under 1%" : `${Math.round(share)}%`;
}

export type ContextFill = { percent: number; compactsAt?: number };

/** how full the model's window is, and where the daemon compacts it, both as whole percents of the window */
export function contextOf(info: Thread | undefined): ContextFill | undefined {
  const c = info?.context;
  if (!c || !(c.limit > 0)) return undefined;
  const percent = (tokens: number): number => Math.min(100, Math.max(0, Math.round((tokens / c.limit) * 100)));
  return { percent: percent(c.used), ...(c.compactAt ? { compactsAt: percent(c.compactAt) } : {}) };
}

/* ---------- the lines that say it in a few words ---------- */

export type FactLine = { text: string; name: string };

/** the facts line under the title: the model it is on, how full its context is, what it has cost. each part is left
    out when it is not known or still nothing (a context under 1%, a spend under a cent), so the line never says zero; none known, no
    line. the details' tiles keep their honest zeros. the spend is the thread's with its agents' (`agents`, from spendOf) */
export function factsOf(turns: readonly Turn[], info: Thread | undefined, agents = 0): FactLine | null {
  const now = currentModel(turns);
  const fill = contextOf(info);
  const context = fill && fill.percent > 0 ? fill : undefined;
  // what rounds to nothing is nothing: the line never says "0%" or "$0.00"
  const cost = spentOf(turns, info) + agents;
  const spent = cost >= 0.005 ? spend(cost) : undefined;
  const shown: string[] = [], said: string[] = [];
  if (now) { const words = modelWords(now.model, now.effort); shown.push(words); said.push(words); }
  if (context) { shown.push(`${context.percent}% of context`); said.push(`${context.percent}% of context used`); }
  if (spent) { shown.push(spent); said.push(`${spent} spent`); }
  return shown.length ? { text: shown.join(" · "), name: `details: ${said.join(", ")}` } : null;
}

/** the menu's short count for the details: "2 agents, 3 files", or "nothing yet" */
export function summaryOf(agents: number, files: number): string {
  const parts = [agents ? plural(agents, "agent") : "", files ? plural(files, "file") : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing yet";
}