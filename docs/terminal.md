# the terminal

a real shell on any machine, one tap from its machine window, that
survives the phone locking, the tab dying and the network flapping. the
shell runs in the cmx2 daemon; boxbox relays its bytes and never holds
more of them than its caps. this file is the whole story: the routes, the
wire, the relay, the pane, the caps, the close codes and how it is
verified. the look is in `design.md` (the terminal); the architecture row
is `architecture.md` (terminals, and the pty relay in memory caps).

what v1 learned and v2 keeps (from the boxbox v1 repo, not public): cursor accounting in utf-16 units, the gap rule, the
replay mute, resize by rest with a trailing debounce, redial on return from
the background, and a plate when the shell ends instead of a fake
resurrect. what v2 changes: the relay is a rust task with bounded pumps,
not a node pipe; the relay itself redials its upstream with its cursor;
there is one pane placed on the machines screen (and, when the thread
menu lands, "open a terminal here"), not v1's three surfaces.

## routes

every route is behind the gate (the session cookie) and names a host from
`boxbox.toml`; the host's credential is added by the server and never
reaches a browser. success bodies are cmx2's json, byte for byte; cmx2's
errors come back in boxbox's error shape.

| route | cmx2 | notes |
|---|---|---|
| `GET /api/hosts/:host/pty` | `GET /pty` | running terminals, and a session's exited ones |
| `GET /api/hosts/:host/pty/shells` | `GET /pty/shells` | the host user's login shell first |
| `POST /api/hosts/:host/pty` | `POST /pty` | `{command?, args?, cwd?, title?}`; always `origin: tui` (a person's terminal goes when it exits) |
| `GET /api/hosts/:host/pty/:id` | `GET /pty/:id` | |
| `PUT /api/hosts/:host/pty/:id` | `PUT /pty/:id` | `{title?, size?: {rows, cols}}`, 1 to 1000 each way, checked before the host sees it |
| `DELETE /api/hosts/:host/pty/:id` | `DELETE /pty/:id` | cmx2 waits up to 2 s for an interactive shell that ignores sigterm |
| `GET /api/hosts/:host/pty/:id/connect?cursor=` | `GET /pty/:id/connect` | the websocket; refused with 403 when the page's origin is not the host it asked |

## the wire

the relay speaks cmx2's pty websocket to the browser and adds two frames.

| frame | from | meaning |
|---|---|---|
| text | cmx2 | terminal output, verbatim |
| binary `0x00` + `{"cursor": n}` | cmx2 | the replay is over; the stream stands at `n` |
| binary `0x01` + `{"cursor": n \| null}` | relay | the relay lost cmx2 and is replaying from `n` (`null`: everything retained). output until the next `0x00` is that replay; an unfinished replay held before it is superseded |
| binary `0x02` | both | heartbeat, every 15 s each way |
| text, browser to relay | browser | typed into the terminal |

**cursors** count utf-16 code units (a string's `.length`), as cmx2 does.
the relay counts what it forwards the same way (`protocol::utf16_len`,
one pass over the utf-8 bytes), so the relay's cursor and the pane's agree
without byte math. a cursor is known only once a connection's `0x00` has
arrived; until then a replay may have skipped what cmx2 no longer holds.

**the gap rule.** cmx2 keeps 64 kb of a terminal's head and 256 kb of its
tail. a replay from cursor `c` that carried `r` units and ended at `n`
lost `n - c - r` units. the pane holds a replay until its `0x00`, so it
can judge it whole: with a loss it resets the screen, writes a dim
`· older output was not kept ·`, and paints the replay onto the clean
screen; it never splices across a hole. a first open (no cursor) is not
judged: it replays head and tail, and there is nothing to compare with.

**the replay mute.** while replayed output is being parsed, anything the
emulator answers (device attributes, cursor reports asked for long ago) is
dropped, never typed into the live shell (v1's t3 scar).

## the relay (`server/src/pty/`)

one tokio task per open terminal, owning the browser's socket, the host's
socket and two pumps. its parts run concurrently inside the task and share
only the pumps and a few atomic counters. `pty::Terminals` tracks every
relay so shutdown waits for them.

| part | does |
|---|---|
| `routes.rs` | the rest routes and the upgrade |
| `dial.rs` | the host's `ws(s)://.../pty/:id/connect`, the credential, tls through the platform verifier, errors in plain words |
| `relay.rs` | the task: the browser's reader and writer, the host's session, redial, the end |
| `pump.rs` | a queue bounded by bytes (a semaphore of permits) and by frames |
| `protocol.rs` | the frames, the utf-16 count, the cursor and the gap arithmetic |
| `telemetry.rs` | the relay's rows, normalized like any client's |

**down** (host to browser). output goes into a 256 kb pump the browser's
writer drains; a frame holds its bytes until the socket has taken it. a
replay waits for room (cmx2 bounds it by what it retains). live output that
finds the pump full means the browser has fallen behind: the relay closes
its connection to cmx2, waits until the browser has at most 64 kb left to
take, tells it a replay restarts from the cursor (`0x01`), and redials with
that cursor. cmx2 keeps what it keeps; the relay never holds more than the
cap. **up** (browser to host): typed input goes into a 256 kb pump the host's
writer drains; input that finds it full means the terminal is not reading,
and the relay closes the browser's socket with 4413.

**redial.** when cmx2's connection drops, closes with anything but 1000 or
1011, or goes 45 s without a byte (the relay pings it every 15 s), the
relay sends `0x01` and redials with its cursor, backing off from 250 ms to
5 s with jitter, for up to 30 s; then it closes the browser's socket with
4502. the browser's socket stays open throughout. a browser that sends
nothing for 45 s (no heartbeat) is gone; the relay ends.

**memory per relay.** at most 256 kb in each pump, plus tungstenite's
read and write buffers on each socket (a frame from cmx2 is at most 192 kb,
a frame from the browser at most 256 kb). a cmx2 frame over 1 mb is not
the contract and ends the connection.

**close codes** the browser hears:

| code | reason | the pane |
|---|---|---|
| 1000 | cmx2's: the terminal exited | the plate: "the shell exited." |
| 1001 | the server is stopping | redial with the cursor |
| 4401 | the host refused boxbox's credential | the plate, with what to check |
| 4404 | the terminal is gone (cmx2 404, or closed it 1011) | the plate: "this terminal is gone." |
| 4413 | input backed up | a note, and redial at once |
| 4502 | the host is not answering: why | after 5 s the head says so; redial with backoff |
| 1006 | (no close: the socket died) | redial with the cursor, backing off |

**logs**, one line per event, tied by `relay=<id>`: `terminal connect`
(the browser's cursor), `terminal attached` (cursor, replayed, dropped,
ms), `terminal lost its host; redialling from the cursor` (cause, why,
cursor), `terminal redialled`, `terminal dial failed`, `terminal relay
ended` (end, bytes each way, redials, overflows, how long it lived); and
`terminal call` for each rest call (host, method, route, status, latency).

## the pane (`app/src/ui/term/`)

| file | does |
|---|---|
| `wire.ts` | the frames as effects on the screen: hold, gap rule, reset, live (pure, tested) |
| `connection.ts` | the socket: dial with the cursor, heartbeat, 45 s silence, redial by close code, redial on return from the background |
| `screen.ts` | xterm.js, loaded on first open; the theme, the font, fit |
| `pane.tsx` | the pane: head, screen bed, keys row, the plate |
| `terminals.tsx` | a machine window's terminals and the shell picker |
| `keyboard.ts` | the keyboard inset, only while an editable holds focus (decision 19) |
| `navigation.ts` | `?terminal=<host>:<id>` mirrored with `replaceState` |
| `api.ts` | the rest calls |

**why xterm.js.** it is protocol-correct, maintained, one dependency, runs
in a home-screen pwa today, and cmx2 speaks xterm-256color at it. the dom
renderer everywhere: the text is in the page, so it selects natively on
touch, the accessibility tree and the drive read it, and safari has no
webgl context to take away; xterm measures each glyph and pads its cell,
so a character martian mono lacks still sits on the grid. it is 83 kb
compressed, so it loads only when a terminal opens: the app's first load
stays at 20 kb of script. libghostty compiled to wasm (t3 code's renderer)
is the known upgrade if xterm ever fails the bar on a real device.

**caps on the page.** 5,000 lines of scrollback (about 6 mb at 100
columns); a held replay flushes past 4 m units (a real one is at most
320 kb); input goes out in 8 k-character frames, so a paste never meets
the relay's cap as one frame; nothing typed while the socket is down is
kept for later, since a keystroke sent late can answer a prompt it was
never meant for.

**resize.** a resize observer refits the grid once a frame; the size is
sent (`PUT`) once it has held 150 ms, and again whenever a connection goes
live, so the terminal takes the size of the screen in front of you.

## telemetry

the relay writes the rows, since it is the one place that sees a
terminal's whole life; the pane names its device and class in the connect
url. kinds live in `telemetry/schema.ts`.

| kind | when | props |
|---|---|---|
| `term.open` | the first replay ends (ok 1, ms from the upgrade), or the host could not be reached (ok 0) | `resume`, `replayed`, `dropped`, `error` |
| `term.reconnect` | a redial's replay ends (ok 1, ms from losing cmx2), or the relay gave up (ok 0) | `cause` (dropped, stalled, overflow), `replayed`, `dropped`, `error` |
| `term.bytes` | the relay ends (ms: how long it lived) | `down`, `up`, `redials`, `overflows`, `end` |

## verification

`just build && bun bench/terminal.ts [rest relay overflow browser]` owns
every process it uses: the pinned daemon on 4890 (bench model 4891), the
cutter (`bench/cut.ts`) on 4892 between boxbox and the daemon, and the
release binary on 3031. cutting the cutter's connections is how the relay's
upstream drops for real. `bench/stall.py` is a reader with a 4 kb receive
buffer that stops reading (bun's sockets keep reading in user space when
paused). `bench/touch.ts` holds cdp touch emulation and taps, since
agent-browser's device presets do not turn touch on.

| step | proves |
|---|---|
| rest | every route, the gate, `stty size` after a resize, a 400 before the host, a 404 in boxbox's shape, kill |
| relay | replay and meta, typing, a resume from a cursor, 60 ticks exactly once across a cut with the replay counted, exit's 1000 |
| overflow | 10 mb into a stalled reader: the relay lets go at the cap, redials, stays live, rss flat |
| browser | the pane at 1512, 820 and 390 by accessible name: shell picker, a command's bytes, `stty size` at each width, the interrupt key by touch, 30 ticks across a cut, the pane's own redial with its cursor after a server restart, 10 mb with rss sampled, rename, kill, the plate |

**open.** cmx2-asks a14: a redial whose cursor falls in the output cmx2
dropped replays nothing instead of the retained tail, and the unused skip
then swallows live output (about 393 kb in the overflow step), so a pane
that fell far behind resets to an empty screen and stays empty until the
shell has printed past that stretch.
device checks that need a real iphone and ipad (the keyboard with the keys
row riding on it, dictation into the screen) are not yet done.
