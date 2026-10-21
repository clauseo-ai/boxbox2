# changelog

all notable changes, newest first. versions follow semver. the release
workflow publishes the section whose heading matches the version in
`server/Cargo.toml`, so every release needs a `## <version>` heading here.

## unreleased

- **the streams to devices are gzipped and batched.** the device stream and
  the board stream gather every ready frame into one write and, when the
  client sends `accept-encoding: gzip` (every browser does), compress it
  with one gzip context per connection, flushed after each write, so no
  frame waits: the recorded bench session goes from 17.6 mb to 0.56 mb a
  minute, and a burst of 40 events is one write instead of 80. webkit
  decodes the flushed stream frame by frame, on the page and in a worker.
  the server asks cmx2 for its stream switches (100 ms text batches, the
  19 event kinds it reads, compact catch-up, gzip) and reads cmx2's gzip;
  an older daemon ignores them. a part is parsed once instead of several
  times. the home overview's tails go out every 500 ms (was 200). a
  transcript read carries an etag and answers 304 without asking the
  daemon when the session is idle, its host connected and nothing changed.

- **the app holds only the threads on screen.** a closed thread leaves the
  page's store at once and is copied back from the worker when it opens
  again; the worker cools it to its saved copy 5 minutes after it closes,
  keeping the 3 closed last warm, and a reopened cooled thread comes back
  from indexeddb byte for byte. a reset re-reads only the threads on
  screen, applied message by message, and the fleet it carries is diffed
  against the one held. a hidden page does no page work: the worker holds
  its posts and lands them in one go when the page shows. a streamed
  answer is saved at most once a second and folded by size, so a
  10-minute answer writes 9.3 mb instead of 31; draft photos are read when
  their composer opens; the on-device cap is 50 mb (it was 150 mib). in
  bun, six fixture threads opened and closed held 22.2 mb, now 11.7 mb at
  once and 6.2 mb five minutes later.

- **a launch asks the network for less.** the page registers its service
  worker once (push used to register it again, three calls a launch, now
  one); the four app icons leave the offline precache (167 kb less to
  install and keep); push checks its subscription against a saved copy
  and asks the server at most once a day when nothing changed (two
  requests every launch before, none now); and the idle warm-up no longer
  loads the machines, history, settings and terminal screens nobody asked
  for (24 kb brotli), which load from the precache when first opened.

- **a thread opening from home makes only what is on screen until it lands.**
  the frame after the click filled the older of the newest turns, the stage
  window filled turns near the screen and the stage grew 32 older turns a
  frame, all inside the pour's own frames; now those wait for the pour to
  land (`motion/animate.ts` knows which boxes a running animation carries).
  frames dropped per pour on a heavy home: 2.72 to 0.72 in WebKit, 3.14 to
  1.13 in Chromium. on some threads the turn in view can sit a px off during
  the pour and is back in place when it lands. `bun .ladle/pour-frames.ts`
  steps every pour 16 ms at a time and compares the motion and the landed
  view with an earlier run.
- **the composer's model chip keeps its glyph while words are typed.** its
  svg was made again on every keystroke, beside the words being typed.

- **home and the thread set an attribute only when it changes.** while a
  fleet streamed, window clear names, the clear pill, the facts line, the
  answer's class and the dock's inert were set again to the same value
  about 27,000 times a minute, each one a style and accessibility pass;
  now none. the details' model and file rows and the ruler's marks keep
  their nodes instead of being rebuilt on every update, and the
  composer's model glyph is no longer made again on every keystroke. the
  `writes--` stories stream 300 sessions and a reply while someone types
  and fail on any same-value write or a name that lags the store
  (`.ladle/shots.ts`).

- **a streaming answer's saves store what it streamed.** indexeddb v5
  saves a part's appended text as chunk records, folded into the page
  when the part settles, the next message joins or a thread passes 256
  chunks, and keeps the per-part baseline in a record of its own instead
  of the head every save rewrites. saving a 24 kb answer as it streams
  falls from 13.98 mb of clones to 0.18 mb (a 100 kb answer 97.9 mb to
  0.99 mb), 10.8 mb of the old cost being the head. every load equals the
  last committed save, key order included, across kills at every write,
  two writers and upgrades from v4 and v3 (`sync/saves.test.ts`). after
  another tab's save, a cold thread is read again from its host rather
  than from pages this tab can no longer vouch for. a rollback to a v4
  build runs without its cache.

- **idle is a budget, with a bench.** `bench/idle.ts` (`just idle`, after
  `just build`) starts its own world on the dev ports, streams a fleet of
  ten threads beside a hundred done, and measures the built app in
  chromium for three minutes each with home visible, a thread open while
  its reply streams, and the page hidden: main-thread, worker and
  renderer time, layouts and paints per worker post, heap after gc,
  allocation, bytes received and attribute writes that set the value
  already there. the streams start on fixed offsets so runs compare.
  `docs/design.md` and `docs/verification.md` hold the idle budgets
  (home main thread 3% of a core, a streaming thread 8%, hidden 2%, no
  same-value writes) with `perf.sync` as their field row; the build
  after the perf lane meets the heap, allocation and worker budgets and
  misses the streaming thread's, which the next pass works on.

- **home and the stage re-read only the sessions a frame names.** each
  session is read in a memo of its own, home's window list re-runs on the
  clock only when a thread's 12 hours run out, each window's view is its
  own memo, and the stage's children and kin read a parent index; over
  3000 steps with 300 sessions, memo time falls from 11.8 s to 0.13 s and
  window views built from 994,482 to 2,919, with outputs equal to the old
  code kept verbatim in the tests. the live strip moves its marks in place
  (12 nodes made per tick, now none). the one second clocks of home, the
  composer and the stage stop while the page is hidden and land on the
  tick an always running clock would show when it returns; the 12 hour
  rule and the offline word keep their own wakes. the fold's motion and
  the plus menu's rows load when idle and on pointerdown, so the first
  load is 118.4 kb of 120 kb.

- **a streaming reply costs what changed.** a reply is painted in units
  cut at blocks nothing written later can change (raw html, a link
  definition, a footnote or a fence inside a list or quote stop the
  cutting), each parsed and sanitised once, so a 21 kb reply streamed word
  by word takes 0.45 s of painting instead of 13.7 s, and settled code
  blocks are not highlighted again. every prefix of every fixture and edge
  document paints the same dom as a whole render
  (`markdown-stream.test.ts`, and the `said-streaming-equivalence`
  story through the real sanitiser in `shots.ts`). the streaming code
  loads with the markdown engine, so the first load is 119.1 kb of the
  120 kb budget. the ruler, the jump and the stage menu drop their blur
  once faded out and get it back at once when shown, checked frame by
  frame in chromium and in webkit.

- **the worker writes only what changed to indexeddb.** one save commits
  at a time and the next gathers everything asked for meanwhile (16 saves
  queued at peak against a 1 s disk, now 2); the fleet is kept as a record
  per session, ask and host with an index of key order (database v4, the
  old whole-fleet record split in place on upgrade); a streaming thread's
  last message is a page of its own, so a delta writes one message. over
  the recorded replay, bytes written fall from 63.9 mb to 6.0 mb (98.5 mb
  to 6.8 mb with 305 sessions), and every load equals the state saved
  (`sync/saves.test.ts`). a second tab or a reload that saved in between
  is detected in the save's own transaction, and that save writes the
  fleet and its threads whole. the stall check is one timer against the
  last byte's time, a frame over 32 mb drops the connection with a growing
  backoff, and `perf.sync` reports frames, bytes, patches and writes once
  a minute. a rollback to the build before cannot open v4 and runs without
  its cache.

- **the worker posts the ui what changed.** a session the server sends
  whole again is diffed against the one held and reaches the ui's store
  leaf by leaf (a changed array item goes whole), streamed text crosses as
  the words added rather than the whole part, and coalescing keeps key
  order inside a session entry. over the recorded replay with a long
  answer, bytes posted to the ui fall from 5.17 mb to 0.38 mb and applying
  them from 3.6 ms to 1.4 ms; the ui's store at every apply and the
  worker's final state hash the same as on the build before
  (`sync/wire.test.ts`). the hydration buffer and the refetch holds get
  128 mb byte caps, sixteen frames at the server's frame cap.

- **repo colours are given by the server, and a person can choose one.**
  the first time the fleet shows a session of a repo with no colour, the
  repo gets the colour its machine's repos wear least (its old hash colour
  when that is free), so up to ten repos on a machine never share. a
  stream opened with `?colours=1` carries them as id-less frames outside
  the journal (the whole map first, then each change ahead of the repo's
  first window); without the flag the stream is unchanged, so contract 1
  and its protocol stay as they were. `PUT /api/prefs/colours` sets a
  repo's colour or puts it back to automatic. the thread's menu, the repo name
  above its title and settings' repo colours open the colour sheet, where
  trying a colour repaints the repo live and nothing is sent until "use".
  kept in `boxbox.db`'s `prefs`
  (scope `colour`, migration 10: a rollback past it needs the database from
  before the upgrade). decision 82.

- **the board's channel on the server.** with `[board]` in `boxbox.toml`
  (`machines`, up to four `label.machine` names, optional), the server
  serves `GET /api/board/stream` (hello, then a whole view whenever the
  board's picture changes, pins, replaced), `POST /api/board/act` (focus,
  compose, read, reply, flush, seats, bind, unbind, gone) and
  `POST /api/board/pin`, and app windows that open `/api/stream?board=1` on
  the board's mac get id-less `board.*` frames. the fleet actor computes the
  view only while a board stream is open, at most four rebuilds a second
  (84 µs for 300 threads in a release build, `perf.board_view`). the board's
  mac is found by client address: the socket peer, or the rightmost
  `X-Forwarded-For` from a loopback proxy. pairings persist in `boxbox.db`
  (`board_bindings`, made only where `[board]` is configured and outside the
  versioned schema, so a rollback still opens the database). without `[board]` the routes are not
  registered and nothing runs; `boxbox doctor` says which. `/api/stream`'s
  query parameters (`after`, and the new `board`) are now described as query
  parameters in the api document; they were described as path parameters.

- **what each machine is, and how it is doing.** the agents screen's machine
  card shows the os (a drawn mark), the machine's model and os version, cpu
  load, memory and disk as meters, and the host's uptime beside the daemon's.
  the cmx2 pin moves from 0bf2ba2 (the pre-public line) to 05e029c (cmx2
  0.8.14 on its public line, the first with `GET /global/system`; the
  vendored files are those of abfde5b, where the move was made, byte for byte). what changed in the
  contract, all additive, contract 7 still: the new route `GET /global/system`
  (`SystemResponse`: os, machine, cpu with its three load averages, memory,
  the data volume's disk or null, host uptime, the daemon's rss and uptime);
  `waiting` on a busy session status (why a turn has not started: a directory
  that does not answer); `cold` on `session.compacted` (required there; boxbox
  reads it as optional so a 0.8.8 daemon's compactions still decode, see
  `docs/gotchas.md`) and `refresh` on `compaction.prefire`. the server samples
  the route every 30 s while a host
  is connected and carries it on `GET /api/hosts` as `system`, with
  `reportsSystem` false for an older cmx2, whose card shows what it can
  without meters.

- **the openclaw dev gateway.** `openclaw.pin` pins openclaw e178c39 (2026.10.1,
  protocol 4), `vendor/openclaw/protocol.schema.json` is vendored from the
  published `@openclaw/gateway-protocol@2026.10.1` and held by `just check`,
  and `just openclaw` builds the pinned gateway and runs it with a scripted
  model (docs/openclaw.md, section 11). recorded wire fixtures live in
  `server/tests/fixtures/openclaw/`.

- **images in read rows.** a tool call that read images opens to thumbnails,
  and a thumbnail opens the image full size. the cmx2 pin moves from 2364633
  to 0bf2ba2, which adds `attachments` and `attachmentsDropped` to a completed
  tool state (additive: at most 8 images and 4 mb of data urls a part). the
  server's upstream frame cap goes from 4 mb to 8 mb so such a part is not
  skipped.

## 0.1.0

first version. it is a pre-release: everything below is built and tested, and
`docs/open.md` lists the known problems.

- **server.** one rust binary that watches every cmx2 daemon, builds one model
  of the fleet and serves it to devices over a resumable event stream with a
  cursor at every hop. it gates itself with a password and a signed cookie,
  keeps read state and push subscriptions in sqlite, and relays terminals.
- **web app.** a home-screen app with one live window per thread, a thread
  view with a row for each step, a composer that sends, queues and steers, an
  inbox for questions and permissions, a machines screen with pairing and
  terminals, light and dark themes, and a code review card.
- **push.** web push notifications for asks, faults and finished turns. boxbox
  stays quiet while you are looking at the thread on any device.
- **board.** support for the 17-key usb board, with its daemon ported to the
  boxbox api and a replay harness that holds its behaviour to recorded sessions.
- **install and operate.** `boxbox init`, `doctor`, `service` and `upgrade`,
  a linux release for x86_64 and aarch64 with `install.sh` and checksums, a
  launchd agent for macos, and a systemd user unit.
- **telemetry.** a documented event dictionary, an append-only log per day and
  a query tool.
- **cmx2 pin.** built against the commit in cmx2.pin (cmx2 0.8.8, contract 7).
  the vendored contract files are checked against the pin on every
  `just check`.
