/* the view model every surface renders — one shape for the real fleet and
   the demo. the fleet store assembles these from cmx wire types; the demo
   fabricates them. components never see the wire. */

export type Machine = {
  id: string;
  name: string;
  address: string;
  version: string;
  online: boolean;
  costTodayUsd: number;
  /** the host's project index (real app): worktrees that exist there */
  projects?: { worktree: string; updated?: number }[];
  /** live checkouts on this host (worktrees under cmx's data dir): the
      machines card whispers the count so disk never surprises */
  checkouts?: number;
};

/** one row of the remote directory browser (GET /global/fs via the proxy) */
export type DirListing = {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; absolute: string; hidden: boolean }[];
};

export type Repo = {
  id: string;
  name: string;
  /** identity hue for the repo dot. identity, never state. */
  hue: string;
  /** a project the host knows but whose sessions aren't loaded yet.
      tapping a ghost opens it. */
  ghost?: boolean;
  /** ghost bookkeeping: where to open it */
  machineId?: string;
  worktree?: string;
  updatedAt?: number;
};

/** one live terminal on one machine, view-shaped off the pty wire Info.
    model-origin ptys (exec_command plumbing) never reach this — the pool
    boxbox renders is HIS terminals, not agent internals. */
export type PtyEntry = {
  id: string;
  machineId: string;
  title: string;
  command: string;
  cwd: string;
  status: "running" | "exited";
  pid: number;
};

/** a pinned command line on a host's card: origin state, device-shared */
export type TermPin = { cmd: string; addedAt: number };

/** where a terminal pane is placed; rides telemetry and aiming */
export type TermSurfaceKind = "visor" | "deck" | "room";

/** how a terminal came to be opened */
export type TermEntry = "door" | "summon" | "pin" | "row";

export type SessionState = "working" | "needsYou" | "idle" | "fault" | "preparing";

/** what exactly needs him. colors by meaning: permission=yellow,
    question=blue, unread=pink, fault=red, review=violet (a decision that
    LANDS work — the merge tap). */
export type NeedKind = "permission" | "question" | "unread" | "fault" | "review";

/** needs-you ranking: decisions first, then faults, then reviews (a branch
    waiting beats prose waiting), then unread replies. lives HERE, not at a
    react boundary: the board daemon is a plain bun process that ranks the
    same seats the app does, and a second copy of this table is drift. */
export const needRank: Record<NeedKind, number> = {
  permission: 0,
  question: 1,
  fault: 2,
  review: 3,
  unread: 4,
};

/** a session living in its own checkout (git worktree): phase tracks the
    cmx readiness contract — preparing until ready-means-alive, failed
    carries the start log tail. */
export type SessionCheckout = {
  directory: string;
  phase: "preparing" | "ready" | "failed";
  /** the parent repo's primary path: the strip folds this session under
      that repo's tile */
  projectPath?: string;
  message?: string;
  log?: string;
  /** declared review (2026-07-23): the agent fired request_review. the
      review NEED raises on this and only this — quiet telemetry otherwise.
      note is the card's headline. */
  requested?: { note?: string; at: number };
};

/** lane-grade review facts for a checkout holding unmerged work */
export type SessionReview = {
  branch?: string;
  base?: string;
  commits: number;
  additions: number;
  deletions: number;
  dirty: boolean;
  mergeable?: boolean;
  /** fetch stamp: the later-snooze keys on this */
  at: number;
};

/** the decision card's diff: per-file counts + the unified patch,
    view-shaped (the store maps the wire) */
export type CheckoutDiff = {
  branch?: string;
  base?: string;
  commits: number;
  dirty: boolean;
  mergeable?: boolean;
  additions: number;
  deletions: number;
  files: { path: string; status: string; additions: number; deletions: number }[];
  patch: string;
  truncated: boolean;
};

export type Session = {
  /** composite key: `${machineId}:${serverSessionID}` in the real app */
  id: string;
  title: string;
  /** true when the title was machine-generated and humanized: surfaces
      render these dim, they are placeholders, not names */
  autoTitle?: boolean;
  repoId: string;
  machineId: string;
  state: SessionState;
  need?: NeedKind;
  lastLine: string;
  lastLineVoice: "agent" | "command" | "you";
  updatedAt: number;
  /** 0 = unknown (thread not hydrated yet): surfaces hide the gauge */
  ctxPct: number;
  /** where the serve's own auto-compact fires, as a percent of context
      (lib/fleet/usage compactAtPct). absent when the model's limits are
      unknown — the gauge draws no tick rather than a guessed one. */
  compactAtPct?: number;
  costUsd: number;
  model: string;
  /** the provider that model rides under, when the wire said (session
      object or last assistant message). the driven-stint fallback needs
      the full identity to seed compose. */
  modelProvider?: string;
  agent: string;
  unread: boolean;
  /** server-reported working directory, verbatim (macos /private and all) */
  directory?: string;
  /** the pending permission, when need === "permission": home lanes answer
      inline without hydrating the thread */
  decision?: { id: string; command: string };
  /** the pending ask, when need === "question": simple asks answer inline
      from home, complex ones deep-link honestly */
  ask?: { id: string; questions: QuestionItem[] };
  /** when the current need started wanting him (pending item arrival for
      decisions, fault time for faults, last update for unreads). the
      strip draws this as geometry. */
  needSinceMs?: number;
  /** when the current run started. the brain's stamp (set at the busy
      transition server-side, healed to message truth on reconcile) so
      every device ticks the same clock; local first-sight only as a
      fallback. absent when idle. */
  busySinceMs?: number;
  /** active reasoning variant shown in the powertrain */
  variant?: string;
  /** a rewind is armed: messages at/after this point are parked. sending
      anything commits it (the server deletes them); unrevert restores. */
  revert?: { messageID: string };
  /** the published read-only link, when this session is shared */
  shareUrl?: string;
  /** a subagent's session: reachable through doors and blockers, never a
      lane on the quiet surfaces */
  child?: boolean;
  /** the parent thread's key, when this is a child: the way back up */
  parentKey?: string;
  /** the branch this session's checkout rides (mono tag on the row) */
  branch?: string;
  /** set when the session lives in its own checkout */
  checkout?: SessionCheckout;
  /** unmerged-work facts, when the checkout holds any */
  review?: SessionReview;
};

export type ToolState = "running" | "done" | "error";

/** one question inside an ask — the wire allows several per tool call */
export type QuestionItem = {
  text: string;
  header?: string;
  options: { label: string; description?: string }[];
  /** multi-select: toggles instead of radios */
  multiple?: boolean;
  /** typed answers allowed unless the ask says otherwise */
  custom?: boolean;
};

export type PartImage = { url: string; mime: string; filename?: string };

export type Part =
  | {
      kind: "user";
      id: string;
      text: string;
      /** owning message: revert/fork/unsend targets. for cache-built parts
          this equals id; live-overlay parts carry the wire part id. */
      messageID?: string;
      /** parked behind the running lap (server-side queue: the DB holds it,
          the loop picks it up when the current turn settles) */
      queued?: boolean;
      /** his own send, still crossing to the serve (no echo yet). not on
          the serve's queue yet, so a flush has nothing of it to run. */
      sending?: boolean;
      /** attached files that are images: data urls straight off the wire */
      images?: PartImage[];
    }
  | {
      kind: "reasoning";
      id: string;
      messageID?: string;
      text: string;
      seconds?: number;
      streaming?: boolean;
    }
  | {
      kind: "tool";
      id: string;
      messageID?: string;
      name: string;
      line: string;
      state: ToolState;
      output?: string;
      lang?: string;
      /** the full command/input when the display line is a summary */
      detail?: string;
      /** file tools: the path the tool touched (display + lang detection) */
      file?: string;
      /** edit/patch: unified diff, straight off metadata.diff */
      diff?: string;
      /** write/read: file content to draw as real code */
      code?: string;
      /** read: first line number of `code` (offset reads tell the truth) */
      startLine?: number;
      /** read: the truncation footer, kept honest under the code */
      note?: string;
      adds?: number;
      dels?: number;
      /** tool-state attachments that are images (screenshots, previews) */
      images?: PartImage[];
    }
  /* ——— the terminal is a session, not rows: write_stdin turns fold in ——— */
  | {
      kind: "terminal";
      id: string;
      messageID?: string;
      cmd: string;
      sessionId?: number;
      tty?: boolean;
      detach?: boolean;
      state: ToolState;
      exitCode?: number;
      seconds?: number;
      output?: string;
      /** screenshots the spawn itself produced (cmx attach-images) */
      images?: PartImage[];
      /** later write_stdin calls against this session, stitched in order */
      turns?: { chars: string; output?: string; seconds?: number; images?: PartImage[] }[];
    }
  /* ——— the pack ——— */
  | {
      kind: "spawn";
      id: string;
      messageID?: string;
      /** task_name — the driver tag */
      name: string;
      agentType?: string;
      brief?: string;
      forkTurns?: string;
      state: ToolState;
      /** pack identity off the settled output json */
      nickname?: string;
      /** child session id: metadata.child_session_id on new serves,
          /children title-match enrichment for parts older binaries wrote */
      childId?: string;
    }
  | {
      kind: "task";
      id: string;
      messageID?: string;
      description?: string;
      agentType?: string;
      prompt?: string;
      state: ToolState;
      result?: string;
      /** child session id parsed off metadata: the door */
      childId?: string;
    }
  | {
      kind: "radio";
      id: string;
      messageID?: string;
      /** outgoing: the target. incoming drains: absent */
      to?: string;
      /** incoming drains: the author path ("/root/bay_radio") */
      from?: string;
      body: string;
      /** followup_task = an assignment, send_message = fyi. incoming:
          the wire's trigger_turn — mail that woke a turn */
      assignment?: boolean;
      /** a lifecycle notice ("Agent … reached status: shutdown"): the
          status word; body keeps the agent's final words, often empty */
      noticeStatus?: string;
      state?: ToolState;
    }
  | {
      kind: "hold";
      id: string;
      messageID?: string;
      timeoutMs?: number;
      outcome?: "woke" | "timeout";
      state: ToolState;
    }
  | {
      kind: "roster";
      id: string;
      messageID?: string;
      agents: { path: string; status: string; last?: string }[];
      state: ToolState;
    }
  | { kind: "flag"; id: string; messageID?: string; path: string; state: ToolState }
  /* ——— web + meta + drivers ——— */
  | {
      kind: "webfetch";
      id: string;
      messageID?: string;
      url: string;
      kb?: number;
      state: ToolState;
      output?: string;
      /** wire request format; markdown (the default) earns the prose view */
      format?: string;
    }
  | {
      kind: "websearch";
      id: string;
      messageID?: string;
      query: string;
      state: ToolState;
      output?: string;
    }
  | { kind: "skill"; id: string; messageID?: string; name: string; state: ToolState }
  /* ——— the searchers: structured hits off cmx metadata ——— */
  | {
      kind: "grep";
      id: string;
      messageID?: string;
      pattern: string;
      include?: string;
      /** post-sort, post-cap rows (max 100), text trimmed of rg's newline */
      hits: { path: string; line: number; text: string }[];
      /** true total, may exceed hits.length when the serve capped */
      total: number;
      truncated?: boolean;
      state: ToolState;
    }
  | {
      kind: "glob";
      id: string;
      messageID?: string;
      pattern: string;
      files: string[];
      count: number;
      truncated?: boolean;
      state: ToolState;
    }
  | {
      kind: "driver";
      id: string;
      messageID?: string;
      /** mcp server prefix ("chrome-devtools" → "chrome") */
      ns: string;
      verb: string;
      line?: string;
      state: ToolState;
      output?: string;
      /** screenshot-taking verbs get the camera treatment */
      shot?: boolean;
      /** the pixels, when the serve attaches them */
      images?: PartImage[];
    }
  /* ——— the pit stop: compaction as a seam, never agent speech ——— */
  | {
      kind: "pit";
      id: string;
      messageID?: string;
      /** the serve called it in (auto on overflow) vs his compact verb */
      auto: boolean;
      /** media stripped to fit a byte cap (the wedge escape, GOTCHAS) */
      overflow?: boolean;
      state: ToolState;
      /** the anchored summary, once the summary turn wrote it */
      summary?: string;
      /** why it failed, when state === "error" */
      fault?: string;
      /** context tokens the gauge showed before the fold */
      before?: number;
      /** context after: the summary's own size until the next settled
          turn replaces it with truth */
      after?: number;
      /** true while `after` is the estimate, not the next turn's truth */
      afterEstimate?: boolean;
    }
  | { kind: "text"; id: string; messageID?: string; md: string; streaming?: boolean }
  | {
      kind: "permission";
      id: string;
      title: string;
      command: string;
      status: "pending" | "approved" | "always" | "rejected";
      /** no cache anchor: floats, seated against the overlay by the merge */
      unanchored?: boolean;
      /** the asking tool part's wire id, when the stream told us: the merge
          seats the floating card at this exact position (part ids are
          ordered ULIDs). absent = tail. */
      anchorPartID?: string;
    }
  | {
      kind: "question";
      id: string;
      /** every question in the ask, wire order */
      questions: QuestionItem[];
      status: "pending" | "answered" | "rejected";
      /** selected labels per question, wire order (settled or optimistic) */
      answers?: string[][];
      /** who asked, when the asking turn is known: model name for the chip */
      askedBy?: string;
      /** the asking tool call: dedupes the settled card against the wire */
      callID?: string;
      /** no cache anchor: floats, seated against the overlay by the merge */
      unanchored?: boolean;
      /** the asking tool part's wire id, when the stream told us: the merge
          seats the floating card at this exact position (part ids are
          ordered ULIDs). absent = tail. */
      anchorPartID?: string;
    }
  | {
      kind: "todos";
      id: string;
      items: {
        text: string;
        done: boolean;
        /** the step being worked right now: the strip breathes on it */
        active?: boolean;
        /** dropped deliberately: struck, never hidden (rank, never remove) */
        cancelled?: boolean;
      }[];
    }
  | { kind: "fault"; id: string; text: string };

/** attribution for one lap: rides the plate above every turn */
export type TurnMeta = {
  agent?: string;
  model?: string;
  variant?: string;
  seconds?: number;
  costUsd?: number;
  /** live laps tick their elapsed from this */
  startedAt?: number;
};

/** the stint grammar's unit: his calls and the agent's laps */
export type Turn =
  | { kind: "call"; id: string; parts: Part[] }
  | { kind: "lap"; id: string; meta: TurnMeta; live: boolean; parts: Part[] };

export type Thread = {
  sessionId: string;
  parts: Part[];
  /** lap attribution by assistant messageID: the view derives turns from
      parts + this map, so optimistic appends regroup for free */
  lapMeta?: Record<string, { meta: TurnMeta; live: boolean }>;
  /** real app: initial message fetch in flight */
  loading?: boolean;
  /** real app: rendered window is the tail; older laps exist upstream */
  partial?: boolean;
  /** real app: total messages fetched into the window so far */
  windowSize?: number;
};

export type ModelEntry = {
  providerID: string;
  modelID: string;
  name?: string;
  /** variant keys verbatim from the wire, ladder order. empty = no control. */
  variants: string[];
};

export type AgentEntry = {
  name: string;
  description?: string;
  /** primary/all cycle on the strat cell; subagents wait behind the caret */
  mode: "primary" | "subagent" | "all";
};

/** a file leaving this device: base64 data url, the only transport a web
    client has (no upload endpoint exists — it all rides the message). */
export type OutgoingFile = {
  id: string;
  mime: string;
  filename: string;
  url: string;
  size: number;
};

/** a draft parked at the composer: text + whatever was clipped to it */
export type Draft = { text: string; files: OutgoingFile[] };

/** a send that never made it: lives at the composer, not in the radio log —
    a delivery failure is yours, not a call from the agent */
export type SendFault = { text: string; files: OutgoingFile[]; at: number };

/** what box box did with a press: ran it, armed it behind an upload, or
    let a repeat press go (flushDecision in fleet.tsx owns the rule) */
export type FlushDecision = "fire" | "arm" | "ignore";

export type AppState = {
  machines: Machine[];
  repos: Repo[];
  sessions: Record<string, Session>;
  threads: Record<string, Thread>;
  /** drafts handed back to the composer (edit-a-queued-message flow) */
  drafts: Record<string, Draft>;
  /** failed sends, per session: the composer surfaces + restores them */
  sendFaults: Record<string, SendFault>;
  /** box box pressed while his own send was still uploading: the flush
      waits for it to land. value = when it was armed. */
  flushArmed: Record<string, number>;
  repoFilter: string | null;
  /** device-local, persisted: pinned repos lead the rail */
  pinnedRepos: string[];
  /** device-local, persisted: pinned models lead every model picker,
      keyed `providerID/modelID` (the same identity the wire rides) */
  pinnedModels: string[];
  composeOpen: boolean;
  /** a pre-decided compose target riding the open door; null = free pick */
  composePrefill: ComposePrefill | null;
  /** device-local, persisted: the last powertrain he drove */
  stint: Stint | null;
  /** real app: the multiplexed stream is up */
  connected: boolean;
  /** push subscription state for THIS device */
  pushEnabled: boolean;
  /** transient app-level notices (config reloads and kin) — the store
      expires them itself, surfaces just draw the stack */
  notices: { id: string; text: string; at: number }[];
  /** live checkouts across the fleet: compose's workspace line lists a
      repo's existing checkouts from here, machines cards count them */
  checkouts: MachineCheckout[];
  /** the brain's spend ledger, today's slice: settled assistant bills
      accumulated server-side once per message (the wire's session lists
      carry no cost — the $0.00 audit scar). null until the first fetch. */
  spend: { day: string; totalUsd: number; perHost: Record<string, number> } | null;
  /** board liveries, server-owned truth: wire index (stringified) → what
      that key holds. rows wear the dot, the machines screen draws the
      twin, the pairing ritual writes here. */
  boardBindings: Record<string, { agent: string | null; color?: string; at: number }>;
  /** the pairing ritual, this device's half: a session waiting for the
      next key press on the physical board. null = not pairing. */
  boardPinArm: { session: string; color: string; at: number } | null;
  /** the virtual twin's fuel: the last frame the daemon rendered, cells
      packed palette<<4|level, palette as hex per slot. null = no board
      talking (the twin shows a dark instrument). */
  boardFrame: { cells: number[]; palette: string[]; at: number } | null;
  /** the board's drive-bank seat map, keyed by session: the digit whose
      key the session sits on, and whether that key is on the page the
      board is showing. rows badge it so "which button do i press" reads
      off the glass. `at` governs staleness — a silent daemon's map
      expires instead of lying. null = no board has ever spoken. */
  boardSeats: {
    seats: Record<string, { digit: number; visible: boolean }>;
    page: number;
    pages: number;
    at: number;
  } | null;
  /** a driver asked the named thread's composer to take focus. latched,
      not fired: the composer almost always mounts AFTER the navigation
      that armed it, so an ear would land on nobody. the composer
      consumes it and clears. */
  composerArm: { session: string; at: number } | null;
  /** live tui-origin ptys per machine, sse-live + GET /pty reconcile.
      the pool every terminal surface renders. */
  ptys: Record<string, PtyEntry[]>;
  /** pinned lines per machine, origin-held (brain data dir), pushed on
      the multiplexed sse like read state */
  termPins: Record<string, TermPin[]>;
  /** terminal font size, device-local persisted (a− / a+, 11..16) */
  termFontPx: number;
  /** the visor: non-null = dropped. carries the aim; the pane resolves
      it against the pool. device-local, survives lift/summon by design
      (state lives here, not in the layer). */
  termVisor: { machineId?: string; ptyID?: string } | null;
};

/** one live checkout on one machine (a git worktree under cmx's data dir) */
export type MachineCheckout = {
  machineId: string;
  directory: string;
  /** the parent repo's primary path */
  projectPath?: string;
  name?: string;
  branch?: string;
  phase: "preparing" | "ready" | "failed";
};

export type CommandEntry = { name: string; description?: string };

/** powertrain + payload choices a new thread starts with */
export type ComposeOptions = {
  model?: ModelEntry | null;
  agent?: string | null;
  variant?: string | null;
  files?: OutgoingFile[];
  /** the workspace line: main (default) shares the checkout; fresh mints
      a git worktree; a path targets an existing one */
  workspace?: "main" | "fresh" | { directory: string };
};

/** the last powertrain he actually drove: written on every compose start
    and every in-thread powertrain change, device-local. the model rides
    as identity PLUS the ladder it shipped with — the live registry is
    truth at prefill time, the stored ladder only speaks when the registry
    is dark (outage), because the wire rides identity either way. a
    driven-stint fallback (derived off session rows) may lack the
    provider: modelID alone identifies it then. */
export type Stint = {
  agent?: string | null;
  model?: {
    providerID?: string;
    modelID: string;
    name?: string;
    variants?: string[];
  } | null;
  variant?: string | null;
};

/** a compose door opened with the target already decided (scope line,
    thread nav +, day sheet start rows): machine + path, locked with a
    "change" way out. `text` seeds the prompt field (the terminal's
    radio-it and explain-this ride it) — a seed, his to edit, never
    auto-sent. */
export type ComposePrefill = { machineId: string; path?: string; text?: string };

/** every action a surface can fire. both stores implement all of it; the
    demo's implementations fabricate, the fleet store talks to cmx. */
export interface AppActions {
  setRepoFilter(repo: string | null): void;
  /** pin/unpin a repo on this device; pinned repos lead the rail */
  togglePin(repoId: string): void;
  /** pin/unpin a model on this device; key is `providerID/modelID`.
      pinned models lead every picker at rest (never during a search —
      a pinned non-match at the top would be a dead row). */
  toggleModelPin(key: string): void;
  setComposeOpen(open: boolean, prefill?: ComposePrefill): void;
  markRead(sessionId: string): void;
  /** everything currently known is read, as of now. the escape valve:
      read state is server-owned and shared, but a device that has been
      away (or had its storage evicted) can still face a wall of lanes,
      and a hundred taps is not an answer. */
  markAllRead(): void;
  replyPermission(
    sessionId: string,
    partId: string,
    reply: "once" | "always" | "reject",
  ): void;
  /** full answers, wire order: selected labels per question. null = park. */
  answerQuestion(
    sessionId: string,
    partId: string,
    answers: string[][] | null,
  ): void;
  /** a fault banner was seen and judged; clears it from home. the thread
      keeps its history, this only retires the blocker. */
  dismissFault(sessionId: string): void;
  /* ——— the checkout review surface (worktrees) ——— */
  /** full diff for the decision card. undefined = unreachable/removed —
      the card keeps the lane facts it already has. */
  worktreeDiff(sessionId: string): Promise<CheckoutDiff | undefined>;
  /** merge the checkout's branch into the repo's default branch on its
      own machine. success removes the checkout; a conflict goes BACK to
      the agent with the rebase order (never his to resolve). */
  worktreeMerge(sessionId: string): Promise<boolean>;
  /** snapshot-then-remove: recoverable until git's gc forgets it */
  worktreeDiscard(sessionId: string): Promise<boolean>;
  /** snooze THIS review; new commits raise the lane again */
  reviewLater(sessionId: string): void;
  /** humanize visible auto-titled rows: fetch tiny tail windows so
      machine titles become what he asked. capped and deduped; no-op for
      titled or hydrated sessions. */
  enrichTitles(sessionIds: string[]): void;
  /** always sends. while the loop is busy the serve persists the message
      and picks it up when the lap settles — the DB is the queue. */
  sendPrompt(sessionId: string, text: string, files?: OutgoingFile[]): void;
  /** a failed send was seen; the composer took the draft back */
  dismissSendFault(sessionId: string): void;
  interrupt(sessionId: string): void;
  /** box box, box box: abort the lap AND run the queued orders now
      (abort + POST loop — the tui's ctrl+x enter). gated: arms while
      his send is still uploading, ignores a repeat press on the lap the
      last flush just started. resolves to what the gate decided. */
  flushQueued(sessionId: string): FlushDecision;
  /** take back an armed flush before the upload lands */
  disarmFlush(sessionId: string): void;
  /** pull a still-queued message back off the serve entirely */
  unsendQueued(sessionId: string, messageID: string): Promise<void> | void;
  /** unsend + hand the text back to the composer as a draft */
  editQueued(sessionId: string, messageID: string): Promise<void> | void;
  /** the composer consumed the handed-back draft */
  clearDraft(sessionId: string): void;
  /** hand the composer a seed to edit before sending (send-back and kin) */
  draftReply(sessionId: string, text: string): void;
  /** rewind the session to just before a message (files restored from
      snapshot). sending anything afterwards commits it. */
  revert(sessionId: string, messageID: string): Promise<void> | void;
  unrevert(sessionId: string): Promise<void> | void;
  /** clone history up to (exclusive) a message into a fresh session;
      resolves to the new session's key for navigation. no messageID =
      fork the whole thread. */
  fork(sessionId: string, messageID?: string): Promise<string>;
  /** publish the read-only share link; resolves to the url */
  shareSession(sessionId: string): Promise<string>;
  unshareSession(sessionId: string): Promise<void>;
  /** ai compaction in place (POST summarize with the thread's own
      powertrain); a loop verb, progress narrates over sse */
  compactSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** DELETE the session off its serve; irreversible, surfaces confirm */
  deleteSession(sessionId: string): Promise<void>;
  /** the `/` registry, one source for palette and deck. cached per machine.
      ref = session key or bare machine id. */
  commands(ref: string): Promise<CommandEntry[]>;
  /** the @ picker: fuzzy file paths from the instance at `directory`
      (GET find/file). relative paths, dirs end with `/`. `prove` widens
      an unproven directory through the deliberate open door once (403
      retry) — pass it only when the target is the session's own home or
      a known place, never for typed NEW paths. throws on refusal so the
      picker can say why. */
  findFiles(
    ref: string,
    query: string,
    opts: { directory: string; prove?: boolean },
  ): Promise<string[]>;
  createThread(
    machineId: string,
    repoId: string | null,
    path: string,
    prompt: string,
    options?: ComposeOptions,
  ): Promise<string> | string;
  /** prove a project's directory live and surface its whole history —
      no session created. compose's quiet sibling. */
  openProject(machineId: string, path: string): Promise<void>;
  /** list a directory on a machine (GET /global/fs). path omitted = home.
      throws with a human message; 404 = the serve predates the endpoint. */
  browseDirectory(machineId: string, path?: string): Promise<DirListing>;
  /** lazy thread hydration (the newest window); demo no-ops */
  ensureThread(sessionId: string): void;
  /** route-away: drop the assembled thread and trim its cache back to the
      window. reopening re-hydrates — memory is not a museum. */
  releaseThread(sessionId: string): void;
  /** pull the WHOLE history for a heavy thread, deliberately */
  loadFullThread(sessionId: string): void;
  /** the model registry across the fleet; cached. ref = session key or
      bare machine id. */
  models(ref: string): Promise<ModelEntry[]>;
  /** per-session model override, persisted on this device, rides every prompt */
  setModel(sessionId: string, model: ModelEntry | null): void;
  /** per-session reasoning variant override, rides every prompt */
  setVariant(sessionId: string, variant: string | null): void;
  /** the agent registry (GET /agent), cached per machine. ref = session
      key or bare machine id. */
  agents(ref: string): Promise<AgentEntry[]>;
  /** per-session agent override, rides every prompt as `agent` */
  setAgent(sessionId: string, agent: string | null): void;
  /** push opt-in for this device; demo no-ops */
  enablePush(): Promise<void>;
  /** machines screen: radio check + persist. throws with a human message. */
  addMachine(name: string, url: string, password?: string): Promise<void>;
  /** rescan skills/mcps/config on a machine, live; sessions untouched.
      resolves to the number of instances reloaded. */
  reloadMachine(machineId: string): Promise<number>;
  /** exit the serve so its supervisor relaunches it. in-flight turns on
      that machine abort; the machine badge tells the truth over sse. */
  restartMachine(machineId: string): Promise<void>;
  /** the pairing ritual, app half: arm the board so the NEXT key pressed
      on the physical instrument binds this session there. color is
      auto-picked (first free livery) unless given. resolves when the arm
      is accepted, not when the key is pressed — the bindings event is
      the confirmation. */
  pinToBoard(sessionId: string, color?: string): Promise<void>;
  /** clear a key's livery (writes a tombstone server-side) */
  unbindBoardKey(wire: number): Promise<void>;
  /** point the composer at a thread: the next mount of that thread's
      composer takes focus. the CALLER owns the device gate — the board
      drives the nearest awake display, never the phone in his pocket. */
  armComposer(sessionId: string): void;
  /** the composer took the focus (or the arm went stale) */
  clearComposerArm(): void;
  /* ——— the terminal (scope-term-ux) ——— */
  /** a terminal opened somewhere. visor summons set the visor state;
      deck/room placements manage their own mounting and call this for
      the record (instrumented by construction, like every verb). */
  openTerminal(
    surface: TermSurfaceKind,
    entry: TermEntry,
    target?: { machineId?: string; ptyID?: string },
  ): void;
  /** the visor lifts */
  closeTerminal(): void;
  /** POST /pty origin tui on the machine's default instance, cwd chosen
      by the caller (~ or a checkout). resolves to the entry, undefined
      when the host refused. */
  createShell(machineId: string, cwd?: string): Promise<PtyEntry | undefined>;
  /** DELETE /pty/:id — the shell dies now, every attached client sees it */
  killShell(machineId: string, ptyID: string): Promise<void>;
  /** line mode's enter: ships the line + \r as one frame through the
      live attachment. chars-only in telemetry, never text. */
  sendLine(machineId: string, ptyID: string, line: string): void;
  /** ⌃c to the foreground process (the most-needed verb while tailing) */
  interruptShell(machineId: string, ptyID: string): void;
  /** line/raw flipped (manual or auto): the record only, panes own mode */
  modeFlip(machineId: string, ptyID: string, mode: "line" | "raw"): void;
  /** a− / a+ — clamps 11..16, persists on this device */
  fontStep(delta: 1 | -1): void;
  /** save a line to the host's pins (origin state, sse-shared) */
  pinLine(machineId: string, cmd: string): Promise<void>;
  unpinLine(machineId: string, cmd: string): Promise<void>;
}

export interface AppStore extends AppActions {
  subscribe(fn: () => void): () => void;
  getSnapshot(): AppState;
  /** the board-focus driver's ear: a focus event from the physical board
      landed; the listener navigates. infrastructure, not intent — the
      instrument proxy passes it through unlogged. */
  onBoardFocus(listener: (session: string) => void): () => void;
  /** the board's other ear: a machines-row key asked for a fresh thread;
      the listener opens the compose sheet with the machine picked. same
      infrastructure law as onBoardFocus. */
  onBoardCompose(listener: (machineId: string) => void): () => void;
}
