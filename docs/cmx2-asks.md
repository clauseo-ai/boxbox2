# what boxbox v2 needs from cmx2

decision 9: gaps in the daemon are asks, never boxbox-side workarounds.
the contract side lives in cmx2 as `docs/engineering/ASKS.md`, one row
per ask with the cmx2 milestone that owns it; this file is the argument:
evidence, v1 scar, and the boxbox milestone each ask gates (`plan.md`).
a new gap is appended to ASKS.md as an unassigned row with the next free
number and argued here under the same number (AGENTS.md, cmx2). facts are
from the cmx2 commit each ask names, and from the commit in `cmx2.pin` where
it names none; line numbers point into that tree.

priority: **gate** means a v2 milestone cannot pass without it; **wanted**
means v2 ships a visibly lesser behaviour until it lands.

| # | ask | priority | gates |
|---|---|---|---|
| a1 | durable event sequence, `id:` on every frame, resume with `Last-Event-ID`, bounded replay, explicit reset | gate | m2 (sync) |
| a2 | every read says which event it reflects | gate | m2 (sync) |
| a3 | bounded per-subscriber buffers on the daemon's own sse | gate | m2 (sync) |
| a4 | client ids for idempotent sends and replies | gate | m3 (composer) |
| a5 | the streaming message is readable mid-stream, and one message is fetchable by id | gate | m3 (thread) |
| a6 | asks: 404 unknown, 409 settled, reject one without the cascade, reject on abort | gate | m4 (asks and push) |
| a7 | the status map lists parked sessions and carries `since` | wanted | m2 |
| a8 | openapi tells the truth about 409s and the part and status unions | wanted | none: generated types tighten when it lands |
| a9 | progress for running tools | wanted | m5 (windows) |
| a10 | usage on the wire: cost, context use, diff totals per session | wanted | m5 (windows) |
| a11 | ids back from `queue` and `prompt_async` | gate | m3 (composer) |
| a12 | pairing: a per-host bearer credential | wanted | m8 (first run) |
| a13 | the event log and the reads agree on a message a restart ended | gate | m2 (sync: the daemon restart case) |
| a14 | a pty resume into dropped output replays the retained tail | wanted | m7 (terminal): until it lands, a pane that fell far behind resets to an empty screen and misses up to its cursor's distance past what cmx2 kept of the next output |
| a15 | imported history stays inside the part union | wanted | m3 (thread): imported sessions read with unknown parts dropped until it lands |
| a16 | a native edit carries its diff and its counts | wanted | m3 (thread): edit rows and the files row show no counts or diff for native turns until it lands |
| a17 | text and reasoning parts carry `time` | landed on 2026-10-01 (0.8.5, contract 5) | none: thoughts show their duration and the tape its thinking channel from the final parts' `time {start, end}`; a transcript recorded before 0.8.5 has no `time` and shows none |
| a18 | a queued or steered prompt keeps its model, effort and agent | wanted | m3 (composer): per-message model and effort ride only an idle prompt; while a turn runs the picker says the choice applies from the next idle send |
| a19 | the queue can be read back | wanted | m3 (composer): queued cards come from this device's own sends and the stream; another device or a cold open after the stream reset shows "n waiting" without their text |
| a20 | a steer says it is a steer | wanted | m3 (composer, thread): a steer is labelled from this device's outbox only; a steer from another device reads as queued |
| a21 | loop says what it ran | wanted | m3 (composer): run now settles on the echo of the message it ran, never on loop's answer |
| a22 | the stalled-subscriber cap holds at the pin (a3 again) | wanted | none in boxbox: its own readers keep up and resume by cursor; the risk is the daemon growing behind other readers. a3 reads `fail` at the pin until it lands |
| a23 | thinking streams; every streamed part is announced | landed on 2026-10-01 (0.8.5, contract 5) | none: the thread and the window can show thinking as it happens, and the reducer takes a part from its announcement |
| a24 | an agent tool part is titled by what it started | wanted | none: the window's tail reads `agent` with no name and `wait for agents` from the tool name until it lands; the thread's rows read the name from the input and the metadata |
| a25 | `/session` pages by a key that breaks ties | wanted | history: reads one ms past the cursor, skips what it showed and widens the page up to 1000; a run of more than 1000 threads sharing one `updated_at` is dropped |
| a26 | a part's final is published when its block ends | landed on 2026-10-02 (0.8.5, contract 5) | none: a thought stops streaming, and its clock stops, when the reply begins; before it lands the row shows a thought thinking for the whole reply after it |
| a27 | a run script's nested calls record what the direct tool would | wanted | the thread: a pack started from a script shows one `run` row, "started 4 agents", and no agent rows or tape lanes; the agents panel and the status line read the agents from the fleet's `parentID` and are whole |
| a28 | a file's bytes can be read | wanted | repo favicons: a repo's name shows no mark beside it until it lands (the route answers 404 and the app keeps the repo-coloured squircle with its initials); the server's lookup is built and tested against the shape below, and a daemon without the route is remembered for 5 minutes, never mistaken for a repo with no icon |
| a29 | `/find/file` does not hold the daemon while it lists | wanted | repo icons and the `@` picker: a lookup guards the worst root (the host's home, `/`) and reads well-known paths before listing, but any big repo still stalls the daemon for as long as its walk takes |
| a30 | a heic or heif file part is converted to jpeg on the host | landed in cmx2 and in the commit in cmx2.pin | the composer: a browser that cannot decode heic (chrome and firefox, desktop and android) sends the original; a daemon without a30 turns the part into a text placeholder ("not a kind the model can read") and the model never sees the photo, so the user converts by hand as before |

## a1. durable event sequence and resume

**today.** each event gets `evt_<Date.now base36>_<++eventSeq>` from one
in-memory counter (`packages/server/src/index.ts:206-207`). it resets when
the daemon restarts, heartbeats and connected frames consume it, and
`/event` filters by directory, so a subscriber sees gaps as normal and
cannot detect a lost event. frames are `data: <json>\n\n` only: no `id:`
line, `Last-Event-ID` is never read, and a new connection gets
`server.connected` and then live events (`index.ts:252-285`). nothing in
`PLAN.md`, `SMALL.md` or `WISHLIST.md` plans it; the documented reconnect
strategy is a rest reconcile (`docs/engineering/BOXBOX.md:15`).

**why it gates.** every "reload the page" bug in v1 traces back to a
stream with no cursor (`scars.md`, resync). v2's promise is exactly-once
delivery across a reconnect, a relaunch and a daemon restart; without a
cursor at the first hop, every later hop is guessing.

**wanted.**

- a `seq` per daemon: a 64-bit integer, strictly increasing, persisted in
  the store so it survives restarts, assigned only to events that change
  state (heartbeats, `server.connected` and `global.disposed` carry
  none). plus an `epoch` string that changes only if the store is reset.
- every sse frame written with `id: <epoch>:<seq>`. the event body
  carries the same `seq` and `epoch`.
- resume: `GET /global/event` honours `Last-Event-ID` (and `?after=` for
  clients that cannot set headers), replaying every stored event after it
  in order, then going live, with no gap and no duplicate at the seam.
- a replay window of at least 30 minutes **and** 50,000 events, whichever
  is longer, read from the store rather than memory.
- when a cursor is older than the window, from another epoch, or from the
  future, the first frame is `stream.reset {reason: "expired" | "epoch" |
  "invalid", seq}` and the client reconciles from rest (a2 makes that
  exact).
- `message.part.delta` gains `offset` (utf-16 units into the part's text
  before this delta), so a consumer can verify contiguity.
- **cmx2's design constraint** (ASKS.md): deltas are not logged. on
  resume, a part that was streaming arrives once as `message.part.updated`
  with its full text at the resume seq, then live deltas continue. boxbox
  treats that `part.updated` as it treats every one: it replaces the part
  whole.

## a2. reads say which event they reflect

**today.** a rest read and the event stream race: an event can be applied
twice (already in the read) or lost (neither). v1 lived with merge
heuristics (`scars.md`: hydration mid-stream).

**wanted.** every read route that returns state (`/session`, `/api/session`,
`/session/:id`, `/session/:id/message`, `/session/status`, `/permission`,
`/question`, `/project`, `/session/:id/agents`, `/session/:id/procs`)
answers with `x-cmx2-seq: <epoch>:<seq>`, the last event seq whose effects
the response includes. a client applies only events after it. this is
what turns "hydrate then stream" into an exact operation.

## a3. bounded buffers on the daemon's own sse

**today.** `controller.enqueue` runs with no `desiredSize` check
(`index.ts:263-268`), so a slow or half-open subscriber's queue grows
without bound in the daemon's memory. this is the same shape as the
queue that ballooned v1's server (`scars.md`, the reconnect
balloon).

**wanted.** a per-subscriber byte cap (1 mb is plenty): when exceeded, the
daemon closes that subscriber's stream. with a1 the subscriber reconnects
and resumes, so dropping is safe and memory is bounded by construction.

## a4. client ids: idempotent sends and replies

**today.** no route accepts an idempotency key or a client message id; the
`messageID` in `runCommand`'s schema is ignored (`index.ts:1171`). a send
that times out on a flaky phone connection cannot be retried safely, and
v1 had to infer "sent" from the text echoing back (`scars.md`: send truth).

**wanted.** an optional `clientID` (a uuid chosen by the client) on
`POST /session/:id/prompt`, `/message`, `/prompt_async`, `/queue`,
`/steer`, `/command`, `/shell`, and on permission and question replies.

- the first request with a given `clientID` acts; a repeat within 24 hours
  returns the first result and does nothing.
- the `clientID` is echoed on every event the action causes
  (`message.updated`, `session.queued`, `session.steered`,
  `permission.replied`, `question.replied`), so the sender knows which
  event is its own without comparing text.

## a5. the streaming message is readable

**today.** an assistant message's parts are written at `message_end` only
(`packages/engine/src/session.ts:607-614`), so text streamed so far is not
fetchable while the message streams. there is no
`GET /session/:id/message/:messageID` (only delete).

**wanted.**

- `GET /session/:id/message` includes the in-flight assistant message
  with its partial text parts (marked `streaming: true`), consistent with
  a2's seq, so a device that opens a thread mid-answer paints the words
  already written and then applies deltas after the seq.
- `GET /session/:id/message/:messageID` returns one `{info, parts}`.

## a6. asks behave like a contract

**today.** a reply to an unknown or already-answered ask returns 200 `true`
(`packages/server/src/asks.ts:9-11, 68-73, 101-115`). `reject` also rejects
every other pending ask in the session (the reject cascade). an interrupt
leaves asks pending.

**wanted.**

- unknown ask id: 404 `NotFoundError`.
- already settled: 409 `ConflictError` with `data: {reply | answers,
  settledAt, by}`, so the ui can say "answered on your mac at 23:49".
- `reject` rejects only that ask; the cascade, if kept, is an explicit
  `{reply: "reject", cascade: true}`.
- aborting a turn rejects its pending asks and emits `permission.replied`
  or `question.rejected` for each, so no surface keeps a dead card.

## a7. status tells the whole story

**today.** `GET /session/status` lists loaded busy sessions only; parked
idle sessions never appear although the manifest promises "every non-idle
session" (`index.ts:1015-1020`). status carries no timestamp, so run
clocks restart on reload.

**wanted.** parked sessions in the map with their parked detail, and
`since` (ms) on every status, busy and parked.

**landed, amended.** cmx2 landed a7 and amended it on
2026-09-30, after this suite's probe showed a parked entry in the plain
map would read as busy to v1, the version in use until cutover: parked
sessions appear only when the client asks with `?parked=true`. v2 always
passes it; the probe asserts both sides.

## a8. openapi tells the truth

- 409 `BusyError` declared on `/message`, `/command` and
  `DELETE /session/:id/message/:mid`, which can all return it
  (`packages/contract/src/generate.ts:306` only declares it on prompt,
  steer and queue).
- `Part` as a discriminated union on `type` (text, reasoning, tool, file,
  compaction and the rest), not `additionalProperties: true` with a free
  string, and `SessionStatus` as a discriminated union. boxbox generates
  rust and typescript from `openapi.json`; a loose schema becomes hand
  decoding, which is how v1 got brittle.
- the `queued` field of `POST /session/:id/prompt`'s 202 in the schema.

## a9. progress for running tools

**today.** a tool part appears as `running` when the model's message ends
and changes when the result lands; nothing arrives in between.

**wanted.** while a shell-like tool runs, a throttled
`message.part.updated` (at most one a second) carrying the last 2 kb of
output. v2's windows use it for live tool lines and rolling counters
(`design.md`); without it they update only when results land.

## a10. usage on the wire

`cost` and token usage per session and per message, the context fill
(`used`, `limit`), and a per-session diff summary (`files`, `additions`,
`deletions`) as fields on `session.updated` and in the session list. v1
computed cost client-side and it starved (`scars.md`: `costUsd`).

## a11. ids from every send

`POST /session/:id/queue` returns no id and publishes no provisional
message; `prompt_async` returns 204 with no body (`index.ts:1132,
1145-1154`). both should return `{messageID}` and publish the provisional
`message.updated {queued: true}` that `/prompt` already does, so the queue
card in the composer is keyed by an id from the first frame.

## a12. pairing

planned for m8 (`docs/engineering/DISTRIBUTION.md`: `cmx2 pair` prints a
url and a one-time token). boxbox wants the exchange to yield a per-host
bearer credential it can revoke, so teammates never type a daemon
password into boxbox (decision 6).

## a13. the log and the reads agree on a message a restart ended

found by m2's exactly-once suite against cmx2 as of 2026-09-30, the daemon restart
case (`bun bench/exactly-once.ts daemon`): a reply streams, the daemon is
stopped and started from the same store, a second reply streams, then the
worker's transcript (built from the event stream) is compared with
`GET /session/:id/message`.

**what happened.** the transcripts differ in one field of the message the
restart cut off. the daemon's own `event_log` holds seq 190,
`message.updated` for it with `finish: "aborted"` and `time: {created:
1790796097646, completed: 1790796099154}` (the restart). the stored row
the read serves has `time: {created: 1790796097646, completed:
1790796097646}`: the projection writes `completed = ctx.completedAt ??
created` (`packages/store/src/projection.ts:143`), while the event at
restart stamps the restart time (`projection.ts:238`, `:249`). the read
answered at an `x-cmx2-seq` past 190.

**why it is a contract miss.** a2: a read is "the state after applying
event `seq` and no later event". applying the log up to that seq gives a
message whose `completed` differs from the read's, so a client that
builds from events and one that reads can never agree, and boxbox's
byte-for-byte check against the read cannot pass for a restart-ended
message. boxbox does not patch it (decision 9): the event is applied as
logged.

**wanted.** the event published for a restart-ended message and the
stored row carry the same info, whichever time is chosen.

## a14. a resume into dropped output replays what is kept

found by the terminal lane (m7), against cmx2 as of 2026-09-30,
unchanged at cmx2's head on 2026-10-01.

**what boxbox does.** the pty relay (architecture: terminals, the 256 kb
cap each way) closes its upstream when live output finds the queue to a
slow browser full, waits for the browser to drain, and redials
`/pty/:id/connect?cursor=N` with the cursor of the last output it
forwarded. cmx2 keeps 64 kb of a terminal's head and 256 kb of its tail
(`packages/procs/src/procs.ts`, `HEAD` and `TAIL`), so after a big burst
`N` often falls in the dropped middle. the contract's answer should be the
retained tail, then the meta frame; the client sees `meta.cursor - N`
exceed what it received, resets, and paints the tail.

**what cmx2 does.** `Terminals.open` asks `Ledger.locate(N)` for the byte
to replay from and a count of characters to skip. `locate` returns the
newest checkpoint at or below `N`; the ledger keeps only the latest 4,096
checkpoints (`MAX_CHECKPOINTS`), so after a long run the answer is
`[0, 0]` and the skip is `N` itself. `procs.attach` then replays from the
head and jumps to the tail (`OutputBuffer.read` never reports the gap to
`attach`), and the skip swallows all of it.

**evidence.** `bun bench/terminal.ts overflow`: a reader with a 4 kb
receive buffer stops reading while `head -c 10485760 /dev/zero | tr '\0'
x | fold -w 99; echo flood-done` runs. the relay's log:

```
terminal lost its host; redialling from the cursor relay=28397a68 host=bench pty=pty_muolzy1y82sq05 cause="overflow" why=255 kb queued for the browser cursor=728634
terminal redialled relay=28397a68 host=bench pty=pty_muolzy1y82sq05 cursor=10697941 replayed=0 dropped=9969307 ms=9908
```

the redial replayed nothing, so `flood-done`, which sits in the retained
tail, never reached the reader. and the skip outlives the replay: whatever
of it the head and tail did not use up is applied to live output after the
meta frame. with cursor 728309 and 327,680 bytes retained, a command typed
after the redial printed about 1,069,771 bytes and the reader got 676,721:
cmx2 swallowed about 393,050 bytes of live output, so the terminal looked
dead until that much had passed (`bun bench/terminal.ts overflow` prints
both counts).

**the ask.** when the byte `locate` finds is below the retained tail,
replay from the tail's first byte with no skip. even with a nearer
checkpoint today's skip drops characters the client never had.

**until then.** the relay and the pane already do the right thing with
the meta frame: the pane resets and says older output was not kept. the
screen stays empty until the terminal has printed past the swallowed
stretch, instead of showing the last 256 kb. it takes a browser more than
256 kb behind during a burst larger than what cmx2 keeps. no workaround
in boxbox (decision 9).
## a15. imported history stays inside the part union

**today.** `Part` is a `oneOf` of text, reasoning, tool and file with a
discriminator (`vendor/cmx2/openapi.json`, pin of 2026-09-30). a session with
`source: cmx` (imported history, browse only) is served raw from the
import: its pages carry `step-start`, `step-finish`, `patch` and
`compaction` parts as well. seen on 2026-10-01 in a 606-message imported
session: four part types outside
the union, on most assistant messages.

**why it matters.** the app's decoders are generated from the contract
(AGENTS.md, typescript). a strict decoder rejects the page; a lenient one
is a boxbox-side parser pretending to understand parts the contract does
not name (decision 9). the thread (`thread.md`, from the wire) needs the
compaction to draw its mark line and the summary card, and nothing else
from the four.

**wanted.** either the four parts are named in the union with their
fields, or the read filters them and carries what a client needs another
way: the compaction as a flag on the user message (the assistant
message already says `summary: true`), the step boundaries as the rows
`/steps` already serves.

**until it lands.** the decoder drops a part whose `type` it does not
know and writes one `wire.unknown_part` telemetry row per page, so the
gap is counted, not hidden.

## a16. a native edit carries its diff and its counts

**today.** a completed `edit` or `write` tool part from a cmx2 turn has
`state.metadata = {path, replacements, line}`: no diff, no `additions`,
no `deletions` (recorded 2026-10-01 against the pinned daemon,
`native-asks.json`, the `edit notes.md` call). imported history carries
`metadata.filediff {patch, additions, deletions}` and `metadata.diff` on
the same tools.

**why it matters.** the edit row shows `+a -d` and opens to its diff; the
files row sums the turn's files; the window's footer counts the diff
(`design.md`, anatomy of a window). a user wants to see what an edit changed
without leaving the thread. without it, a
native turn's edits are names with nothing behind them, and a client that
rereads the file to diff it is guessing at what the model changed.

**wanted.** `filediff` (or `diff` plus `additions` and `deletions`) on
every completed edit and write, the same shape imported history already
has, and the same counts on `file.edited`. a10's per-session summary
stays the total; this is the per-edit truth it is summed from.

**until it lands.** the row shows the file and "no diff was recorded for
this edit"; the files row shows names without counts.

## a17. text and reasoning parts carry `time`

**today (until 0.8.5).** `TextPart` and `ReasoningPart` declared no `time`. imported
history carries `time {start, end}` on both (opencode's shape); native
parts from the pinned daemon do not (recorded 2026-10-01: native text
parts have `id, messageID, sessionID, type, text, synthetic, notice` and
nothing else; at that pin the bench model emitted no reasoning, so the
native reasoning shape was unconfirmed and assumed the same).

**why it matters.** a thought's row says how long it took, the tape draws
a thinking channel from the spans, the live window runs a thinking clock,
and the gap rule ("3 min later") needs to know when a part ended
(`thread.md`, the row, the tape, live). reasoning is read often
and wants a real place.

**wanted.** `time {start, end}` declared on both parts and emitted on
native ones: `start` when the first delta lands, `end` when the part
completes, and `time.start` present on the `message.part.updated` that
announces a streaming part.

**until it lands.** a thought without `time` shows no duration and draws
nothing on the thinking channel; the said row takes the message's
`time.created`.

**landed.** on 2026-10-01 (cmx2 0.8.5, contract 5) both parts declare
`time {start, end?}`: `start` is when the part was announced (its first
delta follows at once), `end` when its block ended (a26; at the first 0.8.5
build, when the step did), and the announcement carries `time.start`. the final `message.part.updated` has both and the
store keeps them, so reads return them. a session recorded before 0.8.5
projects its parts without `time`, so the rule above still holds for old
turns: no duration, nothing on the thinking channel. the bench model's
`[bench:think N MS]` turn emits reasoning, so the native shape is no
longer assumed: it is the one the a23 probe reads.

## a18. a queued or steered prompt keeps its model, effort and agent

**today** (cmx2 as of 2026-10-01, `packages/server/src/index.ts` `promptTurn`).
when the session is busy, the prompt is queued or steered before the model
is applied: the busy branch calls `s.queue(content, {id, clientID})` or
`s.steer(...)` and returns; `setModel` and the effort are reached only on
an idle start. `POST /session/:id/queue` and `/steer` take `TextBody`
(`{clientID, text, parts}`) and cannot carry them at all. the 202 says
`accepted` either way.

**why it matters.** prompts are often sent while a turn
runs (`docs/composer.md`, what the history says). a per-message model or
effort on any of them is dropped without a word, so the composer would
show "opus 5.5, high" on a message the daemon ran on the thread's model:
the send-honesty rule (`design.md`, the composer) broken by the contract.

**wanted.** the queued and steered prompt keeps `model`, `effort` (or
`variant`) and `agent`, applied when it runs (a steer: when the effort can
change, the next request), and `/queue` and `/steer` accept them; or a
400 saying it cannot, so the client can say so. the provisional
`message.updated` carries the chosen model and effort.

**until it lands.** the composer sends model and effort only on an idle
prompt. while a turn runs, the picker reads "from your next message when
the agent is done", and a queued card shows no model of its own.

## a19. the queue can be read back

**today** (cmx2 as of 2026-10-01). provisional messages are published once, as
`message.updated {queued: true}` with `session.queued`, and
`GET /session/:id/message` never includes them; the status carries only
the count (`SessionStatusBusy.queued`), and an idle session after an abort
carries none, though abort leaves the prompts waiting.

**why it matters.** the queue is a first-class surface (decision 16's
cursor at every hop; `composer.md`, sending): a second device, a cold
open, or a stream reset that replaces the fleet cannot draw the queued
cards, unsend one, or say what is waiting behind a turn. home's window
says "working, 1 next" without the "next: ..." line for the same reason
(`docs/home.md`, the gaps).

**wanted.** reads include waiting prompts with `queued: true`, their
provisional ids, text and `clientID`, in queue order (or a
`GET /session/:id/queue` that does), carrying the seq they reflect (a2);
and an idle status that still counts what abort left queued.

**until it lands.** the composer draws the queue from the journal's
provisional messages and this device's outbox; after a reset it shows "n
waiting" from the status count, without their text and without unsend.

## a20. a steer says it is a steer

**today** (cmx2 as of 2026-10-01). a steer and a queued prompt both publish
`message.updated {queued: true}` under a provisional id;
`session.steered {text, clientID}` names no message id, and the landed
message carries nothing that says it arrived mid-turn.

**why it matters.** the thread labels a message "steer, 17:17"
(`thread.md`, anatomy of a turn), and the composer's queue must not show a
steer as a card waiting for the turn to end: the two mean opposite things
about when the agent reads it.

**wanted.** `steer: true` on the provisional message info and on the
landed message info (or `messageID` on `session.steered`), so both reads
and the stream say which is which.

**until it lands.** a steer is labelled from this device's outbox, which
knows the verb it sent; a steer from another device reads as queued.

## a21. loop says what it ran

**today** (cmx2 as of 2026-10-01). `POST /session/:id/loop` answers `true` whether it
drained the queue, found nothing queued, or did nothing because the
session was busy.

**why it matters.** "run now" (stop the turn, run the queue) must be
honest (`design.md`, the composer). a `true` that ran nothing would let a
card say "running" while the prompt still waits.

**wanted.** `{ran: n}` (the prompts it started), with 409 when the session
is busy.

**until it lands.** run now settles on the echo of the message it ran (the
provisional id retired, the transcript id landed), never on loop's
answer, and says "still waiting" when no echo comes within 5 s.

## a22. the stalled-subscriber cap holds at the pin (a3 again)

**today.** at the earlier pin (cmx2 0.8.3, 2026-10-01) a3's probe fails, twice on
2026-10-01 (`just probes 4988`, then `just probes 4988 a3`): a raw socket
that subscribes and never reads is "still open 10 s after 9.3 MiB was
published past it; it was handed 9.3 MiB", and the daemon's rss went from
113 MiB before the burst to a 267 MiB peak and 339 MiB after. every other
ask (a1, a2, a4 to a11) passes at the same pin. a3 passed at the pins of 2026-09-30 and
2026-10-01. cmx2's own review found the same and holds it as d9
(`docs/engineering/REVIEW-2026-10.md`, medium, not root-caused): the
daemon never judges the stream stalled, likely because bun's `node:http`
moves bytes out of `writableLength` into a native buffer once the hop is
full, so the cap reads as drained. its own a3 test (a python stall) still
passes, which is why it went out.

**why it matters.** a3 is what makes a slow reader unable to grow the
daemon: boxbox's upstream watcher is one reader per host and a phone on a
bad network behind a v1 client is another. a daemon that keeps a stalled
subscriber's backlog in memory is the queue that ballooned v1's server
(`scars.md`, the reconnect balloon), now on the machine that
runs the agents.

**wanted.** a3 as written, holding against a stalled reader that is a
real socket with no reads (the probe's), not only a python one: the
subscriber's stream closed once its backlog passes the cap, and the
daemon's rss back near where it started.

**until it lands.** boxbox works around nothing. its own watcher reads
every byte as it arrives and resumes by `Last-Event-ID` when a stream
ends, so boxbox is not the stalled reader; the risk is to the daemon from
other readers, and it is cmx2's to close. a3's probe stays as written and
reads `fail` until then.

## a23. thinking streams; every streamed part is announced

**today (until 0.8.5).** a text part is born by its first
`message.part.delta` (offset 0): no `message.part.updated` names it until
its step lands, so its type is known only from context. a reasoning part
streams nothing: it reaches clients once, whole, when its step ends. the
in-flight read of a `[reasoning, text]` message returned the text part
alone. recorded on 2026-10-01 against 0.8.3 with the bench model's
`[bench:think 50 120]`: 6 s of nothing per thinking step on the wire, and
the app held `1:text 0:reasoning` for a message the daemon held as
`0:reasoning 1:text` (`docs/gotchas.md`, the sync worker).

**why it matters.** a real model can leave 30 s of nothing on the wire
a step. the thread's live row needs to know a thought has started (and a
thinking clock needs its start), a client that opens mid-thought needs the
part typed, and a transcript that is assembled from a stream needs each
part's place before its first word.

**wanted.** every text and reasoning part of a streaming message is
announced when it starts, before its first delta: a logged
`message.part.updated {id, sessionID, messageID, type, text: "",
streaming: true, time: {start}}` in content order; reasoning streams by
`message.part.delta` (`field: "text"`, utf-16 `offset`) exactly as text;
the final updates carry the whole text and `time {start, end}` (a17; a26
says when they come); the
in-flight read returns every started part typed and in order with
`time.start`; resume resends a streaming reasoning part whole before any
delta; deltas are never sent to a part that was not announced.

**landed** on 2026-10-01 (0.8.5, contract 5). `probes/a23.ts` drives a
`[bench:think 24 100]` turn and asserts the announcement before the first
delta for both reasoning parts and the text part, their types and content
order, contiguous offsets, the final `time {start, end}` with the announced
start, and an in-flight read mid-thinking that returns the typed reasoning
part with its text so far. boxbox takes a part from its announcement
(`app/src/sync/reducer.ts`); a delta at offset 0 for a part it was never
told about still creates a text part, because a fleet can hold a daemon at
0.8.3 (`docs/gotchas.md`, a streamed part is born by its first delta).
the session tail keeps reasoning items but does not journal an entry for
their growth: a window renders no thinking (`server/src/fleet/model.rs`,
`Tail::stream`).

## a24. an agent tool part is titled by what it started

**today.** at the 2026-10-01 pin (cmx2 0.8.3) a `spawn` tool part's `state.title` is
`"spawn"`, a `wait` part's is `"wait"` and a `message` part's is
`"message"` (seen on the dev daemon, 2026-10-02: `spawn spawn {"brief":
…, "name": "helper"}`). `read` and `edit` title their path, `shell` its
command. the agent's name is in `state.input.name` when the model gave
one, else only in `state.metadata.agents[0].name` and `metadata.path`
once the call completed.

**why it matters.** the window on home shows a session's last twelve
parts by their titles (`architecture.md`, the fleet model keeps the tail;
`app/src/ui/window/tail.ts`), the composer's live line reads the same
item, and a push's line will too. each of them read "spawn spawn" for an
agent starting and "wait" for a parent waiting on its agents, which is
the one moment the person most wants a name. a window should not have to
carry every tool's input and metadata to say "agent helper".

**wanted.** the title names the thing, as the file tools do: `agent
helper` (the resolved name, the one in `metadata.path`, from the moment
the call is recorded), `wait for agents` or `wait for helper` when the
wait names one, `note to worker_a` for a message.

**until it lands.** the tail reads `agent` with no name and `wait for
agents` from the tool name (`tail.ts`, `SPAWNS` and `WAITS`); the
thread's agent rows read the name from the input and the metadata and are
not affected.

## a25. `/session` pages by a key that breaks ties

**need.** history (docs/home.md) pages every thread a daemon holds, newest
first, through `GET /session?roots=true&limit=&before=`. the answer carries
`x-next-cursor`, the last row's `updated_at`, and `before` is `updated_at <
before`, ordered `updated_at desc, id desc`.

**today.** a cursor that is only a time cannot say where inside one
millisecond a page stopped. boxbox reads `before = edge + 1` and skips what
it already showed (`server/src/http/history.rs`, `Edge`), and asks again
with a larger `limit` (up to the 1000 cmx2 allows) when a full page is all
one millisecond, so a run of up to 1000 threads sharing a millisecond pages
without a loss. measured at 390 and 1512 on the scratch daemon: 33 threads
sharing one `updated_at` came out whole at page sizes 5, 7, 10, 30, 33 and
40; before that read they lost two to four. a run longer than 1000 cannot
be passed, and the rest of its millisecond is dropped.

**why it matters.** a bulk import or a script that touches many sessions
in one transaction stamps them alike. it is rare, and the loss is quiet.

**wanted.** a cursor with a key: `before` accepting `<updated_at>:<id>` (or
a separate `beforeID`) and the next-cursor header answering the same, so a
page continues exactly after its last row. `/session/:id/message` already
continues from an exact position (its `seq` cursor); the session list is
the one read that continues from a time alone.

**until it lands.** the widening read above; a run past 1000 is dropped
and named in docs/open.md.

## a26. a part's final is published when its block ends

**today (until 2026-10-02).** at the first 0.8.5 build a part's final
`message.part.updated` (the whole text, `time {start, end}`, no
`streaming`) was published at the end of the step's message, with the
message's other finals. a thought ends when the reply begins, but its final
came only when the whole step did, so a client that closes a part on its
final showed the thought as still thinking, its clock running, for the
whole reply after it. seen on 2026-10-02 with the bench model's
`[bench:think 50 120]`: the reasoning part streamed 6 s, the reply streamed
6 s more, and the thought's row stayed open, streaming, through all of it.

**why it matters.** the thread's live row opens a thought with a running
clock and an empty box and closes it on the part's final (`thread.md`, the
row, live). a client cannot close it any sooner: the next part's
announcement says a block has ended only by inference, and a part with
`streaming: true` is open until its final (the client rule in cmx2's
contract notes). a stopped clock and a settled thought row are the
difference between a thread that reads as working on the reply and one
that reads as thinking about it.

**wanted.** a part's final is published when its block ends (a provider's
thinking end and text end): logged and numbered, with the whole text and
`time {start, end}` and no `streaming`, ahead of the next part's
announcement, `time.end` no later than that part's `time.start`. the
in-flight read and a resume serve an ended part final, a delta to an ended
part is dropped, and the step's end publishes the final again, identical.

**landed** on 2026-10-02 (0.8.5, contract 5; the shapes did not change, the
manifest's descriptions did). `probes/a26.ts` drives a
`[bench:think 24 100]` turn and asserts the reasoning final is logged and
numbered before the text's announcement and first delta, its `time.end` no
later than the text's `time.start`, an in-flight read during the reply
serving the thought final and the step-end finals agreeing with the early
ones. boxbox needed no code for it: a final replaces the part held by id
(`app/src/sync/reducer.ts`), the thread model turns a part without
`streaming` and with `time.end` into a settled thought with its duration
(`app/src/ui/thread/model.ts`), and the session tail neither shows nor
journals thinking (`server/src/fleet/model.rs`).

## a27. a run script's nested calls record what the direct tool would

**today.** a `run` part's `state.metadata.nested` holds one entry per
helper call, `{helper, tool, ok, ms, permission, rule}`, and nothing of
the tool's own answer: `nestedCall` (`packages/engine/src/calls.ts`)
hands the tool's `details` back to the script and the part keeps only the
decision. a lead that started its pack from one script (seen on a
0.8.3 daemon on 2026-10-02, four `agents.spawn` calls in one
`run`; reproduced on the pinned dev daemon with `[bench:pack 2000 400]`)
has a transcript with no `spawn` part at all, no `child_session_id`
anywhere, and a `run` whose output is `["/root/ink", "/root/chrome", …]`.

**why it matters.** boxbox's ledger names an agent, draws its lane on the
tape and links its report back to the row that started it from the spawn
part's metadata (`docs/thread.md`, from the wire). with the pack started
from a script, the ledger shows one `run` row and the person cannot see
from the transcript which agents that turn started, when, or with what
brief; the agents panel is whole only because it reads the fleet's
`parentID`, not the transcript.

**wanted.** each nested entry carries the tool's `details` the way a
direct call's part carries them as metadata: for `agents.spawn`,
`child_session_id`, `path` and `agents`; for `agents.message`, `to` and
`id`. and the entry's `title` names the thing (a24), so a client can lift
a nested spawn into an agent row without reading the script.

**until it lands.** the `run` row shows the script's first line and
"started N agents" from the nested entries' tool names; the agents panel,
the status line and home's window read the children from the fleet and
are right; the tape has no lane and the ledger no agent row for a
script-started agent.

## a28. a file's bytes can be read

**today.** nothing in cmx2 answers a file's contents. `GET /find/file`
lists relative paths (`packages/server/src/index.ts:1901`, ripgrep's file
list, `.gitignore` held, kept 5 s per directory in
`packages/server/src/find.ts`) and `GET /find/text` returns matching
lines; a request for `GET /file/content` falls to the end of the router
and answers `404 {"name":"NotFoundError","data":{"message":"no route for
GET /file/content"}}` (`index.ts:2466`; read off the pinned dev daemon on
2026-10-02). the tools cmx2 gives a model read files, but only inside a
turn.

**why it matters.** a repo's favicon beside its name is the cheapest way to
tell six repos apart on a phone, and the only
way to get one is to read the file the repo already ships:
`public/favicon.svg`, `app/icon.png`, or, for a Next.js app that draws its
icon in code, the build's prerender at `.next/server/app/icon.body`. boxbox
finds the candidates with `find/file` (recorded below) and has no way to
read any of them. it is a general read, not an icon route: a file preview
in the composer's `@` picker and a diff's full file want the same call.

**what v1 learned** (boxbox v1, `lib/server/repo-icon.ts`, `GOTCHAS.md`),
each of which the shape below answers:

- an extensionless png (`icon.body`) read through an instance route that
  decided its type from the extension came back as mangled text. the type
  comes from the bytes first.
- opencode answered 200 with empty content for a path that did not exist, so
  "no such file" and "an empty file" were the same answer and a missing icon
  looked like a transient. a missing path is a 404 and an empty file is a
  200 with `content-length: 0`.
- a cold instance's `find/file` answers `[]` with a clean 200, and the empty
  answer was cached as "this repo has no icon" for half an hour. boxbox
  keeps that rule (an empty answer from both queries is never a verdict).
  at the pin the same `[]` is what a directory that does not exist answers
  (the `find/file` row below), so an empty answer cannot say which.

**what an unknown directory does today** (read off the pinned dev daemon,
2026-10-02: five `x-cmx2-directory` values that name no directory, then
`POST /global/reload`, which reports `instances`):

| route with an unknown `x-cmx2-directory` | answer | instance made |
|---|---|---|
| `GET /config/providers`, `GET /config` | 200, the default config | yes: `configFor` (`index.ts:435`) keeps one `Config` per directory string in `instances` (`index.ts:170`), never evicted until a reload; 3 requests, `instances: 3` |
| `GET /find/file` | 200 `[]` | no: `instances: 0` after 3 requests. it adds one 5 s listing to `find.ts`'s cache, capped at 32 |

so the v1 hazard holds on `/config` and `/config/providers`: a header with a
path the person never opened costs the daemon an instance that stays until
a reload, and a client that sends one per rendered row grows the map
without bound. `/file/content` must not be a third such route, and boxbox
never sends the header for a directory the host has not proven (a project in
`GET /project`, or the directory of a session in the fleet).

**wanted.** `GET /file/content?path=<relative to the directory>[&max=<bytes>]`
scoped by `x-cmx2-directory` (or `?directory=`, as every route here):

- `200` with the file's raw bytes, `content-length`, an `etag` (a hash of
  the bytes, quoted), and `content-type` sniffed from the magic bytes first
  and the extension second: png, jpeg, gif, webp, avif, ico and svg by
  content; text files by extension; `application/octet-stream` otherwise.
  `packages/tools/src/image.ts:33` (`sniffImage`) already does the image
  half for the `read` tool. `if-none-match` answers 304.
- `404` for a path that does not exist and for a directory, as
  `{"name":"FileNotFoundError","data":{"message":"no file public/x.png"}}`.
  the name differs from the unknown route's `NotFoundError` on purpose: a
  client has to tell "this repo has no such file" from "this daemon has no
  such route" without reading prose, because the first is a verdict about a
  repo and the second is a fact about a daemon (boxbox caches them very
  differently). an unknown or missing directory answers the same 404 and
  creates no instance.
- `403` for a path outside the directory, judged after the path and every
  symlink in it are resolved (`../../etc/passwd`, a link to `/`).
- `max` (default and ceiling 1 MiB): a file over it answers `413` without
  being read into memory, so a client asking for an icon with `max=524288`
  is never handed a movie.
- the manifest declares the route and its three error names, so a generated
  client types them.

**until it lands.** the server's `GET /api/hosts/{host}/repo-icon` reads a
short fixed list of well-known paths first (`favicon.*` at the root, in
`public/` and `static/`, `app/favicon.ico`, `app/icon.*`, `src/app/...`:
`server/src/icons/rank.rs`, `WELL_KNOWN`), and the first read answers the
unknown-route 404. boxbox classifies that as "this host cannot read files",
remembers it for the host for 5 minutes (so a page of repos makes no daemon
calls, then one retry), and answers 404 with `max-age=300`: a repo with no
icon would have been 30 minutes, and a blip is never cached. no listing is
asked for in that state, which matters because of a29. the app shows the
repo-coloured squircle with its initials. recorded under the pin, for the
scratch project the tests are shaped on, `find/file` answers
`public/favicon.png`, `public/favicon.svg` and `node_modules/x/favicon.ico`
(the last of which the server drops). when a28 lands the pin moves, `just
vendor` brings the route into the generated types, and the route's tests
(written against this shape, with a local server that answers it) are
joined by a probe against the daemon.

## a29. `/find/file` does not hold the daemon while it lists

**today.** `listing` (`packages/server/src/find.ts:14-31` at the pin) runs
`spawnSync("rg", ["--files", "--hidden", "-g", "!.git"], {cwd, maxBuffer:
256 MiB, timeout: 10_000})` inside the request handler (`index.ts:1901`),
so the daemon's one event loop, every sse stream and every other request
stand still while ripgrep walks the directory. nothing else is bounded
there: `r.error` and `r.status` are never read, so a walk cut by the
timeout or the buffer answers whatever `r.stdout` held and caches it for 5
s as the directory's whole listing, and the next request after the 5 s
pays the walk again. `findText` beside it uses `Bun.spawn` and does not
block.

what a walk costs, read off the pinned dev daemon (2026-10-02, a scratch
tree of 300,000 empty files, warm file cache): `find/file` answered in
0.25 s, and a `/global/health` sent 50 ms into it answered in 137 ms where
it answers in 1 ms idle. the stall is the walk's length, so a directory
that is a person's home or `/` (a session started in `~` makes it a
project: `projectOf` is the git toplevel or the directory itself) holds
the daemon for the full 10 s, per request, and on macOS the walk can
raise a privacy prompt per protected folder.

**why it matters.** boxbox asks `find/file` for a repo's icon and for the
`@` picker. a lookup against a big root is a 10 s outage for every
client of that daemon, and boxbox's own call has to wait past the 10 s or
leave the daemon stalled with nobody listening.

**what boxbox does, and no more.** it never lists a directory that is the
host user's home or above it (the class `refused`, read from
`/global/fs`), it reads well-known paths through a28 before any listing,
and its `find/file` call waits 15 s. that is a guard against the worst
root, not a fix: any big repo still stalls the daemon for as long as its
walk takes, and the picker's own `find/file` calls are unguarded here.

**a decision, recorded.** at the pin a listing cut at ripgrep's 10 s is
answered as a plain 200 with nothing to say it was cut, so boxbox cannot
tell it from a whole one. it takes it as whole: a repo whose icon lies past
the cut is "no icon" for 30 minutes. the other reading, transient, would
ask a daemon that stalls for 10 s per walk again every 15 s (the retry
memory) for as long as the repo is on screen, which is the very outage
this ask is about. when a29 lands, a listing answered with `x-truncated:
true` is a transient with a long memory, never a verdict.

**a second gap, the same route's neighbour.** `/global/fs` answers `home` as
`homedir()` (`fs.ts:9` at the pin), unresolved, while every session's
directory and `projectID` is resolved (`directoryOf` resolves what it is
given). on a host whose home is a symlink, the root a session proves
(`/data/me`) never equals the home the daemon names (`/home/me`), and the
`refused` check cannot match. wanted: `home` with its symlinks resolved, as
every directory the daemon names elsewhere is. until then a symlinked home
is not recognized and a lookup against it walks it.

**wanted.** `/find/file` lists with an asynchronous ripgrep (as `findText`
does), so no other request waits for it; at most one walk per directory at
a time, concurrent asks sharing it; a deadline that answers what was found
with `x-truncated: true` (as `/find/text` does) and does not cache a cut or
failed listing as if it were whole; and `/global/fs` answering `home` with
its symlinks resolved.

## a30. a heic or heif file part is converted to jpeg on the host

**today.** `blocksOf` (`packages/server/src/parts.ts:96` at the pin) takes a
`file` part with a `data:` url and hands an `image/png`, `image/jpeg`,
`image/webp` or `image/gif` to the resizer; every other kind becomes a
synthetic text block, `<file path="x.heic">\n(image/heic, 3412209 bytes; not
a kind the model can read)\n</file>` (`parts.ts:121`). the send does not fail.
it lands, the model reads the placeholder, and the agent's first words are
that it could not see the photo.

**why it matters.** an iphone's photo is heic by default, and people send
photos from a phone's browser and a mac's. safari decodes heic and
boxbox converts it to jpeg before it goes, but chrome and firefox, on the
desktop and on android, cannot decode it at all (`createImageBitmap` throws,
and chrome often gives a `.heic` file an empty type), so a photo from the
phone's library could not be attached from them: the composer said "save it
as a jpeg or png" and the user had to convert by hand, one photo at a time, which is
the thing a client is for. a client cannot convert it without a wasm
decoder (libheif is a few megabytes of script and a dependency for
something the host already has: macos converts with `sips`, linux with
libheif's `heif-convert` or imagemagick). conversion is the runtime's job,
once, for every client of the daemon: the tui and any other client that
sends a photo from a phone's library needs the same, and the one place that
already resizes every image to the size the models read is the host's
resizer.

**what boxbox does, and no more.** where the browser can decode it (safari)
the composer converts it itself, as before. where it cannot, it sends the
original bytes as a `file` part with mime `image/heic` or `image/heif` and a
`data:` url of that kind, under limits of its own: a file of 9 MiB for one
photo (12 MiB as a data url; a phone's heic is 2 to 5 MB and a 48 mp one about
9, and the models read the converted photo at 1568 px whatever it started as)
and 18 MiB of files for all the photos of one message
(`docs/composer.md`, "a heic the browser cannot decode goes as it is"). it
gives the daemon 15 s plus the time to take the bytes at 256 KiB a second and
75 s for each conversion (cmx2 gives one 60 s in all, and the rest is margin)
to answer the send. a file over the limit is
refused on the device, in words that say its size and what to do. against a
daemon without this ask the message lands with the placeholder above; the
contract carries no field that says a daemon converts, so boxbox cannot
tell and sends anyway.

**status.** landed in cmx2 ("heic and heif intake: every heic is converted
to an upright jpeg without exif before a provider sees it") and is in the
commit in cmx2.pin. a daemon from before it still answers the placeholder.
boxbox's side is done and does not wait for it. what the daemon does,
driven here on an earlier commit: a real `.heic` sent as a `file` part by a new thread and by a
reply came back as an `image/jpeg` part with the client's filename, and the
model described the picture.

**wanted.** `blocksOf` treats `image/heic` and `image/heif` as an image kind:
the bytes are converted to jpeg on the host before the resizer, so the model
gets the same block it would for a jpeg; a browser that cannot name the
file sends it untyped, so the bytes' own `ftyp` brand decides when the mime
is empty or generic; a conversion that fails (no converter on the host, a
corrupt file) is the same kind of synthetic text block, with the reason in
it ("this host has no converter for heic, so only its name came through",
as the pdf's does), never a failed send; the converter runs off the event
loop and is bounded in time and output, as a pdf's `pdftotext` is (30 s,
16 MiB). no shape change in the contract: `PartInput` already carries
`mime` and `url`.
