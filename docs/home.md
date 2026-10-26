# home

home is the live windows (decision 12; `design.md`, the model: windows).
this file says how it is built, what it decided where the law is silent,
how it is verified, and what it still waits on. it extends `design.md` and
is binding the same way (AGENTS.md, design law).

## where it lives

| path | what |
|---|---|
| `app/src/motion/` | the motion law as code: the two springs sampled into `linear()` curves, the short curves, and `play`/`flip`/`sweep`, the only way anything animates a transition; what animates per word or per batch is a css animation on a curve's property (`.settle-in` on `--settle-t`), since webkit keeps every finished web animation alive (gotchas.md, home) |
| `app/src/ui/window/` | one window: the repo colours (`repo.ts`), the tail's grammar (`tail.ts`), the window's view of a session (`view.ts`), the component and its stylesheet |
| `app/src/ui/home/` | home: membership (`membership.ts`, each thread's standing a memo of its own so a frame or a second costs what changed), each window's view as a memo of its own (`views.ts`), the arrangements, the order and its calm, the stage and its motion (`home.tsx`, `stage.tsx`), the folds at the rail and the strip (the fold and its swatches `fold.tsx`, `swatch.ts`, the windows toggle's words `windows.ts`; the stage card's edge moving `edge.ts`, `glide.ts`; the choice kept on the device `remembered.ts`), the budgets (`perf.ts`), the fixtures and the stories |
| `app/src/board/` | the board's digits on home (`docs/board.md`, the app): the first load's foothold (`lazy.ts`: the lazy pieces and the words a name carries), and the chunk fetched on the first board frame (`board.tsx`, `board.css`: the key on a window and a swatch, the pairing item and the stage's line; `pin.ts`: arming a pairing), with its stories |
| `bench/windows.ts` | the windows world: five threads across two repos on a real daemon, for the fixture capture and the budget run |
| `bench/home.ts` | the budget run |

## how it is built

- **facts come from the server** (decision 16). the fleet model decides
  status, asks, the window tail and the window order; home renders them.
  home decides only membership (the law's rule: working, wants you, parked,
  queued, or touched in the last 12 hours; subagents never get a window)
  and how a state reads: chip, clock, footer, accessible name.
- **a window is an article with one stretched button**, its title, whose
  hit area covers the window. the ask's tray is a button of its
  own, so nothing nests a button in a button, and every control has a
  unique name ("ledger: set the greeting in the notes. wants you", "answer
  ledger: which greeting should the notes use?").
- **each window's view is reconciled by line id**, so a streamed change
  updates one text node and a tail line keeps its element while it lives.
- **motion is honest.** a window animates only while it is in view (an
  intersection observer, 35% showing), the stream is live and has been for
  a second (the replay after a connect lands in that second), the page is
  visible, and the stream is not offline. everything else paints in place.
  reduced motion makes springs instant, keeps a 120 ms fade for content
  swaps and turns the word fade and the sweep off, in `play` itself.
- **the calm laws.** a reorder waits while a finger is down and lands 1 s
  after the last release or scroll, on the snap spring (flip, measured
  once); on the deck the window in view keeps its place. a question that
  jumps the deck while you look at another window lights the edge and
  names itself in the top line; after 4 s without input the deck glides to
  it. with a thread open on the phone, the capsule slides down for 6 s and
  swaps the stage when tapped.
- **the transitions.** deck: the window grows into the stage by clip-path
  from its own rect and radius, its colour floods the ground, the rest
  recede; back shrinks it into its window, from the button, `esc`, the left
  edge or pulling the header down (the gesture follows the finger, can be
  abandoned, and releases on progress over 28% or a flick). strip and rail:
  the thread pours out of its window onto the stage and the old layer
  fades back. an asking window never grows, so the stage never moves for
  an ask (`design.md`, one layout law). a
  thread opened from outside (a relaunch restoring the url, a push tap)
  paints in place.
- **home's controls are liquid glass, its windows are not** (the native
  app's decision 22). the bar's pills and rounds (new thread, clear N,
  history, machines, the windows toggle), the fold's new-thread
  disc, rounds and toggle, the dock, the capsule, the working fold's
  capsule and the undo toast float over the windows
  as the stage bar's rounds float over the log, so they are one family:
  regular glass from `styles.css` (`.lg`'s tokens; `.home .pill` is
  `all: unset` and reads them). the folded column's disc is the glass
  tinted with the ink, the dock the glass tinted 50% (dark) or 60% (light)
  with its repo's window material, its plus disc still the accent; the
  capsule tinted 70% with the asking window's. a press swells the glass and
  lights it under the finger. windows, swatches, the sheet, the stage's
  card, the docked details and every chip inside a window keep their solid
  materials, and so does the reload screen's one act. reduced
  transparency, or a browser without backdrop-filter, gives every glass
  control the solid fill in the same shape (the tinted ones keep their
  tint over it), and a press dims it instead. the story
  `home / home glass controls` lays them over live windows beside the solid
  fallback.
- **an agent's thread opens as a layer over its parent's**, even when
  the fleet does not hold the agent's session (a spawn-only agent, or one
  older than its host's newest threads): the layer draws the parent's repo
  and colour under the agent's key, named by the row that opened it (its
  session id when the row gave none), with none of the parent's state
  (`strayView`, layers.ts, as the native app's `ThreadAgentStack.introduce`),
  and the stage is told its parent (`parent`) and that name and repo
  (`fallback`), so its title block names the agent and its parent's repo,
  its back returns there, and it says the thread is not followed live. the
  stage's doors (the agent row's, the details' agents) hand home the row's
  name. `home / home spawn only agent` opens one through its door (its
  shots' craft check flags the parent's open rows under the layer, 7.7 px
  from their left edge, the thread's own padding). the effect that lets go of a
  thread that left the fleet leaves it alone, and it is forgotten once its
  layer is gone.
- **the first frame is the cache.** the first windows (from the worker's
  indexeddb boot, or the first snapshot) paint at once, with no reorder
  wait and no motion.

## decided here, where the law is silent

- **the chip is 34 px tall** (2026-10-01): one line of 12.5 px
  boxbox sans is an 18 px text box, and 34 px keeps the craft check's
  8 px inset above and below it. a 26 px chip could not.
  the window's head holds those 34 px whether or not a chip shows: at
  26 px a chip arriving as a thread started working moved the title 8 px
  and, in the rail, every window below it (perf.shift, found by the
  shell drive's ask in a window).

- **the six hues the law left open**, each proven by `repo.test.ts` to
  hold 4.5:1 for body text at both ends of the gradient, for the light tone
  on the top colour and for the bottom colour on the light tone:
  blue `#004077`/`#071938`/`#9fd0ff`, teal `#00484b`/`#002025`/`#7ee2db`,
  sunset `#761521`/`#300936`/`#ffbc91`, plum `#512977`/`#1e0e33`/`#daaafd`,
  magenta `#700159`/`#2e0628`/`#ffa4e9`, slate `#334052`/`#131822`/`#b8c9de`
  (retuned 2026-10-19, design.md: colour; sunset and magenta took clay's
  and olive's slots).
  a repo's hue is the one the server gave it (decision 82), fnv-1a of
  `host:projectRoot` modulo ten only until the server has named it.
- **the springs as sampled.** snap settles in 467 ms and sheet in 508 ms to
  the springs' own rest threshold; the law's "about 420" and "about 560"
  are rounded from the same constants.
- **the tick draws by clip**, left to right, since the law allows only
  transform, opacity, clip-path and filter to animate. **streamed words fade in by opacity**
  alone (no blur since 2026-10-21; a new tail line rises 8 px as it fades, with no blur either): they are inline so they wrap with the prose, and transform does
  not apply to inline boxes.
- **the bar's line is one phrase** ("ledger wants you, 2 working, 1
  done"): where the bar is narrow it wraps between its parts, each part
  keeping its words and its comma, so no line starts with punctuation and
  nothing is cut. a part longer than the whole line (a long repo name)
  wraps inside itself, at its spaces first, and never runs out of the line
  under a pill; the comma after "wants you" is drawn inside its button,
  out of the button's name, so it can never be left alone on a line. on
  the deck and the rail the line has its own row under the wordmark and
  the pills, the width of the bar: on a phone the wordmark and "machines"
  leave it too little room beside them (2026-10-01, a long repo name ran
  under the pill on the installed unit). `home-shots.ts` fails a story
  whose line leaves its box or comes within 6 px of a pill, and the "home
  long repo name" story holds a 46 character repo name at every width.
- **"update ready" sits in the bar's line** ("update ready. it applies the
  next time boxbox opens.") until settings exist (m7); the protocol break
  is the one screen with the one button.
- **the bar's pills** (2026-10-01): what you do, then where you go. "new
  thread" (with `aria-keyshortcuts` Meta+N) and "clear N" are one group;
  "history" and "machines" the other. "machines" is a mark (two stacked
  boxes) in the pill's own material, its name kept for a screen reader and
  the drive.
  every arrangement has the new thread entry, because the one it had was the
  phone's dock alone, and a repo or folder with no threads has no window to
  start from. on the rail the bar is three rows by rule at any count (the
  wordmark with where you go, then what you do, then the line), because
  four pills and a wordmark do not fit one row at 390 with a two digit
  "clear 23", and a pill that wraps by chance is left alone on a row at
  some count or other (the first reviewer's "machines" alone on the rail).
  the phone's deck is two rows (the native app's stripchevron): the
  wordmark with three round glass marks (history as a clock, machines, new
  thread as a plus, each with its name), then the line with "clear N" at
  its end; the line's flex basis is too wide to share the first row, so it
  always starts the second, and it wraps inside its own box before the
  clear pill gives up its word. the strip has the width for one row. `home--home-crowded-bar` holds
  24 done and "3 want you" at every width, and `home-shots.ts` fails a pill
  that leaves its group's row or the screen.
- **the deck's page dots may not widen the deck.** two dozen windows made
  the dots wider than a phone, the single `auto` column grew to them, and
  the bar's pills ran off the screen; the column is `minmax(0, 1fr)` and the
  dots shrink and clip.
- **the dock and the sheet follow the window in view** on the deck
  (`startPlace`: the open thread, else the window the pager is on, else the
  newest), by the repo root of its project, so their colour matches its
  window. only the dock's props change when you scroll; nothing mounts. the
  dock is a real button (the old one was a read-only mock of the composer).
- **a thread the fleet does not hold never opens** (`stage-open.ts`): a
  `?thread=` for a thread that is gone, or a tap on one that just left,
  clears the url instead of leaving the deck inert under an empty stage.
  `growFrom` and `shrink` release their busy flag in a `finally`.
- **the stage never empties by opening a thread the fleet does not hold**
  (2026-10-02, the second reviewer). `order()` trails the fleet by the calm,
  so after the first thread was archived its key was still `order()[0]`: the
  "never empties" effect poured it, the effect that lets go of a departed
  thread released it, and the two chased each other synchronously, a layer
  per lap (8 to 14 s of long tasks, 3,448 presence posts, an empty stage).
  now the effect pours the first key the fleet holds, `pour`, `growFrom` and
  `swap` refuse a key it does not hold (the rule of `openVerdict`), and
  `applyOrder` closes the hole of a window the fleet no longer holds at
  once. presence reports are one in flight with the latest next
  (`push/latest.ts`), so a burst is the first and the last. `home--home-
  first-leaves` holds the real effects: it takes the stage's thread out of
  the fleet and fails on more than one layer, three url writes, a 200 ms
  task or a stage on a thread the fleet does not hold; it overflowed the
  stack on the old effects.
- **the deck is inert only under a layer that renders** (`staged()`: the
  open thread has a layer and a view), not under `open()` alone. after a
  reconnect, when the open thread had left while the stream was down, the
  bar, the windows and the dock were inert for about a second until
  `caughtUp` (measured 1,009 ms), under nothing.
- **a thread started from the sheet opens like a tap** (`openBorn`): the
  stage grows from the sheet's window; if a transition refuses, it opens in
  place.
- **a cleared window closes its hole at once.** when every key leaving the
  order is one the person just cleared (`handCleared`) and none is born,
  the calm wait is skipped; the flip closes the others up.
- **the machines are one pill away** in the bar ("machines"), with "‹
  windows" to come back, so the terminal (m7) stays reachable now that home
  replaced m2's list.
- **a window previews its ask and never answers it (2026-10-05).** the
  window that held the whole card made the card jank when it expanded, and
  on a phone it forced a sideways scroll because the question card did not
  fit the screen. a window keeps its
  resting size in the deck, the strip and the rail, and shows the ask's
  need in its accent tray (design.md, the inbox in the windows; clamped to
  two lines on the strip and the rail, six on the deck). the tray opens the
  answer sheet over home (`asks/sheet.tsx`, `askSheet` in home.tsx: a
  sheet on the deck, a popover from the window on the strip and the rail,
  home inert under it); a tap on the window and the sheet's "open the
  thread" open the thread with the ask in front: home sets `state.focus`
  (`askFirst`, the same path a push tap takes) and activates the window; the stage goes to the ask's row and
  focuses its card (`thread/stage.tsx`, `goToAsk`). the strip's room
  machinery (a taller row, a clip, the stage moved down by transform) and
  the window's own option buttons are gone; `ui/asks/` keeps the words
  (`words.ts`) and the composer's typed answer (`answer.ts`).
- **your prompt in a window** is a bubble (`.me`): on the
  right, up to 88% wide, wrapped on the deck and one line with an ellipsis
  on the strip and the rail. **when a third sentence pushes the first out**
  of the agent's prose while words arrive, what stays keeps its place and
  only the new words settle (`growth` in `tail.ts`).
- **the earned moment** fires when a command whose words name tests
  (`test`, `spec`, `vitest`, `jest`, `pytest`) goes from running to done in
  a window you are looking at: one sweep, the chip lit with "tests passed"
  and its tick, until the window's state changes.

## the folds at the rail and the strip (2026-10-02, the strip 2026-10-16)

design.md (the inspector and the folds) is the law; how it is built:

- **the layout.** at the rail the stage card spans the whole grid and
  takes `margin: 14px var(--stage-right) 14px var(--stage-left)`;
  `--stage-left` is 318 open, 76 folded or 14 with the windows away, `--stage-right` 330 with the
  inspector shown or 14 folded. the inspector is an absolute 330 px column
  under the card; the folded column sits above it. stacking: inspector 3,
  card 7, folded column 8 (its hover card must clear the stage).
- **the card's shadow and rim** are their own elements (`.lift` under the
  card, `.rim` on it), so a fold can move them with the edge: the shadow
  scales from the edge that stays, and the rim is a rigid corner cap that
  travels with the edge plus a clipped ring, so the 30 px corners never
  turn into ellipses mid-move. with no thread on stage both hide, so a
  first run shows no hollow outline.
- **the move** (`edge.ts`): the inner boxes of the card (12 levels deep,
  only those inside it) are measured in the layout they start in and the
  one they end in, by committing the end layout and putting it back before
  anything paints (`glide.ts` decides which boxes to carry: rows hung
  from both edges are carried per cell); content is carried by translate,
  a pure paint box (the flood) is scaled. a card that grows commits first;
  one that shrinks commits in the frame its transforms end, which paints
  exactly the frame before. a move is never started on another, and a
  resize across an arrangement or the 1400 line stops it and rebuilds the
  layout from the choice.
- **the strip folds too** (the native app's stripux and stripchevron): its
  row and bar give way to one bar as tall as the open bar (`--strip-bar`,
  64 px, 74 on a touch screen) holding the new-thread disc, a swatch per
  window scrolling across, history and machines, and the toggle at its end,
  exactly where the open bar's toggle sits, so a fold and an unfold land on
  one spot. folded, the card spans the grid from under that bar
  (`data-strip`), and the open bar and row stay laid out beneath it, so the
  fold only covers and uncovers them. the move is the card's top edge
  (`edge.ts`, `moveTop`): the width never changes, so nothing reflows;
  what hangs from the top (the stage's bar and what is pinned to it) is
  carried, what stands on the foot (the composer) stays, and the scroller
  keeps the words being read where they are by moving its scroll by the
  room it gained or lost (one at its end is left to its pin). the scroller
  is cut at the travelling bar's foot while it moves, since its dissolve
  is its own mask and stays behind. `boxbox.strip` (open, folded) keeps
  the choice; `[` is the toggle at the strip as at the rail.
- **one windows toggle, in the layout's glyph** (the native app's
  `HomeWindowsToggle`): a band across the top on the strip, the sidebar on
  the rail, its pane filled while the windows are open; named for what a
  tap does ("fold the windows" on the strip, "hide the windows" on the
  rail, "show the windows" folded or away; windows.ts), its state in
  `aria-expanded`. one is on the screen at a time (the open bar's, or the
  fold's, the other inert; while the windows are away, a `round` at the
  start of the stage's bar, passed as the layer's `barStart`).
- **focus** (`data-windows`, `boxbox.focus`, `⇧⌘F`): the rail's open
  toggle puts the windows away, so the rail folds only for the details
  (above). the card takes the screen 14 px in; its edge on the windows'
  side moves (`moving` is `windows`: left at the rail, top at the strip)
  over the open windows or the fold, whichever showed; the details beside
  the column get the width (`detailsPlace`'s `hidden`), and details that
  would not fit beside the windows coming back close. a tap on the fold's ground, between its
  swatches and buttons, unfolds it: folded is never a dead end.
- **the details give way to the column** (the native app's ipadfit,
  `windows.ts` `detailsPlace`): below the inspector's width the stage's
  panel docks only where the column beside it keeps 704 px; home answers
  for the top layer through `DetailsRoom` (`thread/inspector.ts`). at the
  rail from 1136 to 1377 wide the open rail folds to its swatches while
  the details are open (the person's choice stays as it was) and opens
  when they close; the folded rail's toggle, `[` or a tap on its ground
  close them. under 1136, and on a portrait ipad's strip, they are a sheet
  no wider than 560 px. story `home--home-details-by-width` (shot by hand
  at 1180 by 820 too, where the rail folds).
- **the swatches join the order's flip**, so a reorder moves them on the
  snap spring as it moves windows; folded windows are out of view, so none
  of their tails count as watched.
- **the stories** carry a `memory` per story (`Home`'s prop), so one
  story's fold never leaks into the next: `home--home-windows-hidden`,
  `-inspector-folded`, `-windows-hidden-inspector-folded`,
  `-inspector-turns`, `-empty`,
  `-strip-folded` (the folded strip at the ipad width).

## the board's digits (2026-10-18)

how the board's keys on home are built; how they look and move is
`design.md`, the board.

- **nothing until a board.** the store's `board` slice is all a device
  without a board ever holds: `here` false, no digits. the window, the
  swatch and the stage mount the board's pieces only once `board.met` (a
  board has been here since the page opened), and those pieces are a chunk
  of their own (`board/board.tsx`), fetched by that first mount and left
  out of the service worker's precache. once a board has been here they
  stay mounted, so a key can leave by motion when the board goes.
- **the store owns the digits.** each `board.here` replaces the digits
  and the paired keys whole; `board.gone`, and the end of a stream that
  carried a board, clear them. a key reads its window's digit from the
  store and keeps only the face it is showing while it leaves; it marks
  its window (`data-board`, seated or leaving) for the chip's and the
  name's room, and unmarks it when it goes.
- **requests are taken once.** a focus or a compose is a request in the
  store with a serial of its own (a second press of the same key is a new
  request). the rules are `board/requests.ts`, pure and tested: which
  requests the app can take, what a focus does with a sheet over home,
  and which host a machine light composes on. the shell drops one it
  cannot take, or any while a terminal holds the keyboard, and brings home
  up for the rest; whichever home is up takes it, clears it, and acts a
  frame later, once its windows are drawn: `activate(key, originOf(key),
  null)`, the tap's own path, then the caret, only when the thread is on
  the stage and no sheet holds words. a screen coming back hands a
  keyboard's focus to the control that went in a moment later
  (`app/src/shell`); for the first frames that hand-off is undone.
- **pairing settles on the wire's word.** an armed pin settles on a
  `board.here` whose seat for its thread turns paired (`Seat.bound`),
  at the digit it sat on or another, or whose paired seat moves to another
  digit; never on an unpaired seat by order (an unpaired thread often sits
  on a digit already) nor on the paired key it already had. the stage's line owns each phase's timer.

## clearing and history

what decides a window's membership now has one more input: the server's
clear mark (`entry.cleared`). `windowKeys` skips a cleared entry; a
thread that works again, asks, or updates past its mark loses the mark
on the server and the next frame brings the window back, born where the
order puts it. details and the words are in `design.md`, clearing a
window, and history.

- **clear exit then order.** `clear.tsx` plays the window's exit
  (fade curve, `fill: forwards`), awaits it, then POSTs `/api/clear`.
  a refusal cancels the exit and shows the server's reason in a line
  under the window. `handCleared` (`clearing.ts`) marks the key so
  `applyOrder` removes it without the calm wait and the others flip
  into the hole.
- **a thread that works through its agents is not cleared** (the merge with
  the subagents lane): a thread whose agents are at work reads working,
  whatever the daemon calls its own turn, and clearing follows it in both
  places. the window offers no clear while its state reads working (so
  "parked" there means parked on background jobs alone, which can still be
  cleared), and `clear_one` refuses an idle status that is parked with
  agents under it as `Working` (`Activity::Parked.agents`), so a stale tab
  or a script cannot hide it either. a refused clear's line and the note
  "its agent is at work; its report wakes it" can both stand on a window;
  the line goes when the state changes, through the same state memo as the
  earned chip (the clock tick no longer takes either away).
- **clear done** takes at most the 300 keys the order holds. measured on
  the scratch fleet: 299 windows in 264 ms, the server log says
  `cleared=299 refused=0 source="done"`.
- **history** reads the server, not the store: a row of a thread the
  fleet holds shows its live state; one it does not hold (past the cap)
  is adopted by the server (`POST .../adopt`, which reads the session
  from its daemon and upserts it into the fleet) before the thread route
  opens, because home draws a layer only for a thread the fleet holds.
  an archived thread is a 404 `no-such-session` at once, not a wait.
- **adopted threads are kept, and capped.** at most 20 (`MAX_ADOPTED`),
  the oldest idle one going when another comes in, never one a device has
  on its stage, one that works, or one that asks. a host read (a
  reconnect, a new epoch) rebuilds from the daemon's newest 300, so the
  model carries its adopted threads across it, and a restart holds them
  again at their host's first read from the `adopted` table. after a start
  each one is asked of its daemon once (`confirm_adopted`): one archived or
  deleted while boxbox was down is dropped, and a live one is refreshed (a
  rename made meanwhile shows). the session cap (1000) never drops an
  adopted thread or one a device has on its stage. driven at 1512 on the
  scratch daemon (345 sessions, 300 held): 3 adopted, a boxbox restart,
  303 held; 22 more adopted, 320 held and 20 rows in the table; one adopted
  thread archived at the daemon with boxbox stopped was gone after the
  restart and its row deleted (20 rows to 19).
- **clearing serves the thread's done and fault needs** directly, so a
  thread that finished before boxbox started (no newest message to be seen
  through) empties its badge too, and a cleared thread ranks last whatever
  need it still holds (a review waits on its merge). driven: finish a
  thread, restart boxbox, clear it: its done need open and it leading
  before (order index 0), no open need and out of the order after.
- **cleared threads rank last in the order** (`reorder`, rank 6), so past
  the order's 300 a cleared window never pushes an uncleared one off:
  with 320 held, clearing the 5 newest took them out of the order and
  brought 5 older ones in.
- **the sweep is a timer on the fleet task, not a scan per event**
  (`Actor::sweep`, `Model::sweep`, decision 93): a minute after the start,
  then every 5 minutes, it walks the home windows by the board's own
  membership rule (`is_home_window`: not a subagent, not cleared, active or
  touched in the last 12 hours), at most 300, so a first sweep after an
  upgrade looks at what home shows and never at the hundreds of older
  threads a machine lists. one log line per sweep, `home swept` with
  `swept`, `cleared`, `left`, `mode`, `away` and `ms`; a `home.swept` telemetry row
  when it cleared any. with the rule at `never` the timer still fires, spends
  kept marks and logs its line (`mode=never swept=0`), with no telemetry row. its eligibility, in `Model::sweepable`: no
  status at all (busy, retry, parked on agents or on jobs alone), no queued
  prompt, no open ask, no open fault (failed, or a turn cut off), no open
  review, and not kept. `seen1h` counts a thread seen when a person's read
  mark covers its newest finished reply and no done is open, measured from
  that mark's server time: not its newest message, because a daemon can
  leave the newest message the model heard (a step it removed) out of the
  transcript a device reads and marks, found against the dev daemon.
  `any3h` counts from the open done's raise, else the seen mark, else the
  first sweep that found the thread idle at its current `updated` (kept in
  memory per home window, so after a restart a thread with neither waits 3
  hours from then: it errs on keeping). one sweep clears at most 100
  (`MAX_SWEEP_CLEARS`; each clear queues two or three writes for the fleet's
  1024-deep write queue), and the log line's `left` says how many wait for
  the next run.
- **what an auto-clear keeps** (migration 13): the clear mark as a hand clear
  writes it, plus `cause` (`hand` or `auto`), `away` (no device looking at
  that moment, decision 23 through push's `looking` watch), `done_at` (the
  done's raise, open or among the last 200 served, else when it went quiet)
  and `seen_at` (server ms), and `acked` once the away summary is
  acknowledged. the served done and job needs say `how: cleared` on the
  server (the ledger, the store), by `agent`, and telemetry `need.cleared`
  by `auto`; on the wire such a need goes out with no `how` (no client
  reads it, and a strict enum in the ios app would refuse a new value).
- **unclear and kept.** `POST /api/unclear` (keys 1 to 300, source `undo` or
  `away`) removes each mark and writes a kept mark (`kept` table: the
  session's `updated` then, capped at 2000 like the clears); the sweep skips
  a kept thread until its `updated` moves past it, and spends the mark at
  its next run. a key whose mark is already spent (it came back by itself)
  is refused `notcleared` ("it is on home already"), which a client takes
  as done; one the fleet does not hold, `unknown`. a hand clear drops the
  kept mark. telemetry `thread.uncleared`, with `hand` and `auto`
  counting whose clears came undone (read from the marks removed), so the
  share of auto-clears undone is `sum(auto)` over `home.swept`'s
  `sum(cleared)`.
- **the away summary** is computed on the server: the auto-clears with
  `away`, not acknowledged, whose mark still holds, newest clear first. it
  travels as the id-less `away` frame (`docs/protocol.md`, settle frames)
  whenever a clear is taken, spent or acknowledged moves it, and at a
  stream's open when it holds a row; `POST /api/away/seen` acknowledges
  every row at once (one sql update) and every stream hears the empty
  list. a sweep that clears while a device is looking sends `autoCleared`
  `{keys, at}` instead, for the undo toast.
- **job notices are not needs by default** (decision 95, `jobsAsNeeds`
  off): a job need is still raised, listed on `thread.needs` and served as
  before, and the board still lights `news` for it (`docs/board.md`), but
  the push badge (`Needs::waiting_counting`) and the order's lead
  (`Needs::lead_counting`) leave it out, so a thread whose only need is a
  job ranks as the idle or parked thread it is. turning the pref on
  re-ranks at once (`PUT /api/prefs/home` goes through the fleet, which
  follows it and has its writer commit it, in order).
- **a count per word.** the bar's line says "2 done, 1 idle" (done is a
  finished turn nobody has seen, idle one that was seen or never ran a turn;
  a thread with no turn is not "done"), and the pill says "clear 3", the two
  added (`doneKeys`), named "clear 3 threads that are done or idle".

## settle: the working fold, undo and the away line (2026-10-26)

finished work clears itself on the server (the clearing section above, and
`design.md`, settling); what home adds is how it reads. design.md (settling)
is the law, and decisions 93 to 100 say why; how it is built:

- **who folds** (`working-fold.ts`, `foldOf`, pinned by
  `working-fold.test.ts`): a home thread that is busy, retrying, queued or
  parked with its agents at work folds as working; one parked on background
  jobs alone folds as waiting. any ask or any open need (after the job
  filter below) keeps its window, so a thread leaves the fold the moment it
  finishes, fails, asks or gets a need. the thread on the stage never
  folds: going back on the deck always has a window to shrink into, and at
  the strip and the rail the stage's thread keeps its ring. `foldWorking`
  off folds nothing.
- **the order without the fold.** home.tsx takes membership's keys and
  splits them: each thread's fold standing is a memo of its own (`keyed`,
  as membership's standings are), the windows' target is the rest, and the
  views are made for both (`viewKeys`), so the capsule, its list and the
  bar's line read the folded threads' views. the bar's line counts every
  thread on home, folded or not.
- **the capsule and the away line move nothing on their own** (perf.shift
  0). they come and go only inside `applyOrder`'s flip, with the order, after
  the same calm; a fold that changes but keeps the capsule on the screen
  lands at once (its words, its beads). the capsule's beads are kept by key,
  so a working thread's every frame never remakes its bead.
- **where they sit.** deck and rail: the bar's last rows (the away line
  above the capsule), the bar's width. the strip's bar is one row and its
  stage starts under the row of windows, so a row under the bar would move
  the stage: the away line and the capsule lead the row of windows instead
  (`.wlead`, 196 px, the row's height).
- **the capsule's words** (`foldLines`): "4 working" over "nothing wrong,
  tap to see", or, with both kinds, "4 working" over "2 waiting on a job";
  for 30 s after a thread leaves (`LEFT_MS`, the capsule's own timer) the
  second line says "<repo> just left". the accessible name is the whole
  phrase and what a press does ("4 working, 2 waiting on a job. show the
  list"). at the rail the second line shows only when it counts the
  waiting ones.
- **the lists** (`lists.tsx`, one chunk: `FoldList`, `AwaySheet`) are the
  answer sheet's shape: a sheet from the foot on the deck, a popover under
  what opened it at the strip and the rail (under the away line's start
  for "show"), measured once, the one close (`ui/close.tsx`), escape and a
  press outside close, focus back to the opener, or to the bar's first
  control when the opener went with the change ("bring all back" empties
  the away line; `focus-back.ts`). home is inert under them
  (`sheetUp`). a fold row is a stretched button (its title, the whole row's
  hit area) that opens the thread through the window's own path
  (`activate`, perf control `fold`), and focus stays with the stage, not
  back on the capsule; a row parked on jobs alone keeps its
  clear (`clearThreads`, the window's name for it). the list follows the live
  fold and closes when it empties.
- **the toast** (`toast.tsx`, a chunk; `undo.ts` its words, sweep and
  time): `state.undo` in the store, set by `offerUndo` with the keys the
  clear's answer says it cleared (`clear.tsx`), or by `autoCleared` for an
  `autoCleared` frame (worker to page, never state) while the document is
  visible. which clear shows is `offers.ts` (first load, pure, pinned by
  `undo.test.ts`): a newer clear replaces the toast, except that a hand
  clear's toast is never replaced by an auto-clear: the auto-clear waits
  (`state.undoNext`, one auto offer joining the one waiting, at most 4) and
  shows for its own full 6 s when the hand toast ends, so ⌘z always undoes
  the toast on screen. `Lifetime` owns the 6 s and holds it
  while a pointer is over the toast, focus is in it, or its undo is out,
  and tells the offer when it runs out (`until`, Infinity while held): home
  unmounts off home, and an offer read after its time (`liveUndo`, as home
  mounts and before ⌘z) is gone, so coming back later shows nothing and ⌘z
  does nothing; one still running shows for what is left of it;
  the ring is a clip-path wedge with seven points at every frame, played as
  a decor curve, so reduced motion keeps it full while the time still
  runs. undo (`settle-api.ts`, `undoLast`; home's `⌘z` when no text field
  has focus and no sheet is up) posts exactly those keys with source
  `undo`; a refusal stays on the toast with the server's words and "try
  again", and shows even when a newer toast took over meanwhile: the failed
  offer comes back on screen and the newer one waits first in line. a key
  the server says is already back counts as back. focus in the toast when
  it goes (its undo done) moves to the bar's first control. the toast is no
  live region: it would arrive already holding its words. home keeps one,
  empty and visually hidden, from the first paint (`.toast-live`,
  `toastAnnouncement`), and the words go into it as a toast shows. the ⌘z
  hint and `aria-keyshortcuts` show only on an apple desktop (`ui/apple.ts`,
  the stage's own test for the command key). the
  windows it brings back are born without the calm wait
  (`markBroughtBack`, as a hand clear's hole closes at once).
- **the away list** is fleet state outside the journal (`fleet.away`, the
  `away` frame routed like the colours: protocol.ts `settle`, the reducer's
  `away` action, kept across a reset and in indexeddb with the fleet's other
  fields, so a cold launch paints the line in its first frame). every
  `hello` empties it: the server sends the list after the hello only when
  it holds a row, so a cached list the server has since dropped never comes
  back (`settle.test.ts`). the line
  shows while the list holds anything this device has not acknowledged,
  and while its sheet is open; "show" opens the sheet on the list as it
  stood and then acknowledges it, the dismiss acknowledges it
  (`POST /api/away/seen`); the server's empty list follows and the line goes
  with the next flip. the sheet keeps its rows when the list empties; a row
  brought back says so and stays. the calls load with the toast and the
  sheet (`settling()`, ui/later.ts).
- **the job filter** (`inbox/extra.ts`, `counts`): with `jobsAsNeeds` off
  (the default) a job need is not a need to the client: it does not make a
  window unseen ("done"), so it adds nothing to the line's done count or
  "clear N", and it does not keep a thread out of the fold. the server
  leaves it out of the order and the badge (design.md, the order is the
  inbox). history's rows read the same choice.
- **the home prefs** (`store.ts`, `homePrefs`): the server's `prefs.home`
  once read, a copy in localStorage (`boxbox.home`) before, so a cold launch
  folds as the person chose. the copy is read field by field (`readHome`):
  a field missing or of the wrong shape takes the default. settings saves them optimistically
  (`saveHome`, a later choice is never undone by an earlier one's failure)
  with a `verb` row each (`setAutoClear`, `setFoldWorking`,
  `setJobsAsNeeds`).
- **the stories**: `home--home-as-recorded` (the fold at every width),
  `-working-fold-open`, `-working-fold-off`, `-cleared-while-away`,
  `-cleared-while-away-sheet`, `-undo-toast-one`, `-undo-toast-many`, and
  `shell--settings` for the home group.

## assistants on home (2026-10-15)

an assistant's threads are windows on the same deck, in the same order,
under the same membership and calm laws as cmx's (`design.md`, agents:
who a window belongs to). the approved screens change four things: the
palette and the mark, the tail's lines, the footer, and the dock's words.
on the web the window, the agents screen's card and the start something
row and picker are built as standalone components with a story per state
(`app/src/ui/assistant/home/`, ladle group `assistant-home`), waiting for
the app's protocol 3 store.

- **the window.** the assistant's palette is the material (`--p1..3`
  from its slot; coral for the first). the header leads with the round
  mark (22) and the name in the light tone, 15.5 px 500, where a repo's
  square mark and name sit; nothing follows the name (an assistant is its
  own identity). the chip, the title (22 px wide), the ask preview and
  its "answer" pill are as built, in the palette. a cmx window's header
  gains `cmx · vm-a` after the repo name, in the light tone at 60%, 14 px,
  once more than one agent is paired.
- **the tail's grammar**, beside the cmx rules (`design.md`, anatomy of
  a window):
  - **steps** between two pieces of prose fold into one mono line,
    11.5 px, each step its verb dim and its thing lit, joined by a dim
    " · ": "checked calendar · searched 2 sites". it never wraps: past
    the width it says "and 2 more". a step that failed is its own line,
    its verb in red.
  - **a voice note** is one line: a 22 px disc (the light tone at 22%,
    its play glyph in the light tone) and "voice note 0:22" in the
    prose's colour, 15.5 px. yours sits on the right as your prompt does,
    "voice note 0:14" in the bubble. the disc is not a control (the
    window is one button); it shows pause while that note plays, so home
    says what is playing.
  - **a picture or a file** is one line: a 16 px glyph and its name
    ("booking.pdf", or "image" for an unnamed generated one) in the
    prose's colour.
  - **a quote** in the tail is dropped (the window says what was said,
    not to what); a reaction is never a tail line.
- **the footer** says where the conversation is when it is somewhere
  else: "via whatsapp" on the left (mono 11.5 px, the window's second
  ink), where a cmx window has its diff counts, for a thread whose newest
  message came in on a channel (`origin.kind: channel`); the state on the
  right as today ("waiting", "working", "done 11:40"). a thread only ever
  written to from boxbox has nothing on the left, or "3 steps" when its
  last turn stepped.
- **the bar's line** names the assistant as it names a repo: "<name>
  wants you, 2 working, 1 done", the name in its light tone. the capsule
  carries the round mark.
- **the dock** reads "start something" over the place it starts in:
  "with <name>" for an assistant, "in ledger" for cmx, "in ledger · cmx
  · vm-a" once more than one agent is paired. its colour and key follow
  the window in view, as today. for an agent without `threads` it reads
  "message <name>" and opens that agent's one thread.

### more than one thread with an assistant

- an assistant has its **main thread** (the conversation its channels
  land in) and the **topics** you start from boxbox with "start
  something" (`threads`). each is its own window under the same
  membership rule as any thread (working, wants you, done unseen, failed,
  queued, touched in the last 12 hours), so a quiet day with an assistant
  is one window, and a busy one a few. nothing pins the main thread: when
  nothing happened in it for 12 hours it lives in history, as any thread.
- windows of one assistant sit where the order puts them, like windows
  of one repo; the order does not group them.
- history lists them under the assistant (the machine chips become agent
  chips, with the round marks), the main thread first among its rows
  when the search is empty.

### quieter runs: scheduled and heartbeat

an assistant runs on its own: scheduled jobs and heartbeat checks
(`origin.kind: scheduled`; a heartbeat is a scheduled run whose `name`
is `heartbeat`, which `docs/openclaw.md` sets when the job has no label
of its own). each run is a thread of its own (`docs/openclaw.md`, the
mapping), and none of them gets a window of its own unless it asks. most
have nothing to say, and a deck that grew a window for each would stop
being an inbox. so:

- **what wakes a window is `said`, not `updated`.** a thread's `said`
  is the time of its last turn that wrote text for you or raised an ask
  (`docs/agents.md`, the thread). a run moves `updated` every time it
  runs; for an assistant's thread, membership, "done" and the return of a
  cleared window read `said`, so a run that only checked something moves
  nothing on home.
- **a run that says nothing never shows.** a run that ends without a
  message for you and without an ask gets no window, no count in the bar,
  no push, and does not wake the window of the thread it ran in. it is in
  history only, under the "runs" chip, and its thread shows its turn
  behind the mark line ("heartbeat, 08:30").
- **a run that asks is not quiet.** an ask from a run is a window like
  any other, wants you, pushed, first in the order. needing you outranks
  how the run began.
- **a run that says something** is gathered into the assistant's one
  **runs window** (the agent's `runs`, at the order key `<agent>:runs`;
  `runs` is null, and the window gone, when no talking run is unseen): a
  single window per assistant for every run with something unseen,
  titled "<name>'s runs", its chip "3 runs" (`runs.unseen`, never
  "done"), and its tail one line per item (at most 12, newest last): the
  time in mono, the run's name and its preview ("08:00 morning check: two
  meetings moved, nothing to do"). it ranks with the idle windows, below every done
  thread, and the bar's line does not count it; "clear N" does, and
  clearing it clears its runs. it is pushed only when you chose to hear
  about runs (settings, what reaches this device: a fifth kind,
  "scheduled runs", off by default).
- **opening the runs window** opens the newest run's thread. its title
  block says "morning check, 08:00 · 1 of 3 runs", the last part a button
  that opens the runs in the turns list's place (each run by its time,
  name and first words); a run opened there is seen, and the window drops
  it. once every run in it is seen the window leaves the deck, and the
  runs stay in history.
- **a run that lands in the main thread** (a runtime that runs its jobs
  there) follows the same rules by turn: a quiet turn leaves the window
  alone (`said` does not move), a turn that says something marks the
  thread done unseen with the mark line as the window's newest tail line
  ("scheduled, 08:00"), and an ask is an ask.

### when the gateway is away

- the windows of an agent that is not answering, or refused, stay as
  they were, painted from what boxbox last read, and are **stale**: the
  footer's state word becomes "stale, 11:40" (the time of the last read)
  in the second ink, the chip keeps its last state without a running
  clock, and no verb is sent for them (clear waits, an answer waits).
  they come back to life by themselves when the agent is connected
  again.
- history serves an assistant's rows from boxbox's read cache while its
  gateway is unreachable (the answer says `x-boxbox-cache: stale`), each
  marked "stale" after its minute, with one
  line over the list: "vm-b is not answering, so <name>'s threads are as
  boxbox last read them." a thread the cache never held is not listed
  then, and the line says so: "threads boxbox has not read yet are
  missing until vm-b answers."

## the agents (formerly the machines, 2026-10-15)

the machines screen (`design.md`, the machines) is **the agents**: the
same screen, head, grid, cards and verbs, renamed, with an assistant's
card among the machines'. the bar's pill keeps its mark (two stacked
boxes) and is named "agents"; the title is "agents".

- **a cmx card** is today's machine window: the os's tile, the machine's
  name and what it is (`Mac mini · macOS 26.1`), `cmx2 0.8.3 · up 3 h ·
  paired` (uptime from the daemon's own samples, as the law says;
  `connection.since` is when the state last changed, not uptime), the
  three figures, the meters (cpu, memory, disk) over the spec line,
  terminals, the foot (`design.md`, the machines: what a machine is, and
  how it is doing).
- **an assistant's card** is the same window in the assistant's palette:
  the round mark (22) beside the name (22 px, wide), the chip, the mono
  line `openclaw 2026.10.1 · paired` (its runtime and version, then
  "paired" when `connection.origin` is `paired`; a connection written in
  `boxbox.toml` says nothing there), then the figures it can say:
  **wants you** (in the accent when more than none), **threads** (its
  threads boxbox holds), and **memory** only with `admin`. while `ready`
  the mono line carries the uptime too (`openclaw 2026.10.1 · up 3 h ·
  paired`, from `connection.since`, which is the uptime while ready). no
  terminals (no `terminal`). the
  foot holds **reload** and **restart** with `admin` (restart confirmed
  in place as for a machine, "restart stops <name>'s running turns, then
  its gateway starts fresh."), and **forget**.
- **pairing states**, read from the agent's `status` (`pairing`,
  `syncing`, `ready`, `connecting`, `down`, `refused`) and its
  `connection` (`pinned`, `untested`, `protocol`, `refused`,
  `lastError`). the handshake is `docs/openclaw.md`'s; these are the
  words and the shapes, and this table is the one source of the copy:
  `docs/openclaw.md` quotes it.

| state | chip | the mono line | in the card |
|---|---|---|---|
| `pairing`: waiting for approval | "waiting", the dot ringed and empty, second ink | `openclaw 2026.10.1 · waiting for approval` | "approve boxbox on vm-b's gateway:" and the gateway's own words from `lastError` under it verbatim in a mono bed (they carry the approval command), with "copy the approval command" (it copies those words) and "check again" as quiet words. the card asks again every 5 s while the screen is open, and moves on to syncing by itself. no figures |
| `syncing` | "syncing", the dot ringed and half filled, second ink | `openclaw 2026.10.1 · paired` | the figures as last said, in the second ink, and one line: "reading <name>'s threads." the threads open as they arrive |
| `ready` | "connected" | `openclaw 2026.10.1 · up 3 h · paired` | the figures and the foot |
| `ready`, `untested` | "connected" | `openclaw 2026.11.0 · untested`, the last word in the light tone | one line under it, second ink: "openclaw 2026.11.0 on vm-b is untested; boxbox is pinned to 2026.10.1. anything that does not work says so where it fails." (the versions are `version` and `pinned`). never red: nothing is wrong yet, and the agent syncs as any other |
| `connecting` | "connecting", ringed dot | as last known | the figures as last said, in the second ink |
| `down` | "not answering", the failure tone | as last known | why and since when in red, as for a machine; its threads stale |
| `refused`, `refused: protocol` | "refused", the failure tone | `openclaw 2026.12.0 · protocol 5` | red: "vm-b speaks openclaw protocol 5; boxbox speaks 4. update boxbox, or run the openclaw it is pinned to (2026.10.1)." (`protocol`, `pinned`). figures absent; its threads stay on screen as they were, stale, and boxbox sends it nothing |
| `refused`, `refused: methods` | the same | `openclaw 2026.10.1 · refused` | red: the gateway's words from `lastError` (the methods it would not grant), then "pair it again from add an agent." its threads stale |
| `refused`, `refused: auth` | the same | `openclaw 2026.10.1 · not paired` | red: the gateway's words from `lastError`, then "pair it again from add an agent." with "forget" in the foot; its threads stale |
| `refused`, `refused: key` | the same | `openclaw · vm-b` | red: "another agent already has the key <key>. pin a key for this one in boxbox.toml, then reload." its threads stale |

- **add an agent** is the ghost after the cards: "add an agent" and one
  line, "pair a machine's cmx, or an assistant's gateway." pressed, it
  opens as today's deeper card with a segmented choice at its head,
  **cmx** (today's form: "run `cmx2 pair` on it, then paste what it
  prints.") and **an assistant** (the gateway's address and an optional
  name; "pair" sends the request, the card closes, and the new card
  arrives in its waiting for approval state). with no agents: "no agents
  yet. pair one, or add one to boxbox.toml." and the ghost alone.

## the gaps, and who closes them

each is a fact the server's fleet model does not carry yet (boxbox's own
server, not cmx2, so not an ask); home renders what exists and never
guesses.

| gap | what home does meanwhile | where it closes |
|---|---|---|
| ~~a window tail never takes deltas~~ | closed: the fleet folds `message.part.delta` into the tail; a thread's tail goes out as a `thread.patch` tail op at most every 500 ms (it was 200) while only streamed text moves it (`model::TAIL_EVERY_MS`, `protocol.md` section 6), flushed by the actor's clock, and the new words fade in | |
| ~~a tail item has no role~~ | closed: `TailItem.role` (`user`, `assistant`); your prompt is its own line on the right, its first 280 characters kept, and a prompt still queued stays out of the tail | |
| ~~cmx2's synthetic parts enter the tail~~ | closed: `tail_item` skips `synthetic: true`, as the stage does | |
| ~~no failure on a session (`session.error`)~~ | closed by m4: an open fault need feeds `Extra.failure` (`app/src/ui/inbox/extra.ts`) | |
| ~~no read state~~ | closed by m4: "done" until the thread is seen; a turn that ends in front of you is never done-unseen | |
| ~~no route to answer an ask~~ | closed by m4: the thread's ask card answers through boxbox's api with a `clientID`; the window previews it and opens the thread to it (2026-10-05) | |
| no queued prompt text | "working, 1 next" without "next: ..." | server |
| no ask arrival time | "waiting" without a clock | server |
| ~~the service worker precaches nothing~~ | closed by the shell: the worker precaches the build's hashed ui at install and answers a navigation from it, so a cold launch paints with no network (`docs/push.md`, the service worker) | |
| the worker marks no patch as replayed | motion waits a second after each connect instead | worker lane: a `caught-up` stream state |
| ~~an idle session's window has an empty tail~~ | closed: when a session gets a window the fleet reads its newest 12 messages once and lines them up with the stream by `x-cmx2-seq` (`server/src/upstream/tails.rs`; architecture.md, the fleet model) | |
| ~~the rail grows an asking window in its column by layout~~ | closed (2026-10-05): an asking window keeps its resting size in the rail, so nothing below it moves | |

## verification

- **unit** (`bun test app/src/motion app/src/ui/window app/src/ui/home`).
  the springs, the ten hues' contrast, the tail's grammar, every window
  state, membership, and the recorded journal replaying exactly once into
  the five states it was recorded in.
- **the fixture.** `just build && bun bench/windows.ts capture` records
  `app/src/ui/home/fixtures/journal.ndjson`, every frame boxbox's
  `GET /api/stream` sent while five threads ran across two repos on the
  pinned daemon (working, wants you, done, queued, parked).
- **stories.** `bun run stories` in `app/` serves one story per window
  state in `design.md`'s table, each at deck, strip and rail sizes (wants
  you three times: the recorded "which greeting", a long ask of a header, a
  four line question and three options of three to five lines each, and an
  ask of two questions; `ui/thread/stories/asks.ts`), plus home as recorded,
  with each of those two asks (the thread on the stage holds the question
  the window previews), offline, after a protocol break, with a long repo
  name, a live replay, and the moments (the birth and the sweep, played on cue).
  `bun run shots:home` screenshots every still story at 390, 820 and 1512 and
  fails on a console error, a story that never became ready, a page that
  scrolls sideways, a control without a unique name, a bar line that
  leaves its box or comes within 6 px of a pill, or a craft finding
  (`craft.js`, the thread's check). at each width it then plays the birth
  under its own frame pump and fails unless the born window runs an
  animation of transform and opacity whose `currentTime` rises frame by
  frame while its computed opacity and transform change (0 and
  `scale(.9)` to 1 and none, about 34 frames).
- **the pour, frame by frame.** home with heavy threads (every window
  holding 24 turns of a long imported session) is the story the pour is
  timed on. `bun .ladle/pour-frames.ts` (from `app/`) pours each window at
  1512, from a fresh page and again after another, holds every animation
  and steps it 16 ms at a time through its clock, and records the keyframes
  and timing of what the pour started, the poured layer's clip-path,
  transform and opacity, and the turns its view shows; then it lets the
  pour land and records the landed view, and last it pours freely and says
  the frames each pour dropped (`perf.frames`). `--out` keeps a run and
  `--against` fails a later one on any difference in the motion, the view's
  turns or the landed view, saying where boxes sit a px apart (the sub-pixel
  phase at the end of the scroller, `thread.md`, the window).
- **writes that change nothing.** the `writes` stories
  (`ui/home/stories/writes.stories.tsx`) run the whole app at home and at a
  thread with its composer while a seeded fleet of 300 streams under it
  (`fixtures/fleet-sim.ts`, a step every 50 ms), a reply streams into the
  open thread and the person types. a MutationObserver
  (`writes-probe.ts`) counts every attribute and text write and the ones
  that set the value already there; after every batch the windows' clear
  names and the bar's "clear N" are read against the store, a window is
  renamed now and then and the reply settles at the end, so a change that
  does happen is on the page in its own batch.
  `bun .ladle/shots.ts --prefix writes--` fails on any same-value write or
  stale name. a single dynamic attribute in solid is set again whenever its
  effect runs, equal or not, so a name worked out from a view or a list
  that is new on every frame reads through a memo.
- **the board's digits.** `bun test app/src/sync/protocol.test.ts
  app/src/store-board.test.ts app/src/board`: board frames are taken
  without a seq and leave the cursor and the reducer's state as they were,
  only on a stream that asked; the slice replaces, clears and settles a
  pairing; the board's membership is the app's (`windows.test.ts`, over
  the server's fixture, `server/src/fleet/board/windows.json`). `bun .ladle/shots.ts --prefix
  board--` (and `--theme light`) shoots arriving, changing and leaving
  (each held part way), at rest, the folded strip and rail, and reduced
  motion at 390, 820 and 1512, and fails a story on a layout shift or a
  long task while the digits moved, a seated window without its key or its
  name's ", board key N", two equal names, or, under reduced motion, a move
  in flight.
- **the budget run.** `just build && bun bench/home.ts` drives chromium
  against the real daemon with five threads streaming, at 390, 820 and
  1512: 20 cold launches, 50 opens and closes, scrolling while streaming,
  cumulative layout shift, a screenshot each, then the raw `perf.*` rows
  the server wrote and a table against each target. it is chromium on a
  mac over loopback; the gate's own numbers need the real ipad and iphone
  (`verification.md`, device checks).
