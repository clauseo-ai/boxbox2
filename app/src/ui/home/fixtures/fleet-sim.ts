/* a fleet that lives a while, for the reactive tests and measurements: a few hundred threads over two agents built from the
   recorded journal's own threads (replay.ts), then a seeded run of what the stream does to them: working threads' tails
   growing five times a second, turns starting and ending, asks coming and going, threads cleared, agents spawned under a
   parent, the order moving, threads leaving, and the clock passing (some threads' 12 hours run out on the way). each step is
   handed out as patches the way the worker sends them: whole entries (the wire before the worker diffed them) or what the
   reducer itself posts for a thread frame (`fine`: the changed leaves, sync/reducer.ts). */

import type { Ask, Thread } from "../../../sync/protocol";
import { appended, type Fleet, INITIAL_STATE, isAppend, type Patch, reduce } from "../../../sync/reducer";
import { parseJournal, replay } from "./replay";

const HOUR = 60 * 60 * 1000;

/** a seeded generator, so a failing run is the same run again */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Step = { patches: Patch[]; /** the clock moved to here, when it did */ now?: number };

const clone = <T,>(value: T): T => structuredClone(value);

/** `journal` is journal-p3.ndjson's text, read however the caller reads files */
export function simulate(journal: string, options: { sessions?: number; steps?: number; seed?: number; fine?: boolean } = {}): { start: Fleet; now: number; steps: Step[] } {
  const random = seeded(options.seed ?? 7);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const recorded = replay(parseJournal(journal)).state.fleet;
  const templates = Object.values(recorded.threads);
  const askTemplate = Object.values(recorded.asks)[0] as Ask;
  let now = Math.max(...templates.map((t) => t.updated));
  const agents = ["bench", "desk"];
  let made = 0;
  const make = (parent?: Thread): Thread => {
    const { parent: _parent, cleared: _cleared, ...base } = clone(pick(templates));
    const agent = parent?.agent ?? pick(agents);
    const id = `ses_sim${String(made++).padStart(5, "0")}`;
    const updated = parent ? now : now - Math.floor(random() * 14 * HOUR);
    const roll = random();
    const activity: Thread["activity"] = parent || roll < 0.1 ? { state: "busy", since: updated } : roll < 0.15 ? { state: "parked", agents: 1, jobs: 0, since: updated } : { state: "idle" };
    return {
      ...base,
      key: `${agent}:${id}`,
      agent,
      id,
      title: `thread ${made}`,
      ...(parent ? { parent: parent.id } : {}),
      cost: Math.round(random() * 1000) / 100,
      created: updated - 60_000,
      updated,
      activity,
      queued: 0,
      cleared: roll > 0.95 ? updated : null,
    };
  };
  const fleet: Fleet = { agentNames: agents, agents: {}, threads: {}, asks: {}, order: [], colours: {} };
  for (let i = 0; i < (options.sessions ?? 300); i++) {
    const thread = make();
    fleet.threads[thread.key] = thread;
  }
  fleet.order = Object.keys(fleet.threads);
  const start = clone(fleet);
  const startNow = now;

  const steps: Step[] = [];
  let seq = 0;
  /* the reducer's own patches for a thread frame: it diffs the thread against the one it holds */
  const reduced = (thread: Thread, next: Thread): Patch[] => {
    seq++;
    const state = { ...INITIAL_STATE, cursor: { epoch: "sim", seq: seq - 1 }, head: seq - 1, fleet: { ...INITIAL_STATE.fleet, threads: { [thread.key]: thread } } };
    return reduce(state, { type: "frame", frame: { type: "thread", seq, thread: next }, id: { epoch: "sim", seq } }).patches.filter((p) => p.path[0] === "fleet");
  };
  const put = (thread: Thread | undefined, next: Thread): Patch[] =>
    options.fine && thread ? reduced(thread, next) : [{ path: ["fleet", "threads", next.key], value: next } as Patch];
  const commit = (next: Thread): Patch[] => {
    const patches = put(fleet.threads[next.key], next);
    fleet.threads[next.key] = next;
    return patches;
  };
  for (let n = 0; n < (options.steps ?? 600); n++) {
    const roll = random();
    const keys = Object.keys(fleet.threads);
    const working = keys.filter((k) => fleet.threads[k]?.activity.state === "busy");
    const any = pick(keys);
    const entry = fleet.threads[any] as Thread;
    if (roll < 0.55 && working.length > 0) {
      // a working thread's tail grows: the frame most of the stream is made of
      const key = pick(working);
      const was = fleet.threads[key] as Thread;
      const tail = [...was.tail.slice(-11), { ...(was.tail.at(-1) ?? { partID: "p", messageID: "m", kind: "text", role: "assistant" }), partID: `prt_${n}`, text: `word ${n}` }];
      steps.push({ patches: commit({ ...clone(was), tail: tail as Thread["tail"], updated: now }) });
    } else if (roll < 0.62) {
      // the clock: a second, now and then a long stretch, so 12 hours run out on the way
      now += random() < 0.1 ? Math.floor(random() * 3 * HOUR) : 1000;
      steps.push({ patches: [], now });
    } else if (roll < 0.68) {
      // a turn starts or ends
      const activity: Thread["activity"] = entry.activity.state === "idle" ? (random() < 0.8 ? { state: "busy", since: now } : { state: "parked", agents: 0, jobs: 1, since: now }) : { state: "idle" };
      steps.push({ patches: commit({ ...clone(entry), activity, cleared: activity.state === "idle" ? (entry.cleared ?? null) : null, updated: now }) });
    } else if (roll < 0.71) {
      // an idle frame that changes nothing the windows or the rule read: the tail of a thread at rest is resent
      steps.push({ patches: commit(clone(entry)) });
    } else if (roll < 0.74) {
      // cleared, or brought back
      steps.push({ patches: commit({ ...clone(entry), cleared: entry.cleared == null && entry.activity.state === "idle" ? now : null }) });
    } else if (roll < 0.78) {
      // an agent is spawned under a thread, and joins the order
      const child = make(entry);
      const patches = commit(child);
      fleet.order = [...fleet.order, child.key];
      steps.push({ patches: [...patches, { path: ["fleet", "order"], value: [...fleet.order] } as Patch] });
    } else if (roll < 0.82) {
      // an ask comes or goes
      const asked = Object.keys(fleet.asks);
      if (asked.length > 0 && random() < 0.5) {
        const id = pick(asked);
        delete fleet.asks[id];
        steps.push({ patches: [{ path: ["fleet", "asks", id], value: undefined } as Patch] });
      } else {
        const id = `${entry.agent}:que_${n}`;
        const ask = { ...clone(askTemplate), key: entry.key, agent: entry.agent, id: `que_${n}`, thread: entry.key } as Ask;
        fleet.asks[id] = ask;
        steps.push({ patches: [{ path: ["fleet", "asks", id], value: ask } as Patch] });
      }
    } else if (roll < 0.86) {
      // the order moves: one thread to the front
      fleet.order = [any, ...fleet.order.filter((k) => k !== any)];
      steps.push({ patches: [{ path: ["fleet", "order"], value: [...fleet.order] } as Patch] });
    } else if (roll < 0.88) {
      // a thread leaves the fleet
      delete fleet.threads[any];
      fleet.order = fleet.order.filter((k) => k !== any);
      steps.push({ patches: [{ path: ["fleet", "threads", any], value: undefined } as Patch, { path: ["fleet", "order"], value: [...fleet.order] } as Patch] });
    } else if (roll < 0.9) {
      // a new thread
      const fresh = make();
      fresh.updated = now;
      const patches = commit(fresh);
      fleet.order = [fresh.key, ...fleet.order];
      steps.push({ patches: [...patches, { path: ["fleet", "order"], value: [...fleet.order] } as Patch] });
    } else {
      // a count changes in place: the queue behind a working turn
      steps.push({ patches: commit({ ...clone(entry), queued: entry.activity.state === "busy" ? entry.queued + 1 : entry.queued }) });
    }
  }
  return { start, now: startNow, steps };
}

type Node = Record<string | number, unknown>;

/** store.ts's own walk: one patch into a draft */
export function setPath(root: Node, patch: Patch): void {
  const path = patch.path;
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string | number; // i stops before the last segment
    let child = node[segment];
    if (child === null || typeof child !== "object") {
      child = typeof path[i + 1] === "number" ? [] : {};
      node[segment] = child;
    }
    node = child as Node;
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  if (isAppend(patch)) node[last] = appended(node[last], patch);
  else if (patch.value === undefined) delete node[last];
  else node[last] = patch.value;
}
