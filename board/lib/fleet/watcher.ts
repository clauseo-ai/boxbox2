/* type-only extraction of v1's lib/fleet/watcher.ts (decision 14): the
   snapshot shapes the board daemon reads, verbatim from v1 except one
   scrubbed name (board/CHECKSUMS). the watcher itself is replaced by the
   rust server's upstream watcher. */

export type PendingItem = {
  host: string;
  directory: string | undefined;
  kind: "permission" | "question";
  id: string;
  sessionID: string;
  receivedAt: string;
  raw: unknown;
};

export type HostProject = {
  id: string;
  worktree: string;
  updated?: number;
};

export type CheckoutPhase = "preparing" | "ready" | "failed";

export type CheckoutReview = {
  branch?: string;
  base?: string;
  commits: number;
  additions: number;
  deletions: number;
  dirty: boolean;
  mergeable?: boolean;
  /** ms epoch of the fetch — recency, not identity */
  at: number;
};

export type CheckoutSnapshot = {
  directory: string;
  /** the parent project's primary checkout path — the strip folds
      checkout sessions under this repo's tile */
  projectPath?: string;
  name?: string;
  branch?: string;
  phase: CheckoutPhase;
  message?: string;
  log?: string;
  review?: CheckoutReview;
  /** declared review (2026-07-23): the agent fired request_review. the
      ONLY thing besides wreckage that raises the review need — the lane
      never infers "your move" from git state again. note becomes the
      review card's headline. brain-memory only: a brain restart loses the
      flag and the agent (or the owner) re-declares — honest v1 limitation. */
  requested?: { note?: string; at: number };
};

export type HostSnapshot = {
  id: string;
  name: string;
  url: string;
  reachable: boolean;
  pendingCount: number;
  lastError?: string;
  version?: string;
  /** instances proven live by their own frames: the safe list-widening
      set. querying these never spawns anything. */
  liveDirectories: string[];
  /** the host's full project index (GET /project): every project that
      exists, whether or not an instance is live. the rail's ghost chips. */
  projects: HostProject[];
  /** every live checkout on this host, phase + review facts included */
  checkouts: CheckoutSnapshot[];
};
