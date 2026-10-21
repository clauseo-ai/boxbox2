/* the thread summary's reference (docs/protocol.md, section 12): runs the app's own turn model over each thread fixture and
   writes the summary the server's fold must give, one golden per thread, under server/src/fleet/summary/fold/goldens.
   `bun scripts/summary-reference.ts` writes them; `--check` fails when a committed golden differs from what it would write.

   what the app computes inside components, reproduced here as the smallest pure equivalent:
   - the turns as createTurns (turns.ts) makes them: the shown messages (shownCount), cut at each user message, each turn
     built alone by turnsOf over its own slice; messages before the first user message make no turn
   - the turn's line: stage.tsx's firstLineOf (a closure in the component)
   - the child facts: live.ts's summary memo for a held thread (steps, first, end)

   the fixtures are cmx2's shapes; each message is made neutral as the server's translate makes it (sync/fixtures/neutral.ts)
   before the app reads it, as the server folds neutral messages. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { filesChanged } from "../app/src/ui/thread/details-model";
import { type Step, type Turn, projectRoot, shownCount, spawnsOf, turnsOf } from "../app/src/ui/thread/model";
import { isBad } from "../app/src/ui/thread/rows";
import type { WireMessage } from "../app/src/ui/thread/wire";
import { neutralMessage } from "../app/src/sync/fixtures/neutral";

const repo = join(dirname(new URL(import.meta.url).pathname), "..");
const fixtures = join(repo, "app/src/ui/thread/fixtures");
const out = join(repo, "server/src/fleet/summary/fold/goldens");

type Recorded = { info: Record<string, unknown>; parts: Record<string, unknown>[] };
type Fixture = { session: { id: string; directory: string }; messages: Recorded[]; children?: Array<{ session: { id: string; directory: string }; messages: Recorded[] }>; snapshots?: Array<{ messages: Recorded[] }> };

/** where a thread's messages sit in its fixture file, as the rust test reads them */
type Thread = { name: string; fixture: string; source: "messages" | "last-snapshot" | { child: number }; key: string; directory: string; messages: WireMessage[] };

function threadsOf(file: string): Thread[] {
  const f = JSON.parse(readFileSync(join(fixtures, `${file}.json`), "utf8")) as Fixture;
  const threads: Thread[] = [];
  const last = f.snapshots?.at(-1);
  if (last) threads.push({ name: file, fixture: file, source: "last-snapshot", key: f.session.id, directory: f.session.directory, messages: last.messages.map(neutralMessage) });
  else threads.push({ name: file, fixture: file, source: "messages", key: f.session.id, directory: f.session.directory, messages: f.messages.map(neutralMessage) });
  (f.children ?? []).forEach((c, i) => threads.push({ name: `${file}.${c.session.id}`, fixture: file, source: { child: i }, key: c.session.id, directory: c.session.directory, messages: c.messages.map(neutralMessage) }));
  return threads;
}

/** the summary's model for a turn: "provider/model", the neutral message's own (docs/protocol.md, section 12). the app's turn shows the
    model alone (cmx2's `modelID`, the part after the provider), so this reads the messages as turnsOf does: the last assistant
    message that names a model, a compaction's summary message aside */
function summaryModel(messages: readonly WireMessage[], turn: Turn): string | undefined {
  let model: string | undefined;
  for (const m of messages) {
    if (m.info.role !== "assistant" || (turn.compacted && m.info.summary === true)) continue;
    if (m.info.model) model = m.info.model;
  }
  return model;
}

/** stage.tsx's firstLineOf */
const firstLineOf = (text: string): string => { for (const line of text.slice(0, 20_000).split("\n")) if (line.trim()) return line.slice(0, 300); return ""; };

/** createTurns (turns.ts) without its memos: each turn with how many messages it holds */
function turnsAsShown(all: readonly WireMessage[], root: string): Array<{ turn: Turn; messages: number; model: string | undefined }> {
  const n = shownCount(all);
  const cuts: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < n; i++) {
    if ((all[i] as WireMessage).info.role !== "user") continue;
    const last = cuts.at(-1);
    if (last) last.to = i;
    cuts.push({ from: i, to: n });
  }
  return cuts.flatMap(({ from, to }) => {
    const slice = all.slice(from, to);
    const turn = turnsOf(slice, root)[0];
    return turn ? [{ turn, messages: to - from, model: summaryModel(slice, turn) }] : [];
  });
}

const steps = (t: Turn): Step[] => t.items.filter((x): x is Step => x.k === "step");

function summaryOf(thread: Thread): unknown {
  const all = thread.messages;
  const root = projectRoot(thread.directory, all);
  const shown = turnsAsShown(all, root);
  const turns = shown.map(({ turn: t, messages, model }) => {
    const s = steps(t);
    return {
      id: t.id,
      by: t.by,
      ...(t.from ? { from: t.from } : {}),
      ...(t.fromID ? { fromID: t.fromID } : {}),
      ...(t.note ? { note: true } : {}),
      at: t.at,
      end: t.end,
      line: t.by === "mail" || t.by === "compaction" ? "" : firstLineOf(t.prompt),
      steps: s.length,
      ...(s.length ? { ask: s.some((x) => x.family === "ask"), error: s.some(isBad) } : {}),
      status: t.status,
      ...(t.model && model ? { model } : {}),
      ...(t.effort ? { effort: t.effort } : {}),
      ...(t.cost !== 0 ? { cost: t.cost } : {}),
      answered: t.answer !== undefined,
      messages,
    };
  });
  const spawns = shown.flatMap(({ turn: t }) => spawnsOf(t).map((s) => ({
    turn: t.id,
    part: s.id,
    name: s.agent?.name ?? s.object,
    ...(s.agent?.type ? { type: s.agent.type } : {}),
    ...(s.agent?.child ? { child: s.agent.child } : {}),
    at: s.at,
  })));
  /* files[].at is the spec's (the app has no such value): the time of the newest completed edit of that path */
  const newest = new Map<string, number>();
  for (const { turn: t } of shown) for (const s of steps(t)) if (s.family === "edit" && s.status === "completed" && s.object) newest.set(s.object, Math.max(newest.get(s.object) ?? -Infinity, s.at));
  const files = filesChanged(shown.map((x) => x.turn)).files.map((f) => ({ path: f.path, add: f.add, del: f.del, at: newest.get(f.path) as number }));
  /* live.ts's summary of a held child */
  const first = all[0]?.info.created ?? 0;
  const child = { key: thread.key, steps: shown.reduce((n, { turn }) => n + steps(turn).length, 0), first, end: all.at(-1)?.info.completed ?? first };
  return { thread: thread.name, fixture: thread.fixture, source: thread.source, directory: thread.directory, total: all.length, turns, spawns, files, child };
}

const check = process.argv.includes("--check");
let stale = 0;
mkdirSync(out, { recursive: true });
for (const file of ["cmx-deploy", "northstar-heavy", "notes-asks"]) {
  for (const thread of threadsOf(file)) {
    const text = `${JSON.stringify(summaryOf(thread), null, 1)}\n`;
    const path = join(out, `${thread.name}.json`);
    if (check) {
      let held = "";
      try { held = readFileSync(path, "utf8"); } catch { /* missing */ }
      if (held !== text) { stale++; console.error(`${thread.name}: the golden differs from the app's answer`); }
    } else writeFileSync(path, text);
  }
}
if (stale) process.exit(1);
