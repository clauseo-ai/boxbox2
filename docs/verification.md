# verification

the bench v2 is judged on. claims (AGENTS.md, working): say what you
checked and how, and never call something verified that you did not
check. a passing build shows it builds and a unit test shows its unit;
only a run against a real cmx2 daemon shows the path end to end.

## the tiers, cheapest first

use the narrowest tier that answers the question, then climb.

1. **types**: `cargo check`, `tsc --noEmit`.
2. **unit**: `cargo test`, `bun test` (reducer, decide(), tail grammar,
   order, schema). fixtures only for wire parsing (recorded frames).
   for the thread, the stories (`app/.ladle`, `thread.md`, verification):
   `bun run shots` in `app/` renders every part type and state from the
   scrubbed fixtures at 390, 820 and 1512 wide, runs the craft check on
   each and fails on any finding or console error.
3. **real loop**: a cmx2 dev daemon plus the boxbox dev server, driven
   with curl and agent-browser through the real ui.
4. **devices**: the real iphone and ipad as installed pwas over the
   tailnet, and the installed mac chromium pwa.
5. **budgets and soaks**: the timed runs below.

## the bench

- **cmx2 dev daemon**: `just cmx2`, built from the commit in `cmx2.pin`
  (exported with `git archive` into `.cmx2/<pin>/`, never the cmx2 working
  tree), on a port from 4840 to 4849, with its own data dir and a bench
  password, started with `env -u CMX2_SERVER_PASSWORD -u
  OPENCODE_SERVER_PASSWORD` plus the bench password so it never inherits a
  real one. never port 4096, never a fleet machine's serve.
  concretely (`scripts/cmx2.ts`): the daemon listens on 4840 (`CMX2_PORT`
  moves it within 4840 to 4848), its config, data and home live under
  `.cmx2/bench/`, and its environment is an allowlist (path, locale, tmp,
  a bench home and bash, the bench dirs, the bench password), which is
  stronger than unsetting names: no provider key or config of the user's
  can reach it.
- **the bench model** (decision 22): `bench/model.ts` on the next port
  (4841) stands in for the anthropic api the daemon's provider calls. the
  prompt's marker picks the script: `[bench:tools]` reads `notes.md`, edits
  it, runs `wc -l`, asks which greeting to use, then answers in prose;
  `[bench:words N MS]` streams N words, one every MS ms; `[bench:think N MS]` is a
  native turn with extended thinking: a step that streams N thinking words, one
  every MS ms, then runs `git status`, then a step that thinks the same way and
  streams N words of answer (reasoning and text parts in one message, as a real
  model's are).
- **boxbox dev server**: `just dev` on 3001, with a bench `boxbox.toml`
  pointing at the dev daemon, a bench data dir and its own cookie name.
  `just cmx2` writes both bench configs (`.cmx2/bench/boxbox.toml` for the
  release binary, `boxbox.dev.toml` for the dev server) with a minted gate
  password.
- **agent-browser** drives the real ui through the accessibility tree
  (`snapshot -i`, act by ref). every interactive element has a real,
  unique name; a control the drive cannot name is a bug.
- **widths**: 390 × 844 (phone, deck), 820 × 1180 (ipad portrait, strip),
  1180 × 820 (ipad landscape, rail), 1512 × 945 (mac, rail with details),
  1080 × 1920 (portrait monitor, strip). screenshots are taken and looked
  at, and described in the transcript.
- **fake serial port** for the board daemon: a virtual `node-hid` device
  in the daemon's own process, emulating the board's firmware, driven by
  the recorded trace (`docs/board-verification.md`).
- parallel worktrees: each session takes its own decade for the daemon
  (`just cmx2 --port 4870 --boxbox-port 3011`), so benches never collide.
- push: `just push-harness` delivers a real push to google chrome with the
  app closed and prints the payload and its telemetry (`push.md`).
- teardown: every daemon and server a session starts is killed before
  the goal completes, with `ps` printed.

## the probes for cmx2's asks (the opening step of m2, m3 and m4)

`just probes <port>` (`probes/`) is the contract suite for asks a1 to a11, a23 and a26,
one probe per ask, each asserting the contract exactly as cmx2's
`docs/engineering/ASKS.md` states it. it is the first thing a gated
milestone runs after moving the pin, before any code is written against
the asks; `just probes <port> a1 a2 a3` runs a subset.

**what it starts.** the probes own their daemon, because a1 kills it with
sigkill and restarts it and a3 samples its rss: cmx2 from `cmx2.pin` on
`<port>` (4840 to 4848) and the bench model on the next port, with a fresh
store under `.cmx2/probes/` every run. if either port answers, the run
refuses; it never attaches to a daemon it did not start. both are stopped
before the table prints. `.cmx2/probes/daemon.log` and `requests.log`
(every call, status, latency and body head) stay for reading.

**what "landed" means.** an ask is landed when its row in ASKS.md *at the
pinned commit* says so in the owner cell ("m6, landed at abc1234"; never
"not landed", never the shape's prose). no ASKS.md at the pin means
nothing is landed.

**what each probe asserts**, in order; the first assertion that fails ends
that probe and is the one the table names:

| ask | assertions |
|---|---|
| a1 | `server.connected` carries no seq; every state-changing frame has `id: <epoch>:<seq>` and the same epoch and seq in its body; seq strictly increases; `Last-Event-ID` replays every event after the cursor byte for byte (against a witness stream open all along) and goes live with no gap or duplicate; `?after=` and `/event` replay the same; after a sigkill and restart the events after an early cursor replay byte-identical and seq keeps rising in the same epoch; a cursor from another epoch gets `stream.reset {reason: "epoch", seq}` as the first frame, one from the future or malformed `reason: "invalid"` ("expired" needs 30 minutes and 50,000 events of history and is not probed); `message.part.delta` has `offset` in utf-16 units (the glyph script makes units, code points and bytes disagree); a part streaming at the resume point comes back once as `message.part.updated` with its full text before any delta, and its text plus the live deltas after it is the finished part |
| a2 | each of the ten listed reads answers `x-cmx2-seq: <epoch>:<seq>` in the stream's epoch and not behind what the stream had delivered; 40 renames raced against reads of the session: every read shows exactly the title the events up to its seq set |
| a3 | a raw socket subscribes and never reads while an 18 mib burst streams; the daemon closes that stream, and at most 4 mib (the 1 mib cap plus loopback socket buffers) reached it; daemon rss before, peak and after printed |
| a4 | `/prompt`, `/prompt_async`, `/message`, `/queue`, `/steer`, `/command`, `/shell`, a permission reply and a question reply, each sent twice with one uuid: the repeat returns the first result byte for byte (the json text; the one space a blocking send writes before its body to hold the connection is not part of the result), the transcript holds the action once, and an event it caused carries the `clientID` |
| a5 | mid-stream, `GET /session/:id/message` lists the in-flight assistant message with its text part `streaming: true`, holding what had streamed, with `x-cmx2-seq`; `GET /session/:id/message/:messageID` answers `{info, parts}` mid-stream and, after the turn, equals the listing's entry; an unknown id is 404 |
| a6 | a reply or reject for an unknown ask id is 404 `NotFoundError`; with a permission pending in each of two sessions (the daemon raises a turn's asks one at a time, as each settles), reject settles only the one it names; a second reply is 409 `ConflictError` with `data: {reply \| answers, settledAt, by}`; aborting a turn emits `permission.replied reject` or `question.rejected` for what it left pending and neither stays listed |
| a7 | as amended on 2026-09-30: a session parked on a background job is in `GET /session/status?parked=true` with `parked.jobs` (v2 always passes it) and absent from the plain read, which v1 reads as busy; parked and busy statuses carry `since` in ms |
| a8 | in the pinned commit's `openapi.json`: 409 on `POST /message`, `POST /command` and `DELETE /message/:mid`; `Part` and `SessionStatus` unions discriminated on `type`; `queued` on the 202 of `/prompt` |
| a9 | a 6 s shell command printing 900 bytes a second: at least three `running` updates with output, never two within 900 ms, each at most 2048 bytes and the tail of the output |
| a10 | `session.updated` and the session list carry `cost`, `tokens`, `context {used, limit}` and `summary {files, additions, deletions}` |
| a11 | on a busy session `/queue` and `/prompt_async` answer `{messageID}` and publish `message.updated {queued: true}` for it; on an idle one, `prompt_async`'s id is the user message the turn ran |
| a23 | over a `[bench:think 24 100]` turn: the reasoning and the text parts are each announced (a logged `message.part.updated`, empty text, `streaming: true`, `time.start`) before their first delta, in content order, with deltas at contiguous utf-16 offsets from 0; the final parts carry `time {start, end}` with the announced start and the text that streamed (a26 says when they come); an in-flight read mid-thinking returns the reasoning part typed with its text so far, and after the turn the message reads reasoning then text with `time.end` |
| a26 | over a `[bench:think 24 100]` turn: the reasoning part's final (the whole text, `time {start, end}`, no `streaming`) is a logged, numbered `message.part.updated` that arrives before the text part's announcement and first delta, its `time.end` no later than the text's `time.start`; a read taken while the reply streams serves the thought final; the final parts the step's end publishes agree with the early ones (same text, same `time`) |

**the output.** each probe prints its assertions as they pass (`ok`), then
the one that stopped it (`fail` for a contract miss, `error` when the bench
could not get the probe to the point of asking) with what was seen
instead. then the table: the ask, whether ASKS.md marks it landed, the
result, how many assertions passed, seconds, and the first failing
assertion with its evidence on the next line:

```
ask  landed  result         ok  secs  first failing assertion
a1   no      expected fail   1   0.0  every state-changing frame carries id: <epoch>:<seq>
                                   session.created arrived with no id: line
a3   no      expected fail   0  11.3  the daemon closed the stalled subscriber's stream
                                   still open 10 s after 18.0 MiB was published past it; it was handed 18.2 MiB
a8   no      expected fail   0   0.0  POST /session/{sessionID}/message declares its 409
                                   it declares 200, 400, 401, 404

0 pass, 11 expected fail, 0 fail, 0 error
```

| result | means | exit |
|---|---|---|
| `pass` | every assertion held on a landed ask | 0 |
| `pass (early)` | every assertion held on an ask ASKS.md does not mark landed | 0 |
| `expected fail` | an assertion failed on an ask not yet landed | 0 |
| `fail` | an assertion failed on an ask marked landed: the milestone stops | 1 |
| `error` | the probe could not reach its assertions (bench, timeout, a throw) | 1 |

a milestone's gate needs `pass` on every ask it depends on (m2: a1 to a3;
m3: a4, a5, a11; m4: a6). only the assertions up to the first failure have
run against a real daemon; the rest are proven only when the ask lands.

## the scripted session

used by m1 onward: one prompt that calls tools (a read, an edit, a shell
command), a question the agent asks and the bench answers, a prompt
queued while busy, an unsend, a run-now, and an abort. the same script
drives every tier so numbers compare across milestones.

`bun bench/session.ts` drives it against the dev daemon: the tools prompt;
while the question waits, two prompts queued and the second unsent; the
answer; run now while the reply streams (abort, then `loop` runs the
queue); a 400-word reply aborted mid-stream. it prints each call and the
events it saw by type, so boxbox's count can be compared with the
daemon's. `bun bench/session.ts --words N` streams one reply of N words
instead (N delta events), for the memory run.

## the thread drive (m3)

`bun bench/thread.ts [--boxbox http://127.0.0.1:3051] [--replies 50]
[--only 1,2,3,4,5,6]`, with `just cmx2 --port <p>` and `BOXBOX_PORT=<b>
just dev` running (for example ports 4920 and 3051). it signs in
through the gate, makes sessions on the daemon with the bench model's
scripts, and drives agent-browser through the accessibility tree, checking
each step and printing a line for it (`--only` runs some scenarios; 4
needs 1 and 5 needs 2):

1. **reading**: a `[bench:tools]` turn on stage at 390: the rows read,
   edit, run and the pending ask, the status line "wants you", the ask's
   options named in the tree; `answer hi` tapped by its name; the daemon's
   question list empty; the ask gone from the stream; the row `answered`.
2. **asks one at a time**: a `[bench:asks]` turn at 820: the first
   permission risen out of the live window with its options; allow once,
   allow once, answer hi, answer later, each as the daemon raises it; all
   four settled.
3. **mid-answer**: a `[bench:words 700 40]` turn opened after 2.5 s shows
   partial text that grows; a reload mid-answer paints what was written
   inside 1.5 s of the reload command and keeps growing.
4. **a deep link** at 1512: `?thread=&at=&part=` opens and shows the
   answered row; the turns panel open in the screenshot.
5. **widths**: the settled asks turn at 390, 820 and 1512.
6. **the perf row**: more `[bench:asks]` turns answered until 50 replies
   have gone, then, from the telemetry the server wrote
   (`.cmx2/bench/boxbox-data/telemetry`), `perf.send verb=reply` p50, p90
   and max, and `perf.thread` for the thread's first frame (cached and
   not), a row opening and a stream event to a glyph.

every screenshot (`bench/shots/`, gitignored) runs the craft check
(`app/.ladle/craft.js`) on the thread's stage (`window.__craftRoot`; home's
windows beneath it on the deck are home's gate): no text within 8 px of
its surface's edge, no sibling surfaces closer than 6 px, no surface
within 12 px of the screen's edge. every scenario ends by reading the page's uncaught errors and
rejections (each page gets a listener that writes them to the console,
since agent-browser's console holds `console.*` calls only) and fails on
any. a click that does not land prints what agent-browser answered and
the buttons the tree holds. the run fails on any check.

## the exactly-once suite (m2)

step one of m2 is the probes above, `just probes 4840 a1 a2 a3` against
the moved pin, printed with a1 to a3 at `pass`. then, with the scripted
session streaming, for each disruption:

1. drop the browser's connection 20 times at random moments.
2. restart the boxbox server.
3. restart the cmx2 daemon.
4. hide the tab for 10 minutes (and on the phone, lock it).

after each: the worker's transcript for the session equals the daemon's
`GET /session/:id/message` byte for byte (diff printed, empty); the
reducer's duplicate-apply counter is zero; the ui never showed a
"reconnecting" state for a resume under 5 s.

the stalled reader: a client that connects and stops reading for 10
minutes while the fleet streams. server rss sampled every 10 s is flat;
the stream is closed at the 512 kb cap; the client resumes cleanly.

how it is driven: `just build && bun bench/exactly-once.ts [case ...]
[--hidden-minutes 10] [--with-stalled]` owns every process it uses (the
pinned daemon, the release binary on 3001 with the bench config, and
`bench/cut.ts`, a relay on 3003 that destroys every connection through it
on `SIGUSR2`, so a "drop" is a real broken socket to the page and to the
server). the browser is agent-browser's, loading the app through the
relay. per case it opens a fresh session in the app, streams a scripted
reply into it through the daemon, disrupts mid-stream, waits for the
daemon to settle the session, and compares `window.boxbox.transcript(key)`
with the daemon's `GET /session/:id/message` byte for byte, printing the
reducer's counters (`duplicates` must be 0; `covered` counts the expected
overlap between a hydration and the entries after it). cases: `drops`
(20 cuts), `server` (the binary stopped and started: a new journal epoch,
so a reset and a rehydration), `daemon` (cmx2 stopped and started from
the same store, then a second reply), `hidden` (the tab behind another
for the given minutes), `reload` (a full page reload mid-answer: the
characters painted from indexeddb before the stream resumes, then the
reply continuing). `bench/stalled.ts --minutes 10 --load` is the stalled
reader; `--with-stalled` runs it beside the `hidden` case.

## the push matrix (m4)

each row fires the event and prints the `push.decided` row, then checks
delivery on a real subscribed browser:

| row | expected |
|---|---|
| ask, the thread on stage on this device, input 10 s ago | no push, reason `watched` |
| ask, the thread watched on another device | no push, reason `watched` |
| ask, visible but not focused (another app in front) | push to every enabled device |
| ask, every device hidden | push |
| done, a turn the user started, all hidden | push after 10 s |
| done, then the agent continues within 10 s | no push, reason `continued` |
| done, a turn nobody started | no push, reason `not-armed` |
| the user's own interrupt | no push, reason `own-action` |
| a subagent finishing | no push, reason `subagent` |
| a replayed event after a reconnect | no push, reason `replayed` |

plus: an ask answered on one client disappears from another in under 1 s
(timestamps printed); a reply to a settled ask shows who answered and when.

**how it runs.** `bun bench/needs.ts` drives every row against the
release binary on the bench config and the pinned daemon, through
boxbox's own api: fresh threads, the bench model's scripts (`[bench:tools]`
for a question, `[bench:words]` for a done, `[bench:agent]` for a
subagent), presence of other devices over `POST /api/presence`, a stop
over `POST .../abort`, a turn started behind boxbox's back straight on the
daemon (not armed). it prints each row's `push.decided` row, then the
cross-client clear with two `GET /api/stream` readers, the 409 for a late
reply, and `GET /api/needs` with its `x-boxbox-seq`. the replayed row
needs a server restart between `--phase leave-open` and `--phase replayed
<need id>`. `just push-harness --headed --need matrix` runs it with a real
chrome subscribed and the app closed, and shows every push the matrix
decided to send arriving in the service worker; `--need permission
--await-tap 90` delivers a real permission and, when the banner is
clicked, reads the focused ask card back from the page it opened.

## the budget run (m5)

on a real ipad and a real iphone, installed pwas, over
the tailnet, build id printed. every number comes from `perf.*` telemetry
rows or a performance trace, raw rows printed.

| budget (`design.md`) | method | target |
|---|---|---|
| cold launch to cached paint | 20 launches from a killed app | p50 300 ms, p90 700 ms |
| tap to first frame | `perf.paint` over 50 opens | 1 frame |
| transitions | frame timing during 20 opens, closes and pours | no dropped frames at 60 fps |
| stream event to glyph | host timestamp to paint, 200 deltas | p90 150 ms |
| send to acknowledged | 50 sends | p90 400 ms |
| long tasks | performance trace during 2 minutes of streaming and scrolling | none over 50 ms |
| layout shift | cumulative, whole session | 0 |
| client memory | 8 hour soak with the fleet active | heap under 150 mb |
| server memory | 8 hour soak, 3 hosts | steady rss 64 mb |
| reloads | `app.boot reason=reload` over the soak | 0 needed |
| idle cost, home visible | `bench/idle.ts` mode `home`, 3 minutes with the fleet streaming; field: `perf.sync` | main thread 3% of a core, 6 mb/s allocated |
| idle cost, a thread streaming | `bench/idle.ts` mode `thread`; field: `perf.sync`, `perf.longtask` | no long task over 50 ms, main thread 8% of a core |
| idle cost, hidden | `bench/idle.ts` mode `hidden`; field: `perf.sync` | main thread 2% of a core |
| idle cost, worker and memory | `bench/idle.ts`, every mode; field: `perf.sync` | worker 2% of a core; page and worker heap floors grow under 5 mb a window; page peak 64 mb |
| idle cost per worker post | `bench/idle.ts` modes `home` and `thread`; field: `perf.sync` (patches posted) | home 2.5 ms and 1.1 layouts a post; a streaming thread 3 ms a post |
| dom writes that change nothing | `bench/idle.ts`, every mode (a MutationObserver) | 0 a minute |

the per-minute rows compare builds only at similar worker posts a minute
and similar load: the post rate sets how many frames, layouts and paints
there are (reading the rendering numbers, below). the per-post rows and
the dom-write row do not move with it, so they are the gate between runs
on a busy machine.

### the idle run

`just build && just idle` (`bun bench/idle.ts`; `--minutes 3 --warm 20
--streams 10 --done 100 --only home,thread,hidden`, `--keep-traces` keeps
the traces under /tmp/boxbox-idle). it owns its world as `bench/windows.ts`
does, on the dev ports (the pinned daemon on 4840, the bench model on 4841,
the release binary on 3001; `IDLE_DAEMON_PORT`, `IDLE_BOXBOX_PORT` move
them; `CMX2_REPO` names the cmx2 checkout), refuses ports that answer, and
stops everything it started, printing what still listens (nothing). the
fleet is ten threads streaming a word every 60 ms for the whole run (five
do a window's worth of tool work first), their prompts sent 20 ms apart
from one start so their words fall the same way against the server's
500 ms session ticks (`model::TAIL_EVERY_MS`) every run, a hundred done, and one quiet
thread. a counting proxy in front of boxbox sees every byte the page and
its worker receive. each mode loads the page fresh, settles 20 s, then
measures with a chromium trace in 30 s chunks (a busy page traces at about
2 mb/s): main thread busy (the union of top-level tasks, cross-checked
against `Performance.getMetrics` TaskDuration, within 4%) split by self
time into script, style, layout, paint and gc; long tasks from the trace
and a `longtask` observer; the sync worker's busy time and gc; each
thread's heap floor after gc and allocation rate from the gc events (the
worker's heap is readable no other way); worker posts a minute and, per
post, main thread ms, layouts and paints; frames a second; the dom writes
a minute from a MutationObserver (by kind, by nearest class, and those
that set the value already there); the load average at each mode's start
and end; the page heap every 5 s; the
renderer's and all of chrome's cpu from `SystemInfo.getProcessInfo`;
bytes received. it prints one `IDLE_RAW` json line per mode, a summary
table, the build id and commit, and each budget (`design.md`, buttery as
numbers), exiting 1 when one is missed. `--minutes 10 --only home` is the
ten minute flat-heap check.

what it cannot answer: it is headless chromium, not webkit (playwright's
webkit is not installed here and has no readable trace), so absolute
numbers are not an iphone's; chromium also writes indexeddb in its browser
process, so the worker's share is smaller than webkit's (the chrome column
counts every process). headless chromium never reports a page hidden, and
minimising a window under automation does not either, so `hidden`
overrides `document.visibilityState` and `document.hidden` and fires
`visibilitychange`: the app takes its hidden path while the browser keeps
producing frames, the worst case and, by the investigation, perhaps the
field case of a mac whose display is asleep.

the baseline, main f8f04d1, 2026-10-20, chrome for testing 155, a mac mini
(the second of two runs; the first within 0.7 points of core in every mode):

| mode | main % core | script | style | layout | paint | gc ms/min | long > 50 ms | worker % | renderer % | chrome % | page heap start, peak, end mb | alloc mb/s | kb/s in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| home | 4.8 | 2083 | 36 | 235 | 158 | 50 | 0 | 0.6 | 8.5 | 14.0 | 34, 42, 28 | 15.2 | 140 |
| thread | 12.6 | 3623 | 423 | 1610 | 896 | 89 | 0 | 0.8 | 22.0 | 37.7 | 22, 35, 29 | 22.8 | 155 |
| hidden | 3.9 | 1671 | 31 | 214 | 133 | 39 | 0 | 0.6 | 6.8 | 11.3 | 38, 40, 38 | 12.8 | 142 |

after the wire, cache, render and reactive work (b2a43eb, main merged at
35917b7), 2026-10-21, two runs, both with load averages of 10 to 17 from
other work on the machine:

| mode | main % core | script | style | layout | paint | gc ms/min | long > 50 ms | worker % | renderer % | chrome % | page heap start, peak, end mb | alloc mb/s | kb/s in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| home | 4.0, 2.9 | 927, 660 | 65, 113 | 622, 415 | 342, 209 | 23, 20 | 0 | 1.4, 1.1 | 8.4, 6.0 | 15.7, 11.3 | 24, 27, 18; 22, 30, 21 | 1.3, 1.3 | 140 |
| thread | 14.7, 12.6 | 2600, 2169 | 792, 777 | 2595, 2150 | 1472, 1231 | 73, 71 | 0 | 1.2, 1.1 | 24.6, 22.1 | 43.7, 40.5 | 20, 25, 19; 22, 27, 21 | 6.5, 6.4 | 155 |
| hidden | 1.6, 2.1 | 367, 517 | 29, 39 | 217, 307 | 121, 164 | 11, 14 | 0 | 0.7, 1.0 | 3.7, 4.9 | 7.8, 9.8 | 16, 26, 20; 16, 27, 17 | 1.2, 1.3 | 142 |

against the budgets: home allocation met (15 to 1.3 mb/s); home busy met
in one run and missed in the other (4.0%, 2.9%); hidden busy met in one
run and missed in the other (1.6%, 2.1%); a streaming thread is
unchanged and missed (12.6 to 14.7% against 8%); no long tasks, the
worker under 2%, heap floors flat and peaks under 64 mb in every run.
script fell by a half to three quarters in every mode; layout and paint
per minute rose.

**reading the rendering numbers.** frames, layouts and paints follow how
often the worker posts patches. each post costs one animation frame, one
layout and one paint on the main thread. that rate is not fixed by the
code: one build, f8f04d1, posted 300 times a minute in one home run and
1,199 in another, and every build since has done the same, so per minute
layout and paint can rise while each frame gets cheaper. the main
thread's cost per post went from 5 to 16 ms on f8f04d1 to 1.5 to 2 ms on
35917b7 (a home run per merge, 2026-10-21). in the thread mode both builds
lay out on every frame (about 58 a second, 0.4 to 0.6 ms each). so compare
builds on the per-step counts and frames a second, which the run now
prints with the load average at the start and end of each mode, and on
the dom writes per minute (a MutationObserver: by kind, by the nearest
class, and how many set the value already there). f8f04d1 rewrote
`aria-label` on every window's clear button about 2,150 times a second,
each time to the same value; every attribute write the merged build makes
also sets the same value, about 1,200 a minute on `.pill`.

a third merged run with the streams' fixed offsets and the per-post
numbers (load 7 to 18): home 3.6% of a core at 1,013 posts a minute, 2.2
ms, 1.0 layouts and 2.0 paints a post; a streaming thread 10.6% at 2,048
posts a minute, 3.1 ms, 1.6 layouts and 5.0 paints a post; hidden 1.4% at
429 posts a minute, 2.0 ms a post. same-value attribute writes: 1,049 a
minute on home (`aria-label` on `.pill`), 2,571 on a thread (`.tb-facts`
and `.pill`), 481 hidden. budgets missed: home busy, thread busy, thread
per post (3.1 against 3 ms) and the dom writes; the rest met.

## the board trace (m6)

three traces are recorded against v1 (its real server and its own board
daemon, a harness cmx behind it) with scripted key presses on the fake
board: every key event in, every call and led frame out, with timings.
replay the keys against v2 through the fake board; the led frames must be
byte-identical and the calls semantically identical (same intent, same
target, each verb in the same order). `docs/board-verification.md` is the
harness, what it compares and how m6 runs it. decision 78 replaced v1's
daemon with a native one, so v1's bytes prove nothing now; the traces hold
the behaviour, and `docs/board.md` says how the board is built.

## the full surface drive (m7)

agent-browser walks every control in the app by accessible name at phone,
ipad and mac widths and exercises it against a real daemon, printing the
request log. the terminal is opened, typed into, resized, dropped and
redialled with its cursor.

the terminal's part runs on its own: `just build && bun bench/terminal.ts`
(steps `rest`, `relay`, `overflow`, `browser`; `docs/terminal.md`,
verification). it owns the pinned daemon on 4890, a cutter on 4892 between
boxbox and the daemon (cutting it is the relay's upstream dropping), and
the release binary on 3031, and prints `lsof` on its ports when it stops.

## contract 1 goldens (m9)

m9's gate proves contract 1 frozen across the agent source seam
(`plan.md`, m9; `agents.md`, verification). the baseline was recorded on
main before the seam, in `server/goldens/contract1/`:

- `tape.jsonl.gz`: a session against the cmx2 dev daemon, as the fleet
  actor took it: every upstream frame, host read and tail read on the wire,
  every command (mark read, clear, adopt, a review answered, asks answered,
  sends, stream pages, fleet and needs reads), presence, and the tail clock,
  each with the `now_ms` it ran at. the session runs past the caps: 1,100
  threads (57 evicted at 1,000), the order full at 300, 40 turns in windows.
- `live.json.gz`: what that server sent: the whole journal from cursor 0,
  every stream the bench opened, every `/api/fleet` and `/api/needs` answer.
- `golden/`: the end of the session as today's server answers it, epoch and
  build normalised: `hello` and `reset`, resumes inside, at and past the
  head, from another epoch and from before the ring (expired), the fleet,
  the needs with `x-boxbox-seq`, and the payload and title of every push.

`cargo test fleet::replay` (part of `just check`, no daemon) replays the
tape through the actor and holds the journal byte for byte against the live
one, replays it twice and compares, and holds every stream, fleet and needs
answer and every golden. recorded frames enter at one place,
`Replay::upstream` in `server/src/fleet/replay.rs`: `fleet::Upstream`
before the seam, the cmx2 source after it. the seam moves that function and
nothing else.

recording again (only for a new baseline, never to make a test pass):
`bun bench/golden.ts record` (the pinned daemon on 4950, the bench model on
4951, a server built with `--features record` on 3051; `GOLDEN_WORLD`,
`GOLDEN_DAEMON_PORT` and `GOLDEN_BOXBOX_PORT` move them), then
`BOXBOX_GOLDENS=write cargo test goldens`.

### the live goldens

the routes a replay cannot answer, because the daemon answers them, are
held by `bun bench/golden-live.ts check` against a live pinned daemon
(4954, the bench model on 4955, a copy of `target/debug/boxbox` on 4957;
`GOLDEN_LIVE_BINARY` names another build, `GOLDEN_LIVE_WORLD` another
world). it runs one session and compares each answer with its file in
`server/goldens/contract1/live/`: the transcript and one message, plain and
gzipped, with `x-cmx2-seq`, `x-next-cursor` and their pages; history and
its pages; a prompt's 202, its repeat, and the 409 of its client id on
another thread; a terminal redialled with its cursor, from 0 and with -1; a
checkout's review read, merged, discarded and refused (uncommitted work).
ids, times, seqs, shas, the world
directory, the minted passwords and the machine's name become placeholders
before anything is written or compared. it prints a table, one row per
golden, and exits 1 on any difference. `bun bench/golden-live.ts record`
writes the files again, only for a new baseline.

## thumbnails (protocol 3, section 13)

`GET /api/media/{id}?w=<px>` ships a thumbnail for a format only when the
pixel check passes for it: for every test image, ladder width (96, 192,
384, 768, 1536) and device pixel ratio (2 and 3), at least 99.9% of the
thumbnail's pixels within 2/255 on every channel of the browser's own
downscale of the original in the same box, in chromium and in webkit. a
format that fails answers the original for every `w`. **outcome: no format
passes in webkit, so thumbnails are off (`THUMBNAILS` false in
`media/thumbs.rs`) and every `w` answers the original.**

`bun scripts/thumb-check.ts [--dir <scratch>] [--webkit]` runs it:

1. the ignored hook `media::thumbs::tests::pixel_check_set` writes the
   test set and the server's thumbnails through the server's own path
   (`thumbs::scale`): photo-like gradients with noise at 2000x1333,
   1023x2047, 3001x401 and 300x211, line art at 1600x901 and stripes under
   an alpha ramp at 1201x777, as png (6), lossless webp (5) and jpeg (5).
   chromium's canvas encoder then makes lossy webp (quality 0.85) of four
   of the pngs, its srgb profile chunk removed, and the hook scales those
   too.
2. agent-browser's chromium (its own session, `--force-color-profile=srgb`)
   draws, at dpr 2 and 3, the original and the thumbnail side by side in
   the same box, w by h device px, and screenshots the page. the box is a
   w by h css px image scaled by 1/dpr: a laid-out box of w/dpr by h/dpr
   css px snaps a fractional css height to whole css px under emulated
   dpr, which put the box a row off the thumbnail and scored a 1:1 draw
   as a resample.
3. with `--webkit`, the same pages (overflow hidden, images decoded in
   line) go through `scripts/thumb-webkit.swift`, built with `swiftc -O`:
   a WKWebView in a borderless offscreen window, the window's colour space
   srgb, occlusion detection and hidden page throttling off (private
   setters, so a locked or asleep screen does not stall it), snapshotted
   with `takeSnapshot` and redrawn into an 8-bit srgb png. the screens of
   the machine it ran on are scale 1, so each dpr is forced with
   WKWebView's private `_setOverrideDeviceScaleFactor:` (2, then 3); the
   page reports that `devicePixelRatio` and the snapshot comes back at
   exactly css size times dpr, which the script checks. no server: the
   pages load from disk.
4. each pair is compared pixel by pixel: the share within 2/255 and the
   largest delta, per engine, format, width and dpr (164 pairs per
   engine).

what it found in chromium (2026-10-21, worst image per row):

| format | w | dpr 2: % within 2/255, max | dpr 3: % within 2/255, max | ships |
|---|---|---|---|---|
| png | 96 to 1536 | 100.00, 1 | 100.00, 1 | yes |
| webp (lossless and lossy originals) | 96 to 1536 | 100.00, 2 | 100.00, 2 | yes |
| jpeg (quality 90 re-encode) | 96 | 16.51, 18 | 16.51, 18 | no |
| jpeg | 192 | 34.82, 17 | 34.80, 17 | no |
| jpeg | 384 | 38.74, 18 | 37.99, 18 | no |
| jpeg | 768 | 42.19, 22 | 42.20, 22 | no |
| jpeg | 1536 | 65.21, 22 | 65.21, 22 | no |

**near, not identical.** the png and webp thumbnails are not chromium's
pixels: up to 1 (png) or 2 (webp) off on some pixels, inside the
threshold everywhere. a quality 100 jpeg re-encode was also tried and
still failed (19.95% at 96, 95.43% at 1536, max delta 11): the
re-encode and the difference between chromium's jpeg decoder and the
server's move pixels past 2/255. gif was not offered (motion, a palette).

**the filter.** general resampling filters missed by far, each the worst
image over png and webp at any width and dpr, from `fast_image_resize`
6 (premultiplied, gamma-encoded): lanczos3 7.93% (max delta 89),
catmull-rom 8.65% (78), triangle 12.50% (68), box 8.41% (168). linear
light was not measured: chromium resamples gamma-encoded values, as the exact match below shows. impulse images (one
white pixel per 32x32 block) showed chromium's path: skia's mip chain (2x2
boxes, 1-2-1 taps on an odd side, truncating), sampled bilinearly on
premultiplied pixels and blended between the two levels around the scale.
a mip chain sampled at one level alone scored 0.11%. trilinear at skia's
documented level `log2(scale) - 0.5` scored 96.32% (png) and 96.24%
(webp); sweeping the bias on the line art at 384 (dpr 2) gave 0.42 89.93%,
0.45 99.18%, 0.46 to 0.48 100%, 0.50 98.46%, 0.55 82.49%, so the server
uses 0.47 (`media/thumbs.rs`, `LEVEL_BIAS`). the scaling is written in
`media/thumbs.rs` (about 100 lines); no resampling crate offers this
filter, so the crate added is `image`, for the png and webp codecs only.

what it found in webkit (WKWebView on macOS 27.0.1, the same thumbnails,
worst image per row; dpr 2 and dpr 3 gave the same numbers to two
decimals):

| format | w | % within 2/255, max | ships |
|---|---|---|---|
| png | 96 | 2.00, 119 | no |
| png | 192 | 8.67, 116 | no |
| png | 384 | 19.39, 100 | no |
| png | 768 | 46.46, 116 | no |
| png | 1536 | 73.56, 51 | no |
| webp | 96 | 2.00, 117 | no |
| webp | 192 | 8.67, 114 | no |
| webp | 384 | 17.57, 100 | no |
| webp | 768 | 46.46, 116 | no |
| webp | 1536 | 73.56, 50 | no |
| jpeg | 96 to 1536 | 1.92 to 52.38, up to 119 | no |

the harness is not the cause: webkit's 1:1 draw of each png thumbnail
matches the thumbnail file exactly (100% within 2/255, max 0, every png
pair at 96, 384 and 1536). the engines are: webkit's downscale of an
original against chromium's, in the same box, agrees on 2.00% (wide, 96)
to 95.60% (photo, 1536) of pixels, max deltas 16 to 119. webkit
antialiases the stripes chromium's mip chain aliases. a thumbnail within
2/255 of both would put the two engines within 4/255 of each other, which
they are not, so no one scaler can pass both. fitting the server's scaler
to webkit was tried within reason and stopped: against webkit's own
downscale at 384 (dpr 2), the general filters (box, triangle, hamming,
catmull-rom, mitchell, gaussian, lanczos3, supersampled triangle) reach
76 to 77% on the photo with max delta about 20 whatever the filter, up
to 96.7% on the tall photo and 48% on the line art. a photo error that
no filter changes suggests webkit samples large images from a reduced
decode, but that was not established.

**memory.** a thumbnail is at most 1536 by 4096 pixels
(`MAX_THUMB_PIXELS`) and its original at most 40 M pixels (`MAX_PIXELS`),
both decided from the header before anything is decoded; past either, the
original answers. the sampling writes one row at a time straight to 8-bit
pixels, so floats never take more than one row per mip level (24 KiB).
the worst image both caps allow peaks at about 350 MB while it decodes
(the encoded original, up to 64 MiB, an rgb decode of 120 MB and its rgba
copy of 160 MB) and about 290 MB while it scales (the encoded original,
the rgba original, its next level of 40 MB, the 25 MB thumbnail), one
scaling at a time (`JOBS`). before the caps, a 1537 by 26000 screenshot
at 1536 held a 640 MB float buffer, about 0.96 GB in all. computed from
the buffer sizes, not measured.

what it cannot answer: safari on ios (the ios app's webkit). images with
a colour profile, gamma, an orientation or animation answer the original
and were not measured. the bias is fitted to one chromium build.

## device checks that only a real device can answer

keyboard behaviour on the iphone (decision 19), push delivery and the
banner tap deep link, the badge, the back swipe, 60 fps on the ipad. the
simulator and desktop emulation do not count for these.
