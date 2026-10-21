/* neutral shapes for the sync tests: a thread, a fleet, and cmx2's recorded
   parts and message infos turned into what the server's translate.rs makes of
   them (server/src/source/cmx2/translate.rs, the mapping in the shapes audit):
   `sessionID` goes, a part gains `at` from its id, a step marker becomes a
   `marker`, a png/jpeg/gif/webp file an `image`, roles other than `user`
   become `assistant`, `time.created` is `created`. a recorded fixture is
   ported through these, never rewritten by hand. */

import type { FleetSnapshot, KnownPart, Message, MessageInfo, Part, Thread, ToolState } from "../protocol";

type ToolFamily = Extract<KnownPart, { type: "tool" }>["family"];
import { positionOf } from "../order";

/** an idle thread with nothing on it, as the server sends one whole */
export function thread(key: string, overrides: Partial<Thread> = {}): Thread {
  const colon = key.indexOf(":");
  const agent = colon > 0 ? key.slice(0, colon) : "bench";
  const id = colon > 0 ? key.slice(colon + 1) : key;
  return {
    key,
    agent,
    id,
    title: "a thread",
    created: 1,
    updated: 2,
    place: { root: "/w", directory: "/w", name: "w" },
    activity: { state: "idle" },
    queued: 0,
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    agents: 0,
    processes: 0,
    tail: [],
    needs: [],
    read: null,
    ...overrides,
  };
}

export function snapshot(threads: Thread[], rest: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { agents: [], threads, asks: [], order: threads.map((t) => t.key), ...rest };
}

type Json = Record<string, unknown>;

const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const atOf = (id: string): { at?: { step: number; index: number } } => {
  const position = positionOf(id);
  return position ? { at: { step: position.seq, index: position.index } } : {};
};

const timeOf = (time: unknown): { time?: { start?: number; end?: number } } => {
  if (typeof time !== "object" || time === null) return {};
  const { start, end } = time as Json;
  return { time: { ...(typeof start === "number" ? { start } : {}), ...(typeof end === "number" ? { end } : {}) } };
};

/** a mail envelope with its kind, else none (translate.rs, `mail`) */
const mailOf = (value: unknown): { mail?: { kind: string; from?: string; fromID?: string } } => {
  if (typeof value !== "object" || value === null) return {};
  const m = value as Json;
  if (typeof m["kind"] !== "string") return {};
  return { mail: { kind: m["kind"], ...(typeof m["from"] === "string" ? { from: m["from"] } : {}), ...(typeof m["fromID"] === "string" ? { fromID: m["fromID"] } : {}) } };
};

const STATUSES = new Set(["pending", "running", "completed", "error"]);

/** a tool's family by its name, as translate.rs's `family` names it */
export function familyOf(tool: string): ToolFamily {
  const families: Record<string, ToolFamily> = {
    read: "read", grep: "search", glob: "search", recall: "search", edit: "edit", write: "edit",
    shell: "shell", bash: "shell", exec_command: "shell", write_stdin: "shell", proc_spawn: "shell", proc_write: "shell", proc_read: "shell", proc_kill: "shell", proc_list: "shell",
    webfetch: "web", websearch: "web", spawn: "spawn", spawn_agent: "spawn", spawn_pool: "spawn", message: "message", send_message: "message", followup_task: "message",
    wait: "wait", wait_agent: "wait", agents: "agents", list_agents: "agents", close_agent: "agents", question: "ask", todowrite: "plan", skill: "skill",
  };
  return families[tool] ?? (tool.includes("search") ? "web" : "other");
}

/** a tool's state as translate.rs keeps it: the known fields (input and metadata as sent, time its start and end), each attachment a
    neutral image or file part named `<tool part id>.a<i>` with its data url. a status it does not know, or no input, is none */
function toolStateOf(value: unknown, partID: string, messageID: string): ToolState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const s = value as Json;
  if (typeof s["status"] !== "string" || !STATUSES.has(s["status"]) || typeof s["input"] !== "object" || s["input"] === null) return undefined;
  const str = (k: string) => (typeof s[k] === "string" ? { [k]: s[k] as string } : {});
  const attachments = Array.isArray(s["attachments"])
    ? (s["attachments"] as unknown[]).map((a, i) => neutralPart({ ...(typeof a === "object" && a !== null ? (a as Json) : {}), id: `${partID}.a${i}`, messageID }))
    : undefined;
  return {
    status: s["status"] as ToolState["status"],
    input: s["input"] as Json,
    ...str("output"),
    ...str("title"),
    ...str("error"),
    ...(typeof s["metadata"] === "object" && s["metadata"] !== null ? { metadata: s["metadata"] as Json } : {}),
    ...timeOf(s["time"]),
    ...(attachments ? { attachments } : {}),
    ...(typeof s["attachmentsDropped"] === "number" ? { attachmentsDropped: s["attachmentsDropped"] } : {}),
  };
}

/** a cmx2 part as translate.rs makes it neutral; one it cannot make neutral crosses raw */
export function neutralPart(raw: Json): Part {
  const id = raw["id"] as string;
  const messageID = raw["messageID"] as string;
  const base = { id, messageID, ...atOf(id) };
  switch (raw["type"]) {
    case "text":
      if (typeof raw["text"] !== "string") return raw as Part;
      return {
        type: "text",
        ...base,
        text: raw["text"],
        ...(raw["streaming"] === true ? { streaming: true } : {}),
        ...timeOf(raw["time"]),
        ...(raw["synthetic"] === true ? { synthetic: true } : {}),
        ...(raw["notice"] === true ? { notice: true } : {}),
        ...mailOf(raw["mail"]),
      };
    case "reasoning":
      if (typeof raw["text"] !== "string") return raw as Part;
      return { type: "reasoning", ...base, text: raw["text"], ...(raw["streaming"] === true ? { streaming: true } : {}), ...timeOf(raw["time"]) };
    case "tool": {
      const state = toolStateOf(raw["state"], id, messageID);
      if (typeof raw["tool"] !== "string" || typeof raw["callID"] !== "string" || !state) return raw as Part;
      return { type: "tool", ...base, callID: raw["callID"], tool: raw["tool"], family: familyOf(raw["tool"]), state };
    }
    case "compaction":
      if (typeof raw["auto"] !== "boolean") return raw as Part;
      return { type: "compaction", ...base, auto: raw["auto"], ...(typeof raw["overflow"] === "boolean" ? { overflow: raw["overflow"] } : {}) };
    case "file": {
      const mime = raw["mime"] as string;
      if (IMAGE.has(mime)) return { type: "image", ...base, mime, ...(typeof raw["filename"] === "string" ? { filename: raw["filename"] } : {}), url: raw["url"] as string, flavour: "attached" };
      return { type: "file", ...base, mime, filename: raw["filename"] as string, url: raw["url"] as string, flavour: "attached" };
    }
    case "step-start":
    case "step-finish":
    case "patch":
    case "subtask":
      return { type: "marker", ...base, marker: raw["type"], ...(typeof raw["cost"] === "number" ? { cost: raw["cost"] } : {}) };
    default:
      return raw as Part;
  }
}

/** a cmx2 message info as translate.rs makes it neutral */
export function neutralInfo(raw: Json): MessageInfo {
  const time = (raw["time"] ?? {}) as Json;
  return {
    id: raw["id"] as string,
    role: raw["role"] === "user" ? "user" : "assistant",
    created: (time["created"] as number | undefined) ?? 0,
    ...(typeof time["completed"] === "number" ? { completed: time["completed"] } : {}),
    ...(typeof raw["clientID"] === "string" ? { clientID: raw["clientID"] } : {}),
    ...(raw["queued"] === true ? { queued: true } : {}),
    ...(raw["steer"] === true ? { steer: true } : {}),
    ...(raw["summary"] === true ? { summary: true } : {}),
    ...(raw["notice"] === true ? { notice: true } : {}),
    ...(typeof raw["finish"] === "string" ? { finish: raw["finish"] } : {}),
    ...errorOf(raw["error"]),
    ...modelOf(raw),
    ...(typeof raw["variant"] === "string" ? { effort: raw["variant"] } : {}),
    ...(typeof raw["cost"] === "number" ? { cost: raw["cost"] } : {}),
    ...mailOf(raw["mail"]),
  };
}

/** an error whenever cmx2's info has an error object: its message (cmx2's `data.message`, absent when it has none) and its name */
function errorOf(value: unknown): Pick<MessageInfo, "error"> {
  if (typeof value !== "object" || value === null) return {};
  const e = value as Json;
  const data = e["data"];
  const message = typeof data === "object" && data !== null && typeof (data as Json)["message"] === "string" ? ((data as Json)["message"] as string) : undefined;
  const name = typeof e["name"] === "string" ? e["name"] : undefined;
  /* the generated type still says message is required until s1's schema change is regenerated */
  return { error: { ...(message !== undefined ? { message } : {}), ...(name !== undefined ? { name } : {}) } as NonNullable<MessageInfo["error"]> };
}

/** "provider/model", from the model object when the info has one, else from the top-level ids */
function modelOf(raw: Json): Pick<MessageInfo, "model"> {
  const m = raw["model"];
  if (typeof m === "object" && m !== null) {
    const o = m as Json;
    return typeof o["providerID"] === "string" && typeof o["modelID"] === "string" ? { model: `${o["providerID"]}/${o["modelID"]}` } : {};
  }
  return typeof raw["providerID"] === "string" && typeof raw["modelID"] === "string" ? { model: `${raw["providerID"]}/${raw["modelID"]}` } : {};
}

export const neutralMessage = (raw: { info: Json; parts: Json[] }): Message => ({ info: neutralInfo(raw.info), parts: raw.parts.map(neutralPart) });
