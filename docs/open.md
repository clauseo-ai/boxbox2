  source's to schedule. · `rg -n 'ThreadIds::new' server/src`.
- [agents] not driven live against the dev daemon: `POST
  /api/agents/{agent}/asks/{id}` and `POST T/compact` for cmx2 (unit
  tested through the scripted source and the typed mapping only).

### found or left open by the colour, inspector and folds lane (2026-10-02)

- [details] no processes in the details. cmx2 serves a session's
  processes (`GET /session/{id}/procs`, `POST /proc/{id}/kill`), but
  boxbox's server routes none of them, so the details say nothing about
  them rather than guess. a server route (with telemetry and a drive
  against the dev daemon), then a section in the details. · design.md, the
  header, the details and the menu.
- [review] a review card out of view says nothing. the stage lands on the
  turn `&at=` names (a relaunch, a shared link) and nothing moves once the
  reader scrolls up, both by the scroll law, so a card below the view is
  only found by scrolling: at 390 on a link to the thread's first turn the
  card sat at y 1735 in an 844 view with no line about it; scrolled up when
  a new request came, the only sign was "5 new messages below". opening a
  thread from home, a cold load of its url without `at`, and a request
  arriving at the end all showed the card in view (y 374 to 667, the
  composer at 764). the law's own answer for an ask is the line above the
  dock ("wants you: ... go to it", stage.tsx `pinned`), a scroll the
  person asks for; carrying a review the same way is a design call, not
  made here. · `?thread=<key>&at=<first turn>` at 390 with a review open.
- [review] a cleared thread keeps its open review (and its badge) while
  it leaves home: clear serves only done and fault, by design (the
  worktree still waits on a merge). · clear a thread with an open review.
- [needs] a reply sent with `POST .../queue` (no device in its body) serves
  no review and arms nothing, so a review waits through a queued reply
  until the turn it starts is the device's some other way, or its
  checkout merges. prompt, steer and command carry a device and serve it
  (`Fleet::review_answered`). · queue a prompt from the composer on a
  thread with an open review.
- [review] discarding a checkout twice answers 502 `host-said` with
  `ENOENT ... posix_spawn 'git'`: the first discard removed the directory
  the session is still homed in, and cmx2 spawns git there. a merged
  checkout read again is 404 `no-such-checkout` (cmx2 says 400
  `WorktreeRefusedError` reason `primary`). the app serves the card away
  when `worktree.merged`/`discarded` arrives, so a second tap is rare; an
  ask for cmx2 to answer a vanished checkout in its own words is not
  filed. · merge, then discard, then discard again on the dev daemon.
- [review] a merge or discard that outruns its answer (the daemon takes
  longer than 90 s) answers 502 while the daemon may still finish it; the
  `worktree.merged` event serves the need either way. · not driven.
- [details] the figures (spend, tokens, cache share, context, models) are
  driven only by the shell story's recording and a made-up story; no real
  thread with several models, live agents or a context near compaction has
  been looked at. · open a long real thread at 1512 on the installed
  unit.
- [stage] the scroller's top edge is a mask (the bar's dissolve) on the
  one element that scrolls; its scroll cost on an iphone is unmeasured
  (perf.longtask, perf.input on the device run).
- [thread] the live turn is unproven in safari and on an iphone: the
  live step group (its strip's head, the run folding whole) and the
  follow. the streaming reply repaints its markdown once a frame; its cost
  on a long reply is unmeasured (perf.longtask on the device run). the
  "done just now, worked 1 min" line has no unit test (it lives in
  stage.tsx). · `stage--live-heavy-turn` in the stories, then a real
  `[bench:work]` turn on the installed unit at 390.
- [thread] the faint ink (`--text-3`, 38%) is under 4.5:1 on the floods
  (2.5 to 2.7). every faint word that carries information moved to the
  second ink (the clock, a row's directory, the gap line, a step group's
  line, the details' asides and times; `stage-flood.test.ts` holds
  them). what stays faint is toned down on purpose by the law (a
  command's flags and pipes, a done plan item, a bed's cut and hunk lines,
  a stopped result); whether each of those is decoration or information is
  a design call, one at a time.

- [icons] real favicons wait on cmx2 ask a28 (a file's bytes can be read).
  a28 has been in the pin since the move of 2026-10-03; what follows "when a28
  lands" below is what remains.
  the server's `GET /api/hosts/{host}/repo-icon` is built and unit-tested
  against the a28 shape with a local daemon that answers it. against the
  pinned dev daemon the first read meets the unknown-route 404, so the route
  answers 404 with `x-repo-icon: unsupported` and `max-age=300` and no
  listing is asked for, and every repo wears the repo-coloured squircle with
  its initials. nothing has read a real image off a real daemon: the image
  path, the next.js prerender path and the byte caps are verified against
  the fake only. when a28 lands: move the pin, `just vendor`, add a probe for
  `/file/content` (the three error names, the sniffed type of an
  extensionless png, the 413), run the route against a project with a
  `public/favicon.svg` and an `app/icon.tsx` built with next, and check that
  `FileNotFoundError` is the name the daemon gives (the server takes any
  other 404 for a missing route). · `curl -b jar
  ".../api/hosts/<host>/repo-icon?root=<a project root>"` answers
  `x-repo-icon: unsupported` today and `200` with image bytes after a28.
- [icons] a big repo still stalls its daemon while a listing runs: cmx2's
  `find/file` walks the directory with a synchronous ripgrep on its event
  loop (cmx2 ask a29). the lookups never list the host's home or a
  directory above it (`x-repo-icon: refused`) and read well-known paths
  before listing, so a repo that keeps its icon where icons live is never
  listed; a repo that does not (a monorepo package's `public/`) is, for as
  long as its walk takes. a listing cut at the daemon's 10 s is taken as
  complete (no icon for 30 minutes), and a host whose home is a symlink is
  not recognized as home (`/global/fs` does not resolve it). · a root with
  300,000 files held a `/global/health` for 137 ms (1 ms idle), measured on
  the dev daemon; `find/file` on a root of that size is the check after a29.
- [app] `session.rs`'s `scoped` (providers, `find/file`) sends the project
  directory raw in `x-cmx2-directory`; a path with a non-ascii byte cannot
  ride a header, so those two reads fail with "that is not a directory" for
  such a project. the repo-icon lookups percent-encode it
  (`icons/discover.rs`); `scoped` should too, and cmx2 decodes it
  (`directoryOf`). · a project under a path with an accented letter: the
  `@` picker and the providers row fail, the icon lookup does not.

### device-only checks

- logout survival: log out and in, then `launchctl print
  user/$UID/dev.boxbox.serve` shows the unit running and the page
  answers. loaded with LimitLoadToSessionType Background, never driven.
- the iPhone and iPad budgets (perf.shift, longtask, first paint) on the
  device; this mac's numbers were taken at load 40 to 280 and only the
  device run judges.
- push: a tap on a lock-screen notification opens the thread.
- the keyboard on a real ios: the composer stays above it, the stage
  owns the inset.

- [composer] unproven on a device: the sheet's focus inside the opening
  tap raising the keyboard on ios, the model and effort chips not raising
  it, and the top row's fixed height with the keyboard up. · the one device
  pass in the list above.
- [composer] the bench drive (`bench/composer.ts`) was updated for the new
  names (model chip, effort dial) and not run against a real daemon this
  turn; the real loop was driven by hand at 390 and 1512 instead.
- [composer] the finder reads folders on a pause in typing and offers the
  folders cmx2's `/global/fs` lists; hidden folders are not offered.

- [history] a run of more than 1000 threads sharing one `updated_at` on
  one machine cannot be passed: cmx2 lists a run only by the page that
  holds it (1000 at most). the rest of that millisecond is dropped. ask
  a25 in cmx2-asks.md. · a bulk import of 1100 sessions.
- [history] a thread archived or deleted while boxbox was down is dropped
  by a confirm that runs once after the start (`confirm_adopted`,
  `http/threads.rs`): each adopted thread is asked of its daemon, for up
  to half a minute if the daemon does not answer yet. a daemon that answers
  inside that window drops it; one that comes back later does not, because
  the confirm has stopped trying, so the archived thread stays held as
  stored until boxbox starts again (it usually ranks past the order's 300,
  and a send to it gets cmx2's 409). the fix is to confirm at each host's
  first successful read, and to drop the held copy when adopt itself
  answers 404. · stop boxbox and the daemon, archive an adopted thread,
  start boxbox, bring the daemon back after 40 s: the thread leaves.
- [server] a malformed query or json body (axum's own rejection, for
  example `before=x` on a typed number or a body that is not json)
  answers axum's raw text, not the app's error voice, probably on every
  route. · `curl` a route with a body that is not json.
- [home] clear done takes at most the order's 300 keys; a fleet past
  that needs two taps. · the clear done count on a 600-window fleet.
- [home] 300 windows render at once on a bulk fleet (the scratch
  daemon's 320 seeds); the cost per window was not profiled
  (hypothesis: window render). · perf.longtask on the bulk fleet.
- [thread] archive of a working thread was driven through the route only
  (a `[bench:words 80 250]` turn busy, then archive: the daemon's status
  went away, `time.archived` set, the fleet dropped it), not through the
  confirm's extra sentence on a screen. · tap archive in a thread's menu
  while it works.
- [thread] on the rail, an archive from a thread opened out of history
  once failed to release the stage live (reviewer's blocker; the fix is
  home.tsx's, 2026-10-02). re-driven at 1512 on a light fleet: the stage
  went to the next window. unproven on a heavy fleet. · archive from
  history at 1512 on a fleet of 600.
- [home] a clear that is refused (a thread that started working between
  the tap and the answer) was driven at 1512: the window came back with
  "it is working, so it stays. clear it when it finishes", and the line
  was gone once the thread finished. not driven at 390.

- [composer] a first message refused with photos loses the photos: an outbox
  view keeps only their count, and "edit" restores words, model and effort.
  · keep the photos in the view, or a refused send keeps its entry until
  "edit".
- [composer] a photo beside a pending ask: the send word says "answer" and
  the line says "answers the question above", but only a draft with no photos
  is sent as an answer (an answer takes none), so words with a photo go to the
  thread as a message and the ask stays pending. found at the merge with the
  heic lane, not driven; main reads the same. · the word and the line follow
  the photos ("queue"), or the card says an answer takes none.
- [composer] the repo chip for a folder walked to by a different name than
  the repo's (a symlinked path) is unified only when a thread already runs
  there. · a host route that resolves a path.
- [board] `/api/board/compose` (`composeMachine`) is not served by boxbox;
  the board's composer posts to it. predates the usability work. · decide
  whether the board's composer is served or removed.
- [tests] `outbox.test.ts` "a telemetry row in the outbox" is flaky. predates
  the usability work. · find what the row's timing depends on.

- [composer] a failed model list is read again when the stream comes back by
  an effect on the stream's state and `since`; the retry button and the
  return to the foreground were driven, the stream coming back was not.
  · cut boxbox's stream mid-session with the models route aborted.

### the openclaw dev gateway (ocbench lane, 2026-10-15)

- [openclaw] the bench boxbox configs get no `[[openclaw]]` entry yet: the
  server's config is `deny_unknown_fields` and has no openclaw section, so
  writing one would break `just dev`. `writeBoxboxConfigs` adds it when the
  server reads `[[openclaw]]` (docs/openclaw.md, 11.6) · `just dev` starts
  with the entry present.
- [openclaw] webm and ogg voice notes heard by the agent: untested; the
  bench has no transcription provider (the scripted model cannot hear), so
  `openclaw_attachments`' "heard" half needs a real or scripted stt
  provider · the request log shows a transcript of the note.
- [openclaw] the chaos switches that need boxbox's debug hook (drop
  boxbox's socket mid-turn, pause its reader) wait for the server's
  openclaw client · `openclaw_gap_free` and `openclaw_slow_consumer` pass.
- [openclaw] the reminder test scripts the `automations` call; it proves
  the gateway runs the tool from a suppressed send and the job fires on
  both benches, not that a model chooses the tool for "remind me in 2
  minutes" · a real-model run on a test gateway.

### the openclaw connection (occonn lane, 2026-10-15)

- [openclaw] an `[[openclaw]]` entry runs (dials, pairs, keeps its device
  token, reconnects) but publishes no agents, so nothing of it reaches the
  fleet or the agents screen, and its verbs answer `NotBuilt`: agents (3.8),
  snapshots and the verbs are the sync and verbs phases, after the `agents`
  table lands · `[[openclaw]]` agents on the agents screen.
- [openclaw] the openclaw module carries `allow(dead_code)` while parts of
  its client api (`Frame::decode`, `Events::backlog`,
  `ConnectionState::connection_status`) wait for those consumers ·
  `rg -n 'mod openclaw' -B5 server/src/main.rs` shows no allow.
- [openclaw] `[[openclaw]]` entries are started once at boot; a config
  reload does not add, change or stop one (the supervisor's reload carries
  hosts only) · editing an entry and reloading restarts its connection.
- [openclaw] the last `bootId` is held in memory, so a gateway that
  restarted while boxbox was down is not reported as restarted on boxbox's
  first hello; persisting it is the sync engine's cursor row (5.2, 5.8) ·
  `Hello::restarted` after a boxbox restart across a gateway restart.
- [openclaw] a revoked device token falling back to the shared token and
  asking for approval again (`AUTH_DEVICE_TOKEN_MISMATCH`, 3.4) is unit
  tested, not driven live (`openclaw_pairing`'s last clause) · a live run
  that revokes with `devices revoke` on the lan bench.

### left open by the perf gates lane (2026-10-20)

- [perf] the idle budgets' main thread busy time, allocation rate and heap
  have no field kind: `perf.sync` carries the worker's volume and
  `perf.longtask` the long tasks, but a quiet page burning a core, or a
  heap that climbs over hours, shows only in `bench/idle.ts`. fix shape: a
  minute row from the page (task time while visible and hidden,
  `performance.memory` where it exists). · the kind's rows over an idle
  hour on the installed app match the bench's shape

- [perf] the idle budgets are judged in chromium; webkit, where people run
  the app, is unmeasured by script (playwright's webkit is not installed
  and has no readable trace, and the run fakes hidden because headless
  chromium never reports it). · web inspector's timelines and activity
  monitor on the installed mac app with the display asleep, before and
  after, against the same fleet

### left open by the protocol 3 server (2026-10-21)

- [sync] the interest confirm's 30 s stall has no http test: the actor
  side (a post meeting an unread block is busy, waits for it to drain, and
  past 30 s the stream is closed) is tested in `fleet/mod.rs`, and the
  handler's wait in `http/stream.rs` (`confirmed`, the block's 30 s) on
  paused time without the route. ·
  an http test that leaves a confirm block unread for 30 s sees the second
  post answer 404 `no-such-stream` and the stream end.
- [sync] the encoder's remembered message and part states are not
  narrowed to each thread's newest turn as `protocol.md` section 8's last
  paragraph says: they are 4,096 parts and 4,096 messages, oldest out
  first (`fleet/encode.rs`, `REMEMBERED`), so a busy fleet can forget a
  digest and journal one unchanged re-send. · a test where an older
  turn's message is re-sent after 4,096 newer ones and nothing is
  journaled.
- [sync] full resume keeps no window tail read in flight and no encoder
  digests (finished text, unchanged re-sends): after a restart a tail
  being read is asked again on its thread's next change, and the first
  re-send of a part goes whole. · `fleet/model/state.rs` (`floor`).
- [sync] an openclaw connection's own cursors (`source_cursors`) are not
  written in the stream's batches: after a restart its source reads the
  agent afresh, which the quiet re-read takes with no revision, so each
  of its threads gets one `thread.reset`. · `docs/agents.md` section 3.
- [sync] the home, thread and switch goldens in `server/goldens/protocol3/`
  are built by the test from the journal, not recorded from the server's
  own interest switch. · a golden recorded through
  `POST /api/stream/{stream}/interest`.
- [verify] `bench/golden-live.ts` still reads the `/api/hosts/.../messages`
  proxy for its transcript and message goldens (`server/goldens/contract1/live/transcript-*.json`,
  `message-*.json`), a route protocol 3 removed, so those rows cannot pass (not run since).
  they want moving to `/api/agents/.../messages` (and new files) or
  deleting. · `bun bench/golden-live.ts check` prints every row equal.
- [board] the board daemon still asks `/api/board/stream`, which the
  server no longer serves: a board shows nothing until the daemon moves to
  `/api/stream?view=board` with board protocol 3 (package b). · the
  daemon's log shows a 200 and `hello` with protocol 3.
- [app] the web app still reads contract 1 (`app/src/sync/protocol.ts`,
  the reducer, `/api/hosts/.../messages` reads): `tsc -p app` fails until
  it moves to protocol 3 (package a1). · `bunx tsc --noEmit -p app` is
  clean.
- [sync] a page hidden inside the caught-up second after a connect says
  caught up while patches are still held. `ui/caught-up.ts` times the
  second with a plain setTimeout, which runs in a hidden page too, and the
  gate (`sync/gate.ts`) holds patches until the page is shown, so the
  flag goes true with nothing landed, either while the page is still
  hidden or on the tick it is shown, ahead of the held patches. a browser
  does this too: hidden, the timer has nothing to order against, since
  nothing lands until the show; it is invisible until then, but the flag
  is already true when the page comes back. pre-existing: the wire replay
  on 2786331 (before interest posts went one a turn) is `behind` on seeds
  31, 47, 52 and 59 for this cause; one post a turn changed how many
  random draws a run makes, which moved the schedules, and on 5b82bb1
  seed 6 fails with `{ ahead: false }` and with `{ slow: 2000 }`. the
  replay's run moved to seed 8 (`sync/wire.test.ts`). ·
  `replayWire(steps, sha, seed, opts)` ends with `behind` null on
  seeds 6, 31, 47, 52 and 59 with `{ ahead: false }`, `{ slow: 2000 }`
  and the defaults.

### left open by the leak investigation (2026-10-21)

- **webkit page memory: flat since f103f58, keep watching.** on the owner's
  macbook the page grew about 7 to 10 mb a minute while text streamed; the
  causes found were finished web animations webkit kept alive, released
  agent children held whole, per-batch churn, and above all closed stages
  kept alive through their dom (safari reader caches elements) after every
  close and reopen, return from an agent or resize. with f103f58 the page
  sat at about 300 mb footprint (WebKit Malloc about 156-160 mb dirty) from
  13 to 23 minutes of normal use, against 461 to 722 mb and climbing on
  5b82bb1. notes and the harness: branch `leak-notes`. · a longer session
  (hours) stays flat, and the slopes of f8f04d1 and 76d2094 are measured if
  the history matters.
- **the leak fixes went out before their review.** ae9859a (interest posts
  once a turn) moved two wire-replay seeds; 5f545f0 and 092ecc1 (css fades,
  reorder reuse) need a check that the motion is identical. · an
  independent review and a frame-by-frame motion compare pass.
- **a second webkit process beside the web app's page.** on the macbook, each
  launch of the home-screen app starts a second WebContent process about a
  minute after the page (281 mb footprint, 255 mb WebKit Malloc dirty at 11
  minutes; 556 mb in an earlier session). a WKWebView keeps the service
  worker in the page's process, so it may be the web app's separate
  service worker process; boxbox's worker only precaches and never touches
  `/api/`, so its size is unexplained. · the process is identified (an app
  build without a service worker on the macbook) and its memory explained
  or cut.
- **the same thread's stage is mounted again from scratch.** the owner's
  safari heap snapshots (2026-10-21) held four stages of one root thread:
  closing and reopening it, back then the strip's pour (home.tsx, the stage
  never empties), and a resize across strip and rail (home.tsx, moving
  between arrangements) each give `layers()` a new entry for the same key,
  so the stage is built again, its turns rebuilt, and hide then show makes
  the worker send the whole thread again (about 17 mb of store objects for
  a 970-message thread). a disposed stage no longer stays alive through its
  dom (`ui/thread/release.ts`), so this costs churn, not a leak. · the
  same thread keeps its stage where the screen shows it unchanged, or a
  remount within a task does not drop and re-send a thread the worker holds.

### housekeeping

- the real drive makes one scratch haiku session per run on 4097 under
  /tmp/boxbox-shell-real; two exist, idle. nothing deletes sessions; they
  can be archived from the thread.
- the chip's face (added 2026-10-01) is a chip-only `@font-face` over boxbox sans
  with ascent and descent at 1.12 em; confirm it is the same font file,
  not a second download, in the first-load budget.

## closed

- [budget] telemetry was in the first load: 798184f imported
  `sync/telemetry.ts` statically from `sync/client.ts` for its row cap,
  so the perf emitter's lazy import no longer split it (vite warned
  INEFFECTIVE_DYNAMIC_IMPORT; 116.4 to 117.6 kb). the cap moved to
  `sync/queue-cap.ts`, which both import, so it is still one number; the
  warning is gone and the first load is 116.7 kb. telemetry.test.ts walks
  the first load's static imports and fails if telemetry.ts is among them.
  closed by the leak-motion lane (2026-10-21).

- [sync] a streaming tail beat journaled the whole 2.8 kb session entry:
  closed by protocol 3, which journals a `thread.patch` with a tail op
  (`protocol.md` section 6, about 400 b per 500 ms per busy thread before
  gzip; `fleet/encode.rs`).

- [openclaw] `SIGUSR2` and the `bootId`: settled by the occonn lane
  (2026-10-15). with the dev gateway's supervisor, `kill -USR2` sends
  `shutdown {restartExpectedMs: 1500}`, closes 1012, and the gateway that
  comes back has a new `bootId` (`42a58b02...` to `05c8486e...`), which the
  server's openclaw connection logged as `restarted=true` on its next hello.

- [thread] the thread blanked when a reply ended, and stayed blank until a
  reload (reported on main of 2026-10-09 and deployed that day: the thread disappears and a
  reload brings it back; telemetry showed huge perf.shift rows before each
  reload). cause, on a thread opened
  by a tap (a url open is made whole and never showed it): `createTurns` took
  the shown list back to its newest 8 whenever the thread key notified, and
  the key comes through home's layer view, which home makes again at each
  update of the session, about five times a second while a reply streams; the
  settle read the list at 65 turns and laid it out at 8 in the same patch
  batch, asked for 100,787 px of end room (`--hold`, the scroller's padding),
  and padding is part of a flex item's box: the scroller was 100,827 px tall
  in a 917 px stage with the view in the padding, and the release could not
  fire. closed (2026-10-09, three commits, each with its test failing first):
  the key through a memo (57 collapses in a 10 s reply to 0, shifts 41,931 and
  89,390 thousandths to 0, at 1512 and 390), the end room bounded to less than
  the view (`endRoom`: with the first fix out, the list still collapsed 57
  times and the end was never blank), and a view at the end followed in the
  same task as a change above it (the blocks of 32 counted 0.37 each in
  chromium's layout-shift entries, last two of 223 turns at 1512: 0 after).
  driven on the dev stack in chromium and webkit with the hop probe and
  check 9; not on a real device.
- [thread] a thread whose one text part is 6 mb froze the page for 92 to
  110 s (marked is quadratic in its input, and an unbroken run of tens of
  kilobytes takes seconds to lay out). closed by the stage lane: a long
  text is parsed in pieces, past 80 kb shown as its head and tail, and a
  run of 2,000 characters is cut for display (docs/thread.md, a long part);
  a 6 mb part opens in 145 ms cold. · `[bench:bulk 600 10000]`, opened.

- [check] `just check`'s root `tsc` step failed on main with three errors in
  `bench/session.ts`, `bench/thread.ts` and `probes/probe.ts`, so the check
  never reached its tests. fixed by the perf-bench work on 2026-10-08. · `just check` runs to
  the end.
- [ops] `boxbox upgrade` on linux could not restart the shipped unit:
  `service::state()` took `ExecStart`'s words as text, so the config it
  loaded to check the restart was `%h/.config/boxbox/boxbox.toml`. it
  replaced the binary and refused ("the service's config does not load");
  seen on the vm upgrading to the 2026-10-03 build. `exec_words` now reads the words
  back the way install writes them. ·
  `a_units_exec_start_reads_back_as_the_paths_install_wrote`. closed by the
  upgrade fix beside the pin move of 2026-10-03.
- [daemon] cmx2 a22: a3 (the stalled-subscriber cap) failed at the pin from
  cmx2 0.8.5 (2026-10-01) on (9.3 MiB published past a stalled reader, still open after
  10 s). at the pin of 2026-10-03 the daemon closes that stream at the cap, at most
  4.0 MiB reaching it. · `just probes 4840`: 13 pass, a3 among them. closed
  with the pin move of 2026-10-03.
- [thread] the "n new messages below" pill sat inside the composer's dock
  and covered its words. the pill and the pinned ask now live in the dock
  and ride its top edge (`bottom: calc(100% + 10px)`), stacked when both
  show and lifted above a live turn's stuck tape. closed by the colour,
  inspector and folds lane (2026-10-02).
- [composer] `liveLine` skipped nothing: it could show the person's own
  prompt. it now skips `role: "user"` items for the agent's newest step
  and names another agent's report ("helper reported"). · words.test.ts,
  "skips your own prompt". closed by the subagents lane (2026-10-02).
- [thread] a subagent's thread could not be opened at all, an agent row
  showed "0 steps" while its child worked, a thread whose agents were at
  work read "parked" on home and on the stage (it is working: the agents
  are its work), a parent in `wait` read as plain "working", home's window
  said "parked on 0 background jobs", and the tail read "spawn spawn". · the agent row's door,
  the stacked layer, the agents panel, the status line and the window
  copy, driven against the dev daemon; see the commit. closed by the
  subagents lane (2026-10-02).
- [order] a thread working through its agents ranked with the parked,
  below the busy, in the server's order. `Activity::Parked { agents: 1.. }`
  now ranks with busy, newest turn first (`server/src/fleet/model.rs`,
  `reorder`; the test beside it). closed by the subagents lane (2026-10-02).
- [agents] escape on the deck from an agent's stage went home, not back to
  its parent: home's escape branch goes through `layerBack` now. driven:
  parent, door, escape, one layer left on the parent. closed by the
  subagents lane (2026-10-02).
- [agents] an archived agent's door stayed and did nothing. the child's
  state is `gone` once the fleet knows the parent and not the child: the
  row reads "archived" / "its thread was archived" with no door, the
  panel's row says "archived" and is not a control. driven: the child
  archived through cmx2's `PATCH /session/:id` while the parent was on
  stage; the door left, the panel read "helper, archived". closed by the
  subagents lane (2026-10-02).

- [sync] a thread held a message's parts in arrival order: at 0.8.3 the
  reasoning part lands after the text streamed, so the thought painted
  below the answer, and the cache kept it across reloads. parts are now
  placed by the daemon's ids, a cache is put in order as it loads, a delta
  at offset 0 creates its part with no refetch, a refetched message merges
  with what is held instead of replacing it, and the worker no longer
  drops a refetch the reducer asks for (it backs off repeats). · the real
  loop on a `[bench:think]` turn at 390x844: every message's part order
  equals the daemon's, refetches 0, a cache seeded crooked paints in
  order.
- [sync] the app took contract 4 only: reasoning showed nothing for the
  length of a step, and the transcript could not tell a part's type from
  its first delta. the pin is at cmx2 0.8.5 of 2026-10-01 (contract 5): the reducer takes
  parts from their announcements and streams reasoning like text, the
  session tail does not journal thinking, `probes/a23.ts` asserts the
  contract. · a `[bench:think 50 120]` turn through the composer at
  390x844, a thread opened mid-thinking, a reload mid-thinking and a cold
  open mid-thinking each end with every message's part order and types
  equal to the daemon's and refetches 0.
- [thread] a running turn's reply never streamed, the settle moved the
  prompt, and heights changed under a running turn. the trailing say is
  the window's newest row from its announcement, words arriving with the
  blur settle; live is the session's working state, so the shape does not
  flip between steps; the settle keeps the prompt with end padding while
  the ledger is shorter, and the settled turn is the ledger plus the
  answer, fading up once; a user message waits until it has a part; the
  dock and the title block do not resize (the stop button included): the
  bar kept the line's slot while a thread worked, two prose lines tall,
  and after the merge of main the composer's top row is one fixed height
  always (2026-10-02), which does the same whether or not the composer is
  focused. ·
  the real loop at 390x844, 820x1180 and 1512x945, each with three turns of
  history and with none, on `[bench:work]`, `[bench:think]` and
  `[bench:words]`: the reply's length grew in 40 to 200 steps, the prompt's
  y was constant within each run (to 0.1 px) from the turn's first frame to
  1.5 s after the settle, the dock's height and the title block's did not
  change.

- [thread] opening a thread mid-stream animated: every row already in the
  live window rose (475 ms) on an open, a reload and a cold open, an ask
  already risen beneath it rose too, the ruler faded in and out by itself
  (the touch clock started at 0, so the stage's own landing at the end
  read as a touch in the page's first 900 ms), and the bar's backdrop and
  title faded in. the window's first paint and a risen card present at the
  turn's first paint are calm; the ruler shows only on the reader's
  scroll; the bar takes its state without a transition until the opened
  thread has landed. also fixed in passing: the bar's condensed state took
  the oldest report of its observer, so a first look and the scroll after
  it in one frame left it off on a cold first open. · the real loop on
  contract 5 at 390x844: opened mid-thinking, reloaded, opened
  mid-reply and opened cold, every animation start in the first 1.2 s was
  a fresh word (before: rises on every row, 2 ruler transitions); a thread
  with 3 turns of history, opened and reloaded at 390 and 1512, 0 starts
  in 2 s and the ruler shown only after a wheel and scroll; a work turn
  opened mid-turn: no rise at the first paint, 5 rises as later rows came.
- [composer] the "sending" card flashed at every send: between the post
  returning and the stream's first frame of the turn the card showed for
  about 75 ms and moved the dock by 99 px (185.7 to 284.7 and back at
  1512x945 in 5 of 6 runs, 175.7 to 295.4 once at 390). the card now shows
  only when the echo is still missing 600 ms after the tap, and a send
  with no card appears as the turn's first frame. · dockflash over 10
  sends at 1512x945 and 3 at 390x844 (bench:words), from the click to the
  settle: the dock held one height (185.7, and 175.7 at 390) in every run.

- [thread] regression from the 2026-10-02 rise fix: the first row of a turn the reader's
  own send made no longer rose, because the window's first run rose
  nothing and the first thought can arrive in the window's first frame
  (`[bench:think]` at 390, +95 ms). the stillness is now the stage's
  landing state (`LandingContext`, true until three frames after the
  thread's first paint), given to the window and to a risen ask: what is
  painted while a thread lands is calm, anything after is a live event and
  rises. docs/thread.md says so. · the real loop, a fresh send: at 390 and
  1512 the first thought rises at +173 and +118 ms on `[bench:think]`, and
  the first rows on `[bench:work]` at +1132 and +1106 ms; open, reload and
  cold open mid-thinking and mid-reply: 0 animation starts on rows present
  at the first paint (only fresh words, 9 to 10 in 1.2 s).
- [composer] the line repeated the reply already on screen and rolled in on
  every word on a cold open of a thread mid-reply when another thread had
  been open earlier in the session: the on-screen flag read the first
  report of its IntersectionObserver, which was a stale one when the
  observation and the landing scroll came in the same frame (the same
  mistake the stage's bar had, fixed on 2026-10-02). it reads
  the newest. · `vline.ts` at 390, reload and cold after another thread was
  open: the line empty in all 6 samples of each, 0 rolls (before: the line
  showing and 10 rolls in 2 s, from the reviewer's run); scrolled up
  mid-turn the line shows the newest step ("the notes now greet in the"),
  and back at the end it is empty.
- [thread] the ruler's current tick transitioned `width` and the ticks'
  `background`, against design.md (only transform, opacity, clip-path and
  filter animate). the current tick is now the same tick scaled 4/3 from
  its right end, and colours change at once. · `vruler.ts`, scrolling across
  4 turns at 390: the transitions that start are `transform` (on the
  ticks) and the ruler's own `opacity` and `transform`, none on width or
  colour.

- [composer] the line rolled in on every update while the transcript's end
  was out of view (40 rolls at 390 and 43 at 1512 over one reply, about
  one every 200 ms), and began mid-word ("othing else changed", the
  server's raw 280-character tail). it rolls only when a new row begins
  and its text is cut as the window's cards cut theirs; the prose is
  anchored to its end so the newest words show. a part announced and
  still empty, and your own prompt, are not the line (this closes the
  earlier item that the line could show the person's prompt). · `vline2`
  at 390 and 1512, a 160-word reply scrolled up: shown 6/6, 0 rolls over
  the reply (one row); a `[bench:work]` turn scrolled up, rolls against
  rows that began after the line first showed: 5 rolls for 5 rows at 390,
  6 for 6 at 1512; every sampled line began at a sentence or word start. unit tests
  in words.test.ts.
- [daemon] a thought stayed open, its clock running, for the whole reply
  after it: cmx2 published a part's final only at the end of the step. the
  pin is at cmx2 of 2026-10-02 (a26 landed that day; it was filed as a24 and
  renamed when main took a24 and a25): a part's final comes
  when its block ends, and the step's end publishes it again, identical.
  `probes/a26.ts` asserts it (and fails on the 2026-10-01 build, where the final
  came at 93 events against the text's announcement at 67); the reducer,
  the thread model and the session tail each have a test for an early
  final. · a `[bench:think 50 120]` turn through the composer at 390x844:
  the thought's final reaches the worker 1 ms before the reply's first
  word and no sample after it holds the thought streaming; the mid-reply
  screenshot shows both thoughts settled with "6 s" and the reply
  streaming with its caret; order equal to the daemon's, refetches 0.

- [composer] the line showed the last turn's answer for a moment at the
  start of a turn, and kept showing the turn before it between a prompt
  and the agent's first words: the session's busy status can land 1 to 3
  ms before the update that puts the new prompt in the tail, and in that
  gap the newest row with words was still the last turn's. the line reads
  only the running turn (it stops at the newest prompt of the person's own,
  so a turn that has said nothing shows no line; another agent's report
  starts a turn and is named), and from the moment a session known to be
  idle goes busy it shows nothing until the tail has moved; a thread
  opened mid-turn shows its line at once. · the real loop, the page's
  displayed rows from each send to the turn's first words, one-line replies
  and a work turn scrolled up at 1512x945: without the hold 4 of 14 turn
  starts began on the previous turn's row (3 of 7, 1 of 7); with it 0 of 21
  (7 at 1512, 7 at 1512, 7 at 390), the line empty until the first row with
  words (+235 to +248 ms for a reply, +1061 to +1073 ms for the first lead
  of a work turn), rolls equal to the rows that began after the first (4 to
  6 on a work turn, 0 on a reply). the reviewer's run of the first part
  (2026-10-02): 390 work turn empty until the first lead at +1052 ms then 7
  rows and 6 rolls; 390 one-line reply empty until +241 ms and 0 rolls; 1512
  work 6 rows and 5 rolls; vline2 at 390 scrolled up shown 6 of 6 with 0
  rolls; 424 sampled lines all begin at a word.
- [thread] live reasoning was verified end to end only in stories: 0.8.3
  sent no reasoning deltas. at contract 5 the real loop shows it: a
  `[bench:think 50 120]` turn through the composer at 390x844 with three
  turns of history, the thought painted live in 50 distinct states from
  +137 ms, and the frame that paints the reply's first characters is the
  first with no live thought box (the thought's final comes when its block
  ends, a26); prompt y 107.8 and dock 124.7 constant from the turn's first
  frame through the settle, 0 page errors.
- [composer] an idle composer that was not focused gained the line's slot
  once when a turn started and lost it once when it ended (a focused one
  held its height). main's top row is one height always (52 px, nothing
  appears on focus), so the line moves nothing. · the page's dock heights
  over 21 turn starts sent from the api, so the composer was not focused:
  one value in every turn, 134.7 at 1512x945 and 124.7 at 390x844.
- [daemon] the part-end ask filed here as a24 is a26: main took a24 (an
  agent tool part's title) and a25 (the session list's cursor) for other
  asks first, so the row, the section, `probes/a26.ts` and every doc and
  test that named it were renumbered, and the pin moved to cmx2's commit of 2026-10-02
  (the one before it plus the rename, docs and test names only; the vendored
  contract is byte for byte the same). · `just probes 4880`: a23 and a26
  pass, a3 is the known fail (a22).
- [agents] a thread whose pack was started from a `run` script (four
  `agents.spawn` in one script, no spawn part in the transcript) showed
  "agents: none" over four working agents, because the children came from
  spawn steps alone. they come from the fleet's `parentID` now, named by
  the spawn row or the daemon's title; the `run` row says "started N
  agents". driven on the dev daemon with `[bench:pack 2000 400]`: the
  panel listed both, each a door, back landed on the parent. the ledger
  still has no agent rows or tape lanes for a script-started agent (cmx2
  ask a27). closed by the subagents lane (2026-10-02).
- [review] the review card was driven only in stories. now driven end to
  end on the pinned dev daemon: a session homed in a cmx2 checkout of a
  throwaway repo, prompted through boxbox with `[bench:review FILE]` (the
  bench model commits FILE, starts a helper, calls the real
  `request_review`); the card rendered at the live edge at 1280 (rail) and
  390 (deck, opened from home), home's window said "ready to merge: adds
  FILE"; merge went ready, merging, folded "merged into main" with no frame
  without a card (a mutation log) and the squash commit landed on the
  repo's main; a merge mid-turn said busy on the card; discard asked once
  and folded "discarded. the work is kept at refs/cmx2/rescue/<name>". the
  drive found the helper's report waking the agent served the review in 5
  s through `armed`, which outlives a park; fixed with `sent`, taken when
  the turn starts. the tick was screenshotted, not watched frame by frame.
  closed by the review of the worktree review (2026-10-02).
- [needs] a device's own turn was never known as the device's when it
  started: cmx2 publishes busy before the prompt's message, so a done or
  fault it served was served `by agent`, and a reply never served a
  review. a send still armed for the session (within 10 s) now names the
  device when the turn starts, and boxbox's prompt, steer and command
  routes serve the open review once the daemon took the send, by that
  device. tests: `a_turn_whose_status_comes_before_its_message_is_still_the_devices_that_sent_it`,
  `a_done_a_device_sent_the_next_turn_for_is_served_by_that_device_when_busy_comes_first`,
  `a_send_that_never_landed_does_not_make_a_turn_minutes_later_the_devices`,
  `a_reply_through_boxbox_serves_the_review_by_the_device_that_sent_it`.
  driven on the dev daemon with [bench:review FILE] through boxbox's
  prompt route: a second prompt from the phone served the open review
  by that device, how continued. the status-before-message attribution is
  unit tested only. closed by the server findings lane (2026-10-02).
- [review] a second `request_review` from a checkout whose need was open
  kept the first card's note, and a served need's id never came back (an
  agent sent back with notes got no card). each request is its own need
  now (`review:<key>:<checkout>:<seq>`, the event's seq or the time), a
  newer one serves the older open one for the checkout, and a replayed
  event raises nothing. tests: `each_request_for_review_is_its_own_need_and_a_newer_one_answers_the_older`,
  `a_request_replayed_after_it_was_served_raises_nothing_and_serves_nothing`,
  `an_agent_sent_back_with_notes_that_asks_again_gets_a_card_after_its_review_was_served`.
  closed by the server findings lane (2026-10-02).
- [review] a review need outlived a checkout merged or discarded where
  boxbox did not see it, with no way out. a read, merge or discard that
  finds the checkout gone (the worktree's own 404, or 400 `primary`)
  serves the session's review as settled, so the badge and card go. test:
  `a_checkout_the_daemon_says_is_gone_serves_its_review_as_settled`.
  closed by the server findings lane (2026-10-02).
- [review] `worktree.merged` and `discarded` served reviews by host and
  checkout name, so two repos with a checkout of the same name cleared
  each other's. the frame's directory is matched against the session's
  (equal, or the session inside it); a frame with no directory settles
  nothing. driven: a merge through the route settled the second request's
  need (the daemon's frame carries the checkout's directory). test: `a_merge_settles_the_review_of_the_repo_it_was_in_and_not_another_with_a_checkout_of_the_same_name`.
  closed by the server findings lane (2026-10-02).
- [review] a daemon 404 `NotFoundError` was read as "checkout gone".
  only the worktree's own `WorktreeNotFoundError` is now (and 400
  `primary`); a bare `NotFoundError` is `host-said`. test:
  `a_bare_not_found_is_the_daemons_words_not_a_checkout_that_is_gone`.
  closed by the server findings lane (2026-10-02).
- [review] the first-load script was 121.0 kb against the 120 kb budget,
  so `bun scripts/compress.ts` exited 1. the review is a chunk of its own
  (review/layer.tsx, a lazy import in the stage): 119.0 kb, compress
  passes, and the chunk (`layer-*.js`) loads on a cold load of a thread
  with a review open (driven at 390).
- [review] a failed read offers "try again", and the window's chip and
  name say "ready to merge" while a review waits (driven: the window
  named "repo5: review drive add-again. ready to merge"; the retry is
  unit tested, not driven).
- [review] a checkout gone behind boxbox's back folded the card to "this
  checkout is gone" for one frame (16 ms in a mutation log): the server
  serves the need in the same answer, and the line left with it, so the
  window that said "ready to merge" opened on nothing that said why. the
  gone line now outlives its need like the merged one. driven: boxbox
  stopped, the checkout merged on the dev daemon, boxbox started, the
  thread opened at 390: reading, then "this checkout is gone", held.
  closed by the second review of the worktree review (2026-10-02).
- [budget] the providers' marks left the script for an inline sprite in
  `index.html`: the same bytes moved (about 10 kb brotli in the script, 9.4
  in the document), and whether the document needed a budget of its own was
  open. it does: `scripts/compress.ts` prints `index.html`'s brotli size
  beside the script total and fails over 12 kb (9.8 now), so the document is
  not where what the script budget turned away goes; the script is 115.6 of
  120 with the review card and the repo mark in it. closed by the
  code-blocks lane (2026-10-02).
- [thread] the view swung half a screen up every two seconds while a turn ran with
  agents under it, and once stayed off the end (iphone, installed app,
  2026-10-03). cause: webkit's scroll range under a size container
  (`gotchas.md`), and a pin kept from the last scroll event. closed by the
  scroll lane (2026-10-03): `measure.ts`, `pin.ts`, no container above the
  transcript; reproduced and measured in the ios simulator's safari on
  `stage--live-steered` (258 px above the end before, 0 after). not driven on a
  real iphone.
- [home] the rail shifted 31 px when an asking window let go: it grew by
  layout in the column. closed (2026-10-05): an asking window never grows
  (design.md, an ask never grows its window), so nothing moves. not
  re-measured with the shell drive against a real daemon.
- [inbox] answering from a window's own ask card recorded no perf.send.
  closed (2026-10-05): the window has no card; the thread's cards answer
  through `thread/asks.ts`, which stamps `perf.send` from the stream.
  not driven against a real daemon.
- [home] the strip grew a window over the stage and moved the stage down
  by transform, 1000 px for a real question, with the thread squeezed into
  the foot and an empty band beside the window (reported 2026-10-05,
  with a screenshot); on a phone the card did not fit the screen. closed
  (2026-10-05): the window keeps its resting size at every width and shows
  its need in a tray that opens the answer sheet (since the needs-you
  tray, docs/home.md); the card is the thread's, checked at 320,
  390, 820 and 1512 wide against a long ask and a two-question ask in
  the stories. not driven against a real daemon.

- [thread] closed 2026-10-16 by the step groups: an agent started after a turn's first frame grew the tape by its lane and moved the prompt 45 px; the tape is gone (thread.md, the step group), and a group is one line and a fixed strip. with it the story race where `stage--live-heavy-turn` came up with the tape not stuck.


(the last of 1066 lines shown; full output at /Users/rohan/.local/share/cmx2/tool-output/shell-mvi6dxcs-f8lc.txt, read it with offset and limit)