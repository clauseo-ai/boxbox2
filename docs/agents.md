# agents

boxbox stops being a client for cmx2 machines and becomes a client for
agents. cmx2 on a machine is one kind of agent. an openclaw personal
assistant and a hermes agent are others, each first class: their own
threads, voice notes both ways, images, files, generated media, quote
replies and reactions. this file is the contract the server, the web app
and the ios app build against. the owner's calls behind it are decisions
24 to 45 in `decisions.md`; the work is `m9 · agents` and `m10 · hermes`
in `plan.md`.

what this file does not cover: the openclaw connection, its sync
algorithm, its method allowlist, its test gateway and the field mapping
from its transcript are in `openclaw.md`. how the screens look is design
law in `design.md`, `home.md`, `thread.md` and `composer.md`.

## the words

| word | meaning |
|---|---|
| source | a kind of agent runtime boxbox speaks: `cmx2`, `openclaw`, `hermes` |
| connection | one entry in `boxbox.toml`: a cmx2 daemon, an openclaw gateway, a hermes gateway. one connection is one socket or event stream, one credential, one supervisor child |
| agent | someone you talk to. 1 to n per connection: a cmx2 daemon is one agent, an openclaw gateway has one agent per `agents.entries` row, a hermes gateway one per profile |
| agent key | the agent's name on the wire, `[a-z0-9-]{1,32}`, and the first half of every thread key |
| thread | one conversation with one agent, keyed `<agent>:<thread>` |
| neutral wire | boxbox's own shapes for everything that crosses to a client (section 1), once called contract 2. devices get them over protocol 3 (`protocol.md`), which replaced contract 1, the cmx2-shaped wire before it |
| capability | something an agent can do. clients render from capabilities, never from the source |
| media | bytes boxbox keeps for a part: an upload, or a copy of something an agent sent |

before m9 boxbox was cmx2-shaped at three depths: the watcher, the
reducer and the wire. `fleet::Upstream` carried `cmx2::Event`, the reducer
matched its variants, and contract 1 sent cmx2's session, status, message,
part and ask objects to clients byte for byte. the seam (section 4) took
out the first two; protocol 3 took out the third, raw passthrough
included (`protocol.md`, section 15). cmx2 threads behave as they did.

## 1. the neutral wire

the neutral wire (once called contract 2) is boxbox's own documented
shapes for everything that crosses to a client; protocol 3 carries them
to devices (`protocol.md`). no source object crosses raw. the one deliberate exception is
a tool call's `input` and `metadata`, which stay the source's json (below,
the part union), because the rich rows that read them are keyed by tool
name and have nothing neutral to read instead.

the shapes are rust types in `server/src/wire/` (one module per shape),
described with utoipa like every other boxbox type, so the web app's types
and the ios app's drift test both come from the one openapi document.
protocol 3's frames, patches and interest post are in
`server/src/wire/stream.rs` and `wire/patch.rs`; contract 1's types
(`fleet/change.rs`) are gone.

### the agent

```
Agent {
  key: string,                      // "vm-a", "vm-b-main"
  label: { name?: string, source: "cmx" | "openclaw" | "hermes", machine: string },
  kind: "coding" | "assistant" | "other",
  source: "cmx2" | "openclaw" | "hermes",
  mark: "square" | "round",
  palette: string | null,           // a named slot (section 8); null: threads take the repo palettes
  status: "connecting" | "pairing" | "syncing" | "ready" | "down" | "refused",
  connection: {
    name: string, url: string, origin: "config" | "paired",
    since: number,                  // when status last changed, ms; while ready, when it came up
    lastError: string | null,       // plain words; for pairing, the command to run on the machine
    connects: number,
    version: string | null,         // the runtime's own version
    pinned: string | null,          // the runtime version boxbox is built against (openclaw's pin)
    untested: boolean,              // version is not pinned: boxbox syncs and sends anyway
    protocol: number | null,        // the runtime's wire protocol; on a protocol refusal, the one it speaks
    refused: "protocol" | "methods" | "auth" | "key" | null,   // why, while status is refused
    contract: number | null,        // cmx2 only: the daemon's contract, and whether it matches the pin
    contractMatches: boolean | null,
    frames: FrameCounts,
    memory: Memory | null,          // cmx2 only (admin capability)
    system?: HostSystem,            // cmx2 only: os, machine, cpu load, memory, disk (architecture.md, the daemon verbs)
    reportsSystem?: boolean,        // false when the runtime has no system report; absent until asked
    cursor: string | null
  },
  capabilities: Capabilities,       // section 5
  runs: { unseen: number, items: RunItem[] } | null   // the runs window (section 7)
}
RunItem = { thread: string, name?: string, at: number, preview: string }
```

- `label.source` is the word people read (`cmx` for cmx2); `source` is
  the runtime's id. both enums are closed; a new runtime adds a value to
  each.
- `status`: `connecting` while dialling or backing off; `pairing` while the
  gateway waits for the device to be approved on its machine (`lastError`
  carries the command, `openclaw devices approve <requestId>`, and a client
  shows and copies it verbatim); `syncing` from connect until the first read
  of every thread with a window is in (threads show as they were, figures
  from the last read); `ready`; `down` after a failed attempt; `refused`
  when boxbox will not talk to it, with `refused` saying why and
  `lastError` in words: `protocol` (a wire protocol it was not built for;
  `protocol` holds the one the runtime speaks), `methods` (a sync method
  the runtime does not offer), `auth` (the runtime refused boxbox's
  credential; it is not retried until the config changes) and `key` (its
  agent key collides with a connection name, section 3). a refused agent's
  threads stay on screen as they were, marked stale, and no verb is sent.
- `untested` is true when `version` differs from `pinned` and the
  runtime's protocol is the one boxbox speaks: the connection syncs and
  sends as usual, and the agents screen says the version is untested
  (`openclaw.md`, the version policy, owns the words). cmx2 has no pin of
  its own beyond `contract`: `pinned` is null and `untested` false.
- the agents of one connection share its `connection` object. a change to
  the connection emits one `agent` change per agent on it whose state
  moved; an agent equal to the one last journaled is not sent again.

### the thread

the `Thread` replaced contract 1's `SessionEntry`, which carried cmx2's
raw `info` and `status`.

```
Thread {
  key: string, agent: string, id: string,
  title: string,
  created: number, updated: number,             // ms on the agent's clock
  said?: number,                                // ms of the last turn that wrote to you or asked
  generation?: string,                          // opaque; changes when the agent swaps the conversation
  parent?: string,                              // the parent thread's id (subagents capability): an agent it started
  forkedFrom?: { thread: string, message?: string },   // fork capability: the thread of the same agent it was forked from, and its first message the fork left out (absent: the whole thread)
  place?: { root: string, directory: string, name: string },   // places capability only
  origin?: Origin,                              // the thread lives on a channel, or is a scheduled run
  activity: { state: "idle" } | { state: "busy", since: number }
          | { state: "retry", attempt: number, message: string, next: number, since?: number }
          | { state: "parked", agents: number, jobs: number, since?: number }
          | { state: "failed", message: string, since?: number },
  queued: number,
  sends?: SendState[],                          // sends boxbox could not confirm (section 7)
  model?: string, effort?: string,              // what the thread runs with now
  context?: { used: number, limit: number, compactAt?: number },   // spend capability
  cost?: number,                                                    // spend capability
  tokens?: { input, output, cacheRead, cacheWrite },                // cmx2 today
  vcs?: { branch: string, dirty: boolean },
  changes?: { additions: number, deletions: number, files: number },
  browseOnly?: true,                            // imported history: read, never send
  agents: number, processes: number,            // as today
  tail: TailItem[], needs: Need[], read: ReadMark | null, cleared?: number   // as today
}
```

`agents`, `processes`, `tail`, `needs`, `read` and `cleared` are already
boxbox's own and keep their meaning. `TailItem.kind` adds `image` and
`audio` to contract 1's text, reasoning, tool and file; the model builds a
tail once from neutral parts (`fleet/model.rs`, `TailItem`, mapped to
`wire::TailItem`), and protocol 3 sends a changed tail as a
`thread.patch` tail op (`protocol.md`, section 6).

- **`said`** is when a turn last wrote text for you or raised an ask. a
  source whose agent runs on its own (openclaw, hermes: scheduled runs,
  heartbeats) sets it; cmx2 never does, because every cmx2 turn is one
  someone started. when `said` is present, the membership and cleared
  window rules (`design.md`, home) read it in place of `updated`, so a run
  that ends having said nothing moves `updated` and wakes nothing.
- **`failed`** means the agent's last run ended in an error the agent
  reports on the thread (openclaw's `lastRunError`, `openclaw.md`); it holds
  until the next run starts. cmx2 reports errors on messages and never sends
  it. a cmx2 `retry` comes from the raw status: the model folds retry into
  busy for ranking and turns, and that fold stays; only the wire's
  `activity` shows `retry`.
- **`generation`** is an opaque string that changes when the agent swaps
  the conversation behind the key (openclaw: a rewind or branch switch, a
  hash of its session id). the client sends back the one it last saw on
  every send (section 7). openclaw's `/new` keeps the session id, so a
  generation does not catch a message composed before a `/new`. cmx2 has
  none.

### the message

```
Message {
  id: string, role: "user" | "assistant",
  created: number, completed?: number,
  position?: number,                 // its place in the thread's transcript, from the agent
  clientID?: string,                 // on a user message boxbox sent: the send's client id
  queued?: true, steer?: true,       // queue and steer capabilities
  finish?: string,                   // why the turn ended ("aborted", ...)
  error?: { message: string },
  model?: string, effort?: string,   // what this message ran with or asked for
  cost?: number,
  sender?: string,                   // a user message from someone who is not you (a group chat)
  origin?: Origin,
  quote?: Quote,
  reactions?: Reaction[]
}
Origin   = { kind: "channel", name: string } | { kind: "scheduled", name?: string }
Quote    = { message: string | null, sender: string, preview: string | null,
             glyph: "text" | "audio" | "image" | "file", durationMs?: number }
Reaction = { emoji: string, by: "you" | "agent" | string }
SendState = { clientID: string, state: "checking" | "uncertain" | "cancelled", at: number }
```

- **position.** the agent's order for the message in its transcript
  (openclaw: the row's `messageSeq`). a source can deliver a row after a
  later one (openclaw skips a live event and the row comes by a later read,
  `openclaw.md`), so a client places a message by `position` when it has
  one and by arrival otherwise. cmx2 sends none: its journal order is its
  transcript order, as today.
- **origin.** absent means boxbox or the agent's own runtime (every cmx2
  message). `channel` names where a turn came from or went to: `whatsapp`,
  `telegram`, `control-ui` (another operator client of the same gateway).
  `scheduled` is a timer or cron run, with its job's name when the source
  says (a heartbeat's name is `heartbeat`). the thread draws it as the
  "via whatsapp" time line.
- **quote.** `message` is the boxbox id of the quoted message, null when
  the source cannot resolve it (a quote made inside whatsapp of one of the
  agent's own replies, `openclaw.md`). `sender` is "you", the agent's
  name, or a person's label. `preview` is one line, at most 140
  characters, cut at a word, with no markup; null when the source kept
  none. `glyph` is the kind of the quoted message's first part that is not
  text, else `text`. `durationMs` is the quoted voice note's length when
  the glyph is `audio` and the source knows it. a quote with `message:
  null` still renders: "replied to a message on whatsapp" with the preview
  when there is one (a source sends `preview: null` rather than words of
  its own for that case).
- **reactions.** the whole current list, one entry per emoji and actor.
  `you` is the person (any of their surfaces), `agent` the agent of this
  thread, any other string a person's label. a reaction change sends the
  list again whole (`reactions` below), never a diff.

### the part union

discriminated on `type`, as cmx2's is, so the cmx2 mapping is near
identity. every part carries `id`, `messageID` and `at`:

- `at` is the part's place in its message, `{step, index}`, or null. the
  server derives it once: for cmx2 from the part id grammar
  `prt_<session>_<seq>_<index>` (today in the clients, `app/src/sync/order.ts:20-30`),
  for another source from the block's position in the message (`step` 0).
  a client places a part by `at` and keeps arrival order for a null, which
  is today's rule (`architecture.md`, transcripts) moved to the server.

| `type` | fields | what a client draws |
|---|---|---|
| `text` | `text`, `streaming?`, `time?`, `synthetic?`, `notice?`, `mail? {kind, from?, fromID?}` | prose. `synthetic` is context the runtime added (never shown as typed). `notice` is a runtime or boxbox note (an ask cancelled by a gateway restart, a media copy that failed). `mail` is another agent's brief, report or note |
| `reasoning` | `text`, `streaming?`, `time?` | the thinking fold |
| `tool` | `callID`, `tool` (its name), `family`, `state {status: pending \| running \| completed \| error, input, output?, title?, error?, metadata?, time?, attachments?, attachmentsDropped?}` | a step. `family` is the server's: `read`, `search`, `edit`, `shell`, `web`, `spawn`, `message`, `wait`, `agents`, `ask`, `plan`, `skill`, `other` (today's table, `app/src/ui/thread/model.ts:126-162`, moved to the server; another source maps its own tool names). rich rows read `input` and `metadata` only when `family` names the shape they know and the agent's `source` is the one that wrote it; anything else is the generic row |
| `file` | `mime`, `filename`, `size?`, `media?`, `url?`, `flavour` | a file card: name, size, kind; tap opens it |
| `image` | `mime`, `filename?`, `size?`, `media?`, `url?`, `width?`, `height?`, `alt?`, `flavour` | the picture, from `media` through the media route or from a `data:` url |
| `audio` | `mime`, `media`, `durationMs?`, `waveform?`, `flavour`, `spoken?`, `transcript? {text, lang?}` | a voice note row or an audio card |
| `compaction` | `auto`, `overflow?` | the compaction divider |
| `marker` | `marker` (`step-start`, `step-finish`, `patch`, `subtask`, `reset`), `cost?` | nothing. kept so order and accounting survive (`reset` is where the agent cleared its context, openclaw's `/new`) |

- **media.** `media` is `{id: string | null, state: "ready" | "pending" | "missing"}`.
  `id` is the store's (section 6), and null while `pending`, because the
  hash is known only once the bytes are in. `pending` while boxbox is still
  copying an agent's bytes (the part is sent again `ready` when the copy
  lands);
  `missing` when the agent no longer had them, or they were past a cap,
  with a `notice` text part saying which. a part has `media` or a `data:`
  `url`, never neither; only cmx2 parts carry a `url` (section 6, why).
- **flavour.** `attached` (someone sent it), `voice` (a voice note: yours,
  or the agent's spoken reply), `generated` (the agent's tools made it: an
  image, music, a document). a video is a `file` with a `video/*` mime.
- **spoken** is the text the agent's reply said aloud, on its audio part
  (openclaw keeps it beside the speech, `openclaw.md`). the row's "what it
  said" fold shows it.
- **transcript** is the transcript your device made of your own voice
  note, sent with the send and kept by boxbox as a sidecar, because openclaw does
  not store one (section 6, sidecars). it is attached to every audio part
  whose `media.id` matches, in every read and every change.
- **waveform** is at most 64 values from 0 to 255, the loudness of equal
  slices of the clip. present on your own voice notes (your device sends
  it with the upload); absent on an agent's audio, where the client that
  plays it draws the waveform from the bytes it already has and keeps it
  beside its cached copy.
- **a kind the client does not know** (a newer server, a source that adds
  one) is a plain fallback row in the turn: one line in the muted text
  style naming the kind and saying to update the app, plus the part's
  `text` field when it has one. never a crash, never a blank, never a
  dropped turn. the fold counts it like today's `unknownParts`
  (`model.ts:108-109,521`). decoders keep unknown kinds as an `unknown`
  case carrying the raw object (ios: the `unknown(String)` pattern its
  enums already use).

### asks

```
Ask {
  key: string, agent: string, id: string, thread: string,   // thread is the key
  kind: "permission" | "question",
  created?: number, expires?: number,
  tool?: { messageID: string, callID: string },
  permission?: { title: string, patterns: string[], always: string[],
                 options: { id: "once" | "always" | "reject", label: string, lasting?: true }[],
                 risk?: "normal" | "high", warning?: string, detail?: string, scope?: string[] },
  questions?: { question: string, header: string, multiple: boolean, custom: boolean,
                options: { label: string, description?: string }[] }[]
}
AskSettled = { agent: string, id: string,
               outcome: "answered" | "expired" | "cancelled" | "unknown",
               option?: string,          // the option id or answer that won, when answered
               reason?: string,          // plain words, for cancelled and unknown
               by?: { kind: "device" | "channel" | "runtime" | "system",
                      name?: string,     // "whatsapp", a device's name
                      device?: string }, // the boxbox device id, when the answer went through boxbox
               at: number }
```

- **options** carry the server's `label`, which a client draws as is.
  `lasting` marks an answer that leaves a standing grant (cmx2's `always`,
  openclaw's allow always), so the card can say it lasts. no source
  produces a per-session option, so there is none.
- **risk, warning, detail, scope** are what the agent says about the
  blast radius of a permission (openclaw's severity, warning text, detail
  and the recipients, payment, visibility or grant it reaches,
  `openclaw.md`). `risk` is the source's severity mapped to two values;
  `scope` is plain lines. cmx2 sends none of them.
- **settled.** `outcome` says how the ask ended: `answered` (with the
  `option` that won and who answered, `by`), `expired` (the agent's
  deadline passed), `cancelled` (the run ended or the runtime restarted,
  `reason` in words), or `unknown` (boxbox lost track of it and the agent
  no longer knows it). `by.kind` is `device` for an operator surface (a
  boxbox device, with `device`; another operator client by `name`),
  `channel` for a channel reply (`name: "whatsapp"`), `runtime` for the
  agent's own policy, `system` for expiry, no route, a restart or an
  abort. a client says "on this device", "on your other device" or "on
  whatsapp" from it. cmx2 settles map to `answered` (the mapping table
  below).

an answer is by option id or by answers, the same body for every source:
`POST /api/agents/{agent}/asks/{id}` with `{device, deviceClass, clientID,
option}` or `{..., answers: string[][]}`, or `{..., reject: true}` for a
question. the source turns it into its own call. `expires` drives the
"answer by" line and the client blocks an answer in its last 5 seconds
(openclaw questions expire, `openclaw.md`). a second boxbox device's
answer to an ask boxbox already answered is not sent to the agent; it
gets the settle with `by.device` naming the first device.

### needs

already neutral (`fleet/needs.rs`: permission, question, fault, review,
job, done) and unchanged. the source events in section 4 feed them:
`AskRaised` raises permission or question, `Fault` raises fault, `Notice`
raises review and job (sources with the review capability and background
jobs: cmx2 today), and a turn's end raises done. push copy says
`"<place name> wants you"` for a thread with a place and `"<agent name>
wants you"` without one, where the agent name is `label.name`, else
`"<source> · <machine>"` (today: `model.rs:2525,2608-2612`).

### the stream

devices get these shapes over protocol 3: `GET /api/stream`, whose
frames, entries, interest, patches and catch-up `protocol.md` specifies
(sections 2 to 9). the journal entries are `agent`, `agent.removed`,
`thread` (whole), `thread.patch`, `thread.removed`, `thread.reset`,
`ask`, `ask.settled`, `order`, `order.patch`, `message`, `part`, `delta`,
`message.removed` and `reactions`; the control frames are `hello`
(`protocol: 3` and the stream's id), `reset` (`fleet: {agents, threads,
asks, order}`), `caught`, `catchup`, `interest`, `thread.stale` and the
repo colours. contract 1's `host.reset` and `session.*` changes are gone:
a host read is a quiet re-read that journals what moved and a
`thread.reset` for every thread it held (`protocol.md`, section 10).
`upstream` keeps its meaning: the source's seq for the event when it has
one, so a client applies it only past the read it lands on; null when the
source does not number it, which makes it newer than any read. deltas
keep the utf-16 `offset` rule: a source that does not stream sends whole
parts only. a source's live
preview (text the gateway streams before the row is committed,
`openclaw.md`) is a part of a provisional message whose id the source
mints, so its deltas have a part to land on; clients get live text only
this way. when the committed row arrives the source sends
`message.removed` for the provisional one and the real message after it,
in that order, in one journal append.

`thread.reset {key}` says boxbox could not prove that every row of the
thread reached the journal (the overlap test in section 4, what a source
journals, failed). a client drops every message it holds for that thread,
keeps the thread itself (the `thread` change is unaffected), and hydrates
it again if it is open or held. a reset is rare: a gateway that was away
long enough to lose its delta and committed more rows than the widest
tail.

transcripts hydrate from `GET /api/agents/{agent}/threads/{thread}/messages`
(`{messages: {info: Message, parts: Part[]}[], older, total, turns}`, the
page shape of `protocol.md` section 11, with no query the whole thread;
stamped `x-boxbox-seq` and `x-boxbox-upstream: <epoch>:<seq>` when the
source numbers its events) and one message from `.../messages/{message}`
(`no-store`). `turns`, `before` and `at` ask for a page of whole turns,
newest first, cut from the same streamed read (`http/agents/page.rs`:
at most the page's turns and one message held), with the etags and cache
headers of `protocol.md` section 11; `.../summary` answers section 12's
summary, folded from one streamed read (`fleet/summary/fold.rs`, the
app's whole-thread computations ported and checked field for field on
the thread fixtures) and kept per thread (`fleet/summary.rs`: 64
threads or 8 MiB, children's numbers apart, one computation per thread at a time, reused while `v`
holds and for 10 s while its epoch and `rv` do). the cmx2 body is translated message by message
as it streams from the daemon, never parsed whole: one message at most in
memory, capped at 32 MiB (the composer's 24 MiB of `data:` urls with room; `architecture.md`,
memory). for openclaw and hermes, hydration is one read through per
thread at a time, shared by every client that asked while it runs (single
flight), at most 2 a second per connection, and served from the
transcript cache (section 4) when the thread is in it, revalidated by one
delta. every answer from the cache carries `x-boxbox-cache: fresh` or,
while the gateway is unreachable, `x-boxbox-cache: stale` with
`x-boxbox-cached-at: <ms>`; a client draws a stale transcript as it draws
a refused agent's threads, marked stale, and reads it again when the agent
is `ready`.

### the cmx2 mapping, field by field

the cmx2 source fills the neutral shapes from cmx2's objects, which no
longer cross raw. a field not named here does not cross.

| neutral | cmx2 | note |
|---|---|---|
| `Thread.key`, `.agent`, `.id` | `<host>:<info.id>`, host, `info.id` | unchanged identity |
| `Thread.title` | `info.title` | |
| `Thread.created`, `.updated` | `info.time.created`, `info.time.updated` | |
| `Thread.parent` | `info.parentID` | |
| `Thread.forkedFrom` | `info.forkedFrom`: `sessionID` to `thread`, `messageID` to `message` | a fork is never `parent`: `parent` says "an agent of"; absent from a daemon before cmx2 b1e6f8f |
| `Thread.place.root` | `info.projectID` when absolute, else `info.directory` | today's client rule (`app/src/ui/composer/place.ts:9-11`) |
| `Thread.place.directory` | `info.directory` | |
| `Thread.place.name` | the repo word the server already derives | `model.rs:2686-2693` |
| `Thread.activity` | the raw `SessionStatus`: `busy` to busy, `retry` to retry, `idle` with `parked` to parked (`parked.agents`, `parked.jobs`), `idle` or absent to idle; never `failed` | from the raw status, not `activity()`, which folds retry into busy for ranking (`model.rs:2756-2773`) |
| `Thread.queued` | `status.queued`, else 0 | |
| `Thread.model` | `info.model.providerID + "/" + info.model.id` | today's chip (`app/src/ui/composer/composer.tsx:343-346`) |
| `Thread.effort` | `info.effort` | |
| `Thread.context` | `info.context` | |
| `Thread.cost` | `info.cost` | |
| `Thread.vcs` | `info.vcs` | |
| `Thread.changes` | `info.summary` | |
| `Thread.browseOnly` | `info.source == "cmx"` | imported history |
| `Thread.said`, `.generation`, `.sends`, `.origin` | none | absent on every cmx2 thread |
| `Thread.tokens` | `info.tokens` (input, output, cache read and write) | |
| not carried | `slug`, `version`, `revert`, `share` | nothing reads them |
| `Message.id`, `.role` | `id`, `role` | |
| `Message.created`, `.completed` | `time.created`, `time.completed` | |
| `Message.clientID`, `.queued`, `.steer` | `clientID`, `queued`, `steer` | |
| `Message.model`, `.effort` | `model`, `variant` | on a queued or steered user message |
| `Message.finish`, `.error`, `.cost` | `finish`, `error.data.message`, `cost` | read loosely as today (`model.rs:484-500`, `app/src/ui/thread/live.ts:206`) |
| not carried | `agent`, `sessionID` | the key says the thread |
| `Message.origin`, `.quote`, `.reactions`, `.sender`, `.position` | none | absent on every cmx2 message |
| `text` part | `TextPart` as is, plus `notice` and `mail` when present | identity |
| `reasoning` part | `ReasoningPart` as is | identity |
| `tool` part | `ToolPart` as is, plus `family` | `state` is cmx2's `ToolState` unchanged |
| `image` part | `FilePart` whose mime is png, jpeg, gif or webp: `url` (the `data:` url), `filename`, `mime`, `flavour: attached` | |
| `file` part | any other `FilePart`: `url`, `filename`, `mime`, `flavour: attached` | |
| `compaction` part | `CompactionPart` (`auto`, `overflow`) | |
| `marker` part | `StepStartPart`, `StepFinishPart` (`cost`), `PatchPart`, `SubtaskPart` | clients draw none of them today |
| unknown part | any other `type` | the fallback row |
| `Ask.permission.title`, `.patterns`, `.always` | `PermissionRequest.permission`, `.patterns`, `.always` | |
| `Ask.permission.options` | once, always (`lasting`), reject | cmx2's three replies |
| `Ask.questions` | `QuestionRequest.questions[]` as is | |
| `Ask.tool` | `.tool` | |
| `ask.settled` | `PermissionReplied` (`option` the reply), `QuestionReplied` (no `option`), `QuestionRejected` (`option: reject`) | `outcome: answered`; `by.name` from the event's `by` as today (`model.rs:1202-1211`); `at` the time boxbox saw it |

## 2. the transition

the plan here was two wires at once: contract 1 frozen for installed
clients beside contract 2 behind `?protocol=2`, with two journals, two
epochs, every model cap kept twice (once over cmx2 threads, once over the
rest) and a `stream_days` count to say when contract 1 could go. none of
that was built. the owner's round three decisions replaced both wires
with protocol 3 in one change (`protocol.md`; decisions 25, 36 and 37
are superseded):

- **one wire.** `GET /api/stream` speaks protocol 3 only; `hello` says
  `protocol: 3`. there is no `?protocol` pick on the stream,
  `/api/fleet`, `/api/needs` or `/api/history`, one journal and one
  epoch, and the model's caps (order 300, sessions 1000, adopted 20,
  clears 2000, needs 500 open and 200 served) count every thread
  together. `push_devices` has no `protocol` column.
- **no raw passthrough.** cmx2's objects stop at the source: the cmx2
  transcript proxy and its routes
  `/api/hosts/{host}/sessions/{session}/messages[/{message}]` (the
  `DELETE` that unsends stays), `Cmx2Raw` and `x-cmx2-seq` on answers to
  devices are gone. threads read under `/api/agents/...` (section 1, the
  stream). the other verb routes under `/api/hosts` stay (`protocol.md`,
  the owner's q2).
- **the web app** is embedded in the binary and moves with the server.
- **the ios app** stops connecting until a build that speaks protocol 3:
  its hello check refuses any protocol but the one it was built for
  (accepted by the owner).
- **the board** declares its view on `/api/stream?view=board` (board
  protocol 3, `docs/board.md`); `/api/board/stream` is gone.
- **repo colours** reach every stream but the board's; `colours=1` is
  gone (`architecture.md`, repo colours).

## 3. thread ids for foreign keys

thread ids must be one path segment and one push link part:
`[A-Za-z0-9_-]{1,128}`, the intersection of the path rule (`segment()`,
`http/session.rs:458-469`, which also allows `.`) and the push link rule
(`push/notice.rs:92-96`),
and agent keys `[a-z0-9-]{1,32}` (`push/notice.rs:87-91`). read marks,
needs, clears, adopted rows and push links are keyed by them
(`architecture.md`, auth, config, data), so they must never move.

- **cmx2 ids stay as they are**, and a cmx2 agent's key is its connection
  name, so every key in `boxbox.db` and every link already sent still
  resolves.
- **a foreign thread id** is `oc_` (openclaw) or `hm_` (hermes) followed
  by 24 characters: lowercase rfc 4648 base32, no padding, of the first 15
  bytes of `sha256("boxbox-thread-v1" 0x00 source 0x00 connection 0x00
  foreign agent id 0x00 foreign session key)`. the openclaw session key is
  stable across `/new`, resets, rewinds and branch switches, which change
  only its session id (`openclaw.md`), so a thread survives them. a hermes
  thread hashes its state.db session id.
- **persisted.** the first sight of a key writes `thread_ids (agent,
  id, foreign_key, first_seen)` through the store writer, unique on both
  `(agent, id)` and `(agent, foreign_key)`; verbs map back through it.
  the source keeps the 10,000 most recently used rows in memory, nothing
  loaded at start: forward (foreign key to id) a miss recomputes the hash,
  which is deterministic, and writes the row if it is new; back (id to
  foreign key) a miss reads `thread_ids` by its unique index. an insert
  that collides on `(agent, id)` with another key is refused, logged with
  both keys hashed, and the thread is not shown; at 120 bits this is a bug
  report, not a case to design for.
- **pruned.** every cron run is a new thread (`openclaw.md`), so a job
  that runs each minute adds about 525,000 rows a year. once a day the
  source deletes the `thread_ids` rows, and their `source_cursors` rows,
  whose foreign session the agent deleted more than 30 days ago and that
  hold no read mark, need, clear or adoption. a pruned thread that comes
  back gets the same id again.
- **why a hash.** openclaw session keys carry channel peers, phone numbers
  among them (`agent:<id>:whatsapp:direct:<number>`), and can pass 128
  characters. a hash keeps them out of urls, push payloads, logs and
  telemetry. it is deterministic, so a lost database re-derives the same
  ids and old push links still open their threads.
- **message and part ids** of a foreign source are reversible without a
  table: a message id is `m` plus the base64url (no padding) of the foreign
  entry id; a part id is `<message id>_<index>`. a foreign id over 95
  bytes (whose encoding would pass 128) is a source bug, logged, and the
  message is dropped with a fault on its thread.
- **agent keys.** a cmx2 agent's key is its connection name. any other
  agent's key is the `key` its config entry pins, else `<connection>-<slug>`,
  where the slug is the foreign agent id lowercased with every run of
  other characters made one dash and dashes trimmed from both ends. when
  the whole is longer than 32, or the slug is empty, it is cut to 27
  characters (a trailing dash trimmed) and gets `-` and a 4-character
  base32 hash of the foreign id: an openclaw connection name is at most
  24 characters (`openclaw.md`, config), so every key has room. the
  first sight writes `agents (connection, foreign_id, key, first_seen)`
  (as many rows as the config's runtimes have agents), and the key never
  changes after that, even if the rule would now say otherwise.
- **collisions.** connection names and agent keys share one namespace,
  and configured and paired connection names always win, whatever order
  things are found in: an agent whose key equals any connection name, or
  a key already in `agents` for another connection, is `refused` with
  `refused: "key"` and words naming both, whenever it is first seen.
  config load and pairing check `agents` and refuse a connection name
  already used as an agent key ("vm-b-main is already the key of an agent
  on vm-b; pick another name or pin that agent's key"), so a later
  connection never takes a key whose read marks, needs and clears
  (`"<key>:"`, `model.rs:680,1377`) belong to someone else. two new foreign agents that
  would derive one key keep it in the order of their connections in
  `boxbox.toml` (paired ones after, by pairing time); the other is refused
  until the config pins its key. once a key is in `agents` its owner keeps
  it.

## 4. the agent source seam

### shape

```rust
/// what a source sends the fleet actor. every event names its agent.
pub enum SourceEvent {
    Connection(ConnectionStatus),
    /// the connection's agents, whole: identity, kind, capabilities.
    Agents(Vec<AgentFacts>),
    /// one agent read afresh: replaces every thread and ask the fleet held
    /// for it; its seqs are the floors for what follows, and its `epoch`
    /// the source's (a moved epoch re-reads every tail, today's HostRead).
    Snapshot(Box<Snapshot>),
    /// `born`: the thread was just created, so the model marks its tail
    /// read and empty instead of asking for one (today's SessionCreated,
    /// `model.rs:839-842`; `Thread` with `born: false` is SessionUpdated).
    Thread { thread: ThreadFacts, born: bool },
    ThreadRemoved { thread: String },
    /// the source cannot prove every row reached the journal: `thread.reset`.
    ThreadReset { thread: String },
    /// `queued`: prompts admitted behind the running turn (`Thread.queued`).
    Activity { thread: String, activity: Activity, queued: u32 },
    /// a turn ended: busy becomes idle, parked stays parked (today's
    /// SessionIdle, `model.rs:869-882`); raises done as today.
    TurnEnded { thread: String },
    /// what boxbox knows of a send it could not confirm (section 7).
    Send { thread: String, client_id: String, state: SendOutcome },
    Message { thread: String, message: Message },
    Part { thread: String, part: Part },
    Delta { thread: String, message: String, part: String, field: String, delta: String, offset: u64 },
    MessageRemoved { thread: String, message: String },
    Reactions { thread: String, message: String, reactions: Vec<Reaction> },
    AskRaised { ask: Ask },
    /// `kind` picks the floor (permissions or questions, `model.rs:1202-1208`).
    AskSettled { ask: String, kind: AskKind, settled: Settled },
    Fault { thread: String, words: String },
    Notice { thread: String, notice: Notice },   // review, job; cmx2 only today
    /// a worktree merged or discarded: settles review needs by worktree name
    /// and directory, with no thread (`model.rs:1237-1240`); cmx2 only.
    ReviewSettled { worktree: String, directory: String },
    TailRead(Box<TailRead>),
    TailUnread { thread: String, reason: String },
}

/// the input enum's new variant, beside the ones that stay.
Upstream::Source {
    connection: Arc<str>,
    agent: Arc<str>,
    seq: Option<u64>,
    event: SourceEvent,
}
```

the reducer matches `SourceEvent` instead of `cmx2::Event`. its floors
and staleness rules (`stale(host, Domain, seq)`, `model.rs:834,846,857`)
keep their exact meaning, keyed by agent instead of host. the cmx2 source
is today's watcher, reconcile and tail reader unchanged
(`upstream/watcher.rs`, `reconcile.rs`, `tails.rs`) plus a translation table
of one row per domain event boxbox consumes today (19: the session, status,
transcript, ask and need events, `model.rs:826-901,1217-1340`); every other
type the contract declares stays decoded and ignored, as now (`model.rs:900`).
the translation is total and one to one: every event the reducer consumes
today yields exactly one `SourceEvent` (`session.idle` is `TurnEnded`,
never an idle `Activity`; a merged or discarded worktree is
`ReviewSettled`), and an unknown part type becomes the `unknown` part,
never a dropped event. the one skip is a payload that lacks what it
decoded with. no raw payload rides beside the event: the only cmx2 json
the server keeps is an adopted thread's session info, held on
`ThreadFacts.raw` for its `boxbox.db` row (`fleet/adopted.rs`) and never
by the fleet. a `record` build (`--features record`) also holds each raw
cmx2 input until its translated event reaches the actor, for the tape; a
default build carries none of it.

**`seq` on `Upstream::Source`** feeds two things: the agent-wide floors
(`stale()`, `model.rs:1361-1373`, `seq <= floor` per domain) and the
per-thread `upstream` a client compares with a read's stamp
(`model.rs:1276,1303,1336`). so it is a number that increases across the
whole connection, or `None`. cmx2 sends its event seq, as today. openclaw
and hermes number per session (openclaw's `messageSeq` and delta cursors),
never across the connection, so they send `None` and their snapshot
floors are 0; a per-session number passed as `seq` would drop one
session's events behind another's floor. `None` passes `stale()`
unconditionally, so a source that sends `None` must not emit, after a
`Snapshot`, anything it observed before that snapshot's read: the
openclaw source buffers what arrives during a read and replays only what
is newer than it (`openclaw.md`, bootstrap).

verbs go out through one trait. the registry in `AppState` holds
`Arc<dyn AgentSource>` per connection and finds the source for an agent
key; the trait's methods return boxed futures (`futures-util`'s
`BoxFuture`, already a dependency) so it stays object safe.

```rust
pub trait AgentSource: Send + Sync + 'static {
    fn connection(&self) -> &ConnectionConfig;
    /// the connection's agents and their capabilities, as last published.
    fn agents(&self) -> watch::Receiver<Vec<AgentFacts>>;
    fn run(self: Arc<Self>, fleet: SourceSender, shutdown: CancellationToken) -> BoxFuture<'static, Exit>;

    // every source
    fn transcript(&self, thread: &ThreadRef, page: Page) -> BoxFuture<'_, Result<Transcript, VerbError>>;
    fn message(&self, thread: &ThreadRef, message: &str) -> BoxFuture<'_, Result<Stamped<MessageWithParts>, VerbError>>;
    fn thread(&self, thread: &ThreadRef) -> BoxFuture<'_, Result<ThreadFacts, VerbError>>;
    fn prompt(&self, thread: &ThreadRef, send: Send) -> BoxFuture<'_, Result<Accepted, VerbError>>;
    fn abort(&self, thread: &ThreadRef) -> BoxFuture<'_, Result<(), VerbError>>;
    fn mark_read(&self, thread: &ThreadRef, at: f64) -> BoxFuture<'_, Result<(), VerbError>>;
    fn media(&self, source: &MediaSource) -> BoxFuture<'_, Result<MediaBody, VerbError>>;

    // gated by a capability; the default answers VerbError::Unsupported
    fn start(&self, agent: &str, start: Start) -> BoxFuture<'_, Result<Born, VerbError>>;     // threads
    fn answer(&self, ask: &AskRef, answer: Answer) -> BoxFuture<'_, Result<(), VerbError>>;   // approvals, questions
    fn archive(&self, thread: &ThreadRef) -> BoxFuture<'_, Result<Archived, VerbError>>;      // archive
    fn react(&self, thread: &ThreadRef, message: &str, emoji: &str, on: bool) -> BoxFuture<'_, Result<(), VerbError>>; // reactions
    fn queue(..), fn run_now(..), fn unsend(..)                       // queue
    fn steer(..)                                                       // steer
    fn compact(..)                                                     // compact
    fn catalog(..)                                                     // model, reasoning
    fn projects(..), fn folders(..)                                    // places
    fn find_file(..)                                                   // files
    fn shell(..)                                                       // shell
    fn commands(..), fn command(..)                                    // commands
    fn history(..), fn adopt(..)                                       // history
    fn review(..), fn merge(..), fn discard(..)                        // review
    fn reload(..), fn restart(..), fn memory(..)                       // admin
    fn terminal(&self) -> Option<&dyn TerminalSource> { None }         // terminal
}
```

contract 1 had a `Cmx2Raw` trait for the transcript, message and send
routes that passed the daemon's body through byte for byte. it went with
contract 1 (section 2): threads read through the typed `transcript` and
`message` verbs, translated message by message, and the `/api/hosts`
verb routes call the cmx2 source directly (`http/agents`, `agents::cmx2`).

- `Send` is `{client_id, text, attachments: [{media, transcript?}], quote?,
  model?, effort?, generation?}` on prompt, steer and queue; `Start` adds
  `place?` and `worktree`. `Accepted` and `Born` are boxbox's own
  answers (`{state: "accepted" | "checking", message?}`, `{key, thread}`),
  not a daemon's body passed through (section 7, sends).
- every send keeps its client id end to end (`README.md`, one request). a
  source whose runtime dedupes by key passes it as that key (cmx2's
  `x-cmx2-repeat`, openclaw's `idempotencyKey`); the source stamps it on
  the user message it emits, because the composer settles on it
  (`model.rs:489-490`). births stay idempotent by client id through the
  existing kept-births map (`http/compose.rs:80-82,823-832`), moved from
  compose into the registry so every source shares it.

### lifecycle and supervision

- the supervisor (`upstream/mod.rs`, today one watcher per host,
  `upstream/mod.rs:159-338`) owns the connection list from `boxbox.toml`
  and the paired rows, and runs one source task per connection. config
  changes arrive as today's `Configured`, `Paired`, `Forgotten`
  (`upstream/mod.rs:149-153`).
- a source's `run` returns an `Exit` (`Retry {why}`, `Refused {why}`,
  `Stopped`). `Retry` restarts it after today's jittered backoff (500 ms
  floor and 30 s cap, `BACKOFF_FLOOR` and `BACKOFF_CAP` in
  `upstream/watcher.rs:48-49`); a panic is caught at the task
  boundary and counts as `Retry`; `Refused` parks it with status `refused`
  until the config changes. a source never takes another down.
- removal cancels the token; the source has 2 s to close its socket, then
  the task is dropped. the fleet drops the agents (`agent.removed`). server
  shutdown cancels every source inside the 5 s drain (`architecture.md`,
  shutdown).
- `syncing` ends when the source has sent a `Snapshot` for every agent
  and the window tails it owes are read; until then `ready` is not shown.

### buffers and caps

every buffer a source adds has a byte cap and an owner (AGENTS.md, memory and latency). the
numbers per connection agree with `openclaw.md`, load limits.

| buffer | cap | owner | when full |
|---|---|---|---|
| sources to the fleet actor (shared, today's `UPSTREAM_CAPACITY`) | 1024 events (`fleet/mod.rs:67`) | the fleet actor | the source awaits: domain events are never dropped. cmx2's watcher stops reading its sse while it waits, and the daemon holds the events; a socket source's handler waits, and its reader channel below absorbs it |
| a socket source's reader to its own handler (openclaw, hermes) | 4096 frames or 16 MiB | the source | at half the source sheds (it drops the live narration it subscribed for threads off stage, `openclaw.md`, shedding), so slow fleet processing costs live text before it costs the socket. full, the reader stops reading: the gateway buffers up to its own bound and closes a slow consumer, the source reconnects, and its cursors make the catch up gap free |
| requests into a socket source (verbs and sync reads) | 4 in flight, 8 queued | the source | a verb answers 503 `agent-busy` with `retry-after`, and nothing is queued; sync reads wait their turn in the source's scheduler |
| media copies | 2 in flight, 64 queued, 8 MiB/s, 1 MiB buffered per copy | the source queues; the media task writes | the copy is deferred, never `missing`: the part stays `pending` and the source queues it again on its next sight of the message or its next sweep |
| live text (provisional messages) | 8 runs, 256 KiB of text each (a live row is at most 8,000 characters, `openclaw.md`) | the source | past 8 the oldest run's provisional message is retired early; past 256 KiB a run's live text stops growing until its committed row replaces it |
| events held while a session's first read runs | 256 per session | the source | the buffer is dropped and the session is marked for a fresh tail (`needs_tail`, `openclaw.md`) |
| seen index | 200 rows a thread, 24 bytes a row, 2,000 threads, least recently journaled first (9.2 MiB at most) | the source | an evicted thread's next tail cannot prove overlap and ends in `thread.reset` (below) |
| thread id map | 10,000 rows, least recently used first | the source | a miss recomputes or reads `thread_ids` (section 3) |
| sends being reconciled | 256 per connection, 30 minutes each; `Thread.sends` at most 32 a thread | the source | the oldest is settled `uncertain` and dropped |
| hydrations | one read through per thread at a time, 2 a second per connection | the source | a client that asks while one runs shares its answer; past the rate it waits |
| transcript cache | `[cache] transcript_bytes` on disk, 256 MiB unless set; 2 MiB of sqlite page cache per connection in memory | the source | least recently opened threads go first (below) |
| uploads | 4 at once, 1 MiB buffered each | the media task | a fifth answers 503 `media-busy` with `retry-after` (section 6) |
| kept births | 64 (`BIRTHS_KEPT`, `http/compose.rs:82`) | the source registry | the oldest is forgotten |
| store writer (today's) | 256 jobs (`store/mod.rs:19`) | the store | the sender awaits |

### what a source persists

through the one store writer, in `boxbox.db` (decision 18). the new tables
and columns come as migrations after the current six (`store/schema.rs`):

- `connections`: today's `paired_hosts` gains `source`, so a paired
  connection says what it is. `[[host]]` in the file is read as
  `[[cmx2]]`, so every existing `boxbox.toml` works unchanged.
- `agents (connection, foreign_id, key, first_seen)` and `thread_ids
  (agent, id, foreign_key, first_seen)`: section 3.
- `source_cursors (connection, scope, value, updated)`: a source's resume
  points (openclaw: per session its delta cursor, cursor state, session id,
  updated time and archived flag, and the last boot id per connection;
  `openclaw.md` owns what each means). the journal is memory and a source
  gets no acknowledgement from the fleet actor, so a cursor row is written
  after the changes it covers were sent into the fleet channel. a crash
  between the two replays an idempotent read. full resume
  (`protocol.md` section 10) keeps the journal's epoch, but these cursors
  are not in its batches: a restarted openclaw source reads its agent
  afresh, and the quiet re-read resets each of its threads once (no
  transcript revision vouches for them). pruned with
  `thread_ids` (section 3).
- `source_secrets (connection, name, value)`: a gateway device key pair,
  its device token and the connection's instance id (openclaw's, with
  `device_key` in the file taking the key's place when set). never logged,
  never in an api answer, mode 0600 like the file.
- `media`, `media_refs`, `media_sidecars`: section 6.

### what a source journals

the agent is the system of record, as cmx2 is, and boxbox keeps no copy
it would reconcile with it. three things make that hold for a source that
cannot replay its own events the way cmx2 does:

- **every committed row of every non-archived thread is journaled,**
  watched or not, as cmx2's are today (`model.rs:1271-1309`, no window
  gating). a client that holds a thread then stays current on seq alone,
  which is what the clients' caches already assume. openclaw delivers a
  committed row for every session on its roster at no extra cost to the
  gateway (`openclaw.md`, events). the media of every such row is queued
  for copy on first sight (section 6).
- **a seen index** per thread journaled or hydrated in this epoch: the last
  200 rows' ids with a hash of each body (the cap is in the table above).
  it turns re-reads into exactly-once changes. a hydration registers the
  thread's viewer first, then reads, then seeds the index with the ids and
  hashes it served, so a row committed during the read is caught by the
  next delta. merging is monotone per id: a truncated body never replaces
  a longer one, and an oversized placeholder never replaces text
  (`openclaw.md`, the seen index).
- **the overlap test.** after a gap (a lost delta cursor, a reconnect past
  what the agent keeps) the source reads the thread's newest rows and
  journals only what its index lacks. "no seen index" passes only for a
  thread never journaled or hydrated in this epoch. a read that reaches a
  row the index holds, or the agent's own context reset (a `reset`
  marker), proves the gap closed. a read of 1000 rows that proves neither,
  or a whole window (`hasMore: false`) with no overlap, sends
  `thread.reset {key}`, and clients drop that thread's messages and
  hydrate again (section 1, the stream). `openclaw.md` owns the steps.

### the transcript cache

the openclaw and hermes sources keep a bounded read cache of assistant
transcripts, so a thread can still be read while the gateway is away and
a server restart does not cost one tail per thread per device. it is a
cache, never a system of record: the agent stays the one place a row
lives, and nothing in boxbox reads the cache to decide what is true.

- **where.** `<data dir>/cache/<connection>.db`, a sqlite file per
  connection, owned by that connection's source, written on its own
  blocking thread, never through the store writer. it holds message
  bodies only: no cursor, read mark or anything else boxbox needs. a
  deleted or corrupt file is recreated empty and refilled by use.
- **what it holds.** per thread the newest 200 rows or 2 MiB, whichever
  is reached first, for threads active or opened in the last 30 days.
  across connections at most `[cache] transcript_bytes` in `boxbox.toml`,
  256 MiB unless set, split evenly between the connections that keep one.
- **eviction.** least recently opened threads go first until the
  connection's share is under 90% of it. a thread deleted or removed on
  the agent, a forgotten connection, and an archived thread drop their
  rows at once.
- **filled only from what boxbox already reads:** hydrations, tails,
  deltas and the committed rows it journals. it never sends a request of
  its own.
- **served** for a hydration when the thread is in it: fresh (revalidated
  by one delta) while the gateway answers, `stale` with its time while the
  gateway is unreachable (section 1, the stream). a thread not in it while
  the gateway is away answers 503 `agent-down` in words.
- **replaced wholesale** when the source reads a tail after a reset (a
  `thread.reset`, a delta reset, a new generation): the old rows go and the
  tail's rows come in, never merged.
- **never used to detect a gap.** cursors and the seen index do that; a
  row in the cache proves nothing about what reached a client.
- **cmx2** has no cache: its daemon replays its own events and answers
  reads itself.

### how today's cmx2 calls route through it

about forty handlers in `http/` and `pty/` format cmx2 routes inline after
looking the host up (`find` and `find_host`, `http/session.rs:471-475`;
`rg -n 'find\(&state|find_host\(' server/src/http server/src/pty` lists the
call sites). each becomes one trait
call on the cmx2 source, whose body is the handler's current call moved
whole, headers and caps included:

| handler | verb | capability |
|---|---|---|
| `agents::read` (the thread reads) | `transcript`, `message` | none |
| `asks::prompt` | `prompt` | none |
| `asks::abort` | `abort` | none |
| `compose::start` | `start` | threads (and places, worktree when asked) |
| `asks::permission`, `asks::question`, `asks::reject` | `answer` | approvals, questions |
| `threads::archive` | `archive` | archive |
| `threads::adopt`, `history::list` | `adopt`, `history` | history |
| `session::queue`, `session::run_now`, `session::unsend` | `queue`, `run_now`, `unsend` | queue |
| `compose::steer` | `steer` | steer |
| `asks::compact` | `compact` | compact |
| `session::providers`, `hosts::models` | `catalog` | model |
| `compose::projects`, `compose::folders` | `projects`, `folders` | places |
| `session::find_file` | `find_file` | files |
| `compose::shell` | `shell` | shell |
| `compose::commands`, `compose::command` | `commands`, `command` | commands |
| `review::show`, `review::merge`, `review::discard` | `review`, `merge`, `discard` | review |
| `hosts::reload`, `hosts::restart`, `upstream/memory.rs`, `upstream/system.rs` | `reload`, `restart`, `memory`, `system` | admin |
| `pty::*` | `terminal()` | terminal |
| `repo_icon::repo_icon` | (the icons task, as today) | places |
| `hosts::pair` | per source pairing (`POST /api/connections/pair` with `source`) | n/a |

the cmx2-only verbs stay cmx2's behind their capabilities: terminal,
branch review, worktree, compaction, `@` files, repos and folders, and
with them queue, steer, slash commands, `!` lines and admin. the
`/api/hosts/{host}/...` verb routes call the cmx2 source; the
`/api/agents/{agent}/...` routes call the typed verbs of any source.

### the routes

every verb has one `/api/agents` route. `T` is
`/api/agents/{agent}/threads/{thread}`. every write carries `{device,
deviceClass, clientID}` as today's do, and the capability check comes
first (below).

| verb | route | the `/api/hosts` route kept for cmx2 (q2) | capability |
|---|---|---|---|
| read | `GET T/messages`, `GET T/messages/{message}`, `GET T/summary` | none (the transcript proxy went with contract 1) | none |
| prompt | `POST T/prompt` | `.../prompt` | none |
| abort | `POST T/abort` | `.../abort` | none |
| steer | `POST T/steer` | `.../steer` | steer |
| queue, run now, unsend | `POST T/queue`, `POST T/run-now`, `DELETE T/messages/{message}` | `.../queue`, `.../loop`, `DELETE .../messages/{message}` | queue |
| compact | `POST T/compact` | `.../compact` | compact |
| shell | `POST T/shell` | `.../shell` | shell |
| commands | `GET /api/agents/{agent}/commands`, `POST T/command` | `/api/hosts/{host}/commands`, `.../command` | commands |
| react | `PUT T/messages/{message}/reactions` with `{emoji, on}` | none | reactions |
| archive | `POST T/archive` | `.../archive` | archive |
| fork | `POST T/fork` with `{before?}`, the first message the fork leaves out; answers 201 `{key, thread}` | none (a new verb; the app calls this route) | fork |
| adopt | `POST T/adopt` | `.../adopt` | history |
| answer an ask | `POST /api/agents/{agent}/asks/{id}` | `/api/hosts/{host}/permissions/{ask}`, `.../questions/{ask}`, `.../questions/{ask}/reject` | approvals, questions |
| new thread | `POST /api/agents/{agent}/threads` | `POST /api/hosts/{host}/sessions` | threads |
| catalog | `GET /api/agents/{agent}/models` | `/api/hosts/{host}/providers`, `/api/hosts/{host}/models` | model |
| places | `GET /api/agents/{agent}/projects`, `.../folders`, `.../repo-icon` | `/api/hosts/{host}/projects`, `.../folders`, `.../repo-icon` | places |
| files | `GET /api/agents/{agent}/find/file` | `/api/hosts/{host}/find/file` | files |
| review | `GET T/review`, `POST T/review/merge`, `POST T/review/discard` | `.../review`, `.../review/merge`, `.../review/discard` | review |
| admin | `POST /api/agents/{agent}/reload`, `.../restart` | `/api/hosts/{host}/reload`, `.../restart` | admin |
| terminal | `/api/agents/{agent}/pty...`, the same shapes as today | `/api/hosts/{host}/pty...` | terminal |
| pair, forget | `POST /api/connections/pair` with `source`, `DELETE /api/connections/{name}` | `POST /api/hosts/pair`, `DELETE /api/hosts/{host}` | none |

keyed routes serve every agent, because a thread key names its agent:
`POST /api/read` (a read mark; the source's `mark_read` also tells
an agent that keeps read state, section 7), `POST /api/clear` (keys,
including a runs window's `<agent>:runs`, section 7), `POST /api/presence`,
and the media routes (section 6). `GET /api/fleet` answers the neutral
fleet `{agents, threads, asks, order}` with `x-boxbox-seq`, built from
the journaled state (`protocol.md`, sections 6 and 15); `GET /api/needs`
and `GET /api/history` answer as they did, with no `?protocol`.

- **as built (m9, `http/agents/`).** the trait verbs (prompt, steer, queue,
  run now, unsend, abort, compact, react, archive, fork, adopt, answer, new
  thread, models) are `routes.rs`; the cmx2-only capabilities with no trait
  verb (terminal, review, places, files, shell, commands, admin) are served
  by the `/api/hosts` handlers behind the same check (`agents::guard`), in the
  shapes they answer today, and 501 `not-built` for an agent with the
  capability on a source that is not cmx2. `GET /api/agents` lists every
  agent with its connection's state (the agents screen's data). a plain
  verb answers 204; archive answers `{key, at}`; fork answers 201 with the
  new thread's `{key, thread}` (404 `no-such-session` for the thread, 404
  `no-such-turn` for a `before` the thread does not hold, 409 `host-said`
  for history the agent keeps browse only); models `{models:
  [{id, name, provider?, levels?}], default?}`. new error codes:
  `no-such-agent` 404, `agent-unreachable` 502, `agent-busy` 503 with
  `retry-after: 5`, `generation-changed` 409, `not-confirmed` 409,
  `not-built` 501, `attachment-too-large` 413, `attachment-kind` 415,
  `name-reserved` 409.

### a verb an agent cannot do

the http layer checks the capability before it calls, so a client that
hid the control and a server that refuses agree. the answer is **422**
`{"error": "unsupported", "capability": "terminal", "message": "<agent
label> has no terminal"}`. a client never retries it. a missing agent is
404 `no-such-agent`; a capability present but refused by the agent itself
is today's `host-said` (`architecture.md`, archive).

## 5. capabilities

published on the agent (`agent.capabilities`) and live: a change is an
`agent` change. a surface shows a control only when its capability is
true, and the server refuses the verb when it is not (section 4).

| capability | means | gates | cmx2 | openclaw | hermes |
|---|---|---|---|---|---|
| `places` | threads start in a repo or folder on the agent's machine | the place row, recents, folder walk, repo icons, the repo word on windows | yes | no | no |
| `worktree` | a new thread may start in a fresh worktree | the fresh checkout toggle | yes | no | no |
| `terminal` | terminals on the agent's machine | the terminal rows and pane | yes | no | no |
| `review` | branch review of a thread's checkout | the review sheet, merge, discard, review needs | yes | no | no |
| `compact` | compaction | the compact item, compaction parts | yes | no | yes |
| `queue` | a prompt sent during a turn waits behind it; run now; unsend | the queued cards and their verbs | yes | yes (openclaw queues; `openclaw.md`) | yes |
| `steer` | a prompt can join the running turn at its next tool boundary | the steer key | yes | no (its steer interrupts; `openclaw.md`) | yes |
| `model` | a model picker from the agent's catalog | the model chip | yes | yes | yes |
| `reasoning` | `{word, levels}`: the chip's word and its levels | the effort or thinking chip | `{effort, [low, medium, high, xhigh, max]}` (`compose.rs:72-73`) | `{thinking, levels from the gateway}` | `{effort, levels from its config}` |
| `approvals` | permission asks | ask card, push, board pit digits | yes | yes | yes |
| `questions` | question asks | ask card, push | yes | yes | yes |
| `attachments` | `{kinds, maxBytes, maxCount}` | the composer's attach and photo keys, upload checks | `{[png, jpeg, webp, gif, heic, heif, application/pdf, text/*, application/json], 9 MiB, 4}` (`wire/capabilities.rs`: 9 MiB is the largest one file may be, a pdf or a heic original; `http/compose.rs` holds a text or json file to 512 KiB and a photo that was not resized to 1.5 MiB, refused at send in words, and every attachment of a message to 18 MiB together; `composer.md`, attachments: any file) | `{[image/*, audio/*, video/*, application/pdf, text/*], hello-ok.policy.attachments.maxBytes (20 MiB when absent), 8}`; the count is boxbox's own limit, since the gateway names none (`openclaw.md`, media) | `{[png, jpeg, webp, gif], from its config, 4}` |
| `voice` | `{notes, replies}`: `notes`, you can record a voice note and the agent hears it; `replies`, the agent may answer with audio | `notes` gates the mic key and recording; `replies` gates nothing (an audio part is drawn whenever one arrives) and is there so a client can say the agent speaks | `{no, no}` | `{yes, yes}` | `{no, no}` |
| `quotes` | a message can quote another | swipe to reply, the reply strip, quote rows | no | yes | no |
| `reactions` | emoji reactions on messages | the reaction picker and row | no | yes | no |
| `threads` | more than one thread; start one with no place | "start something" for this agent | yes | yes | yes |
| `archive` | archive a thread | the archive item | yes | yes | yes |
| `fork` | a new thread from this one's history, whole or up to a message | the menu's fork, each turn's fork from here | yes | no (not built) | no |
| `commands` | slash commands | `/` | yes | no | no |
| `files` | `@` file mentions | `@` | yes | no | no |
| `shell` | `!` lines | `!` | yes | no | no |
| `history` | past threads, paged; adopt | the history screen's rows for this agent | yes | yes | yes |
| `subagents` | threads have parents | child rows, the roster | yes | yes (`openclaw.md`, mapping) | yes |
| `spend` | cost and context fill mean something | spend and context in details | yes | per agent: true when its rows carry a cost (`estimatedCostUsd`, `openclaw.md`) | yes |
| `origins` | messages arrive from channels or schedules | the "via" time line | no | yes | yes |
| `admin` | reload, restart and memory for the runtime | the agents screen's verbs | yes | no (never sent, `openclaw.md`) | no |

the cmx2 column is everything cmx2 does today, so no cmx2 surface changes.
the openclaw column is what `openclaw.md`'s allowlist reaches. the hermes
column is the target for `m10 · hermes` and is confirmed live there. a
per-thread override (a cmx2 thread outside git has no review) is not in
this contract.

## 6. media

### the store

- **where.** `<data dir>/media/`, files named by content:
  `media/<first 2 hex>/<64 hex>`. the id is the sha256 of the bytes, 64
  lowercase hex, so the same bytes are kept once whoever sent them, an
  upload retried after a timeout is the same object, and a voice note
  boxbox uploaded matches the copy it later reads back from the agent.
- **the index** is in `boxbox.db`: `media (id, mime, size, filename,
  duration_ms, width, height, waveform, origin: upload | agent, created,
  last_used, pinned_until, evicted_at)`, `media_refs (media, agent,
  thread, message)` (what holds it), `media_sidecars (media, thread,
  transcript, lang, device, created)`.
- **one owner.** the media task owns the directory and the index rows:
  writes, copies, eviction. the route reads files directly, by id.
- **the cap** is `[media] max_bytes` in `boxbox.toml`, 2 GiB unless set,
  and every file counts, thumbnails included (`media/thumbs/`, the route
  below). the owner is the media task.
- **eviction.** when a write would pass the cap, the least recently used
  (by `last_used`, set on every serve) go first until the total is under
  90% of it. pinned media never go (an upload until its send settles or
  10 minutes pass). media under 24 hours old never go: if only those
  remain, the new copy is refused and its part is `missing` with a notice
  saying the store is full and where to raise the cap. an evicted file's
  row stays as a tombstone (`evicted_at`), at most 100,000 rows, oldest
  tombstones dropped first. thumbnails go before any file (they are made
  again on request), by their original's `last_used`, with no floor, pin
  or tombstone; a file that goes takes its thumbnails with it, and the
  startup check removes thumbnails whose file is gone. a thumbnail never
  evicts anything: one that does not fit is served and not kept.
- **evicted media** answer 410 `media-evicted` on the route. the client
  keeps the card (name, size, duration, the transcript or spoken text it
  already has) with one line saying the file is no longer on the server,
  and no play or open control. if the agent still serves the bytes, the
  source's next sight of the message copies them back and the part comes
  again `ready`.

### the route

`GET` and `HEAD /api/media/{id}`, behind the gate like every route.

- `id` must be 64 lowercase hex, else 400.
- `range: bytes=a-b` (one range) answers 206 with `content-range`; several
  ranges answer 200 with the whole file; a range past the end is 416.
  `accept-ranges: bytes` on every answer, so audio scrubs and resumes.
- `cache-control: private, max-age=31536000, immutable` and `etag:
  "<id>"`, 304 on a match: the bytes behind an id never change.
- `content-type` from the index; `content-disposition: inline` for image,
  audio, video and pdf, `attachment` for everything else, with the
  filename. every answer, the refusals included, carries
  `x-content-type-options: nosniff` and the sandboxing
  `content-security-policy` the repo icon route uses (`architecture.md`,
  repo icons), since an svg is a document.
- the body streams from the file (`tokio::fs`), never read whole.
- unknown id 404 `no-such-media`, evicted 410 `media-evicted`.
- **thumbnails** (`protocol.md` section 13; `media/thumbs.rs`). off for
  now: while `THUMBNAILS` is false, `?w=` is ignored and the original
  answers exactly as without it (the scaling matches chromium but not
  webkit, `verification.md`, thumbnails). switched on, `?w=<px>` with `w` one of 96, 192, 384, 768, 1536 (device pixels; any
  other value is 400 `bad-request` in words; other query parameters are
  ignored, as before). a png or webp wider than `w` answers itself scaled
  to `w`, aspect kept and height rounded, in its own format (png and webp
  both written lossless), with `cache-control: private, max-age=31536000,
  immutable`, `etag: "<id>.w<px>"` (304 on a match), the stored type and
  disposition, and no ranges (a `range` header gets the whole thumbnail).
  at or under `w`, for every other format, and for an image carrying what
  the browser applies and a thumbnail would drop (an icc profile, png
  gamma or chromaticities without `sRGB`, an exif orientation, animation,
  16-bit samples), or past 40 megapixels, `w` answers the original exactly
  as without it, under `etag: "<id>"`; a client already holding `"<id>"`
  for the url gets 304. jpeg and gif answer the original: jpeg failed the
  pixel check (`verification.md`, thumbnails), gif is motion and a
  palette. the scaling is chromium's own (a skia mip chain sampled
  trilinearly on premultiplied pixels), so a thumbnail lands within 2/255
  of the browser's own downscale. one scales at a time, off the runtime;
  the result is served at once and handed to the media task, which keeps
  it under `media/thumbs/<first 2 hex>/<id>.w<px>` if it fits and its file
  is still live. no client asks `w` yet.

### upload

`POST /api/media` takes the raw bytes of one file of any kind: image,
audio, video, document. headers: `content-type`, `x-boxbox-filename`
(percent-encoded), and for a voice note `x-boxbox-duration-ms` and
`x-boxbox-waveform` (base64 of at most 64 bytes).

- the body streams to `media/tmp/` while it is hashed, then is fsynced and
  renamed to its address; nothing is held in memory past a 1 MiB buffer,
  owned by the media task, which the route hands the body to.
  its own body limit is 64 MiB (`MEDIA_BODY`), the largest file boxbox
  takes from a device; four uploads run at once and a fifth answers 503
  `media-busy` with `retry-after`.
- the kind is checked against the bytes: a signature table in
  `media/sniff.rs` (png, jpeg, gif, webp, heic and heif brands, mp4 and m4a
  brands, ogg, webm, mp3, wav, pdf). a declared image, audio or video type
  the bytes contradict is 415 in words. any other kind is kept as
  declared and served as `attachment`.
- answers 201 `{id, mime, size, filename, durationMs?, waveform?}`, the
  same for bytes it already holds.
- **as built (m9, `media/`, `http/media.rs`).** an upload that cannot fit
  because nothing old enough may go answers 507 `media-full` with the same
  words a copy's notice uses; a body that stops arriving is 400
  `media-incomplete`; a fifth upload's `retry-after` is 5 s. a copy from an
  agent whose declared type its bytes contradict is kept under the type the
  bytes show (an agent cannot be asked to relabel), never refused. copies
  across every source run at most 8 at once in the media task (each source
  still keeps its own 2); a ninth answers busy and its source defers it. a
  serve moves `last_used` at most once a minute, so scrubbing writes no row
  per range. a same-bytes upload keeps the first filename and only fills
  what the first lacked (duration, waveform), and a new pin only lengthens
  the old one. the upload answer's `waveform` is the array of values, as on
  the part. a body that sends nothing for 30 s, or is not whole within 10
  minutes, is dropped (400 `media-incomplete`) and gives its place back;
  server shutdown ends every take in flight (503 `stopping`). whatever a
  caller declares is cleaned before the index sees it (type normalised, a
  generic or missing type replaced by the one the bytes show, filename
  cleaned and cut to 255 bytes, a waveform past 64 values dropped). a
  commit places the new file, writes and commits the rows, and only then
  removes what it evicted. an attachment kind is served as
  `application/octet-stream`, its stored type kept in the json. a pin only
  lengthens; `release(id, until)` lets go only the pin its holder set.
  orphan files younger than an hour survive the startup check.
- **voice notes go to the agent in the form they were recorded.** a device
  records `audio/mp4` (aac in m4a) where it can: the ios app, safari, and
  chromium browsers whose recorder offers it. a browser that records only
  `audio/webm` or `audio/ogg` (opus) uploads that. the server never
  transcodes (decision 33: no audio decoder on the server); the openclaw
  source sends the declared kind, and openclaw runs the same media
  understanding on it as on a whatsapp voice note, which is ogg/opus
  (`openclaw.md`, media). the m9 real loop sends one note of each kind to
  the dev gateway and checks the agent heard it; a kind the gateway turns
  away is dropped from openclaw's `attachments.kinds`, so the composer
  says so before recording rather than after.
- a send names media by id: `attachments: [{media, transcript?}]` on the
  prompt, the new thread and the steer. the server checks each against the
  agent's `attachments` capability (kind, count, and `maxBytes` per file)
  and answers 413 or 415 in words before anything reaches the agent. sends
  no longer carry bytes, so their bodies drop to the small send limit and
  the outbox holds ids, not data urls; the upload is the outbox's first
  step for a message with attachments.
- today's limits (`compose.rs:35-63`: images only, 4 photos, 24 MiB
  together; `http/mod.rs:82`: a 25 MiB body) become the cmx2 agent's
  `attachments` capability. the cmx2 source reads the files from the store
  and builds the `data:` urls cmx2 takes, under today's photo memory
  budget (`http/mod.rs:84-93`), which moves from the route to the source.

### agent-supplied media

copied into the store on first sight, whatever the thread's state,
watched or not, journaled or not: an openclaw download ticket lasts 5
minutes, and a reset or a new session id makes the gateway's record of a
file unservable at once (`openclaw.md`, media). the source queues a copy
when it maps a message with a media block it has no `ready` copy of, sends the part `pending`,
and sends it again `ready` (or `missing`, with a notice) when the copy
ends. a copy streams to disk like an upload, capped at 64 MiB per file
(larger is `missing`, "too large to keep, N MiB"). a full copy queue
defers the copy and never makes a part `missing`; a copy that failed 6
times is `missing` until the source's next sight of the message, which
tries again. a `missing` part that boxbox never held has `id: null`.
audio is fetched in its
playback form (m4a), so every client plays it without a codec of its own.
a cmx2 file part is never copied: its bytes arrive inline as a `data:`
url, bounded by cmx2's own caps, and stay as they are.

### sidecars

your device's transcript of your voice note rides the send
(`attachments[i].transcript`). the server writes it to `media_sidecars`
keyed by media id and thread before it calls the agent, and the source
attaches it to the audio part of every message whose media id matches.
when the agent re-encodes the bytes (the copy back has another hash), the
source matches by the send's client id instead, which its receipts already
carry (`openclaw.md`, sends). the sidecar is never sent to the agent: the
agent transcribes the audio itself, as it does for a voice note from a
channel.

## 7. read state, origin, quotes, new threads, sends, runs

- **read state** stays the fleet's (`fleet/read.rs`): a thread's merged
  mark, in ms on the agent's clock, monotonic per thread, with its `by`
  (device, elsewhere, agent). marking from boxbox is today's `POST
  /api/read`; the source's `mark_read` also tells an agent that keeps read
  state (openclaw), and a read the agent reports from elsewhere (its own
  control ui) arrives as a mark `by: elsewhere`.
- **origin** is on the message (section 1) and, for a thread that lives
  on a channel or is a scheduled run, on the thread. the bubble and a
  window's footer read the message's origin; only the thread's facts line
  reads the thread's. sends from boxbox never carry one.
- **quote replies.** a send with `quote: {message}` names the boxbox id of
  the message it answers; the source maps it to its own reply field
  (openclaw `replyToId`, `openclaw.md`) and refuses with 422 `unsupported`
  if the agent lacks `quotes`. the agent's own quotes arrive as
  `Message.quote`. a quote of a message the client does not hold renders
  from `sender`, `preview` and `glyph` alone; tapping it reads the message
  in when `message` is set.
- **a new thread with an assistant.** `POST /api/agents/{agent}/threads`
  with `{device, deviceClass, clientID, text, attachments, model?,
  effort?}` and, only for an agent with `places`, `place` and `worktree`.
  a place sent to an agent without `places` is 422 `unsupported`; a
  missing place for one with it is 400. the answer is `{key, thread}`,
  idempotent by client id. no directory and no worktree exist for an
  assistant; the composer's place row becomes the agent row (`composer.md`).
  how the openclaw source names the session it creates is `openclaw.md`'s.

### sends: accepted, checking, uncertain

a send must never run twice, and an assistant's runtime cannot always
say whether a send whose answer was lost landed (openclaw's receipt read
reports only custody rows that still exist, and a consumed send's row is
gone, `openclaw.md`, sends). so boxbox never resends on its own when it
cannot prove the send did not land, and says so.

- **generation.** a prompt, steer or queue carries `generation`, the
  `Thread.generation` the client last saw. when it no longer matches, the
  answer is 409 `generation-changed`, "the conversation on <name>
  changed; review and send again", and nothing reaches the agent. a send
  without one is not checked (cmx2, and clients that have not seen one).
- **the answer.** 202 `{state: "accepted", message?}` when the agent
  acknowledged the send. when the acknowledgement was lost (a dropped
  socket, a timeout), boxbox reads the agent's receipts first and answers
  202 `{state: "checking"}` if they have not settled it within the
  route's 10 s; it never answers 5xx for a send that may have reached the
  agent, because outboxes retry a 5xx with the same client id. a 503 or
  422 means nothing reached the agent.
- **the outcome** shows on the thread. the user message with the send's
  `clientID` settles it, as today (`model.rs:489-490`). otherwise
  `Thread.sends` carries `{clientID, state, at}`: `checking` while boxbox
  reads the receipts; `cancelled` when the agent says it cancelled the
  send; `uncertain` when no receipt proves it landed or did not, an
  absent receipt included. the source resends identical bytes only where
  `openclaw.md` proves the send was interrupted before it ran.
- **uncertain is the person's call.** a client shows an `uncertain` send
  as not confirmed ("not confirmed: <name> may not have this. send
  again?") and never retries it. sending again is a new send with a new
  `clientID`, since the old one may have landed. an entry leaves
  `Thread.sends` when its user message arrives or 30 minutes after `at`;
  the client keeps its own not confirmed message in its outbox after that
  until the person sends it again or dismisses it.
- **cmx2** never reports `checking` or `uncertain`: its repeat key makes
  a retry with the same client id safe (`x-cmx2-repeat`), so today's
  outbox rule stands.

- **as built (m9, `source/sends.rs`).** every `/api/agents` send goes
  through one ledger keyed by agent and client id, 256 per connection: the
  first request calls the source in its own task (a dropped client cannot
  cut a send off halfway); a request that arrives while it runs shares its
  answer; one after an answer that may have reached the agent is answered
  from the ledger and never calls again. only a refusal that proves nothing
  reached the agent forgets the id. a source that cannot prove a send did
  not land answers `checking` (never `Unreachable`) and settles it with
  `Sends::resolve`; unsettled after 30 minutes, or pushed out by the cap,
  it ends `uncertain`. a retry of an uncertain or cancelled send answers
  409 `not-confirmed` and nothing is sent. the route's 10 s applies only to
  a source that does not dedupe retries (not cmx2); past it the route
  answers `checking`, the ledger emits `Send {checking}`, and the late
  answer settles it (a refusal then ends `cancelled`, no answer
  `uncertain`, a call that never answers `uncertain` after 30 minutes). a
  new thread past the 10 s answers 202 `checking` too, and the thread comes
  on the stream if it was made. a client id the cap pushed out is kept as a
  tombstone (4,096), so its retry is refused rather than sent. a send whose
  call panicked ends `uncertain` (cmx2: forgotten, since its retry is safe). attachments are checked (kind, count, size per file) and
  pinned before the call, released when the send settles, and a voice
  note's transcript is written with `put_sidecar` first (for a new thread,
  just after the birth, since its key is not known before).

### scheduled runs and the runs window

an assistant runs on its own (scheduled jobs, heartbeats), and most runs
have nothing to say. the order (decision 16: the server ranks windows)
treats them by what they did, not how they began (decision 44):

- **a run that says nothing never shows.** a thread whose turns since the
  last read wrote nothing for you and raised no ask (`said` did not move)
  takes no window, raises no done need and no push, and does not move its
  thread in the order. it stays in history.
- **a run that asks is an ordinary window:** its ask raises a need and
  ranks it like any thread that wants you.
- **a run that talks** joins its assistant's one runs window. the
  order carries the key `<agent>:runs` (never a thread id: no source mints
  `runs`) while the agent has a talking scheduled run unseen, ranked with
  the idle windows below every done thread. its content is `Agent.runs`:
  `unseen` (how many) and up to the 12 newest items, each the run's thread
  key, its job's name, when it spoke and its first words (280 characters
  at most, as a tail line). reading a run's thread (`POST /api/read`)
  sees it, and it leaves the window; clearing `<agent>:runs` (`POST
  /api/clear`) clears every run in it. a talking run raises no done need;
  its push is a separate kind, off unless the device asked for it.
- a run that lands inside a thread that already has a window (a runtime
  that runs its jobs in the main thread) follows the same rules turn by
  turn: a quiet turn leaves that thread where it was.
- cmx2 has no scheduled runs, so none of this touches a cmx2 thread.

## 8. identity

- **name.** an agent is always named with its kind of runtime and its
  machine, the parts of `label` joined with " · ": "cmx · vm-a",
  "assistant · openclaw · vm-b". `label.name` is the config's `name` for
  the agent, else the foreign agent's own display name, else none (every
  cmx2 agent). `label.machine` is the config's `machine`, else the
  connection name. no surface shows a bare host name where it means an
  agent. copy about an assistant uses its name ("assistant is
  thinking", "what assistant said"), never a pronoun, because boxbox
  cannot know which one fits (decision 43). boxbox's own copy carries no
  emoji; an emoji appears only as the content of a reaction (decision
  42).
- **mark.** `square` for a coding agent (the repo mark windows show
  today), `round` for an assistant and for `other`.
- **palettes.** the ten repo palettes stay as they are, and a coding
  agent's thread wears its repo's colour, the one the server gave
  `host:root` (decision 82). beside
  them sit named assistant slots that an agent's config chooses with
  `palette = "<slot>"`; an assistant whose config names none takes the
  slot its key hashes to. the first slot is `coral`: top #5C2129, bottom
  #290B11, light #FFA39A. the slot list and every hex in it are design law
  in `design.md`; this file fixes only the mechanism and coral. every
  thread of an assistant wears its agent's slot, since it has no repo.
- **machines become agents** (decision 45). the machines screen is the agents screen,
  grouped by connection: each agent with its mark, label, status and
  connection facts, and a connection's verbs (pair, forget, and reload and
  restart where `admin` says) on its group. the route is
  `?screen=agents`; `?screen=machines` still opens it, and the launch
  rewrites the url (`canonicalSearch`). every "machine" in the product's
  copy that means an agent says "agent"; "machine" stays only where it
  means the computer (`label.machine`).
- **config.**

  ```toml
  [[cmx2]]                 # [[host]] is the same thing
  name = "vm-a"
  url = "http://vm-a.<tailnet>.ts.net:4096"
  password = "..."

  [[openclaw]]
  name = "vm-b"            # at most 24 characters, so derived agent keys fit
  url = "wss://vm-b.<tailnet>.ts.net:18789"
  token_file = "/etc/boxbox/openclaw-vm-b.token"   # mode 0600 (`openclaw.md`, config)
  machine = "vm-b"

  [openclaw.agents.main]   # optional, per foreign agent id: pins a key, a name, a palette
  key = "assistant"
  name = "assistant"
  palette = "coral"
  ```

  a second openclaw on another machine is one more `[[openclaw]]` entry.
  connection names follow today's host rule (`is_host_name`,
  `config.rs:433-439`) and share one namespace with agent keys (section
  3, collisions). `[cache] transcript_bytes` sets the transcript cache
  (section 4).

## verification

by tier, cheapest first (`verification.md`). the bench gains an openclaw
dev gateway beside the cmx2 dev daemon: the pinned openclaw build, run on
loopback with its own state, config and home, its model answered by a
scripted server (decision 22 is the precedent; `openclaw.md`, the test
gateway, says how). nothing here ever points at a gateway or daemon the
session did not start (AGENTS.md, the live fleet).

1. **types.** `cargo check`, `tsc --noEmit`, the ios build. `just api`
   regenerates the app's types from the utoipa document; the ios drift
   test passes against the new `vendor/boxbox.json` once the ios app
   speaks protocol 3.
2. **unit.**
   - the cmx2 translation table: one test per domain event, frame in,
     `SourceEvent` out.
   - every existing model test (`model.rs:3081` onward, written as cmx2
     frames) passes unchanged through the cmx2 source.
   - protocol 3 over the recorded cmx2 tape (`fleet/replay/tests.rs`,
     `proofs.rs`): the journal applied in order equals the model after
     every step, and a client through view switches, hidden spells and
     dropped streams equals a read at its cursor (`protocol.md`, section
     16; `verification.md`, the protocol 3 goldens).
   - the seam's cmx2 events: `session.idle` keeps a parked thread parked,
     a born thread asks for no tail read, a merged or discarded worktree
     settles its review need, and an ask settle picks its floor by kind.
   - the cmx2 mapping table, row by row, from recorded fixtures (AGENTS.md, integration tests:
     fixtures only for wire parsing).
   - id derivation: fixed vectors for thread ids, message ids and agent
     keys, and the collision refusal.
   - the capability table: every gated route against an agent without its
     capability answers 422 `unsupported`, and nothing reaches the source.
   - media: range answers (206, 200 for several ranges, 416), etag and
     304, 410 after eviction, eviction order with pins and the 24 hour
     floor, sniffing refusals, the upload's memory stays under its buffer.
   - what a source journals: a held thread whose gateway committed more
     rows than a tail while boxbox was away gets every row or a
     `thread.reset`, never a silent gap; a thread with no seen index
     passes the overlap test only when it was never journaled or hydrated
     this epoch.
   - the transcript cache: its caps (200 rows or 2 MiB a thread, the
     total, lru by last open), replaced whole on a reset tail, served
     `stale` with the gateway down, and never consulted by the overlap
     test.
   - sends: a lost acknowledgement with no receipt ends `uncertain` and
     nothing is sent again; a stale `generation` answers 409 and nothing
     reaches the agent.
   - stories: `bun run shots` renders every part kind and media state
     (pending, ready, missing, evicted), the quote row (resolved and not),
     reactions and the unknown kind's fallback row at 390, 820 and 1512.
3. **real loop.** the cmx2 dev daemon, the openclaw dev gateway and the
   boxbox dev server on 3001 with one connection to each, driven with curl
   and agent-browser through the real ui.
   - cmx2 through protocol 3: the scripted session and the exactly-once
     suite (`verification.md`) pass with the web app on protocol 3.
   - the golden answers recorded before the seam match after it:
     `/api/needs` (body), the prompt 202 and 409 bodies, push payloads and
     titles, a pty redial with its cursor, review merge and discard.
   - openclaw: a new thread with no place, text, a voice note up (m4a,
     webm and ogg, each with a device transcript), a spoken reply down (a scripted tts
     directive) with its spoken text, an image both ways, a generated
     file, a quote reply both ways, a reaction, an approval, a question,
     archive, read.
   - chaos, each with the journal and the thread printed after: a socket
     dropped mid turn, the reader's queue full (the source sheds, stops
     reading and catches up), the gateway restarted mid turn, a send
     whose acknowledgement is lost (it ends accepted or not confirmed,
     never twice), the gateway stopped and boxbox restarted (cached
     threads open marked stale),
     an approval answered elsewhere, a copy whose ticket expired, a media
     store with a tiny cap evicting while a client plays.
   - every gated control is absent for the assistant and its route answers
     422 when driven by curl.
4. **devices.** the ios build that speaks protocol 3 (the one from
   before stops connecting, section 2): after a soak with a busy
   assistant beside the cmx2 agents, its counters show 0 gaps, 0
   undecodable frames and 0 dropped (`FleetState.swift`); the assistant's card in coral with a round mark, voice notes
   recorded and played (scrub, speed, locked screen, background), photos
   saved, files opened. the installed phone and mac pwas for the same.
5. **budgets.** idle and steady rss with the journal and two
   connections, and the peak with every source buffer full, against the
   process budget in `architecture.md`; the
   reset snapshot under 256 kb for 300 threads; first byte of the
   media route; an upload at the body limit with the server's memory
   printed; the soak in `m9` with zero reloads.
