# plan

dependency-ordered milestones. milestones order the work; they do not
shrink it: `design.md`, `architecture.md` and the rules in `AGENTS.md` are
the definition of done for the whole project, and every milestone ships finished (tested, measured, beautiful), never a rough cut
to polish later (decision 13).

each milestone is one unit of work with a goal sentence. the sentence is
written so a reviewer reading only the transcript can judge it: the
condition is evidence printed into the transcript (test output, request
logs, screenshots taken and looked at, rss and timing numbers, telemetry
rows), and every goal ends with a turn limit and a report clause. the cmx2
dev daemon runs from the commit in `cmx2.pin` on a port from 4840 to 4849
and the boxbox dev server on 3001 (AGENTS.md, cmx2), never against a
daemon you did not start.

**sequencing against cmx2.** m0 and m1 need only what the pinned cmx2
(the commit in `cmx2.pin`) serves today. m2 starts when cmx2's
`docs/engineering/ASKS.md` marks a1 to a3 landed; m3 needs a4, a5 and
a11; m4 needs a6. a gated milestone opens by moving the pin to a cmx2
commit that has them (AGENTS.md: moving the pin) and running their probes
(`verification.md`). if they have not landed, the session builds nothing
around the gap (decision 9): it reports the missing
asks and stops. any new gap found along the way is appended to ASKS.md as
an unassigned row.

## m0 · the skeleton, public from the first commit

- repo as a public project: mit `LICENSE`, `README` with the intended
  quickstart, `CONTRIBUTING`, `SECURITY`, `CHANGELOG`, `THIRD_PARTY`.
- cargo workspace (`server/`), vite + solid + typescript app (`app/`), the
  board layout from decision 14 (`board/daemon/src/`, `board/lib/`, copied
  byte for byte from v1 at a recorded commit, with a checksum test), and
  `telemetry/schema.ts` plus the query tool carried from v1.
- cmx2 wiring: `cmx2.pin` (already written), `vendor/cmx2/openapi.json`
  and `vendor/cmx2/manifest.ts` copied from the pinned commit, `just
  vendor`, and `just cmx2` running the dev daemon from the pinned commit on
  a port from 4840 to 4849.
- one binary: the server embeds the built app and serves it; `just dev`
  runs the dev server on 3001 with hot rebuild, one command, children die
  with it; `just check` runs fmt, clippy with warnings denied, `tsc
  --noEmit`, unit tests, the schema drift test, the vendored-files-match-
  the-pin test and the board checksum test.
- `docs/deploy.md` drafted; systemd unit with `MemoryMax` and drain.
- ci runs `just check` on every push.

**gate:** `just check` green in ci, including the vendored files matching
the pinned commit; `just cmx2` answering `/global/health` on its port with
the pinned version; the release binary serves the app shell at `/` with a
hashed asset under 120 kb compressed; the binary's idle rss printed; `just
dev` on 3001 started and stopped with no process left behind (`ps` printed
before and after).

**goal:** "m0 of boxbox v2 per docs/plan.md is done: print `just check`
passing (vendored cmx2 files matching cmx2.pin included), `just cmx2`
answering /global/health on a port from 4840 to 4849, the release binary
serving the app shell (curl of `/` and of one hashed asset with its
compressed size under 120 kb), its idle rss from `ps`, and `ps` output
showing `just dev` leaves no process behind after it stops; or, after 40 turns, report what is done, what is
verified, what is not, and the exact next command, and stop."

## m1 · everything the pinned cmx2 already supports

needs nothing beyond the cmx2 commit in `cmx2.pin`: the event stream as it is today
(no cursor), `/global/health`, and `openapi.json`. nothing in m1 depends
on resuming a stream, so nothing in m1 works around a missing ask.

- rust types generated from `vendor/cmx2/openapi.json` at build time;
  typescript types for the app generated from the same file.
- boxbox's own api described with `utoipa`; the app's client generated
  from it.
- typed config (`boxbox.toml`); host credentials server-side only.
- the password gate: `POST /api/login`, the signed cookie, the dev cookie
  name, the flat delay on a wrong password.
- the upstream watcher per host: hand-written sse reader with a 4 mb line
  cap, 45 s byte watchdog, reconnect with jittered backoff, decode into the
  generated `Event` union, undecodable frames logged and skipped. it
  reconnects; it does not pretend to resume (that is m2, on a1).
- host health and version in the server log and at `GET /api/hosts`.
- telemetry: ingest at `POST /api/telemetry`, normalized by rust code
  generated from `telemetry/schema.ts`, written to the same daily ndjson
  files v1 wrote, readable by the carried query tool next to v1's days.

**gate:** against the dev daemon from the pin, a scripted session
(prompt, tool calls, a question, an answer, a queued prompt, an abort) is
watched end to end: every frame decodes (count printed, zero
undecodable); killing and restarting the daemon shows the watcher
reconnecting (log printed); rss steady within 2 mb across 1,000 events;
login accepts the right password and refuses the wrong one after the
delay; a telemetry batch posted to the server comes back from `bun
scripts/telemetry.ts query` alongside a v1 row.

**goal:** "m1 of boxbox v2 per docs/plan.md is done: against the cmx2 dev
daemon started by `just cmx2` from cmx2.pin, print the watcher log for the
scripted session in docs/verification.md with every frame decoded (count,
zero undecodable), the reconnect after the daemon is killed and restarted,
rss before and after 1,000 events within 2 mb, the login accept and refuse
responses, and a telemetry query returning a v2 row next to a v1 row; or,
after 40 turns, report what is done, what is verified, what
is not, and the exact next command, and stop."

## m2 · the sync spine (starts when ASKS a1 to a3 land)

- move `cmx2.pin` to a commit where cmx2's ASKS.md marks a1 to a3 landed;
  re-vendor, regenerate, run the a1 to a3 probes (`just probes 4840 a1 a2 a3`,
  `verification.md`) and print them at `pass`.
- upstream resume with `Last-Event-ID`, dedupe by `(host, seq)`,
  `stream.reset` handling with seq-stamped rest reads.
- the fleet actor and the fleet model: sessions index, statuses, asks,
  queue, parked detail, counts, window tails, order.
- the journal: ring with `(epoch, seq)`, byte and count caps.
- `GET /api/stream` with replay from the ring, `reset` plus snapshot,
  15 s heartbeat, 512 kb outbound cap with close on overflow.
- the sync worker: fetch-stream reader, cursor, exhaustive reducer,
  indexeddb layout, patches to the ui once a frame.
- a debug view in the app that lists the fleet model live (the real ui
  arrives in m5).
- telemetry: `app.stream` with `resumed` and `replayed`.

**gate:** the exactly-once suite (`verification.md`): with a scripted
session streaming, (1) drop the browser's connection 20 times, (2)
restart the boxbox server, (3) restart the cmx2 daemon, (4) sleep the
browser tab 10 minutes; after each, the worker's transcript for the
session equals the daemon's `GET /session/:id/message` byte for byte and
no event was applied twice (reducer counters printed). a 10 minute stalled
reader shows the server's rss flat and the stream closed. journal and
per-connection caps shown holding.

**goal:** "m2 of boxbox v2 per docs/plan.md is done: print the
exactly-once suite from docs/verification.md passing in all four
disruption cases, each with the transcript diff against the daemon empty
and the duplicate-apply counter at zero, plus the stalled-reader run
showing server rss flat and the stream closed at the 512 kb cap; if cmx2
has not landed ASKS a1 to a3 at a commit the pin can move to, report them and stop; or, after 60
turns, report what is done, what is verified, what is not,
and the exact next command, and stop."

## m3 · the thread (needs ASKS a4, a5, a11)

the composer left this milestone on 2026-10-01: it is its own
component with a target (a session, or a new thread in a repo), it is
also mounted on the windows home (m5), and it is built in its own lane
under `app/src/ui/composer` from directions the maintainer picks first. m3 is
the thread read and answered; the daemon's write path is served by the
server for the composer to call (`thread.md`, the stage as built).

- move the pin to a cmx2 commit with a4, a5 and a11; probes first (the
  pin of 2026-09-30 already has them).
- the ledger (`thread.md`) wired to the sync worker: hydration at a seq
  including the in-flight message, deltas applied, a reload mid-answer
  paints what was written and continues.
- the stage chrome for real: the condensing bar, the big title, the ruler,
  the turns panel, the menu, the scroll law (pinned, "new below").
- ask cards answering in place with a `clientID`, honest states, and the
  ask risen out of the live window or carried above the dock when out of
  view.
- links: `?thread=&at=&part=` kept current, deep links landing on a row.
- markdown in answers and reports sanitised.
- the ios viewport law in place (decision 19).
- telemetry: `perf.send` (a reply to the ask leaving the stream),
  `perf.thread` (a thread's first frame, a row opening, a stream event to
  a glyph), honest `ok` from what happened.

**gate:** `bun bench/thread.ts` (`verification.md`, the thread drive)
against a real cmx2 dev daemon and the dev server, driving agent-browser
through the accessibility tree at 390, 820 and 1512: a turn's rows on
stage, a question and two permissions answered in place by their names and
settled on the daemon and on the stream, a thread opened mid-answer
showing the partial text, a reload mid-answer painting what was written
and continuing, a deep link opening its row, screenshots at the three
widths taken, looked at and run through the craft check, and, from the
telemetry the server wrote, reply-to-settled p90 under 400 ms over 50
replies. the composer's gate (send, queue, unsend, run now, steer, the
network-kill retry with the prompt once in the daemon's transcript) moves
with the composer.

**goal:** "m3 of boxbox v2 per docs/plan.md is done: print the thread
drive from docs/verification.md passing against a real cmx2 dev daemon,
including the mid-stream open showing partial text, the reload mid-answer
continuing, the asks answered in place and settled on the daemon,
screenshots at 390, 820 and 1512 widths described, and reply-to-settled
p90 under 400 ms from telemetry rows; if cmx2 lacks asks a4, a5 or a11,
report them and stop; or, after 60 turns, report what is done, what is verified, what is not, and the
exact next command, and stop."

## m4 · asks, needs, read state and push (needs ASKS a6)

- move the pin to a cmx2 commit with a6; probe first.

- asks as one entity: permission and question cards, in place in windows
  and in the transcript, keyboard and touch; settled elsewhere shows who
  and when.
- needs and the window order computed in the server; read state in the
  server, max-merged, sent to every surface; no self-inflicted unread.
- presence, the push decision function with its table tests, "done"
  delay and cancel, tags per thread, badge, `push.decided` for every
  decision, service worker push handling, mac action buttons.
- settings: which kinds push to which device.

**gate:** the push matrix (`verification.md`): each row (watched on this
device, watched on another, visible but idle for 2 minutes, all hidden,
own interrupt, subagent, replayed) produces the expected `push.decided`
row, and the "all hidden" rows arrive as real notifications on a real
subscribed browser. an ask answered on one client disappears from another
within 1 s. a reply to a settled ask shows "answered on ... at ...".

**goal:** "m4 of boxbox v2 per docs/plan.md is done: print the push
matrix from docs/verification.md with every row's `push.decided` telemetry
row matching the expected decision, the delivered notifications shown
arriving on a subscribed browser, the cross-client ask clear under 1 s
with timestamps, and the decide() table tests passing; if cmx2 lacks ask
a6, report it and stop; or, after 60 turns, report what is done, what is verified, what is not, and the exact
next command, and stop."

## m5 · the windows, the motion, the budgets

- the deck, the strip and the rail with live windows: tails in the
  grammar of `design.md`, chips, footers, answer in place, order as inbox,
  the calm laws (nothing moves under a finger, the glide rule, replay
  without motion, offscreen windows still).
- every transition in the motion law: grow and shrink, pour on the rail,
  the capsule, the interactive back gesture, the flying answer, the queue
  advancing, the new-thread birth; the earned moments; reduced motion.
- the offline and update states; the cold launch from cache.
- the visual system: type, the ten repo colours checked for contrast,
  depth planes; the dark appearance first, the light appearance designed
  in the same milestone.
- telemetry: every `perf.*` budget in `design.md`.

**gate:** the budget run (`verification.md`) on the real ipad 10th
generation and the real iphone as installed pwas: cold launch to cached
paint p50 under 300 ms and p90 under 700 ms over 20 launches; no long task
over 50 ms during a 2 minute streaming session (performance trace
summary); zero layout shift; the transition frame check with no dropped
frames at 60 fps; 8 hour soak with the client heap under 150 mb.

**goal:** "m5 of boxbox v2 per docs/plan.md is done: print the budget run
from docs/verification.md with every row at or under its design.md
target (cold launch p50 and p90, long tasks, layout shift, dropped frames,
8 hour heap), with the device, build id and raw telemetry rows for each,
and screenshots of the deck, strip and rail described; or, after 80 turns,
report what is done, what is verified, what is not, and
the exact next command, and stop."

## m6 · the board

- the board channel in the server: bindings, seats, frame mirror, focus,
  compose, pin arming.
- the ported `client.ts`, translating v2 into the `BrainEvent` shapes;
  every other board file byte for byte (checksum test).
- the app obeys focus and compose with the same motion as a tap and shows
  seat digits on windows.

**gate:** the recorded v1 trace (keys in; http calls and led frames out,
captured against v1 before cutover) replayed against v2 with a fake
serial port: every led frame byte-identical and every call semantically
identical (diff printed, empty). a live check with the real board on the
mac: focus, compose, answer a question, flush a queue.

**goal:** "m6 of boxbox v2 per docs/plan.md is done: print the board
trace replay from docs/verification.md with the led-frame diff empty and
the call diff empty, the checksum test showing every board file except
client.ts unchanged from v1, and the live run with the real board
logged; or, after 50 turns, report what is done, what is
verified, what is not, and the exact next command, and stop."

## m7 · the rest of the surface

- ⌘k palette, all threads with search, new thread with repo picker and
  fresh checkout (when cmx2 m6 ships worktrees), the details panel and
  sheet (roster, processes with kill, files, cost), the thread menu
  (rename, model and effort, fork, compact, revert, archive, copy link as
  cmx2 serves them), the terminal relay and pane, machines and settings.
- every keyboard shortcut in `design.md`, verified in the installed mac
  pwa.
- the remaining telemetry kinds in `telemetry/schema.ts`.

**gate:** the full surface drive (`verification.md`): every control in the
app reached by agent-browser through its accessible name and exercised
against a real daemon, with the request log printed; the terminal typed
into and resized, redialled after a dropped socket with the cursor.

**goal:** "m7 of boxbox v2 per docs/plan.md is done: print the full
surface drive from docs/verification.md with every control exercised by
accessible name against a real cmx2 dev daemon and its request log, the
terminal redial with its cursor shown, and the shortcut table verified in
the installed mac pwa; or, after 60 turns, report what is
done, what is verified, what is not, and the exact next command, and
stop."

## m8 · first run, deploy, cutover

- first run for someone new to the project: password, add a machine
  (pairing when cmx2-asks a12 lands, a password until then), notifications
  with one line on why, the empty deck.
- deploy on the vm per `docs/deploy.md`: binary by atomic rename, systemd
  unit, same origin; the v1 app retired only after the soak.
- cutover soak: v2 runs as the maintainer's only client for 3 days.

**gate:** a fresh install on a clean machine following only the README
reaches a first thread; the vm deploy's health and rss printed; the soak's
telemetry digest shows zero reloads needed (`app.boot reason=reload`),
push delivered for every armed "done" and every ask while no device
watched, and no budget regressions.

**goal:** "m8 of boxbox v2 per docs/plan.md is done: print the clean
install transcript reaching a first thread from the README alone, the vm
deploy's health and rss, and the 3 day soak digest showing zero reloads,
every eligible push delivered, and every budget in design.md met; or,
after 40 turns, report what is done, what is verified, what
is not, and the exact next command, and stop."
