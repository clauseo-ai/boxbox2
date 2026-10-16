/* agents as the wire would carry them, for the stories and the tests: wren, an assistant on vm-b (coral, the first), and
   cmx on vm-a and vm-c. names are placeholders; nothing here is a real machine or person. */

import type { Agent, Capabilities, Connection } from "../wire";

export const AT = new Date(2026, 9, 15, 11, 52, 0).getTime();
export const at = (h: number, m: number): number => new Date(2026, 9, 15, h, m, 0).getTime();

const CAPS: Capabilities = {
  places: false,
  worktree: false,
  terminal: false,
  review: false,
  compact: false,
  queue: false,
  steer: false,
  model: false,
  reasoning: { word: "thinking", levels: ["off", "low", "medium", "high"] },
  approvals: true,
  questions: true,
  attachments: { kinds: ["image", "file"], maxBytes: 20_000_000, maxCount: 8 },
  voice: { notes: true, replies: true },
  quotes: true,
  reactions: true,
  threads: true,
  archive: true,
  commands: false,
  files: false,
  shell: false,
  history: true,
  subagents: false,
  spend: false,
  origins: true,
  admin: false,
};

const CONNECTION: Connection = {
  name: "wren",
  url: "wss://vm-b.local:18789",
  origin: "paired",
  since: AT - 3 * 3600_000 - 12 * 60_000,
  lastError: null,
  connects: 1,
  version: "2026.10.1",
  pinned: "2026.10.1",
  untested: false,
  protocol: 4,
  refused: null,
  contract: null,
  contractMatches: null,
  memory: null,
};

export function assistant(over: Partial<Omit<Agent, "connection" | "capabilities">> & { connection?: Partial<Connection>; capabilities?: Partial<Capabilities> } = {}): Agent {
  const { connection, capabilities, ...rest } = over;
  return {
    key: "wren",
    label: { name: "wren", source: "openclaw", machine: "vm-b" },
    kind: "assistant",
    source: "openclaw",
    mark: "round",
    palette: "coral",
    status: "ready",
    runs: null,
    ...rest,
    connection: { ...CONNECTION, ...connection },
    capabilities: { ...CAPS, ...capabilities },
  };
}

export function cmx(machine: string, over: Partial<Agent> = {}): Agent {
  return {
    key: `cmx:${machine}`,
    label: { source: "cmx", machine },
    kind: "coding",
    source: "cmx2",
    mark: "square",
    palette: null,
    status: "ready",
    runs: null,
    connection: { ...CONNECTION, name: machine, url: `http://${machine}.local:7390`, version: "0.8.3", pinned: null, protocol: null, contract: 2, contractMatches: true },
    capabilities: { ...CAPS, places: true, worktree: true, terminal: true, review: true, compact: true, queue: true, steer: true, model: true, commands: true, files: true, shell: true, admin: true, origins: false, quotes: false, reactions: false },
    ...over,
  };
}

/** the gateway's own words while it waits for approval, verbatim (they carry the command) */
export const APPROVAL = "device not approved. on the gateway host, run:\nopenclaw devices approve 9c41e7b2";
