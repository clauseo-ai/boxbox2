/* the telemetry dictionary.

   ONE source of truth, three consumers:
     1. producers — client + server emit through typed helpers derived
        from EVENTS, so a typo is a build error, not a silent hole.
     2. the database — telemetry/db.ts builds the sqlite table, the
        indexes, and a flat view PER EVENT KIND straight off this file.
        add an event here and the database learns its columns.
     3. agents — `bun scripts/telemetry.ts schema --json` dumps this
        whole file as data. nobody has to read prose to know what can be
        asked; the dictionary IS the api.
     4. the rust server — `bun scripts/telemetry.ts dictionary --json`
        writes telemetry/schema.json, the server's build generates its
        ingest from it, and a test fails when the two disagree.

   the point of this file is empirical iteration: boxbox's changes have
   come from bugs annoying the maintainer enough to report them. that only ever
   surfaces the loud problems. this surfaces the quiet ones.

   RULES for adding an event:
   - name it after INTENT, never after a component. `agent.prompt`, not
     `composer_submit_clicked`.
   - content NEVER lands here. lengths, counts, ids, and shapes do.
     prompt text, file contents, and titles stay out (a `chars` prop is
     fine, the chars are not).
   - if a prop is worth filtering or grouping by across kinds, promote it
     to the envelope instead of the props bag. */

export type ColumnType = "TEXT" | "INTEGER" | "REAL";

export type PropSpec = {
  type: ColumnType;
  doc: string;
  /** closed set — the generated view documents it and producers are
      typechecked against it */
  values?: readonly string[];
  /** absent = the producer may omit it */
  required?: true;
};

export type EventSpec = {
  doc: string;
  props: Readonly<Record<string, PropSpec>>;
};

/* ——— the envelope: real, indexed columns carried by EVERY row ———

   these are the dimensions worth slicing the whole log by. anything
   kind-specific lives in props and gets its own generated column in
   that kind's view. */

export const ENVELOPE = {
  id: {
    type: "TEXT",
    doc: "event id (nanoid). primary key — re-posting a batch after a flaky flush is idempotent, never a double count.",
  },
  at: {
    type: "INTEGER",
    doc: "ms since epoch, stamped by the PRODUCER. client clocks can skew; ingest keeps them honest by clamping absurd values (see db.ts).",
  },
  kind: { type: "TEXT", doc: "event kind — a key of EVENTS." },
  device: {
    type: "TEXT",
    doc: "stable per-device id from localStorage, or the literal 'server' for events the brain emits.",
  },
  device_class: {
    type: "TEXT",
    doc: "coarse device family: derived from the ua at registration, or claimed explicitly by a ua-less client (the board daemon): ipad | iphone | mac | android | desktop | board | server.",
  },
  surface: {
    type: "TEXT",
    doc: "which screen the event happened on: home | thread | compose | machines | settings | history | day | review | term | login. null for server events. term is the terminal pane wherever it is placed (visor, deck, room) — a need served while the visor is up still counts on its underlying surface, so term only stamps events the pane itself fires.",
  },
  host: { type: "TEXT", doc: "fleet machine id, the host name from boxbox.toml (e.g. desk, vm)." },
  session: {
    type: "TEXT",
    doc: "session key, `${host}:${sessionID}` — the same identity the client uses everywhere.",
  },
  repo: { type: "TEXT", doc: "repo id, `${host}:${tail}`." },
  ok: {
    type: "INTEGER",
    doc: "1 succeeded, 0 failed, null not applicable. every outcome-bearing event sets it, which makes failure rate a one-line query.",
  },
  ms: {
    type: "INTEGER",
    doc: "duration in ms where the event has one (verb round trip, surface paint, need latency). null otherwise.",
  },
  props: {
    type: "TEXT",
    doc: "json bag of the kind-specific props. never query this directly — use the generated per-kind view, which flattens it into real columns.",
  },
} as const satisfies Record<string, { type: ColumnType; doc: string }>;

/* ——— the events ——— */

export const EVENTS = {
  /* —— reach: where, when, on what, for how long —— */

  "app.open": {
    doc: "a client booted the store. the entry prop is the honest answer to 'what pulled him in' — a push tap is a very different session from a deliberate cold open.",
    props: {
      entry: {
        type: "TEXT",
        doc: "what brought him here",
        values: ["cold", "push", "resume", "reload"],
        required: true,
      },
      standalone: {
        type: "INTEGER",
        doc: "1 = installed pwa (home screen), 0 = browser tab. the ipad story depends on which of these he actually uses.",
      },
      ua: { type: "TEXT", doc: "raw user agent, kept once per open for device forensics." },
      viewport: { type: "TEXT", doc: "`${width}x${height}` css px at boot." },
      offlineSpool: {
        type: "INTEGER",
        doc: "events recovered from the localStorage spool at boot — nonzero means the last visit ended with an unflushed tail (backgrounded, killed, or offline).",
      },
    },
  },
  "app.visible": {
    doc: "the tab became visible. paired with app.hidden this is the ground truth for attention time, and it is what v_stints sessionizes.",
    props: {
      awayMs: { type: "INTEGER", doc: "how long it was hidden before this." },
    },
  },
  "app.hidden": {
    doc: "the tab went away (pocketed, app-switched, locked). the emitter flushes its queue on this transition via sendBeacon.",
    props: {
      visibleMs: { type: "INTEGER", doc: "how long it was visible before this." },
    },
  },
  "app.stream": {
    doc: "the multiplexed sse connection changed state. reconnect churn per device class is the quiet tax nobody has ever measured — ios backgrounding is the suspect.",
    props: {
      state: {
        type: "TEXT",
        doc: "connection transition",
        values: ["open", "error", "reopen"],
        required: true,
      },
      downMs: { type: "INTEGER", doc: "how long the stream was down before a reopen." },
      resumed: {
        type: "INTEGER",
        doc: "1 = the connection resumed from the device's cursor and the server replayed the gap, 0 = it started over from a reset and a snapshot. v2: every reconnect should be a 1.",
      },
      replayed: {
        type: "INTEGER",
        doc: "journal entries the server replayed from the cursor before the stream was live again. v2.",
      },
    },
  },

  /* —— surfaces: what he looks at, and how fast it shows up —— */

  "surface.view": {
    doc: "a screen was opened. the surface column carries which one. coverage across a month answers which surfaces are dead weight (see the kill list in docs/migration-v2.md) without guessing.",
    props: {
      from: { type: "TEXT", doc: "the surface he came from." },
      route: { type: "TEXT", doc: "the concrete path, e.g. /t/desk:ses_abc." },
    },
  },
  "surface.ready": {
    doc: "the surface painted something meaningful (transcript rows present, not a spinner). ms carries the wait. over tailscale on a tablet this is a real story.",
    props: {
      cached: { type: "INTEGER", doc: "1 = served from the client cache, 0 = waited on the wire." },
    },
  },

  /* —— perf: the budgets in docs/design.md (buttery, as numbers), one kind each. ok and ms are the
     measurement, taken from what really happened (the echo, the painted frame), never the local call —— */

  "perf.send": {
    doc: "a send from the composer, timed from the tap to the journal entry carrying its clientID: the daemon's echo, never the local call (for a shell line, whose output is its echo, the daemon's answer). ok = 1 when the echo arrived, 0 when the send failed or the echo never came within 30 s of live stream; ms is tap to echo, retries and time offline included. the budget is p90 under 400 ms.",
    props: {
      verb: {
        type: "TEXT",
        doc: "what was sent: a prompt that started a turn, one queued behind it, a steer, an answer to an ask, a `!` line, a `/` command, or the first prompt of a new thread",
        values: ["prompt", "queue", "steer", "reply", "shell", "command", "start"],
        required: true,
      },
      retries: { type: "INTEGER", doc: "how many times the same clientID was posted again after a timeout before the echo (a4: never a double)." },
      queued: { type: "INTEGER", doc: "1 = the daemon held it behind a running turn as a provisional message, 0 = it started a turn or went straight in." },
      chars: { type: "INTEGER", doc: "length of what was sent. never the text." },
      photos: { type: "INTEGER", doc: "photos on the message, clamped on the device." },
    },
  },
  "repo.icon": {
    doc: "the app asked the server for a repo's favicon, one row per read (docs/design.md, the repo mark; a repo is read again only when its last answer falls due). outcome is what the server said: an image, or why there is none (none, unsupported while the daemon has no file-read route, unproven while the host has not shown the root to be real, refused for the host user's home or a directory above it), or nothing usable (retry: dropped, timed out, a server error, the lookup not finished; unreadable: bytes that are not a drawable image). ms is the fetch and the read of the pixels; ok = 1 for an image, 0 for retry or unreadable, absent for a clean answer of no icon. no host or repo name travels. a long ms with retry is the daemon's file lookups queueing behind each other.",
    props: {
      outcome: {
        type: "TEXT",
        doc: "what came of the read",
        values: ["image", "none", "unsupported", "unproven", "refused", "retry", "unreadable"],
        required: true,
      },
      attempts: { type: "INTEGER", doc: "the repo's consecutive retries including this one, 0 when the read was not a retry." },
    },
  },
  "perf.board_view": {
    doc: "the server rebuilt the board's view (docs/board.md, cost) and sent it: one row a minute at most while a board stream listens, none without one. ms is the rebuild and encode, rounded; us the same in microseconds, since the budget is under 1 ms. no thread, host or machine name travels.",
    props: {
      us: { type: "INTEGER", doc: "the rebuild and encode, in microseconds." },
      bytes: { type: "INTEGER", doc: "the encoded view frame's size." },
      threads: { type: "INTEGER", doc: "threads riding the view, at most 36." },
    },
  },
  "perf.thread": {
    doc: "the thread's paints, an intent to the first frame that shows its result: a thread opening, a row opening, a stream event reaching a glyph. ms is intent to paint; ok = 1 when it painted inside its budget (a thread from cache in 300 ms, a row in one frame, an event in 150 ms).",
    props: {
      what: {
        type: "TEXT",
        doc: "which budget",
        values: ["thread", "row", "event"],
        required: true,
      },
      cached: { type: "INTEGER", doc: "1 = painted from the client cache, 0 = waited on the wire." },
      messages: { type: "INTEGER", doc: "messages in the thread when it painted (thread only)." },
    },
  },
  "perf.cache": {
    doc: "what the sync worker did with its indexeddb cache (docs/architecture.md, indexeddb layout), one row per event. boot: the launch read the meta, the fleet and every thread's head and the pages of the thread the url opens, nothing else; ms is that read, threads the cached threads known, messages the ones read. restore: a thread opened or held was read back from its pages before the wire was asked; ms is the read, ok = 0 when a page was missing and the thread starts over from the daemon. evict: a thread left the cache for the thread cap (40) or the byte cap (50 mb), held-only threads first; opened says the person had it open, and a 1 should be rare, and cap says which limit did it.",
    props: {
      what: {
        type: "TEXT",
        doc: "which event",
        values: ["boot", "restore", "evict"],
        required: true,
      },
      threads: { type: "INTEGER", doc: "boot: threads cached; restore and evict: 1." },
      messages: { type: "INTEGER", doc: "messages read from the cache (boot: those of the url's thread)." },
      bytes: { type: "INTEGER", doc: "the thread's size by the cap's estimate (the size of its json), for restore and evict." },
      opened: { type: "INTEGER", doc: "evict only: 1 = the person had opened the thread, 0 = it was held for another thread." },
      cap: {
        type: "TEXT",
        doc: "evict only: the limit that evicted it. opened = the person's 40 threads, held = a released place of the 16 for held threads, taken by a new hold, bytes = the 50 mb cap, unfit = a held thread's read (or its growth) that could not fit beside the thread on stage and the other leased threads, so nothing else was evicted for it.",
        values: ["opened", "held", "bytes", "unfit"],
      },
    },
  },

  "perf.sync": {
    doc: "what the sync worker's stream connection cost it, in counts and sizes, never content (docs/architecture.md, the sync worker). minute: one row a minute while the stream is up, and one for the part of a minute when it closes; ms is the window, and an idle fleet should cost little in it. overflow: a frame passed the parser's cap (32 mb of text, four times the largest the server forwards), so the connection was dropped and resumed from its cursor; a well-formed stream never sends one.",
    props: {
      what: { type: "TEXT", doc: "which row", values: ["minute", "overflow"], required: true },
      view: {
        type: "TEXT",
        doc: "minute: what the page showed when the row was written (docs/protocol.md, interest): home = no thread on stage, the overview only; thread = a thread on stage, with its words; hidden = hidden for 30 s, the overview only.",
        values: ["home", "thread", "hidden"],
      },
      frames: { type: "INTEGER", doc: "minute: sse frames received (journal, colour and board frames)." },
      received: { type: "INTEGER", doc: "minute: bytes read off the stream. overflow: the characters the parser held at the cap." },
      skipped: {
        type: "INTEGER",
        doc: "minute: journal seqs the stream skipped, from the ids it showed: the transcript entries of threads outside the page's interest, which protocol 3 never sends it. a home page skips most of the journal; a skipped seq is never a gap.",
      },
      posts: { type: "INTEGER", doc: "minute: patch messages posted to the ui thread (one a frame at most)." },
      patches: { type: "INTEGER", doc: "minute: patches in them, after coalescing." },
      posted: { type: "INTEGER", doc: "minute: about how many bytes those patches carried (strings by length, 8 a number)." },
      saves: { type: "INTEGER", doc: "minute: indexeddb saves committed (one in flight at most)." },
      puts: { type: "INTEGER", doc: "minute: indexeddb records those saves put." },
      stored: { type: "INTEGER", doc: "minute: about how many bytes those records held, by the same estimate as posted." },
    },
  },
  "sync.catchup": {
    doc: "how a stream connection of the sync worker opened (docs/protocol.md, catch-up), one row per connection that reached its catch-up's end. caught = the server caught the device's cursor up (overview changes, then each interest thread's transcript from its left) and said caught; reset = it could not (no cursor, another epoch, expired, invalid) and sent the whole fleet, and the threads on screen are read again. ms (in the envelope) is the dial to the caught or the reset applied.",
    props: {
      how: { type: "TEXT", doc: "how it ended", values: ["caught", "reset"], required: true },
      reason: { type: "TEXT", doc: "reset only: the reset's reason.", values: ["none", "epoch", "expired", "invalid"] },
      frames: { type: "INTEGER", doc: "frames after the hello up to and including the caught or the reset." },
      bytes: { type: "INTEGER", doc: "the characters of those frames' data, as they arrived (inflated)." },
      stale: { type: "INTEGER", doc: "thread.stale frames: interest threads whose missed entries the server no longer held, read before they are trusted." },
      resets: { type: "INTEGER", doc: "thread.reset frames: threads the server could not vouch for, whose messages were dropped and read again." },
    },
  },
  "sync.interest": {
    doc: "the server confirmed what the page shows (docs/protocol.md, the confirm), one row per confirm of the newest interest post: a thread opened, closed or held, or the page hidden for 30 s or shown again. ms (in the envelope) is the post to the confirm; the switch shows no gap whatever it is, and a long one is a slow stream.",
    props: {
      entering: { type: "INTEGER", doc: "threads that entered the interest at this confirm." },
      catchup: { type: "INTEGER", doc: "the characters of the catch-up frames that came ahead of the confirm (entering threads' transcripts from their left)." },
      stale: { type: "INTEGER", doc: "entering threads the server could not catch up, read instead." },
      reset: { type: "INTEGER", doc: "entering threads the server had reset since their left, dropped and read again." },
    },
  },
  "sync.fault": {
    doc: "a protocol 3 rule caught something on the device (docs/protocol.md, tests), one row per event. patch-error: a thread or order patch that did not fit what the device held, so nothing of it applied and the stream reconnected with a reset; catchup-error: a catch-up or confirm frame that did not parse, handled the same way; read-late: a thread read that started before the thread entered the interest, taken again; hash-miss: a settled part whose text the device did not hold exactly (textOf), so its message was read again. a well-behaved server and network cause none of the first two.",
    props: {
      what: { type: "TEXT", doc: "which rule", values: ["patch-error", "read-late", "hash-miss", "catchup-error"], required: true },
    },
  },
  "perf.media": {
    doc: "media paints and serves (docs/design.md, voice and media; docs/agents.md, media). card and viewer are the app's: an image card's image painted within 300 ms of entering the view, the viewer opened within its spring; ok = 1 inside the budget. serve is the server's: GET /api/media/{id} from the request to the answer's head (the index read, the file opened), one row per play or open (a whole file, a range from byte 0, or a refusal), never one per scrub; ok = 1 when the file was served (200, 206, 304), 0 for a refusal (400, 404, 410, 416, 503).",
    props: {
      what: {
        type: "TEXT",
        doc: "which paint or serve",
        values: ["card", "viewer", "serve"],
        required: true,
      },
      status: { type: "INTEGER", doc: "serve only: the http status answered." },
      bytes: { type: "INTEGER", doc: "serve: the bytes the answer carries (the range's length for a 206); card and viewer: the image's size." },
    },
  },
  "media.stored": {
    doc: "a file reached the media store, or was refused: one row per upload (POST /api/media) or agent copy (the ingest the sources call on first sight). ms is the whole take, the body streamed, hashed and committed; ok = 1 when the store holds the bytes (stored or duplicate). a run of busy uploads says four were in flight; full says nothing old enough was left to evict and [media] max_bytes wants raising.",
    props: {
      origin: { type: "TEXT", doc: "who brought the bytes", values: ["upload", "agent"], required: true },
      outcome: {
        type: "TEXT",
        doc: "stored: new bytes written. duplicate: the store held them already (an upload retried, a voice note read back from the agent). busy: four uploads (or eight copies) were running. too-large: past 64 MiB. empty: no bytes. refused-kind: a declared image, audio or video type the bytes contradict (uploads only). full: no room even after evicting everything allowed to go. source-failed: the body stopped arriving. failed: the disk or the store failed.",
        values: ["stored", "duplicate", "busy", "too-large", "empty", "refused-kind", "full", "source-failed", "failed"],
        required: true,
      },
      family: { type: "TEXT", doc: "the declared type's family, never the type or a name", values: ["image", "audio", "video", "document", "other"] },
      bytes: { type: "INTEGER", doc: "the file's size when it was read whole, else the length its sender announced; null when neither is known." },
    },
  },
  "media.evicted": {
    doc: "the media store dropped its least recently used files to make room for a new one (docs/agents.md, media, eviction): one row per eviction, which runs until the store, the new file included, is under 90% of the cap. pinned files and files under a day old never go. their ids answer 410 from then on.",
    props: {
      files: { type: "INTEGER", doc: "how many files went.", required: true },
      bytes: { type: "INTEGER", doc: "the bytes they freed.", required: true },
      total: { type: "INTEGER", doc: "the bytes the store holds after, the new file included." },
      cap: { type: "INTEGER", doc: "[media] max_bytes." },
    },
  },

  "perf.memo": {
    doc: "what the thread's memo caches held when a thread's stage closed (docs/thread.md, what is remembered): one row for each cache. the turns the stage built, the row models of settled turns, the sanitised html of settled markdown, and the heights of turns that were measured. bytes is what the cache alone keeps alive against its cap, hits and misses count its reads over its life, evicted the entries its cap pushed out.",
    props: {
      what: {
        type: "TEXT",
        doc: "which cache",
        values: ["turns", "ledgers", "html", "heights"],
        required: true,
      },
      entries: { type: "INTEGER", doc: "entries held." },
      bytes: { type: "INTEGER", doc: "what they cost, by the cache's estimate." },
      hits: { type: "INTEGER", doc: "reads that found their entry, since the app started." },
      misses: { type: "INTEGER", doc: "reads that did not." },
      evicted: { type: "INTEGER", doc: "entries the byte cap pushed out." },
    },
  },

  /* —— intent: every action a surface can fire ——

     emitted BY CONSTRUCTION from a proxy over the AppActions interface
     (v1's lib/store/model.ts). a new verb is instrumented the moment it joins
     the interface — there are no track() calls to forget. */

  verb: {
    doc: "one AppActions call: the complete record of what he asked boxbox to do. ok + ms come from the call's own outcome, so per-verb failure rate and latency need no extra instrumentation.",
    props: {
      name: {
        type: "TEXT",
        doc: "the AppActions method name, verbatim.",
        required: true,
      },
      arg: {
        type: "TEXT",
        doc: "the one argument worth keeping for this verb, per the redaction allowlist in instrument.ts (a reply choice, a machine id, a workspace mode), or the verb's own outcome where that is the story (flushQueued: fire | arm | ignore, the box box gate's decision). never free text.",
      },
      chars: { type: "INTEGER", doc: "length of any text argument. the text itself never travels." },
      files: { type: "INTEGER", doc: "attached file count where the verb takes files." },
      error: { type: "TEXT", doc: "failure message when ok = 0." },
    },
  },

  /* —— needs: the thesis metric ——

     boxbox exists to invert attention: the app says what needs him, he
     serves it from wherever he is. the number that matters is how long
     that takes, split by need kind and by device. raised is server-side
     truth; seen is the client admitting it rendered; served is a verb
     landing on that session. v_needs joins the three. */

  "need.raised": {
    doc: "a session started needing him. permission, question and fault are raised SERVER-side off the frames, so the clock does not depend on any client being awake. unread and review are client-derived (they need read state and checkout state), so the first client to see one raises it and the server dedupes by session+need until it clears — N open tabs still produce one raise.",
    props: {
      need: {
        type: "TEXT",
        doc: "which kind",
        values: ["permission", "question", "fault", "review", "unread", "done", "job"],
        required: true,
      },
      child: { type: "INTEGER", doc: "1 = a subagent raised it." },
      id: { type: "TEXT", doc: "v2: the need's id (`ask:<host>:<id>`, `done:<host>:<session>:<message>`), the join key to need.served and to the push notice of the same id." },
    },
  },
  "need.seen": {
    doc: "a need first rendered on a client's screen. raised → seen measures delivery (push, stream, his pocket); seen → served measures the ui. v_needs pairs a sighting to its raise by time and session, never by a shared stamp — the two sides are stamped by different clocks.",
    props: {
      need: { type: "TEXT", doc: "which kind", required: true },
    },
  },
  "need.cleared": {
    doc: "the need went away. by = him when a verb of his cleared it, agent when the loop moved on by itself, expired when it aged out unanswered. the agent/expired share is the honest count of needs boxbox raised and he never served.",
    props: {
      need: { type: "TEXT", doc: "which kind", required: true },
      by: {
        type: "TEXT",
        doc: "who cleared it. the SERVER always fills this — the need tracker owns the attribution because only it knows when the raise happened and whether serving evidence landed. a client emitting this kind is sending a signal, not a record: the route hands it to the tracker and never stores the client's row. auto: the auto-clear sweep took the thread off home and served its done and job needs (decision 93).",
        values: ["him", "agent", "expired", "auto"],
      },
      ageMs: { type: "INTEGER", doc: "how long it stood." },
    },
  },

  "need.served": {
    doc: "v2: a person served a need: answered it, looked at it, carried the thread on. the server writes it, from the fleet's own derivation (docs/architecture.md: computed once), with ms the time it stood since need.raised. needs that went away without a person are need.cleared with by = agent or expired. v2 raises done where v1 raised unread, and never raises one he watched settle.",
    props: {
      need: { type: "TEXT", doc: "which kind", values: ["permission", "question", "fault", "review", "done", "job"], required: true },
      by: { type: "TEXT", doc: "the device id that served it, or the daemon's name for another client that did." },
      how: { type: "TEXT", doc: "answered: an ask got its answer. seen: the thread was on stage on a looking device, or marked read. continued: a new turn started there.", values: ["answered", "seen", "continued", "settled"] },
      id: { type: "TEXT", doc: "the need's id, the join key to need.raised and push.acted." },
    },
  },

  /* —— the pocket: push as a funnel, not a fire-and-forget —— */

  "push.decided": {
    doc: "v2: the server judged a notice, the suppressed ones included, so a dead funnel shows in a day, not months later. one row per notice; the pushes it caused are push.sent rows with the same id.",
    props: {
      reason: {
        type: "TEXT",
        doc: "why it did or did not go out. sent: to at least one device. watched: a device was looking at the thread (visible and focused within 90 s). continued: a waiting done was dropped because the agent carried on. not-armed: a done for a turn nobody started. own-action, subagent, replayed: never pushed. no-subscriptions: no device is subscribed. kind-off: no device wants this kind. duplicate: every device already had this notice.",
        values: ["sent", "watched", "continued", "not-armed", "own-action", "subagent", "replayed", "no-subscriptions", "kind-off", "duplicate"],
        required: true,
      },
      need: { type: "TEXT", doc: "what it was about: question | permission | done | fault | ready." },
      tag: { type: "TEXT", doc: "the thread tag, `thread:${host}:${session}`: the join key to push.sent and push.tapped." },
      devices: { type: "INTEGER", doc: "how many devices it was queued for; 0 unless sent." },
      id: { type: "TEXT", doc: "the notice id (`ask:<id>`, `done:<message id>`), stable per event: the join key to push.sent, push.delivered and push.tapped." },
    },
  },
  "push.sent": {
    doc: "the server sent a web push. joined to push.tapped this is the delivery funnel: sent → tapped → acted, per need kind. v2 writes one row per device, with ok from the push service's answer (201), never from having tried, and ms the time to that answer across retries.",
    props: {
      need: { type: "TEXT", doc: "what it was about." },
      tag: { type: "TEXT", doc: "dedupe tag, the join key to a tap." },
      subs: { type: "INTEGER", doc: "how many subscriptions it fanned out to (v2: always 1, one row per device)." },
      target: { type: "TEXT", doc: "v2: the device id it was sent to, the same id that device stamps on its own rows." },
      status: { type: "INTEGER", doc: "v2: the push service's http status; null when it was never reached." },
      attempts: { type: "INTEGER", doc: "v2: posts made, retries included (at most 3)." },
      id: { type: "TEXT", doc: "v2: the notice id, the join key to push.decided and push.delivered." },
    },
  },
  "push.delivered": {
    doc: "v2: the device's service worker received the push and showed its notification, with or without the app open. sent → delivered is the push service's leg; delivered → tapped is the person's.",
    props: {
      need: { type: "TEXT", doc: "what it was about." },
      tag: { type: "TEXT", doc: "the thread tag." },
      id: { type: "TEXT", doc: "the notice id." },
      open: { type: "INTEGER", doc: "1 = an app window was open when it arrived (hidden or not), 0 = the app was closed." },
    },
  },
  "push.tapped": {
    doc: "a banner was tapped open. the gap to push.sent is how long the pocket took.",
    props: {
      tag: { type: "TEXT", doc: "the tag of the push that was tapped." },
      action: { type: "TEXT", doc: "v2: which part was tapped: answer | open (the action buttons chromium shows), or banner (the notification itself, the only choice on ios)." },
      need: { type: "TEXT", doc: "v2: what it was about." },
      id: { type: "TEXT", doc: "v2: the notice id." },
      open: { type: "INTEGER", doc: "v2: 1 = an existing app window was focused, 0 = the tap launched the app." },
    },
  },
  "push.acted": {
    doc: "v2: a need that was pushed was then served by a person, from any device. the last step of the funnel: decided → sent → delivered → tapped → acted. ms is the time from the push going out to the need served; the server writes it, joined by the notice id.",
    props: {
      need: { type: "TEXT", doc: "what it was about: question | permission | done | fault | ready." },
      tag: { type: "TEXT", doc: "the thread tag." },
      id: { type: "TEXT", doc: "the notice id." },
      by: { type: "TEXT", doc: "the device id that served it, or the daemon's name for another client." },
      how: { type: "TEXT", doc: "how it was served: answered | seen | continued | settled." },
    },
  },
  "push.replied": {
    doc: "he answered straight from the banner without opening the app — the fastest possible path, and worth knowing how often it actually works.",
    props: {
      /* NOT named `kind`: that collides with the envelope column of the
         same name in the generated view, and a bare `kind` reference
         would silently return the event kind. every other push event
         calls this `need` anyway. */
      need: { type: "TEXT", doc: "permission | question." },
      tag: { type: "TEXT", doc: "the tag of the push that was answered — the join key back to push.sent, same as a tap." },
      action: { type: "TEXT", doc: "the action id the banner fired." },
    },
  },

  /* —— friction: the empirical replacement for 'this annoyed me' ——

     every one of these is a proxy, not proof. the digest quotes the
     surrounding event sequence so the finding can be read, not trusted. */

  "friction.rage": {
    doc: "the same control fired three or more times inside a second, or fired and nothing changed. the app was not listening, or looked like it wasn't.",
    props: {
      control: { type: "TEXT", doc: "accessible name of the control.", required: true },
      taps: { type: "INTEGER", doc: "how many times." },
      inert: { type: "INTEGER", doc: "1 = no state change followed the tap at all." },
    },
  },
  "friction.deadend": {
    doc: "he opened a surface and bounced straight back out (<2s). either it was the wrong door or it had nothing for him.",
    props: {
      to: { type: "TEXT", doc: "the surface he bounced off." },
      backMs: { type: "INTEGER", doc: "how long he lasted." },
    },
  },
  "friction.abandon": {
    doc: "something was typed and thrown away. an abandoned compose is a thought boxbox failed to make cheap enough to finish.",
    props: {
      what: {
        type: "TEXT",
        doc: "what was abandoned",
        values: ["compose", "prompt", "rename"],
        required: true,
      },
      chars: { type: "INTEGER", doc: "how much had been typed." },
      files: { type: "INTEGER", doc: "attachments staged and dropped." },
      heldMs: { type: "INTEGER", doc: "how long it was open." },
    },
  },
  "friction.keyboard": {
    doc: "keyboard-adjacent viewport geometry worth a row. fix=release: webkit claimed a keyboard-sized overlap with nothing editable focused and KeyboardWatch forcibly released the shrunk shell (once per episode). fix=snapshot: the settled geometry vector after EVERY keyboard close — the affidavit that catches lies BELOW the overlap math (stale layout viewport, stale safe-area inset, compositor desync), filed because the 2026-07-25 stuck gap showed zero release rows while plainly visible. screenH is the device truth no viewport lie touches; compare everything against it.",
    props: {
      fix: {
        type: "TEXT",
        doc: "what this row is",
        values: ["release", "snapshot"],
        required: true,
      },
      overlap: { type: "INTEGER", doc: "clientHeight - visualViewport.height, css px." },
      offsetTop: { type: "INTEGER", doc: "visualViewport.offsetTop." },
      vvHeight: { type: "INTEGER", doc: "visualViewport.height." },
      clientHeight: { type: "INTEGER", doc: "documentElement.clientHeight — the layout viewport / what 100dvh keys off." },
      sabPx: { type: "INTEGER", doc: "measured px of --sab (env safe-area-inset-bottom, css-capped at 40px) via a probe element." },
      frameBottom: { type: "INTEGER", doc: "getBoundingClientRect().bottom of [data-bb-frame] — where the shell actually ends in viewport coords." },
      screenH: { type: "INTEGER", doc: "screen.height — device truth, immune to every viewport lie." },
    },
  },
  "error.client": {
    doc: "an unhandled rejection or a failed fetch on a client. tagged with the verb in flight so errors point at intent, not at a stack frame.",
    props: {
      message: { type: "TEXT", doc: "the error message, truncated.", required: true },
      verb: { type: "TEXT", doc: "the AppActions call in flight, if any." },
      status: { type: "INTEGER", doc: "http status where there was one." },
    },
  },

  /* —— the second axis: how he uses the AGENTS, not just boxbox ——

     agent.prompt is intent (what he asked for, with which powertrain);
     agent.bill is what it cost. they join on session in v_agent_runs, so
     'what does a fpl-ssa-agent turn on opus cost me from the couch' is
     one query. the spend ledger keeps 14 days and dollars only; this log
     keeps everything, forever, with the model and the tokens. */

  "agent.prompt": {
    doc: "he sent work to an agent. the powertrain is captured AS DRIVEN — the overrides that actually rode the wire, not the defaults.",
    props: {
      model: { type: "TEXT", doc: "modelID as sent." },
      provider: { type: "TEXT", doc: "providerID as sent." },
      agent: { type: "TEXT", doc: "agent type as sent (build, plan, a subagent name)." },
      variant: { type: "TEXT", doc: "reasoning variant as sent." },
      workspace: {
        type: "TEXT",
        doc: "where it runs",
        values: ["main", "fresh", "existing"],
      },
      fresh: { type: "INTEGER", doc: "1 = this prompt created the session." },
      chars: { type: "INTEGER", doc: "prompt length. the prompt itself never travels." },
      files: { type: "INTEGER", doc: "attachments." },
      queued: { type: "INTEGER", doc: "1 = the loop was busy and the serve queued it." },
    },
  },
  "agent.bill": {
    doc: "one settled assistant message, with its model and its bill. emitted server-side off the same frames the spend ledger counts, deduped by message id. ms carries the turn duration.",
    props: {
      model: { type: "TEXT", doc: "modelID that billed." },
      provider: { type: "TEXT", doc: "providerID that billed." },
      usd: { type: "REAL", doc: "cost of this message.", required: true },
      msg: { type: "TEXT", doc: "message id — the dedupe key." },
      tokensIn: { type: "INTEGER", doc: "input tokens." },
      tokensOut: { type: "INTEGER", doc: "output tokens." },
      tokensReasoning: { type: "INTEGER", doc: "reasoning tokens." },
      cacheRead: { type: "INTEGER", doc: "cache read tokens." },
      cacheWrite: { type: "INTEGER", doc: "cache write tokens." },
    },
  },

  /* —— read state: now that it syncs, its own behaviour is data —— */

  "read.mark": {
    doc: "a thread (or everything) was marked read, and on which device. the whole reason this exists: read state used to be device-local, so a fresh ipad showed a hundred phantom unreads.",
    props: {
      scope: {
        type: "TEXT",
        doc: "one thread or the lot",
        values: ["one", "all"],
        required: true,
      },
      source: {
        type: "TEXT",
        doc: "what marked it",
        values: ["thread", "row", "baseline", "sync", "watched", "clear"],
        required: true,
      },
      device: { type: "TEXT", doc: "v2: the device whose mark moved (the server writes read.mark; watched = on stage on a looking device)." },
      count: { type: "INTEGER", doc: "threads cleared when scope = all." },
      staleMs: {
        type: "INTEGER",
        doc: "how long the thread had been unread before he got to it.",
      },
    },
  },

  /* —— threads leaving and returning: home's clear, history, archive (v2) —— */

  "thread.cleared": {
    doc: "v2: threads were cleared off home, from one window or with 'clear done'. ok is 1 when every thread asked for was cleared; refused counts the ones that were not (still working, waiting on an answer, a subagent, not in the fleet). a cleared thread comes back on its own when it works, asks or is updated, and stays in history: the share that comes back inside a minute says whether people clear what they still want.",
    props: {
      source: { type: "TEXT", doc: "the control: window (one window's clear) or done (the bar's 'clear done').", values: ["window", "done"], required: true },
      count: { type: "INTEGER", doc: "threads cleared.", required: true },
      refused: { type: "INTEGER", doc: "threads asked for and not cleared." },
    },
  },
  "thread.uncleared": {
    doc: "v2: threads were brought back to home: the undo after a clear (from this device, or after the sweep cleared while he was looking) or 'bring back' in the away summary (decision 93). a thread brought back is kept from the sweep until it is updated. ok is 1 when every thread asked for came back; refused counts the ones that were not cleared (already back on their own, or not in the fleet). the share of auto-clears undone says whether the sweep's rule clears what people still want.",
    props: {
      source: { type: "TEXT", doc: "the control: undo (the toast or cmd-z) or away (the away summary's bring back).", values: ["undo", "away"], required: true },
      count: { type: "INTEGER", doc: "threads brought back.", required: true },
      refused: { type: "INTEGER", doc: "threads asked for and not brought back." },
    },
  },
  "home.swept": {
    doc: "v2: the server's auto-clear sweep cleared finished threads off home (decision 93). one row per sweep that cleared at least one; every sweep, clearing or not and under never too, logs one line (home swept: swept, cleared, left, mode, away, ms). ms is how long the sweep took on the fleet task.",
    props: {
      mode: { type: "TEXT", doc: "the person's rule: seen1h (an hour after a read mark covered the newest finished reply), or any3h (three hours after it settled). never clears nothing, so it writes no row.", values: ["seen1h", "any3h"], required: true },
      swept: { type: "INTEGER", doc: "home windows the sweep looked at (at most 300).", required: true },
      cleared: { type: "INTEGER", doc: "threads it cleared.", required: true },
      away: { type: "INTEGER", doc: "1: no device was looking (decision 23), so the clears joined the away summary. 0: a looking device was offered the undo." },
    },
  },
  "away.seen": {
    doc: "v2: a device acknowledged the away summary ('N cleared while you were away'), by opening show or dismissing the line (decision 94). its threads stay cleared and leave the summary on every device.",
    props: {
      count: { type: "INTEGER", doc: "rows the summary held when it was acknowledged.", required: true },
      class: { type: "TEXT", doc: "the device class that acknowledged it (iphone, mac, ...)." },
    },
  },
  "thread.archived": {
    doc: "v2: a thread was archived from its menu. ok is the daemon's answer (cmx2's PATCH with time.archived), never the tap: null when the daemon took the patch and did not answer in time, or answered past reading (it may be archived).",
    props: {},
  },
  "thread.renamed": {
    doc: "v2: a thread was renamed from its menu. ok is the daemon's answer (cmx2's PATCH with title), never the tap: null when the daemon took the patch and did not answer in time. the title is never recorded.",
    props: {},
  },
  "thread.forked": {
    doc: "v2: a thread was forked, from its menu (the whole thread) or from a turn (cut before the next turn's prompt), through the server's fork verb (cmx2's POST /session/:id/fork). ok is the agent's answer, never the tap: 1 for the new thread, 0 for a refusal or an agent not reached, null when the agent took the fork and its answer was lost (no answer in time, or one that could not be read: the fork may exist). cut says what it held, outcome how it went; no title, message or id is recorded.",
    props: {
      cut: { type: "TEXT", doc: "what the fork holds: the whole thread, or the thread through one turn.", values: ["whole", "turn"], required: true },
      outcome: { type: "TEXT", doc: "how it went: done, refused (the agent said no: a turn or thread gone, browse-only history, no fork), failed (the agent was not reached or was busy) or unknown (taken, answer lost).", values: ["done", "refused", "failed", "unknown"], required: true },
    },
  },
  "btw.asked": {
    doc: "v2: a side question was asked about a thread from the composer's btw mode (cmx2's POST /session/:id/btw, through the server). ok is the daemon's answer, never the tap. outcome: done (the daemon took it; the answer streams after), gone (no such thread), refused (the daemon said no, or the question was not one), unsupported (the agent or its daemon has no btw) or failed (the host did not answer). chars is the question's length; the question is never recorded.",
    props: {
      outcome: { type: "TEXT", doc: "how the ask went.", values: ["done", "gone", "refused", "unsupported", "failed"], required: true },
      chars: { type: "INTEGER", doc: "length of the question in characters.", required: true },
    },
  },
  "btw.dismissed": {
    doc: "v2: a btw card was dismissed, on every device (cmx2's POST /session/:id/btw/:btw/dismiss, through the server). ok is the daemon's answer, never the tap. outcome as btw.asked, gone meaning the btw no longer exists.",
    props: {
      outcome: { type: "TEXT", doc: "how the dismissal went.", values: ["done", "gone", "refused", "unsupported", "failed"], required: true },
    },
  },
  "btw.promoted": {
    doc: "v2: a btw's question and answer were added to its thread as a user message, a steer while a turn ran or a prompt otherwise (cmx2's POST /session/:id/btw/:btw/promote, through the server). ok is the daemon's answer, never the tap. outcome as btw.asked; refused is a btw still running or added already.",
    props: {
      outcome: { type: "TEXT", doc: "how the promotion went.", values: ["done", "gone", "refused", "unsupported", "failed"], required: true },
    },
  },
  "review.merged": {
    doc: "v2: a checkout's branch was squash-merged into its base from the review card (cmx2's /experimental/worktree/merge, through the server). ok is the daemon's answer, never the tap. outcome says how it went: done, busy (a turn runs in the checkout), conflict (the branch conflicts with its base), refused (dirty, nothing to merge, detached, or the base is dirty), gone (the checkout was merged or discarded already) or failed (the host did not answer). no path, message or file name is recorded.",
    props: {
      outcome: { type: "TEXT", doc: "how the merge went.", values: ["done", "busy", "conflict", "refused", "gone", "failed"], required: true },
    },
  },
  "review.discarded": {
    doc: "v2: a checkout and its branch were removed without merging, from the review card (cmx2's /experimental/worktree/discard, through the server). ok is the daemon's answer, never the tap. outcome says how it went: done, busy (a turn runs in the checkout), gone (the checkout was merged or discarded already) or failed.",
    props: {
      outcome: { type: "TEXT", doc: "how the discard went.", values: ["done", "busy", "gone", "failed"], required: true },
    },
  },
  "history.page": {
    doc: "v2: one page of history was read through the server (every host's threads, newest first, past home's 12 hours). rows is what came back, hosts how many machines were asked, unreached how many did not answer, chars the length of the search (never the text), ms the time to the merged answer. a search that scans a long way shows as ms.",
    props: {
      rows: { type: "INTEGER", doc: "threads in the page.", required: true },
      hosts: { type: "INTEGER", doc: "machines asked." },
      unreached: { type: "INTEGER", doc: "machines that did not answer." },
      chars: { type: "INTEGER", doc: "length of the search; 0 when there was none." },
      paged: { type: "INTEGER", doc: "1 when the page continued an earlier one (a 'before' cursor), 0 for the first." },
    },
  },

  /* —— the fold: context running out, and what it costs him —— */

  "fleet.compaction": {
    doc: "a session compacted on some host. the client learns it from the serve's session.compacted frame, so it counts folds it WATCHED — a fold that happened with no client awake is not in here. how often threads hit the wall, how much context the fold gives back, and how long he waits for it are all unmeasured today; auto vs manual says whether he ever gets ahead of it.",
    props: {
      trigger: {
        type: "TEXT",
        doc: "who called the stop: auto is the serve on its own threshold, manual is his compact verb.",
        values: ["auto", "manual"],
      },
      overflow: {
        type: "INTEGER",
        doc: "1 = the fold also stripped media to fit the byte cap.",
      },
      tokensBefore: {
        type: "INTEGER",
        doc: "context tokens the serve counted before folding.",
      },
      durationMs: { type: "INTEGER", doc: "how long the fold took." },
      summaryChars: {
        type: "INTEGER",
        doc: "length of the summary the fold wrote. the summary text never travels.",
      },
    },
  },

  /* —— perf: the budgets in docs/design.md, "buttery, as numbers" (v2) ——

     one kind per budget the client can see, emitted by the surface that
     paints (app/src/ui/home/perf.ts). ms is always the measured duration;
     the surface column says where. labels never carry content: a control
     is named by its kind from a closed set, never by its text. */

  "perf.launch": {
    doc: "a cold launch painted its first real screen. ms is from navigation start to the first frame that showed it. a page opened behind another, or hidden before it painted, reports none. target p50 300 ms, p90 700 ms from cache.",
    props: {
      cached: {
        type: "INTEGER",
        doc: "1 = the screen was painted from the device cache before the stream answered, 0 = it waited on the stream.",
        required: true,
      },
      windows: { type: "INTEGER", doc: "windows on that first screen." },
    },
  },
  "perf.paint": {
    doc: "tap to first frame of the response: ms from the input event to the end of the first frame that rendered what it opened (style, layout and paint done). target 1 frame.",
    props: {
      control: {
        type: "TEXT",
        doc: "what was tapped: a window, the capsule, back, a window's answer pill, or a row of the working fold's list (option was a window's own option button, which no longer exists)",
        values: ["window", "capsule", "back", "option", "answer", "fold"],
        required: true,
      },
      arrangement: { type: "TEXT", doc: "the layout at the time", values: ["deck", "strip", "rail"], required: true },
      frames: { type: "INTEGER", doc: "animation frames between the input and that paint; 1 is the budget." },
    },
  },
  "perf.input": {
    doc: "input to paint for one interaction, from the browser's event timing: ms from the input to the next paint after its handlers ran. the page's first input is always reported; after it, only interactions over 16 ms are.",
    props: {
      type: { type: "TEXT", doc: "the event type (pointerup, click, keydown)", required: true },
    },
  },
  "perf.shift": {
    doc: "layout shift over one visible stretch, reported when the page hides. the budget is 0.",
    props: {
      score: { type: "INTEGER", doc: "cumulative layout shift, in thousandths.", required: true },
      shifts: { type: "INTEGER", doc: "layout-shift entries not caused by recent input." },
    },
  },
  "perf.longtask": {
    doc: "a task on the ui thread over 50 ms. ms is its duration. the budget is none during streaming or scrolling.",
    props: {
      during: { type: "TEXT", doc: "what the ui was doing", values: ["streaming", "scrolling", "transition", "idle"], required: true },
    },
  },
  "perf.frames": {
    doc: "one transition's frames: ms is its measured duration. the budget is no dropped frame at 60 fps.",
    props: {
      transition: {
        type: "TEXT",
        doc: "which motion",
        values: ["grow", "shrink", "pour", "reorder", "capsule", "back", "agent", "agent-back"],
        required: true,
      },
      frames: { type: "INTEGER", doc: "frames painted during it.", required: true },
      dropped: { type: "INTEGER", doc: "frame gaps over 1.5 times the display's frame time.", required: true },
    },
  },

  /* —— terminals: the relay's own account (v2) ——

     the relay (server/src/pty) is the one place that sees a terminal's
     whole life: the browser's dial, cmx2's replay, every redial and every
     byte. so these rows come from the server, surface term, stamped with
     the device and class the pane named when it dialled. docs/terminal.md
     has the wire they describe. */

  "term.open": {
    doc: "a browser attached to a terminal through the relay. ok = 1 once cmx2's end-of-replay frame arrived (the pane is showing the terminal), 0 when the relay could not reach it; ms is the upgrade to that frame.",
    props: {
      resume: {
        type: "INTEGER",
        doc: "1 = the browser passed its cursor (it lost its socket and came back), 0 = an open that replays everything cmx2 retained.",
        required: true,
      },
      replayed: { type: "INTEGER", doc: "output cmx2 replayed before going live, in utf-16 units." },
      dropped: {
        type: "INTEGER",
        doc: "output between the cursor and the replay that cmx2 no longer held, in utf-16 units. nonzero means the pane reset and painted the tail.",
      },
      error: { type: "TEXT", doc: "why the relay could not reach the terminal when ok = 0, in plain words." },
    },
  },
  "term.reconnect": {
    doc: "the relay lost cmx2 and redialled it with its cursor, keeping the browser's socket open. ok = 1 once the redial's end-of-replay frame arrived; ms is from losing cmx2 to that frame.",
    props: {
      cause: {
        type: "TEXT",
        doc: "why the relay let go of cmx2: the connection dropped, it went 45 s without a byte, or live output found the queue to the browser full.",
        values: ["dropped", "stalled", "overflow"],
        required: true,
      },
      replayed: { type: "INTEGER", doc: "output the redial replayed, in utf-16 units." },
      dropped: {
        type: "INTEGER",
        doc: "output cmx2 no longer held by the time the relay came back, in utf-16 units.",
      },
      error: { type: "TEXT", doc: "why the redial failed when ok = 0, in plain words." },
    },
  },
  "term.bytes": {
    doc: "a relay's traffic, once, when it ends. ms is how long it lived. the pair with term.open says how terminals are used: opened and read, or typed into.",
    props: {
      down: { type: "INTEGER", doc: "output bytes sent to the browser, replays included.", required: true },
      up: { type: "INTEGER", doc: "input bytes the browser typed into the terminal.", required: true },
      redials: { type: "INTEGER", doc: "times the relay redialled cmx2 (term.reconnect rows)." },
      overflows: { type: "INTEGER", doc: "times live output found the 256 kb queue to the browser full." },
      end: {
        type: "TEXT",
        doc: "why the relay ended: the browser left, the shell exited, the host forgot the terminal, the host stopped answering, the browser went 45 s silent, it typed faster than the terminal read, the server stopped, or the host refused the credential.",
        values: ["closed", "exited", "gone", "unreachable", "stalled", "input-overflow", "shutdown", "refused"],
        required: true,
      },
    },
  },

  /* —— the board: instrument 001 (docs/scope-board.md §10) ——

     the desk instrument's daemon posts through the same POST
     /api/telemetry the browser uses, with deviceClass "board" and no ua.
     the rule that is easy to get wrong: board.key does NOT close a need.
     v_needs only joins the generic `verb` kind, so a keypress that
     serves a need emits TWO events — board.key for the board's own
     instrumentation, and a `verb` whose name is the exact SERVING_VERBS
     literal. a board-flavoured synonym never matches. */

  "board.connect": {
    doc: "the daemon attached to the board: HELLO round trip done, palette pushed, render loop starting. reconnect churn is the health signal — a recurring watchdog trip shows up here as reconnects climbing.",
    props: {
      fw: { type: "INTEGER", doc: "firmware version from the 0x81 HELLO reply.", required: true },
      proto: { type: "INTEGER", doc: "protocol version from the HELLO reply.", required: true },
      reconnects: {
        type: "INTEGER",
        doc: "reattach count for this daemon process before this one. 0 on first light.",
      },
    },
  },
  "board.key": {
    doc: "one physical keypress, as the daemon derived it. ok + ms ride the envelope from the resulting call's own outcome. this kind is invisible to v_needs by design — a press that serves a need emits a generic `verb` row alongside.",
    props: {
      wire: {
        type: "INTEGER",
        doc: "wire index 0-16, the daemon + /board sim ordering (never the led or matrix order).",
        required: true,
      },
      verb: {
        type: "TEXT",
        doc: "the derived verb, from the locked four-verb grammar",
        values: ["tap", "hold", "double", "chord"],
        required: true,
      },
      target: {
        type: "TEXT",
        doc: "what the key pointed at — a kind (seat, machine, need, mode, radio), never content.",
      },
      bank: {
        type: "TEXT",
        doc: "which bank the board was in",
        values: ["drive", "pit", "grid", "fleet", "calc"],
        required: true,
      },
    },
  },
  "board.bind": {
    doc: "a livery binding changed: an agent bound to a key, or cleared from one. rare and deliberate. bet 4 (bound keys beat the omni-switcher to a thread) is checked against these.",
    props: {
      wire: { type: "INTEGER", doc: "the key, as wire index.", required: true },
      agent: { type: "TEXT", doc: "the agent bound or cleared." },
      bound: { type: "INTEGER", doc: "1 = bound, 0 = cleared.", required: true },
    },
  },
  "perf.board": {
    doc: "what the board daemon costs on its mac (docs/board.md, budgets: a 4 mib physical footprint, 0.1% of a core plugged in and idle, nothing measurable with no board). hourly while a board is plugged in, plus one row at each plug covering the time the board was away, so the no-board cost is measured without a timer running while idle.",
    props: {
      footprintKib: { type: "INTEGER", doc: "physical footprint at the sample, kib (vmmap): the process's own memory, what activity monitor shows. the budget's figure." },
      rssKib: { type: "INTEGER", doc: "resident size at the sample, kib (ps rss). counts the shared CoreFoundation pages every IOKit client maps, so it reads about 5.4 mib above the process's own cost.", required: true },
      cpu: { type: "REAL", doc: "percent of one core used since the last sample.", required: true },
      spanMs: { type: "INTEGER", doc: "the wall time the cpu figure covers.", required: true },
      board: { type: "INTEGER", doc: "1 = the span had a board plugged in, 0 = the span ends at a plug.", required: true },
    },
  },
} as const satisfies Record<string, EventSpec>;

/* ——— derived types: producers are typechecked against the dictionary ——— */

export type EventKind = keyof typeof EVENTS;

type ValueOf<S> = S extends { values: readonly (infer V)[] }
  ? V
  : S extends { type: "TEXT" }
    ? string
    : number;

type RequiredKeys<P> = {
  [K in keyof P]: P[K] extends { required: true } ? K : never;
}[keyof P];

export type PropsOf<K extends EventKind> = {
  [P in RequiredKeys<(typeof EVENTS)[K]["props"]>]: ValueOf<
    (typeof EVENTS)[K]["props"][P]
  >;
} & {
  [P in Exclude<
    keyof (typeof EVENTS)[K]["props"],
    RequiredKeys<(typeof EVENTS)[K]["props"]>
  >]?: ValueOf<(typeof EVENTS)[K]["props"][P]>;
};

/** the envelope a producer may set. id and at are stamped by the emitter
    when omitted; device/device_class are stamped by the client emitter
    and forced to 'server' server-side. */
export type EventEnvelope = {
  id?: string;
  at?: number;
  surface?: string;
  host?: string;
  session?: string;
  repo?: string;
  ok?: boolean;
  ms?: number;
};

export type Emit = <K extends EventKind>(
  kind: K,
  props: PropsOf<K>,
  envelope?: EventEnvelope,
) => void;

/** the wire shape POSTed to /api/telemetry and appended to the jsonl */
export type WireEvent = {
  id: string;
  at: number;
  kind: EventKind;
  device: string;
  device_class: string;
  surface?: string;
  host?: string;
  session?: string;
  repo?: string;
  ok?: 0 | 1;
  ms?: number;
  props?: Record<string, string | number | undefined>;
};

export const DEVICE_CLASSES = [
  "ipad",
  "iphone",
  "mac",
  "android",
  "desktop",
  "board",
  "server",
  /* v2: verification drives (agent-browser, the bench) stamp this so no
     digest has to exclude them by hand again */
  "automation",
] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** the ua sniff, one place. crude on purpose — the question is "couch or
    desk", not a browser matrix. ipados lies about being a mac, so the
    touch-point check comes first. */
export function deviceClassOf(ua: string, maxTouchPoints = 0): DeviceClass {
  if (/iPad/i.test(ua)) return "ipad";
  if (/iPhone|iPod/i.test(ua)) return "iphone";
  if (/Macintosh/i.test(ua)) return maxTouchPoints > 1 ? "ipad" : "mac";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

/** the verbs that count as SERVING a need — used by v_needs to close the
    raised → served interval. reading is serving: an unread need is
    answered by looking at it. */
export const SERVING_VERBS = [
  "replyPermission",
  "answerQuestion",
  "markRead",
  "markAllRead",
  "dismissFault",
  "worktreeMerge",
  "worktreeDiscard",
  "reviewLater",
  "draftReply",
  "sendPrompt",
  "interrupt",
  "flushQueued",
] as const;

/** sessionizing gap: two events further apart than this on one device are
    two separate visits. five minutes is long enough to survive reading a
    diff, short enough that a pocketed phone ends the stint. */
export const STINT_GAP_MS = 5 * 60_000;
