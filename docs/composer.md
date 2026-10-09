# the composer

the writing law for boxbox: what the composer is, where it mounts, every
state it can be in, what each one is made of on the wire, and what the
pinned cmx2 does not serve yet. it extends `design.md` (the composer,
starting a thread, input, the motion law) and is binding the same way
(AGENTS.md, rule 6).

## where it lives

| path | what |
|---|---|
| `app/src/ui/composer/composer.tsx` | the component: a target, a mount, the window, the line, the queue's cards, the menus, the full stage |
| `app/src/ui/composer/sheet.tsx` | the new-thread sheet: machine, repos by recency, a folder finder for any other folder, checkout or fresh worktree, the progress and the failure of the first send, the hand-over to the open thread |
| `app/src/ui/composer/model-menu.tsx`, `models.ts` | the model menu (favorites, the whole list by provider, search, the keys) and its rules as pure functions (tested) |
| `app/src/ui/composer/dial.tsx`, `thumbed.tsx`, `effort.ts` | the effort meter and the dial on the sliding-thumb control the sheet's "where it runs" shares, and the ladder rules (tested) |
| `app/src/ui/composer/marks.ts`, `marks-data.ts`, `marks-sprite.ts`, `mark.tsx` | which provider is which mark (in the script); the marks as data (not in it: the build writes them into `index.html` as an inline svg sprite, so they are in the document when it is parsed and a mark is drawn in the first frame, with no fetch and no pop-in; the script budget was the reason); and the tile that draws one with `<use>` (`THIRD_PARTY.md`) |
| `app/src/ui/composer/favorites.ts`, `compact.ts`, `context.tsx`, `icons.tsx` | the star's route (optimistic, newest press wins), the compact call and its state in the store, the context ring, and the icons |
| `app/src/ui/composer/dock.tsx` | home's new-thread dock: one button in the colour of the window in view, naming repo and host |
| `app/src/ui/composer/place.ts` | where a thread can start, as pure rules: repo root of a session, recency order, the repo filter, typed paths (tested) |
| `app/src/ui/composer/words.ts` | every sentence it says (placeholder, send's word, the line, each card's why), pure and tested |
| `app/src/ui/composer/photo.ts`, `fit.ts`, `heic.ts` | photos clamped on the device: 1568 px on the long side, jpeg under 1.5 mb, heic decoded where the browser can; where it cannot, the original sent as `image/heic` or `image/heif` under its own limit, found by type, extension or the `ftyp` brand (`heic.ts`, pure and tested); `fit.ts` holds every photo limit and the room rules |
| `app/src/ui/composer/reads.ts` | the menus' reads through boxbox: commands, files, models, repos, and the folders inside a folder; kept per host and directory in a fixed-size map (folders are read per pause in typing, never kept) |
| `app/src/sync/outbox.ts`, `sender.ts` | the outbox's rules (pure) and the worker's io: drafts and sends in indexeddb, posts with a client id, retries with the same id, settles on the echo; the outbox's byte cap for photos and each post's time by its bytes |
| `server/src/http/compose.rs` | boxbox's routes: steer, unsend, run the queue, shell, command, the reads, and a new thread (with a fresh worktree when asked) |
| `app/src/ui/composer/stories/` | one story per state below, from the fixtures |
| `bench/composer.ts` | the drive against a real daemon |

**status (2026-10-01): locked, with the usability changes below (see "decided here", the first entries).** the window was picked from four candidates (below).

## the direction: the window

the composer is made of the same stuff as a window on home: the thread's
own repo gradient, a lit top edge, a highlight falling from the top left
and a long shadow, so in a violet repo you write into a violet window and
the new-thread sheet takes the colour of the repo you pick. like every
window it carries a live tail: one line of what the agent is doing,
rolling in on each real step, shown only when that line is not already on
screen (the live window or the ask scrolled out of view, or home). while
you write, the same line says what send will do ("after this turn, or hold
to steer", "after this turn and the 2 waiting", "lands in the running
turn, after this step"), because a message that waits for no visible reason is confusing. its controls follow the law for an ask: the
model and effort are pressed into the window's top row, the tools are behind one plus key, and send sits on it in the light tone
and says its word: an arrow when it sends, "queue" while the agent works,
"steer" in white while held. queued messages are small windows of the same
colour above it, in order, each saying why it waits and what sends it.

### what it beat, and why

| direction | idea | verdict |
|---|---|---|
| the app prototype's composer | a dark glass pill, "reply...", a tools row on focus | lifeless: nothing on it said what the agent was doing |
| a. the next message | the draft is the light bubble it becomes, labelled with its fate | ugly: stock parts, a white bubble as an input |
| b. the pulse | a glass box with a live strip and a tick line along its edge; the queue stacked behind as glass edges | ugly: the tick line read as a barcode, the strip repeated the ledger row above it |
| c. the instrument | a slab with a rail of machined keys, an effort dial, a send key dragged up to steer | ugly: a toolbar of grey keys, gestures nobody would find |
| **the window** | the composer as a window of the thread's colour with a live line, pressed tools, a worded send | **picked**: it is the one object on the screen made of the product's own material, and it says the queue's logic in words |

what the verdicts say, the same lesson as the thread: the life has to come
from the product's own material and from real events, not from a new
widget vocabulary; and the first three were judged on craft before
concept, which none of them had.

## what the design asks of it

- the composer in the app prototype was lifeless. it should be lively, with a quality that is hard to name. the
  motion law still holds (`design.md`): the life comes from real events
  (the agent's work, your draft taking shape, the queue moving, a send
  landing), never from decoration that loops.
- the queue and steer must be legible: a person who queues a message has to be able to tell why it waits and what sends it.

## what the history says

what imported agent history and boxbox v1's telemetry showed about how messages are written:

| fact | pattern | so |
|---|---|---|
| sent while the agent was working | a large share of messages are queued, and a few are steered | the queue is a first-class surface, not an edge case |
| stacked soon after the previous prompt | common | queueing several in a row must be one gesture each |
| length | most are a line or two, a few have newlines, and long pastes of thousands of characters happen | the resting composer is one line; growth is the exception |
| slash commands typed | rare | `/` lives behind its glyph, never on the resting surface |
| `@` mentions | rare | same |
| images, any file | rare | photos are one tap away, not a row of their own |
| effort | almost always the thread's own | per message is an override |
| dictation | mac: an external dictation tool on the board's talk key; phone: the keyboard's mic | words arrive in bursts into the focused draft; the draft must take them without losing the caret or a save |

## what the field does (research, 2026-10-01)

what decides boxbox's design, from a survey of other composers:

| question | the field | boxbox |
|---|---|---|
| return while the agent works | split: codex cli, amp and cursor steer; claude code, zed and codex desktop queue. every vendor has shipped a bug where its meaning flipped | **queue by default**, said on the composer before you send; steer is its own named gesture, and every queued message offers "steer now" |
| what a steer does | everyone lands it at the next tool boundary; a hard stop is always separate | the same (cmx2 steer); stop stays in the header |
| queued messages | codex desktop: above the composer, edit, reorder, send, delete, promote to steer; claude code: up arrow pulls the queue back into the input | above the composer, in order, each with unsend; the first with steer now and run now; a steer with run now; unsend returns the text to an empty draft |
| drafts | telegram syncs drafts across devices and lists them; claude code's desktop and ide lose them | per thread in indexeddb on every keystroke, cleared only when the daemon acknowledges the send |
| failure | imessage's red mark with "try again"; whatsapp's clock then ticks | the message stays where it was, "not sent", with retry and "back to draft"; a retry reuses its client id |
| growth | grow to a cap, scroll inside; expand after about 3 lines (telegram) | grow to six lines, then an expand control to the full stage; same composer, same state, no modal |
| voice | the web speech api is dead in ios home-screen apps | no mic of our own; the keyboard's dictation on touch, the board on the mac |
| the ios keyboard | no virtualkeyboard api, `interactive-widget` unshipped in safari, the accessory bar cannot be hidden | decision 19 as written; the stage stands on the visual viewport's keyboard height (`stage.tsx`, `--keyboard`) |

## the component

the composer is one component with a **target**:

- **an open session**: `{ host, session }`. send means prompt, queue or
  steer on that session.
- **a new thread in a repo**: `{ host, directory, worktree: checkout | fresh }`.
  send creates the session with the first prompt.

and three **mounts**, the same component in each:

| mount | where | what changes |
|---|---|---|
| **bar** | the stage's dock slot under a thread (`stage.tsx`, `.stage-dock[data-slot=composer]`) | the top row (the line, the model chip, the effort chip), the plus key and the words with send beside them; the queue lives above it |
| **sheet** | the dock on the phone and deck, the new thread pill on every arrangement, `⌘n` (also plain `n` when not typing; control-n is left alone, it is the emacs next-line in every text field on a mac) | adds the machine, the repo chips and the folder finder, and checkout or fresh worktree; sending shows the thread being made, and when it exists the stage opens on it |
| **full stage** | the expand control once a draft passes six lines | the draft becomes the page, with the top row at its head, back returns to the bar with the caret where it was |

the composer never reads viewport geometry itself: the stage owns the
keyboard inset (decision 19), and the composer stays inside whatever its
mount gives it.

## every state

each state below has a story and a screenshot at 390, 820 and 1512
before m3's gate, and appears in all three prototypes.

### the draft

| state | when | shown |
|---|---|---|
| empty, agent done | idle session, no draft | one quiet line; placeholder "reply" |
| empty, agent working | busy session, no draft | placeholder "queue a message"; the composer says what the agent is doing (how is the direction's choice) |
| empty, wants you | an ask is pending | placeholder "or answer in your own words"; sending answers the ask. an ask of several questions is answered with the same words for each (the daemon takes one list of answers per question), and the line above the words says "answers the questions above" |
| draft | text present | the send control reads what will happen: send, queue, steer |
| long draft | over six lines | the composer stops growing, scrolls inside, offers the full stage |
| full stage | expanded | the draft as the page; characters, model and effort at the foot |
| shell (`!` first) | the draft starts with `!` | mono on a dark bed; "runs on desk, in api"; sends to `POST /session/:id/shell` |

### attachments

| state | shown |
|---|---|
| photo ready | a thumbnail with remove |
| heic ready, the browser cannot draw it | a tile of the same size that reads as a heic photo: the photo glyph over the word "heic" (or "heif") on the quiet track's material, with remove. its name is "<file>, a heic photo of 4.2 mb, converted on the host when it is sent" |
| photo uploading | a determinate ring (resized on the client; a heic goes as its original bytes where the browser cannot decode it, and the host converts it to jpeg, a30) |
| photo refused | the thumbnail with a red edge and why ("too large", "not an image the model can read") |
| heic refused | the words say the size and what to do: "<file> is 11.2 mb, over the 9 mb a heic goes at. export it as a jpeg, or shoot it at a lower resolution, and add it again" |
| file mentioned (`@`) | the path inline as written; the host inlines the file on send |

### menus

| menu | trigger | contents |
|---|---|---|
| commands | `/` first, or the `/` glyph | `GET /command`, filtered by prefix; name, description, argument hint. under a thread boxbox adds its own `/compact` (it runs at once, and a typed `/compact` sent with return does the same) |
| files | `@` after a space, or the `@` glyph | `GET /find/file?query=`, fuzzy; name lit, directory dim, line count |
| shell | `!` first | not a list: one line saying where it runs and what the agent sees |
| tools | the plus key left of the words (in the sheet it is the photo key) | each row has its icon in a quiet tile: add a photo, commands, mention a file, run in the shell, compact (under a thread: summarises the thread so far to free the context, with a ring and how full the context is), agents (under a thread: "agents, 2", opens the agents panel), write on the full stage; the first three put their glyph in the words and open their own menu. opened from the keyboard it lands on its first row: arrows walk the rows, return takes one, escape closes and returns to the plus key |
| model | the model chip (its provider's mark and its name), always in the top row | `GET /config/providers`; models only. it opens on the starred models and the one in use, with a quiet "all models · N" row under them; a star on every row keeps a model on the short list; with nothing starred it opens on every model under provider headers with one line about starring; typing searches every model, the starred first. the thread's model carries a check. "the thread's model, changes from this message on". it opens scrolled to the model in use, and tapping the chip never focuses the words |
| effort | the effort chip beside it (a signal-strength meter and the word) | not a menu: the top row turns into a dial of the efforts the chosen model accepts, a segmented control with a thumb that slides between the levels, each with its bars and name, a profile's named variants after them as pills (one tap picks, one tap on the cross closes), so it is never clipped: a row that cannot fit scrolls. the thread's effort is marked, none when the daemon will choose |

on touch every row is 44 tall (the star too); with a fine pointer, arrows move, tab and
return choose, escape closes; in the model menu shift and return stars the row the arrows are on.

### sending

| state | wire | shown |
|---|---|---|
| sending (idle session) | `POST /prompt_async {clientID}` | the message in the transcript, faded |
| acknowledged | `message.updated` with that `clientID` | solid |
| queued (busy) | 202 `{queued: <provisional id>}`, `message.updated {queued: true}` | a queued card, "next", then "then" |
| two queued | | two cards in order; unsend on each, run now on the first, steer now on the first |
| unsent | `DELETE /session/:id/message/:id` 2xx | the card leaves; with an empty draft its words return to the draft, and its photos come back with them in the same step (to a draft that holds some, the photos join them) |
| unsend too late | 409 | the card stays and says "already sent" |
| run now | `abort` then `loop` | the turn stops; the first card becomes your message |
| run now on a steer | take the steer back (`DELETE …/messages/:message`), `abort`, then a prompt with its words | the turn stops and the steer's words start the turn that answers them; what waits behind it still waits. one that already went is the agent's, and the card says so |
| queue advances | `message.removed` provisional, then the transcript id | the next card rises into the thread as your message |
| steer | `POST /session/:id/steer {clientID}` | the text lands in the live window as a steer row |
| send failed | network error, 5xx, or no acknowledgement in 5 s | stays where it was, "not sent", the reason, retry, back to draft |
| retried | the same `clientID` | the daemon answers the first result again; it never doubles |
| offline | stream down over 5 s | sends wait on the device, faded, "waits for the connection", and go in order when the stream is back |

### the agent around it

| agent | the composer |
|---|---|
| working | send queues; steer is offered |
| done | send sends |
| wants you | send answers the ask |
| retrying, parked | send queues; the reason is in the header |
| failed | send starts a new turn |

## the wire

every send goes through boxbox's server, which adds the host's credential;
the composer posts each with its `clientID`, and the daemon's echo of that
id is what settles it. one set of routes serves it: the ones boxbox shapes
or arms for push are `server/src/http/compose.rs` (and m4's prompt in
`asks.rs`), the passthroughs are m3's `session.rs`.

| verb | boxbox | the daemon at the pin (cmx2 of 2026-10-01) |
|---|---|---|
| send, queue | `POST …/sessions/:session/prompt {device, deviceClass, clientID, text, photos, model, effort}` (m4's; arms the turn) | `POST /session/:id/prompt_async {clientID, parts, model, effort}` |
| steer | `POST …/steer {device, deviceClass, clientID, text, photos}` (arms) | `POST /session/:id/steer` |
| unsend | `DELETE …/messages/:message` | `DELETE /session/:id/message/:message` |
| run now | `POST …/abort`, then `POST …/loop` | the same two |
| command | `POST …/command {device, deviceClass, clientID, command, arguments}` (arms; answers once the daemon has it) | `POST /session/:id/command` |
| compact | `POST …/compact {device, deviceClass, clientID}` (answers once the summary is in, up to five minutes; a running turn is a 422 `host-said`, a failed compaction a 502 that says the thread is unchanged) | `POST /session/:id/summarize {}` (no model, so the thread's own) |
| shell | `POST …/shell {device, deviceClass, clientID, command}` (bounded at the daemon's 600 s) | `POST /session/:id/shell` |
| files | `GET /api/hosts/:host/find/file?query=&directory=&limit=` | `GET /find/file` |
| commands | `GET /api/hosts/:host/commands?directory=` (shaped: name, description, hint) | `GET /command` |
| models, efforts | `GET /api/hosts/:host/models` | `GET /config/providers` |
| favorite models | `PUT /api/prefs/models {favorites: ["provider/model"]}`, read back in `GET /api/prefs` as `models` (ordered, at most 64, repeats dropped; one list for every device) | none (boxbox's own, in `boxbox.db`) |
| new thread | `POST /api/hosts/:host/sessions {device, deviceClass, clientID, directory, place, text, photos, model, effort}` (arms; a repeat answers the first thread) | `/experimental/worktree` when fresh, `POST /session`, then `prompt_async` |
| recent repos | `GET /api/hosts/:host/projects` | `GET /project` |
| photos | data urls on the message: clamped jpegs, or a heic or heif original of at most 9 mb (18 mb for all of one message's photos) | file parts with `data:` urls; a heic or heif part is converted to jpeg on the host (a30) |

### gaps, filed as asks (`cmx2-asks.md`), checked again at the 2026-10-01 pin

| ask | gap | what the composer does until it lands |
|---|---|---|
| a18 | a queued or steered prompt drops its model, effort and agent silently | model and effort ride only an idle send; while a turn runs the picker says "from your next message when the agent is done" |
| a19 | the queue cannot be read back | cards come from this device's outbox and the provisional messages the stream carried |
| a20 | steer and queue look the same on the wire | a steer is labelled from the outbox, which knows the verb it sent |
| a21 | `loop` answers `true` when it ran nothing | run now settles on the echo of the message it ran |
| a30 | a heic or heif file part is a placeholder, not a photo | the composer decodes it where the browser can (safari) and sends the original where it cannot. a daemon without a30 turns the part into a text placeholder, "not a kind the model can read", and does not fail the send: the message lands, the model is told there was a photo it could not read, and nothing on boxbox's side says so. boxbox does not detect that (the contract has no field for it), so against a daemon older than a30 the first sign is the agent's own reply |

fresh worktree is served as of 2026-10-01 (`/experimental/worktree`); the
new-thread route makes one before the session when asked.

## decided here, where the law is silent

- **the model list is short by default.**
  every model row has a star. the stars are one list per person, kept by the
  server (`PUT /api/prefs/models`, read back as `prefs.models`, shared by every
  device, ordered as they were starred, at most 64). a press changes the list
  on screen at once and is put back, with the server's reason in the line
  under the words, when it is not kept; each press sends the whole list, so
  only the newest press settles it (`favorites.ts`, tested). the menu opens
  on the starred models of this host (an id the host does not list is not
  shown and is kept), and the model in use is always on that list, after the
  starred ones when it is not one of them. under them a quiet "all models ·
  N" row shows the rest grouped under provider headers, with "favorites · N"
  as the way back (arrows reach both rows). with nothing starred it opens on
  every model, grouped, with one line that says starring keeps the menu
  short. typing searches every model whatever the view, the starred first.
  the opening view is chosen once, when the list is first here, so the first
  star made in the whole list does not collapse it under the finger that
  made it. opening the menu reads the prefs again (at most every 15 s) for
  the stars another device made. the rules are `models.ts`, pure and tested.
  with a mouse and keyboard the arrows move, return uses, shift and return
  stars, escape goes back to the words, and a line of keys says so; on touch
  the star is a 44 px target of its own.
- **a model has a mark.** a provider's mark (`marks-data.ts`, simple-icons and
  lobe icons, `THIRD_PARTY.md`) sits in its row's tile, on its header in the
  whole list and on the chip; a provider with no mark gets its first letter in
  the same tile. the mark never carries a name alone: the provider is always
  in the text beside it (rule 5).
- **the effort is a meter.** one bar per level of the model's own ladder
  (none is not a bar), rising like signal strength, the bars up to the
  chosen level lit (`effort.ts`, tested); the chip is the meter and the
  word, and with none chosen the bars are dim and the word is "effort". the
  dial is a segmented control over the levels with a thumb that slides
  between them on the snap spring: the same segments are drawn light on the
  track and dark on a layer clipped to the chosen one, so nothing but
  clip-path animates and reduced motion lands the thumb at once. a segment is
  as wide as the widest label needs (never under 56 px) and a label is never
  cut: a row that cannot fit, six levels and a profile's named variants (plain
  pills after them) on a phone, scrolls sideways with a fade at each end that
  has more beyond it, opens with the pick in the middle, and the arrows,
  home and end bring the focused segment or pill into view. the
  arrows move the thumb, home and end go to the ends, return picks and the
  dial folds into its chip after the thumb has landed (240 ms, none under
  reduced motion), escape closes; a dial opened from the keyboard hands
  focus back to its chip. the sheet's "where it runs" is the same control.
- **a thread can be compacted.** the plus menu has "compact" and the slash
  menu has `/compact` (a typed `/compact` sent with return does the same).
  the daemon answers once the summary is in and refuses a thread with a turn
  running, so the row says "after this turn" and a press says why it cannot (the line under the words). while
  it runs a card above the window says so with a clock (the one thing that
  changes, a second at a time, kept out of the live region); a refusal is a
  card in red with what the host said, retry and dismiss; a success is a
  receipt that goes after four seconds. where it stands is in the store by
  session key (`state.composer.compacting`), so leaving the thread and coming
  back still shows it. when the session reports its context (`info.context`,
  cmx2 a10), a ring beside compact shows how full the window is, with a tick
  where the daemon compacts by itself; a thread that reports none shows no
  ring.
- **the sheet reads at a glance.** a close key beside the title (escape and
  the scrim still close it), a machine icon on the machine chips, a clear
  key in the search, an icon on every row of the finder, and "where it runs"
  as the sliding-thumb control with a branch for the checkout, a branch that
  ends in a plus for a fresh worktree, and one line saying what the pick does.
  every control shows a focus ring in the place's light tone, never on a tap.

- **usability over a look, both kept.** the window material, the colours and the
  worded send stay. what changed is only what stood in a person's way:
  - **nothing appears on focus.** the tools row and the model chip used to
    show only while the words had focus, and send moved between the body
    and that row, so every tap on the words moved the window. now the top
    row is always there at one height (the line may say two rows; it never
    changes the row's height), the plus key and send are always where they
    are, and focusing moves nothing. send lives in the body, in one place.
  - **model and effort are two chips, visible with the keyboard down.**
    they used to be one chip that only existed with focus, whose menu held
    the effort under a long model list. the chip takes the words' pointer
    down (`preventDefault`), so a tap does not raise the phone's keyboard.
  - **the effort dial** replaces the effort section of the model menu. a
    five-segment dial does not fit beside the model chip at 390, and an
    always-open dial costs the line its room, so it opens in the top row's
    own place: two taps, never clipped. it lists only what the model
    accepts. a pick equal to the thread's own is not stored (the chip does
    not claim a change that is none).
  - **a pick that waits says so (a18).** on a session whose agent is not
    idle, a pick is not carried by the queued message, so the chip wears a
    dot, its label says "waits for your next message", and the dial's note
    says "from your next message, when the agent is done".
  - **menus fit the room.** a menu's height is the visual viewport above
    the composer less a margin (`--room`, measured on resize), never a
    fixed `52svh`; the model menu opens scrolled to the model in use. in the
    sheet a menu is part of the sheet (static, scrolls with it), so it never
    reaches over the repos or off the screen.
  - **the tools live behind a plus key** left of the words (decided here:
    the tools row cost a row on focus; four keys beside the words cost the
    words their width on a phone). the keys keep their names (rule 5): the
    plus is "add to the message", the menu rows are "add a photo",
    "commands", "mention a file", "run in the shell", "write on the full
    stage". in the sheet the plus is the photo key, since nothing else
    applies to a first message.
  - **the sheet focuses the words itself, once, inside the opening tap**
    (`focus({preventScroll})`), because that is what raises the phone's
    keyboard. the words are never remounted or moved while they have focus
    (since 2026-10-01): a pick, a machine switch or a fleet beat changes the
    composer's props, not its place in the tree.
- **a new thread is easy to find.** the home bar has a "new thread" pill on
  every arrangement (a plus on the deck, plus the word on strip and rail),
  `⌘n` opens the sheet from anywhere, and the dock on the phone and deck is
  a real button named "new thread in <repo> on <host>". the dock and the
  sheet follow the window in view on the deck (its colour, repo root and
  host) and, with nothing in view, the newest thread's repo.
- **where a thread can start.** the sheet shows the machine row when
  `hostNames` has more than one, then repo chips (your repos by their
  newest thread, then the machine's other projects) and an "other folder"
  chip. that opens a finder: a field that filters the repos by name or
  path, or, when the text starts with `/` or `~`, lists the folders inside
  that path (`GET /api/hosts/{host}/folders`, which boxbox serves from
  cmx2's `/global/fs`), with a row to go up, a row to look inside, a row
  marked repo for a git folder, and "use <path>" for the typed path as is
  (return takes it). switching the machine or the repo moves the draft to
  the new target's key, so words typed are not lost to a pick. that holds
  for every pick that changes the target: a repo chip, a folder from the
  finder, a machine, and the repo the sheet takes by itself once a machine's
  list arrives (it used to move the target without moving the words, and the
  text sat under `new:<host>:` for good). the rule is `followDraft`
  (place.ts): the words you just typed replace what the place you arrive at
  held, an empty draft moves nothing. a place with words waiting stays a
  chip with a dot, so it is one tap away (`draftedPlaces`).
- **a folder is one chip, whatever name it was reached by.** cmx2 names a
  git project by its resolved path ("/private/tmp/x" for "/tmp/x"), so a
  folder walked to by the name it was typed under would sit beside the
  repo's own chip. a picked folder takes the root a thread of the same
  directory already has (`canonicalDirectory`, from the fleet's sessions);
  boxbox cannot resolve a path on a host it only speaks to over http, and
  the daemon offers no route for it.
- **the folders route is bounded (rule 7).** it takes a `prefix` and
  narrows on the server, answers at most 500 folders with `truncated`, and
  reads at most 4 MiB of the host's answer (every upstream read is capped at
  16 MiB, past which the answer is the host's failure). 6000 subfolders were
  748 KB before.
- **a directory never seen before is allowed**, checked against the pinned
  source (cmx2 of 2026-10-01): `POST /session {directory}` takes any directory that
  exists, with no project to register, and refuses one that does not with
  400 "directory X does not exist", which the sheet shows as the thread not
  starting. no ask was needed. a fresh worktree needs a git repo, so for a
  folder the finder has seen is not one, that choice is disabled and says
  why.
- **a first message does not close the sheet on a guess.** it used to wait
  up to 8 s for a window on home that might never be drawn (the sender
  drops the outbox entry on the echo, so the old lookup of the entry's
  session found nothing). now the sheet notes the sessions it knew at send
  and finds the new one as a session of that machine it did not have, made
  since the send (or the one the outbox names). while it waits it says "making
  the thread in <repo> on <host>", after 8 s it says the machine is slow and
  keeps waiting, and on a refusal it says "the thread did not start: <why>"
  with retry (one send, the same client id) and edit (the words go back to
  the draft). when the thread exists the stage opens on it growing from the
  sheet's window, as a tap on a window does (`onOpened` to home's
  `openBorn`; if a transition refuses the grow the thread opens in place),
  and the sheet fades out. it works the same on the strip and rail.
  **which thread it opens is the one this send made, and only that one.**
  the worker says `born {clientID, key}` once, from the server's answer to
  that client id (or from the echo, when the answer was missed); the sheet
  waits for that key to be in the fleet. an earlier version guessed from
  the fleet (the one session on the machine that was not there at send), and
  opened another phone's thread, or a subagent's, when one appeared in the
  same moment; it also compared the host's clock with the phone's. the
  outbox could not be the source: the entry is dropped when the echo lands.
- **a first message that did not start is not lost.** the sheet does not
  close on a guess and does not drop the words: "edit" puts them back in the
  draft, picking another place does the same (so does closing the sheet),
  and the entry is discarded either way, since left in the outbox it sat in
  indexeddb for good and counted toward the cap. while it is failed, sending
  another is blocked ("retry or edit the message below first"), because a
  second send would orphan the first. a send that fails after its sheet is
  gone is restored by the sheet that opens next. its photos come back with
  its words: an outbox view holds only their count, so the worker hands the
  photos to the page when the entry is discarded (`returned`), and they join
  the draft of the place it was written for.
- **a refusal is a refusal.** a daemon's own 4xx comes back from boxbox as
  422 `host-said` (a daemon 5xx stays 502). the sender retries 502, 503 and
  504 as unreachable and treats anything else as an answer (a 503 that says the
  server waited two minutes for room for the message's photos and had none is
  an answer too: it has already waited), so a missing
  folder used to show "making the thread" across two posts before it
  failed. the words follow the voice: a missing folder is "nothing at <path>
  on <host>, so the thread did not start. pick another folder, or make it
  and retry.", the finder says "there is no folder at <path> on <host>." or
  "<name> is a file, not a folder.", never "said no (400)".
- **the sheet's controls are named for the new thread** ("model for the new
  thread: ...", "effort for the new thread: ...", "add a photo to the new
  thread"), because at strip and rail the sheet and the bar under the open
  thread are on screen together and every accessible name is unique (rule
  5). while the sheet is open the rest of home is `inert` (a sibling of the
  sheet, never an ancestor), since it is `aria-modal`.
- **send's box is what is drawn.** the button is 44 wide as a disc and 96
  worded, so a click on its middle, or a tap, is a click on it; the face
  inside opens by clip. it used to be a 96 px box with its left 52 px
  clipped, and a click at its center hit the body.
- **the model and effort chips survive a list that is late or did not
  come.** the host's models are read into the store once per host
  (`readModels`, one read for overlapping asks, ten seconds at most); a
  read that fails or hangs is recorded (`state.modelsRead`), where it was
  once swallowed while the picker's comment said it spoke. until the list
  is here the model chip names the thread's own model in words derived from
  its id ("claude opus 5.5", never the raw slug) with a dashed underline and
  a name that says why ("the model list did not come"); the effort chip
  stays, showing the thread's own effort, and its dial offers that one with
  "the effort choices did not come." and a retry (with nothing known the
  chip still says why instead of hiding, so reasoning is never unreachable
  by a failed read). the model menu says "the models did not come." with a
  retry row. a failed read is read again when the stream comes back, when
  the app returns to the foreground, on the menu's retry and on a tap of the
  effort chip. stories `models-loading`, `models-failed` and
  `models-failed-dial`; driven at 390 with the models route aborted, then
  released (the retry and the foreground read both brought the list).
- **escape closes the effort dial** from the words too, and a pick made
  while an ask is pending survives answering the ask in your own words (the
  answer carries no model or effort, so it waits like any queued pick).

- **the line's rule.** it shows the agent's newest step only when that is
  not already on screen (the transcript's last line out of view); while
  you write it says what send will do. it never repeats what is above it.
  its words are the agent's newest row in the running turn that has words
  (never your own prompt or the turn before it, never a part announced
  and still empty: a turn that has said nothing yet shows no line, the
  top row keeping its height), prose as the last two sentences the window's cards
  show, begun at a word: the server keeps a part's last 280 characters,
  so a long part's piece of a first word is left out, and the prose is
  anchored to its end, two lines tall, so what is said now is what shows
  and what is cut goes a whole line at a time from the top. it rolls in
  when a new row begins, a step or a new part; the same row's words
  growing change in place with no roll. a turn's start is told apart from
  the last turn's end: the busy status can land a few milliseconds before
  the update that puts the new prompt in the tail, so from the moment a
  session known to be idle goes busy the line shows nothing until the
  tail has moved, and a thread opened mid-turn (its session never seen
  idle) shows its line at once.
- **the dock holds still through a turn.** the top row is always there at
  one height (above), so the line coming, going, changing its words or
  being empty moves nothing, and the dock's height is the same from the
  first frame of a turn to its settle, focused or not. the live line's
  prose is two lines at most, anchored to its end.
- **send's word.** a disc with an arrow when it sends; it opens by clip
  into a worded pill for queue, steer, answer, run (a `!` line) and start.
- **the first queued card** carries steer now and run now on a row of its
  own, so its text keeps the width at 390; the others carry only unsend.
- **a steer can be run now.** a steer waits for the next
  tool boundary, and a long command or a wait on agents can put that boundary
  far off, so its card carries run now (and unsend) on a row of its own, like
  the first queued card's, while the agent works, and says what run now does
  ("run now stops the turn and runs it"). a stop alone does not do it: driven
  against the pinned daemon (cmx2 of 2026-10-02), a stop that lands while a command runs,
  or while the turn waits on its agents, takes the waiting steer into the
  thread as the turn ends, with an empty aborted reply after it, so `loop` has
  nothing to run (it answers true) and the agent never answers the steer; only
  a stop that lands while the model streams leaves the steer queued for `loop`.
  so run now takes the steer back first, stops the turn, and sends the words as
  a prompt (`runSteerNow`): the daemon took 0, 17 and 6 ms for the three in the
  driven case, so the card leaving and the message arriving is not a gap a
  person sees. a steer that already went is refused with the unsend's own
  words and nothing is stopped; a stop that fails puts the steer back as a
  steer and says so. a steer with photos is not offered it (the card holds the
  photos' count, not their bytes, so the words could not go again whole); the
  same rule hides steer now on a first queued card with photos.
- **unsend with an empty draft** returns the text to the draft, so the
  common reason to unsend (to fix it) is one tap. a message of this device's
  own comes back whole: its photos too, and its words judged against what the
  draft held before the photos came (otherwise a photo coming back made the
  draft look written and the words, which the daemon had already deleted, were
  dropped). the worker sends them together (`returned`, with `text`) just before
  it says the daemon took the message; a steer now or a run now that sends the
  words again by itself does not ask for them back.
- **dictation has no state of its own.** the keyboard's mic and the
  board's talk key both type into the focused composer; the draft takes
  the bursts like typing and is kept on each one.
- **a send is shown as a card when its echo is slow.** an idle send is
  a "sending" card above the window only once it has waited 600 ms for
  its echo; on a good connection the message is in the thread within a few
  frames of the post returning, and a card that came and went would move
  the dock by its own height (about 99 px) for those frames. when the
  daemon echoes a send that had its card, the card flies into its place
  in the thread (`flyInto`), on the stream's live events only; one that
  never had a card simply appears as the turn's first frame.
- **a post never waits on a dead connection.** when the stream drops, the
  posts in flight end and their sends wait on the device ("on this
  device"); each post is also bounded (20 s, and for each photo 20 s or the time its bytes need at 200 kB a second, whichever is longer, `postBudgetMs`). a
  send that goes again carries its first client id, so the daemon answers
  it with the first answer, and an echo missed while away is found in the
  transcript the worker reads back.
- **photos.** at most four on a message, clamped before they go; the server
  refuses anything unclamped rather than relaying it.
- **a heic the browser cannot decode goes as it is (decided here, a30).**
  chrome and firefox, on the desktop and on android, cannot decode heic, and
  people were converting by hand. conversion is cmx2's (rule 8, a30), so
  the composer sends the original and the host converts it to jpeg.
  - **the browser path is always tried first** (`createImageBitmap`): where it
    decodes (safari) the photo is fitted to 1568 px and sent as jpeg under
    1.5 mb, which is free and smaller. only when the decode throws and the
    file is a heic or heif does the original go. it is one by what the browser
    says (`image/heic`, `image/heif`), by its extension (chrome often gives a
    `.heic` an empty type), or by the brand in its first 64 bytes (`ftyp`: an
    iphone's is major `heic`, `heix`, `hevc` and the like, or the generic
    `mif1` and `msf1` as `image/heif`; an avif says `mif1` too and is not one).
    the bytes are read once, as a data url of the file's own kind
    (`data:image/heic;base64,`; a file with no type would otherwise read as
    `application/octet-stream`, which the server refuses).
  - **the limits, every one on the path** (`fit.ts` and `compose.rs` say the
    same numbers, and a test holds each pair):

    | what | limit | why |
    |---|---|---|
    | a resized photo | 1.5 mb of data url | unchanged: 1568 px jpeg lands well under it |
    | a heic or heif original | a file of 9 mb (12 mb as a data url, 23 characters of head more) | the limit is in the size the person sees in their files, so a refusal can say it and a file over it always reads bigger than it ("9.1 mb, over the 9 mb"). a phone's heic is 2 to 5 mb and a 48 mp one about 9; a model reads it at 1568 px whatever its size, so more buys nothing. the size is known before a byte is read, so a file over it is refused without being held |
    | all of one message's photos | 18 mb of files (24 mb as data urls) | two heics at the limit, or four jpegs (6 mb of data url) with room over; it is also what the body limit is built from |
    | the body of prompt, steer and new thread | 25 mb (`PROMPT_BODY`, was 7) | the photos' 24 mb and a 100,000 character text in json (under 1 mb) |
    | photos in flight on the server | 100 mb of memory (`PHOTO_BUDGET_MIB`): two messages at the body limit, each counted twice, by the size its body announces | a body is held twice over while it is read (the bytes it came in, then the strings parsed from them), so a message costs twice its size at its peak: the budget is what the process can reach, not what it is told. a middleware takes the room before a byte is read. a message that does not fit waits for room, up to 2 minutes (`PHOTO_WAIT`): nothing of it has been read, so waiting holds no memory, and a message behind two that are being converted goes when they are done. one that has had no turn in two minutes is answered 503 `photos-busy` ("other photos kept boxbox busy for two minutes, so it could not take this message"), which the sender takes as an answer and does not try again (three tries would be six minutes of waiting): the card says not sent, with retry. words (a body under 256 KiB) are never counted. measured below |
    | the outbox and the drafts together | 72 mb of data url | three messages at the limit (rule 7). the composer asks before it takes a photo (every draft's photos and every unsent message's, `noRoomFor`). the sender holds the same cap for real: a message that would pass it does not take its photos into the outbox, they go straight back to the draft they came from (`returned`), and the message stays as a failed card with its words alone, which says so ("its photos are back in the draft. edit it back there too, and send it when the others have gone") and is not offered a retry (that would send the words without them). a person does not meet this (the composer asks first); it is the backstop for another tab. a data url string per photo in memory, in indexeddb and in a worker message, so it is the bytes this device spends on photos nobody has received |
    | a post from the device | 5 s, the wait for room (2 min, for any message with photos), the upload at 200 kB a second, and what the server gives the host (`postBudgetMs`) | the post outlasts everything the server waits for: two heics at the limit are given about eight and a half minutes. a retry carries the same client id, so a post cut after the server took it is answered with the first answer |
    | boxbox to the daemon | 15 s, then per photo bytes at 256 KiB a second, and 75 s more for each heic or heif (`accept_timeout`) | the daemon answers once it holds the message, and cmx2 converts a heic before it does, giving each 60 s in all (each converter gets what is left of it, 45 s at most); 15 s more is the margin. the device's post is given this on top of the upload, so the server's answer, not the device's timeout, is what a slow host produces |
    | the daemon's own body | 128 MiB (cmx2 `MAX_BODY_BYTES`, read at the heic checkout) | well above 25 mb |

    the passthrough routes in `session.rs` (queue, send; 8 mb, any data url)
    are not the composer's and keep their own limit.
  - **a file over the limit says the size and what to do.** "IMG_4021.heic is
    11.2 mb, over the 9 mb a heic goes at. export it as a jpeg, or shoot it at
    a lower resolution, and add it again". the server says it the same way, in
    the file's size and not the data url's, for a client that did not ask first.
    a heif says "heif". a photo that would take a message past 18 mb says so and
    offers a message of its own; a device holding 72 mb says how much it holds.
  - **the tile.** the design law says "a thumbnail with remove" and is silent
    on bytes that cannot be drawn, so: the same 60 px box, the quiet track's
    material (it is not a picture, so it does not pretend to be one), the
    photo glyph over the word `heic` (or `heif`) in mono, and the remove mark
    as on any photo. the mark is in the top right corner and the glyph and the
    word keep to the left and below it, so nothing sits under the mark at any
    width (the tile is 60 px at 390 and at 1512). nothing is decoded in script for a preview: a wasm
    decoder would be a dependency (rule 15) and megabytes of script for a
    thumbnail the host will not use. its accessible name carries the file's
    name, the kind and the size, and says the host converts it; the glyph and
    the word inside are hidden from assistive technology, so that name is the
    only thing read. the picker's
    `accept` names `.heic` and `.heif` beside `image/*` so a browser that does
    not map the extension still offers them.
  - **`width` and `height` on `Photo` are `null` for an original.** nothing in
    the app reads them (the tile is a fixed box and the transcript draws what
    the daemon stores); they were only what the clamp measured. a browser that
    cannot decode the file cannot measure it, so the honest value is none,
    not a guess, and the host finds the real size when it converts.
  - **an older daemon** turns the part into a text placeholder and does not
    fail the send (a30): the message lands and the model says it could not
    read the photo. the composer cannot tell, so it sends anyway.
  - **what the server holds for photos, measured.** two messages of 22.6 MiB
    (two heics each) posted together to a prompt route, three times in a row,
    with a stand-in for the daemon that takes the body and answers 202 after
    2 s, so what is measured is boxbox's own. resident memory at idle, at its
    peak, and after the answers:

    | build | idle | peak | after |
    |---|---|---|---|
    | linux arm64, the release's static musl build (the build stage of `ops/release/Dockerfile`), in a container | 9 mb | 77 to 97 (+68 to +88; the kernel's high-water mark 99 to 102) | 5 to 9 mb, at once and a minute later |
    | the same, four messages at once | 8 mb | 88 (+80): two go, two wait about 2 s for room and go, all four are answered 202 | 9 mb |
    | macos arm64, the release build (the system allocator) | 12 mb | 104 (+92) | 103 mb for 8 s, 69 mb after 40 s; a footprint of 63 mb |

    the peak is the budget: two messages counted twice is 92 mb, and idle and
    the budget are what the kernel's high-water mark reads. on linux, where the
    release is built and run, memory goes back to idle as the answers go (musl
    hands a freed large block back at once), so the 64 mb steady figure holds
    and a photo is a peak of the seconds it is in flight. on a mac the system
    allocator keeps the freed 23 mb blocks in its large cache (57 mb in four
    regions) for as long as it likes; it does not grow (three bursts in a row
    read the same) and sits inside the steady figure, and the debug build is
    worse for the same reason (it held 82 to 113 mb after a burst). mimalloc as
    the mac's allocator was tried and held more (132 mb), so the system one
    stays. on the way here, the debug build on the mac read 308 mb at the peak
    (+283) before the parts and the body were moved instead of copied, 206 with
    the budget, and 122 once the body was read into one buffer of its announced
    size (`Message`, not axum's `Json`, which joins the frames into a second
    buffer) and written once with its size known. some clients see the
    connection end instead of a 503 when a message is turned away, because the
    server answers before the body has been sent.
  - **a keystroke carries the words, never the photos.** the draft used to be
    structured-cloned to the worker whole on every edit, and the worker wrote
    the whole record (photos included) to indexeddb after every pause in
    typing; with two heic originals that is up to 24 mb copied per key and 24
    mb written per pause. now the message says `photos: "kept"` unless the edit
    changed the set (a photo added or removed, a draft moved or cleared), the
    worker holds the set it was last sent (`photoSets`, bounded by the drafts and
    the device's 72 mb), and indexeddb keeps the two apart: `drafts` holds the
    words (no photos), `draftPhotos` holds the set and is written only when it
    changed (database v3). tested in `sender.test.ts` (what each write
    carried) and `outbox.test.ts` (the split and the join).
  - **a write that fails is not forgotten, and does not go on for ever.** a
    draft write the store refuses (the quota, a closing database) goes back,
    made from the draft's newest words and never the words the failed write
    carried (an edit that came while it was slow may be written already, and
    must not be written over by older ones: `latest` in `sender.ts`), and its
    photo set stays marked as unwritten, so a keystroke after the failure cannot
    write words with no photos behind them. it is tried again after 3 s, then
    6, 12, 24, 48 and every minute (`draftRetryMs`: each try can be megabytes
    of photo), and typing does not bring a try sooner. after three rounds in a
    row the person is told, where they write: "this device has no room left to
    keep drafts, so what you write here stays only while this page is open.
    free some space and it saves again", and it goes when a write lands. a
    draft written before the split holds its photos in its words record: it
    reads as it was, and the sender marks every draft that comes back with
    photos as changed, so its first edit writes the photos into their own
    record once, in the same transaction as the words (nothing is moved at
    read, so nothing can fail silently there).
  - **photos come back with the words.** an unsend the daemon took, "edit" on
    a failed send, the sheet's edit and its restore of a first message that did
    not start, and a message the outbox would not take the photos of, put the
    message's photos back in the draft they came from, with its words where they
    are wanted: the worker hands them to the page (`returned`), which adds the
    photos after the ones the draft holds, up to four and 18 mb. an unsend's
    words come in the same step, into a draft that held nothing before the
    photos came (`takeBackDraft`), so a message with a photo is taken back whole
    in one tap. photos that do not fit a draft that already holds some are said
    in the composer's line ("1 photo did not fit the draft (a message takes at
    most 4 photos and 18 mb together) and boxbox no longer holds it. pick it
    again from your library for another message"): nothing else holds them, so
    that is the one case that loses any.
  - **photos picked for a thread go to that thread.** clamping awaits (a heic is
    read whole), so the draft they join is the one the picker was opened for,
    taken at the start, and not whatever thread is open when the last file is
    read.
  - **another tab on an older build.** the database is v3 and an upgrade waits
    for every other connection to close. a tab running a build from before this
    one never lets go, so the new tab's cache opened late with no word why; now
    the page says so ("boxbox is open in another tab on an older version. close
    or reload that tab, and this one opens."), with no button (reloading this
    tab cannot help: the other one holds the database), and the notice goes by
    itself when that tab lets go. a v3 tab yields to the next upgrade: it closes
    its connection, stops writing, and shows the update's reload button.
  - **two tabs on one thread** each hold their own worker and their own draft
    in memory, and both write the one indexeddb record. a tab that is left open
    and edited after another tab has added or removed photos writes its own
    words with the photo set it last knew, so the thread's words can end up
    with the other tab's photos, or the other tab's photo set replaced. the
    draft is one per thread by design (there is one draft to find), and the
    page does not watch another tab's writes; not fixed.
- **a new thread is remembered by its client id** on the server (the last
  64), so a retried birth answers the first thread instead of making a
  second.
- **model and effort are the thread's.** at the pin a message that names
  a model or an effort makes it the session's from that turn on
  (`setModel`, `applyEffort`), so the chip shows the session's own (its
  `model` and `effort`), the picker says "changes from this message on",
  and a pick lives in the draft only until a send carries it. a queued
  send cannot carry it (a18), so the pick waits for the next idle send.
  picking a model never raises the effort: the daemon's default for that
  model stands unless one was picked.
- **the first-load script budget** counts what `index.html` loads, as
  `architecture.md` says ("the whole app's first load"); a chunk only a
  later action imports is printed and not counted (`scripts/compress.ts`).

## telemetry

`perf.send` (`telemetry/schema.ts`): ms from the tap to the daemon's echo
of the send's client id, by verb (send, queue, steer, shell, command,
start, run), with the posts it took and its photos; `ok` 0 when it failed
or no echo came in 30 s. the worker emits it when the echo settles the
outbox entry, live or found in a transcript it read whole after a reset.
`friction.abandon` (`what: compose`) is emitted when the person empties a
draft that held words or photos, with the most characters and photos it
held and how long it was open; a draft cleared by its send is not one. no
prompt text ever enters a label.
