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
  key opens a thread with the same motion) and each window it seats wears
  its digit as a key set into its material (the board, below).

## what the app is for

the design spends its attention in this order and puts everything else in
a drawer.

| job | evidence | where it lives |
|---|---|---|
| read and watch a thread | most of the time in the app goes to reading and watching | the stage |
| stack prompts | prompts are often queued behind a busy turn | the composer and its queue |
| know when to come back | people open the app just to find out whether anything needs them | push, the windows' order, the badge |
| answer an ask | questions are infrequent; permissions come from other users | in the thread, where it was asked; the window says it waits and opens the thread to it |
| start a thread | most compose opens start a new thread | home's field, one gesture from anywhere (home: what next) |
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

a window can leave home by hand or by itself once its work is finished,
and come back on its own or with "undo" and "bring back".

- **clear.** a window that is done, idle, failed or parked has a "clear"
  button in its footer; the bar has "clear N" (the done and idle ones, which the line beside it counts apart).
  a working or asking thread has no button, and the server refuses it
  too. clearing is not destructive: the thread is still on its machine,
  in history, and one tap opens it.
- **the mark lives on the server** (`clears`, migration 4), not on a
  device, so every device agrees. the mark is the thread's `time.updated`
  at clear time. the thread comes back, for good, when it goes busy,
  asks, or its updated time moves past the mark (for an assistant's
  thread, its `said` time: a run that only checked something does not
  bring it back, `home.md`, quieter runs). coming back is still what a
  thread mostly does; since settle (decision 93) a person can also take a
  clear back, below.
- **finished work clears itself** (decision 93). the server sweeps home
  every 5 minutes (and a minute after it starts) by the person's rule in
  settings, the same on every device: `seen1h` (the default) clears a
  thread an hour after a person saw its finished reply, `any3h` three hours
  after it settled whether seen or not, `never` leaves clearing to the
  person. it only ever clears a top-level home window that is done or idle:
  never one working, retrying, parked (on its agents or on background jobs
  alone), with prompts queued, asking, failed or stopped, or waiting on a
  review of its worktree. an auto-clear is the same mark as a hand clear,
  marked `auto`, and it serves the thread's done and job needs, so the
  badge drops; the thread comes back exactly as a hand-cleared one does.
- **unclear.** an undo (the toast after a clear from this device or a
  sweep while it is looking, or cmd-z) and "bring back" in the away list
  take the mark back (`POST /api/unclear`): the window returns where the
  order puts it, and the sweep leaves it alone until the thread is updated
  again, so a thread brought back is not cleared again on the next sweep.
- **away.** what the sweep cleared while no device was looking (decision
  23) is the away summary, "N cleared while you were away" (decision 94),
  the same on every device until one opens or dismisses it
  (`POST /api/away/seen`). its threads stay cleared.
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
| wants you | filled with the repo's light tone: "wants you" | a tray of its accent rises out of the tail (what it needs in one line, what answering takes, "answer"), its edge lit; the window keeps its size |
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
rail are what wants you. a window that wants you wears a **tray** of its
accent in place of the tail's foot (the native app's decision 24), and
keeps the size it rests at (see "an ask never grows its window", below):
a slab of the repo's accent inside the window, its corner concentric with
the window's, in the accent's ink. it says what the thread needs in one
line, read from every pending ask (`window/need.ts`): the question itself
under its header when there is one question, "asks 3 questions" over the
questions' headers when there are several, "wants permission to run bun
test" for a permission, both halves ("asks a question and wants permission
to run bun test", "2 asks waiting") when a thread asks both; clamped to six
lines on the deck and two on the strip and the rail. one quiet line says
what answering takes ("3 options", "allow once, always allow or deny"), and
"answer" sits at its end as the accent turned over. the whole tray is one
button, named for the repo and the line ("answer ledger: which greeting
should the notes use?"), and it opens the **answer sheet** over home
(`asks/sheet.tsx`): every pending ask of the thread as the thread's own
card, on the repo's deep window material, answered in place, with "open
the thread" at its foot. on the deck it rises from the foot; on the strip
and the rail it hangs from the window that asked (below it on the strip,
beside it on the rail), so the stage stays in view. an answered ask leaves
it while the rest stay, and it closes when the last has gone; escape and a
press outside close it, and the focus goes back to the tray. the asking
window's edge is lit in its accent (1.5 px at 85%, inside the edge, apart
from the stage's ring outside it), and when it starts wanting you in front
of you one ring of its accent leaves its edge to 6% past it and fades on
the ping curve, once, drawn on the page at the window's box since the
window clips; nothing loops, and reduced motion draws no ring. a tap on the
window itself, "open the thread", the bar's "wants you" and the capsule
open the thread with the ask in front: the same path a push tap takes.
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

**the ask card** (`app/src/ui/asks/card.tsx`, `AskCard`, `PermissionCard`; the question's words in `asks/question.tsx`)
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
result, and a long option wraps. the question's words are the agent's
markdown, painted by the thread's own painter and sanitiser, in the card
rather than the row's head (a button), so they can be selected, hold links
and carry a copy control on their label's line, as a code block's and a
slip's do; open, a lone question's head drops its words so they are not
shown twice. settled, the card keeps every question whole with its answer
under it. home's answer sheet draws the same words through the card, a lone
question's in the sheet's 19 px title type (2026-10-22).

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

### settling: the working fold, undo and the away line (2026-10-26)

finished work clears itself (clearing a window, above); home says so in
four places, each its own decision where the law was silent.

- **the working fold.** windows at work with nothing wrong fold into one
  liquid glass capsule under the bar, above the windows (at the strip,
  leading the row of windows: a row under its one-row bar would move the
  stage). a thread folds while it works, retries, queues or waits on its
  agents ("working"), or waits on background jobs alone ("waiting on a
  job"), with no ask and no open need; it leaves the moment it finishes,
  fails, asks or gets a need, and is born where the order puts it. the
  thread on the stage keeps its window. the capsule says "4 working" over
  "nothing wrong, tap to see" ("2 waiting on a job" on the second line when
  both kinds fold, "<repo> just left" for 30 s after one leaves), and holds
  a bead per thread, its repo's mark over a 26 px line whose short bar
  travels by transform while it works and stands still while it waits (and
  under reduced motion). a press opens the list: "repo · title", the live
  line, the clock, and a parked row's reason as its window says it, with
  its clear. the capsule and the away line come and go only with a reorder,
  inside its flip and its calm, never at a moment of their own.
- **undo.** every clear from this device (one window, "clear N") and an
  auto-clear while the page is in front shows a glass pill for 6 s:
  "cleared N", "undo" in the accent, a 20 px ring draining clockwise by
  clip-path. at the rail it sits at the column's foot, the column's width,
  with the one thread's title under "cleared 1" and, on an apple desktop,
  the ⌘z hint; on the deck
  it is 48 px tall and centred in the page dots' row under the window in
  view (measured once as it shows), so it never covers a window's clear;
  with no dots (one window) it sits 16 px over the safe area. its time stops while a pointer or focus is on
  it. ⌘z undoes from anywhere but a text field. undo brings back exactly
  what the clear cleared, and a failure stays on the pill in the server's
  words with "try again", coming back on screen if a newer pill took over.
  an auto-clear never replaces a hand clear's pill: it waits, and shows for
  its own 6 s when that one ends. an offer is over when its time is, home
  away or not: coming back later shows no pill. the words are announced
  through a live region home keeps from its first paint, not by the pill.
- **the away line.** when the server cleared threads while no device was
  looking, a line under the bar's line says "6 cleared while you were
  away" with "show" (the accent, underlined) and a dismiss. show opens a
  sheet (deck) or a popover under the line (strip, rail): the same title,
  a line for the mode ("each was done and seen more than an hour ago. they
  are still in history." or "each was done more than 3 hours ago, seen or
  not. they are still in history."), rows "repo · title" with "bring back"
  and "done 13:48, seen 13:55, cleared an hour after" ("not seen", "cleared 3
  hours after"), and "bring all back" in the accent. showing or dismissing
  acknowledges the list on every device.
- **job notices.** with "job notices count as needs" off (the default) a
  background job's notice is a row in its thread: no window turns "done"
  for it, it adds to no count, it lifts nothing and badges nothing.

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
  helper" when it starts, "wait" while the parent waits (the verb alone:
  the daemon titles every wait "wait for agents", whatever it waits on,
  and the tail has only the title), "helper reported" when its report lands (never your prompt's
  bubble: the report is the agent's, not yours).
- prose shows the last two sentences; older lines fade out under the top
  mask.
- **what the body shows follows the state** (the native app's decision
  25, `window/run.ts`). working or queued, the run it is in: what you
  asked, the turn's newest eight lines under it, and the turn's strip (the
  step group's lane, `thread/strip.tsx`) under them, one slot a step for
  the newest twelve steps in order, since the tail carries no clock: a
  thought a span on its track, a tool a mark by its kind, the running one
  lit, a failure red. done, idle, failed or parked, only the agent's words
  since your message (its last words anywhere when it said none since),
  640 characters kept from their end, cut at a word behind an ellipsis;
  with no words at all, the run settled, nothing running. an asking window
  keeps its tail as it was.

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
- **pictures a tool returned** (a read of an image, a command that wrote
  one) are thumbnails in the open row, under the file's line when there is
  one, so a read row that holds them says "1 image" where a text read says
  its lines and opens to show them. a thumbnail is one fixed square (76 px,
  96 on the wide stages, radius 12, the bed's colour and edge) with the image
  filling it, cropped: the row's height never depends on a picture, so the
  window's heights hold while images load. at most eight are drawn in a row,
  the rest as "and 3 more images" in the quiet tone (the count includes what
  the daemon dropped past its own cap). a press opens the picture in a modal
  card of glass in the top layer over a dimmed page, as the spend's card is:
  the image fits the card (12 px from the screen's edges), whole, under a
  header with its file name (sans 14 px, 600, the full ink, one line cut at
  its end) and the close (the close, below) 10 px in from the card's
  corner, on one middle line; a press on the image shows it at its own size,
  scrolling inside the card, and a press again fits it. escape, the close
  control and a press outside close it, escape goes no further than the card
  (it is not the stage's back), and focus returns to the thumbnail. only
  png, jpeg, gif and webp are drawn, and only from a data url that says the
  same; anything else a tool attached is not an image here. controls are named
  "image shot.png" (thumbnail), "image shot.png, full size" (the card),
  "close image shot.png" and "image shot.png at its own size" (pressed when
  at its own size); a name that comes twice in a row says its place, "image
  shot.png, 2 of 3".
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
  moment you scroll up, nothing moves; the jump to the latest, a round
  liquid-glass control (44 px, tinted with the flood's foot) above the dock,
  shows while you are a screen or more above the end or something arrived,
  with what arrived as its count (an 18 px capsule in the accent hung on its
  corner, "99+" past 99). a tap or ⌘↓ cuts most of a long way and glides the
  last screen. reopening a thread restores where you were.
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
  dictation turns speech into a draft; a **voice note** is different: the
  recording itself is the message, for an agent whose `voice` declares
  `notes` (2026-10-15). such a composer has a mic key where send sits while the
  draft is empty (`composer.md`, voice, files and assistants).
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
  (escape, its close, or a press outside it closes it; focus returns to the
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
    log below that where the column beside them keeps 704 px (the open
    rail folding to its swatches for them at the rail), a surface pressed
    into the flood (a
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
  thinking, then the law's long tail as it is built: rename (built: the
  item opens a field holding the title in place, save sends cmx2's
  `PATCH /session/:id` with `title` through `POST .../title`, and the
  daemon's update carries the name to every device), model and
  effort defaults, fork, compact, revert to a turn (also on each turn's
  own menu), open a terminal here, copy link, colour (the colour sheet,
  above), archive.
- **fork** (built; `thread.md`, fork): the menu's item forks the whole
  thread; a turn's "fork from here" forks it through that turn. a turn has
  no menu of its own yet, so its fork sits on the quiet line under its
  answer, after the reply's copy and in its voice (a glyph and a word, the
  second ink), and on a line of its own for a turn with no answer: the
  one place every settled turn already has a control, where a control is
  found without a new gesture. revert, when built, joins it there. a
  forked thread says "forked from <title>" beside the repo line, as an
  agent's says "an agent of <parent>", underlined because it is a door
  (to the turn the fork was cut at). neither control animates; the
  opened fork takes the stage's place as any opened thread does.
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
  the thread back to home; at the strip and the rail home lets go of it
  when the fleet drops it, a beat later, and the stage is home (decision
  102). a refusal (the daemon says
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

## the board (2026-10-18)

the board is one person's keypad (`board.md`). on a device without one
none of this exists: not a byte of it is fetched. while a board is plugged
into the mac a window is open on, that window's windows wear its digits.

- **the key.** a window the board seats wears its digit as a key set into
  its material: a 26 px well at the end of the header row, centred on it,
  pressed into the window's own material (`--win-press`,
  `--win-press-edge`), the digit in the window's accent at 13 px, weight
  680, tabular. a paired key (the board keeps that thread on that digit)
  is lit as the board lights it: the accent raised off the material
  (`--win-raise`, a lit key), the digit in the accent's ink. the key is a
  step under the chip's 34 px, so the chip stays the window's voice; it is
  a mark of where the window lives, never a control of its own.
- **the swatch's key.** 18 px on the swatch's foot corner, 5 px out, in the
  swatch's own material ringed 2.5 px in the ground, as the state's badge
  sits on the top corner; lit the same way when paired. the two never share
  a corner.
- **the same digit `⌥n` opens** while no key is paired: the server seats
  the app's window order. a paired key keeps its thread wherever the order
  moves it, and being lit is how it says so.
- **room without layout.** the key is out of the flow. a chip slides aside
  for it by its `translate` (32 px: the key and 6 px), and the name gives
  up the room at its end, its start never moving, so a key arriving or
  leaving moves nothing a layout shift counts (`perf.shift` unchanged).
- **motion.** arriving, the chip slides aside on the snap spring and the
  key rises into the room 70 ms later, from `scale(.6)` and clear.
  changing, the new digit rises into the key from 70% below, and a key
  that becomes paired lights on the fade curve. leaving, the key sinks
  back and fades on the snap spring and the chip returns 70 ms behind it.
  transform and opacity only; nothing is measured but the window's box,
  once per move, to tell whether it is in view. out of view, offline,
  replaying, hidden or under reduced motion, the end state lands at once.
  a key drawn with the board's arrival arrives; a window drawn later paints
  its key in place.
- **names.** a seated window's name and its swatch's end in ", board key
  N" ("ledger: set the greeting in the notes. wants you, board key 3"), so
  a screen reader hears the key that opens it, and every name is unique
  while a board is here.
- **focus.** a digit key opens its thread through home's own tap path, with
  the tap's motion, wherever the app is: from the machines, history,
  settings or a terminal, home comes back on its own travel first. a focus
  never discards or buries typed words: while the answer sheet holds words
  (home's field is never over the stage, and its words stay in it), the thread opens behind it and the
  sheet keeps the screen and its caret. an empty sheet is put away. with no
  words in the way the caret goes into the thread's composer without a
  scroll, so the dictation the keypad types next lands there (a draft in
  another thread's composer is kept per thread, so moving the caret loses
  nothing), and only once the thread is on the stage: a tap a running
  transition refused moves nothing.
- **compose.** a machine key lands on home's field set to that machine,
  the caret in it (decision 103; a thread on the stage steps back first, or
  shrinks first on the deck); words already in the field go with it, as a
  pick in the field moves them. the key names a machine as its agents'
  `label.machine`, which for cmx2 is the host's name, and the field starts
  threads on the fleet's hosts: a machine it cannot start one on is
  dropped.
- **what the app cannot take** is dropped where the person is, without
  leaving the screen: a focus for a key home draws no window for, a compose
  for a machine the field cannot start a thread on, and any request while a
  terminal holds the keyboard.
- **a hidden window** (another tab, minimised) does neither: the window in
  front of the person is the one that moves.
- **pairing.** while a board is here, a thread's menu offers "pair with a
  board key"; a thread already paired offers "pair with another board key",
  with "paired with key N" beside it. a server without `[board]` answers
  that it has none, and the menu stops offering it. it
  arms the board in the window's light tone, the bright one of its pair,
  which a key's led can show, and the stage says "press a digit on the
  board", still and calm, until the board shows the thread on a paired key
  ("paired with board key N", for 2.4 s) or the 30 s are up ("nothing was
  pressed. pair again from the thread menu."). a refusal says what
  happened and what to do ("the board is not plugged into this mac now.
  plug it in, then pair again.").

## home: what next (2026-10-26)

home is where a thread starts and where you see what to do next
(decisions 102 to 109; `app/src/ui/next/`, the start's state in
`app/src/ui/composer/new-thread.ts`). it supersedes "starting a thread"
below (the sheet and the dock), the dock wherever this law names it, and
"the stage never empties" at strip and rail sizes.

- **at each size.** at the strip and the rail, when no thread is chosen,
  the stage is home: the field, and what next under it, on the neutral
  ground. nothing pours a window onto the stage by itself: a launch with
  no thread in its url, a thread that leaves the fleet (archived here or
  elsewhere) and an arrangement change with no thread open all land on
  home. on the deck the field leads home under the bar, and the deck's
  rows are the bar, the field, the windows and the page dots; the windows
  in their order are the list, so the deck draws the field alone, and the
  pager law holds. a deck with no window to show (every thread folded, or
  none at all) draws "start in" under the field instead of empty ground,
  as many repos as the phone has room for (two to five); the empty deck's
  ghost ("a thread you start above, or in cmx2 on any of your machines,
  shows up here as a live window.") is drawn only when there is no repo to
  offer either. there is no dock. home's field is mounted once, whatever
  the arrangement, so its words, its place and a send being made live
  through a resize across 700 px.
- **the field** is the composer every thread has (the `sheet` mount),
  named "start a thread", its placeholder "what next?". it is the one
  place a thread starts. its top row leads with the place (the repo chip,
  then the machine chip with two machines or more), then the composer's
  own model and effort chips; the plus is the photo key. a thread not yet
  made has no effort of its own: the effort chip says "default" (the
  daemon runs the model's own level and its model list does not say
  which, so the chip names the choice rather than guess a level), and a
  pick says the level. the words stand two lines tall at every size, on
  the composer's insets (12 above and at the sides, 8 above the keys' row,
  which keeps a row of its own), so the placeholder never sits on the plus
  and send. its words are
  named "first message for a new thread in <repo>", or "first message for
  a new thread" while no repo is chosen, and a send is held while nowhere
  is chosen: "pick a repo or a folder on <host> to start in". the send
  keeps every rule the sheet had (`composer.md`, the first message does
  not close on a guess): "making the thread in <repo> on <host>.", the
  slow line after 8 s, a refusal said plainly under the field with the
  words given back and retry and edit, and one thread made at a time
  ("one thread at a time. this one can start once the first is open.").
  a refusal that comes while a thread covers the field is said over the
  thread, where the undo toast sits (`ui/next/refused-line.tsx`,
  `role="alert"`): retry, and edit, which goes home to the field with the
  words back; home never moves the person by itself. the place picked
  and the send in flight live in the store (`state.newThread`), so the
  field mounted again keeps both. when the thread exists the stage opens
  on it out of the field's window, as a tap opens a window.
- **tokens.** the place is typed into the sentence and read at the caret:
  `@` at a word's start is a repo (a word filters the machine's repos, a
  path walks its folders; a repo of that name on another machine you have
  threads on is offered with its host, and a pick moves both), `on `
  followed by the start of a machine's name is a machine (only with two
  machines or more, never for `on ` alone, never for letters inside a
  name: "focus on a" stays words beside a machine called vm-a), and `/`
  at a word's start with no second slash is a model (a path in the prose
  is not one). a token opens its menu as it is typed and resolves only
  when picked (return, tab or a tap), never on a guess: a typed menu has
  no row highlighted until the arrows move, unless the word names a row
  exactly (a repo's name, a machine's name, a model's name or id), so
  return on "cc @alice" sends "cc @alice" and tab does what tab does. a
  pick takes its letters out of the words and becomes the chip. a token
  never picked stays words, and while a thread is being made a token
  opens nothing, as the chips are disabled. keys while an input method
  composes are the composition's. the composer's own `/`, `@` and `!`
  menus are off in the field.
- **every token is a tap away.** the repo chip opens the same menu with a
  finder ("find a repo, or type a path"), "other folder" for any folder by
  its path, and at the menu's foot the fresh worktree switch ("a fresh
  worktree", disabled with its reason on a folder that is not a git repo);
  while it is on, the repo chip says "worktree" beside the repo's name.
  a folder's row picks it, and its chevron, "look inside", walks into it;
  the walk ("other folder", "up", "look inside") is in the menu's own
  finder, a typed menu moving into it too, so a path never enters the
  words. the machine chip lists the machines; the model and effort are
  the composer's own chips. a menu opened by a tap highlights its first
  row (never "other folder"); arrows walk a menu, return or tab picks the
  highlighted row, escape closes it and keeps the words, and a press
  outside closes it.
- **what next** (the list, at strip and rail). under the field, in the
  server's order and never ranked here: "waiting on you", the threads that
  want you, stopped, or finished unseen, each a row with its verb (answer
  opens the answer sheet, open pours the thread); then "start in", the
  field's machine's repos by the new-thread recency, each "start in <repo>
  on <host>" (two folders of one name are told apart by their path, in the
  row and its name), which a tap picks into the field. as many repos as
  the stage has room for, two to eight. the working fold is not a row: its
  capsule is on screen at every arrangement (the rail's column, the
  strip's row, the deck's bar), and one thing is said in one place. a row's
  mark is 26 px, under the two-letter size, so a repo reads as the one
  letter its window, its chip and the capsule's beads show beside it (the
  repo mark, below).
- **neutral ground.** home has no flood. the field is the composer on a
  neutral pair (#2a2c34 to #141519, light tone #d4d7e0) on the plane's
  recipe: a quiet surface in dark, a lit card in light. a repo's colour is
  only in its own chip (a whisper of its deep colour on the key) and in
  its marks.
- **where it sits.** the field is the stage's prose measure wide (640 at
  the strip, 720 at a strip 1200 px wide or more (a portrait monitor), 680
  at the rail, 760 on a rail 2000 px wide or more), so it stands where a
  thread's composer does, and "waiting on you" and "start in" stand under
  it in the same column at every size. home has no inspector column: at
  the rail 1400 and up its room reaches the right edge, as the card does
  with the inspector folded, and the column of field and list is centred
  in it, never beside an empty column. the block stands two fifths of the
  stage's spare height down (`PLACE`, a little above the middle, where the
  eye rests), measured when the stage or the list changes size and never
  per frame; the field growing as words are typed is left out, so typing
  never walks it up the screen. a block taller than the stage flows from
  the top and scrolls inside it. when rows arrive or leave, the block's
  move plays from where it was on the snap spring (one box, transform
  only), and the rows themselves move in home's reorder flip after the
  calm, as the windows do. menus drop under the field over the list, the
  composer's model menu too, and never push it.
- **the way home.** at strip and rail every thread's bar carries "what
  next?" after the title, the field collapsed: a button named "what next?
  go home", with an "esc" key hint on a fine pointer only. a press, or
  escape from a thread with no field focused and nothing open over it (a
  sheet, a modal dialog, the thread's menu), and the thread steps back
  while the field drops out of the bar, the caret in it; an agent's layer
  steps back to its parent first, as its back does. escape on the empty
  field pours the thread you came from back. the deck keeps its back, and
  the deck it returns to is led by the field.
- **keys.** `esc` from a thread at strip and rail is home; `⌘n` from
  anywhere, typing included, and `n` when not typing land on the field
  with the caret in it (on the deck an open thread shrinks first, at strip
  and rail it steps back first). the new thread pill, the folded rail's
  plus disc and a board machine key do the same. `⌘k` is not built and
  stays reserved for the jump (input, below); nothing takes it.
- **motion.** the thread pours back into its window, the pour that
  opened it played in reverse: the card's clip closes on the sheet spring
  to a sliver at the edge its window sits beside (the rail's left, the
  strip's top), as long as the window, drifting 22 px toward it, while its
  parts fade where they are; the rim closes with the clip, and the shadow
  and, at the widest rail, the inspector's details fade. a thread with no
  window in view (folded, or the windows put away) steps back instead:
  `scale(.94)` on the sheet spring, its opacity held for the first third
  so the step is seen, then gone. home is uncovered as the clip closes, so
  the two pages of words never cross. the field arrives 18 px from above
  after 90 ms and the list 10 px from below after 140 ms, both on the sheet
  spring; a menu drops 6 px on the snap spring. a thread poured from home
  opens its rim with its clip and fades its shadow in, so no whole card's
  outline stands in the first frame. clip-path, transform and opacity only;
  reduced motion takes the app's rule. `perf.paint` (control) and
  `perf.frames` (transition) call it `home`.
- **empty, offline, failed.** with nothing waiting and no fold the list
  says "nothing needs you right now." and still offers "start in". a
  machine with no repos says "nothing has run on <host> yet. type a folder
  to start in, like ~/code." in the repo menu, and no machine at all "no
  machine is connected yet. add one from agents.". offline, home's bar
  says so in its quiet line ("offline, last update 14:02") as it always
  has; the field still takes words, a first message sent while the
  connection is down waits in the outbox and the field says "the
  connection is down. the thread starts on its own when it is back.", and
  the list renders what was last read. a read that fails is said in the
  menu in its own words; a refusal is said under the field, or over the
  thread that covers it.
- **its cost.** the field and the list are a chunk of their own
  (`ui/later.ts`, `NextUp`), warmed the moment home mounts; their styles
  (`ui/next/next.css`) are in the first load, so the chunk's arrival never
  reorders the cascade. until it lands home draws the field's outline
  ("what next?" on the field's surface, at its height), so the first frame
  shows where a thread starts and the stage is never blank ground.
- **the bar's line** does not repeat the capsule: a line that would say
  only what the working fold's capsule under it says (every thread
  working, all of them folded) is not drawn; a want, a done, offline or an
  update brings it back (`home.md`, the bar's line).

## starting a thread

**superseded by home: what next (decisions 102 and 103).** the sheet and
the dock are gone; every entry below lands on home's field. what still
holds is the send's behaviour: it does not close on a guess, says
plainly if the machine refused, and opens the stage on the new thread.

on every arrangement the home bar has a "new thread" pill (a plus on the
deck, the plus and the words on strip and rail), and on the deck the dock
under the windows is a button named for the place it starts in, in the
colour of the window in view. tapping either raises the composer as a
sheet set to the window you were looking at (its repo and machine); on a
machine with more than one, the machine is a choice, and the repos are
chips in their colours by recency, with an "other folder" finder for any
folder on that machine, typed or walked to. the sheet's composer row is the
model and effort chips alone, changeable there (the place line above it already
says where the thread starts, so the row never repeats it); the plus key
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
| **deck** | width under 700 | home's field under the bar, then full-height windows in a snap pager, one per screen, the next one peeking | fills the screen; back by button, edge swipe or pulling the header down |
| **strip** | 700 and up, portrait | the windows as a row across the top, 2 to 4 visible, tails live; the row folds to a bar of swatches; with no thread chosen the stage is home's field and what next | on stage below the strip once chosen; "what next?" in its bar goes home |
| **rail** | 1000 and up, landscape | the windows as a column on the left, tails live; with no thread chosen the stage is home's field and what next | on stage beside the rail once chosen; "what next?" in its bar goes home; the inspector joins at 1400; both columns fold |

**superseded in part by decision 102:** the stage at strip and rail sizes
is home (its field and what next) until a thread is chosen, and nothing
pours a window onto it by itself; the rail stays the switcher and the
watch beside a thread. what follows was why the stage never emptied: on the mac, home was
a corridor, passed through on the way to the next thread, and people go
thread to thread directly. the rail is the
switcher and the watch: other agents stay visible and live while you read
one, which is what v1's "pit wall" was added for. on the phone, the deck
is home because the phone is hub and spoke (home to thread and back).

| | phone (deck) | ipad portrait (strip) | ipad landscape, mac (rail) | mac portrait monitor (strip) |
|---|---|---|---|---|
| windows | 330 × about 580, one in view | 240 × 200, tails 3 lines | 300 wide, 150 to 260 tall | 260 × 220 |
| stage measure | full width, 22 px gutters | 640 px prose measure | 680 px prose measure, diffs and code take the full stage | 720 px measure |
| composer, bar title | the words' gutters | the measure's column | the measure's column | the measure's column |
| an ask | a preview on the window (the window keeps its size); the thread holds the card | a preview on the window; the card is in the thread on the stage | as the strip | as the strip |
| body text | 16.5 px | 17 px | 15.5 px | 16 px |
| touch target | 44 pt minimum | 44 pt | 28 px (pointer), 44 pt on ipad | 28 px |
| details | sheet | a sheet (docked only where the column beside keeps 704 px) | the inspector at 1400 and up; below it docked beside the rail folded to its swatches, or a sheet where even that leaves too little | docked |
| the clock | none: the words take the width | in the margin | in the margin where the stage leaves room | in the margin |

### the inspector and the folds (the rail)

the desktop layout needed a right sidebar, and both sidebars needed to
collapse (2026-10-02). as built:

- **the inspector** is the column beside the stage at the rail 1400 wide
  and up: 330 px, flat on the ground (padding 26 by 22, its scrollbar
  hidden), holding the thread's details or its turns (the header, the
  details and the menu, above). it is quieter than the stage on purpose:
  figures to glance at beside the thing you read. at home, with no thread
  on the stage and the column shown, it holds "start in", the repos to
  start a thread in, its heading level with home's field (decision 107),
  so the column is never empty ground and the card's edge stays where a
  thread puts it.
- **the rail folds** to a 76 px column while the details need its room
  (one layout law's table: the open rail gives way first, the native app's
  ipadfit), not to nothing, because the rail is the switcher and the
  watch: the windows' toggle (its middle on the stage
  bar's control line, 46 px down), a new-thread disc (44 px, the solid
  pill's material; it lands on home's field), one swatch per window in the inbox order, scrolling
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
- **the strip folds** the same way (the native app's stripux): its bar and
  row give way to one bar as tall as the open bar, the new-thread disc, a
  swatch per window across, history and machines, and the toggle at its
  end where the open bar's sits, so a fold and an unfold land on one spot.
  the card's top edge glides; the words being read keep their place.
- **focus puts the windows away**: the open rail's toggle, `⇧⌘F` at the
  strip and the rail, and the windows come back from a round leading the
  stage's bar (the only one on screen while they are away), `⇧⌘F` or
  `[`. the card takes the screen, 14 px in, its edge on the windows' side
  gliding over whatever was showing (the open windows or a fold).
- **the toggles are a pair** at the two edges of the stage: the windows'
  at the end of the rail's first row (atop the folded column) or of the
  strip's bar, the details' in the stage's bar. each is a frame with a
  pane, the pane on its own side (the strip's a band across the top, where
  its windows are), and says its state by filling it; neither is ever lit
  in the tone. the windows' toggle is named for what a tap does ("fold the
  windows" on the open strip, "hide the windows" on the open rail, "show
  the windows" folded or away); one is on the screen at a time, and a tap
  on a fold's ground unfolds it (the folded rail's closes the details).
- **motion.** the stage card's edge glides on the sheet spring by
  clip-path and its contents are carried by translate, with the layout
  committed once (first when the card grows, last when it shrinks, the
  arriving column drawn under the card while its edge uncovers it); a
  column arrives and leaves by opacity and a 16 px drift. where a wrapped
  paragraph would change width (the rail between 1000 and about 1075 wide,
  or 1400 to about 1468 with the inspector), a carry cannot follow it, so
  the content swaps on the fade instead. reduced motion: instant.
- **remembered on the device.** `boxbox.strip` (open, folded),
  `boxbox.focus` (shown, hidden) and `boxbox.inspector` (details, turns,
  folded); keys `[`, `]` and `⇧⌘F` (input). the rail's fold follows the
  details and is not kept (`boxbox.rail` is no longer read).

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
| back | edge swipe, pull the header down, `‹` | `esc` (the deck; at rail and strip there is no back, and `esc` from a thread is home, decision 108) |
| home, what next (rail, strip) | "what next?" in the thread's bar | `esc` from a thread with no field focused and nothing open over it; `esc` on the empty field goes back to the thread |
| jump anywhere | pull down on the deck: all threads | `⌘k`: threads, repos, commands, "new thread in ..." (reserved: not built yet, and nothing else takes it) |
| new thread | the new thread pill or the folded rail's plus disc: home's field, the caret in it | `⌘n`, or `n` when not typing: home's field |
| send | the send button (return is a newline on touch) | `return`; `shift return` for a newline |
| steer instead of queue | long-press send | `⌘return` |
| stop the turn | the stop control in the header's live line | `⌘.` |
| answer an ask | tap the option | `1` `2` `3` while the ask has focus |
| reply to a message (`quotes`) | swipe the row right, or long-press it and "reply" | hover the row and press its reply control, or `r` on a focused row (not while typing) |
| record a voice note (`voice`) | hold the mic key; slide up to lock, left to cancel | `⌘⇧m` starts a locked recording, `return` sends it, `esc` cancels it |
| thread menu | `⋯` or long-press the header | `⌘/` |
| fold the windows (the strip) | the toggle at the end of the strip's bar, or on the fold, or a tap on the fold's ground | `[` |
| put the windows away, bring them back (the strip, the rail) | the open rail's toggle; back by the round leading the stage's bar | `⇧⌘F` (`[` brings them back) |
| fold the details (the rail, 1400 and up) | the details toggle in the stage's bar | `]` |
| the board | n/a | unchanged (decision 1): its focus and compose verbs drive the same stage and the same motion as a tap |

the native app's windows menu (fold the windows, put them away, the
details, the previous and next window, a window by position) has no
menu bar to live in on the web, in a tab or installed: each of its items
is a key in this table instead, named on its control by
`aria-keyshortcuts` (`[`, `⇧⌘F`, `]`, `⌥↑` `⌥↓`, `⌥1` to `⌥9`), and
each control is also the click. a menu of our own drawn in the bar would
be a second control for every one of them.

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
- **installed to the home screen.** the icon is the ios app's (since
  2026-10-21): the fleet, three windows in the repo palette's light tones
  (violet, gold, teal in front) fanned about one point near their foot, on
  the deep violet ground, so boxbox has one face on the home screen however
  it is installed. the drawing in `app/public/icon.svg` is the ios icon
  document's geometry at 512, its liquid glass flattened to fills, a lit
  top edge, a dark rim and a soft cast, in the tones the ios render shows.
  the maskable and the apple touch icons square the shape, since each
  platform cuts its own and ios paints transparent corners black; the fan
  already sits inside the maskable safe zone at full size
  (`scripts/icons.ts` says by how much). the
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
  interface: titles, labels, chips, menus and counts. titles run wide
  (width 108 to 122) and tight.
- **lexend** (variable, weight 300 to 800) for what you read and write:
  the agent's prose and markdown, your messages, voice note text, and the
  composer as you type (`--read`). chosen 2026-10-21 over keeping mona at
  normal width for prose, where its even rhythm read as interface rather
  than writing: lexend's open, widely spaced letters stay calm through a
  long reply on a phone at night, and its texture sits as a clear second
  layer under mona's wide titles. it fits fewer characters on a line than
  mona, which the measure accepts. the times and the "show all" in your
  bubble stay mona, as interface.
- **martian mono** (variable, width 75 to 112) for tool lines, code,
  diffs and counters, set narrow (width 90) so a tool line fits a window.
- numbers are tabular everywhere they change.
- **as shipped** (m0): mona sans carries a reserved font name, and the app
  ships a subset (latin, arrows, keys, blocks) with optical size pinned
  and weight 300 to 800, so it is renamed **boxbox sans** as the ofl asks
  of a modified version (`scripts/fonts.sh`, 140 kb). martian mono ships
  subset under its own name (50 kb), and so does lexend (29 kb; its
  reserved font name is "RevReading Lexend"). all three load with `font-display: swap`
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
  accents. the server gives a repo one when it first sees a session there
  and keeps it (decision 82): of the colours the repo's host wears least,
  the one a stable hash of `host:root` names when it is free, else the
  lowest in the table, so up to ten repos on a machine never share.
  "least used" counts every repo the server remembers on that host, idle
  ones too, not only those with threads now. a
  person can choose another (the colour sheet, below), and automatic gives
  back the one boxbox picked. every client shows the server's colour; the
  hash is only the fallback for a repo the server has not named yet, such
  as a folder no thread has worked in. every pair holds 4.5:1 for body
  text in white.

| name | top | bottom | light tone |
|---|---|---|---|
| green | `#004a2c` | `#002319` | `#80e9a8` |
| violet | `#34298a` | `#171240` | `#b7abff` |
| rose | `#721743` | `#2e0820` | `#ffa9ca` |
| cobalt | `#19359c` | `#101048` | `#adc2ff` |
| blue | `#004077` | `#071938` | `#9fd0ff` |
| teal | `#00484b` | `#002025` | `#7ee2db` |
| sunset | `#761521` | `#300936` | `#ffbc91` |
| plum | `#512977` | `#1e0e33` | `#daaafd` |
| magenta | `#700159` | `#2e0628` | `#ffa4e9` |
| slate | `#334052` | `#131822` | `#b8c9de` |

set in m5 (`docs/home.md`); retuned 2026-10-19: gold, clay and olive (yellow and
brown, read as muddy) gave their slots to cobalt, sunset and magenta, so the
other seven repos keep their colour; every top sits near 0.05 relative
luminance at the most chroma that allows, and the bottom's hue turns a few
degrees from the top's (sunset's from vermilion to wine), so each window is a
saturated gradient rather than a greyed one. every pair holds 4.5:1 for white body text at
both ends, the light tone holds 4.5:1 on the top colour, and the bottom
colour holds 4.5:1 on the light tone (`app/src/ui/window/repo.test.ts`).

- **red** (`#ff6b6b` on dark, `#ad2323` on light) means failure and
  nothing else. diff lines use `#9ff0b3` and `#ffa3a3` on dark, `#0d6329`
  and `#a8233b` on light.
- **citron** (`#ffe680` light tone, `#4b4100` / `#201b00` deep pair) means
  a btw and nothing else. see the btw exception below.

#### the btw exception (2026-10-22)

colour means which repo, and a btw is the one thing on a stage that is not
the thread: a side question answered from the session's context with no
tools, never in the agent's context (`docs/thread.md`, btw). the owner asked
that it be unmistakable, with a tint of its own from the design system, so
it is the one place a hue says what something *is* rather than whose it is.

- **the hue.** citron, a lemon yellow: the only gap left in the hue wheel.
  every other hue is a repo's (the ten above and the five assistant hues in
  `repo.ts`), red is failure and recording, violet is focus and the app's
  own accent, and the amber next to it is already a state (a blocked
  report's gold, a machine's strain), so the yellow is taken clear of the
  amber, toward lemon. gold left the repo palette as muddy (above); citron
  is worn as a wash and an ink, never a window's flood, so that reading does
  not arise on the stage.
- **one palette, the repo palette's shape.** `app/src/ui/btw/tint.ts`
  (`BTW_COLOUR`) and `styles.css` (`--btw-top`, `--btw-bottom`,
  `--btw-tone` on the root) hold the same three values; the test holds them
  equal. the pair keeps the palette's three contrasts (white on both ends,
  the light tone on the top, the bottom on the light tone).
- **where it is worn.** the btw card (a citron wash over the flood, the
  label, the dashed rail and the caret in its ink, `btw/card.css`), the
  "from a btw" marker's word, and the composer window while the draft is a
  btw (the window recipe with the citron palette in place of the repo's, so
  its material, its accent and send are the same tokens in that hue).
  nothing else takes it: not a state, not a repo, not a chip.
- **the proofs.** `app/src/ui/btw/tint.test.ts` reads the recipes from the
  css and evaluates them as `stage-flood.test.ts` and `plane.test.ts` do:
  on every repo's flood, top to foot, in both appearances, the label's ink,
  the question (`--text`), the quiet words and the answer hold 4.5:1 on the
  wash; red holds 4.5:1 on light and 3:1 on dark (the standing exception,
  `open.md`, red on a dark window); the marker's ink holds 4.5:1 on the bare
  flood; on the composer window in btw mode the ink, the line, the
  placeholder's ink, the second ink and the accent hold 4.5:1 on its
  material, and send's ink holds 4.5:1 on the accent.
- **the quiet words on the wash** are a step brighter than the stage's
  second ink on dark (white at 72%, `--btw-quiet`): the wash lifts the
  ground, and 62% white fell to 4.1:1 at the top of the bluest floods.

### the colour sheet (2026-10-19)

a repo's colour is chosen in one sheet, `app/src/ui/colour/sheet.tsx`, with
its rules in `picker-model.ts` (tested). a repo is a machine and a root, so
the sheet is titled "api's colour" and says "on desk · every window, thread
and chip of api", with the close.

- **where it opens.** the thread menu's "colour" item, which shows the
  colour's dot and "cobalt · automatic" or "sunset · chosen"; the repo line
  above the thread's big title, a capsule ringed in the accent with the
  mark, the name, the dot and a caret (at the top of the log on every
  size; it scrolls away with the title, and the bar keeps to its title and
  status); and settings' *repo colours*, one
  row per repo. not from home: a long press there fights the deck's
  gestures. a thread with no repo (an assistant's) offers none of them.
- **what it shows.** this repo's window (the thread's title, its mark, and
  its ask with "wants you" while one is open) ringed in the colour being
  tried, beside the machine's other repos as small windows in theirs
  ("beside your other repos on desk", the three newest). then automatic, a
  row with a radio that says what it gives in words: "cobalt, picked by
  boxbox. every device agrees.", or "teal for now. boxbox picks api's own
  when a thread runs there." for a repo the server has not spoken for. then
  the ten in slot order with their names: the picked one ringed and ticked
  (automatic's swatch ringed alone while automatic is picked), "auto" under
  the one automatic gives, and a badge with the wearer's initial (or how
  many) on a swatch another repo on the machine wears. a line under them
  says who: "slate is relay's on desk. ledger has green, docs has plum. you
  can still share one; their windows would look alike." sharing is allowed.
- **trying is live, nothing is sent.** a press on a swatch or automatic
  repaints the repo everywhere at once through the store's preview (the
  stage behind the sheet, home's windows, the marks), on this device only.
  "use sunset" (or "use automatic") is the one control that sends; it shows
  only once the pick differs from what the server holds. "keep cobalt", the
  close, escape and a press outside put the repo back as it was. picking
  automatic's own colour by hand reads "keep automatic" and "use cobalt",
  so the two never read alike.
- **after use.** the stream's `colour` frame repaints every device, usually
  before the answer; the preview holds until the map holds the choice, or 3
  s, so the stage never flashes back. a refusal keeps the sheet open.
  a 503 comes only after every device has the choice, so it says so:
  "every device shows sunset now, but the server could not keep it, so it
  goes back when the server restarts. try again in a moment.", and "use
  sunset" stays to send it again. any other refusal changed nothing and
  keeps the server's words ("api's colour did not change. boxbox has no
  thread in ...").
- **shape and motion.** a modal dialog in the top layer, the report sheet's
  glass, painted in the colour being tried (its "use" and rings take it).
  on the phone it rises from the screen's foot at the screen's width, the
  swatches five to a row; from 700 px it is a card 640 wide standing at the
  foot of the stage it belongs to, the swatches ten to a row. it rises on
  the sheet spring and sinks on it; under reduced motion it fades in 120 ms.
- **keyboard and names.** automatic and the ten are one radio group named
  "api's colour": tab reaches the checked one, the arrows move the pick and
  the keyboard with it. a swatch is named "slate, worn by relay", "cobalt,
  automatic" or "rose"; the menu item "colour, cobalt, automatic"; the repo
  line "api, cobalt, automatic. choose its colour"; a settings row "api on
  desk, sunset, chosen. choose its colour". focus goes back to what opened
  it (`⋯` for the menu, whose items are inert once it closes).

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
  appearances). windows, the composer's window and what it raises, home's
  field, the capsule, a machine, a folded rail's swatches and a
  repo's mark follow the page's appearance and are built from the plane's
  own tokens (`--win-*`, `--accent`, `--on-accent` on the plane block in
  `app/src/styles.css`), read from the surface's palette (`--p1..3`: the
  repo's top, bottom and light tone, or the app's violet). dark is the
  deep pair, the light tone's accents, a white 16% lit edge, and the
  highlight from the top left in the repo's light tone at 13% (white greyed
  the corner into a haze), on an eased falloff that ends flat instead of a
  straight ramp with an edge. the window on the stage, at the strip and the
  rail, wears a 2 px ring of its accent outside its edge with 2 px of
  ground between, and keeps its own lit edge; a folded swatch on the stage
  wears the same (the native app's decision 22). light is the
  light tone at 40% in white at the top and 18% in near-white at the foot
  (30 and 12% until 2026-10-19 left the cool hues reading as grey paper),
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
  an ask's option, the docked details) is lit paper: white
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
  sizes as used: 20 (the stage's repo line, the fold's hover card, home's
  field chip), 22 (a window header), 26 (home's list and field menu rows,
  one letter like the windows beside them), 30 (a folded swatch), 32 (a sheet row), 34
  (the capsule, beside its 34 px "open"), 36 (a history row, a settings
  row).
- **the governing rule** (learned in v1): show the mark wherever identity
  does not already ride the surface, and let it lead; a trailing mark
  beside names of any length reads as scatter. surfaces:

| surface | mark | why |
|---|---|---|
| window header (deck, strip, rail) | yes, 22, leads the name | the name is the only identity the header carries; the window's gradient is shared with its neighbours of the same repo |
| history row | yes, 36, replaces the colour bar | the bar said the repo's colour; the mark says it with the favicon, so colour is not said twice. the repo's name stays in the meta line |
| home's field: the repo chip | yes, 20, leads the name | the chip is the only place the field shows a repo's colour (decision 105); the sheet's repo chips at 22 are gone with it |
| home's field: menu rows | yes, 26, spans the name and the path | a list of repos by name, and the leading mark is the scan line; under 28, so one letter as the windows and the chip beside it show (the sheet's finder rows were 32) |
| home's list: what next and start in | yes, 26, leads the row | a row names a thread or a repo on the neutral ground, and the mark is its colour there; one letter, as the window, the field's chip and the capsule's beads on the same screen say it (a 32 px row mark spelled two, "le" beside "l") |
| folded rail swatch | yes, 30, `bare` | the swatch is already the repo's colour and spelled its initials, so a tile in a tile is not drawn until there is a favicon; then the plate shows (its state moves out to the corner the plate leaves free, and rings in the swatch's colour) |
| fold hover card | yes, 20, leads the repo name | a name on glass with no colour of its own |
| capsule, "X wants you" | yes, 34, replaces the colour dot | it is the one place a repo speaks over another's window |
| stage's repo line | yes, 20, leads the name | the line names the repo; the flood is its colour but the favicon is its face. the name is now the project root's, as the window says it (it was the worktree directory's) |
| settings, per-repo defaults | yes, 36 | a list of repos on the plain page |
| home's summary line ("api wants you, 2 working") | no | a sentence of parts that wrap between them; an inline mark would break the line's measure, and the ink colour already carries the repo; the capsule and the window carry the mark |
| the composer | no | it is a window of the repo's own colour (home's field: the neutral ground, its repo chip carries the mark), and the stage above says the repo |
| composer full head | no | it carries the thread's title, not a repo |
| clear and ask cards | no | named by the window they sit in |

### agents: who a window belongs to (2026-10-15)

boxbox drove one kind of agent, cmx, which works in repos on a machine.
it now drives assistants too: an agent behind a gateway (openclaw is the
first) that keeps conversations, not repos, and talks on other channels
(whatsapp) as well as here. the approved screens fit an assistant into
boxbox as it is: the same deck, stage, ledger, asks and composer, with
its own colour and a round mark where a repo's square one sits. nothing
about a surface is decided by asking "is this openclaw". every surface
below is gated on a **capability** the agent declares, by name, and an
agent that lacks one simply does not show that surface.

- **two kinds, one model.** a cmx agent is one per machine and its
  windows belong to a repo, so a cmx window's identity is its repo (the
  mark, the palette) and the agent rides beside it. an assistant's
  windows belong to the assistant: its name and palette lead, and it has
  no repo, no worktree and no branch.
- **how an agent is named.** the agent's `label` joined with " · ": cmx
  is `cmx · <machine>` ("cmx · vm-a"); an assistant is `<name> ·
  <runtime> · <machine>` ("<name> · openclaw · vm-b"). where each form is
  used:

| surface | cmx | an assistant |
|---|---|---|
| a window's header | the repo's mark and name, then `cmx · vm-a` in the light tone at 60% (14 px), shown once more than one agent is paired; with one agent the header is as it was | the round mark and `<name>` in the light tone (15.5 px, 500); nothing after it |
| the stage's title block, live line | the repo line as before | `<name> · thinking` (or `· listening`, `· working 0:40`), the name in the second ink |
| the start something picker | `cmx` (16 px, 600) and `vm-a` (14 px, second ink) | `<name>` and `openclaw · vm-b` |
| the agent row of start something | `cmx` over `on vm-a` | `<name>` over `openclaw · vm-b` |
| the dock's second line | `in ledger · cmx · vm-a` (more than one agent) or `in ledger` | `with <name>` |
| the agents screen | the machine's name, `cmx2 0.8.3 · up 3 h · paired` | `<name>`, `openclaw 2026.10.1 · paired` |
| accessible names | "cmx on vm-a" | "<name>, openclaw on vm-b" (a middle dot is not read the same by every screen reader) |

- **assistant palettes** are five named slots beside the ten repo hues,
  in the same recipe (top, bottom, light tone), chosen to sit in the gaps
  the ten leave on the colour wheel, so an assistant next to a repo of a
  near hue still reads as another thing. they feed `--p1..3` exactly as a
  repo's palette does, so the plane, the flood, the accent, the paper and
  both appearances follow with no rule of their own. the agent's
  `palette` names its slot (`docs/agents.md` says how one is given); the
  person can change it in settings, as a repo's. each holds the three
  proofs the ten hold (white body text at both ends at 4.5:1, the light
  tone on the top colour, the bottom colour on the light tone), and the
  plane and flood tests run over fifteen palettes, not ten.

| name | top | bottom | light tone | sits between |
|---|---|---|---|---|
| coral | `#701e2e` | `#2e0914` | `#ffa9a7` | rose and sunset (the first assistant's, as approved) |
| lime | `#1b4a03` | `#022209` | `#bbea7a` | green, on the yellow side |
| jade | `#00493d` | `#00211e` | `#83e8c9` | green and teal |
| lagoon | `#004757` | `#001d2a` | `#85ddf3` | teal and blue |
| orchid | `#621f6d` | `#250a2d` | `#eea7f4` | plum and magenta |

  measured for this table (wcag relative luminance, retuned 2026-10-19
  with the ten): white on the tops 10.3 to 11.0, on the bottoms 17.0 to
  18.1; the light tone on its top 5.9 to 7.5; the bottom on its light tone
  9.9 to 12.3.

- **the round mark.** an assistant's mark is a circle where a repo's is a
  squircle: the shape says the kind (square is a place an agent works in,
  round is an agent you talk to), the colour says which one. it is the
  same component (`RepoMark` with `shape="round"`), the same material,
  ring and accent, the same sizes and the same rules (identity only,
  `aria-hidden`, no state, one arrival). it always shows one letter, the
  name's first, set as the one-letter size: an assistant's name is a word,
  and two letters read as a code. it never draws a favicon or the
  gateway's avatar: identity stays in boxbox's material, and a photo of a
  face on a deck of colour tiles is the one thing that would shout.
- **a machine's square mark.** in the picker a cmx row is a square mark
  holding the machine's initials (two letters: `va` for vm-a) in the
  page's quiet material (white at 8% on dark, the ink at 6% on light, a
  ring of the second ink at 30%), since cmx has no colour of its own
  until a repo is chosen.
- **where the round mark goes** follows the governing rule above: a
  window's header (22, leads the name), the capsule (34), a folded swatch
  (30), a history row (36), the picker's rows (30) and the agent row (33),
  and the agents screen's card (22, beside the name). the summary line
  and the dock carry none, as for a repo.
- **capabilities.** each surface names the capability that gates it, by
  its key on `agent.capabilities` (`docs/agents.md` holds the wire and
  wins if a name here drifts from it). an agent that does not declare one
  never shows its surface, and a surface never guesses from the runtime's
  name:

| capability | surfaces it gates |
|---|---|
| `voice` (`notes`) | the mic key and recording; `notes` alone decides it |
| `voice` (`replies`) | nothing: it says the agent may answer with audio, and an `audio` part is drawn whenever one arrives, so no surface waits on it |
| `attachments` (`kinds`, `maxBytes`, `maxCount`) | the plus key's "add a file" and "add a photo", and what each accepts; its limits are the composer's, under boxbox's own outbox cap |
| `quotes` | the reply strip, the swipe and the hover reply, quote blocks on what you send (a quote the agent sends is drawn whenever it arrives) |
| `reactions` | the react control and the picker (reactions the agent sends are drawn whenever they arrive) |
| `reasoning` (`word`, `levels`) | the chip beside the model: "effort" or "thinking", as `word` says, with `levels` as its dial |
| `model` | the model chip |
| `places` | the place row (repo chips, the folder finder) and a repo's mark |
| `worktree` | the fresh worktree toggle |
| `threads` | start something with that agent; without it the agent has its one thread and the dock opens it |
| `approvals`, `questions` | the permission card, the question card |
| `origins` | the origin line in a bubble ("via whatsapp"), a window's footer origin, scheduled runs and their quiet window |
| `admin` | reload, restart and memory on the agents screen |
| `history` | the agent's rows in history and its agent chip there |
| `archive` | the thread menu's archive |
| `terminal`, `review`, `compact`, `queue`, `steer`, `commands`, `files`, `shell`, `spend`, `subagents` | today's surfaces of those names, unchanged |

a cmx2 agent declares what today's surfaces need, so a cmx thread is
exactly what it was. the mark's shape is the agent's `mark` (`square`,
`round`) and its palette the agent's `palette` (a slot name, or none for
an agent whose windows take their repo's), so the client draws what the
server says and never infers either from `kind` or `source`. an agent
of kind `other` takes the round mark only when its `mark` says so, as
any agent. every verb on an agent (send, steer, queue, unsend,
stop, react, archive, clear, read, history) goes through the
agent-scoped routes `docs/agents.md` names; the `/api/hosts/...` routes
this law names elsewhere are cmx's, kept beside them (`protocol.md`, q2).

- **"paired"** on a card's mono line is how the connection was made
  (`connection.origin: paired`, as against one written in `boxbox.toml`),
  not its state: the state is the chip ("connected", "syncing",
  "waiting", and so on, `home.md`, the agents).

- **red for recording.** the law keeps red for failure. one other meaning
  is allowed, and only while it is true: a microphone that is capturing.
  the recording dot and the hot mic key are `--rec` (`#ff4f4f` on dark,
  `#c42b2b` on light), a hue apart from failure's `#ff6b6b`, never used
  for anything at rest, and gone the moment capture stops. the convention
  is universal enough that a recording in any other colour reads as not
  recording.
- **reactions are content.** boxbox's own words never use emoji (copy,
  below). a reaction is the one place an emoji glyph appears, because it
  is what a person or an agent sent, as a message's words are; it is
  named in words for a screen reader (its cldr short name).

### the new rows: type and colour (2026-10-15)

every new row is built from tokens the stage already has; the numbers are
the approved screens' (the phone, 402 pt wide). "the bubble" is your
message's material (light on the dark flood, the deep pair on the light
one); "a well" is white at 7% with a white 10% edge on dark and the
paper on light (the two appearances, above).

| row | shape | type | colour |
|---|---|---|---|
| origin line in your bubble | the bubble's time slot, right aligned | 12.5 px, tabular: `09:12 · via whatsapp` | the bubble's quiet ink (`#7a7a80` on the light bubble) |
| your voice note | the bubble, radius 22 22 8 22, padding 10 14 10 10; a 34 px play disc, the waveform, the duration, the time under them | duration 13 px tabular; time 12.5 px | disc: the bubble's ink (`#1c1c1e`) with the bubble's colour as its glyph; played bars the bubble's ink, unplayed at 35% |
| an agent's voice note | a well, radius 20, padding 10 14 10 10; a 36 px play disc, the waveform, then the duration over "<name>'s voice" | duration 13 px 600 tabular in the first ink; label 12.5 px second ink | disc: the accent, its glyph `--on-accent`; played bars the accent, unplayed the first ink at 30% |
| a fold under a note ("transcript", "what <name> said") | a 13.5 px line with a chevron, right aligned under your bubble, left under the agent's card | 13.5 px | third ink; open, the text is prose in a well (yours 15.5 px; the agent's as its said rows) |
| a generated image | a card at most 300 x 190 (the image's own ratio inside those bounds, never taller than 360), radius 20, a white 12% edge | caption mono 12 px | caption on black 35% with white 90% ink, radius 8, at its foot when the image has a name |
| a file card | a well, radius 18, padding 11 16 11 12; a 32 px type tile, the name, the size under it | name 15 px 600; size mono 12.5 px | size in the second ink; the tile: a page glyph with the type's word (`pdf`, `doc`, `zip`, `txt`) in mono 9 px on the accent |
| a quote block in your bubble | inside the bubble's top, margin -4 -6 8, radius 8, padding 5 9 6, a 3 px rule on its left | author 12.5 px 650; excerpt 13 px, one line, cut with an ellipsis | fill: the bubble's ink at 6%; rule and author: the quoted author's deep colour (the palette's top on the light bubble; your own: the bubble's quiet ink); excerpt in the bubble's quiet ink |
| a quote above an agent's words | a line over the said row: a 2 x 16 px rule, the author, the excerpt | 13.5 px; author 600 | rule and excerpt in the third ink, the author in the second |
| a reaction | a pill 24 tall hanging 10 px over the bottom edge of what it reacts to, at the bubble's left corner or under a said row's start; glyph 14 px, a count 12 px tabular when more than one | count 12 px | a well on the flood; your own reaction carries a 1.5 px ring of the accent |
| the folded step group | the step group as built (`thread.md`, the step group): the chevron, "3 steps · checked calendar, searched 2", the time; under it its strip | 13.5 px second ink (full ink open, and for what a live run is doing); time mono 11.5 px | the strip, 16 px: a 3 px thinking track with spans in the accent, a tools bed from 6 px with marks in ink by kind (edits in the add green, long commands and the running step in the accent, failures red), over ink at 6% and 4% |
| an agent's permission card | the ask card as built: radius 26, padding 15 16 16 | "permission" 13.5 px 600 at 62%; the question 17 px 650 wide (108); a command in it mono 14.5 px 600; options 15 px 620, 34 px pills | the light tone with `--on-accent` ink, options pressed in at ink 10%, the primary on the ink with the light tone as its word (as every ask) |
| an answered permission | the card folded to one line, radius 22, padding 14 15 | "permission" 13 px 600 at 62%; "allowed once · brew upgrade on vm-a" 15 px 650 | the light tone at 55% over the flood, so it reads settled beside a live ask |
| the live "thinking" line | a 6 px dot and the word at the live edge | mono 13 px | the accent; the dot at 80%, still (nothing pulses) |
| a scheduled run's start line | a mark line where your bubble would be | 13.5 px: "scheduled, 08:00: morning check", "heartbeat, 08:30" | second ink, the kind word in the first |
| media still being copied (`media.state: pending`) | the card's own box at its size | | a well; a still quarter arc, 20 px, in the third ink (the copy has no progress to say, and nothing spins); no tap |
| media the gateway lost (`missing`) | the card's own box, kept at its size | 13.5 px: "no longer on vm-b" | a well with a dashed white 14% edge; the name and size stay in the second ink |
| media boxbox evicted (410, `media-evicted`) | the same | 13.5 px: "no longer on the server" | the same; the name, the size and any transcript stay; no play or open control |
| an upload in flight | the attachment's own box | | a 20 px determinate ring in the accent at the box's centre over black 30%; the bubble is faded as any unsent message |
| an upload that failed | the same box | 13.5 px red words under it | a red (`#ff6b6b`) 1.5 px edge |

### accessible names for agent surfaces (2026-10-15)

AGENTS.md, accessibility, for every new control. names are told apart as the thread's are
(`namesOf`: "again", "third time", in document order), name a row by its
author and clock and the first 40 characters of its words where that is
what tells it apart, and hold still while the thing they name changes
state (a toggle says its state in `aria-pressed` or `aria-expanded`, not in
its name).

| control | name |
|---|---|
| the mic key | "record a voice note for <name>" (under a thread), "record a voice note for the new thread" (the sheet) |
| the lock (a button too, for a keyboard and assistive technology) | "lock the recording" |
| send while recording or locked | "send the voice note" |
| cancel while locked | "cancel the voice note" |
| the timer | `role="timer"`, "recording time", not live |
| the live waveform | `aria-hidden` |
| play on a note (a toggle, `aria-pressed`) | "play your voice note, 11:31, 0:14", "play <name>'s voice note, 11:34, 0:22" |
| the scrubber | a slider, "position in <name>'s voice note, 11:34", value "0:12 of 0:22" |
| the speed control (only on the note playing) | "playback speed, 1.5 times" (the value is the control) |
| a transcript fold (`aria-expanded`) | "transcript of your voice note, 11:31", "what <name> said, 11:34" |
| the now playing line's pause and its jump | "pause <name>'s voice note", "go to <name>'s voice note, 11:34" |
| an image card | "image <file>" (as pictures a tool returned), "image from <name>, 11:34" when it has no name |
| the viewer | "image <file>, 2 of 5"; "previous image", "next image", "save image <file>", "share image <file>", "close image <file>"; "zoom in", "zoom out", "fit the image" (keyboard `+`, `-`, `0`) |
| a file card | "open <file>, pdf, 84 kb" |
| a quote block | "go to the message it quotes, from <name>: <excerpt>" |
| a reply control on a row (hover, and the row's menu) | "reply to <name>, 11:34: <excerpt>", "reply to your message, 11:31: <excerpt>" |
| the reply strip | a group, "replying to <name>: <excerpt>"; its close "stop replying" |
| a react control | "react to <name>, 11:34: <excerpt>"; the picker's options "react with thumbs up" |
| a reaction | "thumbs up from <name>"; your own, a button, "your reaction, thumbs up. remove it" |
| a send that was not confirmed | "send it again: <excerpt>" |
| an ask's answer by line | `role="timer"`, "time left to answer", not live until the last minute |
| the thinking chip | "thinking for this message, low"; the dial's options "off", "low thinking", and so on, by the agent's own `levels` |
| the plus menu's rows | "add a file", "add a photo" |
| an attachment in the draft | "<file>, pdf, 84 kb", with "remove <file>"; while it uploads "<file>, sending, 40%"; failed, "send <file> again" |
| the agent row (`aria-expanded`) | "agent for the new thread: <name>, openclaw on vm-b" |
| the picker's options | "cmx on vm-a", "<name>, openclaw on vm-b", with ", not answering" or ", waiting for approval" when it cannot take a thread |
| the dock | "start something with <name>", "start something in ledger, cmx on vm-a" |
| an assistant's window | "<name>: <title>. wants you" (the window's rule), with "answer <name>: <question>" |
| the quiet runs window | "<name>'s runs: 3 since 08:00" |
| the runs control in a run's title block | "runs of <name>, 1 of 3" |
| the bar's pill | "agents" (it was "machines") |
| an agent card's verbs | "reload <name>", "restart <name>", "forget <name>", "copy the approval command", "check again" |
| the ghost | "add an agent" |

### the agent surfaces on the web, as built (m9, before the neutral wire is wired)

the surfaces above exist on the web as standalone components with a story
for every state, waiting for the app's protocol 3 store and sync worker:
`app/src/ui/assistant/` (`voice/` the player, the recorder, the note rows
and the peaks worker; `media/` the cards and the viewer; `rows/` quotes,
reactions, the reply strip and the small rows; `home/` the deck's window,
the agents screen's card and the start something row and picker;
`thinking.tsx` the chip; `wire.ts` a hand mirror of `server/src/wire/*`
that the generated types replace). the ladle groups are
`assistant-voice`, `assistant-composer`, `assistant-thread` and
`assistant-home`. the round mark is `RepoMark` with `shape="round"`; the
five palettes are `ASSISTANT_COLOURS` in `app/src/ui/window/repo.ts`, and
the plane and flood tests run over all fifteen (`ALL_COLOURS`).

decided there, where the law is silent:

- **an image's box.** a landscape image fits inside 300 x 190; a portrait
  one may stand up to 360 tall, never narrower than 96; one without a
  size is 300 x 190 with the picture fitted whole. the box is set as a
  width and an aspect ratio, so a bubble narrower than 300 shrinks it
  without a shift. in your bubble the picture takes the bubble's width up
  to its own box.
- **your voice note, gone.** your bubble has no label line, so "no longer
  on vm-b" (or "on the server") leads its time slot: "no longer on vm-b ·
  11:31".
- **your voice note, not sent.** the retry is named "send your voice note
  again, 11:31" and "back to draft" is named "back to draft: your voice
  note, 11:31".
- **the kind and the rate a note records in.** aac in mp4 first, then opus
  in webm, then opus in ogg (agents.md), skipping a kind the agent's
  `attachments.kinds` do not take; with none left the mic is not offered.
  aac records at 64 kbps and opus at 32: chromium's aac encoder refuses
  anything under 48 with an `EncodingError` (`docs/gotchas.md`).
- **asking for the microphone** is read from the permissions api; where it
  cannot say (safari, firefox), a device flag (`boxbox.mic.granted` in
  local storage, set when the platform grants it) tells a first press,
  which only asks, from one that records.
- **an encoder error mid-recording** is an interruption: the recorder stops,
  stays locked with what it has, and says the interruption's words.
- **where the recorder says things.** the refusal and "hold to record..."
  are the composer's line (the top row); the cap's and the interruption's
  words are a status line under the recorder's top row, in the dial note's
  style, since the top row is the timer and the waveform then.
- **the lock** rises only for a hold: a mouse click, a key and a screen
  reader's tap lock at once, so there is no capsule to show them.
- **the live waveform** keeps a canvas of 240 bars and starts it over from
  the 64-bar ring when it fills, so a bar is painted once except at that
  turn; under reduced motion the visible bars are repainted right aligned.
- **a reaction under a said row** sits 4 px under the words instead of
  hanging over them, so a pill never covers a glyph of the agent's prose;
  under a bubble it hangs 10 px over the edge as the table says. someone
  else's pill is an image named for screen readers ("thumbs up from
  <name>"); an emoji outside the six is named "reaction" and the glyph.
- **a quote needs room**: a bubble holding a quote block is never narrower
  than 240 px, so its one line reads, and the block's padding is 10 9 9
  (the table's 5 9 6 leaves its author 5 px from its top edge, under the
  craft check's 8).
- **the viewer** is the dark pager in both appearances, as a photo wants.
  ctrl or ⌘ with the wheel zooms about the pointer; previous and next are
  buttons under a fine pointer only; the zoom buttons step aside under 520
  px wide, where pinch and double tap do it; focus stays inside it while it
  is open; share is not drawn where the browser cannot share files.
- **peaks** for an agent's note are drawn in a worker that demuxes ogg,
  webm, mp4 (fragmented too) and mp3 and decodes with webcodecs; any other
  kind (wav, flac) stays the flat line. a fragmented aac without an edit
  list keeps its encoder priming, so its waveform can sit one slice late.
- **the thinking chip's meter** has a bar for every level but "off", and
  "off" lights none.
- **a file without a size** shows its type word where the size would be.
- **an unknown part** says "a <kind> part this version of boxbox cannot
  show. update the app to see it." (agents.md asks for the kind and the
  update; these are the words).
- **the agents screen and the picker** (`home/`): the footer's right side
  follows home.md's examples ("working 0:40", "done 11:40", "stopped
  11:31"); a refused card shows no figures in any refused state; forget is
  offered only for a paired agent, confirmed in place as "boxbox deletes
  its pairing with <name> on vm-b and stops reading its threads."; reload
  and restart are held unless the agent is ready; a connecting agent is
  "not answering" in the picker; the picker lists every agent by
  `threads`, cmx included, and arrows walk the dim rows so they are heard,
  though return does nothing on them; the runs window's footer says
  "scheduled" on the left and the newest run's time on the right; while
  stale, a window's "answer" pill is held.

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
  a reply being written is made in units (`markdown-stream.ts`, docs/thread.md),
  so a frame parses and sanitises only the unit being written.
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
| windows | windows, the stage, asks, the composer in home's field and on the full stage, what the composer raises, a machine, a swatch, a repo's mark | the repo's material for the appearance (the deep pair on dark, the light tone in white on light), a lit top edge, a highlight falling from the top left, a long soft shadow in the window's own colour; the composer's menus, its queue's list, the edges behind its strip, the new-thread sheet and the pair sheet are deeper cards of the same plane (`--win-deep-1..2`), not glass |
| glass | the stage's menu, cards that float over the stage (the ruler's, the pinned ask), a fold's name card, the shell picker's menu, the terminal's keys row and its ended plate | backdrop blur 24 px, saturate 1.4, a hairline lit edge |
| liquid glass | the controls over content that a finger touches (the native app's decision 22): home's bar and fold controls, the capsule, the composer, the jump to the latest | `.lg` in `styles.css`: regular (blur 14 px, saturate 1.8, a breath of fill) or `.clear` (blur 3 px, a thinner fill, for a pane that lays its own shade behind its words); one even hairline rim, brighter along the top where the lens catches the light, and a soft drop that falls away below (no lit foot and no tight contact shadow: the foot's line and a 1 px dark blur under the hairline read as a bevel, a dark outline hugging a light one); `--lg-tint` at `--lg-tint-mix` washes in a colour. `.lg-press` answers a press by swelling 6% with a light under the finger. reduced transparency, or no backdrop-filter, gives the solid `--lg-solid` in the same shape, and the press dims to 0.6 instead |

options in an ask are pressed *into* the window (inset shadow); the
primary option sits *on* it in the accent (the light tone on dark, the
deep top colour on light). the composer under a thread and its queue's strip are
clear liquid glass with a pool of shade behind their words; in home's field and on
the full stage, and under reduced transparency, the composer is a window
(`composer.md`, the glass).

**the close.** every surface that closes (a photo full size, a report's
sheet, the details panel and the spend, the assistant's image viewer)
closes with one control, `Close` (`app/src/ui/close.tsx`,
the look `.close-round` in `styles.css`): a 36 px round of liquid glass
(`.lg .lg-press`, the stage bar's and the sheet's rounds) with a drawn
cross, about 12 px corner to corner, two 1.75 px strokes with round caps in
the full ink. a drawn cross sits at the round's centre whatever the face; a
typographic "×" sat low, thin and grey. a pointer over it lifts it 1 px and
lights its fill; the press is the glass's swell; on touch its hit area is
44 px, the round unchanged. a surface that is dark in either appearance
(the image viewer) sets the dark glass tokens and `--close-ink` on itself.
a surface places it and never restyles it.

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
(`cubic-bezier(.2,.8,.2,1)`), and streamed words fade in over 360 ms, by
opacity alone (2026-10-21: the 5 px blur they once settled from is gone
everywhere, the thinking box and home's windows alike; a blur gave every
arriving run a layer of its own).

the rest of the vocabulary is small and lives beside the springs in
`app/src/motion/springs.ts`. nothing else in the app picks a duration or an
easing.

| token | numbers | used for |
|---|---|---|
| press | 90 ms, `cubic-bezier(.3,0,.2,1)` down, the snap spring up | a control sinking to .96 under a finger (.985 for a window or a card) and rebounding. `app/src/motion/press.ts`, one listener for the whole app |
| leave | 110 ms ease-in | a menu or popover going away, and the old screen in a screen change |
| ping | 760 ms, one ring out to 3.6x | a status dot whose state changed in front of you, once |

css reads the same numbers as custom properties written onto the root before
the first frame and again when the device's motion choice changes: each curve
is a pair (`--snap`, `--snap-ms`) and a shorthand a `transition` takes
(`--snap-t`, `--sheet-t`, `--fade-t`, `--press-t`, `--leave-t`). write
`transition: transform var(--snap-t)`. `transition: transform var(--snap)` has
no duration and does nothing; that mistake sat in six stylesheets until the
motion pass.

- **a screen change** (home to the machines or history, the machines to
  settings, and back) is one view transition over the frame: the new screen
  arrives from the right on the sheet spring while the old one sinks to .97
  and is gone in 110 ms; back is the same reversed, with the leaving screen on
  top. a thread (home's own morph), the terminal and the back swipe (the
  finger already moved the screen) do not use it. under reduced motion it is
  the 120 ms fade. `app/src/motion/screen.ts`, `app/src/shell/shell.css`.
- **press.** a touch press starts 70 ms after the finger lands, so a finger
  that lands to scroll or swipe the deck never makes a window flinch; a tap
  shorter than that gets one small blip. a window that is let go of does not
  rebound, since its grow measures it where it stands. under reduced motion a
  press dims to .7 and nothing moves.
- **a status dot** lets go one ring when its window's state changes in front of
  you. it is an event, never a loop: the law's "never animates anything
  forever" stands, and the connection has no pulse for the same reason.
- **the composer.** focus lifts the window's shadow (it moves and brightens
  on the snap spring, so nothing paints per frame); a message you send settles
  into the queue from slightly small; the counts in home's summary line fade
  in when they change in front of you.
- **home, what next** (decision 109; home: what next, above). a thread
  stepping back to home scales to .96 on the sheet spring while its words
  go on the fade curve, and the card's shadow, rim and, at the widest
  rail, the inspector's details fade with it; the field comes down 18 px
  after 90 ms and the list rises 10 px after 140 ms, both on the sheet
  spring; the field's menus drop 6 px on the snap spring. `perf.frames`
  counts it as `home`.
- **recording a voice note** (2026-10-15; `composer.md`, voice, files and
  assistants). a press on the mic key turns the composer into the
  recorder in one content swap (the fade curve): the words and the chips
  give way to the red dot, the timer and the live waveform on the top row,
  "slide to cancel" where the words were, and the key grows from 44 to 52
  px by `scale` on the snap spring, filled with `--rec`, with a 7 px halo
  of `--rec` at 20% that is drawn once and never breathes. the lock (a
  glass capsule 36 x 76) rises 12 px into place above the key on the snap
  spring. the finger is followed 1:1: sideways it drags the key and the
  "slide to cancel" words, which fade as the drag nears the cancel line;
  upward it fills the lock's track. past either line a release commits on
  the snap spring with the finger's velocity; short of it the key settles
  home. cancelling drops the dot and the timer with the leave curve; the
  waveform folds to its centre line by `scale` on the y axis and is gone.
  locking closes the lock's shackle (one 160 ms fade between two glyphs)
  and the capsule sinks into the composer.
- **the live waveform** is a strip of bars, one per 100 ms of input, each
  bar's height the input's peak in that slice. new bars enter at the right
  and the strip moves left by `transform`, one step per bar, with no
  easing; the bars themselves are painted to a canvas once each, never per
  frame. the timer ticks once a second, tabular, with no motion.
- **playing a voice note.** play and pause cross in the fade curve. the
  played part of the waveform is a second copy of the bars in the played
  colour, revealed by `clip-path` from the left as the note plays (one
  update per animation frame while it plays, nothing between notes). a
  scrub follows the finger 1:1 and the sound follows the playhead on
  release. when a note ends and the next row is a voice note, the next
  disc turns to pause as the first turns to play: nothing scrolls unless
  the reader is at the end, which is followed as any new row is.
- **the media viewer** opens from the card's rect on the sheet spring
  (the card's image grows into the viewer, as a window grows into the
  stage) and closes back into it; a swipe down follows the finger and
  closes past 28% or on a flick, as the stage's back does. swiping
  between images follows the finger 1:1 and lands on the snap spring.
  pinch and double tap zoom about the touch point, released into the snap
  spring.
- **a swipe to reply** pulls the row right 1:1 behind the finger, the
  reply glyph fading in at its left; past 64 px a light haptic tick
  (native) marks the line, and release settles the row home on the snap
  spring while the reply strip rises above the composer on the same
  spring.
- **reduced motion** for all of these: the swaps are the 120 ms fade, the
  key does not grow, the waveform's bars are replaced in place instead of
  moving, and the viewer fades.

- **gestures follow the finger 1:1** and release into the spring with the
  finger's velocity. a back swipe can be abandoned halfway and settles
  back.
- **only transform (and its individual `scale`), opacity, clip-path and filter
  animate.** never width, height, top or left in a live screen.
- **streaming.** deltas are coalesced to one paint per frame; a thought's
  words fade in, each 100 ms batch revealed over the frames after it in
  pieces that end at a word, within 80 ms (thread.md, live); the reply renders as markdown as it
  streams, its caret at the end of its last text (raw markup on screen is
  worse than words without the fade, thread.md, live); the caret is the
  only thing that blinks: 530 ms on and 530 off, by opacity, steady under
  reduced motion.

**the earned moments**, each exactly once per real event:

| event | moment |
|---|---|
| tests go green after running in front of you | one sweep of light across the window; the chip draws a tick: "118 passed" |
| you answer an ask | none yet: the card says "sent" and settles when the stream does. the option's flight into your message played only from the window's options, which the window no longer holds (`open.md`) |
| a new thread is sent | the stage opens on it out of home's field, as a tap opens a window |
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
fade, the sweep and the word fade are off.

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

what the app costs while nobody touches it (2026-10-20). the field number
behind these: the installed app at about 20% of a core with the display
asleep, receiving about 21 kb/s. the gate is `bench/idle.ts` (`just idle`,
`verification.md`, the idle run): ten threads streaming and a hundred done,
three minutes a mode, in chromium over cdp. chromium is not the webkit
people run, so the targets are judged as before and after on one machine,
and the baseline is that run on main (f8f04d1), two runs; merged is b2a43eb
(the wire, cache, render and reactive work), two runs on a loaded machine.

| budget | target | baseline | merged | field kind |
|---|---|---|---|---|
| home visible while the fleet streams: main thread busy | 3% of a core | 4.7%, 4.8% | 4.0%, 2.9% | `perf.sync` (the work's volume); busy time has none yet (`open.md`) |
| home visible: main thread allocation | 6 mb/s | 12.8, 15.2 mb/s | 1.3, 1.3 mb/s | `perf.sync`; allocation has none yet (`open.md`) |
| a thread open while its reply streams: long tasks | none over 50 ms | none | none | `perf.longtask` |
| a thread open while its reply streams: main thread busy | 8% of a core | 13.0%, 12.6% | 14.7%, 12.6% | `perf.sync`, `perf.longtask` |
| page hidden while the fleet streams: main thread busy | 2% of a core | 4.6%, 3.9% | 1.6%, 2.1% | `perf.sync` |
| the sync worker, every mode | 2% of a core | under 1% | under 1.5% | `perf.sync` (saves, puts, bytes put) |
| heap, page and worker, every mode | the floor after gc grows under 5 mb a window; the page's peak under 64 mb | flat; peak 42 mb | flat; peak 30 mb | `perf.sync`; the heap has none yet (`open.md`) |
| home visible: main thread per worker post | 2.5 ms, 1.1 layouts | 16.3 ms, 1.2 | 1.8 to 2.1 ms, 1.0 | `perf.sync` (patches posted) |
| a thread streaming: main thread per worker post | 3 ms | 4.4 ms | 3.4 to 4.1 ms | `perf.sync` (patches posted) |
| dom writes that change nothing, every mode | 0 a minute | 131,757 a minute on home (one run) | about 1,200 to 2,100 a minute on home | none (`bench/idle.ts` only) |

the per-minute rows compare builds only at similar worker posts a minute
and machine load: how often the worker posts sets how many frames,
layouts and paints the main thread does. the per-post rows and the dom
writes do not move with it.

for voice and media (2026-10-15), each with its `perf.*` kind (new kinds,
added to `telemetry/schema.ts` with the work, never renamed after):

| budget | target | kind |
|---|---|---|
| mic key pressed to the recorder painted | 1 frame | `perf.record` (`what: paint`) |
| mic key pressed to the first captured sample | p90 300 ms once permission is held | `perf.record` (`what: capture`) |
| the live waveform's work on the main thread | under 2 ms a bar, no long task over 50 ms while recording | `perf.record` (`what: bar`), `perf.longtask` |
| a voice note's play pressed to sound | p90 150 ms when its bytes are held, p90 600 ms when they are fetched | `perf.voice` |
| a waveform drawn for a note | from its peaks within a frame; never a decode on the main thread | `perf.voice` (`what: peaks`) |
| an image card painted | its box at the first frame (zero layout shift); the image within 300 ms of entering the view, decoded off the main thread | `perf.media` (`what: card`), `perf.shift` |
| the viewer opened | within its spring, no dropped frames | `perf.media` (`what: viewer`), `perf.frames` |
| an attachment sent | send to acknowledged as `perf.send`, with its bytes and its post time | `perf.send` |

buffers, each with its cap and its owner (AGENTS.md, memory and latency):

- **the recording** is held by the composer's recorder: encoded chunks
  only (opus or aac, about 24 to 64 kbps), never raw samples, at most 15
  minutes and 12 mb, or the agent's `attachments.maxBytes` when that is
  less, whichever comes first. the live waveform keeps a ring of the last
  64 bar heights (64 bytes); the whole note's peaks are reduced as it
  records to 64 values (`Uint8Array`, 64 bytes) and sent with it.
- **voice notes heard** are never decoded whole into memory: a note plays
  through one media element (web) or one player (native) that streams it
  by range. the bytes of notes played or prefetched live in the cache at
  most 48 mb, least recently played going first, never the note playing
  or the one after it. only the playing note and the next are prefetched.
- **peaks.** your own notes carry their 64 peaks in `waveform`, sent
  with the upload by the device that recorded them. an agent's audio
  comes without them (`docs/agents.md`), so the client draws them: it
  decodes the note in a worker where the platform can (webcodecs'
  `AudioDecoder` on the web, `AVAudioFile` on a background queue
  natively), once, when the card first comes within 2.5 screens of the
  view; until then, and where the platform cannot, the waveform is a flat
  line of the note's length and says nothing false. peaks are kept per
  note in an lru of 512 (32 kb).
- **images** are decoded at the size they are drawn (`decoding="async"`
  and `createImageBitmap` with a resize, in a worker on the web), the
  viewer holds the image in view and its two neighbours at full size and
  no more, and the image cache is at most 64 mb, least recently seen
  going first.
- **attachments waiting to send** are held by the outbox under its byte
  cap (composer.md), which counts files and voice notes with the photos.

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

renamed **the agents** on 2026-10-15: the same screen and the same cards,
with an assistant's card among the machines' and "add an agent" as its
ghost. what changed and every pairing state is in `home.md`, the agents.

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
  pulses. under the head one mono line: `cmx2 0.8.3 · up 3 h · paired`
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
  counts them: an ask outranks a running turn), **cmx2 memory** (the
  daemon's rss from the newer of its memory and system reports, absent for
  a daemon that reports neither; named for cmx2 since the meters below
  hold the machine's own memory). while the machine is
  not connected they are the last it said, the numbers in the second ink;
  a machine never reached shows none.
- **what a machine is** (2026-10-17), from the host's `system` (cmx2's
  `GET /global/system`, sampled every 30 s: architecture.md, the daemon
  verbs). the head leads with the os's mark in a 44 px tile, a squircle
  of the window's accent at 12% with a glow of it from the top left, the
  window's lit edge and a ring of the accent at 22%, the glyph in the ink
  (`ui/machines/marks.tsx`: an apple for darwin, four panes for windows,
  ubuntu's circle of friends, debian's swirl, a penguin for any other
  linux, a plain screen where the os is not known). the marks are drawn
  in the app's icon line (24 grid, 1.6 stroke, round), never a vendor's
  logo file, and are identity only: aria-hidden, unchanged by the
  connection. beside the tile, the name and the chip on one row and under
  them, across the chip's column too, what the machine is in its own
  words: `Mac mini · macOS 26.1`, `Google Compute Engine · Ubuntu
  24.04`, `virtual machine · Ubuntu 24.04` for a vm without a model, the
  os alone (`Arch Linux`) for a box that names none. an older cmx2
  (`reportsSystem` false) says "update cmx2 to see this machine's stats."
  there, in the second ink, with the plain screen in its tile, and draws
  no meters; a host not yet sampled or never reached says nothing there.
- **how it is doing.** under the figures, one bed pressed into the window
  (the ask's press) holds three meters: **cpu** (`load 2.41 · 14
  cores`, the figure the 1 minute load as a share of the cores, past
  100% when saturated), **memory** (`41 of 64 gb`, in the binary units
  memory is sold in; used is total less available, as activity monitor
  counts it), **disk** (`213 gb free`, in the drive's decimal units; the
  meter is absent when the daemon could not read its disk). each is a
  row of name, mono words and a tabular mono figure, over a 6 px channel
  holding a lit tube of the accent (brightest at its leading end, a
  highlight along its top, a short glow). the cpu's channel carries two
  notches, its load over 5 and 15 minutes (the older fainter), so the
  quarter hour's direction reads at a glance. under the meters a quiet
  mono spec line: the cpu's model, the architecture and `up 9 days`
  (the host's uptime, said only while connected and from a sample of this
  connection, as the daemon's), or `as of 14:02` while the machine is
  away. **strain** is the machines' amber (`#8a4b00` on light, `#ffc266`
  on dark), never red, which stays a failure's: the cpu at or past its
  cores, memory under a tenth free, a disk under a tenth or 5 gb free;
  the tube and the figure take it, the cpu's figure is then past 100%,
  and memory and disk say `1.2 gb free · low` in words too. while the
  machine is not connected the meters are its last sample, the tubes
  unlit in the third ink and the words in the second. **motion:** the
  meters are kept by place, so a new sample slides each fill (a
  full-width bar moved left by what is unused, clipped by the channel)
  and each notch by transform on the sheet curve, and nothing around them
  moves; opening the screen fills each tube once from empty; reduce
  motion places them still. each meter is a `meter` to a screen reader,
  its `aria-valuetext` the whole reading ("cpu: load 2.41 on 14 cores,
  1.98 over 5 minutes, 1.70 over 15").
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
  (`--win-deep`, as the new-thread sheet was), brought into view where it
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
five groups of hairline rows on the ground: *this device* (appearance:
system, dark, light as a segmented control, a track pressed into the
ground with the chosen option on it in the light tone; reduce motion as a
switch whose knob moves on the snap spring by transform, "follows the
system" until chosen and "follow the system" to go back), *home*
(2026-10-26, the person's prefs, so every device agrees: "clear finished
windows" as a segmented control the row's width under its words, "1 h
after seen", "3 h, seen or not", "never"; "fold working windows" and "job
notices count as needs" as switches; each row's hint says what it does;
until the prefs are read the rows are disabled), *what reaches
this device* (the notifications row below, then the four push kinds as
switches once subscribed, and the other devices' choices read-only), and
*new threads* (each repo with threads, most recent first: model and
effort as native selects pressed into the ground, 16 px on touch, with
"the machine's default" and "the model's default effort" first), and
*repo colours* (each repo by machine and root, newest thread first: its
mark, its machine, and its colour's dot with "green · automatic" or
"sunset · chosen"; a press opens the colour sheet, colour above). a chosen
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

the words agents brought (2026-10-15): "start something", "with <name>",
"message <name>", "via whatsapp", "voice note", "<name>'s voice",
"transcript", "what <name> said", "transcribing", "slide to cancel",
"thinking", "listening", "replying to", "scheduled", "heartbeat", "runs",
"no longer on vm-b", "no longer on the server", "not confirmed", "send
it again", "answer by", "stale", "syncing", "agents", "add an agent",
"waiting for approval", "untested", "paired". the approved screens' gendered words ("her voice",
"what she said") are written with the name: boxbox does not know an
assistant's pronouns.

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
