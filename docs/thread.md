# the thread

the reading law for a thread: what a turn is made of, how the work is
folded, how you move through it, how it links, and how every state of
every part looks. it extends `design.md` (the stage, the composer, the
scroll law and the materials are decided there) and is binding the same
way (AGENTS.md, rule 6). it was accepted 2026-10-01; the implementation
is `app/src/ui/thread/`, and every part type and state below has a story
under `app/.ladle`.

## the direction: the ledger

a turn is a ledger. one row for each thing the agent did, in the order it
happened, and nothing summarised away. the kind of thing on the left,
the thing itself, and what came of it on the right; the clock in the
margin beside it where the minute changes, wherever the stage leaves a
margin. what the agent said to you breaks out
in sans between the rows; what it thought is a quiet row you can open.
every row opens in place to its output, its diff, its hits or its
thoughts. failures and pending asks are open already. heavy turns carry
a tape at the turn's end, the turn's work drawn in time. live, the turn
is the same ledger growing at its end, and the tape rides at the bottom
of the view beside it.

why: summaries in place of the work ("ran 6 commands") read as lazy;
truncation hides what a reader came to read; anything read often must not
hide behind a tap;
things shown in one place and hidden in another read as jank; a modal
that opens the work is a symptom of a page that hides it; and nothing may
float or change shape while a turn runs.

## anatomy of a turn

```
                         ┌─────────────────────────────┐
                         │ okay now go ahead and       │  your message, right
                         │ implement everything   17:17│
                         └─────────────────────────────┘
  17:17 │thought  Implementing everything is a big   20 s   the ledger; the clock
        │         scope, so I need to plan this               hangs in the margin
  17:18 │Starting implementation. First I need to know what   prose runs the measure
        │I can build and verify here.
        │run      6 commands: git status, git        2 s
        │         branch, git log, xcodebuild
        │thought  I see there are uncommitted            4 s
        │         CloudLibrary changes in the tree
        │skill    ios-autonomous-dev
  17:19 │read     StreamView.swift, StreamSurface.swift
        │edit     UpscaleStrategy.swift             +46 -0
        │         Packages/VideoRenderingKit/Sources
        │run      bun test               ▬▬▬▬ 54 passed
  17:49 │files    changed 19 files            +4,391 -25
        │stopped  you stopped it after 11 min                 only if it was
        │Everything is already on origin. Both repos are     the answer
        │clean.
 ┌───────────────────────────────────────────────────────┐
 │ worked 32 min          89 steps, 52 thoughts, 1 agent │  the tape, the turn's
 │ thinking ▬▬  ▬ ▬▬   ▬▬▬    ▬ ▬▬                       │  footer (heavy turns);
 │ tools    ▮▮| ||▮ |▮▮| || ▮   ||| ▮ |                  │  live, it sticks to the
 │          transport_impl, 128 steps                    │  bottom of the view
 │ agent               ▬▬|▮|||▮▮▬▬ ||▮|                  │
 │          17:17      10 min      20 min          17:49 │
 └───────────────────────────────────────────────────────┘
```

in order:

1. **what started the turn.** your message as the bubble on the right
   (`design.md`: light on the dark flood, the deep pair on the light one),
   with its time; "queued, 17:17" or "steer, 17:17"
   when it was one of those; in an agent's own thread, the brief its parent
   sent is the same bubble, "brief, 17:17" ("brief from worker_a," when a
   nested agent sent it). an agent's report is a quiet card ("transport_impl
   reported, 17:49" and "copy" in its header, the report's markdown,
   clamped to eight lines with "read the whole report" when longer than
   700 characters); a note from
   another agent is the same card, "worker_a wrote". a runtime
   notice (a job finished, a wake) is one mark line. a compaction is a
   mark line, "compacted here. show the summary", opening the summary card.
2. **the ledger** is the rows.
3. **the files row**, when the turn edited anything: "changed 19 files,
   +4,391 -25", opening to every file with its counts and its diff.
4. **how it ended**, when it did not end well: "stopped: you stopped it
   after 11 min" or a red "failed" row with the daemon's reason.
5. **the answer** is the prose after the last step, markdown at reading
   measure, flush with the rows' kind column and the title: it runs the
   whole measure. once it has settled, one quiet line under it holds
   "copy", which copies the answer's markdown as the agent wrote it (see
   "code and copying").
6. **the tape**, only on a heavy turn (see below): the turn's footer, its
   receipt, after the answer, live and settled.

turns are separated by 32 px; inside a turn everything is 16 px apart.

## the row

```
        ┌────────┬──────────────────────────────────┬────────────┐
  17:18 │ run    │ bun test 2>&1 | tail -8          │ ▬▬▬ 54 passed│
        └────────┴──────────────────────────────────┴────────────┘
  clock   kind     the thing                          the result
  in the  50 px    the rest                           at most 20ch,
  margin                                              none if silent
```

- **the clock** shows when the minute differs from the row above; the
  first row of a turn always shows it. mono 10.5 px in the second ink
  (the faint one is under 4.5:1 on the floods). it is marginalia, since a
  time marker inside the line takes horizontal space and narrows the
  readable area: it hangs outside the
  measure, right-aligned 14 px before the row's text, on the row's first
  line, and takes no width from the words. it shows only where the stage
  leaves it a margin with at least 20 px to the stage's edge (the
  scroller's content 720 px and up, said to the stylesheet as `data-clock`
  by `measure.ts` and not by a container query (`gotchas.md`, containment);
  there the measure may give up as much as 34 px so the room is always there): the ipad
  strip, the rail, a laptop. on the phone it is not shown and its width is
  the words'; the bubble carries the turn's time, a pause over 90 s keeps
  its "N min later" line, and an open command's facts say "at 17:29:06"
  (an agent's "started 17:19:01").
- **the kind** is one word, mono 10.5 px, dim: `run`, `watch`, `type`,
  `commit`, `push`, `edit`, `write`, `read`, `grep`, `find`, `recall`,
  `fetch`, `search`, `agent`, `ask`, `plan`, `skill`, `note`, `wait`,
  `agents`, `thought`, `files`, `stopped`, `failed`. `agent`, `ask`,
  `commit` and `push` are in the repo's light tone because they are rare
  and matter; a failed row's kind and result are red.
- **the thing**, mono 12.5 px at 20 px line height for anything the
  machine did; sans for language (what it said, what it thought, what it
  asked). that is the one rule for faces: mono is the machine's, sans is
  words for you.
- **the result**, mono 11.5 px, dim, right aligned, never wider than
  20 characters: `54 passed` with a pass/fail meter, `3 failed`, `no
  errors`, `2 errors`, `exit 1`, `+187 -0`, `+46 new`, `12 hits`, `4
  files`, `170 lines`, `40 of 312`, `reported`, `wants you`, `answered`,
  `dismissed`, `stopped`, a hash chip for a commit, a tick for a push, a
  live clock while something runs, a duration when a command took 1.5 s
  or more, and nothing at all when there is nothing to say. silence means
  it went fine; only red means it did not. a passed test run, a clean
  build, a commit and a push use the light tone: earned.
- the row is a button when it has something to open (`aria-expanded`),
  a plain row when it does not (what it said). rows bleed 8 px past the
  text on both sides so an open row's surface holds its text well inside.
  gaps between columns: 8 px on the phone, 12 px at strip and rail sizes.
  a row with no result leaves no gutter for one: its words run to its end.

what each kind shows, and what opens beneath it:

| kind | the thing | the result | opens to |
|---|---|---|---|
| run | the command: program lit, flags and prefixes toned down, everything after the first pipe toned down. a chain reads "6 commands: git status, git branch, git log…" (see display rules) | evidence from its output (tests, build), `exit N` in red, a duration when 1.5 s or more | the command whole in a bed of its own (home as `~`), facts (where it ran, unless the command's bed says so with its `cd`; exit; took; when), the output head and tail in a bed headed by its line count, with "N lines not shown", the error in red |
| watch, type | the command it watched, or what it typed "into" it | the same | the output it saw |
| commit | the subject, in sans | the hash as a chip | `+a -d in N files` |
| push | `branch to origin` | a tick | nothing |
| edit | the file name, then its directory on one line, cut from the start so the part nearest the file stays | `+a -d` | the file line (where in the file it landed), then the diff |
| write | the same | `+N new` or `+N` | the file's content as a diff of additions; "and N more lines" past 80 |
| read | one file: name and directory. several: the names, up to six; past six, "14 files" | one file: `312 lines` or `40 of 312`. several: nothing | every file with its span and a file line; the first file's opening lines; the images it returned as thumbnails under their file (design.md, the transcript) |
| grep, find, recall | the pattern in the string tone, "in dir" when scoped; several fold to `"a", "b", "c"` up to four, then "5 searches" | `12 hits`, `8 files` | hits by file with the match lit; a glob's files |
| fetch, search | the host and path; the query | `6 results` | titles, domains |
| agent | the name, then the first sentence of its brief in sans | `reported`, a live clock while its child works (the turn's or not), `wants you` while the daemon waits on the person for it, `parked` while it waits on agents of its own, `128 steps` when its turn ended and never reported, nothing when it never started | its state in words ("working for 7 min", "reported after 4 min", "waiting on you", "parked on agents of its own", "its turn ended, no report", "did not start"), its steps, its seat, the whole brief when longer than its first sentence, and the door: "open its thread" (below) |
| ask | the question, sans 14.5 px | `wants you` while pending, `answered`, `dismissed` | the options as buttons while pending (the first in the light tone, "or type an answer"); "you answered hello" after |
| permission (an edit, run or read row that is waiting) | the row it belongs to | `wants you` | "wants your permission to edit notes.md", the diff, allow once / always allow / deny, "or deny and say why" |
| plan | the current item | `2 of 5` | every item with its state |
| skill | its name | | |
| note | `to parent` | | |
| wait | running: what it waits on, `for 2 agents` (the agents at work under it), `for a reply` (a correlation id) or `for a job or a message`; done: who it heard from, `from helper`, `from a background job`, `from root`, or `nothing came` | a duration; `timed out` | |
| thought | the first sentence, sans 13.5 px at 60%; "8 thoughts: " leads a fold | the time spent | every thought in full, each with its clock and duration |
| (said) | the prose, sans 15.5 px (16 at strip and rail), spanning the whole row, as markdown | | nothing; it is not a button |
| files | `changed 19 files` | `+4,391 -25` | every file with its counts and file line; each opens its combined diff |
| stopped | `you stopped it after 11 min` | | |
| failed | the daemon's reason | | |

a **gap** of more than 90 s between one row ending and the next starting
is a dotted line labelled "3 min later", starting at the kind column.
live turns show no gaps; the tape carries the time.

## folding

- consecutive **thoughts** fold into one row: "8 thoughts: " and the
  first sentence of the first. its result is the time they took together.
- consecutive **reads**, consecutive **searches** of one tool, and
  consecutive **web lookups** of one tool fold into one row.
- **commands, edits, writes, agents, asks, plans and failures never
  fold.** a failed read stands alone.
- a thought, a sentence or any other kind between two reads keeps them
  apart: the ledger never reorders.
- reads of one file inside a fold merge (two spans, "2 reads").

## display rules

these decide how a thing is shown, never whether it is shown.

- **a chain** (`&&`, `||`, `;` outside quotes) reads "N commands: " and
  the short form of each in order (program and subcommand: `git status`,
  `bun test`, `xcrun simctl`), duplicates dropped, at most five named,
  "and 3 more" past that. `echo`, `cd`, `export`, loop and branch keywords
  are not commands. the whole line is in the open row.
- **a single command** shows in full with the program lit (weight 560),
  flags, `2>&1`, `time`, env assignments and everything after the first
  pipe faint, strings in the light tone at 85%. a `cd dir &&` prefix is
  dropped from the row; the open row's command bed shows it (home as `~`),
  and says where it ran there, so the facts say "in dir" only for a workdir
  the command does not name.
- **closed rows clamp at two lines** (40 px), the second fading to 18%,
  except what it said, asks, and file rows (a name and its directory).
  opening removes the clamp. a thought's open row shows "for 20 s" (or
  "8 thoughts over 36 s") in place of the teaser, so the text is never
  shown twice.
- **file names** break only between their words (`SampleBuffer` /
  `DisplayView.swift`), never inside one; **directories** are one line,
  cut from the start with an ellipsis; **patterns** may break after `|`;
  prose wraps normally. nothing is cut mid-word anywhere.
- **paths** are shown relative to the session's project root; outside it,
  with `~` for home.
- **an agent's brief** shows its first sentence; the whole brief opens.
- **your message** clamps at six lines with "show all 423 characters";
  a report at eight with "read the whole report". the answer never clamps.
- numbers are tabular everywhere; counts carry thousands separators.

## open in place

- a tap on a row opens it beneath the header; only transform, opacity and
  clip-path animate: the rows below slide (flip, measured once), the body
  reveals under a clip. a second tap closes it. several rows may be open.
- **open by default.** a failed step (its red error), a pending ask, a
  pending permission. nothing else; the rest is one tap away.
- **show thinking** (the thread menu, stored per device) opens every
  thought row and keeps new ones open. live, the current thought is always
  open.
- an open row has a surface (black at 20%, inset shadow, radius 14); a
  closed row has none. beds (output, diffs, file lines) are darker insets
  (black at 30%, radius 12) that scroll sideways and fade at the edge they
  continue past; the page never scrolls sideways.
- the files row's list opens one file at a time, its diff under it.

## every state

parts on the wire are `text`, `reasoning`, `tool` and `file`
(`vendor/cmx2/openapi.json`, `Part`); a tool's state is `pending`,
`running`, `completed` or `error` (`ToolState`). every combination has a
row, and a story:

| part | state | the row |
|---|---|---|
| text, user, typed | | the bubble; "queued," or "steer," before its time when it was |
| text, user, `mail` kind `task` (the brief that started this agent) | | the bubble, "brief," before its time |
| text, user, `mail` kind `report` (an agent's report) | | the report card |
| text, user, `mail` kind `message` (a note from another agent) | | the report card, "worker_a wrote" |
| text, user, `mail` kind `job` or `system`, or `notice` | | the mark line |
| text, user, `synthetic` | | not shown (context the daemon added) |
| text, assistant | streaming | the said row with a caret at the end; words arrive with the blur settle; in a running turn it is the window's newest row, from the announcement of the part |
| text, assistant | settled | the said row; the last one after the last step is the answer, as markdown |
| reasoning | streaming | live: "thinking" with a running clock, its text in a 112 px box that follows the newest line |
| reasoning | settled | the thought row, folded with its neighbours |
| tool | pending | the row with `waiting` in the light tone; a permission ask on it opens the permission card |
| tool | running | the row with a live clock; a shell's last 2 kb of output in the open body, following the newest line; a running command on the tape stretches |
| tool | completed | the row with its result |
| tool | error | red kind and result, open, the error in a red bed; "stopped" and faint when the error is an interrupt (`MessageAbortedError`, `interrupted`) |
| file | | a thumbnail row: the file name and its size, opening the image or the document's first page |
| tool | completed, with images (`state.attachments`) | a read of an image says `1 image` in place of its lines and opens to thumbnails under its file's line, each opening full size; a fold of reads groups them by file; a command's or a script's open body draws them too. at most eight, then "and 3 more images" (design.md, pictures a tool returned) |

the turn's own states, from `MessageInfo` (`time.completed`, `error`,
`finish`) and the status map:

| state | the turn |
|---|---|
| working | live layout below; the header's line says "working 3:40, 12 steps" with a stop control |
| done | the ledger, then the answer |
| aborted (`MessageAbortedError`, or `finish: aborted`) | the ledger, then the stopped row; the tape says "stopped after 11 min" |
| failed (any other error) | the ledger, then the red failed row with the reason |
| retrying (`SessionStatusRetry`) | the header's line says "retrying in 20 s, attempt 2: rate limited"; the ledger keeps its shape |
| parked (`SessionStatusIdle.parked`) | with agents at work the thread is working: the header's line says "working 0:41, 2 agents" (a live clock from when its own turn handed over; a door to the agents panel) and the window is "working"; parked on jobs alone, "parked, waiting on 2 jobs". the last row is the wait or the agent |
| queued behind (`info.queued`) | the provisional message is a faded bubble; it becomes solid under its transcript id when it lands (`message.removed` retires the provisional one) |
| compacted | the mark line and the summary card, from the assistant message with `summary: true` |

asks (answered in place; the routes are under "the stage, as built"):

| ask | state | shown as |
|---|---|---|
| question | raised (in the fleet's pending list) | the ask row, open: the question's own short label above its words in the light tone (the one the window shows), options as buttons, each with its description wrapped under it; the first option is primary; "or type an answer" when the daemon takes one; "dismiss". the row's head is the question, across the row's whole width on a phone |
| question | raised with several questions (one ask, one list of answers per question) | the row says "2 questions"; the card has a block for each (its header, its words, its options, its typed answer) and one "answer" that sends them all once each has an answer; the options choose, they do not send |
| question | running but not raised (the daemon has not put it yet; on 2026-09-30 a turn's asks came one at a time, on 2026-10-01 together) | the row closed, `waiting`; open, it says "waiting its turn: not asked yet" |
| question | answered | `answered`; "you answered hello" opens |
| question | dismissed (`question.rejected`, or the turn aborted) | `dismissed`; the tool row is an interrupt, not a failure |
| permission | raised | the tool row it belongs to, open, `wants you`: "wants your permission to edit notes.md", the diff, allow once, always allow, deny, "or deny and say why" (an input) |
| permission | allowed once, always | the tool row runs; its facts say "you allowed it once, 17:18" or "always, for this project" (m4 carries who and when) |
| permission | denied | the tool row is an interrupt: "you denied it"; the agent's next words explain |
| any | in a live turn | the row's card arrives in the transcript where it was asked; the thread's window on home shows only its preview and keeps its size (`design.md`: an ask never grows its window) |
| any | named by a window's "answer" pill, the bar's "wants you", the capsule or a push | the stage goes to the ask's row (only its own scroller moves, and the row's top lands just below the bar, the bar's laid-out height plus its 36 px fade; the end's pin lets go for it, so the thread does not follow itself back to the end), its card takes focus, and one ring in the repo's light tone is drawn round the whole row, on the row's own box (the row is not lit as well: two boxes read as two things); a stage already on the thread goes there too (`stage.tsx`, `goToAsk`). a stage under another layer, or under the new-thread sheet, takes the focus when what covers it lets go, and one poured again on top of its own thread's agent takes it as it mounts; an ask the thread does not show yet is waited for, 4 s from the moment the fetch behind the thread has landed (a cache's rows are from before the ask), and then the focus is let go; an ask the fleet does not hold, once the stream has caught up (a second after it went live: it is live at the hello, before the replay brings the asks), is let go at once |
| any | scrolled out of view | one line above the dock, "wants you: which greeting?", that scrolls to it; never lost, never shown twice. a review waiting has the same line ("ready to merge" and its note) while its card is out of view, and an ask's line outranks it (design.md, ask) |
| a reply | sending | the tapped option pressed, the rest quiet, "sending" |
| a reply | sent | "sent: hi" until the ask leaves the stream, when the row settles; the `perf.send` row is stamped then, from the stream, never from the local call |
| a reply | not sent | "not sent: the server is not answering. tap to try again." in red; the retry carries the same `clientID`, so it cannot answer twice |
| a reply | already settled elsewhere (409) | "answered on iphone at 23:49" from the daemon's `{by, at}` (a6), a quiet note with nothing to retry and the options held; the row settles from the stream and keeps the note |
| a reply | the ask is gone (404) | "this is gone: it was answered, or its turn ended.", the same: a note, nothing to retry |

agents (the row reads the child's own state from the fleet, so it is right
after the parent's turn ended too):

| state | the agent row | the tape |
|---|---|---|
| started, working (the child's status is busy or retrying) | `agent name`, a live clock from when it was started; the facts say "working for 7 min" | a lane under the tools lane, labelled with its name and step count, from the moment it started. a settled turn whose agent still works keeps its tape's clock running: the header says "working 7:21, through its agents" in the light tone, the scale runs ahead as it does live, the head moves |
| wants you (an ask is pending on the child) | `wants you` in the light tone | the lane holds |
| parked (the child's status is idle with `parked`) | `parked`; "parked on agents of its own" | the lane holds |
| reported | `reported`; the report card appears where it arrived, and links back | the lane ends |
| never started (no child session) | no result; the facts say "did not start" | no lane |
| idle without a report | `128 steps` once its thread is held (nothing until then); "its turn ended, no report" | the lane ends |
| gone (the fleet knows the parent and not the child: archived or deleted) | `archived`; "its thread was archived"; no door. the agents panel's row says "archived" and is not a control | the lane stays as recorded |

### an agent's own thread

a subagent is a session of its own (`parentID`), and `design.md` decides
it opens as its own stage: tap to open one, back returns to the parent at
the same scroll position. as built:

- **the door.** an agent row that has a child opens to "open its thread"
  (`agent-door`, named "open helper's thread"); the agents panel's rows
  open the same way.
- **the stage over the stage.** home stacks the agent's layer over the
  parent's (`home.tsx`, `openAgent`): the new layer slides in from the
  right on the sheet spring while the parent's recedes under it (scale
  0.96, half opacity), still mounted and `inert`, so its scroll, its open
  rows and its live state are exactly where they were when back lands.
  back (the bar's button, the deck's edge swipe, escape) slides the layer
  out and restores the parent's url place. an agent's thread opened on its own
  (a link, a relaunch) has no parent layer: its back opens the parent in
  its place, by a fade.
- **the subagent's stage** says whose it is: the repo line reads "work ·
  an agent of the long helper", its back is "back to the long helper"
  at every size (strip and rail stages have no other back), and its own
  agents, status line, composer and menu are the ordinary ones. it keeps
  the parent's colour.
- **the agents** are a section of the thread's details (design.md, the
  header, the details and the menu), wherever the details show (home's
  inspector at the rail 1400 wide and up, docked in a wide stage, a sheet
  on the phone): one row per agent the thread started, read from the
  fleet (every session whose `parentID` is this one, however it was
  started: the spawn tool, or `agents.spawn` inside a `run` script, which
  leaves no spawn part at all, cmx2 ask a27), named by the spawn row that
  started it when there is one, else by the daemon's title "name (seat)";
  the ones at work first, then waiting on you, parked,
  the rest by when they started: its clock, its name (with its session's
  last four characters when two share a name), its seat dim, and under
  it "working 7:21" in the tone, "wants you", "parked", "reported" or
  "128 steps" ("no report" while its thread is not held: see agents, held
  when wanted). its heading counts "1 working". the details open from the
  thread menu ("details", with a count), the facts line, the bar's details
  toggle, from the status line
  whenever that line is about agents ("working 0:41, 2 agents",
  "waiting on 2 agents for 3:12" are buttons then) and from the
  composer's plus menu, where an "agents, 2" row sits with the other tools
  (it was a key in a tools row that appeared on focus; the usability work
  moved every tool behind one plus key, `composer.md`). one panel is open
  at a time; opening it closes the turns.
- **the status line** tells waiting from working: a turn sitting in a
  running `wait` says what it waits on: "waiting on 2 agents for 3:12"
  (the agents at work under it, and a door to the agents panel), else
  "waiting on a reply from its parent" when the step before it messaged
  an agent, "waiting on a reply" for a correlation id, else "waiting on a
  job or a message". it never says agents when none is at work: an agent
  waiting on its own background jobs is not waiting on agents. with the
  stop control; a
  session the daemon calls parked on agents says "working 0:41, 2 agents",
  since its agents are its work; parked on jobs alone, "parked, waiting on
  2 jobs". the live line on
  home's window says "wait" for the same step.

## the tape

a heavy turn (more than 6 steps, or longer than 3 minutes, or any agent)
carries the tape at its end, after the answer: the turn's footer, its
receipt. it is a reading of the turn's time:

- a header: "worked 32 min" (or "stopped after 11 min", or, live,
  "working 0:37" in the light tone) and the counts: steps, thoughts,
  agents, failures in red.
- two channels with labels like track headers: **thinking**, a 4 px line
  with a filled span for each thought; **tools**, a 20 px lane with a
  mark for each step: a block as wide as a command ran (1.2 s or longer),
  a full tick for an edit, a short tick for a read or search, a white tick
  for an agent starting, a white diamond for an ask, red for a failure.
  one colour for the kinds; the ledger carries the detail.
- one lane per agent under it, labelled "name, 128 steps", starting where
  the agent started.
- a scale: the turn's start and end as clock times at the ends, marks
  every 30 s, 1, 2, 5, 10, 15, 30 or 60 minutes so there are at most six.
  quiet stretches over three minutes fold to a notch so the work fills
  the width.
- **scrubbing.** a drag across the tape moves a playhead and a caption
  ("17:36, 19 min in / write MetalVideoRenderer.swift / +433"); letting go
  scrolls the ledger to the row for that moment and lights it for 1.6 s.
  on touch, a sideways drag scrubs and a vertical one scrolls. the tape is
  a slider to assistive technology.

## live

2026-10-02: a person checking on a running turn could not see or scroll
through what was going on right now, and had to scroll up to find the
timeline, which belongs at the bottom. so a running turn is the same ledger as a settled one,
growing at its end, and its instrument rides at the live edge:

```
 ┌─────────────────────────────┐
 │ your prompt                 │
 └─────────────────────────────┘
   read   notes.md      4 lines     every row as it happens, and any
   edit   notes.md       +1 -1      of them opens while the turn runs
 ┌ run    xcodebuild       0:16 ┐
 │   $ building…               │   the newest row, open, following
 └─────────────────────────────┘   the newest line of its output
   the reply streams here as        the reply, as markdown, with its
   markdown, with its caret▌        caret
 ┌─────────────────────────────┐
 │ working 1:34  5 steps, 5 th…│   the tape: the turn's footer; while
 │ thinking ▬▬  ▬  ▬▬          │   the turn runs it sticks to the
 │ tools    |  | ▮  ▮▮▮|       │   bottom of the view
 └─────────────────────────────┘
 ┌ the composer ───────────────┐
```

- **every row, as it happens.** each step is a row of the ledger from the
  moment it starts (a text or reasoning part from its announcement), and
  any row opens while the turn runs: a person checking on the agent reads
  a command's output or an edit's diff without waiting for the end. a new
  row rises in (18 px, the snap spring); nothing above the end changes.
- **the newest row is open** with its live body: a thought streams into a
  112 px box that fills from the top and then follows its newest line
  under a fade; a command shows its last 2 kb of output the same way; an
  edit shows its diff. when the next row arrives, the row before closes
  unless the reader opened it. one fixed box at the end keeps the end
  steady: a streaming body never grows the page line by line, and for a
  reader at the end a step moves the rows above up by one row.
- **the reply streams as the newest said row**, at full height, as
  markdown (the answer's sanitised rules, parsed at most once a frame, the
  caret at the end of its last text). only the blocks whose html changed
  are replaced: a code block that has settled keeps its node, so its copy
  control keeps focus, hover and its "copied" while the reply goes on
  beneath it. every said row reads as markdown, so
  a list said mid-turn is a list. at the settle the trailing reply steps
  into the answer's type in place, with the same structure, so only its
  size changes, once, and it fades up 10 px. a thought's words keep the
  blur settle; the reply gave it up, because raw `**` and `-` on screen
  were the worse defect.
- **a pending ask** is its row, open, at its place; while it is out of
  view the pinned line above the dock carries it.
- **gaps** ("3 min later") show live too, where they happen, so the settle
  adds nothing.
- **the tape is the footer** of a heavy turn, live and settled, and arrives
  at the end the moment the turn turns heavy, the way a row does. **while
  the turn runs it sticks to the bottom of the view** (`position: sticky`
  within its turn), resting exactly where it sits for a reader at the end,
  40 px above the scroller's foot, so scrolling back through the running
  turn moves nothing and the instrument stays beside the stream; above the
  running turn it leaves with it, and the composer's line carries the
  newest step there. live it floats, so it is a card in the flood's own
  colour, its foot lifted a step toward the light (on the dark flood a
  touch of white, on the light one more), with the glass edge and a soft
  drop; never a neutral grey slab on a coloured stage. it cannot blur what
  passes under it, because the scroller's mask turns `backdrop-filter` off
  (`gotchas.md`), so while it is stuck the scroller's mask also clears the
  band between the card and the composer: nothing reads below it. at the settle it lands into the
  page as the pressed well, a 160 ms cross-fade. on a stage 600 px wide or
  less, while stuck, it is drawn without its scale (the card sits 24 px
  lower so its foot stays on the line; its layout box keeps its height, so
  the scroll range never changes and a stuck tape at the end can always
  let go). scrubbing works live: letting go lands on the row, which unpins
  the stage. the new-below pill and the pinned ask ride 10 px above the
  stuck card.
- **the stage follows the end** while the reader is pinned to it: any growth
  of the transcript, and any change of the scroller's own box (the dock
  taller, the keyboard up), is scrolled to in the frame that paints it, so a
  new row is never painted below the fold first. being pinned is a latch
  (`pin.ts`): only the reader's own scroll lets go of it (a wheel, a touch, a
  pointer, a key, a finger that went down on the scroller from its first
  touch to its last lift (the lift of a tap on send or queue is not a scroll
  of theirs), or the scroll the stage makes for their tap on a link, a step or a
  turn; momentum after the lift is theirs for 900 ms), and it is taken back
  by scrolling to within 48 px of the end or by sending a message, which is
  the reader asking for the end and the one thing that moves a reader who
  had scrolled up (the composer's own send or its typed answer to a question, not a card
  sent again after it was taken back). a scroll event the reader did not make says nothing about
  whether they left. one that follows the stage's own write or a change of
  the transcript's or the scroller's size within two frames (counted in
  frames, since a page that janks runs them late), or that lands on the place
  the view was left from by one of the stage's last writes (webkit restoring
  the old offset a few frames late when the dock took a card), is the browser
  clamping or snapping, and while pinned it is answered by putting the end
  back, even inside the reader's window (a restore is asked before it); the echo of the stage's own write (an event at the place it wrote)
  is neither the reader's nor a change, so a stream that writes every frame
  never keeps the reader's window open. any other (find in page, focus
  moving into a row, voiceover's scroll, which send no input) is read for
  where it left the view, so a reader using them can leave the end. the
  moment the reader scrolls up, nothing moves (the scroll law). a change the reader makes (opening a row,
  "show all", a report's whole text, a compaction's summary) is never
  chased: the tapped row keeps its place to the pixel (`FollowContext`;
  the scroller's own scroll anchoring is off, since it moved the tapped
  row).
- **only what changed changes.** the clock text, the newest text, the
  result of the current row; a row's html is rebuilt only when what it
  reads changed.
- the header's line and the bar's line say "working 1:34, 5 steps" with a
  stop control, and "done just now, worked 1 min" for a minute after a
  turn the reader watched ends.
- **the settle changes as little as it can.** the newest row closes, the
  trailing reply becomes the answer, the tape lets go and lands as a well.
  a reader at the end stays at the end however the end moved; a reader
  further up stays exactly where they were (the stage's `SettleContext`).
  the room it leaves under a shorter end (`--hold`, the scroller's end
  padding) is bounded (`endRoom`, `pin.ts`): room that would fill the view with
  padding is not kept, the view goes to the new end. a hold is padding, padding
  is part of the scroller's box, and a flex item is never smaller than its
  padding: a hold of 100,787 px (the settle read the list at 65 turns and laid
  it out at 8, see the shown list above) made the scroller 100,827 px tall in a
  917 px stage with the view in the padding, and the release (it reads the
  scroller's height, which the padding was) could not fire: the thread blank
  until the next message or a reload.

decided here, where the law was silent:

- **a part is a row from its announcement.** at contract v5 a text or
  reasoning part is announced (`streaming: true`, `time.start`, no text)
  before its first word: its row opens then, a thought with its running
  clock and an empty 112 px box. a daemon that sends a whole thought at
  once (0.8.3) fills the box in one step, with no caret.
- **live is the session's working state**, not the last message's: the
  running turn is the newest turn that is not a queued one still waiting,
  while the session is working. the shape does not flip between the steps
  of a turn, each of which is its own message.
- **a turn appears whole.** a user message that has no part yet (the
  daemon announces the message before its text) is not shown: painted
  alone it is an empty bubble that grows by its first line and pushes the
  turn down.
- **the dock does not change height while a turn runs.** the composer's
  top row is always there at one height (`composer.md`, nothing appears
  on focus), so the line changing its words, appearing and going, or being
  empty while the turn has said nothing yet, moves nothing, whether the
  composer is focused or not. the stop button lives in the status line,
  which does not wrap.
- a turn opened mid-stream paints its ledger so far from the hydrated
  messages with no motion (`design.md`, replay never animates), then
  continues live: rows painted while the stage lands the thread it has
  just opened (a first open, a reload, a cold open: until a few frames
  after the first paint) do not rise; a row that comes after that is a
  live event and rises, a turn the reader's own send makes included.
- opening a thread starts nothing on its own: the ruler shows only when
  the reader scrolls (the stage landing at the end is not a scroll of
  theirs), and the bar takes its condensed state without fading until the
  opened thread has landed and been seen.
- **what this replaced.** until 2026-10-02 a running turn kept one fixed
  shape: the prompt and the tape held still at the top and a 340 px window
  showed only the newest rows, unfolding into the whole ledger at the
  settle. it kept the eye still and hid the work; the work has to be visible
  and scrollable, with the timeline at the live edge.

## code and copying

2026-10-02: code blocks had no copy control, no syntax highlighting and
no language label, commands had no copy control, and the text you send
could not be copied. the law was silent, so it is decided here (the
palette and the control are in `design.md`, code and copying).

- **a code block** is a fence in every markdown surface (the answer, what a
  row said, a report, a compaction's summary). it is a bed with a slim
  header inside it: the language on the left, "copy" on the right, the
  code under them, highlighted. the header stays put and the code scrolls
  under it with the bed's fade at the edge it continues past. the language
  is the fence's word resolved through highlight.js (`ts` reads
  `typescript`, `sh` and `zsh` read `bash`, `yml` reads `yaml`; html, svg,
  toml and ini read as written); a word it does not know is shown as the
  author wrote it, lowercased, and the code is plain; a word longer than 24
  characters is not a language and is cut there; a fence with no word has no
  label. there is no auto-detection: a wrong guess is worse than plain
  text. code over 12,000 characters is plain, and the block a reply is
  still writing is highlighted to 2,500 (it is painted every frame, and
  never kept in the cache, since each frame's text is its own).
  **a fence with no word and one line** has nothing for a header to say, so
  it is one row: the line, which scrolls, and the control at its end.
  unlabelled and longer, it keeps its strip, since the control has to sit
  somewhere.
- **the block being written** is the last fence of the last block of a reply
  that is still streaming, when nothing follows it: at the top level, or in
  a list item or a quote. it holds its "copy" back (it would copy half the
  code) and is highlighted to the streaming size; when the reply moves on
  or settles it is built again, once, highlighted in full, with its
  control. only a block with a fence is built again for that: a paragraph
  above it stays the node it was, so a selection in it stays.
- **copy copies exactly what was written.** no trailing newline added, no
  markup. the tap's own call puts it on the clipboard (the async api first;
  on a plain http origin over a tailnet the old textarea way, which ios
  allows only inside the tap's handler, so nothing may be awaited before
  it), and the control says "copied" with the thread's tick (which draws
  itself under a clip, unless motion is reduced) for 1.6 s, the time a lit
  row holds, then goes back. if the browser refuses both ways it says so in
  place, in red, for 4 s, in words that say what is possible: "could not
  copy. select the text instead", and where the text cannot be selected by
  hand, what can be: an output with its middle not shown, "could not copy.
  only the lines shown can be selected"; a report shown clamped, "could not
  copy. read the whole report, then select it". if the chunk that keeps the
  hold and the announcement cannot be fetched, the outcome is still drawn on
  the control and goes back by itself; it is never silent. the code stays
  selectable; the control is not text and never opens the callout.
- **always there.** the primary device is a phone, which has no hover. the
  control is 20 px in a 30 px strip, and its hit area is 44 px, drawn past
  the strip by a pseudo element, which nothing clips.
- **the reply.** under a settled answer, one quiet line holds "copy"
  (`act-line`), which copies the answer's markdown as the agent wrote it. a
  report card holds "copy" in its header, beside the time, copying the whole
  report whatever the card shows of it. both speak in the face around them
  (sans, 12.5 px), not the machine's mono. a said row mid-turn has no reply
  control, on purpose: the ledger stays quiet, and its prose stays text to
  select (its code blocks carry theirs). a streaming reply has none.
- **a command and its output.** every open shell row shows its command in a
  bed of its own, with the output's bed under the facts, and both are the
  code block's: the same header, the same inset, the same type, over the
  bed's text. the command's header says "command"; the output's says how many
  lines it has ("22 lines", "1 line"), which the facts no longer do. the
  control is always on the command and on the output. the command bed shows
  the command as it was sent, with home as `~` as everywhere in the thread, and
  its `cd dir &&` too, so the facts leave "in dir" out when the bed says it;
  the copy is the command exactly as it was sent (home as the agent wrote it).
  the output copies whole as the store holds it, cleaned at the press (the
  wall-time preamble some tools add is taken off), up to 256,000 characters,
  and a copy that stops there announces "copied the first 256,000 characters
  of the output". the open row shows a head and a tail, each line cut at 220
  characters; the copy is not cut, and the refusal says only the lines shown
  can be selected when the bed is cut or clipped. the newest row of a
  running turn shows its live window and has no control. the error bed, a
  read's preview and a diff have none.
- **only our controls.** the sanitiser drops every class an agent's html
  carries but marked's `language-ts` on a fence's code, and every data
  attribute, so nothing it writes is drawn as our control, our block or the
  thread itself (thread.css styles by class). a `<pre><code>` it writes in
  html is a fence like any other and is dressed like one.

## a long part

decided 2026-10-08 after a thread whose one text part was 6 MB froze the page for
over a minute and a half. the time was marked's: it grows with the square of
the text it is given (16 KB 30 ms, 64 KB 0.3 to 1.2 s, 256 KB 5 s, 1 MB over a
minute), and a text of megabytes is millions of nodes besides. the real parts
seen top out at 64 KB, so what is painted is bounded without
touching those (`big-text.ts`):

- markdown (the answer, a said row, a report, a summary) is parsed in pieces
  of about 16 KB cut where a block ends outside a fenced block, which is linear
  in the text: a 64 KB part is four pieces and is shown whole.
- a text past 80 KB shows its head (to 64 KB, cut where a block ends) and its
  tail (the last 16 KB, from where a block starts), with a line of its own
  between them, "5,980,000 characters not shown", the way a long command's
  output shows its head and tail. a fenced block the cut falls in is closed at
  the end of the head and opened again at the start of the tail.
- **the markdown engine is a chunk of its own.** marked and the sanitiser are
  70 KB of the app's script between them (24.7 kb compressed), and the window,
  the memo caches, the holds and the long-text bounds of this lane put the
  first load at 124.1 kb against its 120 kb budget (main was 117.7). they are
  `markdown-engine.ts`, fetched as the app starts (the import is made when
  `markdown.ts` is first loaded, so on a launch from the cache it is in long
  before a thread's rows come), and the first load is 104.6 kb. a text painted
  before the engine is here is painted as plain paragraphs (a blank line is a
  paragraph, a line break is kept, nothing read as markdown) and once more
  when it is, with the blocks that changed replaced; what was made before is
  not kept in the html cache. the engine is the only user of either library.
- the pieces share the reference definitions (`[spec]: https://...`) of the
  whole text, up to 8 KB of them, since a reference link names a definition that
  may be in another piece (900 links read as 351 before). marked draws a
  definition nowhere, so a piece says nothing more for them.
- plain words (a prompt, a thought opened, a thought still being written) show
  the first 32 KB and the last 8 KB the same way; the box that follows the
  newest line of a thought being written shows only the last 8 KB, which is
  all it ever showed. the bubble's six-line clamp holds the first 1,200
  characters, not the text.
- a run of 2,000 characters or more with no whitespace (a minified file, a
  base64 blob), in prose or in code, is cut for display: its head (200
  characters), then "N characters not shown", as a command's long line is cut.
  the browser has nowhere to break such a run but between characters and shapes
  it a character at a time, over five seconds for 70 KB in the app's own font
  (a space every 24 characters is two milliseconds, and a zero-width space took
  3.6 s). nothing is put into anyone's text, so a url, a link, a table and a
  fence keep what they are (a first version put a space every 24 characters
  into every long word of a text that held one such run, and broke all of
  them). the cut is made on the html of the words, not the tags and not what a
  `pre` holds; a code block is cut where it is dressed, from its own source,
  which its copy control copies whole (`sources` in markdown.ts), as the store's
  text is copied for a reply. a run under 2,000 characters (a long url, an
  identifier) is left as it is. a 6 MB part opens in 145 ms cold and 36 ms from
  the cache, with no long task.
- what is not shown is not gone: every copy control copies the whole part, the
  store holds it, and the turns list and the ruler's card read 300 characters of a
  prompt. the turn's digest tells a text over 64 KB by its length and its two
  ends.
- not bounded here, and noted in `open.md`: a command or a tool's input of
  megabytes, which its row tokenises and its open bed lists line by line.

## navigation

- **the header condenses.** the big title (repo, title at 24 px, the
  status line) is the first thing in the log and scrolls away with it. a
  60 px bar (64 at strip and rail sizes) floats over the log with back
  (the deck), the details toggle (a wide stage) and the menu. it has no
  backdrop: the log dissolves under it through a 40 px eased mask at the
  scroller's top edge (design.md, depth), and once the big title has gone
  by, the title and status fade in at one line each. the big title rests
  below the band. nothing changes height.
- **the ruler** (`design.md` calls it the rail): one hairline per prompt
  on the right edge, evenly spaced (4 to 9 px apart), appearing while you
  scroll and hiding 1.2 s after; an ask's turn has its hairline in the
  light tone; the current turn's is white and longer. holding it scrubs
  turns: a card says "turn 18 of 34, 17:17", the prompt's first line and
  "89 steps, 32 min, answered", and the log follows. it answers the person
  scrolling, never the app following new text. a slider to assistive
  technology.
- **turns.** from the thread menu at every size (in the menu, not the
  bar), shown where the details would be:
  home's inspector column at the rail 1400 wide and up (its close goes
  back to the details), docked on the right in a wide stage (312 px; the
  ruler stays away while a panel is docked), a sheet from the bottom on the
  phone (74% tall, its close closes it). one line per turn: its clock, its prompt (two lines,
  "transport_impl reported", "compacted"), a dot for a turn that asked,
  and under it a duration bar whose length is the square root of the
  turn's time against the session's longest (a red end mark when a step
  failed) with "89 steps, 32 min" or ", stopped". the turn in view is
  highlighted and kept centred when the panel opens; tapping one scrolls
  to it.
- **the menu** (`⋯`): turns, agents (with the count), show thinking
  (checked), then rename, fork from here, compact, copy link.
- **the scroll law** is `design.md`'s: pinned at the bottom while you are
  there, nothing moves once you scroll up, "new below" counts what came.
  pinned is a latch that only the reader's own scroll clears (`pin.ts`, live);
  sending a message takes the reader to the end.

## links

- **the url is the place.** `/?thread=<host:session>&at=<messageID>`
  names the thread and the turn at the top of the view and is kept
  current with `replaceState` as you scroll (250 ms after the last
  scroll), so a relaunch or a shared link lands on the same turn.
  `&part=<partID>` names a row: its turn is filled (the window), and the row
  is opened, scrolled to and lit for 1.6 s once it has painted. a push's `?ask=<id>` lands on that
  ask's row the same way, and so does a window's "answer" pill (home sets the same
  `state.focus`): the row's card takes focus. no history entries are pushed (`design.md`, the
  system swipe). the pretty form, `/t/<host>/<session>`, waits for the
  server to serve the app shell under any path (m7).
- **copy link** in the menu copies the url of the turn in view (m7).
- an agent row's `reported` links to its report card, the nearest one
  after it; the report's agent name links back to the row that started
  it. a tape scrub links to a row. the turns panel and the ruler link to
  turns.
- links in prose open in a new tab with no referrer (the sanitiser sets
  `target` and `rel`). a path in the answer that matches a file the turn
  changed opens that file in the files row (m7).

## layout by device

| | phone (deck) | ipad portrait (strip) | ipad landscape, mac (rail) |
|---|---|---|---|
| gutters | 20 px | 32 px | 32 px |
| measure | full width | 640 px | 680 px |
| the clock | not shown | in the margin | in the margin where it fits |
| kind column | 50 px | 50 px | 50 px |
| column gaps | 8 px | 12 px | 12 px |
| said | 15.5 px | 16 px | 16 px |
| answer | 16.5 px | 17 px | 17 px |
| open row's body | from the kind column, so beds take the width | from the content column | from the content column |
| the bar | 60 px | 64 px | 64 px |
| big title | 24 px | 28 px | 28 px |
| turns, details | a sheet | docked, 312 px, a well in the flood | docked; at 1400 and up home's inspector column |
| the window (live) | 340 px | 340 px | 340 px |

spacing is the one scale, 4, 8, 12, 16, 24, 32. text sits at least 8 px
inside any surface, sibling surfaces are at least 6 px apart, and no
surface comes within 12 px of the screen's edge; the craft detector
measures all three and the stories' screenshot test runs it.

## materials and colour

- the ledger has no surface of its own; the ground and the type carry it.
  surfaces appear for an open row, a bed, an ask's options, the tape, a
  report and the summary card, each one plane (`design.md`, depth).
- red means a failed step and nothing else. the repo's light tone marks
  what is rare and earned: an agent, an ask, a commit, a push, a passing
  run, a clean build, a live clock, a pending ask's primary option.
- diff lines use `#9ff0b3` and `#ffa3a3` on 8% tints; a match in a grep
  hit is the light tone at 22%.
- the row's result meter (34 × 4 px) is the light tone for passed and red
  for failed.

## motion

- opening and closing rows, files and cards: flip on everything in and
  around the view, the snap spring; the body reveals under a clip.
- a new live row: rises 18 px with the snap spring; the rows above slide
  by its height.
- the tape's scale stepping up: the lanes glide with the sheet spring.
- the header's title fading in: 200 ms opacity, a 6 px rise with the
  snap spring.
- landing from a scrub or the turns panel: a smooth scroll, then the row
  lit for 1.6 s.
- never: the ledger while you type, anything painted from cache or
  hydration, the scroll position on its own, the window's height.

## accessibility

every row that opens is a `button` named by its content: "run bun test,
54 passed", "edit compaction.test.ts, +187 -0", "8 thoughts, 36 s",
"agent transport_impl, reported"; `aria-expanded` follows. a fold is
named the same way, its result included: "read notes.md, 4 lines". no two
controls on the page share a name: a row whose name a row above it
already carries, in its own turn or any turn above, says how many times
it has come up, "read notes.md, 4 lines, again", then "third time",
"fourth time" and on to "tenth time", then "11th time". the first keeps
its plain name, so the names read in the order the work happened. what is
counted is what is mounted: a turn the window has not filled carries no
controls and counts for nothing (see "the window"). the
live window counts the rows it shows; a raised ask is told apart from
the asks raised with it. the tape and
the ruler are sliders with names and values (a tape's is "scrub through the
work of this turn, turn 12", and a report's "read the whole report, turn 12"
and "the agent helper, where it started, turn 12", and a long message's
"show all 476 characters, turn 12": where the turn stands on the page tells
the turns' own controls apart; ten messages of one length had ten buttons
named "show all 476 characters"). every option in an ask is
named by its answer. the bar's buttons are "back to threads" ("back to
the long helper" on an agent's stage), "details" (a disclosure, expanded
while the details show; the rail's fold toggle is its pair, "windows",
expanded while the rail is open) and "thread menu"; the facts line under the title is
one button named in full ("details: opus 5.5, high, 41% of context used,
$1.84 spent"). the turns list is named "turns"; each turn in it is named
by its clock and its prompt, and ", switched to opus 5.5, high" when its
model changed. the details are named "details"; each agent in them is
"open helper's thread, working" (its state without the clock, so the
name holds still), and an agent row's door is "open helper's thread"; the
composer's plus-menu row is "agents, 2". a
layer under an agent's stage is `inert`, so the tree never holds two
threads' controls at once. text in the ledger stays
selectable; controls never open the text callout. a copy control is named
for what it copies and where: "copy the typescript code" (a code block, by
the language it reads as; "copy the code" with no word), "copy the command,
run bun test, 54 passed" and "copy the output, run bun test, 54 passed"
(after the row they belong to, whose name is already told apart from every
other row's and holds still), "copy the reply, 17:17, okay now go ahead and
implement everythi" (by its turn: the clock and the first 40 characters of
the prompt's first line, as the turns list names a turn), "copy
transport_impl's report" ("note" for a note). what is left that shares a name
(the code blocks of one language, two reports from one agent) is told apart
the way rows are (`namesOf`), in document order over the controls the page
holds: the second is "copy the typescript code, again", then "third time".
that counting is read as the page stands, so a block that appears above
shifts its namesakes below it by one; a row's own names never move. the name
stays what it was when a copy lands; the state is announced through one
visually hidden status in the thread (`role="status"`, polite): "copied
the typescript code", or the control's refusal words, and the status is
emptied at the end only if it still holds that press's words.

## copy

lowercase, the voice of `design.md`. the ledger's words: run, watch,
type, commit, push, edit, write, read, grep, find, recall, fetch, search,
agent, ask, plan, skill, note, wait, agents, thought, files, stopped,
failed; "N commands", "and 3 more", "wants you", "answered", "dismissed",
"reported", "wrote", "parked", "did not start", "its turn ended, no
report", "working for 7 min", "reported after 4 min", "waiting on you",
"parked on agents of its own", "open its thread", "an agent of <parent>",
"brief,", "waiting on 2 agents for 3:12", "working 0:41, 2 agents",
"working 7:21, through its agents", "parked, waiting on 2 jobs", "no output",
"no diff was recorded for this edit", "N lines not shown", "and N more
lines", "3 min later", "you stopped it after 11 min", "worked 32 min",
"working 1:34", "done just now", "show the summary", "read the whole
report", "read the whole note", "show all N characters", "allow once",
"always allow", "deny", "or deny and say why", "or type an answer", "copy",
"copied", "could not copy. select the text instead".

## class names

every class is scoped to its element and nothing reuses a generic word:
`row`, `row-h`, `row-t`, `row-k`, `row-c`, `row-r`, `row-b`; `tape`,
`tape-h`, `tape-lanes`, `lane`, `lane-hd`, `lane-plot`, `lane-name`,
`tp-think`, `tp-mk`, `tp-now`, `tp-scale`, `tp-playhead`, `tp-cap`;
`tail`; `bar`, `bar-title`, `title-block`, `tb-repo`, `tb-h1`,
`tb-status`; `you`, `report`, `rep-h`, `rep-b`, `rep-all`, `mark`,
`sumcard`; `bed`, `fl`, `fb`, `hits`, `todo`, `facts`, `gap`, `dir`, `fn`;
`cblock`, `cblock-h`, `cblock-lang` (a code block, its header and its
language, which the command's and the output's beds wear too; `lone`, the
one-line block with no header; highlight.js's own `hljs-*` classes inside the code, mapped to
tokens in one place in `thread.css`), `copy-btn`, `copy-g`, `copy-w` (the
control, its glyph and its word), `bed-wrap` (a bed with its header), `act-line`,
`rep-r`, `copy-status`;
`ask-card`, `ask-opts`, `ask-opt`, `ask-or`, `ask-ans`; `agent-door`;
`ruler`, `rcard`;
`turns`, `turns-in`, `turns-hd`, `turns-list`, `turns-empty`, `ti`,
`ti-time`, `ti-text`, `ti-sub`, `ti-bar` (an agent's row is `ti ag`, `on`
while it works, `wants` while it waits on you); `tb-parent`, `tb-agents`.
state classes are `open`, `cur`, `full`,
`lit`, `bad`, `stopped`, `running`, `over`, `overflows`, `on`, `here`,
`k-ask`, `k-cur`, `writing` (and `data-state` `copied` or `refused` on a
control). round seven's jank came from `.you`, `.live`, `.sub`
and `.strip` meaning two things; that does not happen again.

## from the wire

the view model (`app/src/ui/thread/model.ts`) turns the daemon's
messages into turns of items (said, thought, step) and the rows fold
from the items. what it reads:

| the row needs | from |
|---|---|
| a step's kind, object, time | `ToolPart.tool`, `state.input`, `state.time` |
| a `run` script | its first line of code as the thing; "started N agents" from `state.metadata.nested` (one entry per helper call, by tool name; the entries carry no child ids, a27) |
| a shell's exit, cwd, output, running tail | `state.metadata.exit`, `input.workdir`, `state.output`, `state.metadata.output` (a9) |
| tests, build, commit, push, clean | read from the output, never guessed from the name (`evidence.ts`) |
| an edit's counts and diff | `state.metadata.filediff` or `diff` when present |
| a read's span and the file's length | `input.offset`, `input.limit`, `metadata.startLine`, `endLine`, `totalLines`, the output's footer |
| an agent's name, child, brief | `metadata.agents[0].name` (the pinned daemon's spawn answer), else `metadata.path` without `/root/`, else `input.name`; `metadata.child_session_id`; `input.brief`; its seat from `agents[0].seat` |
| the thread's agents | the fleet: every session with this one as `parentID`, plus any child a spawn row names that the fleet has let go. a child's own thread is held only when it is wanted (see "the stage, as built", agents held when wanted) |
| where an agent's child is now | the fleet: the child session's `status` (busy or retry is working; idle with `parked` is parked) and whether an ask is pending on it; `status.since`, `time.created` |
| a question's options and answer | `input.questions`, `metadata.answers`; a raised one from the fleet's asks (the daemon's `/question`) by `tool.callID` |
| a permission | the fleet's asks (the daemon's `/permission`) by `tool.callID` |
| a step's moment | `state.time.start`, else `end`, else the message's `time.created`: native tool parts carry `start: null` (`gotchas.md`) |
| a thought's duration | `ReasoningPart.time` |
| a report, a note, a brief, a notice | the user message's `mail {kind, from, fromID}` (cmx2's mail kinds: `task`, `report`, `message`, `job`, `system`), `from` without `/root/`; a report is joined to the row that started its agent by `fromID`, by name when the daemon gave none; imported history marks reports as `[from /root/name]:` |
| the turn's end state | `MessageInfo.error.name`, `finish`, `time.completed` |
| a compaction | the user message with a compaction part, then the assistant message with `summary: true` |

what the pinned contract does not give, argued in `cmx2-asks.md` and
filed as asks:

- **a15**: imported history is served raw, with `step-start`,
  `step-finish`, `patch` and `compaction` parts outside the `Part` union,
  so a strict decoder rejects a whole page of an imported session.
- **a16**: a native edit's metadata is `{path, replacements, line}` with
  no diff and no counts, so the edit row and the files row cannot show
  `+a -d` or a diff for a native session; imported history has both.
- **a17** (landed 2026-10-01, cmx2 0.8.5): `time {start, end}` is
  declared on text and reasoning parts and native parts carry it: the
  announcement of a streaming part has `time.start`, its final update both,
  published when the part's block ends (a26: a thought's final comes when the
  reply begins, not at the step's end, so its clock stops there).
  a thought's duration, the thinking channel of the tape and the live
  thinking clock read it. a session recorded before 0.8.5 has no `time` on
  its parts, so the line below still holds for old turns. reasoning now
  streams (a23): the live row can show the thought growing from its
  announcement (`docs/cmx2-asks.md`).

until they land the rows show what they can: an edit without counts
shows its name and "no diff was recorded"; a thought without time shows
no duration; the imported parts outside the union are dropped by the
decoder with a `wire.unknown_part` telemetry row, never by a boxbox-side
parser that pretends to understand them.

## the stage, as built (m3)

`app/src/ui/thread/`: `model.ts`, `rows.ts`, `ledger.ts`, `shell.ts`,
`evidence.ts`, `tape.ts` and `wire.ts` are pure; `thread.tsx` paints a turn; `live.ts`
reads the store; `asks.ts` answers; `stage.tsx` is the screen; `motion.ts`
holds the springs and flip. the markdown is `markdown.ts`'s one painter;
`languages.ts` (what a fence's word means, pure), `highlight.ts` (the cache
and the way into the highlighter), `highlight-engine.ts` (highlight.js, a
lazy chunk), `copy.ts` (the control), `copy-button.tsx`, `copy-names.ts`
(the names, pure), `copy-run.ts` (what a press does, a lazy chunk) and
`clipboard.ts` (the one way onto the clipboard) are the code blocks and
copying; `stories/code-sample.ts` is the markdown their stories paint.

**from the store.** the worker holds `state.threads[key]` (m2: hydrated
at a seq with the in-flight message, deltas applied by offset) and the
stage reads it. `createTurns` (`turns.ts`) cuts the messages at each user
message (it reads only their roles) and gives each turn a memo of its own,
which reads only its own messages by index: a delta to the running turn
wakes the running turn and nothing else, so the cost of a patch is the
cost of what changed, not of the thread. a turn is rebuilt only when what
it reads changed. the store keeps an object while nothing in it changes and
replaces it when it is sent again, so the memo's quick check is which
objects the store holds (`printOf`: messages, parts, a tool's state, each
text's length); a new object is a possible change, and `digestOf` says
whether it is a real one: one digest of everything `turnsOf` and the row
models read, each message's info whole (cost, model, effort, finish,
error, mail) and each part whole (a tool's state read once per state
object: its input, metadata, output), read in idle time after a turn's first
paint (hashing a thread's whole text in the task that opens it was a share of
that task), so a part sent again before it is read is built again. a part sent again with the same
words is the same turn and keeps its dom; any change to a field a turn
shows is a different digest, and the turn is built again. untouched turns keep
their objects and their dom. the turn that is rebuilt is not
rebuilt whole: `turnsOf` keeps what each part became (the part memo, by
part id, one per turn) and reads a part again only when its text grew or
the store replaced its tool state; a message whose info changed comes
back with copies of its parts, and a step read again equal to the last
keeps its object. a poll's command and a file's length, which come from
earlier parts, are placed afterwards, so a step is a new object only when
they changed. the views (`ledger.ts`, pure) remember each row's model by
what it reads (its items, its pending ask, the clock while it runs, an
agent's child and report) and each entry by its fields, so a delta to
one part hands one place a new entry and every other place the same
object: `Index` gives it nothing and its dom stays (the unit test
`ledger.test.ts` plays a recorded turn delta by delta and counts the
places that changed; in the live story 2,800 checks of older rows saw no
node replaced). turns and rows are keyed by place (`Index`), never by
object identity, because the running turn is still a new object on every
delta. the last turn is live while it has no
`time.completed` or the session's status is `busy` or `retry`; a clock
ticks each second only then, or while any of the turn's agents still
works (`ctx.tick`, the agent rows' and the settled tape's clock; `ctx.now`
stays the sign that the turn itself runs). the clock is not part of the
context the stage shares (`data.ctx`: the children, the asks by call id,
the thinking setting, and the mail turns an agent row finds its report in):
each turn is handed `now` (the running turn) or `tick` (a settled turn
whose agents work) by its own memo, whose equality is what that turn reads
of the context (`sameCtxFor`, `ledger.ts`: the asks on its own steps, its
agents' children and reports). a delta, an ask on another turn, a second
passing wake the turns that read them and no others. the page's names
(accessibility) are counted down the page as a running count by one
register (`names.ts`): a turn that arrives or changes at the end is counted
from itself, a change higher up counts the page again once, and a turn is
told only when its own names changed.

**what is remembered.** four caches outlive a stage, each a byte-capped
least-recently-used map (`lru.ts`, the one class the highlighter's cache
is too; AGENTS rule 7), made once and owned by the store (`store.ts`,
`threadCaches`): the turns `createTurns` built, by thread and turn, valid
for the digest of the messages they were built from (32 MB; no part memo is
kept, which would hold the store's own part states alive after the worker
let the thread go); the ledgers of settled turns, so a thread opened again
paints its rows from the row models it had (32 MB: a stage takes a
turn's ledger out while it paints it and puts it back when it goes, so two
stages never share one, and a running turn's is never kept); the sanitised
html of settled markdown, by its text (8 MB; the text a reply is still
writing is never kept); and how tall each turn measured (1 MB, see the
window). a size is what the cache alone keeps alive: the derived words and
every string a step holds, a command's whole output included, never the
store's objects. a thread the worker lets go drops its entries
(`applyPatches` sees the patch), signing out empties them all, and one
`perf.memo` row per cache is written when a stage closes (entries, bytes,
hits, misses, evicted). what is written for later is refused if what it
writes for went in between: a writer takes a mark when it begins (a turn
built, a view made, a stage's first measure of a thread, a painter made) and
the caches refuse a write whose mark is older than the last clear or than the
thread's last drop (`stamp` and `keep`). without it the sign-out cleared, then
each view's cleanup put its ledger back and each idle digest its turn, and the
caches held a signed-out user's threads. the drops remembered are bounded (512);
past that a write begun before the forgotten one is refused too, which costs a
cache write and nothing else.

**agents, held when wanted.** a child session's thread is a full session
(a long thread starts dozens of agents of hundreds of messages each), so
the stage holds one only when it is wanted, and never more than the worker
can keep. the worker keeps a reserve of 16 places for threads that are only
held (`holdThread`, `releaseThread`, sync/client.ts), and asking for more
would hold, evict and hold again for as long as the screen stayed as it was,
so at most 12 are wanted at once (`holds.ts`): the agents that are live
(working, parked, or asking) first, then those whose row or lane is within
a screen of the view, nearest first (`data.seen`, from one intersection
observer on the stage; a child is near when any of its elements is). the
rest, and every agent while the reader opens none of them, are read from
the fleet. one the worker evicted, or refused (its reserve was full), that is
still wanted is held again, at most three times in thirty seconds, by the holds'
own timer (a wall clock is not a signal, so nothing a reactive read could see
would say that time had passed: a refused hold was never asked for again, nor
one evicted within a second and a half of its hold; the timer looks once a
thread has had that second and a half to arrive, again after another, and when
the budget lets the first ask go, and is let go when the thread arrives, stops
being wanted or the stage closes); one that stops being wanted is
released, and all of them when the parent leaves the stage. the agents
panel never holds. what is not held is read from the fleet's session info
alone: its title, its status, when it started and how long it lasted
(created to updated), and the step count is left off until the thread is
read, never shown as zero: the agent row's result is empty and its facts
leave the count out ("its turn ended, no report"), the panel's line says
"no report" where a held child says "128 steps", and the tape's lane
carries its name and its marks only once its items are here. a thread is
read when its messages can be shown (live, or restored from the cache and
stale): one the worker has only started, hydrating with nothing in it, is
not, and says nothing of steps. a held child is summarised once, in a memo
of its own (`Child`, with `held`), and its turns are cut the way the
thread's are, so a delta to one agent wakes that agent's row and lane.

the clock follows the same rule: a running step in a turn that is not the
live one (the daemon left it unfinished) reads "running" and does not
count, and an agent row whose child the fleet does not know yet reads
nothing in a settled turn; only the running turn, and a settled turn whose
agents work, tick.

**asks.** the pending asks come from the fleet's list, joined to their
rows by the tool call id (`request.tool.callID`). a reply goes through
the server with a `clientID` minted once per ask and action and kept for
a retry; the daemon's answer passes through as it came, so a 409 carries
who settled it. the stage watches the ask leave the fleet's list and
stamps `perf.send verb=reply` from that moment.

**routes** (behind the gate, the host's credential added by the server,
bodies to and from cmx2 byte for byte; a host that cannot be reached or
refuses the credential answers in boxbox's error shape):

| route | cmx2 | used by |
|---|---|---|
| `GET /api/hosts/:host/sessions/:session/messages` | `GET /session/:id/message`, with `x-cmx2-seq` | the worker's hydration (m2) |
| `GET /api/hosts/:host/sessions/:session/messages/:message` | `GET /session/:id/message/:m` | the worker's refetch of one part (m2) |
| `POST /api/hosts/:host/questions/:ask` `{device, deviceClass, clientID, answers}` | `POST /question/:id/reply` | the ask card (m4's `asks.rs`: the fleet learns who answered first) |
| `POST /api/hosts/:host/questions/:ask/reject` `{device, deviceClass, clientID}` | `POST /question/:id/reject` | "dismiss" |
| `POST /api/hosts/:host/permissions/:ask` `{device, deviceClass, clientID, reply, message}` | `POST /permission/:id/reply` | the permission card |
| `POST /api/hosts/:host/sessions/:session/abort` `{device, deviceClass, clientID}` | `POST /session/:id/abort` | "stop" in the status line (m4's: a fault inside 15 s is the person's own) |
| `POST /api/hosts/:host/sessions/:session/compact` `{device, deviceClass, clientID}` | `POST /session/:id/summarize {}` | compact now, from the composer (`composer.md`, the wire) |
| `POST …/prompt` `{device, deviceClass, clientID, text, photos, model, effort}` (m4's: the turn is armed for "done"); in `compose.rs`, `…/steer`, `…/command`, `…/shell`, `POST /api/hosts/:host/sessions` (a new thread) and `GET …/commands`, `…/projects`, which take the device and arm their turn; in `session.rs`, the passthroughs `…/queue` (`Send`: text, parts, model, effort, agent), `…/loop`, `DELETE …/messages/:message`, `GET /api/hosts/:host/providers`, `…/find/file` | the daemon's write path | the composer (`app/src/ui/composer`, `docs/composer.md`, the wire) |

every send body carries `clientID` (8 to 64 plain characters); `Send`
takes `text`, `parts` (data or file urls, at most 8), `model`, `effort`
and `agent`; the send routes take bodies up to 8 mb for clamped photos.

**the screen.** the stage is the body of home's layer
(`app/src/ui/home/stage.tsx`, docs/home.md): the whole screen on the
deck, grown out of its window; the panel below the strip; the panel
beside the rail. it takes the window's colour, home's back (the shrink
or the fade) and hands home its bar for the pull-down gesture. its own
pane is the only scroller; the bar floats over it and condenses once the big
title in the log has gone by (an intersection observer). the ruler
appears on a scroll the person made (wheel, touch, pointer or key in the
last 900 ms), never on the app following new text. the side panel (the
details or the turns) docks from 660 px of stage width and is a sheet
below that; given home's inspector (the rail, 1400 and up) it portals
there instead and never docks. the scroll law:
pinned at the bottom while there; once scrolled up, new messages count
into "N new messages below". the keyboard's height reaches the stage as
`--keyboard` only while an editable on it holds focus (decision 19), and
its inputs are 16 px.

**telemetry.** `surface.view {route}` on mount; `surface.ready {cached}`
and `perf.thread what=thread {cached, messages}` at the first frame that
shows the thread (its rows, or that it is empty once the worker
answered). `cached` is whether the rows came from the client's own copy,
which a thread restored from indexeddb after the stage mounted is
(`paint-source.ts`): the stage cannot see where rows came from, but it
sees what an open from the wire looks like, an empty thread the worker
holds still reading before the rows arrive, and a first paint with no such
thread before it is from the copy; `perf.thread what=row` from a tap to the frame after the row
opened; `perf.thread what=event` for one patch in twenty-five of the open
thread, from its arrival on the ui thread to the frame after it painted;
`perf.send verb=reply {retries}` from the tap to the ask leaving the
stream, `ok` false when the send failed.
`perf.memo what=turns|ledgers|html|heights` when a stage closes: the entries,
bytes, hits, misses and evictions of each memo cache (thread.md, what is
remembered). every row rides the worker's
queue (`ToWorker.telemetry`), the one emitter.

## the window (progressive mounting)

decided 2026-10-08, after a 300-turn thread opened in over a
second with 32,000 elements: every turn is a box on the page from the start
(`section.turn[data-turn]`, so the ruler, the turns panel, the url's place
and every query by turn keep working), and the rows, bubble, answer and
tape of a turn are mounted into its box when the turn comes near. the
design, and what each part of it says:

- **mount once.** a turn that is not filled is an empty box of a remembered
  or estimated height; once filled it stays filled for the life of the
  stage. nothing is unmounted, so focus, a selection, an open row, a code
  block's scroll and words typed into an ask are never lost to the window by
  construction. the cost is that a long scroll through a thread ends with
  the thread mounted, which is what the earlier design (it unmounted) tried
  to avoid: the dom is bounded when a thread opens and as far as the reader
  has gone, and not past it.
- **always filled.** the live turn, the newest three turns, and any turn
  that holds a pending ask (an ask is never an empty box, and its row is
  there to land on). the first frame also fills from the end until the
  screen and half as much again are covered, so what a thread opens at is
  never painted empty. only that opening makes the older of the newest three
  a frame later (a long task otherwise); turns that come after are made whole
  in the task that brings them, because a frame is painted between that task
  and the next frame's callbacks, and the older of two turns arriving together
  (two reports with a prompt, or a queued message that gets its own id when
  it runs) was an empty box in the view of a reader at the end for that frame
  (check 9, chromium 390, once under load: two turns, 222 px, one frame).
- **filled when near.** an intersection observer watches every box with a
  margin of 2.5 screens above and below the scroller; a loop fills what it
  reports, the turns on screen first and then the nearest, at most two a
  frame (a thread painting its way up never holds a frame long).
- **no write to the scroll position under a finger.** a fill above the
  reader's eye changes what is under it, putting the anchor back is a write to
  the scroll position, and a write ends an ios fling. on a screen a finger has
  been on, while a finger is down or the reader's own scroll ran in the last
  140 ms (the pin tells the reader's scroll from the stage's own), nothing
  above the anchor is filled, on screen or not: a box that comes into view
  then stays a box of its remembered or estimated height, and is filled when
  the view is still (a first version filled any box on screen at once, which
  wrote at each empty box that entered the view and ended the fling there). it
  looks intended, not broken: a dashed line across its top, and the first
  words of what the turn was about in the quiet ink (`data-waiting`, from the
  turn mark's language; no spinner, since it is a pause of a moment and
  nothing is loading). a box below the anchor never waits, since filling it
  moves nothing above itself. a wheel, a trackpad, a key or a script has no
  such momentum to protect, and its scrolls hold nothing back: the boxes near
  the view are filled ahead of it, so one rarely comes into view empty.
- **a move the page makes always lands.** a link, the turns panel, the ruler,
  a step on the tape, an ask and "to the bottom" go through one door
  (`StageWindow.travel`, `moveTo`). one under two and a half screens is a
  smooth scroll: the turns it goes past, and one beyond each end, are filled
  first, with the reader's place kept, so the heights it lands by are real;
  while it goes the window writes nothing to the scroll position (a restore's
  write ended a smooth scroll, so a turn two screens up was never reached, and
  nothing else may write either: two writers) and fills nothing above the
  view; when the browser says `scrollend`, or the view has stood still for
  two looks, it lands by where its target is now, the move's one write. a
  farther move lands at once and fills nothing on the way: the turns it goes
  past are never looked at, and mounting them (300 of them, for the turns
  panel's jump to the first turn of a thread that long) would be one task and
  would keep them mounted; the caller has filled the turn it goes to and its
  neighbours (`reveal`), and the fills near the place it lands at follow as
  they always do. the reader's wheel, key, touch or press ends a move where
  they are, and the grown thread waits for it (`steady`). the window's side
  of this is tested over a scroller that is only numbers
  (`stage-window.reactive.test.ts`: a far move fills nothing, a short one
  fills its way and writes nothing, lands by its target, and is ended by a
  touch).
- **the ask the stage brought holds the view.** the row of an ask the stage
  scrolled to is the anchor (`hold`), not whatever is at the top of the view,
  until the reader acts or four seconds go: rows between the top and the ask
  that settle or grow push the top's neighbours, not the ask. (it was held by
  the top's anchor, and a row above the ask that grew pushed the ask down.)
- **heights.** an empty box has the height the turn measured the last time
  it was filled, at the width it wrapped at (to the nearest 8 px; in memory,
  a byte-capped cache, `memo-cache.ts`), else an estimate from what the turn
  holds (`windowing.ts`: its prompt, its rows, its said words, its answer,
  its tape), scaled by how the turns measured so far came out against their
  estimates (between half and four times). an estimate only has to be near:
  a box that fills is measured, and the reader's place is kept (next).
- **one owner of where the view is.** `stage-window.ts` and the pin (`pin.ts`)
  write the scroll position, and nothing else does. the scroller's native
  anchoring is off (`overflow-anchor: none`, `stage.css`), so the browser
  never corrects as well. a view at the end is followed by the pin (the end
  and its latch are the pin's, as before), and a change the window makes to
  the page while the view follows the end (a fill, a block of older turns) is
  followed in the same task (`keep` calls the stage's follow), not by the
  stage's resize observer after the layout: the layout in between has the
  view where it was, nothing is painted so, and chromium's layout-shift
  entries count it all the same (0.37 for each block of 32 turns a thread
  opens with, 0.73 for the last two of a long one at 1512; a bare page that
  prepends 32 blocks and re-pins in a resize observer does it too, and one
  that re-pins in the task has none). a view anywhere else has an
  anchor, taken at every scroll event: the first turn at or below the top of
  the view that has its rows (an empty box holds nothing the reader looks at,
  and its own fill changes its height under the top of the view), and inside
  it the first box under the top, as deep as the page's own boxes go (a row,
  a block of its answer), with how far its top is from the top of the view.
  a fill is made with the anchor taken first and put back in the same task,
  before anything is painted (`pin.place`, which the pin counts as the
  stage's own write, so its echo is not read as the reader's); a height that
  changes for any other reason (a late highlight, an image) is put back in
  the frame's resize report, which the browser makes after layout and before
  paint. a view scrolled by a write whose scroll event has not been reported
  yet is the reader's: the anchor is taken again, not put back. the box's
  top is read to a fraction of a pixel where the page is drawn at its own
  size, and as laid out while the layer a thread opens in arrives drawn
  smaller. a change the reader makes (a row opened) is below the anchor or
  inside the box that holds it, so it never moves what is held, and the
  tapped row keeps its place as it did.
- **one way to a turn.** the ruler, the turns panel, a link (`at`, `part`),
  an ask (the dock's line, the window's "answer", a push), "N new messages
  below", a report's link to the row that started its agent and a row's link
  to its report all go through `reveal`: the turn and the one either side of
  it are filled, with the reader's place kept, and the box is answered; then
  the move is made to what is laid out. a move over more than 2.5 screens
  lands at once instead of smoothly (a smooth scroll over a hundred turns
  would fly past boxes that are not filled); a nearer one is the smooth
  scroll the law asks for, and the box it lands on is filled.
- **an ask's row is held by the same anchor.** the stage used to keep a row it
  brought to the bar for three seconds itself, and pulled the view back from any
  scroll that was not the reader's input (find in page, voiceover, a script);
  now the one owner holds it like any other place, and a scroll that is not ours
  is read for where it left the view.
- **replay never animates.** a box that fills in later is not a live row: it
  does not rise, as nothing painted from cache or hydration does.
- **names.** the names are unique across what is mounted (`names.ts`): a turn
  that is not filled says no labels and counts for nothing, and a turn that
  fills above shifts its namesakes below it by one, as "again" and "third
  time" always read the page as it stands. an empty box is not a control and
  has no name.
- **a long thread is shown newest first, a few turns a frame.** making 210
  turns in the task that applies the thread was 111 ms of a frame at 390 (83 ms
  of script: the turn of each message, a view of each turn, and the markdown of
  the last ones; 22 ms of layout): a long task at every open. a thread opens
  with its newest 8 turns (`first` in `createTurns`) and the stage shows 32
  older ones a frame, newest first, until it has them all (the same frame is
  51 ms, 45 of them script, with no long task, and the whole thread is there a
  quarter of a second later; the first frame fills from the end the screen, not
  a screen and a half, and four turns at most: the near turns come a frame later). of the always-filled newest three, the newest
  and the running turn and any that asks are filled in that task and the other
  two a frame after: they are above the first screen, and filling all three
  was 55 ms on a thread whose last turns have real rows. the list is keyed by the turn's id, so turns coming in above keep the
  views of the ones shown; the oldest shown is remembered by id, so a message
  arriving does not take it away. turns come in above the reader's place, which
  is kept as a fill keeps it (`keep`), and not while a finger is down or a fling
  runs (`steady`): they wait. a thread opened to a turn or a row (a url's `at=`
  or `part=`; the url's place counts only when its `thread=` is this stage's
  thread: a stage opened by a tap while the url still named another thread's
  turn was made whole, one frame of 65 to 75 ms at 1512 on a launch from the
  cache) or with a focus on it, and any search through every turn (a link
  to a part, an agent's report) have all of it at once. a pending ask brings its
  own turn and the turns after it (`need` in `createTurns`: the messages are
  read for the ask's call, newest first, without tracking their parts), so an
  ask is never in a turn that is not made, and a thread that asks is not made
  whole at once (that was 55 ms in one frame, a long task). until they are all
  in, the roster, the spend and the turns list count what is shown, and the
  panel that draws them (the details or the turns, in the inspector, docked or
  a sheet) is not drawn until then (`filling`, `details.tsx`: its body is
  `visibility: hidden`): its sections grew by the block and moved the ones
  under them, which chromium counted as layout shift (2.6 thousandths, once, at
  the first open of a long thread: the budget is 0), and a reader of the page
  read a partial list.
- **the shown list starts again only for another thread, never for a
  notification.** `createTurns` takes the list back to its newest few when the
  thread key changes (`on`), and `on` runs when what it reads notifies, not when
  the value is another. the stage's key comes from home's layer through its
  window's view, which home makes again at every update of the session (a reply
  streaming makes it about five times a second), so each of those took the list
  back to 8 turns and regrew it: 57 collapses in a 10 s reply (1512 and 390),
  layout shifts of 0.3 each, a scroll write for each, and, worst, a collapse
  inside the settle (below). the key is read through a memo in `createTurns`
  and in the stage (a thread's row has the same rule for its key, `thread.tsx`),
  and a test makes the view again with the same key and asks for the turns
  that were shown. it never showed in a drive that opened the thread by its url:
  a url open has a focus on the thread, so it is made whole and has nothing to
  take back. a thread opened by a tap on its window (the rail, the strip, the
  deck) or by the stage's own first pour is the progressive one.
- **find in page** searches what is mounted: the newest turns and the
  neighbourhood of the view, and not a turn that has never been near. this
  is the one behaviour the window trades: a word in a turn far above is not
  found until the reader has been there (the turns list, the ruler and a link
  go to it, and the url names it). it is recorded in `open.md`.
- **the agents.** a child agent's lane or row is watched only while its turn
  is mounted, so a thread's agents are held for the turns the reader has
  been near (see agents, held when wanted).

## budgets

- a turn of 89 steps and 52 thoughts is about 100 rows and, closed, under
  4,000 px on the phone. a session of 44 turns is about 80,000 px. the log is mounted progressively, and what
  that promises is decided in "the window" (below): an older turn is an
  empty box until it comes within 2.5 screens of the view and is never
  emptied again, so the dom of a thread opened at its end holds the newest
  turns and what the view's neighbourhood needs, not the thread, and nothing
  a reader did in a turn is ever taken away by it.
- `perf.thread` for opening a thread (`design.md`, buttery): the first
  paint from cache within a frame; a row opening within its spring with
  no long task over 50 ms; the live window's tick under 4 ms on the ipad
  (only text changes).
- the live turn never reads layout inside a frame loop: the flip measures
  once per row set change.

## verification

- **stories.** `app/.ladle` holds one story per part type per state in
  the tables above, driven by the scrubbed fixtures in
  `app/src/ui/thread/fixtures/` (excerpts of three real sessions: a heavy
  turn with an agent, a deploy with a commit, a push and two asks, and a
  native session with a permission, a question, a steer, an abort and a
  park), plus the tape, the live window and the turns panel. the pending
  question has three rows: the recorded "which greeting", a long ask (a
  header, a four line question, three options of three to five lines) and
  an ask of two questions (`stories/asks.ts`, written in neutral names: the
  recording holds neither), and the shell's `thread-ask-*` stories open the
  stage the way a window's "answer" pill does and fail unless the card is
  focused in its one ring, the row under the bar's fade, and the card the
  same card a tick of the clock later: `long` and `two` (the asks), `settles`
  (words typed into the card kept, then an answer from another device),
  `under-agent` (the parent's ask opened from under its agent's thread: the
  strip's pill, the deck's capsule), `slow` (a thread that comes after the
  wait a focus would have had from the tap), `cached` (the cache's rows, from
  before the ask, with the fetch out for longer than that wait, then the
  fetched thread with it), `reset` (a push tapped as the stream reconnects,
  the fleet without the ask until the replay), `unseen` (an ask the thread
  does not show: the focus is let go when the wait is over) and `gone` (an ask
  answered elsewhere: let go at once).
- the code blocks have stories of their own: an answer with a block for
  every language and a line that scrolls, a report with code, a said row
  with a block, a reply written through fences (`data-replaced` on the
  sample counts the settled blocks whose node was replaced, and stays 0),
  and every open shell row.
- **the screenshot test** (`bun app/.ladle/shots.ts`) opens every story at
  390, 820 and 1512 wide, saves the screenshots to `app/.ladle/shots/`,
  runs the craft detector on each and fails on any crowding, touching,
  edge contact or console error. the screenshots are looked at, not
  diffed: fonts and antialiasing differ across machines.
- **the thread drive** (`bun bench/thread.ts`, `verification.md`): with
  `just cmx2 --port <p>` and `BOXBOX_PORT=<b> just dev` running, it
  drives agent-browser through the accessibility tree at 390, 820 and
  1512: a turn's rows on stage; a question answered by its name and
  settled on the daemon and on the stream; two permissions and two
  questions answered as the daemon raises them; a thread
  opened mid-answer showing the partial text, then reloaded mid-answer
  and painting what was written before continuing; a deep link opening
  its row; screenshots at the three widths, each through the craft check;
  and, from the telemetry the server wrote, `perf.send` p90 over at least
  50 replies and the `perf.thread` rows.
  the bench model's `[bench:code MS]` runs a command and then streams a
  reply with four fenced blocks a few characters at a time: the real loop for
  the code blocks (a block written under the eye holds its control back, the
  names are unique, each control copies what its block holds).
- **devices.** a real iphone and ipad for the tape's scrub, the ruler's
  hold, the rows' tap targets and the live window's frame rate. these are
  owed and not yet done (2026-10-01).
