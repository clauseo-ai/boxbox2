# the board

the board is an optional add-on: a 17-key usb keypad running the boxbox
firmware (fw 5, protocol v1), lit key by key, that shows the fleet at a
glance and drives the app on the mac it is plugged into. boxbox does not
need it, and an install without one pays nothing for it: the server's board
channel is dormant until `[board]` is in `boxbox.toml`, the app's first load
carries only the board's frame plumbing (under 1 kb) and fetches the rest
when a board frame arrives, and the daemon is a separate binary nobody else
installs.

decision 1 still binds what the board does: every key, colour and light
behaves as it always has, except the changes decisions 78 to 81 list. this
file is how it is built; `board-verification.md` is how that is proven.

## the pieces

| piece | where | does |
|---|---|---|
| the wire | `board/wire` (crate `boxbox-board-wire`) | every shape the server and the daemon exchange, and the frames app windows get. the server builds it with `openapi`, so the app's decoders come from the same types |
| the daemon | `board/daemon` (binary `boxbox-board`) | one native rust binary per mac: the keypad over hid, the verb grammar, the banks, the scenes, the radio |
| the channel | `server/src/board/` | the board's view, computed in the fleet actor while a board listens; the board's verbs; the relay to the board's mac |
| the app | `app/src/board/` | digits on the windows of the board's mac, and focus and compose obeyed there |
| the harness | `board/trace` | replays recorded key sessions against the daemon (`board-verification.md`) |

## turning it on

```toml
# boxbox.toml on the server (read at start; a change takes a restart)
[board]
# the machine lights, in key order (/ * - +). each is a `label.machine`:
# for cmx2 the host's name. omit for the app's machine order.
machines = ["desk", "vm", "laptop", "mini"]
```

then `boxbox-board install` on every mac the board may be plugged into. a
mac without the board plugged in runs the daemon idle: no server
connection, no timers, waiting on macos's device notification.

## the channel

| route | from | does |
|---|---|---|
| `GET /api/stream?view=board&protocol=3&device=…&addrs=…` | daemon | the device stream's board view (`protocol.md` section 5), gzipped (the daemon sends `accept-encoding: gzip` and inflates; the server sync-flushes after every frame and heartbeat). 409 for another `protocol`, which the daemon logs as "update the daemon". sse: `hello` (`protocol: 3`), then a `view` whenever the board's picture changes, `pin` when the app arms a pairing, `: hb` every 15 s. one board at a time: a new stream sends the old one `replaced` and takes over |
| `POST /api/board/act` | daemon | one tagged `Act`: focus, compose, read, reply, flush, seats, bind, unbind, gone. 204 when taken: for a focus or a compose, when a window on the board's mac took it (409 `no-board-window` otherwise, 404 `no-such-session` for a thread the fleet does not hold, 404 `no-such-machine` for a machine the view shows no light for); for a reply or a flush, when the agent took it. every verb answers 409 `no-board` with no board present |
| `POST /api/board/pin` | app | arms the next digit key pressed to pair with a thread, for 30 s. 409 `no-board` when no board stream is open, 503 `board-busy` when its stream has stopped reading |

with no `[board]` the routes are not registered, so every one answers 404
like any unknown `/api` path, and nothing below exists. all three sit
behind the gate cookie.

the verbs, as the server carries them out (`server/src/board/routes.rs`):

- **read** marks the thread read through its newest message, with the
  board's device id and class `board`, the same mark `POST /api/read` makes.
- **reply** answers through the neutral ask path: a permission takes once,
  always or reject; a question takes one of its options by index (the
  view's `ask.options`) or reject. an ask the fleet no longer holds answers
  404 `gone`.
- **flush** is abort, then run-now, as the person's own action (a fault
  that follows is not a need).
- **seats** are kept with presence and relayed to the board's windows as
  `board.here`, `bound` as the daemon sent it. a stream from the same
  device that replaces the last keeps them until the next seats.
- **bind** and **unbind** take only the digit keys (wire 4, 5, 6, 8, 9, 10,
  11, 12, 13; anything else is 400) and persist in `boxbox.db`
  (`board_bindings`, made at start only where `[board]` is configured and
  kept out of the versioned schema, so a rollback to a build before the
  board still opens the database). a key holds one thread and a thread one key: binding
  a key frees any other key the thread held.
- **gone** ends presence only when it comes from an address of the board's
  mac: a late gone from the mac the board just left changes nothing.

`bun bench/board.ts` drives the stream and the verbs against a real cmx2
daemon and a server with `[board]` (its header says how to set it up).

the server emits no `verb` telemetry row for a board verb: the daemon
records its own, with `ok` from this answer, so a server row would count
twice.

**the view** (`board/wire`, `View`) is the board's whole picture, a few
kilobytes at most, sent whole: no patches, no cursor, a reconnect is just
the next view.

- `threads`: the home windows that need you or are working, plus every
  bound thread, in the app's window order (the order `⌥1` to `⌥9` open:
  `fleet.order` through the home membership filter), subagents never, at
  most 36. since the app ranks needs and working threads first, digit n on
  an unpaired board is window n in the app, with one exception: with job
  notices off (`jobsAsNeeds`, the default, decision 95) a thread whose only
  need is a job still lights `news` and rides the board, but the app's order
  ranks it among the quiet threads, so a quiet window the board does not
  show can sit before it in the app.
- per thread: its need (`permission`, `question`, `fault`, `review`, or
  `news` for `done` and `job`), how long the need has waited as of the
  frame (an age, so the vm's and the mac's clocks never have to agree),
  `working`, `fresh` (streamed text in the last 2 s, flipped by the server
  so token deltas never reach the board), `queued`, and the open ask with
  a single question's option labels, at most nine.
- `machines`: up to four, each the agents sharing a `label.machine`: up
  when any is connected, and an activity of 0 to 5 for the fleet bank.
- `bindings`: paired digit keys with their livery colour, kept in
  `boxbox.db` so both macs show the same pairs.

**cost.** the fleet actor holds the board projection only while a board
stream is open. the changes that can move the picture (`host*`,
`session*`, `ask*`, `order`) mark it dirty; deltas, parts and messages
never do; a delta only stamps its thread fresh and feeds its machine's
activity rate (v1's: +1 a delta up to 60, times 0.7 a second, gone under
0.05, the light the rate rounded to 0 to 5). both edges of `fresh` are
structural, as v1 lit them: the first delta after a quiet spell marks the
projection dirty, so a working key brightens within the coalesce, and the
dimming is one deadline at exactly the earliest fresh thread's last delta
plus 2 s, never a tick, so a thread that keeps streaming costs no build. a
dirty projection rebuilds at most every 250 ms (1 s when only activity
moved, and that second's tick runs only while a rate lives), encodes
once into `Bytes`, and is not sent when the picture equals the last one
sent. the comparison is of the picture, not the bytes: `waitingMs` is an
age taken at encode time, so bytes would differ on every rebuild while any
need is open; the picture holds each need's raised time instead, and the
daemon adds its own elapsed time to the last age. no board, no work: the
actor's only cost per change without a board stream is one `Option` check.

a machine is up when any agent with its `label.machine` is ready or
syncing. without `[board] machines` the lights take the machines in the
order of the app's sources (configured cmx2 hosts, paired hosts, then the
other connections), first four.

## where the board is

a browser cannot say which machine it is on, so the board's mac is found
by address (decision 81):

1. the daemon opens its stream with every address of its mac (`addrs`:
   tailnet v4 and v6, lan).
2. the server reads each stream's client address once, at connect: the
   socket peer, or the rightmost `X-Forwarded-For` when the peer is
   loopback (`tailscale serve` and most reverse proxies on the same host).
   an entry from a peer that is not loopback is never believed, and a v4
   address carried in v6 counts as v4. the board's set is its `addrs` plus
   the address its stream came from, unless that is loopback: behind a
   proxy that sent no usable `X-Forwarded-For` every client looks like
   loopback, and a phone must not match. a daemon on the server's own
   machine lists loopback in `addrs` itself. addresses reach logs only at debug and
   never a telemetry label.
3. app windows on a desktop-class device open `/api/stream?board=1`. the
   server ignores the flag without `[board]`; with it, it matches the
   window's address against the board's, and sends that stream `AppFrame`s:
   `board.here` with the digits, `board.focus`, `board.compose`,
   `board.gone`. these frames are id-less, outside the journal: no seq, no
   cursor, no other stream ever sees one, and they start once the stream is
   live (after its replay or reset). which windows sit on the board's mac is
   worked out once when presence moves, so a focus costs one flag check a
   window. ios and phones never send the flag.
4. unplugging sends `Act::Gone` and closes the stream, so the windows drop
   their digits at once. a stream that drops without it (the mac slept,
   the network went) keeps the board present for 20 s, then `board.gone`.

plugging the board into the other mac moves everything there: that mac's
daemon wakes, its stream replaces nothing (the first went with the unplug)
or replaces the stale one, and the digits and focus follow.

## the app

- **digits.** while a board is here, each window it seats wears its digit
  (window card, rail and strip swatches): the same digit `⌥n` opens. the
  badge is part of the window's material, not a sticker on it; its look,
  motion and budgets are in `design.md` (the board).
- **focus.** a board tap opens the thread through home's own tap path, with
  the same motion, and puts the caret in its composer, as v1 did for every
  focus: a key press aims you at a thread to talk to it, and dictation types
  into whatever holds focus. a double tap is the same focus to the app.
- **compose.** a machine key lands on home's field set to that machine,
  the caret in it (decision 103; the new-thread sheet is gone).
- **pairing.** a thread's menu offers "pair with a board key" while a board
  is here; the next digit pressed takes it.
- the board code is its own lazy chunk (`app/src/board/board.tsx`),
  fetched on the first `board.here` and left out of the service worker's
  precache. no board, no work: what the first load carries is the frame
  plumbing, the store's slice and the mount points (0.6 kb compressed), and
  the rest is never fetched. how it is built is `home.md`, the board's digits.

## the daemon

`board/daemon` (binary `boxbox-board`, macos only: elsewhere it says so and
exits 1). the pure modules (`protocol.rs`, `verbs.rs`, `scenes.rs`), the
controller, the state and the painter take time as an argument and touch no
device, so the tests drive them exactly and linux builds and tests them; the
keypad, the network and the microphone around them exist only on a mac.

**lifecycle.**

| state | runs |
|---|---|
| no board | the main loop blocked on its channel with no deadline, and one thread blocked on macos's hid notifications (async-hid, on a dispatch queue). no server connection, no timers, no audio objects |
| plugged in | the keypad opened non-exclusively (vid 0x3a54, pid 0x4f5d, usage page 0xff60), the hello, the global byte for the hour and a first frame, then on the ack the palette (slots 0 to 8 and the liveries), in v1's order, which the traces hold. then login if the cookie is gone, the stream, and the formation lap once the first view lands (at most 1 s after the ack). a hello unanswered for 2 s goes again, backing off to 64 s, since a board can enumerate before its firmware listens. a keypad whose read or write fails is dropped and, if still plugged in, opened again after 2 s, doubling to 64 s while it keeps failing |
| running | the hid reader, the stream reader, the poster and the main loop, which sleeps until the next report, frame, answer or deadline |
| stopped (sigterm, sigint: launchd stopping the agent for an upgrade or `uninstall`) | what an unplug does that fits in 300 ms: `Act::Gone` posted, the dark frame v1 sent (the firmware's watchdog hands the board back as a numpad), the last telemetry posted, the poster waited on at most 300 ms, then exit 0 |
| unplugged | `Act::Gone` and the last telemetry posted, the stream's socket shut down at once, the mic meter closed; hands-free, the pit, a held seat, an armed pin, every open press and the scenes cleared; the page back to 0. the poster ends after its queue, so nothing of the server stays open |

**the view and what the daemon derives.** state is the latest `View`; the
daemon adds only what one picture cannot say:

- the arrival pulse (a thread's need changed; permission pulses essential,
  a fault is the red flag) and the victory lap (a review need left without
  the board marking it read). the first view after any connect seeds
  silently, since the gap was not seen happening.
- hot: a fault, or `waiting_ms` plus the time since the view landed at
  least 10 minutes, with one deadline for the next crossing.
- the briefing, when the board was away longer than `away_ms`: unplug to
  plug, or a stream gap while plugged, by the wall clock (a sleeping mac
  stops the monotonic one). never on a fresh process.
- seats: bound digit keys hold their thread on every page; the rest of the
  digits take the unbound threads with a need or a running turn in the
  server's order and page through them. `Act::Seats` posts the digits the
  board shows now (bound keys, then the current page) only when they
  change, and again after every reconnect. never on a clock.
- liveries: a bound thread keeps one of slots 9 to 13 while it is bound, a
  freed slot is reused, two threads never share one, and a slot's colour is
  pushed as soon as the binding appears. past five bindings a key keeps its
  thread in the floor's white.
- a pin arms the next key down; a digit binds (`Act::Bind`), any other key
  is consumed and binds nothing (the server would refuse it).

**rendering.** a frame is composed only when something changed: a message
(a report, a view, an answer, a meter window), or a deadline the controller
names (a verb's window, a scene step, a queue blink, a hot crossing, the
pit's reject arm, a pin's expiry, hands-free's silence, the hour). nothing
runs at 60 Hz. the two animated palette slots (the working pulse, the radio
breath) stream at most 25 writes a second and only while a key on screen
uses them; those wakes reuse the composed frame. with nothing written for
500 ms a ping goes out, inside the firmware's 2000 ms watchdog. every
connect resends the frame and the brightness.

**the drive bank, as it is now** (the rest of the grammar is v1's):

| key | tap | double | hold | chord |
|---|---|---|---|---|
| nl | drive and fleet | calc (firmware) | deep work | |
| `/ * - +` | new thread on machine 1 to 4 | | | |
| 1 to 9 | the pit for an ask, else focus | focus | queue view | with ent: flush; with 0: talk into it |
| `.` | next page | | mark the top call read | |
| ent | enter (firmware) | | | flush |
| 0 | readback | hands-free | push to talk | |

**the radio.** the 0 key is a real ctrl+f18 the firmware types into the mac
it is plugged into, so dictation runs there, in whatever dictation app owns
the shortcut, with that mac's microphone. the daemon only watches: the
meter opens the default input through coreaudio (cpal) while the key is
held, a chord talks or hands-free is on, and closes it at the stop. it folds
the input to v1's 8 khz, 25 ms windows, auto-gained into four scrolling
bars. a denied microphone delivers silence, which the meter shows; no input
device leaves that talk without a meter. readback is `say` (or
`say_command`), started on a tap and reaped by a short-lived thread.

**the network.** posts (acts, login, telemetry) go through ureq, pooled and
blocking, on a poster thread behind a bounded queue, so a key never waits
on the server. the stream is read on a socket the daemon owns, so an unplug
shuts it at once (a blocking client's body reader cannot be closed from
another thread): `: hb` every 15 s, 45 s without a byte is a dead stream,
redialled after 0.5 s doubling to 30 s, back to 0.5 s once the server took a stream (its 200), however it ended. `replaced` ends it until the next
plug. tls on both is the system's (native-tls, security framework: its roots
and its verifier), which keeps the binary at 1.9 mib stripped with no tls
stack in it (ureq's native-tls feature brings webpki's roots, unused). login posts `password_file`'s contents to
`/api/login` and keeps whatever cookie `Set-Cookie` names, 0600 in the
state dir; any 401 logs in again once.

**telemetry.** `board.connect` (the ack's fw and proto, reconnects),
`board.key` and `board.bind` as v1, with `ok` and `ms` from the server's
answer to the act; a press that serves a need also records v1's generic
`verb` (`markRead`, `flushQueued`, `replyPermission`,
`answerQuestion`). `perf.board` (physical footprint, rss, cpu) hourly while plugged in, plus
one row at each plug covering the time away. batches go to
`/api/telemetry` as `deviceClass: "board"`, 5 s after the first event or
at 40.

**files.**

| what | where |
|---|---|
| binary | `~/.local/bin/boxbox-board` |
| config | `~/.config/boxbox-board/board.toml` (0600): `origin`, `password_file`, the verb timings, the night curve, the voice, `say_command`, `mic_meter`, optionally `state_dir`. read once at start: a change takes `launchctl kickstart -k gui/$(id -u)/dev.boxbox.board`, so no file watcher runs beside an idle daemon |
| password | `password_file` (0600), written by `boxbox-board login` from stdin; never argv, never the agent's environment |
| state | `~/.local/share/boxbox-board/` (0700): the cookie, the device id, `status.json`, `board.log` (one line per event, capped at 2 × 1 mib; kinds, counts and ids, never a title, words or an address) |
| agent | `~/Library/LaunchAgents/dev.boxbox.board.plist`, loaded in the user's gui domain: RunAtLoad, KeepAlive only after a failure (`SuccessfulExit` false), ProcessType Interactive, stdout and stderr to /dev/null (the daemon's own capped `board.log` holds everything). a config that cannot be read is logged there and exits 0, so the agent stays down instead of respawning every 10 s; running `install` again after fixing it loads and starts the agent. a daemon that cannot watch for the keypad exits 1, and launchd brings it back under its throttle |

`boxbox-board install` puts the binary, the agent, a config template (never
over one) and the state dir in place; `uninstall` removes the agent and the
binary and keeps config and state; `status` says whether the board is
here, the stream's state, and the daemon's memory and cpu.

**the microphone permission** belongs to the binary: its `Info.plist` is
linked into it (`build.rs`, `-sectcreate __TEXT __info_plist`) with the
usage string, so there is no wrapper process. macos keeps the grant against
the binary's designated requirement. an ad hoc signature's requirement is
its cdhash, which every build changes, so macos asks again after each
upgrade. a self-signed code signing certificate's requirement is its
identifier and the certificate's leaf hash, which the next build signed with
the same certificate satisfies (`codesign -v -R` against the old
requirement passes; checked with two different builds). no paid account
and no trust setting are needed: codesign signs with an untrusted
identity. so `install` signs with an identity named `boxbox-board signing`
when the keychain has one, and ad hoc otherwise, with a warning. to make
one once: keychain access, certificate assistant, create a certificate,
name `boxbox-board signing`, identity type self-signed root, certificate
type code signing. no hardened runtime, which would also need the
`com.apple.security.device.audio-input` entitlement.

**the harness's seams** (never set in an install):

- `BOXBOX_BOARD_HID=unix:<path>`: the keypad becomes a unix socket the
  harness listens on, present only while the board is plugged in; the
  daemon connects (looking every 50 ms, in this mode only) and the close is
  the unplug. fixed 32-byte frames each way, no length prefix, no report id.
- `BOXBOX_BOARD_METER=script:<path>`: json `{"windowMs": 150, "levels":
  [0.3, ...]}`, rms 0 to 1; each meter start plays the levels from the top,
  one every `windowMs`, then holds; each start and stop appends a line to
  `<path>.log`.
- `BOXBOX_BOARD_CONFIG=<path>`: the config, anywhere; and `say_command` in
  it names the readback binary.

**where it differs from the plan, and why.**

- hotplug is async-hid's (macos's hid notifications on a dispatch queue)
  rather than nusb's: the same crate opens the keypad split into a reader
  and a writer, which hidapi cannot (its device is not `Sync`, so reading
  on one thread while writing on another would mean polling).

## budgets

| budget | target | row |
|---|---|---|
| daemon memory | physical footprint 4 mib or less (resident size, which counts CoreFoundation's shared pages every IOKit client maps, reported beside it) | `perf.board` (hourly: footprint, rss, cpu) |
| daemon cpu, board plugged in, drive bank idle | 0.1% of a core or less, averaged over an hour | `perf.board` |
| daemon cpu, no board | nothing measurable: no wakeups | `perf.board` |
| key to action | a resolved verb posts within 5 ms; the server relays a focus within 5 ms | `board.key` `ms` |
| server, no board | no projection, no task, no timer | |
| server, board listening | a rebuild under 1 ms, at most 4 a second | `perf.board_view` |
| app, no board | 1 kb or less of first-load script (the frame plumbing, the store's slice, the mount points; 0.6 kb measured); the rest a lazy chunk fetched on the first `board.here` (1.9 kb of script and 0.4 kb of css, compressed), never precached | `scripts/compress.ts`, the build's chunk report |
| app, board here | badges move by transform and opacity only; no layout shift, no long task | `perf.shift`, `perf.longtask` |

v1's bun daemon, measured on a mac: 34 mib resident, 0.95% of a core
averaged over 12 hours, most of them with no board plugged in.

boxbox-board, measured on a mac (release, stripped, 1.7 mib then; 1.9 mib since the tls fix), 10 minutes
each with `ps -o rss=,cputime=` at both ends:

- a fake board on the socket seam idling in the drive bank, against a fake
  stream sending one view and heartbeats: 0.45 s of cpu in 600 s (0.075% of
  a core), about 20 palette writes a second for the radio's breath and 14
  frames in all; a physical footprint of 2.9 mib.
- no board, on the real hid path: cpu time flat at 0.02 s across the 600 s,
  and `sample` shows two threads, both blocked in `__psynch_cvwait`; a
  physical footprint of 2.6 mib.
- resident size, both cases: 6.3 to 8.2 mib. about 5.4 mib of it is the
  CoreFoundation any IOKit client maps: an empty program linking it shows
  5.4 mib resident and 1.7 mib of footprint.

## what changed from v1, on purpose

- machine 4 on `+`; mark-read moved to a hold on `.`; the fleet bank shows
  four machine columns and no spend odometer (decision 79).
- seats come from the server's order instead of the board's own triage
  (decision 80).
- four v1 defects are fixed rather than carried: a new livery's colour
  reached the board only on a replug; two agents could share a livery slot;
  a replug inside the same hour kept the firmware's full brightness; and the
  meter, hands-free, the pit and a held seat survived an unplug.
- the on-screen twin (the frame mirror) and the spend poll are gone; v2's
  app has neither.
