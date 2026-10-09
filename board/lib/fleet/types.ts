/* cmx wire types — hand-written against LIVE captures (2026-07-19, harness
   serve, cmx 0.0.0-codemaxxxing-202607180201) plus the paid-for contract
   knowledge in GOTCHAS.md. the event union upstream is a ~130-way anyOf with
   no discriminator; we type only what boxbox filters on and carry the rest
   as raw. any new field gets verified against a live capture before its
   optionality is trusted. */

/* ——— envelope families ——— */

/** /global/event frame. server-level frames (server.connected) omit
    `directory` ENTIRELY — never require it. */
export type GlobalEventFrame = {
  directory?: string;
  project?: string;
  workspace?: string;
  payload?: EventPayload;
};

export type EventPayload = {
  id?: string;
  type?: string;
  properties?: Record<string, unknown>;
};

/** second envelope family riding the same stream — no `payload` key.
    any frame decoding keeps this branch first. */
export type SyncFrame = {
  type: "sync";
  name?: string;
  seq?: number;
  aggregateID?: string;
  data?: unknown;
};

export function isSyncFrame(frame: unknown): frame is SyncFrame {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { type?: unknown }).type === "sync"
  );
}

/* ——— event vocabulary (verified against cmx source 2026-07-18) ——— */

export const EventTypes = {
  serverConnected: "server.connected",
  serverHeartbeat: "server.heartbeat",
  instanceDisposed: "server.instance.disposed",
  permissionAsked: "permission.asked",
  permissionReplied: "permission.replied",
  questionAsked: "question.asked",
  questionReplied: "question.replied",
  questionRejected: "question.rejected",
  sessionStatus: "session.status",
  sessionIdle: "session.idle",
  sessionError: "session.error",
  sessionUpdated: "session.updated",
  sessionDeleted: "session.deleted",
  sessionDiff: "session.diff",
  sessionCompacted: "session.compacted",
  messageUpdated: "message.updated",
  messageRemoved: "message.removed",
  messagePartDelta: "message.part.delta",
  messagePartUpdated: "message.part.updated",
  messagePartRemoved: "message.part.removed",
  todoUpdated: "todo.updated",
  configUpdated: "config.updated",
  projectUpdated: "project.updated",
  worktreeReady: "worktree.ready",
  worktreeFailed: "worktree.failed",
  worktreeReviewRequested: "worktree.review.requested",
  ptyCreated: "pty.created",
  ptyUpdated: "pty.updated",
  ptyExited: "pty.exited",
  ptyDeleted: "pty.deleted",
  ptyPoolWarning: "pty.pool_warning",
} as const;

/* ——— worktrees (the checkout surface, cmx 2026-07-22) ———

   wire truth, pinned against the cmx source built this session:
   - GET /experimental/worktree → WorktreeInfo[] (was string[] before the
     graduation; `branch` is OPTIONAL on every surface — detached checkouts
     exist upstream and the decode must not assume it)
   - worktree.ready properties {name, branch?}; worktree.failed
     {message, log?} — ready now means ALIVE (populate + include copy +
     instance + start scripts), a failed start carries the log tail
   - GET /project?worktrees=true folds git-truth checkouts into each
     project row (the unified projects+worktrees index)
   - GET /experimental/worktree/diff?directory= → WorktreeDiff */

export type WorktreeInfo = {
  name?: string;
  directory: string;
  branch?: string;
  [key: string]: unknown;
};

export type WorktreeDiffFile = {
  path?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  [key: string]: unknown;
};

export type WorktreeDiff = {
  branch?: string;
  base?: string;
  baseRef?: string;
  commits?: number;
  dirty?: boolean;
  mergeable?: boolean;
  additions?: number;
  deletions?: number;
  files?: WorktreeDiffFile[];
  diff?: string;
  truncated?: boolean;
  [key: string]: unknown;
};

/* ——— ptys (the pocket terminal surface, cmx 2026-08-07) ———

   pinned field by field against a live harness capture (throwaway serve on
   127.0.0.1:4841, cmx 0.0.0-codemaxxxing-202608050521). Info is a closed
   struct upstream and every key below was observed on the wire, so nothing
   here carries a raw escape hatch — a new upstream field must fail the
   decode tests loudly rather than slip through as unknown.

   three things the route listing does NOT tell you, all capture-proven:
   - `args` comes back with the serve's own login flag PREPENDED: a create
     with args ["-c","sleep 5"] answers ["-l","-c","sleep 5"]. the round
     trip is never identity, so never diff a create body against Info.
   - `origin` is optional in the schema and only there. the serve defaults
     a missing origin to "tui" at create, so every captured frame carries
     one; a client still cannot require it.
   - status "exited" NEVER arrives on the bus. a model-origin pty that
     exits is retained in the pool with status flipped, and that flip
     fires pty.exited ONLY — no pty.updated, no pty.deleted. GET /pty is
     the only place the exited status is ever observed. */

export type PtyInfo = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited";
  pid: number;
  origin?: "tui" | "model";
};

export type PtyCreatedProperties = { info: PtyInfo };
export type PtyUpdatedProperties = { info: PtyInfo };
/** exitCode is non-negative and real: a shell that exits 3 reports 3, and
    an explicit DELETE reports the killed shell's own code, not a sentinel. */
export type PtyExitedProperties = { id: string; exitCode: number };
export type PtyDeletedProperties = { id: string };
/** cap is the hard pool ceiling (64), count the live total. the warning
    threshold is 60, so cap is NOT the number that fired this frame. */
export type PtyPoolWarningProperties = { count: number; cap: number };

/* ——— pending state ——— */

/** permission metadata is a bare object upstream; shapes vary per tool
    (bash asks carry `cmd`, NOT `command`; live capture 2026-07-19 shows
    `permission` class, `patterns` array, `always` options). only the live
    queue tells the truth — everything beyond id/sessionID is best-effort. */
export type PermissionInfo = {
  id: string;
  sessionID: string;
  title?: string;
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  time?: { created?: number };
  [key: string]: unknown;
};

export type QuestionOption = {
  label?: string;
  description?: string;
  [key: string]: unknown;
};

export type QuestionInfo = {
  id: string;
  sessionID: string;
  questions?: {
    question?: string;
    header?: string;
    options?: QuestionOption[];
    multiple?: boolean;
    custom?: boolean;
    [key: string]: unknown;
  }[];
  /** the asking tool call (live-verified 2026-07-20): anchors the card at
      its position in the transcript and names who asked */
  tool?: { messageID?: string; callID?: string };
  [key: string]: unknown;
};

/* ——— sessions ——— */

export type SessionInfo = {
  id: string;
  slug?: string;
  projectID?: string;
  directory?: string;
  path?: string;
  title?: string;
  agent?: string;
  version?: string;
  parentID?: string;
  summary?: { additions?: number; deletions?: number; files?: number };
  model?: { id?: string; providerID?: string; variant?: string };
  time?: { created?: number; updated?: number };
  share?: { url?: string };
  revert?: unknown;
  [key: string]: unknown;
};

/** GET /session/status → map sessionID → status object (shape loose) */
export type SessionStatusMap = Record<string, Record<string, unknown>>;

/** session.compacted properties. the FLEET rule, not a style preference:
    serves older than the enrichment emit `{sessionID}` and nothing else,
    so every field past sessionID is optional and every consumer handles
    absence. the numbers describe the fold that just happened — what the
    serve counted before it, how long it took, how big the summary came
    out, and which message the kept tail starts at. */
export type SessionCompactedProperties = {
  sessionID: string;
  /** the serve called it in on overflow vs his compact verb */
  trigger?: "auto" | "manual";
  /** media stripped to fit the byte cap (the wedge escape) */
  overflow?: boolean;
  /** context tokens the serve counted before the fold */
  tokensBefore?: number;
  durationMs?: number;
  summaryChars?: number;
  /** first message id of the tail the fold kept (`tail_start_id` on the
      compaction part that opened the stop) */
  tailStartID?: string;
};

/* ——— messages ——— */

export type TokenUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

export type MessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  mode?: string;
  agent?: string;
  variant?: string;
  /** assistant only: this turn IS the compaction summary (cmx summarize) */
  summary?: boolean;
  cost?: number;
  tokens?: TokenUsage;
  modelID?: string;
  providerID?: string;
  time?: { created?: number; completed?: number };
  error?: unknown;
  [key: string]: unknown;
};

/** parts are a wide union upstream; we keep type + the fields our surfaces
    read, raw carries the rest. wire strings arrive EMPTY, not nil — every
    display fallback goes through nonEmpty(). */
export type PartInfo = {
  id: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: Record<string, unknown>;
  time?: { start?: number; end?: number };
  [key: string]: unknown;
};

export type MessageWithParts = {
  info: MessageInfo;
  parts: PartInfo[];
};

/* ——— models / providers ——— */

export type ModelLimit = { context?: number; output?: number };

export type ProviderModel = {
  id: string;
  providerID?: string;
  name?: string;
  limit?: ModelLimit;
  cost?: Record<string, unknown>;
  status?: string;
  /** variant name → opaque provider options. only the KEYS matter to a
      client; absence/empty means the model has no ladder. */
  variants?: Record<string, unknown>;
  [key: string]: unknown;
};

/** GET /agent entry (Agent.Info). `mode` decides who cycles: primary/all
    up front, subagents behind the caret. hidden internals never surface. */
export type AgentInfo = {
  name: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  native?: boolean;
  [key: string]: unknown;
};

/* ——— helpers ——— */

export function nonEmpty(...candidates: (string | undefined | null)[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return undefined;
}

/** the tui ctx% formula (numerator parity pinned in GOTCHAS): input +
    output + reasoning + cache.read + cache.write, from the last SETTLED
    assistant message (time.completed set AND tokens.output > 0). */
export function usedTokens(usage: TokenUsage): number {
  return (
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.reasoning ?? 0) +
    (usage.cache?.read ?? 0) +
    (usage.cache?.write ?? 0)
  );
}

export function isSettledAssistant(info: MessageInfo): boolean {
  return (
    info.role === "assistant" &&
    info.time?.completed !== undefined &&
    (info.tokens?.output ?? 0) > 0
  );
}
