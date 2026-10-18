# board verification

decision 1 binds what the board does: every key behaves as it does in v1,
judged by identical behaviour, not parity of spirit, apart from the changes
decision 79 lists. decision 78 replaced v1's daemon with a native one, so
the bytes of v1's files no longer prove anything; this harness proves the
behaviour, by replaying sessions recorded against v1 at the process
boundary.

## what the harness is

`board/trace/` runs a real board daemon, unmodified, against a fake board
and a real server, plays a scripted session of key presses and agent
turns, and records everything the daemon does, timestamped. it attaches
two ways. the native daemon (decision 78) runs at its seams
(`docs/board.md`, the harness's seams). v1's bun daemon runs under a
preload. the records are the same either way:

| channel | what is recorded |
|---|---|
| leds | every hid write the daemon sends the board: hello, palette, frame, global, ping, mode |
| board | every report the fake board sends back: hello ack, key down and up, mode echo |
| calls | every call to its server: method, path, directory header, body, status. the board stream's frames are kept beside them for reading, never diffed |
| radio | every readback (the words), and every meter start and stop (v1's `sox`) |

the pieces:

| file | does |
|---|---|
| `firmware.ts` | the fake board: the mf17 boxbox keymap (fw 5, protocol v1) as a pure state machine. hello ack, key reports, the local nl double tap into calc (the triggering press never reported), nothing reported on the calc layer, the 2000ms watchdog, the unconditional mode echo |
| `daemon.ts` | starts the daemon `--daemon` names: a binary is the native daemon (`native.ts`), a directory is v1's bun daemon under the preload |
| `native.ts` | runs `boxbox-board` with `BOXBOX_BOARD_HID=unix:<path>`, `BOXBOX_BOARD_METER=script:<path>` and `BOXBOX_BOARD_CONFIG=<path>` (origin the proxy, a password file, a flat night curve, no voice, the meter on, `say_command` the recorder, the daemon's own timings), with its own HOME, so the state dir starts empty |
| `socket-board.ts` | the fake board on a unix socket. the socket exists only while the board is plugged in. each way carries fixed 32-byte frames: the protocol's host writes, and the firmware's reports. a report goes out 1ms after the write that caused it, the hello ack after 40ms, and the watchdog ticks every 50ms. unplugging closes the connection |
| `proxy.ts` | the recording reverse proxy between the native daemon and its server: method, path, body and status, as the fetch wrapper recorded them. it passes a stream through unbuffered and records each `data:` frame on the side |
| `radio.ts`, `say-recorder.ts` | the radio's seams. `say_command` is a shim that logs its argv and exits 0 without speaking. the meter script is `{"windowMs":150,"levels":[0.3,0.15,0.3,0.08,0.3,0.15]}`, the six windows v1's fake sox played. in script mode the daemon appends `start` and `stop` to `<script>.log`, and those read as `sox start` and `sox stop` |
| `preload.ts` | v1 only, loaded with `bun --preload` into v1's daemon process. `node-hid` resolves to a virtual module whose one device is the fake board; `fetch` is wrapped and recorded; `Bun.spawn` of `say` is recorded and never speaks, and of `sox` is the same scripted microphone |
| `world.ts`, `world-v1.ts`, `world-v2.ts` | the server side. v1's world is boxbox v1 exported at the frozen commit (`18df8bd`), built and served in production mode on 3021, in front of a harness cmx serve on 4880 whose model is the trace model on 4881. v2's world is boxbox v2 built from the checkout (`target/release/boxbox`) on 3022, with one host `h1` and `[board] machines = ["h1"]`, in front of the pinned cmx2 (`just cmx2`'s export) on 4884 whose model is the trace model on 4885, with an app window on `/api/stream?board=1` so a focus has somewhere to land. the board's mac is played by `192.0.2.10` (a documentation address): the proxy forwards every daemon call with it as `X-Forwarded-For`, and the app window says the same, so the server finds the window by address as decision 81 does. the daemon's real `addrs` pass through and never reach a record |
| `model.ts` | the trace model: a scripted anthropic messages api. a reply, a permission, a question with n options, or streamed work, each with a fixed 400ms think time and a 300ms pause before a tool call, so agent-driven frames hold long enough to compare. `--shell-tool` and `--shell-arg` name the runtime's shell tool (cmx2's is `shell` with `command`). `--end-ms` pauses between a reply's last word and its end: v1's cmx went idle about 300ms after a reply's last token and cmx2 within a few, so the v2 world passes 300 and a turn ends as long after its words as it did when the traces were recorded (otherwise the words and the end land in one 250ms build of the server's view, and the bright working frame v1 drew never shows) |
| `scenarios.ts` | the three sessions, as setup plus steps (a gesture, an agent turn, or rest) |
| `run.ts` | one traced run: the daemon starts with no board (v1's reconciles; the native one must stay silent), then the board is plugged in; each step ends when the board and the world are both quiet |
| `normalize.ts` | a run reduced to the lines the diff compares, with v1's wire (`decodeV1`) and the native daemon's acts (`decodeV2`) decoded into the same intents |
| `deltas.ts` | decision 79's deliberate changes, as reviewed rules, and the step whose presses change with them |
| `diff.ts` | per step and channel, a line diff: `-` the trace, `+` the replay. the lines a decision 79 rule forgave are printed apart |
| `trace.ts` | the file format, and the scrub that names nothing on the recording machine |
| `record.ts`, `replay.ts` | the two entry points |

the harness never imports daemon code. it meets the daemon only at the
process boundary: the socket, the proxy, the say command and the meter
script for the native daemon, and the hid module, `fetch` and
`Bun.spawn` for v1's. so the same checker drives both.

## the three traces

`board/trace/traces/`, recorded against boxbox v1 `18df8bd` with its own
board daemon:

- **thread-switching**: eleven unread threads over two pages. taps focus
  threads on both pages, dot pages and wraps, nl flips drive to fleet and
  back, a double tap aims dictation, plus marks the top call read, div
  opens compose on the first machine, holds on nl toggle deep work, and a
  double tap on nl drops the fake board into calc and back (the firmware's
  own escape, seen by the daemon only as mode echoes).
- **talk-key**: the radio through its whole grammar. a hold talks with the
  meter up, a tap reads the top call back, a double tap locks hands-free
  and the next press stops it, a chord with a seat talks into that
  thread, then a thread streams and the radio reads back after it lands.
- **permission-pit**: a permission answered with the pit digits. k1 into
  the pit, k3 arms reject, min skips back to drive, k1 allows once; the
  next ask is rejected with k3 twice; the third is allowed always with k2;
  then a question with three options is answered with k2.

## how a step ends

a step is over when at least 1000ms has passed, nothing that matters (a
frame change, a board report, a keyed call, a process) has happened for
700ms, no keyed call is in flight, no agent is working (every busy thread
is waiting on an ask), and any condition the step names holds (an agent
step waits for at least one new frame). a turn a key sets going (allow
once, an answer) finishes inside the step that set it going.

## what "identical" means

`normalize.ts` is the definition; its tests pin every rule. in short:

- **byte for byte**: every frame, palette writes to slots 0 to 13, global,
  hello, mode, every board report, every `say`, every meter start and
  stop, and every call's intent and outcome.
- **checked, not diffed**: ping is the keepalive; the longest gap between
  host writes is printed (about 510ms against the firmware's 2000ms
  watchdog).
- **reduced because a clock decides them, not behaviour**: the two
  animated palette slots (14 and 15, streamed through sines; which keys
  breathe is in the frame bytes), the seat map's 5s heartbeat (a post
  counts only when its map changes), the twin mirror's 5/s throttle (only
  a step's last mirror counts), the 60s spend poll and the startup login
  race (only the first counts), and telemetry batching (each event is
  placed by its own timestamp; its latency and id are dropped).
- **reduced because an agent's timing decides them**: in steps an agent
  drives, a frame held under 60ms is the render loop catching up with a
  burst of events and is dropped. every frame that holds is compared. key
  steps and the start drop nothing.
- **optional because the seat memo decides it**: the controller
  re-derives its seat list at most every 250ms but leaves the pit from
  fresh state, so after an answer the board can redraw the pre-pit drive
  frame for 0 to 250ms, or not at all. only that shape is optional: the
  picture from just before a frame that held at least a second, back for
  under 250ms, with no key down. it may be absent on one side, never different. a pulse's
  beats return after 170 to 240ms and the meter never returns to the frame
  before its last, so both stay required. `--show` marks optional frames.
- **calls by meaning**: within a step, calls are grouped by verb (each
  verb's own order kept), since calls from different sources interleave
  by timing.

### across versions

a replay against v2 reads both sides through `crossVersion`:

- v2's acts decode onto v1's intents. `focus`, `compose` and `read`
  (`markRead`) map one to one. a reply is `replyPermission` with its
  answer, or `replyQuestion` with the label of the option it names.
  `seats` is the seats on the keys by digit (v1's map without its page and
  hidden seats). v1's abort then loop is one `flush`. `bind`, `unbind`,
  `gone` and telemetry keep their own shape. a reply's directory is
  dropped on both sides, since v2 never sends one.
- **a seat is the unit (decision 80).** v2's board follows the app's window
  order, so digit n is window n, and its threads sit on other digits than
  v1's own triage put them. each side is read through its own posted seat
  maps (v1's `postSeats`, v2's `Act::Seats`):
  + calls and readback by digit, under the map in effect at the press that
    caused them. a tap on k1 focuses whatever sits on digit 1 on that side.
    `markRead` and "the top call" mean digit 1's thread. a verb's telemetry
    `session` reads the same way. a thread on no digit keeps its key.
  + frames by thread for the nine digit keys. each side's digit cells move
    through its own map (the map posted for that render: the last one
    before the next frame) to where the trace's map seats each thread, so
    each thread must wear the same light wherever it sits. every other key
    must match byte for byte, decision 79's cells apart.
  + the seat map itself is not a line. it changes whenever the app's order
    does, which is not when v1's triage did, and every other line is
    already read through it.
  + after an answer, v1's seat memo could redraw the picture from just
    before the pit (the board as it was at the press that entered it) for
    under 250ms. v2 has no memo and shows the thread's true state there
    instead. only where the trace's frame is that redraw, the replay's frame
    holds for at most 250ms (measured at the fake board, with 10ms of slack
    for the hops a write crosses: one 250ms build was seen holding 251ms),
    and read by thread the two differ on one digit key alone (decision 79's
    cells apart).
- **a bare first frame (decision 81).** the daemon opens no server
  connection until the board is plugged in, so a frame drawn before the
  first view reached it shows no threads or machines. only frames before
  the first view are forgiven, never one after.
- **telemetry fixes.** `board.connect` may carry the board's real `fw`,
  `proto` and `reconnects`; v1 sent a hardcoded `fw` 1. its outcome and
  every other field must match. `perf.board` is new (the daemon's budget
  row) and is accounted for wherever it lands.
- these three print under "accounted for by decisions 80 and 81, and
  telemetry fixes", apart from decision 79's.
- not compared, because v2 has no counterpart (`V1_ONLY`): the twin
  mirror (`/api/board/frame`), the spend poll, and the session list and
  session reads v1 derived the board from (refreshSessions,
  fetchSession). v2's server sends the view (decision 80).
- decision 79's changes are forgiven only as `deltas.ts` writes them, and
  each forgiven line is printed under "accounted for by decision 79":
  + where the trace has the mark-read light (`25`, v1's copy armed), `+`
    may show a machine light (the floor, or what `/ * -` show), and where
    the trace's `.` is the floor (no more pages to hint), `.` may show the
    mark-read light, in any step;
  + in the two fleet steps of thread switching, the odometer's cells (`-`,
    `+`, ent) may differ, since they are the fourth machine's column;
  + "tap plus: mark the top call read" presses a 600ms hold on `.`
    instead. its board reports may say wire 16 for 7, its frames may differ
    on `+` and `.`, and v1's one `board.key` tap on `+` is the hold's
    `holdStart` and `holdEnd` on `.` (target read), with the same bank and
    outcome. the call it makes must still be the same `markRead`.
  anything else that differs fails.

## commands

```sh
cargo build --release -p boxbox-board
bun board/trace/replay.ts all --daemon target/release/boxbox-board --world v2   # the m6 gate
bun board/trace/replay.ts all --daemon target/release/boxbox-board --world v2 --rediff   # the last run diffed again, starts nothing
bun board/trace/world-v2.ts --smoke [--board]   # the v2 world alone: three threads, a permission, a question
bun board/trace/replay.ts <trace.json | all> [--daemon <dir>]   # v1's daemon against v1's world
bun board/trace/record.ts <scenario | all> [--daemon <dir>]
bun board/trace/replay.ts <trace.json> --show   # the normalized view, starts nothing
```

`--world v2` builds boxbox with `cargo build --release` (or uses
`BOXBOX_BINARY`) and exports the pinned cmx2 into `.cmx2/<pin>/` once
(`CMX2_REPO` when the cmx2 checkout is not `../cmx2`). it needs ports 4884,
4885 and 3022 free. `BOARD_TRACE_CMX2_PORT` (the model takes the next port)
and `BOARD_TRACE_BOXBOX_PORT` move them for a parallel lane. the daemon logs
at `BOARD_TRACE_RUST_LOG` (info).

`--world v1` is the default. `--daemon` then defaults to v1's own daemon
(`board/` in the v1 export). the first run exports, installs and builds v1
into `board/trace/.work/` (gitignored); later runs reuse it. it needs the
boxbox v1 repo (not public) at the path in `BOXBOX_V1_REPO`, holding the
frozen commit, and the installed cmx binary
(`~/.local/share/cmx/bin/opencode`, or `CMX_BINARY`). ports 4880, 4881
and 3021 must be free. recording is v1 only.

worlds live under the system temp dir, never inside a checkout. every
command stops everything it starts, on success or failure. replay writes
its own run to `board/trace/.work/replay-<scenario>/replay.json` for
reading a diff against, and the daemon's log to `.../daemon/daemon.log`.
the v2 world's logs (`cmx2.log`, `boxbox.log`, `model.log`,
`app-window.log`) are in `<tmp>/boxbox-board-trace/replay-<scenario>/`.

## the evidence against v1

replaying each trace against v1's own daemon is the check that the
harness is deterministic: the same behaviour must give an empty diff. on
2026-10-01, `bun board/trace/replay.ts all` against the traces as checked
in printed `diff empty (leds, board, calls, radio)` for all three.

## how m6 uses it

1. the native daemon (`board/daemon`, decision 78) honours the seams in
   `docs/board.md`. the harness drives it only through them.
2. the server's board channel answers `/api/board/stream` and
   `/api/board/act` with `[board]` configured. `world-v2.ts` stages it from
   the checkout, and `--smoke --board` checks the stream answers.
3. run `bun board/trace/replay.ts all --daemon target/release/boxbox-board
   --world v2`. the gate is the printed diff: empty on every channel for all
   three traces, with every forgiven line under "accounted for by decision
   79" and each one a rule in `deltas.ts`. a needed change outside those
   rules is a decision row and a reviewed rule, never a looser normalizer.
4. the live half of the gate is not this harness: the real board on the
   mac, focusing, composing, answering a question and flushing a queue.

v1's daemon against v1's world stays. it is the determinism check for the
harness itself (an empty diff with nothing forgiven), and the only way to
record a trace. `preload.ts` and the bun half of `daemon.ts` exist for it
alone.

## what the traces do not cover

- scenes no trace sets off: the fault red flag, the victory lap, the
  briefing after a long absence, the queue view and its ent flush, the
  pairing ritual and liveries, the fleet waterfall with live tokens.
  adding one is a new scenario and a new recording; the trace model and
  worlds already have the vocabulary for most of them.
- the hardware itself: usb timing, the real firmware's clock, wispr's
  side of the radio. the live check covers those.
- v1 at any commit but `18df8bd`, the one the board was frozen at.