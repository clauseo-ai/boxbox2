# board verification

decision 1 freezes the board: every key behaves as it does in v1, judged
by identical behaviour, not parity of spirit. decisions 11 and 14 say how
that is held: only `board/daemon/src/client.ts` is rewritten for v2, and
a trace recorded against v1 (keys in; calls and led frames out) is
replayed against v2 and must match. the checksum test (`board/CHECKSUMS`,
`board/checksums.test.ts`) proves the bytes; this harness proves the
behaviour. m6's gate is both.

## what the harness is

`board/trace/` runs a real board daemon, unmodified, against a fake board
and a real server, plays a scripted session of key presses and agent
turns, and records everything the daemon does, timestamped:

| channel | what is recorded |
|---|---|
| leds | every hid write the daemon sends the board: hello, palette, frame, global, ping, mode |
| board | every report the fake board sends back: hello ack, key down and up, mode echo |
| calls | every `fetch` to its server: method, path, directory header, body, status |
| radio | every `say` (the words) and every `sox` start and stop |

the pieces:

| file | does |
|---|---|
| `firmware.ts` | the fake board: the mf17 boxbox keymap (fw 5, protocol v1) as a pure state machine. hello ack, key reports, the local nl double tap into calc (the triggering press never reported), nothing reported on the calc layer, the 2000ms watchdog, the unconditional mode echo |
| `preload.ts` | loaded with `bun --preload` into the daemon's own process. `node-hid` resolves to a virtual module whose one device is the fake board; `fetch` is wrapped and recorded; `Bun.spawn` of `say` is recorded and never speaks, and of `sox` is a scripted microphone (six level windows 150ms apart, then quiet) so the voice meter draws the same frames every run |
| `daemon.ts` | launches `<daemon>/src/main.ts` under the preload with a pinned config (flat night curve, the daemon's own timings) and a fresh state dir, and talks to it over ipc |
| `world.ts`, `world-v1.ts` | the server side. v1's world is boxbox v1 exported at the frozen commit (`18df8bd`), built and served in production mode on 3021, in front of a harness cmx serve on 4880 whose model is the trace model on 4881 |
| `model.ts` | the trace model: a scripted anthropic messages api. a reply, a permission, a question with n options, or streamed work, each with a fixed 400ms think time and a 300ms pause before a tool call, so agent-driven frames hold long enough to compare |
| `scenarios.ts` | the three sessions, as setup plus steps (a gesture, an agent turn, or rest) |
| `run.ts` | one traced run: the daemon starts with no board, reconciles, then the board is plugged in; each step ends when the board and the world are both quiet |
| `normalize.ts` | a run reduced to the lines the diff compares, and the v1 wire decoded into intents |
| `diff.ts` | per step and channel, a line diff: `-` the trace, `+` the replay |
| `trace.ts` | the file format, and the scrub that names nothing on the recording machine |
| `record.ts`, `replay.ts` | the two entry points |

the harness never imports daemon code: it meets the daemon only at the
process boundary (the hid module, `fetch`, `Bun.spawn`), so the same
checker drives v1's daemon and m6's.

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
  hello, mode, every board report, every `say`, every `sox` start and
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

## commands

```sh
bun board/trace/record.ts <scenario | all> [--daemon <dir>]
bun board/trace/replay.ts <trace.json | all> [--daemon <dir>]
bun board/trace/replay.ts <trace.json> --show   # the normalized view, starts nothing
```

`--daemon` defaults to v1's own daemon (`board/` in the v1 export). the
first run exports, installs and builds v1 into `board/trace/.work/`
(gitignored); later runs reuse it. worlds live under the system temp dir,
never inside a checkout. both commands stop everything they start, on
success or failure. replay writes its own run to
`board/trace/.work/replay-<scenario>/replay.json` for reading a diff
against, and the daemon's log to `.../daemon/daemon.log`.

needs: the boxbox v1 repo (not public), at the path in
`BOXBOX_V1_REPO`, holding the frozen commit, and the installed cmx binary
(`~/.local/share/cmx/bin/opencode`, or `CMX_BINARY`). ports 4880, 4881 and
3021 must be free.

## the evidence against v1

replaying each trace against v1's own daemon is the check that the
harness is deterministic: the same behaviour must give an empty diff. on
2026-10-01, `bun board/trace/replay.ts all` against the traces as checked
in printed `diff empty (leds, board, calls, radio)` for all three.

## how m6 uses it

1. port `board/daemon/src/client.ts` to v2. nothing else under
   `board/daemon/src` or `board/lib` changes; the checksum test holds them.
2. add `board/trace/world-v2.ts`: the cmx2 dev daemon from the pin (with
   its bench model or this trace model, `--shell-tool` set to cmx2's shell
   tool) behind boxbox v2's server, implementing `World` (`open`,
   `prompt`, `settled`, `quiet`, `aliases`, `redactions`) the same way.
   anything the v1 world does to make v1 faithful (minting the read
   baseline before setup, one commit in the scratch repo) has its v2
   equivalent or is shown unnecessary.
3. add `decodeV2` to `normalize.ts`: v2's wire onto the same intents
   (`focus`, `compose`, `markRead`, `replyPermission`, `replyQuestion`,
   `seats`, `mirror`, `telemetry` and the rest). if the ported client
   talks over something other than `fetch`, record it in `preload.ts`
   beside `fetch`. the leds, board and radio channels need no mapping:
   they are the frozen daemon's own output.
4. add `--world v2` to `replay.ts`, then run
   `bun board/trace/replay.ts all --daemon board/daemon --world v2`. the
   gate is the printed diff, empty on every channel, for all three traces.
5. the live half of the gate is not this harness: the real board on the
   mac, focusing, composing, answering a question and flushing a queue.

## what the traces do not cover

- scenes no trace sets off: the fault red flag, the victory lap, the
  briefing after a long absence, the queue view and its ent flush, the
  pairing ritual and liveries, the fleet waterfall with live tokens.
  adding one is a new scenario and a new recording; the trace model and
  worlds already have the vocabulary for most of them.
- the hardware itself: usb timing, the real firmware's clock, wispr's
  side of the radio. the live check covers those.
- v1 at any commit but `18df8bd`, the one the board was frozen at.
