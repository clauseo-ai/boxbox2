# home

home is the live windows (decision 12; `design.md`, the model: windows).
this file says how it is built, what it decided where the law is silent,
how it is verified, and what it still waits on. it extends `design.md` and
is binding the same way (AGENTS.md, rule 6).

## where it lives

| path | what |
|---|---|
| `app/src/motion/` | the motion law as code: the two springs sampled into `linear()` curves, the short curves, and `play`/`flip`/`settle`/`sweep`, the only way anything animates |
| `app/src/ui/window/` | one window: the repo colours (`repo.ts`), the tail's grammar (`tail.ts`), the window's view of a session (`view.ts`), the component and its stylesheet |
| `app/src/ui/home/` | home: membership (`membership.ts`), the arrangements, the order and its calm, the stage and its motion (`home.tsx`, `stage.tsx`), the folds at the rail (the folded column and its swatches `fold.tsx`, `swatch.ts`; the stage card's edge moving `edge.ts`, `glide.ts`; the choice kept on the device `remembered.ts`), the budgets (`perf.ts`), the fixtures and the stories |
| `bench/windows.ts` | the windows world: five threads across two repos on a real daemon, for the fixture capture and the budget run |
| `bench/home.ts` | the budget run |

## how it is built

- **facts come from the server** (decision 16). the fleet model decides
  status, asks, the window tail and the window order; home renders them.
  home decides only membership (the law's rule: working, wants you, parked,
  queued, or touched in the last 12 hours; subagents never get a window)
  and how a state reads: chip, clock, footer, accessible name.
- **a window is an article with one stretched button**, its title, whose
  hit area covers the window. the ask's "answer" pill is a button of its
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
  swaps and turns the blur and the sweep off, in `play` itself.
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
  blue `#173a5e`/`#0a1a2e`/`#9cc8ff`, teal `#10484a`/`#062123`/`#7fe0d6`,
  clay `#5a2c19`/`#29130a`/`#ffb48c`, plum `#46205c`/`#1f0e2b`/`#dfa8ff`,
  olive `#3b4216`/`#1a1d08`/`#d4df7c`, slate `#2b3441`/`#12161c`/`#b9c6d8`.
  a repo's hue is fnv-1a of `host:projectRoot` modulo ten.
- **the springs as sampled.** snap settles in 467 ms and sheet in 508 ms to
  the springs' own rest threshold; the law's "about 420" and "about 560"
  are rounded from the same constants.
- **the tick draws by clip**, left to right, since the law allows only
  transform, opacity, clip-path and filter to animate. **streamed words settle by blur and opacity**
  alone: they are inline so they wrap with the prose, and transform does
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
  start from. on the deck and the rail the bar is three rows by rule at any
  count (the wordmark with where you go, then what you do, then the line),
  because four pills and a wordmark do not fit one row at 390 with a two
  digit "clear 23", and a pill that wraps by chance is left alone on a
  row at some count or other (the first reviewer's "machines" alone on the
  rail). the strip has the width for one row. `home--home-crowded-bar` holds
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
  header, its question (clamped: three lines, six on the deck), one quiet
  line of what waits ("3 options", "2 questions") and an "answer" pill.
  the pill and a tap on the window both open the thread with the ask in
  front: home sets `state.focus` (`askFirst`, the same path a push tap
  takes) and activates the window; the stage goes to the ask's row and
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

## the folds at the rail (2026-10-02)

design.md (the inspector and the folds) is the law; how it is built:

- **the layout.** at the rail the stage card spans the whole grid and
  takes `margin: 14px var(--stage-right) 14px var(--stage-left)`;
  `--stage-left` is 318 open or 76 folded, `--stage-right` 330 with the
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
- **the swatches join the order's flip**, so a reorder moves them on the
  snap spring as it moves windows; a folded rail's windows are out of view,
  so none of their tails count as watched.
- **the stories** carry a `memory` per story (`Home`'s prop), so one
  story's fold never leaks into the next: `home--home-rail-folded`,
  `-inspector-folded`, `-both-folded`, `-inspector-turns`, `-empty`.

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
- **a count per word.** the bar's line says "2 done, 1 idle" (done is a
  finished turn nobody has seen, idle one that was seen or never ran a turn;
  a thread with no turn is not "done"), and the pill says "clear 3", the two
  added (`doneKeys`), named "clear 3 threads that are done or idle".

## the gaps, and who closes them

each is a fact the server's fleet model does not carry yet (boxbox's own
server, not cmx2, so not an ask); home renders what exists and never
guesses.

| gap | what home does meanwhile | where it closes |
|---|---|---|
| ~~a window tail never takes deltas~~ | closed: the fleet folds `message.part.delta` into the tail; a session's entry goes out at most every 200 ms while only streamed text moves it (`model::TAIL_EVERY_MS`), flushed by the actor's clock, and the new words settle in by blur | |
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
- **the budget run.** `just build && bun bench/home.ts` drives chromium
  against the real daemon with five threads streaming, at 390, 820 and
  1512: 20 cold launches, 50 opens and closes, scrolling while streaming,
  cumulative layout shift, a screenshot each, then the raw `perf.*` rows
  the server wrote and a table against each target. it is chromium on a
  mac over loopback; the gate's own numbers need the real ipad and iphone
  (`verification.md`, device checks).
