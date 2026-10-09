# design

the design law for v2. the direction is live windows (decision 12). this
file says what it looks like, how it moves, how it maps to every device,
and the numbers that decide whether it is buttery.

## the direction

home is the work itself. every thread that is alive is a window in its
repo's colour, and the window shows what the agent is doing right now: your
prompt, the tool calls ticking past in mono, the prose settling in, the
counters rolling as files change and tests run. you move between windows
the way you used to flick between tmux panes, except these come to you
when they need you. opening a window grows it into the thread and floods
the screen with its colour. depth is physical: a dark ground, lit windows
above it, glass only for the few things you touch (the dock, the composer,
sheets). the joy is earned: when tests go green a single sweep of light
crosses the window and a tick draws itself, once, because something real
happened. nothing loops for decoration and nothing is a metaphor.

## the bar (2026-09-30)

- no f1, nothing carried over from v1's visual identity or the board's led
  palette. the board keeps its colours; the app starts fresh.
- sleek, modern, slick: someone looking at the screen should ask what it
  is.
- thoughtful animation and real depth. personality and a little joy of
  building; not cookie-cutter, not try-hard, not boring.
- grounded: everything must be buildable as a home-screen web app.
- a thoughtful ux throughout, with no jank in real use.
- **everything is important.** the standard of care is the same for the
  parts nobody sees as for the hero screen. an empty state, an error line, a focus ring, the
  offline state, the frame where a transition hands off to the next, the
  accessible name of a control, the naming inside the code: each is held
  to the same bar as the hero screen. detail is part of done on every
  change, never a polish pass later.

## platform truth: what a home-screen pwa can and cannot do

every design idea must be buildable as a web app installed to the home
screen. the build verifies each "yes" on a real device before relying on it.

| capability | ios / ipados pwa | mac chromium pwa |
|---|---|---|
| lock-screen push | yes (16.4+); banner and tap only, no action buttons | yes, with action buttons |
| app icon badge | yes (badging api) | yes |
| dynamic island, live activities, widgets | **no** | n/a |
| drawing near the camera cutout | no: the system status bar sits on top | n/a |
| haptics | **no** (no vibration api on ios) | no |
| same-document view transitions | yes (safari 18+) | yes |
| spring easing via css `linear()` | yes (safari 17.2+) | yes |
| backdrop blur | yes | yes |
| scroll-driven animations | safari 26+, verify | yes |
| frame rate | **animation and rAF capped near 60 fps** on 120 hz phones unless the user flips a hidden flag; native scrolling runs at 120 | display rate |
| system back swipe | **the edge swipe walks browser history** and peels a stale snapshot; it cannot be disabled | n/a |
| webgl | yes; webgpu safari 26+, verify | yes |
| background work while closed | no; only push wakes the service worker | same |

consequences:

- agent state lives inside the app's own chrome, never in system surfaces.
- "tap to answer" on the phone means a push that opens the exact card, not
  a banner button.
- motion is css, web animations and view transitions, time-based, and
  budgeted at 60 fps on safari, the slowest target. scrolling is native
  and never hijacked, so it keeps 120 hz.
- **in-app navigation never pushes history entries** (the url is kept
  current with `replaceState` so a relaunch restores the place). with no
  history to walk, the system swipe has nothing to peel, and the back
  gesture is ours: interactive, following the finger, the same motion as
  the back button. verify on device in the first milestone that touches
  navigation.
- the slowest target is an ipad (10th generation, 60 hz, a14), and the
  frame budget is judged on it.
- **the ios viewport law** (decision 19, from v1's keyboard scars): no
  `viewport-fit=cover`, so the app starts below the status bar and
  safe-area insets read 0 (every inset takes a floor); `html` never
  scrolls, only the app's own panes do; inputs are 16 px or larger on
  touch; the keyboard inset counts only while an editable holds focus;
  nothing snaps scroll after the fact. the strip above the app is the
  browser's, painted in the `theme-color`: the ground, and while a
  thread is open full screen on the deck, the top of its flood, so the
  repo's colour reaches the screen's edge.
- **the board, when connected**, drives the stage like a tap (its focus
  key opens a thread with the same motion) and each window shows its
  seat digit while the board is showing seats.

## what the app is for

the design spends its attention in this order and puts everything else in
a drawer.

| job | evidence | where it lives |
|---|---|---|
| read and watch a thread | most of the time in the app goes to reading and watching | the stage |
| stack prompts | prompts are often queued behind a busy turn | the composer and its queue |
| know when to come back | people open the app just to find out whether anything needs them | push, the windows' order, the badge |
| answer an ask | questions are infrequent; permissions come from other users | in the thread, where it was asked; the window says it waits and opens the thread to it |
| start a thread | most compose opens start a new thread | the dock, one gesture from anywhere |
| switch threads | phone: hub and spoke; mac: thread to thread, and the board | the deck (phone), the rail (ipad, mac), `⌘k` |
| everything else | terminal, machines, fork and revert are used rarely | the thread menu and settings |

## the model: windows

### what gets a window

a thread has a window while any of these hold: it is working, it wants
you, it finished a turn you have not seen, it failed, it has a queue, or
you touched it in the last 12 hours. everything else lives in **all
threads** (search first, grouped by repo, newest first), one gesture away.
a quiet day shows two or three windows, a busy one eight; the deck never
becomes a list of fifty.

### clearing a window, and history

a window can leave home by hand, and come back on its own.

- **clear.** a window that is done, idle, failed or parked has a "clear"
  button in its footer; the bar has "clear N" (the done and idle ones, which the line beside it counts apart).
  a working or asking thread has no button, and the server refuses it
  too. clearing is not destructive: the thread is still on its machine,
  in history, and one tap opens it.
- **the mark lives on the server** (`clears`, migration 4), not on a
  device, so every device agrees. the mark is the thread's `time.updated`
  at clear time. the thread comes back, for good, when it goes busy,
  asks, or its updated time moves past the mark. there is no "unclear"
  control: coming back is what the thread does.
- **motion.** the window leaves by the fade curve (opacity and the
  transform it already had), and only once it is gone does the POST go
  out; the order drop then makes the others close up by flip, measured
  once. a window the person just cleared skips the calm wait that
  guards other leavers.
- **history** is a route (`?screen=history`, parent home) opened by the
  "history" pill. it lists every thread the machines know, cleared ones
  too, newest first: repo colour, title, machine (only when more than
  one), state, and last activity. a search box filters on title and repo
  and chips filter by machine. a row opens the thread route. the snapshot
  the app holds is capped (300 per machine), so history is a paged read
  (`GET /api/history`), 30 rows at a time with "older threads". the list
  holds 300 rows: past that the next page replaces them ("300 threads are
  on screen. the next ones replace them.") and "back to the newest" starts
  over. every row's name is its repo, title, state, machine and minute;
  rows that would share one get the shortest id ending that tells them
  apart, as do the windows' open and clear buttons. empty,
  loading and unreached words: "reading your machines", "no threads yet.
  start one from the plus.", "nothing matches that.", "<machine> did not
  answer, so its threads are missing here.", "that is every thread the
  machines know."

### window states

| state | chip | what the window shows |
|---|---|---|
| working | "working" with a live elapsed clock | the live tail |
| wants you | filled with the repo's light tone: "wants you" | a preview of the ask rises out of the tail (its question, what waits, an "answer" pill); the window keeps its size |
| done, unseen | "done" and the time | the last lines of the answer, the result counts |
| failed | the one red in the system: "stopped" plus the reason | the error line, "retry" and "open" |
| queued | "3 next" beside the state | the next prompt, dimmed, under the tail |
| parked | "parked" (cmx2), only when it waits on background jobs alone | why, and what wakes it: "waiting on a background job; its notice wakes it". a thread whose agents are at work is **working** (the chip, the clock, the order), whatever the daemon calls its own turn: "its agent is at work; its report wakes it", "2 agents at work; their reports wake it" |
| idle, seen | no chip | the last exchange, dimmed |

state is carried by form (the chip, the window's position, the ask), and
the colour always means *which repo*. there is no traffic-light palette:
a question in the violet repo is violet; only failure is red.

### the order is the inbox

the needs-you inbox (non-negotiable 3) is not a separate screen. it is the
front of the deck and the top of the rail:

1. wants you (questions and permissions), oldest ask first
2. failed (a real fault, never your own interrupt)
3. done, unseen, newest first
4. working, the newest turn first (ordering by activity would reshuffle
   them every few seconds)
5. queued and recent, most recent first

the badge on the app icon counts 1 to 3. a window leaves the front only
when it is served (answered, seen, retried); nothing is ever removed
without its answer.

**what raises a need, and what serves it** (m4, derived once in the
server from the daemon's events):

| need | raised by | rank | served by |
|---|---|---|---|
| permission, question | the daemon asking | 1 | its answer, from any client; the daemon dropping it (an abort, the session ending) clears it |
| fault | the daemon's `session.error`, or a turn cut off (`finish: aborted`) that nobody stopped here in the 15 s before | 2 | a new turn in the thread (a retry, a reply). looking does not serve it: a failure is not read away |
| review | the agent in a checkout asking for review | 3 | the checkout merged or discarded (the frame's directory names the checkout, and a session is in it when its own directory is or lies inside it), a reply a device of ours sent through boxbox's prompt, steer or command route and the daemon took, a turn a device started, a newer request for the same checkout, or the daemon saying the checkout is gone when the review is read. a turn the agent started itself (woken by a child's report) does not serve it: that says nothing about the checkout. each request is its own need (`review:<key>:<checkout>:<seq>`) |
| job notice | a background job reporting (it exited, printed what it watched for, opened a port) | 3 | the thread seen |
| done | a turn ending with the session plainly idle (parked is not done) | 3 | the thread seen, or a new turn |

a subagent's turns and failures raise nothing on their own: they flow to
the parent, which carries on. a job notice is news, not a push: it wakes
the agent, and the turn it causes ends as a "done" like any other.

**unread from here.** read state is one mark per thread, taken by the
server on the daemon's clock and never on a device's: the newest message
a device had in front of it, by id and `time.created`. the thread's mark
is the furthest of its devices' marks (read on the mac is read on the
phone), and it never moves back. a thread is "done, unseen" while its
last reply was created after the mark. opening such a thread draws one
hairline above the first message after the mark as it stood when the
thread opened, labelled "unread from here", and the mark moves to the
newest message at once, so the line stays where it was drawn until the
thread closes and never reappears. a thread on stage on a device that is
looking (visible and focused, decision 23) is seen as each turn settles:
a turn that ends in front of you raises no need and draws no line (no
self-inflicted unread).

### the inbox in the windows (m4)

the inbox has no screen of its own: home's windows are ordered by the
server's needs, so the front of the deck and the top of the strip and
rail are what wants you. a window that wants you carries a **preview** of
its ask in place of the tail's foot, and keeps the size it rests at (see
"an ask never grows its window", below): the question's header as a small
label, if it has one; the question, clamped (three lines in the strip and
the rail, six in the deck's tall window); one quiet line that says what
waits ("3 options", "2 questions", "allow once, always allow or deny" for a permission, the
card's own words for its three replies);
and an "answer" pill in the repo's light tone, the material of the "wants
you" chip. the pill is named for the repo and the question ("answer ledger:
which greeting should the notes use?"). a tap on the pill or on the window
opens the thread with the ask in front: the same path a push tap takes.
the thread opens on the stage (strip and rail) or full screen (deck), the
ask's row scrolls to just below the bar (the bar's own height and its 36 px fade, so the
row's label and ring are whole; an ask near the thread's end sits lower, whole, where
the end stops it, and one that nearly fills the room under the bar gets end room, out of
view, so the end's pin does not drag it up under the fade) and its card takes focus, with one
ring in the repo's light tone round the whole row (its label, question,
options and dismiss: one object, not a lit head and a ringed card) that
follows focus and never moves the layout; a thread already on stage just goes to the ask. a failed window
says the fault's reason; a window whose turn finished unseen says "done"
until its thread has been on stage on a looking device.

an earlier design let the window hold the whole card. it looked janky when
it expanded, and on a phone it forced a sideways scroll because the
question card did not fit the screen (2026-10-05). a real question (a header, four lines of question, three options with three
to five lines each) grew the 260 px strip window about 1000 px tall,
pushed the stage down by all of it across the full width and left a band
beside it empty. so the window never holds the card and never grows; the
ask is answered in its thread, which has the width and the height for it.

**the ask card** (`app/src/ui/thread/thread.tsx`, `AskCard`, `PermissionCard`)
sits in the ask's row, open while it is pending (the thread's own rows,
`thread.md`, asks); the row's head is the question, with its own short
label above it in the light tone, as the window shows it. a question shows one option per answer, each with its
description wrapped under it; a single question with single choice answers in
one tap, anything more is chosen then sent ("answer with 2 picked"). several
questions in one ask (the daemon takes one list of answers per question) are
blocks of their own, each with its header, its words, its options and its
typed answer, told apart by a hairline; the options choose, and one "answer"
at the foot sends them all once every question has one. a typed answer is
always offered ("or type an answer") and wins over a choice in its question.
"dismiss" rejects a question. a permission shows what it wants in plain words
and three options, "allow once" resting on the card in the light tone, then
"always allow" and "deny" (and "or deny and say why"). while an answer is on
its way every option is held and the card says "sending"; the card settles
when the stream says the ask is gone. an answer that lost the race says
"answered on iphone at 23:49", with nothing to retry; one for an ask that is
gone says "this is gone: it was answered, or its turn ended.", with nothing
to retry; one that failed keeps the choice and says "not sent: ... tap to try
again", and the retry carries the same client id. keys 1 to 9 press the
options of one question while focus is on the card or inside it (never in a
field): in an ask of several questions, the question focus is in, else the
first with no answer yet. at 320 px and up nothing scrolls sideways: a long
question takes the row's whole width on a phone, under the kind and the
result, and a long option wraps.

### the laws that keep it calm

- **nothing moves under your finger.** while you are touching, scrolling
  or dragging the deck, reorders wait; they apply 1 s after you let go,
  with the reorder motion so you can see where things went.
- **the window you are looking at never slides away.** if a question
  jumps ahead of it, it stays in view and an edge of the new window glows
  in at the side, with the top line saying "ledger wants you". if you have
  not touched the screen for 4 s, the deck glides to the ask itself,
  because you are watching.
- **live motion only for live events.** anything that arrives by replay
  (a reconnect, a relaunch, catching up) paints in place with no motion.
  a counter only rolls when the number changed in front of you.
- **offscreen windows do not animate.** they update their text; the
  motion budget is spent where you look.

### anatomy of a window

```
 ┌───────────────────────────────┐
 │ api                  working  │  repo (host only if you run more than one)
 │ rate limit the webhook        │  thread title
 │ endpoint                      │
 │   (fades in from the top)     │
 │         add a per-customer    │  your prompt, right-aligned
 │         limit, 100 a minute   │
 │ read routes.rs         1 file │  tool lines, mono, grouped
 │ the limiter is a token        │  prose, sans
 │ bucket per customer id...     │
 │ cargo test          104 / 118 │  counters roll
 ├───────────────────────────────┤
 │ +93 -12   ▮▮▮ 3 agents   6:12 │  diff, subagents, procs, clock
 └───────────────────────────────┘
```

the tail's grammar, so it reads at a glance and never floods:

- consecutive reads fold into one line ("read 12 files").
- an edit is `edit file +84 -12`; a command is its short form and its
  result (`cargo test 118 passed`, `bun test 3 failed`).
- a subagent is a tile in the footer, lit while it runs; its own work
  never floods the parent's tail. in the tail it is one line, "agent
  helper" when it starts, "wait for agents" while the parent waits on
  it, "helper reported" when its report lands (never your prompt's
  bubble: the report is the agent's, not yours).
- prose shows the last two sentences; older lines fade out under the top
  mask.

## the stage: a thread

opening a window grows it into the thread (a shared-element transition:
the window's rect becomes the stage, its colour floods the ground, the
other windows recede). back shrinks it into its window, which is by then
showing the tail of what you just did.

```
 ┌──────────────────────────────────────┐
 │ ‹                          ◫    ⋯    │  the bar: details, the menu
 │ ledger                               │  the title block scrolls away;
 │ move invoices to the new ledger      │  the bar condenses once it has
 │ ● working 3:40, 2 agents      stop   │  live line, tap for the agents
 │ opus 5.5, high · 41% of context ·    │  facts line, tap for details
 │ $1.84 ›                              │
 ├──────────────────────────────────────┤
 │                  write the migration │  you
 │ ▸ 14 steps, 3 files, dry run 4,212   │  the work, folded
 │ clean for 4,209 invoices. three rows │  prose
 │ have negative totals...              │
 │ ┌──────────────────────────────────┐ │
 │ │ how should i handle the three... │ │  an ask, where it happened
 │ │  migrate them as refunds         │ │
 │ │  skip them and list them         │ │
 │ └──────────────────────────────────┘ │
 ├──────────────────────────────────────┤
 │  next: then add a changelog entry   x│  the queue, above the composer
 │ ┌──────────────────────────────────┐ │
 │ │ reply...                     ↑   │ │  composer (a window, composer.md)
 │ └──────────────────────────────────┘ │
 └──────────────────────────────────────┘
```

### the transcript

- **the daemon decides where everything goes** (architecture.md,
  transcripts). every message and part carries the daemon's id, deltas
  land at their offset, and every hop resumes by sequence number, so a
  turn cannot settle out of order, vanish or double.
- **your message** is a bubble on the right: light on the dark flood,
  the repo's deep pair on the light flood, so it is the strongest thing
  on the page in both appearances (colour, below). **the work** between
  your message and the answer folds into one mono line that counts it
  (steps, files, commands, the result); tap to unfold every step, with its
  per-step rung from cmx2. **the prose** is sans at reading measure.
- **diffs** sit in a bed at full stage width, collapsed to the file list,
  expanded per file. **code** is mono, highlighted, horizontally
  scrollable inside its own bed under a slim header that says its language
  and holds "copy" (code, below); the page never scrolls sideways.
- **subagents** appear where they were spawned as small windows in the
  transcript, live while they run; tap to open one as its own stage, back
  returns to the parent at the same scroll position. as built
  (`thread.md`, an agent's own thread): the agent's row is the small
  window, its open body holds the door, and the agent's stage is a layer
  stacked over the parent's, which stays mounted and inert beneath it.
- **an ask** sits where it happened; while it is open and scrolled out of
  view, a pinned line above the composer carries the question and scrolls
  back to it, so it is never lost and never shown twice. a **review** that
  is waiting gets the same line while its card is out of view: "ready to
  merge" and the agent's note on one line (named "ready to merge: <note>.
  go to it"), and a tap scrolls to the card, the one scroll the stage makes
  for it, since the person asked. a card arriving never scrolls the stage
  by itself unless the reader is at the end, where the end is followed as
  any new row is; a reader scrolled up, or landed on an older turn by a
  link, is carried by the line. an ask's line outranks the review's: one
  line at a time, and the review's comes back when the ask's goes. a review
  chunk that cannot load (a page from before an update) is one card in
  words, "the review did not load", with a "reload" button. the card folds to
  "answered, 23:49" once answered.
- **scroll.** while you are at the bottom, new text keeps you there. the
  moment you scroll up, nothing moves; a "new below" pill in the repo's
  tone counts what arrived. reopening a thread restores where you were.
  one exception, by the reader's own hand: sending a message takes you to
  the end, where it lands, wherever you had scrolled to.

### the composer

- the draft is saved per thread on every keystroke and survives a
  relaunch, an update and a crash.
- **when the agent is busy, send queues**; the queue is a short stack of
  cards above the composer, in order, each with "unsend", and one "run
  now" (stop the turn, run the queue). a second control, "steer", sends
  into the running turn (cmx2 steer) for the moments you need to redirect
  it without waiting.
- **send is honest.** your message appears at once, faded, and becomes
  solid when the server acknowledges it with an id. if it fails it stays
  where it is with "not sent, tap to retry". it never disappears, never
  doubles (an idempotency key, `cmx2-asks.md`), and "sent" is never
  inferred from the text echoing back.
- `/` commands, `@` files, `!` shell, photos, model and effort for this
  message live in one row that appears when the composer is focused, so
  the resting composer is one quiet line.
- **voice.** on the phone and ipad, the keyboard's dictation (the web
  speech api is unreliable in standalone mode). on the mac, the board's
  talk key fills the focused thread's composer exactly as today.
- the keyboard never covers the composer or the last line: the stage
  follows the visual viewport, and opening the keyboard keeps the bottom
  of the transcript anchored (the ios viewport scar, `scars.md`).

### the header, the details and the menu

the resting screen once said nothing of the thread's current model, the
models it had used or its stats (usage, cost), and the menu led with
turns (2026-10-02). so what a person checks
about a thread is on its resting screen, and the long tail lives behind
`⋯`:

- **the facts line**, under the live line in the title block: the model
  the newest turn ran on with its effort ("opus 5.5, high"), how full the
  context is ("41% of context") and what the thread and every agent under
  it have spent ("$1.84"),
  joined by " · ", each part left out while it would say nothing (a
  context under 1%, a spend under a cent). a quiet line (13 px, the second
  ink) ending in a chevron, and one button that opens the details, named
  in full for a screen reader.
- **the bar** holds the details toggle and `⋯`, and `‹` on the deck;
  nothing else. the toggle is the glyph of a frame with a pane on its
  right, in the bar's quiet disc, and says its state in the glyph: the
  pane is filled while the details show. nothing about it is lit in the
  tone, since at the rail the details show most of the time. the phone
  has no toggle: the facts line and the menu open the details there.
- **details.** (a) **this thread.** four tiles (spent; tokens, with the
  share read from cache; the context's fill, with a meter and where it
  compacts; steps, "in 9 turns"), then the branch and whether it has
  uncommitted changes; (b) **models.** every model the turns ran on with
  its effort, newest first, how many turns and what they spent; (c) the
  **agents**, each with the door into its stage; (d) **files changed**,
  newest edit first, with their counts. the thread's own spend has one
  source, its turns, so the models add up to it. the spent tile says the
  whole tree: the thread's turns and every agent under it at any depth,
  each agent's spend the daemon's account of its session (`info.cost`,
  which never counts its children, so nothing counts twice), or the sum of
  its held messages once the fleet has let it go. with agents the tile is
  a button ("$0.40 by 3 agents" under the figure) that opens **the spend**:
  a modal card of the sheet's glass in the top layer over a dimmed page
  (escape, its ×, or a press outside it closes it; focus returns to the
  tile). it holds the total, then this thread's own spend, then every
  agent, each under the agent that started it (14 px in a level), the
  dearest first among siblings, with its share of the total; a row is the
  door into that agent's stage. an agent whose spend is not known (the
  fleet let it go and no thread of it is held) says "not known", stays out
  of the total, and the total says so. a model has one name in the whole app
  ("opus 5.5"; the composer's chip says it the same way), and a turn whose
  model changed says so in the turns list ("switched to opus 5.5, high").
  - where they show: the **inspector**, the column beside the stage at the
    rail 1400 wide and up (one layout law, below); **docked** beside the
    log in a wide stage below that, a surface pressed into the flood (a
    well, not glass), because a person reading at a laptop or an ipad
    keeps watching the figures while the log moves; a **sheet** on the
    phone, headed by the thread's title and "repo, on host".
  - not yet: processes with kill. cmx2 serves a session's processes
    (`/session/{id}/procs`, `/proc/{id}/kill`); boxbox's server does not
    route them yet, so the details say nothing about processes rather than
    guess (`docs/open.md`). the worktree review (diff, merge, discard) is
    routed (`docs/architecture.md`, review).
- **menu.** turns (the list of prompts and reports, shown where the
  details would be), details (with a count, "2 agents, 3 files"), show
  thinking, then the law's long tail as it is built: rename, model and
  effort defaults, fork, compact, revert to a turn (also on each turn's
  own menu), open a terminal here, copy link, archive.
- **archive** (built): the menu item swaps the menu for one question in
  words, "archive this thread? it leaves every list on every device. its
  history stays on disk.", with "keep it" and "archive it". focus goes to
  "keep it" when the question opens and back to "archive" when it is
  declined; the closed menu is `inert`, so its items are not in the
  accessibility tree. a thread that is working adds "it is working now,
  and archiving stops the turn." (the daemon aborts the turn itself, so the
  app does not refuse). before it asks the daemon, boxbox marks the stop as
  the person's own action, so no "stopped" push goes out for a thread the
  person just archived. the call is
  boxbox's `POST /api/hosts/:host/sessions/:id/archive`, which sends
  cmx2's session PATCH with `time.archived`. on success the deck closes
  the thread back to home; the strip and the rail put the next window on
  the stage, since their stage never empties. a refusal (the daemon says
  no, or a thread it no longer has: "that thread is not on <machine> any
  more. it may have been archived") shows the words in the menu. cmx2 archives imported
  history too at the pin; it refuses nothing here. archived threads leave
  history too: cmx2 lists none of them, and opening one that was archived
  elsewhere is a not-found, not a wait.

## the terminal

the long tail held to the same bar: one pane, one
tap from the machine it runs on, and "open a terminal here" in the thread
menu when the thread lane places it. the wire and the relay are
`terminal.md`; decided in m7:

- **where.** each machine window lists its open terminals as rows in one
  surface pressed into the window (name in mono, the place it runs,
  "ended" dimmed, a chevron), its last row **new terminal** in the light
  tone, which opens the host user's login shell, and at that row's end the
  **shell picker**, a glass menu of the host's shells, the login shell
  first, one not installed shown and disabled (the machines, below). a
  new terminal is named for its shell, numbered when the name is taken
  ("bash 2"); names are unique on a machine, and a row's accessible name
  carries its machine ("open terminal bash on bench"), so every control's
  is unique on the screen.
- **the pane at each size.** under 1000 wide (phone, ipad portrait) it
  covers the frame and everything behind it is `inert`; back is `‹` or
  `esc` when the screen does not hold focus. at 1000 and up it sits on
  stage beside the machines column (the rail pattern), with no back. it
  appears with the content fade; nothing else about it moves.
- **the head.** the name, wide (22 px), which is the rename control; a mono
  line with the host, the place it runs and the grid (`bench · api ·
  44×44`); `kill`, confirmed in place ("kill" / "keep"). the destructive
  verb carries itself by its word, never by red. the head says nothing
  while all is well; after 5 s down, one quiet line ("the host is not
  answering: ..." or "not connected. trying again"); a resume under 5 s
  shows nothing (honesty, above).
- **the screen bed** is a window-plane object, dark (`#08090b`) in both
  appearances, because programs choose their colours for a dark ground.
  its sixteen colours are the design's own: the repo light tones for the
  hues, the text greys, and red. martian mono at 11 px under 700 wide
  (44 columns on a 390 phone; the face is wide, and columns are what a
  terminal is made of), 12.5 px to 1000, 13 px above; the bed runs to 8 px
  from the phone's edges for the same reason. the block caret blinks while
  the screen has focus (the one thing that blinks) and not under reduced
  motion.
- **the keys row** (touch, detected three ways): glass, riding on the
  keyboard: `ctrl` (latches for the next key, filled in the tone while
  latched), `esc`, `tab`, `⌃c`, and the four arrows (application cursor
  keys when the program asked for them). keys share the width, 44 tall; on
  the narrowest phones they are 40 wide rather than scroll sideways. a tap
  never takes focus from the screen, so the keyboard stays up.
- **no line mode.** v1 built a line field for touch; v2 does not. raw input with the keys row is honest about what a terminal
  is (tab completion, vim, passwords) and is one less mode to explain.
- **the keyboard** (decision 19): the pane stands on the keyboard's height
  only while an editable holds focus, read from the visual viewport, so the
  grid loses rows instead of hiding them; the screen's hidden field is 16 px
  on touch so ios never zooms.
- **when the shell ends**, the output stays readable, input stops, and a
  glass plate at the foot of the bed says what happened ("the shell
  exited.", "this terminal is gone. its host no longer has it.") with
  **new terminal** (same host, same place) and **close**. nothing
  pretends to bring a dead shell back.
- **a resync** after a long absence, when the host no longer kept what was
  missed, resets the screen and writes one dim line, `· older output was
  not kept ·`, then the tail.

## starting a thread

on every arrangement the home bar has a "new thread" pill (a plus on the
deck, the plus and the words on strip and rail), and on the deck the dock
under the windows is a button named for the place it starts in, in the
colour of the window in view. tapping either raises the composer as a
sheet set to the window you were looking at (its repo and machine); on a
machine with more than one, the machine is a choice, and the repos are
chips in their colours by recency, with an "other folder" finder for any
folder on that machine, typed or walked to. the sheet's top row says what
the new thread starts on (model and effort, changeable there); the plus key
adds a photo. sending does not close the sheet on a guess: it says the
thread is being made, says plainly if the machine refused, and when the
thread exists the stage opens on it, growing from the sheet's window the
way a tap on a window does (2026-10-01: the new thread opens; it
does not fly to a window on home and wait). on the mac `⌘n`
does the same from anywhere, typing included; `n` alone does when not
typing. the decisions are in `composer.md`.

## one layout law for three devices

layout follows the size of the window, not the name of the device. an
ipad in split view gets the phone layout; a mac on a portrait monitor
gets the ipad-portrait layout. three arrangements:

| arrangement | when | home | a thread |
|---|---|---|---|
| **deck** | width under 700 | full-height windows in a snap pager, one per screen, the next one peeking | fills the screen; back by button, edge swipe or pulling the header down |
| **strip** | 700 and up, portrait | the windows as a row across the top, 2 to 4 visible, tails live | always on stage below the strip |
| **rail** | 1000 and up, landscape | the windows as a column on the left, tails live | always on stage beside the rail; the inspector joins at 1400; both columns fold |

why the stage never empties at strip and rail sizes: on the mac, home was
a corridor, passed through on the way to the next thread, and people go
thread to thread directly. the rail is the
switcher and the watch: other agents stay visible and live while you read
one, which is what v1's "pit wall" was added for. on the phone, the deck
is home because the phone is hub and spoke (home to thread and back).

| | phone (deck) | ipad portrait (strip) | ipad landscape, mac (rail) | mac portrait monitor (strip) |
|---|---|---|---|---|
| windows | 330 × about 580, one in view | 240 × 200, tails 3 lines | 300 wide, 150 to 260 tall | 260 × 220 |
| stage measure | full width, 22 px gutters | 640 px prose measure | 680 px prose measure, diffs and code take the full stage | 720 px measure |
| an ask | a preview on the window (the window keeps its size); the thread holds the card | a preview on the window; the card is in the thread on the stage | as the strip | as the strip |
| body text | 16.5 px | 17 px | 15.5 px | 16 px |
| touch target | 44 pt minimum | 44 pt | 28 px (pointer), 44 pt on ipad | 28 px |
| details | sheet | docked beside the log | the inspector at 1400 and up, else docked | docked |
| the clock | none: the words take the width | in the margin | in the margin where the stage leaves room | in the margin |

### the inspector and the folds (the rail)

the desktop layout needed a right sidebar, and both sidebars needed to
collapse (2026-10-02). as built:

- **the inspector** is the column beside the stage at the rail 1400 wide
  and up: 330 px, flat on the ground (padding 26 by 22, its scrollbar
  hidden), holding the thread's details or its turns (the header, the
  details and the menu, above). it is quieter than the stage on purpose:
  figures to glance at beside the thing you read.
- **the rail folds** to a 76 px column, not to nothing, because the rail is
  the switcher and the watch: the fold toggle (its middle on the stage
  bar's control line, 46 px down), a new-thread disc (44 px, the solid
  pill's material), one swatch per window in the inbox order, scrolling
  and fading under the disc and the foot, and history and machines at the
  foot. a swatch is its window folded to 44 by 44: the window's gradient,
  lit top edge and highlight, its repo's first two letters in the light
  tone (or its favicon on a plate: the repo mark, below), and its state
  in the chip's vocabulary on its corner (wants you a
  light-tone badge ringed in the ground, working or queued a dot, done and
  not seen a tick, failed a red cross); the one on stage wears the ring a
  rail window wears. it is named and opened exactly as its window is.
  with a fine pointer a glass card names it after 250 ms; touch has no
  hover, and a tap opens the thread, whose title says it.
- **the toggles are a pair** at the two edges of the stage: the rail's at
  the end of its first row (atop the folded column), the details' in the
  stage's bar. each is a frame with a pane, the pane on its own side, and
  says its state by filling it; neither is ever lit in the tone.
- **motion.** the stage card's edge glides on the sheet spring by
  clip-path and its contents are carried by translate, with the layout
  committed once (first when the card grows, last when it shrinks, the
  arriving column drawn under the card while its edge uncovers it); a
  column arrives and leaves by opacity and a 16 px drift. where a wrapped
  paragraph would change width (the rail between 1000 and about 1075 wide,
  or 1400 to about 1468 with the inspector), a carry cannot follow it, so
  the content swaps on the fade instead. reduced motion: instant.
- **remembered on the device.** `boxbox.rail` (open, folded) and
  `boxbox.inspector` (details, turns, folded); keys `[` and `]` (input).

**an ask never grows its window, at any size** (2026-10-05, above). the
window of an asking thread keeps the size it rests at in the deck, the strip
and the rail, and shows the preview instead of the tail's foot (the
strip and the rail also give up the tail and the footer to it, and hold the
title to one line). the stage never moves for an ask: nothing is laid out
again, and nothing is covered or pushed down. you read one thread and
answer another by tapping the pill: the stage swaps to the asking thread
(strip, rail) or the thread opens full screen (deck), at its ask. a window
on the deck that is scrolled out of view says nothing more than it did; the
glide to an ask after 4 s idle, the cue and the capsule are as before.

### input

| | touch (phone, ipad) | keyboard (mac, ipad with a keyboard) |
|---|---|---|
| open a window | tap | `⌘1` to `⌘9` by position, or `⌥↑` `⌥↓` through the order |
| back | edge swipe, pull the header down, `‹` | `esc` (deck only; rail and strip have no back) |
| jump anywhere | pull down on the deck: all threads | `⌘k`: threads, repos, commands, "new thread in ..." |
| new thread | the dock | `⌘n` |
| send | the send button (return is a newline on touch) | `return`; `shift return` for a newline |
| steer instead of queue | long-press send | `⌘return` |
| stop the turn | the stop control in the header's live line | `⌘.` |
| answer an ask | tap the option | `1` `2` `3` while the ask has focus |
| thread menu | `⋯` or long-press the header | `⌘/` |
| fold the windows (the rail) | the toggle at the end of the rail's first row, or atop the folded column | `[` |
| fold the details (the rail, 1400 and up) | the details toggle in the stage's bar | `]` |
| the board | n/a | unchanged (decision 1): its focus and compose verbs drive the same stage and the same motion as a tap |

`⌘n` and `⌘1` to `⌘9` belong to the browser in a tab; the build verifies
them in the installed chromium pwa and falls back to `n` (when not typing)
and `⌥1` to `⌥9`. keyboard hints on
answer options show only for a fine pointer. `[` and `]` work like `n`:
only while no field has focus and no modifier is held, since the brackets
are characters a person types.

hover states exist only under `(hover: hover)`. long-press never opens the
system's text callout on controls (`-webkit-touch-callout: none`), and
text in the transcript stays selectable. while a thread is open on the
phone, everything behind it is `inert`: out of reach for fingers, focus
and screen readers. closing a thread returns focus to its window for
keyboard users only; a finger does not get a focus ring.

### moving between surfaces (the shell)

decided in the shell lane, where the law names the surfaces but not the
ways between them (the route table is `architecture.md`):

- **a screen's head** (the machines, settings) is a row with its way back
  on the left, `‹ windows` or `‹ machines`, quiet, the chevron a size
  larger than its word, and its verbs on the right; the title sits under
  the row, as a large title sits under a navigation bar. the stage keeps its
  own `‹` beside the thread's title.
- **the deck's edge swipe** goes back from every screen that covers its
  parent on the phone (the machines, settings, the terminal), with home's
  feel: the screen follows the finger 1:1, can be abandoned and settles on
  the snap spring, lets go past 28% of the width or on a flick, slides away
  on the sheet spring, and the parent arrives with the content fade.
- **`esc`** follows the back control wherever one exists. the terminal at
  1000 and up has no control, yet `esc` outside its screen still closes it:
  `esc` dismisses anything whose parent is on screen.
- **a screen swap** (home, the machines, settings) fades the new screen in
  on the content fade (160 ms, opacity only); the thread and the terminal
  keep their own motion. nothing fades on the first paint.
- **focus follows a screen swap for the keyboard only.** going in lands on
  the screen's title, coming back on the control that went in (the bar's
  "machines", the head's "settings"). a finger gets no ring.
- **leaving home** takes the thread off the stage and `‹ windows` puts it
  back, painted in place: you come back to what you were reading.
- **the gate** paints the app from the device's cache before the server
  answers, and says nothing while it asks; without a cache and without the
  server it says so in one line with "try again".
- **installed to the home screen.** the icon is a window, not a picture
  of one. the drawing in `app/public/icon.svg` is the violet pair full
  bleed in the window's own material (the highlight from the top left, the
  lit top edge), holding what a window holds: the repo's name in boxbox
  sans, a live tail in martian mono and the cursor, lit in the light tone.
  no placeholder bars, and the words are outlined to paths so every
  renderer draws them without the fonts. the maskable and the apple touch
  icons square the shape, since each platform cuts its own and ios paints
  transparent corners black; the maskable draws the work at 84% so it sits
  inside the safe zone (`scripts/icons.ts` says by how much). the
  manifest's theme and background are the dark ground, and the status bar
  keeps the system's default style, since the app never draws under it
  (decision 19).

## attention: push and the in-app signal

push is the product (decision 7). the ux side of it:

**who gets buzzed.** a device is *present* on a thread when boxbox is in
front on that device (visible and focused), the thread is visible there
(on stage, or its window in view), and it said so in the last 90 s
(decision 23). if you are present on
the thread anywhere, nobody buzzes. otherwise every device you enabled
gets the push. walking away from the mac with the thread open still
reaches the phone.

| event | pushes | delay | title | body |
|---|---|---|---|---|
| a question or permission | yes | none | "ledger wants you" | the question, or the command it wants to run |
| a turn you started is done | yes | 10 s, cancelled if you look or the agent continues | "api is done" | the result line or the last sentence: "118 passed. all four new tests..." |
| a real fault | yes | none | "infra stopped" | the reason in plain words |
| a worktree is ready to review | yes | none | "site is ready to merge" | the agent's note, else the branch |
| your own interrupt, a subagent, a replayed event | never | | | |

- one notification per thread (tagged by thread), so a thread's newer
  news replaces its older banner instead of stacking.
- tapping opens the app on that thread with the ask focused, painted from
  the device cache on the first frame, then made current.
- on the mac the push carries the answer options as buttons (chromium
  only); on ios it is a tap.
- settings: per device, which of the four kinds push. that is the whole
  settings page for push.

**inside the app**, with no push: in the rail or strip, the window changes
state in place and rises to its rank. on the phone inside another thread,
a slim capsule in the repo's colour slides down under the status bar,
"ledger wants you"; tapping it swaps the stage (the current thread shrinks
away, the other grows in) and opens that thread with its ask in front, the
card focused, as the strip's pill does. it leaves after 6 s; the ask stays at
the front of the deck.

## honesty: how the connection feels

v1 taught people to reload. v2's promise is that nobody needs to, and
that the screen never lies about how current it is.

- **cold launch paints the last known state on the first frame** from the
  device's cache (no spinner, no skeleton), then catches up without
  motion.
- **no "reconnecting" banner** for a normal resume: the stream resumes
  from its cursor and the gap closes silently.
- **if the stream is down for more than 5 s**, live tails stop moving, the
  clocks stop, and one quiet line in the header says "offline, last update
  23:41". sends made while offline queue on the device, faded, and go out
  in order when the stream is back.
- **updates never reload under you.** a new build waits: "update ready"
  in settings, applied at the next cold launch. until settings exist (m7)
  the line sits in home's bar: "update ready. it applies the next time
  boxbox opens." (`docs/home.md`). only a protocol break
  forces the issue, with one screen and one button: "boxbox was updated.
  reload".
- **every failure says what failed and what to do**, in the interface's
  voice: "not sent, tap to retry", "the vm is not answering. last seen
  23:41".

## visual system

### type

- **mona sans** (variable, width 75 to 125, weight 300 to 800) for the
  interface and the agent's prose. titles run wide (width 108 to 122) and
  tight; prose runs at normal width. one family carries the personality
  through width, not through a second display face.
- **martian mono** (variable, width 75 to 112) for tool lines, code,
  diffs and counters, set narrow (width 90) so a tool line fits a window.
- numbers are tabular everywhere they change.
- **as shipped** (m0): mona sans carries a reserved font name, and the app
  ships a subset (latin, arrows, keys, blocks) with optical size pinned
  and weight 300 to 800, so it is renamed **boxbox sans** as the ofl asks
  of a modified version (`scripts/fonts.sh`, 140 kb). martian mono ships
  subset under its own name (50 kb). both load with `font-display: swap`
  and are cached forever under their hashed names.
- scale: 12.5 chip, 13.5 meta, 15.5 to 17 body (per device, above), 22
  window title, 28 to 34 stage title. no all-caps labels, no letterspaced
  eyebrows.

### colour

- **ground.** dark first (phones are often used in the evening and at night). `#0b0c0f`
  ground, text `#f4f4f6` at 100, 62 and 38%.
- **light appearance** follows the system and is designed, not inverted
  (as in v1 both are first-class; dark is not the identity):
  ground `#f3f3f1`, text `#101114`. windows are made of their repo's
  colour in both appearances: the deep pair on dark, the light tone washed
  into white paper on light (the two appearances, below); the thread flood
  uses the repo's light tint.
- **repo colours.** a curated set of ten deep hues, each a pair (top and
  bottom of the window gradient) plus a light tone for chips, asks and
  accents. a repo gets one by a stable hash of its path and keeps it
  forever; the user can change it. every pair holds 4.5:1 for body text
  in white.

| name | top | bottom | light tone |
|---|---|---|---|
| green | `#1b4a33` | `#0c2419` | `#8fe6a5` |
| violet | `#34298a` | `#171240` | `#b7abff` |
| rose | `#5a1f45` | `#2a0d20` | `#ff9fd0` |
| gold | `#4a3b12` | `#211a07` | `#f3d474` |
| blue | `#173a5e` | `#0a1a2e` | `#9cc8ff` |
| teal | `#10484a` | `#062123` | `#7fe0d6` |
| clay | `#5a2c19` | `#29130a` | `#ffb48c` |
| plum | `#46205c` | `#1f0e2b` | `#dfa8ff` |
| olive | `#3b4216` | `#1a1d08` | `#d4df7c` |
| slate | `#2b3441` | `#12161c` | `#b9c6d8` |

set in m5 (`docs/home.md`): every pair holds 4.5:1 for white body text at
both ends, the light tone holds 4.5:1 on the top colour, and the bottom
colour holds 4.5:1 on the light tone (`app/src/ui/window/repo.test.ts`).

- **red** (`#ff6b6b` on dark, `#ad2323` on light) means failure and
  nothing else. diff lines use `#9ff0b3` and `#ffa3a3` on dark, `#0d6329`
  and `#a8233b` on light.

### the two appearances, as built (2026-10-02)

light mode once read white on white and the stage was always black, not
colour matched (2026-10-02). what holds both appearances together now:

- **one number.** the appearance is `--L` (0 dark, 1 light, the system's
  unless settings chose), and every colour token is written once as
  `color-mix(in srgb, <light> calc(var(--L) * 100%), <dark>)`, exactly the
  dark value at 0 and the light one at 1 (`app/src/styles.css`). a token
  cannot be set for one appearance and forgotten for the other, which is
  how a pill rule written only for the system's light mode came to ignore
  the device's own choice.
- **the window plane is lit in its own colour** (2026-10-02: dark
  slabs on a light page read as an afterthought; this
  replaces the earlier rule that the plane kept its deep colours in both
  appearances). windows, the composer's window and what it raises, the
  new-thread sheet, the capsule, a machine, a folded rail's swatches and a
  repo's mark follow the page's appearance and are built from the plane's
  own tokens (`--win-*`, `--accent`, `--on-accent` on the plane block in
  `app/src/styles.css`), read from the surface's palette (`--p1..3`: the
  repo's top, bottom and light tone, or the app's violet). dark is the
  deep pair, the light tone's accents, a white 16% lit edge. light is the
  light tone at 30% in white at the top and 12% in near-white at the foot,
  a touch lighter than the flood so a window over the stage still reads
  raised; accents are the deep top colour with near-white ink on them;
  quiet fills and pressed wells are the deep colour at a few percent, so
  they take the window's hue and never read grey; the edge is a white lit
  top and the deep colour at 13% following the corners, so a pale card
  holds its shape on the pale ground without a grey border; the cast is the
  window's own bottom colour at 32% with a short contact shadow. your words
  in a window are the deep pair on light, as on the stage. pieces of the
  plane that float (menus, the sheet, queued cards) are a deeper card:
  `--win-deep-1..2`. `app/src/ui/window/plane.test.ts` proves the plane's
  words on its material for all ten palettes in both appearances (the
  third ink too, on light), red on the failed chip's own red breath, and
  that every dark plane token is exactly the literal the plane used before
  it had tokens.
- **the page's inks** hold the stage's steps on light: the second and third
  are the ink at 74% and 66%, so the third holds 4.5:1 on the ground and on
  a window's lightest material and a word set in it is never a contrast
  bug. dark keeps its third ink (38%) for decoration. a quiet pill on the
  light ground carries an ink hairline in its edge (`--pill-edge`), so it
  holds its shape on the pale page.
- **one dark thing on a light page, by law.** the terminal's screen bed
  (programs choose their colours for a dark ground).
- **the flood** (the stage's ground, `--flood-1..3`): dark, the top colour
  at the top, the bottom colour by 40%, and at the foot the bottom colour
  with 4% of the light tone; light, the light tone poured in at 62% into
  white at the top, 40% into `#f7f7f5` by 40%, and 28% into `#f3f3f1` at
  the foot with 4% of the deep top colour breathing into it, so the stage
  is the repo's colour and not a tint of the page (the first light flood,
  46, 20 and 14%, read washed out). it never reaches the bare ground, so
  the stage reads as a surface to its last pixel and its corners hold, and
  the card's edge separates from the page by its colour. the highlight from
  the top left is white at 8% on dark and 50% on light.
- **accents follow the flood** (`--accent`): the light tone on the dark
  flood, the deep top colour on the light one; a primary control is filled
  with it and inked with `--on-accent`. on the page the app's own violet
  pair does the same.
- **your message** is light on the dark flood and the deep pair on the
  light one: the strongest thing on the page in both, not an inversion.
- **ink tints, not grey.** the stage declares the page's base tokens again
  with the repo's hue in them on light, and each is exactly the page's
  value at `--L: 0`. ink is a hue black (the deep bottom colour at 12% in
  `#101114`), its second and third steps are that ink at 74% and 66%, and
  the third holds 4.5:1 on light too, since words are set in it (a dismiss,
  a placeholder, a time). lines and a pointer's tint are the deep top
  colour at 17% and 7%, a pill the light tone at 34%, a round control a
  lit white knob with the repo's edge, and glass edges and shadows take the
  repo's hue, so nothing on the stage reads as the page's grey.
- **paper, not slabs.** on the light flood a well (an open row, a report,
  an ask's option, the tape at rest, the docked details) is lit paper: white
  at 52% over the flood, a white lit top, the repo's hue as its edge and a
  short soft shadow in its bottom colour. a bed (code, output, a diff)
  lifts toward white with a trace of the hue and is pressed into whatever
  it lies on. the details' figures and lists are cards of the light tone
  washed into white (`--paper-1..2`), so the inspector on the grey ground
  is made of the same material as the stage beside it. dark has no paper:
  those surfaces keep their quiet ink fills and the rows sit where they
  always did.
- **proved, not eyeballed.** `app/src/ui/window/stage-flood.test.ts`
  evaluates the css's own recipes (`css-colour.ts`) for all ten palettes in
  both appearances: the text, its second ink, the prose, the accent, the
  diff colours on every stop and on a bed, and red below the title block
  hold 4.5:1; on light the third ink holds it on every stop, on a well, a
  bed and the paper, the details' paper holds the inks, the diff colours
  and red, and the pill holds the text and its second ink. a dark test
  holds every base colour token the stage declares again equal to the
  page's own at `--L: 0`. a component rule is outside what the tests can
  read: its dark side is held by screenshot against the commit before
  (dark shots of the same stories, diffed pixel for pixel).

### the repo mark (2026-10-02)

the mark is meant to be tasteful, deliberate and intentional: a repo's favicon in a
squircle tile beside the repo's name wherever the name appears. identity
only, never state: it does not pulse, badge, escalate or animate beyond its
one arrival. the repo's name beside it is the accessible name, so the mark
is `aria-hidden`. one component, `RepoMark`
(`app/src/ui/repo-mark/`), used by every surface.

- **the shape** is a true squircle, a superellipse (`|x|^5 + |y|^5 = 1`,
  the continuous corner of an ios icon: the curve eases into the straight
  edge instead of meeting it), not a `border-radius`. it is one svg path in
  a 100 box used as a css `mask-image` (and `-webkit-mask`, since Safari
  has no `corner-shape`), so every size shares one definition and it
  scales without redrawing. `shape.ts` draws the path, `repo-mark.css`
  holds it, `shape.test.ts` proves they are the same.
- **identity** is `{host, root}` with the project root (`repoRootOf`),
  never a worktree's directory, so one repo is one mark everywhere; its
  colour is `colourOf`, as the window's is.
- **no favicon, while it loads, or when it never loads.** the tile is the
  windows plane's material in the repo's colour (the mark is a surface of
  the plane, `plane-window`: the deep pair on dark, the light tone washed
  into white on light, and the highlight from the top left) with a
  hairline ring in the plane's accent (its light tone on dark, its deep top
  colour on light) and its initials in that accent: two letters from a
  28 px tile, one letter, set larger, below it (two at 8 px are a smudge).
  a bare mark (on a swatch, which is the same material) shows only its
  initials until a favicon comes. the initials hold 4.5:1 for every hue
  under the highlight and at the tile's foot, in both appearances
  (`shape.test.ts`, from the css's own recipes).
- **a favicon.** the image sits in the middle two thirds of the tile on a
  plate chosen so it cannot vanish, the bug v1 never fixed (dark on dark).
  the image is read once (`probe.ts`: a 48 px same-origin canvas draw) and
  `plate.ts` decides, pure and tested:
  - **light plate** (`#f4f4f6`) for an icon whose ink is dark; **dark
    plate** (`#222328`, the provider mark's glass settled on the ground,
    opaque so it reads on the light page too) for light or bright ink. the
    plate is the one that loses less of the icon: the alpha-weighted share
    of pixels under 2:1 against each plate decides, the icon's mean
    luminance breaks a tie. a dark outline round a white fill goes to the
    dark plate: the fill is most of the ink.
  - **full bleed, no plate**, when the image is an app icon of its own:
    opaque corners, at least 98% covered and within 10% of square. an
    opaque rectangle, a disc, or an image with one empty corner keeps a
    plate, since filling the tile would crop it or show its corners.
  - an image with no ink (a blank svg) is no icon: the colour tile stays.
  - the ring carries the repo's accent round every plate, so identity
    still whispers.
- **where the answer lives, and how long it is believed.** the store
  (`state.repoIcons`, keyed by host and root), so every mark of one repo
  shares one request and one reading (a window, its swatch, its history
  rows). the read is a `fetch`, not an `<img>`, because only a fetch sees
  the status and the server's `x-repo-icon`, and what the server says about
  why there is no icon decides how long that is believed. the app asks
  again on the server's own clocks (`icons.ts` is the state machine):

| answer | server's max-age | asked again after |
|---|---|---|
| an image (200) | 6 h | 6 h, on a later mount; a mark that is up keeps its plate |
| `none` (searched, no icon) | 30 min | 30 min, so a favicon added later turns up in about half an hour; any class the app does not know is read as `none` |
| `unsupported` (the daemon has no file-read route yet, a28) | 5 min | 5 min |
| `unproven` (the host has not shown that root to be real) | 60 s | 60 s |
| `refused` (the host user's home or a directory above it, never listed) | 1 h | 1 h |
| `retry`, a dropped connection, a timeout (15 s), an abort, a 5xx, a closed gate | `no-store` | 15 s, doubling (30, 60, 120, 240, 480, 960 s) to a cap of 20 min |

  a transient is never remembered as "no icon": only a reply that says so
  is. a mounted mark owns the timer that asks again when its verdict falls
  due (cleared when the verdict, the repo or the mark changes), so a retry
  recovers, and an unproven root is believed after a minute, without a
  remount. a hidden page asks nothing: the ask waits for the page to be
  shown and is made then if it is still due (the listener is the mark's and
  is cleared with it). the cap keeps a host asleep overnight, or a project
  the daemon cannot read, to about thirty asks in eight hours, not one every
  two minutes. while a repo is asked again its old verdict stays in the store,
  so a mark never blanks, and a second mark never asks at the same time; a
  retry that follows an image keeps the plate. an empty root (a thread
  whose info has not arrived) is not asked about.
  the store is bounded: 96 repos, the oldest answers go first, never one a
  mark on screen holds and never one being read for the first time.
  each read is one `repo.icon` telemetry row (the outcome and the
  milliseconds, no host or repo name), so a cold page whose reads queue
  behind the daemon's file lookups shows as long `retry` rows.
- **behaviour.** the box is fixed at its size from the first frame, zero
  layout shift. the initials to favicon change is one opacity crossfade
  (the fade curve; reduced motion keeps its 120 ms fade); an image the
  browser already holds is there at the first paint with no fade, and an
  error leaves the colour tile. `pointer-events: none`, no selection.
  every rule is scoped under `.rm` so a host surface's `span` or `b` rule
  cannot reach into the mark.
- **size** is the one custom property `--mark` (as `composer/mark.css`'s),
  set by the component; letters, ring and plate are fractions of it.
  sizes as used: 20 (the stage's repo line, the fold's hover card), 22 (a
  window header, a sheet chip), 30 (a folded swatch), 32 (a sheet row), 34
  (the capsule, beside its 34 px "open"), 36 (a history row, a settings
  row).
- **the governing rule** (learned in v1): show the mark wherever identity
  does not already ride the surface, and let it lead; a trailing mark
  beside names of any length reads as scatter. surfaces:

| surface | mark | why |
|---|---|---|
| window header (deck, strip, rail) | yes, 22, leads the name | the name is the only identity the header carries; the window's gradient is shared with its neighbours of the same repo |
| history row | yes, 36, replaces the colour bar | the bar said the repo's colour; the mark says it with the favicon, so colour is not said twice. the repo's name stays in the meta line |
| new-thread sheet: repo chips | yes, 22, replaces the 8 px dot | the dot was this slot's colour; the selected chip's light fill still reads it |
| new-thread sheet: finder rows | yes, 32, spans the name and the path | a list of repos by name, and the leading mark is the scan line |
| folded rail swatch | yes, 30, `bare` | the swatch is already the repo's colour and spelled its initials, so a tile in a tile is not drawn until there is a favicon; then the plate shows (its state moves out to the corner the plate leaves free, and rings in the swatch's colour) |
| fold hover card | yes, 20, leads the repo name | a name on glass with no colour of its own |
| capsule, "X wants you" | yes, 34, replaces the colour dot | it is the one place a repo speaks over another's window |
| stage's repo line | yes, 20, leads the name | the line names the repo; the flood is its colour but the favicon is its face. the name is now the project root's, as the window says it (it was the worktree directory's) |
| settings, per-repo defaults | yes, 36 | a list of repos on the plain page |
| home's summary line ("api wants you, 2 working") | no | a sentence of parts that wrap between them; an inline mark would break the line's measure, and the ink colour already carries the repo; the capsule and the window carry the mark |
| composer dock and the composer | no | they are windows of the repo's own colour, and the window in view above says the repo |
| composer full head | no | it carries the thread's title, not a repo |
| clear and ask cards | no | named by the window they sit in |

### code, and copying (2026-10-02)

code had no copy control, no highlighting and no language label. the law
was silent; what is decided, and why it looks as it does:

- **one block everywhere.** a fence is the output bed's material (radius
  16 on the answer and a said row, 12 on a report and a summary; the bed's
  tint and its edge, `--bed-edge`: the hairline in dark, near-white paper
  edged in the repo's hue in light, as every bed is) with a header inside
  it, 30 px, flush with the code's own left padding: the language in mono
  10.5 px in the second ink on the left, the control on the right. the
  header carries information only (what the code is, how to take it); there
  is no divider under it and no label on a block with nothing to say. the
  code scrolls under it, fading at the edge it continues past; the header
  does not move. the block does not clip (its control's hit area is wider
  than its strip), so the code's own box carries the bottom corners.
  - **one line, no language.** a strip holding one lone word ("copy") is
    30 px spent on nothing, so such a fence is one row: the line, which
    scrolls, and the control at its end, at the same right inset the
    headers' controls have. a fence of several lines with no language keeps
    its strip.
  - **the command's and the output's beds** in an open shell row are this
    block: a header of 30 px (the word "command" on the left of the command's,
    which says what the bed is, and the output's line count, "22 lines", on
    the output's, which says what it holds), the control at the same inset,
    the bed's own text under it, over the same material and edge. an
    earlier cut laid the control over the bed's corner and cut a notch in the
    bed's mask to keep text from running through it; it cut a hole in the
    bed's own fill and hairline and read as a line of output, so the three
    are one family now: the same control size, type, inset and baseline.
- **the control** is two sheets and the word "copy", the second ink,
  brighter under a pointer, always there (the phone has no hover). 20 px
  tall, with a hit area of 44 drawn past it. in a code block and on a bed it
  is mono 10.5 px, the machine's face, like the label beside it; in a
  report's header and on the reply's line it is sans 12.5 px, the face
  around it (a meta word among words is not the machine's). on success the
  glyph becomes the thread's tick, which draws itself by a clip (the
  motion law's one allowed property for it, and off when motion is reduced,
  by the system's setting or the app's), the word "copied" and the
  accent hold for 1.6 s; on refusal the word says "could not copy. select
  the text instead" in red for 4 s, or what can be done where the text
  cannot be selected by hand (an output with its middle cut, a report shown
  clamped). it is the same control on a code block, under the answer, in a
  report's header, and on a command's and its output's beds. the glyph is a mask over `currentColor`, so it takes
  the control's colour in every state, and it is drawn by the stylesheet.
- **the colours of the code** are five hues from the repo palette's own
  light tones (deep versions in the light appearance), one for each thing
  a language is made of, and the quiet ink for what is said around it.
  they are fixed and not the repo's accent: the accent is one of those ten
  hues, so keywords in it would be the same colour as strings, numbers or
  functions in the repo that shares it. every token reads `--L` like the
  rest, and every one holds 4.5:1 on the bed over every stop of every
  repo's flood, in both appearances, which `highlight-colours.test.ts`
  evaluates from the stylesheet's own recipes:

  | token | used for | dark | light | lowest ratio, dark / light |
  |---|---|---|---|---|
  | `--hl-key` | keywords, tag names, sections | `#ff9fd0` | `#9a1f63` | 7.20 / 6.40 |
  | `--hl-str` | strings, regexps | `#f3d474` | `#755400` | 9.38 / 5.82 |
  | `--hl-num` | numbers, literals, symbols | `#8fe6a5` | `#14633a` | 9.08 / 6.12 |
  | `--hl-fn` | functions, attributes, properties | `#9cc8ff` | `#1a5594` | 7.85 / 6.35 |
  | `--hl-type` | types, built-ins, classes | `#b7abff` | `#4b3bb0` | 6.66 / 6.90 |
  | `--text-2`, italic | comments, meta, tags | | | 5.72 / 7.42 |
  | `--text` | the rest | | | 12.38 / 15.74 |

  (the light column was measured again when the light mode landed, since its
  flood, its bed and its second ink changed under the code: the five hues
  hold 5.82 to 6.90, and comments, in the second ink, read at 7.42 where
  they were 5.06. dark did not move.)

  a diff fence tints a whole line with `--add` or `--del` at the diff bed's
  own shares (9% on dark, 15% on light): 7.97 / 4.96 and 6.05 / 4.69. the
  control's words (the second ink, the accent when copied, red when
  refused) hold 4.85 / 6.71, 5.76 / 8.01 and 4.54 / 4.91 on the bed and on a
  report's well.
- **highlighting** is highlight.js 11.12.0's core with 22 registered
  grammars and no auto-detection, in a chunk of its own (about 28 kb
  compressed): the app's first-load script is held to 120 kb compressed
  (`architecture.md`) and sat at 118. the chunk is fetched when a thread
  first shows a fence and on a quiet moment after the first surface paints,
  so it has usually arrived; a fence painted before it is plain and is
  painted again, once, when it lands. a cache of what was painted, by
  grammar and code, holds 2 mb at most and drops the least recently used.
  the language names and aliases are `languages.ts`, held to hljs's own
  registry by a test.
- **the copy** is in the first-load script, in the tap's own call (ios allows
  the textarea way only there); what follows it (how long the outcome holds,
  the announcement, naming namesakes) is a small chunk of its own.
- **making room** for both, the providers' marks left the script: 26 kb raw
  of svg path data (about 10 kb brotli) became one inline sprite in
  `index.html`, written by the build (24.9 kb raw, 9.4 kb brotli). that is
  the same bytes moved, not bytes saved, and it is said so: the script budget
  measures what has to be fetched, parsed and run before anything draws, and
  the document is parsed first, so a mark is drawn in the composer's first
  frame (`composer.md`). so that the document does not become where what the
  script budget turned away goes, `index.html` has a budget of its own, 12 kb
  brotli, and `scripts/compress.ts` gates both. merged with the light mode,
  the review card and the repo mark, the first-load script is 115.6 kb and
  the document 9.8 kb.
- **one painter** paints every markdown surface (`markdown.ts`): it parses
  into a detached template, dresses the fences, and replaces only the
  top-level blocks whose html changed, so a block that has settled keeps
  its node, its focus, its hover and its "copied" while a reply streams on.
  the sanitiser is the one it always was, run before anything of ours is
  added; the controls are made by our code after it and are never allowed
  through it. clicks are one listener on the surface.
- **not counted.** boxbox does not count copies. `telemetry/schema.ts` has
  no kind for a client's own action of this sort, and none was invented.

### depth

three planes, and every element belongs to exactly one:

| plane | what | material |
|---|---|---|
| ground | the page | flat, with a soft glow of the window in view |
| windows | windows, the stage, asks, the composer and what it raises, the capsule, a machine, a swatch, a repo's mark | the repo's material for the appearance (the deep pair on dark, the light tone in white on light), a lit top edge, a highlight falling from the top left, a long soft shadow in the window's own colour; the composer's menus, its queued cards, the new-thread sheet and the pair sheet are deeper cards of the same plane (`--win-deep-1..2`), not glass |
| glass | the stage's menu, cards that float over the stage (the ruler's, the pinned ask), a fold's name card, the shell picker's menu, the terminal's keys row and its ended plate | backdrop blur 24 px, saturate 1.4, a hairline lit edge |

options in an ask are pressed *into* the window (inset shadow); the
primary option sits *on* it in the accent (the light tone on dark, the
deep top colour on light). the composer is a window,
not glass (`composer.md`, the direction).

- **the stage's bar is not glass.** frosted glass over a scrolling log
  smeared a white bubble into a grey blob under the title. the bar sits
  on the flood, and the log dissolves under it: the scroller's top edge
  is a 40 px eased mask from just above the bar's bottom, so nothing is
  ever legible, or smeared, behind the title. the big title rests below
  the band.
- **the stage at the strip and the rail is a card.** radius 30, the long
  soft shadow (`--lift`), and a rim drawn above its content (a lit top
  edge and a 1 px edge that follows the corners), in both appearances.
- the docked details are a surface pressed into the flood, not glass:
  they sit in the stage beside the log, not over it.

## motion law

**two springs, used everywhere**, generated into css `linear()` curves:

| spring | stiffness, damping | settles | used for |
|---|---|---|---|
| snap | 380, 32 | about 420 ms | position: reorders, chips, the tail pushing up, an option flying into place, pager dots |
| sheet | 250, 27 | about 560 ms | surfaces: a window growing into the stage and back, sheets, the capsule |

sampled to a rest threshold, snap settles in 467 ms and sheet
in 508 ms (`app/src/motion/springs.ts`).

plus two short curves: content swaps fade in 160 ms
(`cubic-bezier(.2,.8,.2,1)`), and streamed words settle from a 5 px blur in
360 ms.

- **gestures follow the finger 1:1** and release into the spring with the
  finger's velocity. a back swipe can be abandoned halfway and settles
  back.
- **only transform, opacity, clip-path and filter animate.** never width,
  height, top or left in a live screen.
- **streaming.** deltas are coalesced to one paint per frame; a thought's
  words enter with the blur settle; the reply renders as markdown as it
  streams, its caret at the end of its last text (raw markup on screen is
  worse than words without the blur, thread.md, live); the caret is the
  only thing that blinks.

**the earned moments**, each exactly once per real event:

| event | moment |
|---|---|
| tests go green after running in front of you | one sweep of light across the window; the chip draws a tick: "118 passed" |
| you answer an ask | none yet: the card says "sent" and settles when the stream does. the option's flight into your message played only from the window's options, which the window no longer holds (`open.md`) |
| a new thread is sent | the sheet closes into the new window at the front |
| the queue advances | the next card slides up into the thread as your message |
| a worktree merges | the review card folds into one line, "merged into main", with the tick |

**the review card** (app/src/ui/review): while a session has an open
review need, a card sits at the live edge of its thread, where an ask
would. it shows the agent's note (else the branch), `branch → base`,
commits, +/- totals, every file with its counts, the patch on request (cut
where the server cuts it, and at 600 painted lines), a warning when the
checkout is dirty or will not merge cleanly, and two controls: merge into
the base, and discard, which asks once in words (what leaves, what stays)
before it acts. a refusal is said on the card: busy (the agent is
mid-turn), conflict (the files named), refused (the daemon's reason), gone
(the checkout was merged or discarded already, which folds the card to
"this checkout is gone"; the line outlives the need, which the server
serves in the same answer, so the thread says why there is no card). a failed read keeps the
reason and offers "try again". each request has a need of its own: a newer
request replaces the card, from a folded one too, with its new note and a
fresh read of the diff. a merge or a discard
outlives the need that brought it, since the server serves the need as it
acts: the card folds into one line, "merged into main" with the tick
drawing itself, or "discarded"; the fold and the tick play only when the
reader watched it happen. home's window carries the note as "ready to
merge: <note>", and its chip says "ready to merge" where a finished turn
would say "done". the review is a chunk of its own (a lazy import in the
stage): the first load keeps only the question of when a review waits.

**never animates.** anything painted from cache or replay; the transcript
while you type; the scroll position (no programmatic scroll you did not ask
for, except the one glide to an ask after 4 s idle); the page on first
paint; anything forever (no pulsing dots, no shimmer skeletons, no
spinners; working is shown by the clock and the tail moving).

**reduced motion.** springs become instant, content swaps keep a 120 ms
fade, the sweep and blur are off.

## buttery, as numbers

each budget has a `perf.*` telemetry kind and a gate in `verification.md`. judged on the ipad 10th generation and the
iphone as installed pwas, over the tailnet.

| budget | target | v1 baseline |
|---|---|---|
| cold launch to the last screen painted from cache | p50 300 ms, p90 700 ms | slow on the phone |
| tap to first frame of the response | 1 frame | unmeasured |
| a transition completes | within its spring, no dropped frames at 60 fps | unmeasured |
| opening a thread whose window is live | painted during the transition, never after it | often over 1 s on the phone |
| stream event on the host to glyph on screen | p90 150 ms | seconds on the phone |
| send to acknowledged | p90 400 ms | unmeasured (echo-guessed) |
| long tasks during streaming or scrolling | none over 50 ms | unmeasured |
| layout shift | 0 | unmeasured |
| reloads | none needed; `app.boot reason=reload` trends to 0 | common on mac and phone |
| client memory after 8 hours open | under 150 mb heap | unmeasured |

## first run (decision 6)

someone opens boxbox for the first time:

1. set the password, then "add a machine": the cmx2 daemon's address and
   its password, tested live ("connected, cmx2 0.4, 3 projects").
2. allow notifications, with one line on why: "so boxbox can tell you when
   an agent needs you or finishes."
3. an empty deck shows one ghost window, "start something", which opens
   the composer. no tour.

### until m5: the gate and the machines list

the law describes first run (m8) but not the screens m0 and m1 need to be
usable, so, in the windows' material: the gate is the wordmark
(wide, 122%), one 16 px password field pressed into the ground, and the
primary button in the violet light tone; a wrong password says "wrong
password" under the field. signed in, "machines" lists each host as a
window in the violet pair (lit top edge, long shadow) with its name, a
chip ("connected", "connecting", "not answering"), and a mono line with
the cmx2 version and the events read; a host that is down says why and
since when. no spinner anywhere: the first answer paints the right screen.
m5 replaces both with the deck, the strip and the rail. the machines list
as it stands now is "the machines", below.

### the machines (redesigned 2026-10-03)

the first cut was a pile: every line the same weight, the
connection a whisper in the corner, plumbing (the contract, events read) as
the second line, and the loudest thing on the screen a full-width "new
terminal" beside a floating "add a machine". the
screen now reads in the order a person asks: is it up, what is on it, then
what can I do.

- **the grid.** machine windows sit in a grid of one size (columns of at
  least 340 px, the screen at most 1080 wide): one column on the phone and
  beside the terminal (the rail's 356 px), two on the ipad, three on the
  mac, so a person with three machines sees all three at once and a
  machine looks the same wherever it is. the grid follows the screen's own
  width (a container query), not the device's. each window is as tall as
  what it holds, so a confirmation or a note opening in one grows that one
  alone (layout shift), and the ghost after them never weighs what a
  machine does.
- **the head** is the shared one: `‹ windows` on the left, **settings** a
  pill on the ground (home's bar pill, 34 px, 44 on touch) on the right,
  the title under them. **sign out** is this device's, not a machine's: a
  quiet word at the foot of the page.
- **a machine window**, in the violet pair with a window's highlight from
  the top left (`::before`, as home's windows): the name (22 px, wide) and
  the connection in home's window chip, a 34 px capsule with a dot of the
  accent ("connected"; "connecting" rings the dot and leaves it empty, in
  the second ink; "not answering" in the chip's failure tone). nothing
  pulses. under the name one mono line: `cmx2 0.8.3 · up 3 h · paired`
  (uptime is the daemon's own count at its last sample plus the time since,
  said only while connected and from a sample of this connection, so a
  machine that is down or just restarted never claims one;
  the contract appears only when it does not match, in red, "contract 5,
  boxbox speaks another"; "never reached" without a health answer). a host
  that is down says why and since when in red words under it; undecodable
  frames are a failure and say so there too ("2 events could not be read.
  the server's log names each one."). the decoded count is boxbox's own
  business and left to telemetry.
- **three figures**, the number large (20 px, wide, tabular, as the
  details' figures: under the name, never over it) and its word under it,
  parted by hairlines of the window's ink: **wants you** ("want you" for
  any other count; the threads there that want you, in the accent when
  more than none), **working** (the threads there working, as home's bar
  counts them: an ask outranks a running turn), **memory** (the daemon's
  rss, absent for a daemon that does not report it). while the machine is
  not connected they are the last it said, the numbers in the second ink;
  a machine never reached shows none.
- **terminals.** a small word, then one surface pressed into the window
  holding the open terminals as rows (name in mono, the place, a chevron)
  and, as its last row, **new terminal** in the accent with a drawn plus
  and the shell picker at its end, parted by a short hairline. a machine
  that is not connected is not asked for its list (its window already says
  why) and is read the moment it is back.
- **the foot**, under a hairline: the verbs as quiet words that take the
  window's fill under a pointer: **reload** fires at once and answers in
  one line under the foot ("reloaded at 14:02: flushed skills, agents,
  ..."). **restart** and a paired machine's **forget** are confirmed in
  place, as the terminal's kill is: the foot becomes the consequence in
  words ("restart aborts every running turn on bench, then its daemon
  starts fresh.") pressed into the window as an ask is, with the verb
  sitting on it in the accent and the way out beside it in words ("keep
  running", "keep"); never red. focus goes to the way out, `esc` takes
  it, and focus returns to the verb; after a restart or a refusal it goes
  to what the window said, after a forget to the title. after a restart
  the window rereads each second and says "restarted. back after 2.0 s"
  once the host holds a new connection, or that it has not come back after
  a minute.
- **add a machine** is the place the next machine goes: a ghost window
  after the others (no material, a hairline on the ground, as home's empty
  deck), a plus in a round pill, "add a machine" and one line, "run `cmx2
  pair` on it, then paste what it prints." the whole ghost is the button.
  pressed, it opens in its place as a deeper card of the window plane
  (`--win-deep`, as the new-thread sheet), brought into view where it
  runs past the fold: the line on how, the address, the token and an
  optional name, "pair" in the primary tone and "cancel"; `esc` cancels
  and focus goes back to the ghost, as it does after a pairing. a paste of
  the whole output fills the address and the token at once. a refusal says
  why and what to do; success closes the sheet, the ghost says "paired
  studio. cmx2 ...", and the new window arrives with its chip, "paired" on
  its mono line.
- with no machines, one line under the title ("no machines yet. pair one,
  or add a [[host]] to boxbox.toml.") and the ghost alone.

### settings

**settings** (`?screen=settings`, reached from the machines header) is
three groups of hairline rows on the ground: *this device* (appearance:
system, dark, light as a segmented control, a track pressed into the
ground with the chosen option on it in the light tone; reduce motion as a
switch whose knob moves on the snap spring by transform, "follows the
system" until chosen and "follow the system" to go back), *what reaches
this device* (the notifications row below, then the four push kinds as
switches once subscribed, and the other devices' choices read-only), and
*new threads* (each repo with threads, most recent first: model and
effort as native selects pressed into the ground, 16 px on touch, with
"the machine's default" and "the model's default effort" first). a chosen
appearance applies at once and a copy rides in localStorage so a cold
launch paints in it; the server's prefs are the truth.

under the header, one hairline row (no window: it is a setting, not a
machine) holds notifications for this device: "notifications", a chip
("on", "off", "blocked", "not in this browser"), first run's line on why,
and "turn on notifications" in the primary tone or a quiet "turn off
notifications". in a safari tab on an iphone or ipad the line says "add
boxbox to your home screen, then open it from there to get
notifications." settings (m7) holds it now; first run (m8) takes it over.

## copy

lowercase, plain verbs, no em or en dashes, no emojis, no f1. name things
by what they are to the person: "wants you", "done", "stopped", "3
next", "unsend", "run now", "steer". the same verb follows an action
through its flow ("merge" makes "merged"). errors say what happened and
what to do; they never apologise.

## directions explored

the directions weighed before live windows:

| direction | idea | verdict |
|---|---|---|
| hush | monochrome ui, one black island that morphs to carry agent state | boring |
| folio | editorial: agent prose in a serif, tool calls in the margin | boring, the worst of the set |
| depth | threads as a stack of physical sheets, glass only on the composer | boring |
| aurora | agents rendered as a living light field | gimmicky |
| orbit | threads as planets, subagents as moons, turn progress as a ring | gimmicky: planets for something that does not need them |
| settle | one variable font; streaming text morphs from mono to sans | rejected |
| lift | elevation is lightness, whatever needs you lifts toward you, nothing teleports, state in a pill grown from the camera cutout, one spring curve | motion and not-flat: right. the look: boring and mundane. the island pill is not buildable as a pwa |
| live windows | home is the agents' actual work: each thread a window in its repo's colour holding a live tail, swiped like panes; a question slides its window forward; opening grows the window into the thread with a colour flood; delight only when earned | **picked** (decision 12) |

what the verdicts say: the wow has to come from craft (material, depth,
the quality of motion), not from a metaphor, and restraint alone reads as
boring.
