# gotchas

v2's own scar tissue: anything that bit during the build, written the
moment it bites, with the rule that prevents it. v1's scars are classified
in `scars.md`.

## the thread and its stories

- **ladle is react-only, and the app is solid.** its own vite (6, beside
  the app's 8) compiles the stories; two jsx transforms in one graph
  clobber each other unless each plugin takes only its files. rule:
  `app/.ladle/vite.config.ts` gives the solid plugin `src/ui/thread/**`
  minus `*.stories.tsx`, and the react plugin the stories and `.ladle/`;
  story files use `createElement`, never jsx, and mount solid with
  `render(() => createComponent(...))`. ladle's typings are `.tsx`
  sources checked as solid jsx if imported, so nothing imports types from
  `@ladle/react`; `Story` and `Provider` are typed locally.
- **a fixture is fetched, never imported.** a 2.8 mb json module makes
  the type checker build a literal type of it (minutes, then memory).
  rule: `import url from "./x.json?url"` and `fetch(url)`; type the
  parsed value by hand.
- **`.thread button` beat every control's own padding.** the app's
  `button` reset (44 px, padding, radius) had to be undone inside the
  thread, and a class-plus-element reset outranks a single class, so
  `.row-h` and `.ask-opt` lost their padding silently. rule: resets inside
  a scope use `:where(.scope) button`, which carries no weight.
- **`pre-wrap` hangs trailing spaces past the box.** a wrapped command in
  a bed put its last space over the padding and the craft check flagged
  4.8 px of inset. rule: wrapped mono text uses `white-space: break-spaces`.
- **`exactOptionalPropertyTypes` and spreads.** `{ x: maybe() }` where
  `maybe()` can return `undefined` is not assignable to `{ x?: T }`. rule:
  `...(v !== undefined ? { x: v } : {})`, and component props that a
  parent forwards unchanged are declared `x?: T | undefined`.
- **agent-browser's chrome is not the user's browser.** `open <url>` in
  agent-browser paints in its own chrome; the user's board is opened with
  `open "http://…"` from the shell. a page loaded before `set viewport`
  keeps the width it was born with (the `wide` class is computed once), so
  set the viewport, then open.
- **solid's `For` keys by object identity.** the running turn is rebuilt
  as a new object on every delta, so `<For each={turns()}>` tore the
  turn's dom down and up on every word: the live window's rise animation
  restarted forever (rows at 18% opacity), a row's open state and a deep
  link's landing were lost. rule: the ledger, the live window and the
  stage key turns and rows by place (`Index`) and read the model through
  the accessor. `Index` alone still handed every place a new model on
  every word (each row's content was rebuilt, so its inline nodes were
  replaced): closed by keeping identity below the turn, the part memo in
  `turnsOf` and the row and entry memos in `ledger.ts`, so a delta hands
  one place a new entry (`ledger.test.ts`).
- **a boolean aria attribute is dropped when false.** solid renders
  `aria-expanded={false}` as no attribute, which a screen reader reads as
  "not expandable", and a driver testing `=== "false"` never matches. rule:
  aria booleans are written as the strings `"true"` and `"false"`.
- **a hot-replaced component's effects belong to the dead instance.** in
  dev, editing `stage.tsx` re-created the stage; a reply's settle effect
  that had been created by the old instance never fired and the perf row
  never landed, which looked like a bug in the store. rule: after an edit
  to a component that owns effects, reload the page before believing what
  it does.

- **a headless tab can stop producing frames.** after some tens of
  stories in one tab, `requestAnimationFrame` stopped firing while evals
  still answered, `document.visibilityState` stayed visible and no
  animation ran; navigating to another story did not bring frames back,
  and `agent-browser screenshot` then waited until its own timeout, so a
  200-story run stalled around story 45 five times in a row. rule: the
  screenshot test starts a fresh browser every 25 stories, asks the page
  for one frame before each screenshot and, when none comes inside 1.5 s,
  closes the browser and starts a fresh one for that story
  (`app/.ladle/shots.ts`); with that, 222 shots ran clean. a whole browser
  can start that way too (a session relaunched while its old chrome was
  still dying ran at 0 fps from `about:blank` on), so the thread drive
  closes its session first and opens again in a fresh browser when a page
  gives no frame. the probe, from `eval`: count `requestAnimationFrame`
  callbacks in a second; 60 is a live tab, 0 is a dead one while evals
  still answer. two runs on one agent-browser session stall each other:
  stop a run by its pids (`kill <pid>`, never `pkill -f` with a pattern
  another worktree's run also matches).
- **chrome 151's headless stops producing frames about a minute after it
  starts, unless field trials are off.** launched with `--headless=new`
  and a plain profile, `requestAnimationFrame` stopped and
  `Input.dispatchMouseEvent` for a wheel never answered 60 to 75 s after
  launch, every time, even on a `data:` url, with evals still answering
  and the page visible; focus emulation, a screencast, the backgrounding
  flags and a user-active power assertion did not help.
  `--disable-field-trial-config` (which playwright passes) did. agent-browser
  0.32's own chrome is launched without it (`--headless=new`, checked with
  `ps`), and its tab went to 0 frames twice in one hand session; attaching
  agent-browser to a chrome started with the flag (`agent-browser connect
  <port>`) kept it drawing. rule: a harness that starts chrome itself passes
  it (`bench/window.ts`, `chrome()`), and a hand session that must last
  minutes attaches agent-browser to such a chrome.
- **a second scroll pass on the same page proves nothing about fill-ins.**
  the long thread mounts each turn once and never lets it go, so after one
  pass up through it every turn is filled, and a wheel or fling pass run
  next on the same page met no fill-in at all (`0 with layout above the
  eye`) while its verdict read pass. rule: every pass of `bench/window.ts`
  starts from the thread opened afresh at its end.
- **rows in view do not prove the stage held its turns.** on main of 2026-10-09,
  after a hop to another thread and back, each flush of a streaming reply
  drew one frame with only the last 8 turns of 69 (the open's first set,
  boxes of 7575 px) and the next frame drew all 69 again. the view was at
  the end, the scroll clamped to the shorter content, and the live row
  never left the screen, so a watcher asking "a turn with rows in view, no
  empty box" passed every frame while chrome logged two layout shifts per
  flush. rule: check 9 counts the stage's turns in each painted frame (read
  after paint, a message posted from a frame callback) and fails a frame
  that draws fewer on the same thread, or loses more than 200 px of
  content, away from the reader's input.
- **a probe run from outside the repo gets another playwright-core.** a
  script in /tmp importing `playwright-core` was given 1.64.0 from bun's
  global cache, which looks for a webkit build that is not installed; the
  repo pins 1.63.0, whose webkit is. rule: run probes from the worktree, or
  link its `node_modules` beside them.
- **headless chrome advances animations only when something asks for a
  frame.** a row's 475 ms rise sat at 65 ms four seconds after the page
  opened and moved only when an eval or a screenshot came, so the drive's
  wait for the stage to settle never ended and a screenshot mid-rise read
  as text crowding a row's edge; a running `requestAnimationFrame` loop
  on the page gives 60 fps and everything finishes in real time. rule: the
  drive installs a frame pump with its error listener on every page
  (`bench/thread.ts`); the stories' screenshots are of still states and
  need none.
- **a click agent-browser refuses can stop the page's clock.** after a
  `find role button click` answered "covered by <button.ask-opt.first>",
  the page ran at 0 fps: every animation sat at `currentTime 0`, evals
  still answered, navigating did not help, a fresh browser did. rule: the
  drive clicks only once the stage's own animations are done
  (`getAnimations({subtree: true})` on `.thread-stage`), and after a
  failed click asks for a frame and starts the browser again (signed in,
  back on the page) when none comes.
- **the thread lives inside home, so home's selectors reach it.** `.home
  .bar` put the stage's bar in flow (60 px taken from the log), `.home
  .mark` and `.home .live` would restyle the turn marker and the tape's
  live mark. rule: the thread's class names stay clear of home's (`bar`
  is `stage-bar`, `mark` is `turn-mark`, the tape's `live` is `running`;
  `back` is shared on purpose); before adding a class, grep the other
  screens' stylesheets for it.
- **a css variable is not an easing for `element.animate`.** one flip in the
  live window passed `easing: "var(--snap)"`; the web animations api throws
  `TypeError: not a valid value for easing`, and because the call sat inside
  a solid effect, the throw emptied that update's effect queue: the settle
  effect behind it never ran, `perf.send` rows went missing (1 of 52 in the
  drive), and the slide itself never played. nothing in the stories caught
  it because the craft check reads layout, not motion, and the error is
  uncaught. rule: easings come from `motion.ts` (`SNAP.ease`, a sampled
  `linear()` curve), never from a css token; the drive reads the page's
  console for `[error]` lines and fails on any.
- **solid's `on` runs on every notification, not on every change.**
  `createEffect(on(() => props.m.key, () => setOpen(props.m.open)))`
  re-ran each time the row was handed a new model (every second, once an
  agent row's clock ticked after the turn ended) and closed the row a
  person had just opened; the key had not changed, but `on` only chooses
  what is tracked and never compares what it read. the same shape in the
  window cleared the earned chip on every tail line, not on a state
  change. rule: anything passed to `on` that can re-notify with the same
  value goes through `createMemo` first (its `equals` is the comparison);
  the live window's `keys` memo was already the pattern.
- **the installed app serves yesterday's build.** the service worker
  caches the shell and applies a new build "the next time boxbox opens",
  so a `vite build` followed by a reload shows the old code and a story
  about a change that "did nothing". rule: a dev loop against the
  embedded app unregisters the worker and clears its caches before the
  reload (`navigator.serviceWorker.getRegistrations()` and
  `caches.keys()`), or tells the waiting worker `boxbox.take-over`; and
  the first check after a rebuild is a marker only the new code paints.
- **`just dev` cannot share a machine with another lane's vite.** its
  vite port is 3002 for every worktree; with a sibling lane holding it,
  the loop here was `vite build`, the debug binary with
  `.cmx2/bench/boxbox.toml` (rust-embed reads `app/dist` from disk in a
  debug build), and the reload above. `just cmx2` stops the whole bench
  when the bench model dies: restart the model by restarting the bench.
- **a row's body is handed over again every second while its turn runs, and
  a card built from it was built again with it** (2026-10-05). `BodyView`
  read the whole body, so a pending ask's card was a new element each
  second: the words typed into it, the options picked and the focus a tap
  had given it were gone within a second, unseen in a still story. the ask
  and permission cards are now built once, while their row asks, and read
  their body as it changes (the questions through a memo that compares
  words, so a new body with the same questions keeps its blocks). a card
  that holds state belongs on this rule; the story that proves it is
  `shell--thread-long-ask`: type, wait two seconds, the text is still there.
- **`scrollIntoView` moves the page too.** a row the stage's scroller cannot
  bring to its top (the thread's end is near, as an ask's row is) leaves the
  rest of the move to every scrollable ancestor, `overflow: hidden` ones
  included: the deck's whole screen slid up 34 px with the bar half cut.
  `light(row, scroller)` scrolls the one scroller; the stage's own links to
  an ask and a push's tap use it.
- **a focused card inside a lit row draws two boxes.** the stage went to an ask
  by lighting its row (`light`) and focusing its card: the lit head and the
  ringed card were two boxes, offset, round one object, and the page's own
  `:focus-visible` ring (styles.css, which a script's `focus()` matches on a
  fresh page) drew a third on the card. an ask is now brought (`bring`: the
  scroll, not the light) and the ring is the row's, by `:has(.ask-card:focus)`;
  the card turns the page's ring off.
- **the stage's move to an ask landed under the bar, twice over** (2026-10-05).
  the scroller starts at the stage's top and the bar floats over it, so a row
  scrolled "to the top" is under the bar; the move is to the bar's laid-out
  height plus 36 px (`CLEAR_OF_BAR`, where the bar's fade is whole). a stage
  that opens pinned also follows the thread as it lays out and took the view
  back to the end under the smooth scroll, so the move lets go of the pin
  (`pin.leave()`) unless it ends at the end. and a rect read while the layer
  arrives (drawn at .975, each part moving on its own) is not in the px the
  scroller counts in: the move reads offsets (`layoutTop`), which a transform
  does not touch.
- **`setState("focus", focus)` on an object merges it into the one before.**
  the store's reference never changed, so an effect on `state.focus` missed
  every change after the first (a probe saw A, null, C for A, B, null, C).
  `openFocus` sets `{ focus }` at the top, which replaces (`store-focus.test.ts`).
  the focus is let go by the stage, not by a clock in the store: a timer from
  the moment of the tap lost a push's focus on a cold launch, whose gate,
  sign-in and thread take longer than 4 s before any stage is there (the
  `thread-ask-slow` story fails with the timer back). a stage waits
  `FOCUS_FOR_MS` for an ask it does not show yet (`focus-lapse.ts`), from the
  moment the fetch behind its thread has landed, not from the cache's paint:
  on a cold launch the cache has rows, from before the ask, while the fetch is
  still out (`!data.hydrating()`; the `thread-ask-cached` story fails without
  it). an ask is let go as answered elsewhere only when the fleet does not
  hold it *and the stream has caught up*: the stream is "live" at the hello,
  before the frames that bring the fleet's asks, so "live" alone released the
  focus of a push tapped as the stream reconnected (`ui/caught-up.ts`, the
  second home has always waited for the replay, shared with it; the
  `thread-ask-reset` story fails without it). a push that named a thread
  alone is let go at once; a thread home drops lets its focus go too. a focus
  is set only once a transition has decided to go (a tap refused while one
  runs leaves none).
- **a row that nearly fills the room is dragged up under the bar by the end's
  pin.** pin.ts takes a view within `BOTTOM_SLACK` (48 px) of the end as at the
  end and follows it there, so an ask whose landing is 1 to 47 px short of the
  end ended up to 47 px higher than the bar's fade clears (9 px under the bar's
  foot, measured, with the pin released: the scroll events re-read where the
  view is). the end gains the difference as `--ask-pad`, below the view, while
  the ask is pending (`askLanding`, `pad`).
- **a layer is covered by the layers after it, not by any layer that names
  its thread.** a parent poured again from under its agent's thread is the
  same thread twice, and the agent's leaving layer keeps its `over` for the
  length of the pour: by key the new layer was covered too, took no input,
  and the ask's card never took focus (`home/layers.ts`, `coveredBy`; the
  `thread-ask-under-agent` story fails without it, at the strip and on the
  deck). a stage that is covered, or under the new-thread sheet, looks again
  when what covers it lets go (a mutation observer on `inert`): with the
  covering by key restored and that retry alone, the same story passes.
- **the capsule never worked on main.** its tap read `shown()` after
  `setCapsule(null)`, and solid throws on an accessor read once its `Show`
  has gone (the tap threw and swapped nothing); and `on(..., { defer: true })`
  hands its handler nothing as the value before the first change, so the
  first ask to arrive after home mounted had no capsule, cue or glide. found
  by the story that opens a parent's ask from under its agent's thread on the
  deck (2026-10-05). the tap reads its key first and swaps before the capsule
  goes; the effect keeps the asks it has seen. the same `before` read after
  `defer` is in the arrangement effect (`docs/open.md`).
## codegen

- **typify ignores an openapi `discriminator`.** cmx2's `Event` is a
  `oneOf` of `$ref`s with a `discriminator` mapping; typify 0.8 emits an
  `#[serde(untagged)]` enum that tries every variant in order and, with
  `const` left as a plain `String`, the first shape that fits wins. rule:
  `build/cmx2.rs` rewrites `const` to a one-value `enum` (so each variant's
  `type` is its own type) and generates the union and its one-step
  dispatch from the mapping itself. never decode `Event` through typify's
  untagged enum.
- **typify names a nullable inline union after itself.** an inline
  `anyOf: [{object}, {type: null}]` registered as `ShellResponse` becomes
  `struct ShellResponse(Option<ShellResponse>)` beside `struct
  ShellResponse`, and the build fails. rule: only plain inline objects get
  named route types; hoist a union to a component before naming it.
- **typebox's `Record` needs a regex engine in typify's output.** it is
  written as `patternProperties: {"^.*$": T}`, which typify validates with
  `regress`. rule: the loader rewrites that exact pattern to
  `additionalProperties: T`, which means the same.
- **typebox string unions come out as `Subtype0`/`Subtype1` structs.** an
  `anyOf` of string consts is read as "any of these schemas" rather than
  an enum. rule: the loader turns an `anyOf` whose arms are all string
  consts into one `enum`.

## the sse decoder

- **a discarded line looks blank.** once a frame passes the cap the line
  buffer is dropped, so testing "is this line blank" on the buffer fires
  at the end of the oversized line, and the frame's later `data:` lines
  read as a new frame. rule: blankness is judged on the line's raw length
  as it arrived (`raw_len`), never on what was kept. the unit test
  `the_rest_of_an_oversized_frame_is_not_read_as_a_new_one` holds it.

## typescript

- **an assertion method needs an explicitly typed receiver.** a probe's
  `check(...): asserts ok` called through `run(ctx)`, where `ctx` is typed
  only by the `Probe` interface, fails with ts2775 ("assertions require
  every name in the call target to be declared with an explicit type
  annotation"). rule: every probe writes `async run(ctx: Context)`.

## the terminal

- **bun's sockets keep reading while paused.** `socket.pause()` on a
  `node:net` socket under bun stops the `data` events but bun goes on
  draining the kernel buffer into user space, so a "stalled" reader never
  pushes back and the relay never overflows. rule: a stalled reader is a
  real one, `bench/stall.py`, with a 4 kb receive buffer and no reads.
- **agent-browser's device presets do not turn touch on.** `set device
  "iPhone 14"` changes the user agent and the viewport; `maxTouchPoints`
  stays 0 and `(pointer: coarse)` false. rule: `bench/touch.ts` holds
  `Emulation.setTouchEmulationEnabled` on a cdp session of its own (an
  override lasts only while its session is open) and taps with
  `Input.dispatchTouchEvent`; agent-browser's `click` hangs under touch
  emulation.
- **a solid `Show` callback that returns a string is computed once.**
  a child like `(now) => " · " + now().cols` inside `<Show when={size()}>`
  never updates; the callback runs untracked. rule: return jsx, so the reads sit
  in expressions solid tracks.
- **the machines list reread replaced every host object**, so `<For>`
  remounted each machine window every 5 s and closed whatever it held open
  (the shell picker). rule: lists that are reread are reconciled by key
  (`reconcile(data, { key: "name" })`).
- **xterm's rows end in padding.** `innerText` of `.xterm-rows` gives each
  row with trailing spaces, and a line without a final newline runs into
  the next output. rule: match rows with `\s*$`, and end a marker with its
  own line.
- **a shell echoes the command that prints the marker.** waiting for
  `ticks-done` matched the typed command line at once. rule: markers are
  computed by the shell (`echo ticks-$((1000+1))`), so the echo never
  contains them.
- **cmx2 keeps an exited terminal until it forgets it.** a dial right after
  `exit` replays and then closes 1000 again; only later dials get 404
  (4404 from the relay). rule: the pane treats both as ended.

## zsh

- **`$C:l` is a zsh modifier.** `git show $C:lib/x.ts` lowercases `$C`
  and eats the colon. rule: brace the variable, `"${C}:lib/x.ts"`.

## reqwest

- **its error message hides the cause.** `reqwest::Error`'s display is
  "error sending request for url (...)"; "connection refused" is three
  `source()`s down. the first reconnect log read like a riddle. rule:
  upstream errors go through `plain()` in `upstream/watcher.rs`, which
  names the kind (cannot connect, timed out, dropped mid-answer) and the
  innermost cause.

## repo icons

- **`find/file` lists what ripgrep lists, so a build's output is never in
  it.** `.gitignore` holds, which is why `.next/server/app/icon.body` is
  read by path and not found; and `node_modules` is listed unless the repo
  ignores it, so the ranking drops vendored paths itself
  (`server/src/icons/rank.rs`). rule: discovery proposes, the read decides;
  never infer a prerender's absence from the listing.
- **an empty `find/file` is not "no files".** at the pin a directory that
  does not exist answers `[]` with a 200, and a cold index did in v1. rule:
  empty from both queries is a transient (`no-store`, retried), never the
  30-minute verdict "this repo has no icon".
- **a daemon spells a project's root its own way.** `/project` and a
  session's `projectID` carry the real path (`/private/tmp/x` for a
  `/tmp/x` the shell typed), so a root the app builds by hand is
  unproven. rule: ask with the `projectID` the fleet holds; the gate
  compares the daemon's spelling, trailing slash aside.
- **a path with a non-ascii byte cannot ride `x-cmx2-directory` raw.** a
  header holds ascii and cmx2 decodes it as a uri component, so the icon
  lookups percent-encode the root (everything but `/` and the unreserved
  set). `session.rs`'s `scoped` still sends the raw string; a project path
  with a non-ascii letter fails there with "that is not a directory".
- **an unknown `x-cmx2-directory` is not free on every route.** at the pin
  `/config` and `/config/providers` keep one instance per directory string
  until a reload; `find/file` keeps none (cmx2-asks a28 has the numbers).
  rule: a lookup never sends the header for a root the host has not shown
  to be real (a session in the fleet works in it, or `/project` lists it).
- **a listing walks the whole directory on the daemon's event loop.** cmx2's
  `find/file` runs a synchronous `rg --files` for up to 10 s (cmx2-asks
  a29), so every stream stalls for the walk, and a session started in `~`
  makes the home a project the host "proves". rule: the lookups never list
  the host's home or any directory above it (`refused`, read from
  `/global/fs` once per host), refuse `/` at the route, read well-known
  paths through `/file/content` before any listing (a daemon without that
  route answers on the first read and nothing is ever listed), and wait 15
  s for a listing, past the daemon's own 10, because giving up first leaves
  it stalled with nobody listening and asking again stalls it again.
- **a listing cut at rg's 10 s is taken as complete.** the pinned daemon
  answers it as a plain 200, with nothing to say it was cut (cmx2-asks
  a29), so a repo whose icon lies past the cut is "no icon" for 30
  minutes. a decision, not an oversight: calling it transient would ask a
  daemon that stalls 10 s per walk again every 15 s for as long as the
  repo is on screen. when a29 lands, `x-truncated: true` becomes a
  transient with a long memory.
- **the daemon's `home` is not symlink-resolved, a project's root is.**
  `/global/fs` answers `homedir()` as it is; sessions' directories and
  `projectID`s go through `realpath`. on a host whose home is a symlink the
  `refused` check cannot match the root a session proves, and the home is
  listed (cmx2-asks a29 asks for a resolved `home`). nothing on the boxbox
  side can resolve a path on another machine.
- **an empty file is a file.** `touch public/favicon.ico` is common and a28
  answers it 200 with length 0. rule: an empty read is skipped, never a
  failure that stops the next candidate, and a repo whose every listed icon
  is empty has no icon (30 minutes, not a re-walk every 15 seconds). only a
  listed icon that is missing when read, every one of them, is transient:
  the listing and the files disagree.
- **a small repo matches neither `favicon` nor `icon.`.** both queries are
  fuzzy subsequence matches, so a crate of three files lists nothing for
  either, which reads exactly like a cold index. rule: when both are empty,
  one `find/file?query=&limit=1` tells a directory with files (no icon)
  from one with none (transient).
- **the tests' daemon is a local axum server, not a stand-in for the
  lookups.** `server/src/icons/testing.rs` answers `find/file` with
  listings recorded from the pinned daemon and `/file/content` the way a28
  asks, so the real reqwest path, the status classification and the byte
  caps run. what it cannot say is whether a real a28 daemon answers the
  same: that waits for the ask (docs/open.md).

## cmx2 behaviour the contract does not spell out

- **a native tool part's `time.start` is null.** `ToolState.time` declares
  `start: number | null`, and the pinned daemon writes `null` on every
  native part (the end is stamped). a row placed at `start` lands at the
  epoch: the clock reads 05:30 and the tape draws every mark at the left
  edge. rule: a step's moment is `start`, else `end`, else the message's
  `time.created` (`app/src/ui/thread/model.ts`, `stepOf`); a step with no
  start has no duration.

- **any reader can be closed at the daemon's 1 mb cap, not only a stalled
  one.** a javascript reader parsing a loopback burst falls 1 mb behind
  and cmx2 closes it too (a3 working as written). rule: every reader of a
  cmx2 stream resumes from its last id when the stream ends; the probes'
  witnesses use `ctx.follow()`, the upstream watcher resumes with
  `Last-Event-ID`.
- **a running question is not yet an ask.** with `[bench:asks]` the model
  calls two reads and two questions at once; the transcript shows all
  four tool parts `running`, but `GET /question` is empty until the
  permissions settle, and then holds one question at a time. a row that
  showed options for a running question part could not be answered. rule:
  a question row offers its options only when the fleet's pending list
  holds it (joined by `tool.callID`); otherwise it reads `waiting`.
- **how many asks a turn raises at once changed with the pin.** on
  2026-09-30 pi gated a response's tool calls in order, so the second
  permission was asked only after the first settled; at 0.8.1 (2026-10-01)
  the `[bench:asks]` turn had both permissions and both questions pending
  together (the thread drive saw ten options risen at once). rule: never
  assume either; take asks as the fleet raises them (a question row
  offers its options only once the fleet holds the ask, `waiting` until
  then), and in a probe take them in order (`nthAsk` in `probes/probe.ts`)
  or put asks that must be pending together in different sessions.
- **a streamed part is born by its first delta.** the pinned daemon sends
  no `message.part.updated` for a text part until the step lands: the
  first `message.part.delta` (offset 0) is the part's creation, and the
  whole part arrives at the end. a tail that waited for the part to exist
  before taking deltas would never stream. rule: a delta at offset 0 for
  an unknown part creates it; a delta past what is held (offset beyond
  it) changes nothing until the part arrives whole (`server/src/fleet/model.rs`,
  `Tail::stream`). the app's reducer is the same: a delta at offset 0 for a
  part the thread lacks creates it (text, `streaming: true`), and only a
  delta past what is held refetches the message (`app/src/sync/reducer.ts`).
  at contract 5 (0.8.5) the daemon announces every text and reasoning part
  before its first delta, so the fallback is for a host still at 0.8.3,
  which a fleet can hold; the announcement is what gives a part its type.
  a part's final comes when its block ends (a26), not at the step's end: the
  step's end publishes it again, identical, and the reducer takes both (a
  part replaced by an equal part).
- **a blocking send starts its body with a space.** `/message`,
  `/command` and `/shell` write one space at once to hold the connection
  through a long turn; a4's stored repeat has none. rule: compare such
  bodies as json text with surrounding whitespace trimmed.

## the sync worker

- **a hold was an open, so a thread with 66 child agents evicted every
  thread the person had opened.** the stage held each child through the
  worker's `open`, which counts against the 40-thread cap and refreshes
  recency, so 67 holds pushed the person's own threads out and they opened
  cold from the wire; the 150 mb cap in this file was not implemented; and
  boot read every page of every cached thread (over 100 mb for a large
  real cache) and posted it to the ui in one message. rule: `hold` and `open`
  are two verbs (`reducer.ts`: a hold takes a place only from held-only
  threads); boot reads heads, and a thread's pages are read when it is
  wanted; an entry for a thread whose pages are not in memory marks it stale
  so it is read again (never apply it to a thread you did not load, and never
  drop it without writing the mark: the saved cursor has moved past it).
  `perf.cache` rows say what boot read and what was evicted.

- **a read's number must never repeat for a key.** a thread evicted while its
  whole-transcript read was in flight and held again began at hydration 1
  again, so the worker's job key (`hydrate <key> <n>`) took the new read for
  the old one still running, and the reducer took the old answer (taken at an
  upstream seq before an entry that had arrived for the thread in the gap) for
  the new thread's: the entry was lost and the thread read `live` without it.
  rule: reads are numbered from one counter in the state (`SyncState.reads`),
  and a read is dropped the moment its thread is not the one it was made for
  (`read.ts`, `wanted`), before its body is downloaded or parsed.
- **a lane that wants more than the reserve read every child again every
  round.** with 16 places for held threads and a stage that held 66 children,
  each hold evicted the one held longest ago, so every round read all 66 and
  kept 16 (the bodies downloaded and parsed for threads that were evicted a
  moment later). a time-based protection (a place is safe for 10 s) only
  moved the thrash to every 10 s. rule: a hold is a lease on a place for as
  long as the thread is held and not released, and a hold that finds every
  place leased is refused and reads nothing; the lane that asks again is let in
  when a place is released or its thread evicted. the lease lives in memory
  only, so a page that is reloaded starts with none (a release the lane missed
  cannot outlive the page), and the cache must never write it back: a head
  read at boot is a free place.
- **children that do not fit together evict each other.** a stage of 60 mb
  with 12 wanted children of 8 mb is over the byte cap by 6 mb, and each
  child's read took the longest-held lease's room, so every re-hold (the lane
  re-holds what is absent, a few times a half minute, for as long as the
  child is wanted) downloaded and parsed one whole transcript and evicted
  another child, for as long as the screen stayed. the same happened to one
  child that cannot fit at all: dropped after its read, held again, read
  again. rule: a child's read takes room only from released held threads and
  opened threads off stage, never from another lease; one that cannot fit that
  way is dropped alone and its measured size is noted (`SyncState.unfit`), and
  a hold for it is refused without a read until the room it needs could exist,
  which is computed from what the stage and the leases weigh now. the person's
  open, and the stage's own growth, still take leases.
- **a refetch answer is for one incarnation of a thread.** the worker's job key
  was `refetch <key> <messageID>`, so a refetch of a thread that was evicted and
  held again was taken for the one still in flight and its older snapshot was
  merged into the new thread. rule: the read's number is in the effect, the
  job's key and the answer, and the reducer drops an answer whose number is not
  the thread's.
- **a module-level cache in a pure reducer is a singleton.** a `WeakMap` of
  part sizes kept the big tool outputs from being stringified twice and was
  global mutable state outside the store (AGENTS.md). rule: count a part
  without making it (words and an envelope for text, a weight of the json for
  the rest), the same function on both sides of a replacement, so no cache is
  needed.
- **a hold that cannot fit must not evict for the attempt.** `makeRoom` evicted
  the person's opened threads for a child's read and then dropped the read
  because it did not fit anyway. rule: a held read that cannot fit beside the
  stage is checked first and dropped alone.
- **an estimate of a size you do not know is worse than none.** heads written
  before sizes counted were given a size per page, 3.8 times too big for the
  review's thread, which on a first launch after an upgrade would have evicted
  small threads the person had open. rule: unsized heads count for nothing until
  their pages are read and measured.
- **axum's json and error answers announce no content-length when a layer sees
  them**, so a size floor read from the header never applies. read the body's
  `size_hint().exact()` as well, and test through a real handler, not a header
  set by hand (`http/compress.rs`).

- **thinking would have cost every home an entry per beat.** at contract 5
  reasoning streams by deltas, and `Tail::stream` grew a Reasoning item and
  asked for a session entry every 200 ms beat, while the window renders
  reasoning as nothing (`app/src/ui/window/tail.ts`): a journal entry of a
  few kb to every connected home for no visible change. rule: an item that
  shows nothing (thinking, an announced text part with no words yet) can
  change without an entry; the next entry carries it
  (`TailItem::shows`). an insert into a full tail still emits, since it
  pushes a visible item out.

- **a message's parts keep the daemon's order, not their arrival order.**
  at 0.8.3 a text part is born by its first delta while a reasoning part
  of the same step lands whole when the step ends, so `upsertPart`
  appended the thought after the answer: the app held `1:text 0:reasoning`
  where the daemon held `0:reasoning 1:text`, and the cache kept it across
  reloads. cmx2's own part ids are positional, `prt_<session>_<seq>_<index>`.
  rule: a part the thread does not hold is placed before the first held
  part whose (seq, index) is greater, compared as numbers (the seq's
  padding is the daemon's to change); an id without that shape (imported
  history) keeps arrival order and never moves one that has a position.
  it holds for part entries, resumed parts, delta-born parts, refetch
  merges and hydration buffers; a user message can hold a part of a later
  seq (the routing note) and keeps the daemon's order too
  (`app/src/sync/order.ts`). an insert before the end patches the whole
  parts list, since the ui sets a path and an index would overwrite.
  the worker puts a cache written before this in order as it loads it.
- **a snapshot never replaces what the thread already has with less.**
  0.8.3's in-flight read of a message holds only text parts (no reasoning,
  no tools), and a read is older than whatever the stream applied after
  it. rule: a refetched message merges: the snapshot's parts replace held
  parts with the same id unless that would shorten text, parts it lacks
  stay where they are, and every entry that arrived for the message while
  it was fetched (deltas, parts, info) waits and is applied over the
  snapshot in order. a held delta the snapshot did not reach reopens the
  refetch and keeps everything after it; none is dropped.
- **the worker ends a fetch job before it dispatches its answer.** the
  reducer's effects run inside `dispatch`, so an answer that asked for the
  same message again found its own job still in `fetching` and the second
  refetch was dropped, with its held deltas waiting forever. rule: release
  the job, then dispatch. messages asked for again within 5 s wait 125 to
  250 ms, then longer up to 8 s, so a message the daemon answers short of
  what is needed is not hammered.
- **an older cache with parts out of order costs the person nothing.**
  the worker's boot checks each cached message once (a pass over the part
  ids: about 12 to 17 ms in bun for 40 threads of 500 messages, far above
  a real cache, and off the ui thread), shows them in the daemon's order
  on the first frame and writes the fixed pages back.
- **backoff that waits for 30 s of health turns flaky wifi into minutes
  offline.** the first drop cut drew a 13.5 s outage out of 20 quick cuts,
  because each short-lived connection counted as a failure. rule: a
  connection that reached its hello resets the backoff; only dials that
  never get one back off.
- **agent-browser's `eval` may quote its answer once more.** a driver that
  unwraps "until it is not a string" parses a string result one level too
  deep. rule: the page answers `{"v": value}` as json, and the driver
  unwraps exactly one layer of quoting (`bench/exactly-once.ts`).
- **a hidden page runs no animation frames.** the ui applied the worker's
  patches on its own `requestAnimationFrame`; behind another tab none
  fire, so every patch of a streaming reply would queue for as long as
  the tab stays away (found reading the hidden case). rule: while
  `document.visibilityState` is hidden, patches apply at once, and the
  queue is coalesced as it grows, so its size follows the paths it
  touches, never the time away. the worker arms a timer beside its own
  frame for the same reason.
- **a navigation ends the worker, and its telemetry queue with it.** the
  worker flushes every 10 s or 50 rows; a reply answered and the page
  reloaded inside that window lost its `perf.send` row, and the thread
  drive saw 1 of 52 land. a `flush` message at `pagehide` does not help:
  the worker rarely gets to run it. rule: the ui keeps its own copy of
  each row it emitted until the worker reports the server took it
  (`flushed`), and on `pagehide` or hidden sends what is left with
  `navigator.sendBeacon`. the server writer drops a repeat of a recent
  id, because a page that only went hidden sends twice.
- **a page that navigates away keeps its stream socket for a minute.**
  chrome did not close a departed page's `/api/stream` connection when
  the document went: the server kept writing heartbeats to it for 62 s
  (`frames=5`) before "the client went away", and chrome holds six
  connections per host, so after a few quick navigations the next page's
  hydration request queued behind dead streams for 53 s (the thread drive:
  a thread with no rows and no card for 10 s, then fine). rule: the page
  closes its own stream on `pagehide` (`pause`: the worker aborts the
  socket and writes everything) and dials again on a `pageshow` with
  `persisted`. count sockets with `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED`
  when a page is slow to hydrate.

## telemetry

- **the rule that refused client need rows refused the server's too.**
  `normalize` dropped `need.raised` and `need.cleared` by kind alone, so
  the fleet's own rows vanished with "from a client (the server derives
  needs)" in the log, and the first matrix run found no `need.raised` row
  for a need it had just raised. rule: a server-owned kind is kept only
  when `Origin.server` is set, which only `Sender::record` sets; a client
  can claim the `server` device class, so the class is never the proof.

## parallel lanes on one machine

- **`pkill -f` on a relative command line kills every lane's server.**
  each worktree starts its bench server as `target/release/boxbox serve
  --config .cmx2/bench/boxbox.toml`, so one lane's `pkill -f` with that
  pattern stopped another lane's server mid-run ("shutting down
  signal=terminate", three times in the m4 lane). rule: stop what you
  started by the pid you noted when you started it (or by `lsof` on your
  own port), never by a command-line pattern.
- **worktrees sharing one `CARGO_TARGET_DIR` share the boxbox crate's
  fingerprint and build-script state.** `cargo build` in one worktree can
  hand back the binary another worktree built, and `target/debug/boxbox`
  serves the `app/dist` of whichever worktree last ran the build script (a
  reviewer saw an old "clear 5 done" pill this way). a check that must
  compile a given commit forces the crate to rebuild and reads that it did;
  `strings target/debug/boxbox | grep app/dist` names the dist it carries.

## the openclaw dev gateway (`just openclaw`)

- **`git clone --mirror` of openclaw is past 10 gib.** github serves every
  pull request's refs to a mirror clone; the first cold run was at 10 gib
  and still growing when it was stopped. the mirror at
  `~/.cache/boxbox/openclaw.git` is a bare repo that fetches exactly the
  pinned commit with `--depth=1` (165 mib), which is all `git archive`
  needs. a pin move fetches the new commit the same way.
- **`spawnSync` cannot buffer the export.** `git archive` of the tree is
  over 1 gib of tar; a `maxBuffer` of `1 << 31` overflows to a negative
  number and node refuses it. the export streams `git archive | tar -x`
  through a pipe.
- **node 25 and later ship no corepack.** the tree pins
  `pnpm@12.5.1+sha512...`; `npx --yes corepack@0.36.0 pnpm ...` runs that
  exact version (homebrew's pnpm 10 is not used).
- **the tree's build stamps the enclosing git commit.** `.openclaw/<commit>/`
  sits inside the boxbox checkout, so `hello-ok.server.buildId` carries
  boxbox's commit, not openclaw's. `server.version` is right; never read
  the commit from `buildId`.
- **the 2026.10.1 config refuses older shapes.** `default: true` on an
  agent entry fails start ("legacy agents.entries default markers need
  explicit surface owners", exit 78); `tts.providers.<id>.voice` and
  `agents.defaults.models` without `modelPolicy.allow` are flagged. the
  fixture uses what `openclaw doctor --fix` writes: `agents.ownership:
  "explicit"`, `agents.defaults.systemAgent.agentId`, `talk.agentId`,
  `modelPolicy.allow`, `speakerVoice`, `plugins.entries.openai.enabled`.
  when a pin move breaks the config, run doctor on a scratch copy and
  diff.
- **thinking levels need `reasoning: true` on the model.** with
  `reasoning: false`, `sessions.create {thinkingLevel: "low"}` answers
  "not supported for mock-openai/gpt-5.6-luna (use off|ultra)".
- **an exec approval is denied at once without an approval client.**
  "headless runs cannot wait for interactive exec approval" until a
  connected operator claims the `approvals` cap (docs/openclaw.md, 3.5);
  the bench client claims it.
- **most agent tools are behind `tool_call`.** the model sees read, write,
  edit, exec and a handful more by name; ask_user, automations and the
  rest are "cataloged behind compact prompt surface" and must be called
  as `tool_call {id: "ask_user", args}`. calling them by name answers
  "Tool ask_user not found".
- **a `MEDIA:` line with a `data:` url stays text.** a workspace path
  (`MEDIA: ./dot.png`) becomes an image block; the bench writes `dot.png`
  into each workspace.
- **media blocks land after the final event.** the tts `audio` block and a
  `MEDIA` image join the assistant row a moment after `chat` `final`; a
  history read right at final has only the text. the recorder polls.
- **a delta row is an envelope.** `chat.history {cursor}` rows are
  `{sessionKey, message, messageId, messageSeq, session, ...}`, not the bare
  message a page answers; `activeLeafEntryId` is at
  `sessionInfo.activeLeafEntryId`, not top level.
- **`sessions.create` with an `idempotencyKey` needs a device.** a
  device-less shared-token client is refused ("idempotent session creation
  requires an authenticated principal or device identity"); boxbox's
  paired device is fine.
- **`sessions.create` with no key makes a dashboard session**
  (`agent:main:dashboard:<uuid>`), which `archiveDashboardAfter` archives
  as `stale-dashboard`. a bench started with `--archive-dashboard-after
  20s` archives every keyless test session 20 s after its last activity.
- **the log file is machine-wide by default.** without `logging.file` the
  gateway writes `/tmp/openclaw/openclaw-<date>.log`, shared by every
  gateway on the machine; the fixture sets it to `.openclaw/bench/logs/`.
- **recorded fixtures name the machine unless scrubbed.** the hello-ok
  presence snapshot carries the lan address, the hardware model and the
  host name, and paths carry the checkout; `bench/openclaw-record.ts`
  scrubs them and refuses to write a file that matches a private pattern
  (the same `BOXBOX_PRIVATE_PATTERN` or `private/check-patterns.txt` as
  `scripts/check-public.sh`).
- **a script that edits a file through a tool's printed output truncates
  it.** a tool that caps its output at 2000 lines or 50 kb hands back the
  tail of a long file plus a footer; writing that back replaced
  `docs/openclaw.md` with its last 47 kb. edit large files in place
  (`edit`, or a script that reads and writes the file itself), never
  through a shell's captured output.

## typescript, the root project

- **a test that imports a component's module pulls the dom into the root
  project.** the root `tsconfig` has no dom lib; a `bun test` file importing
  `answer.ts` (which reads `navigator` through `push/device.ts`) failed
  `tsc -p .` with "cannot find name window". rule: what a test covers lives
  in a module with no browser imports (`ui/asks/words.ts`), and the verbs
  that talk to the browser stay beside it.

## ports on a shared machine

- **parallel lanes take their own decade, up to the 4990s.** the bench's
  port rule admitted daemons to 4898 while a lane was handed 4950 to 4959;
  `checkPort` (`scripts/pinned.ts`) now takes x0 to x8 up to 4998, the
  bench model on the next port.
- **cmx2 0.8 stamps its version at build time.** the pinned source reads
  `VERSION: string = typeof CMX2_VERSION === "string" ? CMX2_VERSION :
  "0.8.1-dev"`, so a source run (the bench, the probes) reports the
  literal. `pinnedVersion` takes the last quoted string on that line.
- **`/global/restart` exits the daemon for a supervisor.** in dev nothing
  would start it again, so `just cmx2` restarts a daemon that exits
  cleanly (code 0, no signal), as launchd and systemd do; any other exit
  still stops the bench.

- **3001 is not always free for the bench.** on a mac that runs a live
  boxbox v1, 3001 can be held by it (never stopped from a dev session,
  AGENTS.md, the live fleet). rule: the bench configs, `just dev`, `bench/exactly-once.ts`,
  `bench/stalled.ts` and `bench/cut.ts` read `BOXBOX_PORT` (default 3001);
  on a machine where 3001 is taken, run them with `BOXBOX_PORT=3011`.
- **agent-browser shuts its browser down after a few idle minutes.** the
  hidden case waited 10 minutes without a command; about 300 s in, the
  browser went away, and coming back found `about:blank` in a fresh
  profile that answered 401 everywhere, which first read as the tab
  being killed. rule: a driver that waits keeps the session busy with a
  harmless command (`tab list` each minute) and fails loudly if the app
  is gone, never reopening it quietly.

## push

- **chrome for testing cannot subscribe to push, and headless chrome never
  receives.** the testing build has no push service keys; headless
  subscribes (fcm answers 201 to the send) but the worker's push event
  never fires. rule: the harness launches google chrome, headed.
- **a chrome started from an agent's shell may never finish subscribing.**
  in the machines lane (2026-10-01), `pushManager.subscribe` in google
  chrome 154 launched from the session's shell gave no answer in 20 s,
  headless or headed, with or without `--use-mock-keychain`, while fcm and
  mtalk were reachable; chrome's log said the keychain refused it
  (`errSecInteractionNotAllowed`). `just push-harness` stopped at the same
  step. rule: a push drive that cannot subscribe says so and stops; it
  never fakes a subscription row.
- **a chrome profile with no window left gets no push.** with every window
  of the throwaway profile closed, fcm took the push (201) and nothing
  arrived in 30 s; with one unrelated tab open it arrived in about 200 ms
  (page open) to 6 s (app closed). "the app is closed" means no boxbox
  window in a running browser. rule: the harness keeps a blank tab.
- **a service worker built with the app imports the app's chunks.** vite
  split `payload.ts` into a shared chunk and `sw.js` began with `import`,
  which a classic worker cannot run. rule: `vite.config.ts` builds the
  worker alone as an iife after the app, and `just build` shows `sw.js`
  with no import.
- **a span's aria-label is not its name.** a role-less `<span
  aria-label>` is ignored by the accessibility tree; the snapshot showed
  only its text. rule: name controls and regions, never bare spans.

## the board trace harness

- **a scratch project inside a git checkout makes every sibling worktree
  part of it.** cmx takes a project's worktrees from git, so a harness
  project under this repo turned the machine's other worktrees into project
  directories, and v1's reconcile listed sessions with
  `x-opencode-directory` set to them, opening instances there and writing
  their paths into the trace. rule: harness worlds live under the system
  temp dir, in their own repo.
- **a repo with no commits gives cmx no project.** cmx names a project by
  its root commit; with none, the project-scoped session list v1
  reconciles from comes back empty and every thread made before the
  daemon connected is invisible to the board. rule: the scratch repo gets
  one commit, made with `GIT_CONFIG_GLOBAL=/dev/null` so the user's
  git identity and signing stay out.
- **v1 mints its read state on first access.** its baseline is stamped
  then, and everything updated before it counts as read. a fresh v1 data
  dir whose first reader is the daemon marks every setup thread read and
  the board goes dark. rule: the world reads `/api/read` before staging
  anything.
- **`Bun.spawn` is writable but not configurable.** `Object.defineProperty`
  throws; plain assignment works. `globalThis.Bun` is neither.
- **v1's board daemon drew before the hello ack.** its render loop started
  when the device opened, so a fake board that answered inside a render tick
  raced the palette push. rule: the fake answers hello after 40ms, longer
  than a tick, which makes v1's real order (global and a base frame, then
  the palette) the only order.
- **a bun server's streamed response can hold its headers until the first
  chunk.** a test upstream that pushed its first sse frame only after the
  client's `fetch` resolved deadlocked, since `fetch` resolves on headers.
  rule: a fake stream sends its first frame unprompted, as boxbox's board
  stream sends `hello`. the proxy records the status when headers arrive,
  as the fetch wrapper did.
- **a unix socket's path is capped at 104 bytes on macos.** a socket under
  a run dir inside a worktree path is too long to bind. rule: the fake
  board's socket lives directly in `/tmp`, named for the harness's pid.
- **status alone cannot say a turn is over.** right after `prompt_async`
  the session is not busy yet and reads as idle. rule: settled means every
  prompt is in the thread and the last message is a finished assistant
  reply, or an ask is open.
## home

- **webkit keeps every finished `Element.animate()` alive, with its
  element.** a static page that fades 20 spans a second in with
  `el.animate(opacity, { fill: "backwards" })` and removes them after 3 s
  held every animation it ever made (WebAnimation, KeyframeEffect,
  BlendingKeyframe) and every removed span and text node, about 10 kb each,
  after a forced gc; `cancel()` frees none of them and no js reference is
  needed. the same page with a css `@keyframes` class kept only the live
  ones. home's streamed words settled through `Element.animate`, about
  twenty a second with a fleet streaming, and that was most of the page
  process's WebKit Malloc growth (20 MB a minute after gc, home alone,
  WKWebView on macos). chromium frees them. home's windows were the bigger
  share: each reorder flips every window that moved, and each window kept
  one animation per move. rule: anything that animates per word, per batch
  or per row uses a css animation (`.settle-in`, `.live-text .w`); an
  element animated again and again reuses its one animation (`flip`'s
  `move`, motion/animate.ts); `Element.animate` is otherwise for
  transitions a person starts. a css animation is not a web animation in
  one more way: it starts over from its first keyframe whenever its
  element is put back in the page (the keyed `<For>` moving a window at a
  reorder) or an ancestor stops being `display: none`, where a web
  animation carries on. so `settleIn` drops the class once the fade has
  ended, and `flip` hands a fade still running its start time back after
  the move (motion/animate.ts). to reuse a finished web animation, use
  `cancel()` then `play()`: `currentTime = 0` starts it on the frame of
  the call in webkit, a frame before a fresh `Element.animate` would, up
  to 8.8 px off on a reorder.

- **`performance.now()` starts at the page, so 0 is not "never".** the calm
  law's "1 s after the last touch" was written with the last touch at 0,
  so every launch held the first windows back for up to a second (the
  budget run caught it: every launch painted 0 windows). rule: a moment
  that has not happened yet is `-Infinity`, and the first windows paint at
  once, never through a reorder.
- **agent-browser's `--session` goes before the command.** `agent-browser
  set viewport --session x ...` reads `--session` as the command's own
  argument. rule: `agent-browser --session <name> <command> ...`.
- **navigating a tab again keeps the old page's stream open.** chromium
  holds the previous document (and its worker's `/api/stream`) for 10 to
  22 s after the same tab navigates; after five launches the held streams
  fill the six connections per host and the next document waits about 9 s.
  reloads and fresh tabs never stall. rule: a launch in a bench is a fresh
  tab; the app itself should drop its stream on `pagehide` and resume on
  `pageshow` (sync lane).
- **a background tab runs no animation frames.** a tab opened behind
  another paints nothing until it is in front, so a launch timed there
  reports the wait. rule: the bench brings a new tab to the front before
  anything else, and `perf.launch` is not reported for a page that was
  hidden before it painted.
- **timing on a shared mac is noise.** the same build measured p90 input to
  paint 32 ms on one run and 104 ms on the next, with the load average at
  466 from other sessions. rule: print `uptime` beside any desktop budget
  number; only the device run judges the gate.
- **a fresh browser can lose its first viewport.** `agent-browser close`
  then `set viewport 390 844` then `open` left the page at chromium's
  default 1280 x 577 often enough that both ladle screenshot tests shot
  their "phone" size at 1280 wide for a while and passed (the files said
  so: `sips -g pixelWidth`), and home's birth check failed at "phone" only
  in a full run. rule: after the first `open` of a fresh browser, ask the
  page for `innerWidth` and set the viewport again if it differs
  (`bench/shell.ts`, `app/.ladle/home-shots.ts`, `shell-shots.ts`).
- **a story that shows one window three times repeats its names.** the
  screenshot test's unique-name check is scoped to each `figure` of a state
  story and to the page everywhere else.
- **chromium counts a layout move under a flip.** a window that grew by
  layout in the rail moved the windows below it, and sliding them back
  with a flip (a web animation started in the same resize observer
  callback) still scored 0.03 to 0.07 per ask: a new animation applies
  from the next frame, so the frame that painted the move counted it. an
  inline transform set in the same task did hide the boxes, yet their
  absolutely placed `::after` still counted. rule: for perf.shift 0,
  nothing laid out moves. an asking window used to grow, and the strip's
  stage made room by transform; it now keeps its resting size in every
  arrangement (2026-10-05), so there is nothing to make room for. the shell
  drive puts every shift where it happened (the stage and the other
  windows, the asking window's own content, the bar) so a cause is named,
  not guessed.
- **a flex row's text box that changes width moves.** the bar's line sits
  right of a spring, so a phrase that grows moves its paragraph left; a
  button with vertical padding on a line of its own changed the row's
  height by 12 px when "wants you" came and went (the rail and the deck
  moved every window under it). rule: a line that comes and goes keeps
  one line height (`.sum` 20 px), and a hit area reaches past it by a
  pseudo-element, never by padding.
- **a signal set inside an effect renders after the effect.** the order
  was applied from `createEffect(on(target, applyOrder))`; solid holds
  back what `setOrder` renders until the running update ends, so `flip`
  read the old dom before and after (nothing slid) and the born window was
  not in the map yet (`birth` was never called): a thread arriving in view
  just appeared. reorders after a touch went through a timer and moved,
  which hid it. rule: anything that measures, mutates and measures again
  (`flip`, a birth) runs outside a reactive update; home applies the order
  in a microtask. closed: the screenshot test plays the birth under a
  frame pump and fails unless the animation's clock and the computed
  opacity and transform change frame by frame (`home-shots.ts`).
- **a text box is the font's whole content area.** the craft check flagged
  every window's chip for crowding its top edge by 3.9 px: a range's rect
  for 12.5 px boxbox sans is 18 px tall (ascent to descent, whatever the
  line height or `text-box` trim), so the law's 26 px chip could never
  show 8 px above and below it, while its letters sit about 8 px clear.
  rule (2026-10-01): the measure stays as it is and the chip is
  34 px tall, which holds 8 px above and below the 18 px box. a check
  moved until it passes is not a fix; when a size the law names cannot
  pass the measure, the size goes to the maintainers, never the check.
  `line-height` does not move a range's box; the font's metrics do.
  closed: the chip uses "Boxbox Sans Chip", the same file with
  `ascent-override: 88.5%`, `descent-override: 23.5%` (the font's own
  79 to 21 split at 1.12 em), so its text box is 14 px and the
  unchanged check finds nothing on any chip (`app/src/styles.css`).
- **boxbox sans rides high in a short line.** the window's prompt bubble,
  the design's `8px 11px` at 13.5 px on a 1.38 line, put its letters'
  box 7 px from the top and 8.6 px from the bottom: the glyph box is
  taller than an 18.6 px line and sits above its middle. the design's own
  font hid it. rule: a sans surface copied from a design is measured
  in boxbox sans, and the extra pixel goes on top (`window.css`, `.me`).
- **a line can break after a button.** home's bar summary was a flex row
  of a button and a span; made inline text, it still wrapped as "ledger
  wants you" then ", 2 working": a button is an atomic inline, and the
  rule that keeps a comma off the start of a line does not hold across
  it. rule: punctuation after a control sits with the control inside one
  `white-space: nowrap` part, and parts are joined by plain spaces.

## ops

- **stdin's lock is not reentrant.** `io::stdin().lock()` held for a
  prompt's lifetime deadlocks the first time anything else on the thread
  reads stdin, as `boxbox init --password-file -` does. rule: lock stdin
  per read, never hold a `StdinLock` in a struct.
- **cookies ignore ports.** v1 on `:443` and v2 on `:8443` of the same host
  name see each other's cookies, so a shared cookie name would sign one
  out whenever the other signs in. rule: v2's cookie is `boxbox_session`,
  v1's `bb_session`; never set one to the other (`docs/deploy.md`).
- **rustls brings c.** reqwest's rustls uses aws-lc, and sqlite is bundled
  c too, so a linux release needs a c toolchain for its target; cross
  compilers make that fragile. rule: the github release builds each
  architecture natively in `ops/release/Dockerfile` (alpine, musl, static).
  a mac cross-compiles only with zig (`ops/release/zig.sh`, decision 83),
  whose clang and bundled musl build that c for the target; a gcc or clang
  cross toolchain set up by hand stays out.
- **rpassword prints its prompt before it turns echo off.** a script that
  answers a password prompt the instant it appears (a pty driver, an
  `expect` script) gets its answer echoed back to the terminal; a person
  never types that fast. rule: automation gives `boxbox init`
  `--password-file`; a pty test pauses before each secret, as a person
  would.
- **`file` names a static musl binary two ways.** aarch64 reads
  "statically linked", x86_64 "static-pie linked"; a check for one phrase
  failed the first x86_64 release after a clean build. rule: the release
  Dockerfile accepts both, and rejects anything with an interpreter.
- **dash does not expand a glob in a redirection.** `printf x
  >>dir/boxbox-*.tar.gz` under `/bin/sh` on debian creates a file named
  with a literal `*` and leaves the tarball alone, so the tamper test
  first "installed a tampered tarball". rule: resolve a glob with `for`
  before redirecting to it.
- **systemd's own services die under x86_64 emulation.** in an amd64
  container on an arm64 host (rosetta), journald and logind run under
  seccomp filters the translated process trips, and die with sigtrap;
  without logind no user manager starts and `systemctl --user` has no bus.
  rule: `ops/test/systemd.Dockerfile` lifts those filters for system
  services only; the unit under test is a user unit and runs as shipped.
- **launchd's gui domain ends at logout.** `launchctl load` and
  `bootstrap gui/<uid>` (what cmx2's `serve --install` uses) put an agent
  in the gui login's domain, which logout tears down with its agents.
  rule: the boxbox agent is bootstrapped into `user/<uid>` with
  `LimitLoadToSessionType` `Background`, so a later gui login does not
  load a second copy into its own domain (`docs/deploy.md`, the mac).
- **launchd opens the log, not the program.** `StandardErrorPath` is
  opened by launchd for each start and never rotated; a wrapper that
  renames the file at start leaves the server writing into the renamed
  one. rule: nothing pretends to rotate it; `boxbox service status`
  shows its size, and a capped log has to be the server's own.
- **`std::env::set_var` is unsafe in edition 2024**, and unsafe code is
  forbidden, so a test cannot point `HOME` somewhere else. rule: the code
  under test takes its paths as arguments (`upgrade::replace` takes the
  target), and only the thin command reads the environment.
- **the first pairing makes a loopback cmx2 daemon ask everyone.** a
  daemon on 127.0.0.1 with no password serves without a credential until
  any client pairs; from then on every request needs one, and whatever
  called it bare gets 401 (cmx2 of 2026-10-01, `unguarded()`). rule: before
  pairing with someone's daemon, check what else calls it; one on
  `0.0.0.0` asks already.
- **`option_env!` sees a set-but-empty variable.** a release script that
  exports `BOXBOX_REPO=""` compiles `Some("")`, not `None`. rule: the
  stamped repo is filtered for emptiness wherever it is read.
- **`just build` stops at the app's script budget and leaves the build
  behind.** `scripts/compress.ts` writes every `.br` and `.gz` and only
  then exits 1, so `app/dist` is complete when the recipe fails. rule:
  that failure is a budget to fix in the app, not a broken build; never
  ship around it without saying so (on 2026-10-01 the committed app was
  156.7 kb of its 120 kb).
- **`boxbox upgrade` on linux reads the unit's `%h` as text.** the shipped
  unit runs `%h/.local/bin/boxbox serve --config
  %h/.config/boxbox/boxbox.toml`, and `service::state()` splits that line
  without expanding systemd's specifiers, so the config it loads to check
  the restart is a path that does not exist. the first linux upgrade (the
  vm, 2026-10-03) placed the binary, kept `boxbox.previous`,
  printed a false note that the service runs another binary, then refused
  to restart: "the service's config does not load". rule: a unit's words
  are read back through `exec_words` (`server/src/cli/service.rs`), the
  inverse of what install writes, `%h` and quotes included. a binary from
  before that fix (2026-10-03 and older) still refuses: run `boxbox doctor`
  and `systemctl --user restart boxbox` after it, or run the upgrade with
  the new release's own binary. the running server keeps the old inode
  until the restart, so nothing is down in between.
- **a release build can ship the source from before an edit made while it
  ran.** buildkit copies `server/` when the `COPY` step runs (after the base
  images are pulled, which can take minutes), and cargo calls a file fresh
  when it is older than the last build's output, which is stamped when that
  build ends. a file edited between the copy and the end of a build is
  therefore older than the build's output: the next build on the same cache
  mount finished in 0.4 s and handed back the first build's binary, byte for
  byte (the "new" static binary answered with the old error text; found by
  comparing `md5`). rule: do not edit sources while a release or a measuring
  build runs; after one that was edited, `touch` the sources (or build with
  `--no-cache`) and compare the binary's `md5` with the last one's before
  trusting what it measures.
- **a mac's resident memory is not the server's.** after a photo message
  the system allocator keeps the freed 23 mb blocks in its large cache (57 mb
  of a 63 mb footprint, four regions) and `ps` shows them as resident for
  tens of seconds; the debug build held 82 to 113 mb. the static linux
  release returns to idle (9 mb) at once. rule: memory claims are measured on
  the release build for the machine they are about (`docs/composer.md`, what
  the server holds for photos), and a mac number says "mac" beside it.

## the stories' screenshot test reads whatever ladle holds its port

`app/.ladle/shots.ts` serves ladle on 61010 and reads `meta.json` from it.
when another worktree's lane already has ladle on 61010, the new server
fails to bind and the test quietly reads the other lane's stories (it once
printed "0 screenshots, 0 failed" for a prefix that had nineteen). pass
`--port <n>` per lane; the composer lane uses 61012.

## a store value posted to the worker throws, silently

solid's store hands out proxies, nested arrays included. a draft built
with `{ ...draft(), text }` still holds the store's `photos` array, and
`postMessage` cannot clone a proxy: it throws a `DataCloneError` inside an
async handler, the send never reaches the worker, and nothing on screen
says so. anything posted to the worker goes through
`structuredClone(unwrap(value))` at the boundary (`sync/client.ts`).

## an echo can arrive in a transcript read, not a frame

when boxbox restarts (a deploy, a crash) the worker's next connection can
come back without the frames that went by while it was away, and the
thread is read whole (`hydrated`, `refetched`) instead. an outbox that
settles only on live `message` frames then misses the echo of a send that
landed, and the 30 s watch calls it "not sent" while the daemon has it
once (the composer drive caught exactly this). the sender reads every
transcript the worker reads (`Sender.read`), and the drive kills boxbox
mid-send to keep it honest.

## telemetry the worker emits itself can die with the page

the worker batches rows for up to 10 s. `pagehide` posts a flush, but the
browser tears the dedicated worker down with the page, so the fetch is
cancelled. rows the ui thread emits are also kept on the ui side and go by
beacon on the way out (`sync/client.ts`, `emit`); rows the worker emits on
its own (the sender's `perf.send` and `friction.abandon`) have no such copy,
and the last few seconds of them are gone (the composer drive lost the last
8 of its 50 sends this way). a boxbox killed in its 500 ms write window
loses the batch it just answered 202 to. a drive that counts rows waits
past the 10 s flush before it navigates away, and treats a row count below
what it sent as this, not as a failed send.

## a post on a vanished network never answers

a fetch whose connection disappears without a reset (a phone leaving wifi,
a server killed between taking a request and answering it) stays open for
minutes, and `signal` is the only way it ends. the composer drive caught a
send left "on its way" for 30 s after boxbox died, while the line already
said the connection was down. the sender ends every post in flight when
the stream drops and bounds each post's time (`sender.ts`, `POST_MS`); the
send then waits on the device and goes again with the same client id,
which the daemon answers with its first answer.

## the build's css

- **lightning css keeps only the last of `backdrop-filter` and
  `-webkit-backdrop-filter`.** vite 8 minifies with lightning css, which
  folds the two into one property and keeps whichever came last: written
  unprefixed first, the build shipped `-webkit-backdrop-filter` alone,
  which chromium ignores, so every glass bar in the installed app (the
  stage's bar, its pinned ask line, the ruler, the menu, the machines'
  sheet) drew no blur on the mac while the stories, served unminified,
  did. rule: the prefixed line first, the unprefixed last (or the
  unprefixed alone; lightning css adds the prefix the targets need), and
  read `app/dist/assets/*.css` for `backdrop-filter:` after a build that
  touches glass.

## the shell

- **openapi-fetch keeps the `fetch` it found when the client was made.**
  `createClient` reads `globalThis.fetch` once, so a story that swaps in
  its recorded answers after `api/client.ts` has loaded still goes to the
  network (ladle's server, 404). rule: the shell's stories import
  `stories/server.ts` first, before anything that creates the client;
  ladle loads each story file lazily, so nothing else got there first.
- **devtools' offline switch covers the page, not its workers.**
  `Network.emulateNetworkConditions` on the page's session failed the
  page's own `fetch`, but the sync worker's stream stayed live, so home
  never said "offline". rule: an offline proof stops the server (or
  emulates on every worker target too); a page-only switch proves only
  that the page itself could not reach the network.
- **a root script cannot import an app workspace's dependency by name.**
  bun installs each workspace's dependencies beside it, so
  `scripts/icons.ts` importing `@resvg/resvg-js` found nothing from the
  root. rule: name the app's copy by its path
  (`../app/node_modules/...`), with a comment saying why.
- **`::first-letter` does nothing on a flex container.** the back
  control's chevron, sized with `::first-letter` on an `inline-flex`
  button, stayed the word's size and sat high. rule: the chevron is its
  own element, drawn with two borders as the stage's `‹` is.
- **an inert layer is still read by the craft check.** the deck's windows
  under an open thread are inert and covered, yet `craft.js` measured
  them and reported crowding nobody can see. rule: the shell's
  screenshot test hides inert subtrees after the screenshot and before
  the craft check (`app/.ladle/shell-shots.ts`).
- **a fresh worktree has no pattern list, so the public check proves
  nothing.** the public check prints "skipping" without one. rule: `just
  setup` in every new worktree, and give the check `BOXBOX_PRIVATE_PATTERN`
  before a lane lands.
- **a story that opens a thread needs its transcript at every width.**
  home at the ipad and mac widths puts the window that wants you on the
  stage, so a home story with no transcript showed "reading the thread."
  forever beside the windows. rule: home's and the shell's stories hold
  the notes transcript for that window
  (`app/src/ui/thread/stories/transcript.ts`).
- **a second tab in agent-browser's chrome is not dependable.** `tab new
  <url>` now and then left the tab on `about:blank`, and once a new tab
  never painted ("nothing is running" with no windows, every patch
  waiting on a frame) while `snapshot -i` waited five minutes on it;
  `tab <id>` back to a hidden tab hung the same way. rule: a drive that
  needs a pasted url opens it in a second agent-browser session signed in
  on its own, gives every agent-browser command a deadline, and starts a
  browser again when its page gives no frame (`bench/shell.ts`).
- **a page the service worker controls loses what it sends as it
  unloads.** the first page after sign-in is not controlled and its
  hide-time telemetry landed on a reload; every later page is, and on a
  reload two seconds after a tap its `perf.paint`, `perf.frames` and its
  own `perf.shift` never reached the server (0, 0, 0 in four of four
  tries; unregistered, 1, 1, 1 every time). the cause is the fetch
  handler, not the app's listeners: with one installed, chromium hands a
  controlled page's every request to the worker first, even the `/api`
  posts it returns untouched, and of six posts sent at `pagehide` and
  hidden on a reload after 40 s on the page (keepalive fetch and
  `sendBeacon` alike) a controlled page delivered four, three times in
  three, and an uncontrolled one six. rule: `sw.ts` routes `/api/*`
  around the worker with static routing (`InstallEvent.addRoutes`,
  chromium), which took the same probes to six of six and 1, 1, 1; a
  leaving page's flush also goes beside a batch still in flight
  (`Telemetry.flush(true)`), so the hide's own row never waits on one.
  safari has no static routing, so there the posts still pass through
  the handler. a second loss hid behind the first: `perf.ts` sent its
  queue only from home's observers, which stop when a screen replaces
  home, so a tap measured on home, then machines, then a reload inside
  the 10 s flush lost the tap's rows (the drive at 820: one
  `perf.paint` of two). rule: a queue is flushed on hide by its own
  owner for as long as it lives (`perf.ts`, `emitter`), never by a
  component that may be gone. a drive reloads seconds after a tap, as
  a person does (`bench/shell.ts`).

## history: the cursor is exclusive, and a reload needs its screen listed

`GET /api/history`'s `next` is the key of the last row shown
(`<updated>:<host>:<id>`), and cmx2's own `before` is exclusive on time
alone, so the server asks one millisecond past it and skips what the key
passed; a page that is only one millisecond is read again wider. an
exclusive time alone drops the rest of a millisecond at every page edge
(33 threads with one `updated_at` lost two to four at page sizes 5 to 30
before this). a search page can
come back empty with a cursor (nothing in this slice matched), so the
screen keeps reading by itself up to five times before it asks.
`routeFromUrl` (`shell/navigation.ts`) lists every screen by hand: a
reload on `?screen=history` landed on home until `history` was added
there. a new screen needs `routes.ts`, `navigate`, `routeFromUrl`,
`store.ts`'s `Screen` and the shell's `Switch`, all five. the edit and
write tools run rustfmt through a hook that may not carry the edition;
run `cargo fmt` yourself after editing Rust.

## home: an open thread with no layer kills every tap

a url's `?thread=` naming a session the fleet does not hold (archived, another install's link, a thread the host forgot) set home's `open()` anyway; the stage's `<Show when={viewOf(key)}>` drew no layer, and on the deck `.bar`, `.wins`, the pager and the dock are `inert` whenever `open() !== null`, so the person saw dimmed windows and nothing answered a tap (reproduced at 390 against the dev daemon with `?thread=bench:ses_nope`). rule: `open()` is set only when `state.fleet.sessions[key]` exists; a session still missing after the stream caught up is dropped with `closeThread()`, and a thread on stage that leaves the fleet lets the stage go (`stage-open.ts`, `home.tsx`). `growFrom` and `shrink` also schedule their release in a `finally`, so a throw in their animation can no longer leave `busy` set. `home-shots.ts` fails any deck story that is inert with no layer on the stage, and the "home stale thread url" story holds the case.

## the composer's pickers: stars, marks, the dial

- **`effort.ts` and `effort.tsx` cannot share a folder.** `import "./effort"`
  resolves the `.ts` first, so the component file's exports were "not
  exported" and the error read as a typo. rule: one stem per module; the
  pure ladder is `effort.ts` and the meter and dial are `dial.tsx`.
- **a row rule on `span` and `b` reaches the tiles put inside the row.** the
  menus' `.cz-option span` (the slash row's description) recoloured and
  clipped the provider tile (a span), and `.cz-group-head span { flex: 1 }`
  stretched a mark into an oval; the monogram is a `b`, which the mono `b`
  rule restyled and which a bench query for the row's `b` found first. rule:
  rules for a row's text are scoped to the row's kind (`:not(.model):not(.tool)`)
  and name their parts by class (`.cz-name`, `.cz-group-name`).
- **the sliding thumb's dark label must beat the segment's own colour.** the
  lit layer is the same segments again, clipped; a rule for `.cz-seg` set the
  light colour on the lit copies too, so the chosen label read pale on the
  light thumb. the lit layer's rule names itself (`.cz-thumbed .cz-thumbed-lit
  .cz-seg`). the thumb's lit top edge is a gradient on the layer, not a box
  shadow, since a clip cuts a shadow off.
- **the craft check measures "touching" as the vertical gap to the next
  sibling,** so a row's track (44 tall) and a pill beside it (38 tall) read as
  surfaces 41 px inside each other. a button 36 px tall or less is never a
  surface: pills that sit beside a surface in a row are 36 (44 on touch,
  where the check is not run).
- **a flag the dial reads as it is made must be set before the signal that
  makes it.** `setDial(true)` rendered the dial synchronously, then
  `setDialByKey` came too late, so a keyboard-opened dial did not take focus.
  the same moment decided the menu's find focus. say the flag first.
- **a story's `el.click()` is a keyboard click** (`detail` is 0), which the
  composer answers by moving focus into what opened, so the stories' first
  screenshots wore focus rings. the stories' `press` dispatches a click with
  `detail: 1` (a tap), `key` is the keyboard one.
- **a star is the whole list.** each press sends every id, so two quick presses
  answered out of order would put the older list back. rule: only the newest
  press's answer settles the list, and a failure puts back what that press
  found (`favorites.ts`, tested with a fake route; the real client cannot be
  built under bun with an empty base url, a `Request` needs an absolute one).
- **equal columns that fit their widest label: size the grid under max-content.**
  the dial's segments must be equal (the thumb is a fraction of the track), yet
  six levels on a phone cut "medium" to "mediu…" when the columns were
  `minmax(0, 1fr)` in a track with a guessed `min-width`. a grid of
  `repeat(n, minmax(56px, 1fr))` sized under `min-width: max-content` gives every
  column the widest label's width (the spec's flex fraction for an intrinsic
  grid), so labels are never cut and the clip stays a plain fraction; what does
  not fit scrolls. `scrollIntoView` on a segment scrolls every scrollable
  ancestor (the sheet, the stage): the row scrolls itself (`reveal`).
- **`on(source, fn, { defer: true })` does not record the first input.** the
  deferred first run returns before `prevInput` is set, so the first real
  change reaches `fn` with `before === undefined`; the thumb's slide guarded on
  that and so never slid the first time (a dial folds after one pick, so it
  never slid at all until the effort was picked twice). rule: no `defer` when
  the effect needs the previous value; let the run at mount record it and
  return on `before === undefined`.
- **an optimistic store write lands before the first `await`.** `toggleFavorite`
  sets the list synchronously, so the star's pop, reading `starred()` after the
  press, saw the new value and popped on the star taken off. rule: read what
  the press changes before calling it.
- **a listbox holds options and nothing else.** the model menu grew star
  toggles, a switch and a text box inside `role="listbox"`, and the plus menu
  behaved like a menu while being a listbox of options. the model menu is a
  group of buttons (`aria-current` on the one in use), the plus menu a `menu`
  of `menuitem`s; only the slash and file menus, whose rows are never focused,
  stay listboxes.
- **a stop does not leave a waiting steer queued: it can take it into the
  thread.** cmx2's `abort` ends the turn, but the loop drains the steering
  queue at the next boundary, and the boundary a stop lands on (the tool
  returning "aborted") is one: the steer becomes a user message, the next reply
  is an empty `aborted`, and `loop` (`drainQueue`) finds nothing queued and
  answers `true`. only a stop that lands while the model streams leaves the
  steer for `loop`. driven against the pinned daemon with a slow command and
  with a wait on agents (steer, abort, loop, then read the transcript). rule: run now on a
  steer takes it back first (`DELETE …/message/:id`, which works until it went),
  stops, then sends its words as a prompt; never abort-then-loop for a steer.
- **tools.** the read tool sees only the working directory, so scratch
  screenshots go under `app/.ladle/shots/` (ignored), each to a new file
  name; the shell returns an image only for a file that same command wrote;
  macOS `sed -i` needs `''`, and a ladle on 61030 is the shots test's own, so
  a hand-driven one takes another port.

## the two appearances: a token is resolved where it is declared

- **an inherited token carries the value it had where it was declared.**
  `--text: color-mix(... var(--L) ...)` declared on `:root` is resolved
  there, with the page's `--L`, and its children inherit the result; a
  surface that sets its own `--L` (the terminal's bed was one) still
  inherits the page's ink, and a window inside the stage inherits the
  stage's hue-tinted ink. rule: a surface that must read the tokens afresh
  (the window plane, `plane-window`) is listed beside `:root` on the block
  that declares them (app/src/styles.css), and a token built from an
  element's own palette (`--accent`, `--win-*`, `--flood-*` from `--tone`,
  `--window-top`, `--c1`) is declared on the elements that carry the
  palette, never on `:root`.
- **a ladle story is dark unless its url asks for light.** ladle's own
  theme (its default is dark) sets `data-theme` on the root, which the app
  reads over the system's appearance, so a run with the browser in light
  still painted most stories dark: a light craft run of the thread,
  composer, home and details stories had checked dark. rule: shoot light
  with `--theme light` (`shots.ts`, `home-shots.ts`, `shell-shots.ts`),
  which asks ladle in the url and sets the browser's scheme for the shell,
  whose app clears the root's theme on "system".
- **the run tool's `fs.read` returns numbered lines.** a script that reads
  a file with it and writes the text back writes `     1\t` before every
  line (two lanes clobbered `styles.css` and `home.css` this way). rule:
  in a script, change a file with `fs.edit`, or with a program that reads
  and writes the file itself (python or sed through `shell.exec`); never
  write back text that came from `fs.read` or from a command's output (see
  "never round-trip a file through a command's output").
- **a rule written for the system's light mode only ignores the device's
  choice.** `@media (prefers-color-scheme: light) { .home .pill {...} }`
  stayed light on a device that chose dark, and was missing on one that
  chose light. rule: no appearance media queries in components; every
  colour is a token written once with `--L` (design.md, the two
  appearances).
- **frosted glass over a scrolling log smears.** a white bubble passing
  under the stage's blurred bar became a grey blob. rule: the bar sits on
  the flood and the scroller dissolves its own top edge with a mask.
- **two stylesheets, one generic class.** the details' `.facts` and
  `.dir` took thread.css's rules in the app (and gave theirs back), while
  the details' own stories, which load no thread.css, looked right. rule:
  a panel's classes carry its prefix (`.dt-`, `.tb-`), and a story that
  stands alone is not evidence that a class does not collide.

## reduced motion and the transition shorthand

- **a duration alone animates every property.** the global reduced-motion
  rule set `transition-duration: 120ms` on every element; the initial
  `transition-property` is `all`, so the stage's margin animated by layout
  for 120 ms when a fold should have been instant. rule: the reduced rule
  also sets `transition-property: opacity` (only the content fade
  survives, as the law says).
- **js motion read only the system's setting.** `prefersReducedMotion()`
  followed the media query and ignored the device's own "reduce motion",
  which the css obeyed. rule: settings tells the motion module
  (`setMotionChoice`), and every caller reads `prefersReducedMotion()`.

## an animation started in a `ref` never ran

- **solid's elements are born in an inert document.** jsx is cloned from a
  `<template>`, whose contents belong to a document with no window, and a
  `ref` runs before the clone is put in the page. `el.animate()` there
  never ran: chromium took that document's timeline, which never ticks,
  and webkit (every iphone) left it pending even when handed
  `document.timeline`. either way it held its first frame for good
  (`getAnimations()` does not list it). a queued card's arrival (opacity 0,
  `fill: "backwards"`) left every card queued with the composer up for
  more than 600 ms invisible, still taking its room, until a reload
  painted it with no arrival. naming the page's timeline fixed chromium
  only; the fix shipped and the bug stayed on the phone. rule: `play`
  starts an animation on an element not yet in the page a microtask later
  (solid has inserted it by then), so a `ref` may animate; a raw
  `el.animate` waits until the element is in the page. a motion fix is
  checked in webkit too (playwright's, with an iphone profile), not only
  in chrome.
- **a `<For>` over objects built in a memo makes every row again.** the
  queue's cards were rebuilt whenever the thread's messages changed (every
  step of a working turn), so each card was a new element and played its
  arrival again. rule: a list whose rows animate in is keyed by id
  (`<For each={ids()}>`) and each row reads its latest by id.

## ladle and screenshots, learned in the folds

- **a new story export needs a ladle restart**: the running server does
  not pick up a new export in an existing stories file.
- **a background `&` in a shell tool call dies with the call** (120 s);
  a server that must outlive it is a background job of the tool.
- **an animation's frames can be captured exactly**: pause every
  `document.getAnimations()`, set `currentTime`, screenshot; a frame
  sequence of a move is then repeatable, not a race with the clock.
- **never `read` an image path that may not exist** in an agent lane: an
  image inside an error result poisoned one lane's transcript for good
  (every later turn replayed it and failed); `ls` first.

## the live turn, learned when its window went

- **a masked ancestor turns `backdrop-filter` off.** in chrome 151 any
  ancestor with `mask-image` (the stage's scroller dissolves its top edge
  with one) makes a descendant's `backdrop-filter` blur nothing. rule: a
  surface floating inside the scroller (the live tape, the scrub caption)
  is an opaque card in the glass's colours, never a blur that is not
  there. safari is unchecked.
- **a sticky offset is measured from the scroller's content box**, so the
  scroller's padding is already out of it; an `IntersectionObserver`'s root
  is the content box too. a custom property keeps a `calc()` as written,
  so a length read back from one (`--foot`) must be declared as a plain
  length.
- **`on(fn, { defer: true })` passes `undefined` as the previous value on
  its first run.** a settle that asked "was it live" was skipped when
  nothing had notified before it. rule: track the previous value yourself.
- **chrome's scroll anchoring moved the row a reader tapped**: a row that
  grows below the anchor chrome picked shifts what is above. rule:
  `overflow-anchor: none` on the stage's scroller, which keeps its own
  place (`FollowContext`).
- **an effect that reads a prop backed by the turn re-runs on every
  delta** (the prop is a getter over the running turn), so a tape's
  observers were made again each frame and `data-stuck` flickered. rule:
  read such a prop through a `createMemo` that changes only when it does.
- **a replay story must land the stage at the end before the turn
  starts**, or the follow races the history swap and never pins.
- **never round-trip a file through a command's output.** output is cut
  past a size (the top of a long file is dropped), and a file written back
  from it loses its head silently. rule: edit files in place, or build
  them with redirects (`cat a b > c`) that never pass through output.
- **a lazy chunk that shares a module with the first load can make the
  build worse, not better.** the bundler (rolldown, vite 8) hoists a module
  shared by the entry and a lazy chunk, with the solid runtime beside it,
  into a preloaded chunk of its own, and every lazy chunk then reads it
  from there: the first load grew from 121.0 to 122.7 kb brotli when the
  review card was split off with its modules shared. the review's chunk
  imports no module of the first load (the api client and the motion
  helper are props), which keeps the hoisted chunk down to the solid
  runtime (the first load is then `index` plus a `web` chunk, 119.3 kb).
  the size is read from `bun scripts/compress.ts` after `vite build`,
  never guessed, and `index.html`'s preloads say what it counted. rule
  since 2026-10-16: `vite.config.ts` puts every module the entry imports
  statically into one chunk (a `codeSplitting` group on rolldown's
  `$initial` tag), so a lazy chunk may import from the first load freely:
  splitting the sheets of `ui/later.ts` off without it moved 9.8 kb into
  lazy chunks and took 0.2 kb off the first load (it became seven
  preloaded files); with it the first load is one file, 114.8 kb.
- **tests are not in `tsc -p app`.** the root `tsc -p .` checks them: a
  signature change that only a test calls breaks `just check` while the
  app's own check passes.
- **no scroll event follows a scroll that moves nothing.** a link that
  landed on the turn already at the top of the view left the stage's
  pin at its first value, pinned, so the next growth (a review's card
  arriving) was followed down to the end. rule: a programmatic scroll
  the stage makes tells it where it left the view (`pin.derive()`, or
  `pin.input()` before a scroll the reader's tap asked for).
- **webkit's scroll range disagrees with the layout under a container.** a
  size container (`container-type: inline-size`: layout and inline-size
  containment) at or above the scroller made ios safari snap the scroller back
  to a place about half a screen above its end, over and over, whenever
  the stage wrote `scrollTop = scrollHeight`: `scrollHeight` said 4,249, the
  native range ended at 3,282, and the scroll events of the snap read as the
  reader having left. a container on the scroller, on the thread or on the
  stage all did it; `container-type: normal` did not, and neither did dropping
  the mask, the overscroll behaviour, the animations or the sticky tape.
  chrome never does it. rule: nothing above the transcript is a container;
  ask its width with `measure.ts` (`data-clock`, `data-tight`, `--scroll-w`).
  a repro that needs no phone: boot an ios simulator, serve the stories
  (`bun run stories`), open `stage--live-steered` in its safari and read
  `data-gap` and `data-ended` on `.shell-story` (or add `&post=<url>` and have
  a listener keep them): both must be 0 once `data-played` is set.
- **a flag set from the last scroll event is stale the moment the content
  grows.** the stage kept `atBottom` from the last scroll event, and a scroll
  event that landed while the view was off the end (its own write's, arriving
  after the content grew; a clamp; webkit's snap) turned following off for
  good: nothing re-read it, and the resize observer only watched the
  transcript. rule: being pinned is a latch only the reader's own scroll
  clears (`pin.ts`); an event that follows the stage's own write or a change of
  size (in frames: 100 ms late is still the next frame on a janking page), or
  lands on a place the stage just wrote from (webkit gives back the old offset
  about four frames late when the dock grows under a write), is answered by
  putting the end back; any other non-reader event is read
  for where it left the view (find, focus, voiceover send no input), the echo
  of the stage's own write refreshes nothing, and a finger is the reader's from
  touchstart to touchend (a thumb that rests a second and then drags is not a
  browser snap). the scroller's own box is observed too.

## code blocks, the copy control and the first-load budget

- **the first-load script is 115.6 kb of its 120**, merged with main's review
  card and repo mark (main alone was 119.3; this lane alone was 111.0, from
  118.0 before it began and 119.8 when the code blocks landed, before the
  marks left). the highlighter (`highlight-engine.ts`, 28 kb) and what
  follows a copy (`copy-run.ts`) are chunks of their own, and the providers'
  marks left the script: 26 kb raw of svg path data (about 10 kb brotli) is
  one inline sprite in `index.html` now (`marks-sprite.ts`, a vite plugin,
  for the app and for ladle), 24.9 kb raw and 9.4 kb brotli. that is the
  same bytes moved, not saved: the script
  budget does not count them, and every launch still carries them (precached
  by the worker). a sprite in the document is the only way a mark is drawn in
  the first frame: a fetched sprite or a lazy chunk would pop in. so the
  document has a budget of its own, 12 kb brotli (9.8 now), which
  `scripts/compress.ts` prints beside the script total and fails over; do not
  spend the document's room on what the script budget turned away.
  brotli's size moves by 200 bytes between builds of nearly the same code
  (removing a branch once made the build larger), so a change is measured by
  building (`just build`, or `bunx vite build` in `app/` and `bun
  scripts/compress.ts`), never by counting what it added. rule: anything new
  that the first paint does not need goes behind a dynamic import or out of
  the script.
- **the copy must happen in the tap's own call.** ios allows the textarea
  way (`execCommand("copy")`, which is what plain http over a tailnet gets)
  only inside the tap's handler, and the async api's promise has a short
  life too, so `copyFrom` calls `copyText` before it awaits anything and
  `clipboard.ts` is in the first-load script. a lazy import in front of it (an
  earlier cut had one) loses the gesture on exactly the device the app is for.
  only what follows the copy waits for a chunk (`copy-run.ts`), which is
  fetched in the frame after the first control is made (the highlighter, on a
  quiet moment 1.5 s after the first surface paints), and a failed fetch
  leaves the outcome drawn on the control and reset by a timer. `copy.test.ts`
  holds the invariant: the clipboard is written before the call returns.
- **a failed dynamic import is not retried.** the browser keeps a module
  that failed to load as failed until the page loads again, so
  `loadHighlighter` makes one attempt and fences stay plain after it; a second
  `import()` would only fail the same way.
- **an agent's html can carry any class.** DOMPurify keeps `class` by
  default, and thread.css styles by class, so raw html in a reply could draw
  a `.copy-btn`, a `.cblock` or a `.thread` root. the sanitiser drops every
  class but marked's `language-ts` on a fence's code (`keepsClass`) and every
  data attribute; `--said-hostile-markup` in the stories' test holds it.
- **marked ends a fence's text with a newline of its own**, so what a copy
  reads is the block's text less exactly one trailing newline
  (`sourceOf`); highlighted code gets the same newline back after its
  spans, or the two shapes would copy differently.
- **a bed's mask is two masks.** the fade at a bed's edge and the notch the
  control sits in are intersected (`mask-composite: intersect`, and
  `-webkit-mask-composite: source-in` for older safari); a rule that sets
  one `mask-image` alone drops the other. the notch is a conic gradient
  centred on the notch's lower left corner, transparent in the quadrant
  above and right of it.
- **the copy controls' names are two kinds.** a command's and an output's
  are named after their row (`copy the output, run bun test, 54 passed`), whose
  name the register already tells apart and holds still; a reply is named by
  its turn's clock and prompt. only what still shares a name (the code blocks
  of one language) is counted, by `renameAll`, in document order over the
  controls the page holds, so those shift when a block appears above them. an
  earlier version counted every control from the turns' own labels and held
  still when a row opened; it cost more script than the budget had.
- **ladle answers "story not found" after a hot update that removed an
  export** (the log says "Could not Fast Refresh (export removed)"); every
  story is then missing until the server restarts. rule: restart the ladle
  you started, by the pid you noted.
- **a story that streams must wait for the highlighter**, or its first
  fence is painted twice and a count of replaced nodes says 1 (the repaint
  is right; it is not what the count is for). `CodeReplay` awaits it, and
  `shots.ts` fails the story unless `data-replaced` is `0` when it has played.

## reactive unit tests need solid's browser build (perf-stage)

- **`bun test` loads solid's server build**, where `createMemo` and
  `createSignal` do not react: a test of a memo boundary passes or fails for
  the wrong reason. tests that need reactivity are named `*.reactive.test.ts`,
  skip themselves when the build in use does not react, and run in their own
  pass, `bun test --conditions browser <file>`, which `just check` makes.
  they must not import `store.ts` or `sync/client.ts` (both touch `window`
  at load): keep the reactive logic in files that take accessors
  (`turns.ts`, `names.ts`), not in `live.ts`.
- **a store's array read by `slice` tracks its length**, so every turn memo
  would wake at every message that arrives; `createTurns` reads its slice by
  index. the same goes for any memo that should wake for one item of a list.
- **the dev server's vite port, 3002, is fixed** (`app/vite.config.ts`,
  `scripts/dev.ts`, `scripts/pinned.ts`, the generated `boxbox.dev.toml`):
  two worktrees cannot both run `just dev` whatever `BOXBOX_PORT` says. a
  lane that must run beside another changes the four to its own port, and
  puts them back before it commits.

## keeping the reader's place under a window (perf-stage, step 2)

- **a script's scroll write in a frame's callbacks is reported a frame later.**
  the scroll event of a write made in an animation frame callback comes in the
  next frame, but the resize observers run in this one, after layout. an
  observer that puts the view back against the anchor it took at the last
  scroll event undoes that write. `stage-window.ts` takes the anchor again when
  the view is not where the anchor was taken.
- **hold the box under the top of the view, not the box that holds it.** an
  empty box that fills changes its own height under the top of the view, and a
  block above the eye inside one turn changes the turn's. the anchor is the
  first turn with rows at or below the top and inside it the first box under
  it.
- **`offsetTop` rounds at each box, `getBoundingClientRect` does not.** a
  view kept by offsets drifts by a pixel after a few fills; read rects where
  the page is drawn at its own size and offsets while the layer a thread
  opens in arrives drawn smaller.
- **one window id for two runs of one script is one browser.** a bench that
  drives agent-browser names its session from the worktree it runs in, so the
  same `bench/window.ts` started twice from one worktree, or by two lanes,
  closes each other's chrome ("Inspector.detached target_closed", then "the
  cdp socket closed" some minutes in). run a copy from your own worktree.
- **editing a file the dev server serves reloads the page under a bench that
  is driving it.** a drift pass that finds every turn's box changed at once, and
  its line gone from the dom, was reloaded by a save, not broken.

## the fleet's maps and the contract 1 replay (m9 goldens)

- **a map's iteration order leaks wherever ties are not broken.** the same
  recorded inputs replayed three times gave `/api/needs` a different served
  order once: `Needs::serve_where` served the matching needs in `HashMap`
  order, and every `min_by` or `max_by` over a map picks among equal keys by
  that order too (eviction by `updated`, the oldest arm). the journal itself
  stayed byte for byte, so only a replay of the needs answers caught it. each
  such pick now breaks ties by id or key; a new one must too, or the
  contract 1 goldens flake.
- **a recording stream falls 512 kb behind while the bench is busy.** a bun
  `fetch` reader on the same event loop as the script that drives the
  session got closed for falling behind on order frames (a thousand threads
  make each one about 9 kb). the head comes from `/api/needs`'s
  `x-boxbox-seq`, and the journal is read once from cursor 0 at the end.

## a streamed body ignores the router's body limit (media, m9)

`DefaultBodyLimit` (the router's 64 KiB `SMALL_BODY`) is applied by the
extractors that buffer (`Bytes`, `String`, `Json`); a handler that takes
`axum::body::Body` and streams it gets every byte the client sends. the
media upload proved it in the real loop: a 63 MB body passed the 64 KiB
router limit untouched. a streaming route counts its own bytes and refuses
as they pass its cap (`media/receive.rs`), and refuses an announced
`content-length` before reading (`http/media.rs`).

an appended migration also breaks any schema test that asserts how many
migrations run from an older version; count them as `VERSION - n`, never a
literal (`store/schema.rs`).

## a raw json value inside a tagged or flattened shape (m9 seam)

`Box<RawValue>` deserializes only straight from serde_json's reader. inside
an internally tagged enum (`#[serde(tag = "type")]`) or a `#[serde(flatten)]`
struct, serde buffers the object first and a raw value then fails with
"invalid type: newtype struct". contract 2's `Part` hit it inside the
`part` change: its `Deserialize` reads a `serde_json::Value` and builds the
raw value from it (`wire/part.rs`), while the cmx2 source builds parts with
`Part::from_raw`, which keeps the daemon's bytes.

## voice notes in the browser

- **chromium's aac recorder refuses a low bitrate.** `new MediaRecorder(s, { mimeType: "audio/mp4;codecs=mp4a.40.2",
  audioBitsPerSecond: 32000 })` starts, hands one empty chunk and fires `error` (`EncodingError: Internal Error`) at
  once in chrome 151; 48 kbps and up record. opus in webm takes 32. the recorder picks its rate per kind
  (`recorder-model.ts`, `bitrateOf`).
- **a headless tab will not play without a gesture, even muted.** `audio.play()` on a `new Audio()` rejects with
  `NotAllowedError` in agent-browser's chrome whether or not the element is muted, and an `AudioContext` stays
  suspended. the screenshot run cannot click, so a story that shows a note playing plays the real player against a
  clock that keeps time as a media element does (`app/src/ui/assistant/stories/fake-audio.ts`); a story opened with
  `&aloud` in its url uses a real element, and the browser check drives it with agent-browser's real `click`.
- **a fake microphone needs launch flags on every call.** agent-browser launches a session's browser on the first
  command after it closed, and only with that call's `--args` (or `AGENT_BROWSER_ARGS`): pass
  `--use-fake-device-for-media-stream,--use-fake-ui-for-media-stream` in the environment of every command, or a
  relaunch silently comes back with no microphone and a permission prompt nobody answers.
- **`navigator.permissions.query({ name: "microphone" })` says nothing in safari and firefox** (it throws, or the name
  is unknown). the first press there is told from a recording one by a device flag (`boxbox.mic.granted`).

## a cleanup that reads the stage (home--home-first-leaves)

- **a view's cleanup reads nothing reactive.** when the thread on the stage leaves the fleet, the stage's `<Show>` lets
  its thread go and solid takes the turns down inside that update, while the stage's memos are still stale. a cleanup
  that read the thread's key (the ledger's cache key) threw solid's "stale value from <Show>"; one that read a prop
  backed by those memos (a turn's `live`, its `turn`, a window slot's id) ran them again, and they took the same turns
  down a second time (`cannot read properties of null` inside `cleanNode`). either error left home half torn down and
  the story never reported. a view reads what its cleanup needs when it is made (a cache key, a slot's id) or keeps it
  as last seen from a computation (`Ledger`, `seen`), and the cleanup reads only those.

## a drop target inside a drop target (fix-files)

- **a drag of files from outside the page ends with no `dragend`.** the composer is a drop target inside the thread's
  stage, which is one too; each counts the drag's enters and leaves. the composer used to stop the drop's propagation so
  it was taken once, and the stage, which had counted the enter, never heard the drop and stayed lit ("drop a photo..."
  under a draft that already held the files) until the next drag. the stage now hears the drop, sees it was taken
  (`defaultPrevented`) and only resets (`drop.ts`, `fileDrop`).
- **a browser's word for a file's kind is not to be trusted.** chrome calls a `.ts` file `video/mp2t`, and a markdown
  file is `text/markdown` on a mac and nothing on another system: the composer goes by the name's extension first
  (`files.ts`, `fileKind`).

## a sent photo flickering while the reply streams (stage--photo-above-live)

- **a turn's derived objects are rebuilt at every delta of its reply, and the person's message is in that turn.** the
  sent photos above the bubble were `photosOf(parts)` inside `turnsOf`, so every rebuild of the live turn handed the
  bubble a new array of new `Picture` objects, and the strip (`<For>` over `[{ pics }]`, keyed by object) took every
  thumbnail out and made a new img: a fresh load and decode of a data url of a phone photo's size, a blank box for a
  frame, at every delta. measured on the story over the heavy turn's first 12 messages (22.8 s): 267 imgs made and 243
  loaded before, 0 and 0 after; the turns above the live one lost no node either way (their memos never woke). the
  fix keeps the photos like any part, in the part memo under the message's id (`model.ts`, `photosIn`), and the strip
  lists its groups by place (`Index`) and only its thumbnails by picture, so a caller's fresh group object costs
  nothing. any value a turn builds from the person's message (or from a part that did not change) needs the same
  care, or a keyed list under it remounts at stream rate.

## a pin move can make an older daemon's frames undecodable (the system pin)

- **an event field cmx2 adds as required breaks every daemon older than it.** the move from 0bf2ba2 to abfde5b kept
  contract 7, yet `session.compacted` gained a required `cold` (cmx2 0.8.13); a 0.8.8 daemon sends the event without
  it, so each of its compactions would have been an undecodable frame and a red line on its card. the generator reads
  such a field as optional (`server/build/cmx2.rs`, `ADDED_SINCE_OLDEST`), and a test decodes the frame both ways
  (`cmx2.rs`, `an_older_daemons_compaction_without_cold_still_decodes`). on the next pin move, read the manifest's
  diff for a new field without `Type.Optional` on an existing event.
- **a new field on a host's status changes the fleet goldens.** `HostStatus` rides the fleet's journal, so a field
  serialized as `null` changes every replay golden byte for byte. a field that is absent until it is known
  (`system`, `reportsSystem`) is skipped while `None`.

## ladle in parallel lanes (the machines lane)

- **two vites share 3002.** `app/vite.config.ts` takes `BOXBOX_VITE_PORT`
  (3002 by default, what `just dev` and the bench's `[dev] vite` expect):
  a lane that runs its own vite beside another starts it on a port from its
  range and points a copy of `boxbox.dev.toml` under `/tmp` at it (the
  board app lane).
- **a killed agent-browser command can leave the tab flooded with keys.**
  after a few drive commands were killed by a shell timeout mid-run, the
  page's renderer sat at 90% of a core and every evaluation hung: pausing it
  through the devtools port showed trusted `keydown` events for `Minus`
  arriving without end. nothing in the app did it. rule: keep each drive
  command inside its timeout, and when evals hang, close the session
  (`agent-browser --session <name> close`) and open a fresh one.
- **under `bun test` a solid store merges a new object into the old one.**
  the tests load solid's server build, where `setState(path, obj)` (and a
  `produce` assignment) kept the old object and its fields: a pin set from
  `armed` to `paired` still carried `until`, and a second request for the
  same thread was the same object. rule: a store value whose identity or
  shape matters is reconciled (`reconcile(next)`) or carries a serial
  (`store.ts`, the board's requests).

- **two ladles share vite's hmr port.** ladle's vite opens its hot-reload socket on 24678 whatever `--port` says, so a
  second worktree's `shots` run fails while another lane's ladle is up. `LADLE_HMR_PORT=<port>` gives a run its own
  (`app/.ladle/vite.config.ts`), from the lane's port range.

## the foot room left a pinned reader a screen of nothing (fix-blank)

- **room kept for what the reader no longer sees is a blank stage.** the foot room (`foot.ts`) kept whatever the
  transcript gave back above its end while a turn played, up to the whole view. a working thread whose newest step is a
  read shows its body open, most of a screen, and the body closes to its opening lines once the step ends: the foot kept
  680 px of a 712 px view, the end was followed into the room, and the stage showed its condensed bar over nothing until
  the person scrolled (`stage--open-live`, 106 blank frames at the phone's width and 107 at the ipad's in the second
  after the thread opened). the check of `stage--foot-room` counted only the turn moving down, so it passed through the
  blank. the room now keeps the box at the top of the view still and no more (`seenAt`, `roseSince`): what is given
  back above the view (a fill shorter than its guess) is followed, a box under the top that lost what the reader saw of
  it lets the room go, and the room never takes more than half the view. nothing is kept until the stage has seen the
  end on screen, so a thread opening at its top does not bank room before it lands at the end.
- **a pinned view's scroll event can come after a change and before its resize report.** a script's layout read
  after a patch clamps the scroll, and its event is dispatched in the next frame's scroll steps, ahead of the resize
  observer. what is at the top of the view is read in the resize report (where the view will be once the end is
  followed, from that layout, since the room and the scroll move no box) and at the reader's own scrolls, never at a
  pinned view's other scroll events, or the "before" is read from the layout after.
- **measure the blank, not a proxy.** both checks now count frames a pinned stage shows next to none of its thread
  under its bar (`data-empties`, `data-blank`), and the foot-room story's drop is of the first box whose top was in
  view, which is what the reader sees move (with no foot room at all it still counts 10 drops).

## a quiet window cost a fifth of a core (the perf lane)

- **session entries reach the ui's store leaf by leaf.** `state.fleet.sessions[key]`
  and its unchanged parts keep their identity across ticks, so an effect has to read
  the field that changes; one that read only the session object, or a status, ran
  on every tick before and now runs only when that field moves (`home.tsx`'s
  streaming label was one). a changed array item (a tail line, a need) is always a
  new object, never changed in place.
- **indexeddb v4 marks what to write from patch paths.** the fleet is a record per
  entry plus an index of key order, and a thread's last message is a page of its own;
  a patch path is what marks a record, so a new patch shape must still start with
  `fleet/<map>/<key>` or `threads/<key>/messages/<n>`, or its change never reaches disk.
- **two pages write one database.** a second tab, or a reload overlapping the old page's
  last save, writes between this page's saves; what a page remembers of the layout
  (page starts, the key index) is only good while it wrote last. each save reads the
  meta record (writer id and a counter) in its own transaction and rewrites whole
  after another writer.
- **an html block left open in a reply runs into everything after it.** a streaming
  unit after raw html is never cut, and a link definition anywhere makes the piece one
  unit, since either can change what earlier text means. the cut rules follow marked
  18's list, quote and fence rules: a marked upgrade reruns `markdown-stream.test.ts`
  and the `said-streaming-equivalence` story before it lands.
- **the caret is recreated on every paint on purpose.** its blink restarts with each
  new node, which keeps it lit while words flow; a kept caret blinks mid stream.
- **a hidden layer's glass goes after its fade, not with it.** the ruler, the jump and
  the menu step `backdrop-filter` to none after `--leave-ms`; webkit steps both the
  prefixed and unprefixed property at the delay (checked in a wkwebview), so a new
  fading glass layer follows the same pattern rather than `visibility`, which would
  change focus and the accessibility tree.
- **a scratch script under /tmp that imports app code gets a second solid-js.** it
  resolves solid from its own directory, and reactivity silently breaks between the
  two copies (memos never rerun). symlink `app/node_modules` next to the script.
- **a clock that stops while hidden must not stop logic that names a moment.** home's
  12 hour rule (it drives the order and the `windowsInView` presence post) and the
  composer's offline word keep their own wakes while hidden, re-checked at least
  every 60 s since timers pause through a system sleep.
- **a head rewritten on every save must stay small.** v4's thread head carried the
  thread's baseline, a number per part, and cost more than the growing message itself
  (10.8 of 13.98 mb over a 24 kb answer); v5 keeps it in `<key>#base`, written when it
  changes. chunks of appended text are only good in the order they were appended: a
  failed save's marks stay ahead of the ones made while it was in flight.
- **solid sets a single dynamic attribute again whenever its effect runs, equal or
  not.** a name built from a view, a facts object or a list that is new every frame
  re-set `aria-label` on every window 2,150 times a second; such a value reads through
  a memo, which compares before it writes. the `writes--` stories count same-value
  writes and fail on any.
- **work started by a click lands inside the transition it starts.** filling turns
  the frame after a thread opened, and on every frame after it, ran inside the pour and
  dropped about three of its frames; work the eye cannot see yet waits for
  `whenLanded` (`motion/animate.ts`). turns made with their real heights above the
  view move the scroller's sub-pixel phase, so the turn in view can sit a px off until
  the rest are made.
- **a second `register('/sw.js')` is not free.** push registered the worker again on every
  launch beside the shell's call; the page now holds one registration promise
  (`shell/worker.ts`) and push awaits it. openapi-fetch captures `fetch` when its client is
  made, so tests stub `api.GET` and `api.POST`, not `globalThis.fetch`.
- **a hidden page's held posts land as one message, patches before the last status.** the
  worker holds its posts while the page is hidden and releases them together; a status
  landing ahead of its patches, or any timer between them, races the caught-up second (the
  1 s hidden queue that was reverted did exactly that; `wire.test.ts` now catches it).
- **a frame asked for from inside a frame is the one after.** perf.thread asked for a frame
  from its first-paint effect; when the rows came from the landing, which writes the store
  inside a frame's callbacks, that frame was already the one painting them, so every reopen
  since a5298d1 read a frame late. time what a change paints by whether it was made inside a
  frame (`landingInFrame`), not by asking for another.
- **a press is not an open.** a thread a press shows ahead of its click (`pressThread`) is let
  go with `press` when no open followed, and the worker puts it back where it was among the
  closed: stamped as closed now, a press on a window would push a thread the person did read
  out of the three kept warm. touch presses take nothing: a finger on a window starts a swipe
  through the deck as often as a tap.
- **cool a thread only when nothing of it is marked or being saved.** a cooled thread comes
  back from its indexeddb pages, so a mark or a save in flight would come back without it.
- **with reqwest's gzip feature on, a client decodes bodies and drops the header.** a test that
  checks `content-encoding` builds its client with `.no_gzip()`, and so do the release
  downloads, whose checksum is over the compressed bytes.
- **the bench tape was recorded at 200 ms tails.** `Replay::at_recorded_pace` is the only fair
  comparison with the live recording now that the overview runs at 500 ms.
- **the stream's 512 kb bound counts plain frames in the actor's queue.** once batched and
  gzipped, hyper and the kernel hold more behind it (about 155 kb of compressed bytes, 4.3 mb of
  frames, for a client that never reads), so a stalled client is cut later in frames but still
  bounded in memory.
- **anything that takes controls out of a turn leaves `[data-copy-held]` marks.** copy names
  the controls below it by position (copy-run.ts renameAll), so a far turn's stand-in that
  dropped its copy buttons without the marks shifted every copy name under it.
- **tower-http compression polls a body after it has ended.** a streamed body built with
  `stream::unfold` must be fused, or the whole-thread read panics once it goes through gzip.
- **a frame asked for from inside a frame is the one after.** an effect that runs in a
  requestAnimationFrame callback and asks for another to time its paint measures one frame
  late; perf.thread counts the frame the rows paint in.
- **a press is not an open.** a pointerdown may start loading what a click would open, but
  holds it at most 1.5 s and one at a time; touch presses are left out, since a finger on a
  window often starts a swipe.
- **on the protocol 3 stream a skipped seq is a filtered entry, never a gap.** the cursor
  rule follows the newest seq seen; a real gap shows as a reset or a protocol error, which
  drops the cursor.
- **a catch-up's entries are gated by the read alone.** the server compacts a message to its
  last info ahead of its parts, so a thread-wide upstream gate refused the parts as
  duplicates; live entries keep the thread-wide gate.
- **seqs are never compared across epochs.** a restarted server starts its head again, and a
  thread's entry seq kept from the old epoch made a read look late and re-read in a loop.
- **the whole read's etag must not share the paged query's hash.** with no query the hash
  normalised to 8 turns and tagged the whole thread like `?turns=8`.
- **the board trace proxy inflates gzip** to record frames; replays reach the daemon's own
  inflater only because the proxy passes the gzip through untouched.
- **reqwest strips content-encoding once it decodes.** the watcher cannot see whether a cmx2
  daemon gzipped its stream; test with `.no_gzip()` when the header matters.
- **migration 11 cannot be rolled back in place without losing the saved stream state.** the
  lossless way back is in docs/deploy.md: drop the four tables, set user_version 10, then the
  old binary.
- **a compact replay can carry a session info ahead of the event that moved its revision.**
  judge transcript revisions only once the replay is caught up, or every busy thread resets
  after a restart.
- **a restored count must count what it restores.** `StreamKeys::restore_thread` put the
  thread's newest-turn ids back without adding them to the fleet-wide `turn_ids`, so the
  first removal or reset after a crash restart subtracted ids never counted: a debug build
  panicked in the fleet actor (every write then answered `stopping`), a release build wrapped.
  found by the btw live run against a fresh daemon; `fleet/keys.rs` has the test.
- **a new cmx2 capability fails the two-wire test.** `two-wire-main.json.gz` holds main's
  fleet made neutral by `translate::agent` as it stood when it was recorded, while the
  replayed goldens carry today's capabilities. lay the new capability onto the recording in
  `ADDED_SINCE_RECORDING` (`app/src/sync/two-wire.test.ts`); never edit the recording.

## a new capability moves every recording that holds an agent (fork-threads)

adding `fork` to `Capabilities::cmx2()` changed every protocol 3 golden under
`server/goldens/protocol3/` (the agent frame carries the capabilities whole),
the converter's recording `app/src/ui/home/fixtures/journal-p3.ndjson` (its
`CMX2_CAPABILITIES` mirrors the server's) and the two-wire test, which lays it
onto the recorded agent (`ADDED_SINCE_RECORDING`, below; the recording itself
is never edited). write the goldens with `BOXBOX_GOLDENS=write cargo test protocol3_goldens`
and diff the old and new bytes decompressed before committing: the only
difference should be the new field. an unknown field in a verb's body (every
body is `deny_unknown_fields`) answers 422 in axum's plain words, not the json
error body, so a drive that parses every answer as json throws there.

a parallel lane took 4840 and 4841 a moment before this one (the btw lane's
`just cmx2`): the bench model failed to bind, and the bench dir still named
4840, so the drive and the dev server reached the other lane's daemon with
this lane's password (401s, nothing done). check `lsof` on the decade first,
and take another: `bun scripts/cmx2.ts --port 4846 --boxbox-port 3061` with
`target/debug/boxbox serve --config .cmx2/bench/boxbox.toml` (vite's 3002 is
fixed in `scripts/dev.ts`, so two lanes cannot both run `just dev`).

## two branches under the script budget alone can be over it together (fork-threads + btw)

fork-threads and btw each passed every check, and each one's first load was under the 120 kb script budget on its own.
merged, the first load was 122.2 kb. the only place it showed was the release build's compress gate
(`bun scripts/compress.ts` after `cd app && bunx vite build`); `just check` does not build the app. when merging
branches that add first-load code, run the build and the compress line on the merge. the fix moved what is not needed
for the first paint into chunks (the btw card, marker and placement, the fork lineage line, divider and menu item, the
fork verb, the btw send checks, the queue's strip), down to 118.5 kb.
