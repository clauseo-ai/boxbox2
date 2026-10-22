/* journal.ndjson, a contract 1 recording of a real cmx2 daemon, as the protocol 3 frames the server sends for the same
   changes (docs/protocol.md, sections 3, 6 to 8; server/src/wire/patch.rs, which the patches here follow). each frame keeps
   its recorded id and seq. a session becomes its thread whole on first sight and after its removal, else a thread.patch
   against the last thread sent: the fields that changed (set), the optional ones that became absent (unset), the tail as
   drops and puts; a session that changed nothing takes no frame, and so takes no seq, as the server journals none. the
   window order is an order.patch when that is smaller than the list, else the list whole. a host is an agent (translate.rs,
   `agent`), a cmx2 thread is translate.rs's thread (`thread`, `activity`), and a message, part, ask and settle take the
   neutral shapes (neutral.ts for the messages and parts). the committed journal-p3.ndjson is this module's output over
   journal.ndjson, and a test holds the two equal. */

import type { Agent, Ask, Frame, Thread, TailItem } from "../../../sync/protocol";
import { neutralInfo, neutralPart } from "../../../sync/fixtures/neutral";
import type { Recorded } from "./replay";
import { repoName } from "../../window/repo";

type Json = Record<string, unknown>;
/** one frame of journal.ndjson: the contract 1 recording's own shape */
export type Contract1 = { id: string | null; frame: Json };

export type Converted = {
  frames: Recorded[];
  /** what the frames build, for the tests: the fleet's threads, window order, agents and asks after the last frame */
  threads: Record<string, Thread>;
  order: string[];
  agents: Record<string, Agent>;
  asks: Record<string, Ask>;
};

/** the stream id the converted hello carries: 128 bits, hex */
const STREAM = "3c5e1a9f07b24d8e9a61c0d4e27b5f13";

const NO_INTEREST = { thread: null, under: [], holds: [] };

/** what cmx2 can do, as translate.rs's `Capabilities::cmx2()` says (capabilities.rs) */
const CMX2_CAPABILITIES: Agent["capabilities"] = {
  admin: true,
  approvals: true,
  archive: true,
  fork: true,
  commands: true,
  compact: true,
  files: true,
  history: true,
  model: true,
  origins: false,
  places: true,
  questions: true,
  queue: true,
  quotes: false,
  reactions: false,
  review: true,
  shell: true,
  spend: true,
  steer: true,
  subagents: true,
  terminal: true,
  threads: true,
  worktree: true,
  attachments: {
    kinds: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif", "application/pdf", "text/*", "application/json"],
    maxBytes: 9 * 1024 * 1024,
    maxCount: 4,
  },
  reasoning: { word: "effort", levels: ["low", "medium", "high", "xhigh", "max"] },
  voice: { notes: false, replies: false },
};

const obj = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
/** a value the reducer's equality and the server's both read as the same: the json of it */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** translate.rs's `whole`: a count, truncated, and 0 when it is not a positive number */
const whole = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

function agentOf(host: Json): Agent {
  const name = str(host["name"]);
  const health = obj(host["health"]);
  const frames = obj(host["frames"]);
  const connection = str(host["connection"]);
  return {
    key: name,
    label: { name: null, source: "cmx", machine: name },
    kind: "coding",
    source: "cmx2",
    mark: "square",
    palette: null,
    status: connection === "connected" ? "ready" : connection === "connecting" ? "connecting" : "down",
    connection: {
      name,
      url: str(host["url"]),
      origin: str(host["origin"]) as Agent["connection"]["origin"],
      since: num(host["since"]),
      lastError: typeof host["lastError"] === "string" ? host["lastError"] : null,
      connects: num(host["connects"]),
      version: typeof health["version"] === "string" ? health["version"] : null,
      pinned: null,
      untested: false,
      protocol: null,
      refused: null,
      contract: typeof health["contract"] === "number" ? health["contract"] : null,
      contractMatches: typeof health["contractMatches"] === "boolean" ? health["contractMatches"] : null,
      frames: { decoded: num(frames["decoded"]), undecodable: num(frames["undecodable"]), duplicates: num(frames["duplicates"]) },
      memory: (host["memory"] ?? null) as Exclude<Agent["connection"]["memory"], undefined>,
      ...(host["system"] ? { system: host["system"] as Exclude<Agent["connection"]["system"], undefined> } : {}),
      ...(typeof host["reportsSystem"] === "boolean" ? { reportsSystem: host["reportsSystem"] } : {}),
      cursor: typeof host["cursor"] === "string" ? host["cursor"] : null,
    },
    capabilities: CMX2_CAPABILITIES,
  };
}

/** translate.rs's `activity`: a busy or retrying status as it is, an idle one with a park as parked, and no status as idle */
function activityOf(status: Json | null): Thread["activity"] {
  if (status === null) return { state: "idle" };
  const since = typeof status["since"] === "number" ? status["since"] : undefined;
  if (status["type"] === "busy") return { state: "busy", since: since ?? 0 };
  if (status["type"] === "retry") {
    return { state: "retry", attempt: whole(status["attempt"]), message: str(status["message"]), next: num(status["next"]), ...(since !== undefined ? { since } : {}) };
  }
  const parked = status["parked"] ? obj(status["parked"]) : null;
  if (parked) return { state: "parked", agents: whole(parked["agents"]), jobs: whole(parked["jobs"]), ...(since !== undefined ? { since } : {}) };
  return { state: "idle" };
}

const tailOf = (item: Json): TailItem => ({
  partID: str(item["partID"]),
  messageID: str(item["messageID"]),
  kind: item["kind"] as TailItem["kind"],
  role: str(item["role"]),
  ...(typeof item["tool"] === "string" ? { tool: item["tool"] } : {}),
  ...(typeof item["state"] === "string" ? { state: item["state"] } : {}),
  text: str(item["text"]),
  ...(typeof item["from"] === "string" ? { from: item["from"] } : {}),
});

/** translate.rs's `thread` and `SessionEntry` to Thread: the info's fields, the status as activity and the queue count it
    carries (the server fills `queued` from the busy status it is given), the tail, needs and read as they are */
function threadOf(session: Json): Thread {
  const info = obj(session["info"]);
  const time = obj(info["time"]);
  const tokens = obj(info["tokens"]);
  const cache = obj(tokens["cache"]);
  const projectID = str(info["projectID"]);
  const directory = str(info["directory"]);
  const title = str(info["title"]);
  const status = session["status"] ? obj(session["status"]) : null;
  const model = info["model"] ? obj(info["model"]) : null;
  const context = info["context"] ? obj(info["context"]) : null;
  const vcs = info["vcs"] ? obj(info["vcs"]) : null;
  const summary = info["summary"] ? obj(info["summary"]) : null;
  return {
    key: str(session["key"]),
    agent: str(session["host"]),
    id: str(info["id"]),
    title,
    created: num(time["created"]),
    updated: num(time["updated"]),
    ...(typeof info["parentID"] === "string" ? { parent: info["parentID"] } : {}),
    place: { root: projectID.startsWith("/") ? projectID : directory, directory, name: repoName(projectID) },
    activity: activityOf(status),
    queued: status && status["type"] === "busy" ? whole(status["queued"]) : 0,
    ...(model ? { model: `${str(model["providerID"])}/${str(model["id"])}` } : {}),
    ...(typeof info["effort"] === "string" ? { effort: info["effort"] } : {}),
    ...(context
      ? { context: { used: whole(context["used"]), limit: whole(context["limit"]), ...(typeof context["compactAt"] === "number" ? { compactAt: whole(context["compactAt"]) } : {}) } }
      : {}),
    cost: num(info["cost"]),
    tokens: { input: whole(tokens["input"]), output: whole(tokens["output"]), cacheRead: whole(cache["read"]), cacheWrite: whole(cache["write"]) },
    ...(vcs ? { vcs: { branch: str(vcs["branch"]), dirty: vcs["dirty"] === true } } : {}),
    ...(summary ? { changes: { additions: whole(summary["additions"]), deletions: whole(summary["deletions"]), files: whole(summary["files"]) } } : {}),
    ...(info["source"] === "cmx" ? { browseOnly: true } : {}),
    agents: whole(session["agents"]),
    processes: whole(session["processes"]),
    tail: list(session["tail"]).map(tailOf),
    needs: list(session["needs"]) as unknown as Thread["needs"],
    read: (session["read"] ?? null) as Exclude<Thread["read"], undefined>,
    ...(typeof session["cleared"] === "number" ? { cleared: session["cleared"] } : {}),
  };
}

/** translate.rs's `ask`: the words of a question with the details the request carries beside them, or a permission
    with cmx2's three fixed options. a question with no words is none */
function askOf(ask: Json): Ask {
  const key = str(ask["key"]);
  const request = obj(ask["request"]);
  const tool = request["tool"] ? obj(request["tool"]) : null;
  const common = {
    key,
    agent: str(ask["host"]),
    id: str(ask["id"]),
    thread: key,
    kind: ask["kind"] as Ask["kind"],
    ...(tool ? { tool: { messageID: str(tool["messageID"]), callID: str(tool["callID"]) } } : {}),
  };
  if (ask["kind"] === "question") {
    const questions = list(request["questions"]).map((q) => ({
      question: str(q["question"]),
      header: str(q["header"]),
      multiple: q["multiple"] === true,
      custom: q["custom"] === true,
      options: list(q["options"]).map((o) => ({ label: str(o["label"]), ...(typeof o["description"] === "string" ? { description: o["description"] } : {}) })),
    }));
    return { ...common, ...(questions.length > 0 ? { questions } : {}) };
  }
  return {
    ...common,
    permission: {
      title: str(request["permission"]),
      patterns: (request["patterns"] ?? []) as string[],
      always: (request["always"] ?? []) as string[],
      options: [
        { id: "once", label: "allow once", lasting: false },
        { id: "always", label: "always allow", lasting: true },
        { id: "reject", label: "reject", lasting: false },
      ],
    },
  };
}

/* —— the patches: patch.rs, ported —— */

const REQUIRED = ["title", "created", "updated", "activity", "queued", "agents", "processes", "needs"] as const;
const OPTIONAL = ["said", "generation", "parent", "place", "origin", "sends", "model", "effort", "context", "cost", "tokens", "vcs", "changes", "read", "cleared"] as const;

/** patch.rs `thread`: the fields that changed, the optional ones that became absent, and the tail; none when nothing did */
function threadPatch(prev: Thread, next: Thread): Json | null {
  const a = prev as unknown as Json;
  const b = next as unknown as Json;
  const set: Json = {};
  const unset: string[] = [];
  for (const field of REQUIRED) if (!same(a[field], b[field])) set[field] = b[field];
  for (const field of OPTIONAL) {
    if (same(a[field], b[field])) continue;
    if (b[field] === undefined || b[field] === null) unset.push(field);
    else set[field] = b[field];
  }
  if (!!a["browseOnly"] !== !!b["browseOnly"]) {
    if (b["browseOnly"]) set["browseOnly"] = true;
    else unset.push("browseOnly");
  }
  const tail = tailPatch(prev.tail, next.tail);
  if (Object.keys(set).length === 0 && unset.length === 0 && !tail) return null;
  return {
    key: next.key,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
    ...(tail ? { tail } : {}),
  };
}

/** patch.rs `tail`: the drop that leaves the fewest puts; a drop of n removes n from the front, then each put replaces
    the item at its index, or appends it when the index is the length */
function tailPatch(prev: readonly TailItem[], next: readonly TailItem[]): { drop: number; put: [number, TailItem][] } | null {
  if (same(prev, next)) return null;
  let best: { drop: number; puts: number[] } | null = null;
  for (let drop = 0; drop <= prev.length; drop++) {
    const base = prev.slice(drop);
    if (base.length > next.length) continue;
    const puts: number[] = [];
    for (let i = 0; i < next.length; i++) if (!same(base[i], next[i])) puts.push(i);
    if (best === null || puts.length < best.puts.length) best = { drop, puts };
  }
  if (best === null) return null;
  return { drop: best.drop, put: best.puts.map((i): [number, TailItem] => [i, next[i] as TailItem]) };
}

type OrderOp = ["-", number, number] | ["+", number, string[]];

/** patch.rs `order_ops`: removes and inserts around the longest common run of keys */
function orderOps(prev: readonly string[], next: readonly string[]): OrderOp[] {
  const n = prev.length;
  const m = next.length;
  const table = new Array<number>((n + 1) * (m + 1)).fill(0);
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = prev[i] === next[j] ? (table[at(i + 1, j + 1)] as number) + 1 : Math.max(table[at(i + 1, j)] as number, table[at(i, j + 1)] as number);
    }
  }
  const ops: OrderOp[] = [];
  let i = 0;
  let j = 0;
  let pos = 0;
  while (i < n || j < m) {
    if (i < n && j < m && prev[i] === next[j]) {
      i++;
      j++;
      pos++;
    } else if (j < m && (i === n || (table[at(i, j + 1)] as number) >= (table[at(i + 1, j)] as number))) {
      const last = ops.at(-1);
      if (last && last[0] === "+" && last[1] + last[2].length === pos) last[2].push(next[j] as string);
      else ops.push(["+", pos, [next[j] as string]]);
      j++;
      pos++;
    } else {
      const last = ops.at(-1);
      if (last && last[0] === "-" && last[1] === pos) last[2] += 1;
      else ops.push(["-", pos, 1]);
      i++;
    }
  }
  return ops;
}

/** patch.rs `order`: the ops when they are smaller than the list, else none (the list goes whole) */
function orderPatch(prev: readonly string[], next: readonly string[]): OrderOp[] | null {
  const ops = orderOps(prev, next);
  return JSON.stringify(ops).length < JSON.stringify(next).length ? ops : null;
}

/** the recording as protocol 3 frames: each with its recorded id and seq, a session as thread or thread.patch, an order
    as order or order.patch, the rest in their neutral forms. an unknown frame throws, so a new recording says what it adds */
export function toProtocol3(records: readonly Contract1[]): Converted {
  const frames: Recorded[] = [];
  let threads: Record<string, Thread> = {};
  let order: string[] = [];
  let agents: Record<string, Agent> = {};
  let asks: Record<string, Ask> = {};
  /** the newest time the recording shows: the stand-in for the server's clock where a frame carries none */
  let clock = 0;
  const emit = (id: string | null, frame: Json) => frames.push({ id, frame: frame as unknown as Frame });

  for (const { id, frame } of records) {
    const type = str(frame["type"]);
    const seq = num(frame["seq"]);
    switch (type) {
      case "hello":
        emit(id, {
          type: "hello",
          protocol: 3,
          epoch: frame["epoch"],
          head: frame["head"],
          build: frame["build"],
          stream: STREAM,
          interest: NO_INTEREST,
        });
        break;
      case "reset": {
        const fleet = obj(frame["fleet"]);
        agents = {};
        for (const host of list(fleet["hosts"])) {
          const agent = agentOf(host);
          agents[agent.key] = agent;
        }
        threads = {};
        for (const session of list(fleet["sessions"])) {
          const thread = threadOf(session);
          threads[thread.key] = thread;
          clock = Math.max(clock, thread.updated);
        }
        asks = {};
        for (const ask of list(fleet["asks"])) {
          const neutral = askOf(ask);
          asks[`${neutral.agent}:${neutral.id}`] = neutral;
        }
        order = list(fleet["order"]).map((key) => str(key));
        emit(id, {
          type: "reset",
          seq,
          epoch: frame["epoch"],
          reason: "none",
          fleet: { agents: Object.values(agents), threads: Object.values(threads), asks: Object.values(asks), order },
        });
        break;
      }
      case "session": {
        const next = threadOf(obj(frame["session"]));
        clock = Math.max(clock, next.updated);
        const prev = threads[next.key];
        threads[next.key] = next;
        if (prev === undefined) emit(id, { seq, type: "thread", thread: next });
        else {
          const patch = threadPatch(prev, next);
          if (patch) emit(id, { seq, type: "thread.patch", ...patch });
        }
        break;
      }
      case "session.removed": {
        const key = str(frame["key"]);
        const { [key]: _gone, ...rest } = threads;
        threads = rest;
        emit(id, { seq, type: "thread.removed", key });
        break;
      }
      case "order": {
        const keys = list(frame["keys"]).map((key) => str(key));
        if (same(keys, order)) break;
        const ops = orderPatch(order, keys);
        emit(id, ops ? { seq, type: "order.patch", ops } : { seq, type: "order", keys });
        order = keys;
        break;
      }
      case "ask": {
        const ask = askOf(obj(frame["ask"]));
        asks[`${ask.agent}:${ask.id}`] = ask;
        emit(id, { seq, type: "ask", ask });
        break;
      }
      case "ask.settled": {
        // the recording keeps no outcome or time for a settle: the answer is cmx2's, and the server's clock is the newest the recording shows
        const agent = str(frame["host"]);
        const askId = str(frame["id"]);
        const { [`${agent}:${askId}`]: _settled, ...rest } = asks;
        asks = rest;
        emit(id, { seq, type: "ask.settled", agent, id: askId, outcome: "answered", at: clock });
        break;
      }
      case "message":
        emit(id, { seq, type: "message", key: frame["key"], upstream: frame["upstream"] ?? null, message: neutralInfo(obj(frame["info"])) });
        break;
      case "part":
        emit(id, { seq, type: "part", key: frame["key"], upstream: frame["upstream"] ?? null, part: neutralPart(obj(frame["part"])) });
        break;
      case "delta":
        emit(id, { seq, type: "delta", key: frame["key"], messageID: frame["messageID"], partID: frame["partID"], field: frame["field"], delta: frame["delta"], offset: frame["offset"] });
        break;
      default:
        throw new Error(`the recording holds a frame this converter does not know: ${type}`);
    }
  }
  return { frames, threads, order, agents, asks };
}

/** the recording's lines as the committed file holds them: one `{id, frame}` object per line */
export function serialize(frames: readonly Recorded[]): string {
  return frames.map((recorded) => `${JSON.stringify(recorded)}\n`).join("");
}
