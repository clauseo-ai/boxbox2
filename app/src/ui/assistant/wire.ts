/* contract 2's shapes as the assistant surfaces read them (docs/agents.md, 1. the neutral wire; server/src/wire/*.rs),
   named as the rust types and their serde names are. these are a mirror for the standalone components and their stories
   only: when contract 2 lands, the generated types (bun scripts/gen-api.ts) replace this file and every import moves to
   them; nothing here decodes, and nothing here is sent. only the fields the surfaces draw are mirrored. */

/* —— the agent (wire/agent.rs, wire/capabilities.rs) —— */

export type AgentLabel = { name?: string; source: "cmx" | "openclaw" | "hermes"; machine: string };
export type AgentStatus = "connecting" | "pairing" | "syncing" | "ready" | "down" | "refused";
export type Refused = "protocol" | "methods" | "auth" | "key";

export type Connection = {
  name: string;
  url: string;
  origin: "config" | "paired";
  /** when status last changed, ms; while ready, when it came up */
  since: number;
  lastError: string | null;
  connects: number;
  version: string | null;
  pinned: string | null;
  untested: boolean;
  protocol: number | null;
  refused: Refused | null;
  contract: number | null;
  contractMatches: boolean | null;
  /** cmx2 only (the admin capability); upstream/memory.rs */
  memory: { rss: number; liveSessions: number; uptimeS: number; sampledAt: number } | null;
};

export type Reasoning = { word: "effort" | "thinking"; levels: string[] };
export type Attachments = { kinds: string[]; maxBytes: number; maxCount: number };
export type Voice = { notes: boolean; replies: boolean };

export type Capabilities = {
  places: boolean;
  worktree: boolean;
  terminal: boolean;
  review: boolean;
  compact: boolean;
  queue: boolean;
  steer: boolean;
  model: boolean;
  reasoning: Reasoning | null;
  approvals: boolean;
  questions: boolean;
  attachments: Attachments | null;
  voice: Voice;
  quotes: boolean;
  reactions: boolean;
  threads: boolean;
  archive: boolean;
  commands: boolean;
  files: boolean;
  shell: boolean;
  history: boolean;
  subagents: boolean;
  spend: boolean;
  origins: boolean;
  admin: boolean;
};

export type RunItem = { thread: string; name?: string; at: number; preview: string };

export type Agent = {
  key: string;
  label: AgentLabel;
  kind: "coding" | "assistant" | "other";
  source: "cmx2" | "openclaw" | "hermes";
  mark: "square" | "round";
  /** a named slot (coral, lime, jade, lagoon, orchid); null: the agent's threads take their repo's palette */
  palette: string | null;
  status: AgentStatus;
  connection: Connection;
  capabilities: Capabilities;
  runs: { unseen: number; items: RunItem[] } | null;
};

/* —— the message (wire/message.rs, wire/send.rs) —— */

export type Origin = { kind: "channel"; name: string } | { kind: "scheduled"; name?: string };
export type Quote = { message: string | null; sender: string; preview: string | null; glyph: "text" | "audio" | "image" | "file"; durationMs?: number };
/** `by` is "you", "agent", or a person's label */
export type Reaction = { emoji: string; by: string };
export type SendState = { clientID: string; state: "checking" | "uncertain" | "cancelled"; at: number };

export type Message = {
  id: string;
  role: "user" | "assistant";
  created: number;
  completed?: number;
  clientID?: string;
  sender?: string;
  origin?: Origin;
  quote?: Quote;
  reactions?: Reaction[];
};

/* —— the parts (wire/part.rs) —— */

export type PartAt = { step: number; index: number };
export type MediaRef = { id: string | null; state: "ready" | "pending" | "missing" };
export type Flavour = "attached" | "voice" | "generated";

type PartBase = { id: string; messageID: string; at: PartAt | null };

export type FilePart = PartBase & { type: "file"; mime: string; filename: string; size?: number; media?: MediaRef; url?: string; flavour: Flavour };
export type ImagePart = PartBase & { type: "image"; mime: string; filename?: string; size?: number; media?: MediaRef; url?: string; width?: number; height?: number; alt?: string; flavour: Flavour };
export type AudioTranscript = { text: string; lang?: string };
export type AudioPart = PartBase & { type: "audio"; mime: string; media: MediaRef; durationMs?: number; waveform?: number[]; flavour: Flavour; spoken?: string; transcript?: AudioTranscript };
/** a kind this build does not know: the decoder keeps its `type` and the raw object (agents.md, a kind the client does not know) */
export type UnknownPart = PartBase & { type: "unknown"; kind: string; raw: Record<string, unknown> };

export type MediaPart = FilePart | ImagePart | AudioPart;
