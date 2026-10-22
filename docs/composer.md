# the composer

the writing law for boxbox: what the composer is, where it mounts, every
state it can be in, what each one is made of on the wire, and what the
pinned cmx2 does not serve yet. it extends `design.md` (the composer,
starting a thread, input, the motion law) and is binding the same way
(AGENTS.md, design law).

## where it lives

| path | what |
|---|---|
| `app/src/ui/composer/composer.tsx` | the component: a target, a mount, the window, the line, the queue's verbs, the menus, the full stage |
| `app/src/ui/composer/queue.tsx` | the queue's strip above the window (one message, "+N", the edges behind, swipe and long press) and the list of every message with its verbs that a tap on it opens |
| `app/src/ui/composer/sheet.tsx` | the new-thread sheet: machine, repos by recency, a folder finder for any other folder, checkout or fresh worktree, the progress and the failure of the first send, the hand-over to the open thread |
| `app/src/ui/composer/model-menu.tsx`, `models.ts` | the model menu (favorites, the whole list by provider, search, the keys) and its rules as pure functions (tested) |
| `app/src/ui/composer/dial.tsx`, `thumbed.tsx`, `effort.ts` | the effort meter and the dial on the sliding-thumb control the sheet's "where it runs" shares, and the ladder rules (tested) |
| `app/src/ui/composer/marks.ts`, `marks-data.ts`, `marks-sprite.ts`, `mark.tsx` | which provider is which mark (in the script); the marks as data (not in it: the build writes them into `index.html` as an inline svg sprite, so they are in the document when it is parsed and a mark is drawn in the first frame, with no fetch and no pop-in; the script budget was the reason); and the tile that draws one with `<use>` (`THIRD_PARTY.md`) |
| `app/src/ui/composer/favorites.ts`, `compact.ts`, `context.tsx`, `icons.tsx` | the star's route (optimistic, newest press wins), the compact call and its state in the store, the context ring, and the icons |
| `app/src/ui/composer/dock.tsx` | home's new-thread dock: one button in the colour of the window in view, naming repo and host |
| `app/src/ui/composer/place.ts` | where a thread can start, as pure rules: repo root of a session, recency order, the repo filter, typed paths (tested) |
| `app/src/ui/composer/drop.ts` | drops: what a drop holds (photos, files to mention, words) as pure rules (tested), and `fileDrop`, the target the composer puts on itself and on the stage its mount passes as `dropZone` |
| `app/src/ui/composer/inline.ts` | the live line's markdown read inline: its runs (strong, emphasis, code), the marks gone, a mark still open dropped (tested) |
| `app/src/ui/composer/words.ts` | every sentence it says (placeholder, send's word, the line, each card's why and when it goes, the strip's lead), pure and tested |
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
"steer" in white while held. messages on their way fold into one strip
above it that says when the one it shows goes; a tap lists them all, in
order, each saying why it waits and what sends it.

### the glass (2026-10-16, the ios app's decisions 15, 16 and 23)

under a thread the composer is clear liquid glass (`.lg` tokens in
`styles.css`, read by `composer.css`): it floats over the log as the stage
bar's rounds do, so the transcript moves under it, brightened and barely
blurred, lit along the rim, with the clear lens's short drop in place of the
window's long shadow. its words stay legible the way the system keeps them
on clear glass: a pool of shade behind them (the window's lit top colour on
light, its deep colour most of the way to black on dark, half at its heart:
at 80% it hid the transcript passing under the glass, which read as an
opaque pane; at half the placeholder measures 5.5:1 on dark and 6:1 on light
over the log, the draft 10.6:1 and 12.6:1).
the pool fills the pane and is feathered by a mask of two crossed ramps, 40%
at the rim and whole 32 px in, so it has no edge anywhere and never leaves
the pane; it only thins toward the rim and most at the corners, where the
lens catches the light. (a blurred box 8 px in, the first port of the native
pool, spilled past the rim as a dark halo and left a bright ring inside it:
the pane read as a smudge in a frame.) the words taking focus light the rim:
a hairline of the accent and a brighter top, by opacity alone, so the lens at
rest is quiet and a typing one is awake, as a native field of glass is. a
brighter ink serves what send will do and the placeholder. the plus, send, the chips, the
dial's close and the problem's dismiss are drops of glass over a breath of
ink (8% black on light, 10% white on dark; clear glass inside glass draws
white on light), with no pressed-in edge; on (send ready, a menu open, a
retry) is the glass tinted with the accent; a press swells the lens rather
than shrinking the key. a shell line tints the glass with its dark bed. the
queue's strip is a drop of the same glass with its own pool; the edges
behind it, its list, the menus, the sheet and the full stage keep the repo
material, since they sit on grounds of their own or would stack glass on
glass. without backdrop-filter none of it applies and the window and its
pressed keys stand as above; under reduced transparency the lens keeps its
shape and its tokens turn solid, as every lens does (`styles.css`). the
glass was once gated on `not (prefers-reduced-transparency: reduce)`, which
safari reads as false since it knows no such feature, so on a mac or an
iphone the bar wore the repo material instead, and the material's long
shadow, on a layer lifted 6 px and scaled to 97.5% at rest, cast onto the
window's own foot (a negative layer of an isolated box paints over its fill):
a dark ring inside the edge, heaviest at the foot, under a light hairline.
the shadow's layer is now the window's own size at rest and at focus, only
its opacity moving. the rim at rest is one even hairline brighter along the
top, the drop soft below with no contact shadow; crops of each layer toggled
are how the ring was named (the shots' `glass-rest-*` stories, in webkit as
well as chrome, since the two disagree on that media query).

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
| **bar** | the stage's dock slot under a thread (`stage.tsx`, `.stage-dock[data-slot=composer]`) | the top row (the line, the model chip, the effort chip), then the words: on one line between the plus key and send, from a second line the window's full width with the plus and send on a row of their own under them (the layout, below); the queue's strip lives above it |
| **sheet** | the dock on the phone and deck, the new thread pill on every arrangement, `⌘n` (also plain `n` when not typing; control-n is left alone, it is the emacs next-line in every text field on a mac) | adds the place line (the machine, the recent repos and the folder finder behind it), and the fresh worktree switch; sending shows the thread being made, and when it exists the stage opens on it |
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
| file ready | a tile beside the photos, as tall: its type tile (the page glyph in the accent over its kind, "pdf", "md", "csv"), its name cut in the middle ("bookin…al.pdf") over its size, with remove. its name is "<file>, 1.2 mb" (`FileTile`, `files.ts`) |
| file refused | the problem line, before a byte is read, in cmx2's own numbers: "<file> is 31 mb. cmx on <host> takes pdfs up to 9 mb.", "export.csv is 625 kb. cmx on <host> takes text files up to 512 kb.", "<file> is not text. cmx on <host> reads pdfs, text and json.", "<file> is not utf-8 text. save it as utf-8 and add it again.", "<file> has a quote in its name. rename it and add it again.", "<file> is empty. add a file with something in it.", past the count "cmx on <host> takes 4 photos and files on a message. <file> did not fit." |
| file mentioned (`@`) | the path inline as written; the host inlines the file on send |
| dragged over the composer or its stage | the window's edge lights in the accent and the line says "drop a photo or a file to add it" |
| dropped or pasted | an image joins the photos (the same clamp as a picked one); a pdf, text or json file joins them as a file (below); both count to the same four. any other file is mentioned after an `@` by its name, its spaces gone (the host's file list finds it when it is in the repo, as a typed mention does), and the problem line says so: "cmx on <host> does not take .zip files, so logs.zip is mentioned by its name instead." dropped words join the draft (`drop.ts`) |

the drop target is the composer and, where its mount passes one (`dropZone`),
the stage around it: a drop anywhere on an open thread lands in its composer.
the browser hands a dropped file over without its path on the host, so a file
the agent reads goes as its bytes, with the message, and one it does not is
named (`attachments: any file`, below).

### menus

| menu | trigger | contents |
|---|---|---|
| commands | `/` first, or the `/` glyph | `GET /command`, filtered by prefix; name, description, argument hint. under a thread boxbox adds its own `/compact` (it runs at once, and a typed `/compact` sent with return does the same) |
| files | `@` after a space, or the `@` glyph | `GET /find/file?query=`, fuzzy; name lit, directory dim, line count |
| shell | `!` first | not a list: one line saying where it runs and what the agent sees |
| tools | the plus key left of the words (in the sheet it is the photo key) | each row has its icon in a quiet tile: add a photo, add a file (the file picker, "pdf, text or json"; a page glyph with its lines), commands, mention a file ("mention", "a file on <host>"; the plain page glyph), run in the shell, compact (under a thread: summarises the thread so far to free the context, with a ring and how full the context is), agents (under a thread: "agents, 2", opens the agents panel), write on the full stage; the first three put their glyph in the words and open their own menu. opened from the keyboard it lands on its first row: arrows walk the rows, return takes one, escape closes and returns to the plus key |
| model | the model chip (its provider's mark and its name), always in the top row | `GET /config/providers`; models only. it opens on the starred models and the one in use, with a quiet "all models · N" row under them; a star on every row keeps a model on the short list; with nothing starred it opens on every model under provider headers with one line about starring; typing searches every model, the starred first. the thread's model carries a check. "the thread's model, changes from this message on". it opens scrolled to the model in use, and tapping the chip never focuses the words |
| effort | the effort chip beside it (a signal-strength meter and the word) | not a menu: the top row turns into a dial of the efforts the chosen model accepts, a segmented control with a thumb that slides between the levels, each with its bars and name, a profile's named variants after them as pills (one tap picks, one tap on the cross closes), so it is never clipped: a row that cannot fit scrolls. the thread's effort is marked, none when the daemon will choose |

on touch every row is 44 tall (the star too); with a fine pointer, arrows move, tab and
return choose, escape closes; in the model menu shift and return stars the row the arrows are on.

### sending

| state | wire | shown |
|---|---|---|
| sending (idle session) | `POST /prompt_async {clientID}` | the message in the transcript, faded |
| acknowledged | `message.updated` with that `clientID` | solid |
| queued (busy) | 202 `{queued: <provisional id>}`, `message.updated {queued: true}` | the queue's strip: "next, after this turn" and its words; no bubble in the transcript until it lands |
| two queued | | one strip showing the first, "+1" and the edge of the one behind; a tap lists both in order: unsend and edit on each, run now and steer now on the first |
| unsent | `DELETE /session/:id/message/:id` 2xx | the card leaves; with an empty draft its words return to the draft, and its photos come back with them in the same step (to a draft that holds some, the photos join them) |
| unsend too late | 409 | the card stays and says "already sent" |
| run now | `abort` then `loop` | the turn stops; the first card becomes your message |
| run now on a steer | take the steer back (`DELETE …/messages/:message`), `abort`, then a prompt with its words | the turn stops and the steer's words start the turn that answers them; what waits behind it still waits. one that already went is the agent's, and the card says so |
| queue advances | `message.removed` provisional, then the transcript id | the strip rises into the thread as your message, and shows the next |
| steer | `POST /session/:id/steer {clientID}` | the text lands in the live window as a steer row |
| send failed | network error, 5xx, or no acknowledgement in 5 s | stays where it was, "not sent", the reason, retry, back to draft |
| retried | the same `clientID` | the daemon answers the first result again; it never doubles |
| offline | stream down over 5 s | sends wait on the device, faded, "waits for the connection", and go in order when the stream is back |

the queue's strip (`queue.tsx`) is a chunk of its own, loaded just after the launch rather than in the first load
(2026-10-22): fork and btw together took the first load to 122.2 kb of script, over its 120 kb budget, and moving
the strip with the late btw and fork pieces brought it to 118.5 kb. the one thing it changes: on a reload with
messages queued, the strip shows a frame or so after the first paint, read from the precache. a btw's send checks
(`btw/ask.ts`) load at the first btw sent, the same way.

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
  in the text beside it (AGENTS.md, accessibility).
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
  focus back to its chip.
- **a thread can be compacted.** the plus menu has "compact", the slash
  menu has `/compact` (a typed `/compact` sent with return does the same),
  and the stage's thread menu has "compact" too, calling the same
  `compactThread`: one compaction per thread, whichever asked, and this
  card says it.
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
- **the sheet reads at a glance** (the native app's newthread, ported
  2026-10-16): the title and the stage bar's round of liquid glass to close
  it (escape and the scrim still close it); one place line, as tall as a
  field, with the repo's real mark (its favicon once read), its name and
  "on <host>", named "starts in <repo> on <host>" with `aria-expanded`; the
  composer under it; and "a fresh worktree" as one quiet switch
  (`role="switch"`) with one line under it saying what the choice means, or
  why this folder cannot have one. a press on the place line opens it in
  place into the pickers: the machine chips when there are two or more, the
  twelve recent repos as their marks (52 px, the name under each, the chosen
  one ringed in its own accent with a hair of the card between, scrolled
  into view as they open), and the finder ("find a repo, or type a path").
  a repo or a folder picked closes the pickers onto the words, the caret in
  them; a machine picked keeps them open on the finder. with nowhere chosen
  they open by themselves. in place of the recent marks the line says
  "looking." while the machine's repos are being read, the read's own words
  when it failed, and "nothing has run on <host> yet. find a folder to start
  in." only when the machine has answered with none. every control shows a
  focus ring in the place's light tone, never on a tap. the composer's own
  top line still names the place too; it is the composer's to drop.

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
    words their width on a phone). the keys keep their names (AGENTS.md, accessibility): the
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
- **where a thread can start.** the place line's pickers show the machine
  row when `agentNames` has more than one, then the recent repos (your repos
  by their newest thread, then the machine's other projects), then a
  finder: a field that filters the repos by name or
  path, or, when the text starts with `/` or `~`, lists the folders inside
  that path (`GET /api/hosts/{host}/folders`, which boxbox serves from
  cmx2's `/global/fs`), with a row to go up, a row to look inside, a row
  marked repo for a git folder, and "use <path>" for the typed path as is
  (return takes it). switching the machine or the repo moves the draft to
  the new target's key, so words typed are not lost to a pick. that holds
  for every pick that changes the target: a recent repo, a folder from the
  finder, a machine, and the repo the sheet takes by itself once a machine's
  list arrives (it used to move the target without moving the words, and the
  text sat under `new:<host>:` for good). the rule is `followDraft`
  (place.ts): the words you just typed replace what the place you arrive at
  held, an empty draft moves nothing. a place with words waiting stays
  among the recent marks with a dot, so it is one tap away (`draftedPlaces`).
- **a folder is one chip, whatever name it was reached by.** cmx2 names a
  git project by its resolved path ("/private/tmp/x" for "/tmp/x"), so a
  folder walked to by the name it was typed under would sit beside the
  repo's own chip. a picked folder takes the root a thread of the same
  directory already has (`canonicalDirectory`, from the fleet's sessions);
  boxbox cannot resolve a path on a host it only speaks to over http, and
  the daemon offers no route for it.
- **the folders route is bounded (AGENTS.md, memory and latency).** it takes a `prefix` and
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
  the draft). **the sheet lets go of the screen as the message goes** (the
  native app's decision 21, ported 2026-10-16): it slides off as a close
  does but stays mounted, hidden and inert (`away`, held by home), so the
  send and its state are kept while home is usable under it. the dock says
  what the sheet would ("making the thread in <repo> on <host>.", the slow
  line, or the connection's) in place of its place line, also as its
  `aria-description`; a tap on the dock, the new thread pill or `⌘n` brings
  the same sheet back as it opened. a refusal brings it back by itself with
  the words, retry and edit, and retry lets go again. when the thread
  exists the stage opens on it growing from the dock while the sheet is
  away (from the sheet's window when it is up), as a tap on a window does
  (`onOpened` to home's `openBorn`; if a transition refuses the grow the
  thread opens in place), and the sheet goes. the strip and the rail have no
  dock: the sheet lets go there too, and the new thread pill brings it
  back. `composer / new thread sheet lets go` is the story.
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
  and what is cut goes a whole line at a time from the top. the agent's
  prose is markdown and is drawn as such, inline (`inline.ts`): strong in
  the full ink, emphasis slanted, code in the mono face, a link as its
  words, and no star, underscore or backtick shown; a mark still open at
  the stream's end is dropped rather than drawn as a literal star that turns
  bold a moment later, and a heading's hashes or a list's bullet go before
  the prose is cut. a question the agent asked, settled or not, and its own
  todo list are never the line (they are the ask card's and the window's
  to leave out, as the window's cards do), so the step before them shows.
  it rolls in
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
- **the layout: no line is ever under a key** (the ios app's composerrow). one
  line of words sits between the plus key and send, inset clear of both (52 px,
  and send's own width, 104 px while it is worded). a second line, a wrap at
  that room or a return, puts the words the window's full width with the plus
  and send on a row of their own under them, in the corners, as the claude and
  chatgpt apps do. the wrap is measured by an unseen ruler of the words at the
  one-row inset (`.cz-ruler`), on each keystroke and when the width changes, so
  the shape never flips back and forth at the width in between. the keys move
  to their row on the snap spring (`flip`) and the words glide sideways from
  their inset; the window's height changes at once, since only transform
  animates. the sheet's words stand two lines tall over the keys, so there the
  third line is the one that stacks; the full stage is always stacked. the
  words grow to six lines, or fewer when the screen above the keyboard cannot
  hold the whole composer with six (the largest type, a short landscape
  screen): whole lines, read from the visual viewport on focus and on its own
  resize events, so the last line in sight is whole and the keys stay above the
  keyboard.
- **send's word.** a disc with an arrow when it sends; it opens by clip
  into a worded pill for queue, steer, answer, run (a `!` line), start and
  ask (a btw, see btw mode).
- **the queue is one strip** (`queue.tsx`; the ios app's decision 23). a card per
  message stacked above the window took 330 px of a phone's thread at three, and
  the daemon's provisional message drew a bubble in the transcript beside it. now
  a message on its way has one place until it lands: a 52 px strip above the
  window showing one message (one that did not go first, else the first in
  line, `leadOf`) with its label and when it goes on the first line ("steer, at
  its next step", "next, after this turn", `cardWhen`), its words (or, for one
  that did not go, what went wrong) on the second, "+N" for the ones behind and
  their edges peeking 4 px over its top (two at most, the room for both kept
  whatever waits, so a second message moves nothing). on the strip: retry and
  edit on one that did not go, steer now and run now from 700 px up, and the
  cross that unsends. a swipe left past 96 px (or a fling half as far again)
  unsends, the strip following the finger by transform and saying "unsend"
  under it; a long press on touch, a right click or the context menu key opens
  every verb as a menu. a tap opens every message with its verbs (the cards
  below) in a list that floats over the thread as the plus menu does, the
  composer's width on a phone and 440 px wide from 700 px up, so nothing under
  it moves; escape or a press outside closes it. the strip is the lead
  message's element, so it is what flies into the thread when that one lands.
- **the first queued card** in the list carries steer now and run now on a row
  of its own, so its text keeps the width at 390; the others carry unsend, and
  edit while the draft is empty.
- **edit on a waiting message** takes it back into the empty draft with the
  caret in its words: an unsend named for what it is for, offered on the list's
  cards and in the long press while the draft holds nothing (a draft with words
  has no room for them). one that did not go keeps its own edit, back to the
  draft with its photos.
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
  people were converting by hand. conversion is cmx2's (AGENTS.md, cmx2; ask a30), so
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
    | the outbox and the drafts together | 72 mb of data url | three messages at the limit (AGENTS.md, memory and latency). the composer asks before it takes a photo (every draft's photos and every unsent message's, `noRoomFor`). the sender holds the same cap for real: a message that would pass it does not take its photos into the outbox, they go straight back to the draft they came from (`returned`), and the message stays as a failed card with its words alone, which says so ("its photos are back in the draft. edit it back there too, and send it when the others have gone") and is not offered a retry (that would send the words without them). a person does not meet this (the composer asks first); it is the backstop for another tab. a data url string per photo in memory, in indexeddb and in a worker message, so it is the bytes this device spends on photos nobody has received |
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
    decoder would be a dependency (AGENTS.md, dependencies) and megabytes of script for a
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
  - **a draft's photos are read when its composer opens.** a launch read every
    draft's photos and posted them to the ui, so each draft held up to 24 mb in
    the worker and again in the ui's store for the life of the page, shown or
    not. now the words record says how many photos the draft keeps and their
    size (`held`), boot reads the photos of the thread the url opens and no
    other, and a composer asks the worker for its draft's as it opens (as does
    an open of its thread, a few frames ahead of the stage); the worker reads
    the one record once and keeps it as it keeps a set an edit sent. what counts
    photos before they are read (the device's 72 mb, a place holding a draft)
    reads the count; a send, a new set, or photos handed back (`returned`) wait
    for the read, so they join the draft's photos and never replace them. a
    read that fails leaves the photos on the device as they are: an edit keeps
    the count and writes only the words, a send says "its photos could not be
    read, so it did not go. send it again", a draft is not moved to another
    place without them, and emptying its words lets photos that cannot be read
    go, so a record that cannot be read never holds its place. the reading is
    its own chunk (`app/src/sync/draft-photos.ts`), loaded only when a draft
    has photos to read, so the first load carries none of it.
    words written before the count existed read their photos at boot as before,
    until the next edit writes it. tested in `cache.test.ts` (what boot reads)
    and `sender.test.ts` (one read, an edit during it keeps the last word).
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

### btw mode (2026-10-22)

a btw is a side question about the thread, answered from the session's
context with no tools and never put into the agent's context
(`thread.md`, btw). the composer asks it. rules in
`app/src/ui/btw/mode.ts`, tested in `mode.test.ts`.

- **offered** only on a thread whose agent answers btws
  (`capabilities.btw`) and only in the bar under it: not the sheet, never a
  new thread (there is no context to ask about). where it is not offered no
  entry point shows: no slash row, no plus row, `/btw ` is plain words.
- **entering.** `/btw` followed by a space (or a tab; a new line after it
  is kept as the question's) as the first thing in the draft, typed or
  pasted: the prefix is eaten and what follows is the question. the slash
  menu's first row, "btw", where it is offered. the plus menu's "btw" row
  ("ask on the side. the agent won't see it"). the draft holds the mode
  (`Draft.btw`), so it survives a reload as the words do.
- **leaving.** a tap on the chip; backspace with the caret before the first
  word and nothing selected (the chip is what it deletes, the words stay);
  a send that went. nothing else leaves it.
- **what it looks like.** a "btw" chip before the words, the accent's fill
  in a pill, the words' first line indented for it so a long question wraps
  under it as text would. the window wears the citron (`design.md`, colour:
  the btw exception) for as long as the draft is a btw, with a dashed inner
  rule, the card's rail. the placeholder reads "ask on the side. the agent
  won't see this"; send reads "ask". the words are named "btw about
  <thread>, the agent won't see it".
- **no model or effort in btw mode.** a btw runs on the thread's own model
  and settings, which keeps it on the prompt cache, so a pick there would be
  meaningless and misleading: the model and effort chips and the dial are
  not drawn while the draft is a btw. the top row keeps its one height (the
  composer's law: nothing appears or goes on focus) and holds one short line
  in the chips' place, "on this thread's model, no tools", which says what
  answers it and fits on one line at 390 px. a pick made before entering
  stays in the draft for the next message.
- **sending.** send, return on a keyboard and ⌘return all ask: a btw is
  never queued and never a steer, and hold to steer does nothing. it works
  idle or mid-turn and while the agent asks (the words do not answer the
  question in btw mode). the worker asks (`askBtw`); the card is in the
  thread before the stream's echo. the draft empties and the mode ends,
  keeping a model or effort pick that has not gone.
- **words only.** a btw carries no photo or file. photos in the draft stay
  in it, and a send says "a btw takes words only. remove the photos and
  files, or leave btw to send them to the agent" in the problem line.
- **failure** keeps the draft and the mode and says the worker's words in
  the problem line (they say what happened and what to do). asking the same
  draft again carries the same client id, so an ask that landed while its
  answer was lost is not asked twice.
- **a btw draft is never a message.** the draft's flag is the mode, offered
  here or not: a btw draft restored before the thread's read lands (or on an
  agent that no longer answers btws, or a thread with no turn) keeps its
  chip and tint, and its send says "a btw can't be asked here yet. wait for
  the thread to load, or tap btw to send it to the agent instead"
  (`btwSendBlock`). photos in a btw draft are named before anything about
  reading them.
- **after an ask lands** its draft goes on the thread it was asked from,
  whichever thread is open now; words typed into it during the ask stay as
  the next question (`askedDraftGoes`).

## voice, files and assistants (2026-10-15)

the composer under an assistant's thread is today's composer in the
assistant's palette (the approved screens): the window, the line, the
chips, the plus key. what changes is gated on the agent's capabilities by
name (`design.md`, agents: who a window belongs to), never on its
runtime, so a cmx thread's composer is exactly what it was.
on the web the mic key, the recorder and the thinking chip are built as
standalone pieces (`app/src/ui/assistant/voice/voice-composer.tsx`,
`thinking.tsx`; ladle group `assistant-composer`) that the composer takes
when the app's protocol 3 store is wired.

### the chips

- **the model chip** shows when the agent declares `model`, as today.
- **the thinking chip.** the chip beside it is the agent's `reasoning`:
  its `word` is the chip's word ("effort" for cmx, "thinking" for an
  assistant), the meter has one bar per entry in `levels`, and a press
  opens today's dial over those levels, named by the agent ("off",
  "minimal", "low", "medium", "high"). a pick is the thread's from the
  next message on, as effort is today; how the agent applies it is the
  source's (`docs/openclaw.md` sets it on the session before the send,
  not as a one-turn override), so the chip always shows the thread's own
  level, never a per-message one. an agent
  without `reasoning` has no chip and the model chip takes the row's
  room.
- **the placeholder** names who reads it: "message <name>" under an
  assistant (idle), "queue a message" while it works, as today; "reply"
  stays cmx's.

### the mic key

- with `voice` (`notes`), the round key at the right of the words is the
  **mic** while the draft is empty (no words, no attachments) and send
  the moment it is not. the two cross in the fade curve in one 44 px box,
  so nothing moves. without `voice` the key is send, as today.
- the mic is quiet at rest (the plus key's material, the first ink), not
  in the accent: send is the primary, and a mic in the accent beside an
  empty field would read as the thing to press.
- dictation still works in the words (the keyboard's own mic), and still
  has no state of its own.

### recording

| state | how you get there | shown |
|---|---|---|
| asking for the microphone | the first press, ever, on this device | nothing of boxbox's own: the platform's prompt. the press does not record; a granted prompt leaves the composer as it was, and the next press records |
| refused | the platform says no, or the permission was turned off | the composer's line says "boxbox cannot use the microphone. turn it on in settings, then try again." (in a safari tab: "allow the microphone for this site in safari's settings, then try again."); the mic key stays, and a press says it again |
| no microphone | the device has none, or the web has no `MediaRecorder` | the mic key is not offered; send is the key |
| holding | press and hold the mic key | the recorder: the red dot, the timer (`0:09`, mono 15 px 600 tabular), the live waveform on the top row; "slide to cancel" with a chevron where the words were; the key grown, filled with `--rec`; the lock capsule above it; the plus key stays, dimmed and inert. the header's live line says "<name> · listening" |
| sliding to cancel | drag left while holding | the words follow the finger and fade as they near the cancel line (120 px, or a third of the composer's width, whichever is less) |
| cancelled | release past the cancel line, or `esc` | the recording is dropped from memory at once; the composer returns to its empty state. nothing is sent and nothing is kept |
| locking | drag up while holding | the lock's track fills with the drag |
| locked | release past the lock line (72 px up), or a tap on the lock, or `⌘⇧m`, or a tap on the mic by a screen reader or a pointer that cannot hold (the web with a mouse: a click locks at once) | the recorder stays without a finger: "cancel" (a word) where "slide to cancel" was, and send (the arrow on the accent) as the key |
| sent | release the hold short of both lines (a hold under 600 ms is a tap, below), or send while locked, or `return` while locked | the note goes as a message (`audio`, `flavour: voice`, with its `durationMs` and 64 peaks), into the thread as your voice bubble, faded until it is acknowledged, as any send; while the agent works it queues as a message would |
| too short | a hold released before 600 ms | nothing is sent; the line says "hold to record, or tap the lock to record hands free." for 4 s |
| near the cap | 60 s before the cap | the timer carries "1 min left" after it in the second ink |
| at the cap | 15 minutes, or 12 mb, or the agent's `attachments.maxBytes` when less | the recording stops by itself and stays locked, not sent: "this is as long as a voice note can be. send it, or cancel it." |
| interrupted | a call, another app taking the microphone, the page hidden on the web | the recording stops and stays locked with what it has, "recording stopped when another app took the microphone." the note is never sent by an interruption |
| send failed | as any send | your voice bubble says "not sent" with retry; "back to draft" returns the note to the locked state, not to the words |
| not confirmed | the gateway's receipt says neither yes nor no | the bubble says "not confirmed: <name> may not have it." with "send it again"; boxbox never resends by itself (`thread.md`, a send that is not confirmed) |

- **a voice note is a message.** it takes the composer's whole send:
  quote, attachments, and words cannot ride it (a voice note goes alone,
  as on every messenger). a reply strip that is open when you record
  quotes the note to what it replies to.
- **what is captured** is encoded as it goes (`design.md`, buttery: the
  buffers): opus in webm or ogg where the browser records it, aac in mp4
  where it does not (safari), and aac in m4a natively; the upload says
  its kind, and what reaches the agent is the server's business
  (`docs/agents.md`, the upload: it transcodes to what the agent takes).
  a transcript is made on the device where the platform can do it there
  (native, on-device speech recognition, never a server), and rides the
  part as `transcript`; the web makes none.
- **the audio session** (native) is taken for recording only while the
  recorder is open, and given back with playback ducked, never left
  holding the microphone. starting a recording stops any note playing.

### the reply strip

- with `quotes`, a swipe right on any message (yours or the agent's
  words, a voice note, a card) past 64 px opens the **reply strip** above
  the composer: a glass tab the composer's width less 8 px a side, 52 px
  tall, its top corners round (22) and its foot joined to the composer.
  it holds a reply glyph, a 3 px rule in the accent, the author ("<name>"
  or "you") 12.5 px 650 in the accent over one line of the message's
  words 13.5 px in the second ink (a voice note's is "voice note 0:22",
  its duration from the quote's `durationMs`, or "voice note" without one;
  a card's its file name), and a 26 px round close.
- on the web with a fine pointer the swipe is a **reply control** at the
  row's end, shown on hover and on focus within the row (under `(hover:
  hover)`), and `r` on a focused row. every platform has "reply" in the
  row's long-press menu as well, so it is never a gesture alone.
- the strip lives in the draft: it is saved with it, survives a relaunch,
  and goes with the send. `esc` or the close takes it away. replying to a
  second row replaces the first. the words take focus when it opens
  (not on touch, where focus would raise the keyboard uninvited).
- the strip rides above the queue's cards and below the pinned line; the
  dock's height grows by its 52 px on the snap spring and the transcript's
  bottom stays anchored.

### attachments: any file

- with `attachments`, the plus menu's first rows are **add a photo**
  (the photo library, as today) and **add a file** (the platform's file
  picker; the web's `<input type=file>`, native's document picker), each
  offered only when the agent's `kinds` take something of that sort. a
  drop onto the composer and a paste of a file do the same on the web.
- **a file in the draft** is a tile beside the photos' thumbnails: its
  type tile, its name cut in the middle ("booking-con…firm.pdf") and its
  size, with remove. a message takes the agent's `maxCount` and
  `maxBytes`, under boxbox's own outbox cap; photos are clamped as today,
  files go as their own bytes.
- refused before it goes, with the words saying what and what to do,
  every number the agent's own `maxBytes` and `maxCount`: "<file> is 31
  mb. <name> takes files up to <maxBytes>.", "<name> does not take .zip
  files.", "<name> takes <maxCount> files on a message. this one did
  not fit.". uploading, a determinate ring; failed, a red edge and "the
  upload stopped. tap to try again." (`thread.md`, pictures and files).
- **cmx2** takes files: its `attachments.kinds` add `application/pdf`,
  `text/*` and `application/json` to the photo kinds (`wire/capabilities.rs`),
  which is what cmx2 reads from a file part's bytes (its `parts.ts`): a pdf
  whole for a model that reads documents and as its extracted text for the
  rest, a text or json file put into the message whole as `<file
  path=...>`. a file goes beside the photos on the same routes, as
  `files: [{mime, filename, url}]` (`http/compose.rs`, `Document`), and the
  server holds it to the same numbers as the composer: a pdf at most 9 mb
  (under the 20 mb cmx2 hands a model whole, and two fit the message), a text
  or json file at most 512 kb (cmx2 puts all of it in the message, so this
  keeps one file from filling the model's context, about 130,000 tokens),
  photos and files 4 on a message and 18 mb together. the kind goes by the
  name's extension first (a mac calls markdown `text/markdown` and another
  system calls it nothing; a browser calls `.ts` a video), then by the
  browser's type; a `.env` or `.env.*` is never one, whatever kind the
  browser gives it, so a secret is not sent by a stray drop. a text file
  whose first 8 kb holds a zero byte is a binary file with a text file's
  name, and refused, as is one that is not utf-8 (cmx2 decodes it as
  utf-8; the server checks it too). a file goes by its name after the last
  slash or backslash, at most 255 characters, with no quote, angle bracket,
  control or format character: cmx2 writes the name into `<file
  path="...">` unescaped, and a bidi override would hide what it says. the
  composer refuses such a name before a byte is read, and the server
  refuses it again. the daemon echoes a sent pdf whole (up to 12 mb of data
  url), so the worker keeps a non-image file part's name, kind and size and
  lets its url go (`reducer.ts`, `slimPart`); images keep theirs. in the draft and the outbox a
  file rides in the photos' list as its own bytes with no dimensions (one
  cap, one record, one hand back), and the request splits it out by kind.
  uploading and failed are the message's, on its card, as a photo's are; the
  card counts them apart ("2 photos, 1 file").

### start something with an agent

- **the agent row** takes the place row's spot at the sheet's head (the
  machine was a choice inside the place row; it is now the agent): a 54
  px row pressed into the sheet, the
  agent's mark (33 px: square with the machine's initials for cmx, round
  in its palette for an assistant), the agent's name (16.5 px 600) and
  under it its runtime and machine ("on vm-a" for cmx, "openclaw · vm-b"),
  with a chevron. the sheet's colour follows the agent: an assistant's
  palette, or for cmx the repo picked below it.
- **the picker** opens under the row as a deeper card of the window
  plane, rows 48 px: every cmx agent, one per machine (square marks, "cmx"
  and the machine), a hairline, then every assistant that declares
  `threads` (round marks, the name and "openclaw · vm-b"), the chosen one
  carrying a check. an agent that is not answering, or still waiting for
  approval on its gateway, is listed dim with that in its second line and
  is not a choice. arrows walk it, return takes one, `esc` closes it.
- **with cmx chosen**, the place row follows (the repo chips and the
  folder finder, `places`) and the worktree toggle (`worktree`), as
  today.
- **with an assistant chosen**, there is no place row and no worktree
  toggle, because the agent declares neither: the composer follows the
  agent row directly, its placeholder "message <name>", and one line
  under it in the second ink: "<name> starts a new thread on vm-b." the
  first message makes the thread (`docs/agents.md`), and the stage opens
  on it as today.
- an agent without `threads` is not in the picker; its one thread is
  opened by the dock when its window is in view (`home.md`).
- the sheet opens on the agent of the window in view, as it opens on its
  repo today.

### web and native

| | web | native (boxbox-ios) |
|---|---|---|
| capture | `MediaRecorder` on a `getUserMedia` stream, chunks every 1 s into the recorder's capped buffer; the live levels from an `AnalyserNode` read once per 100 ms | `AVAudioRecorder` (aac, m4a) with metering read once per 100 ms |
| hold, slide, lock | pointer events with capture on the key; a mouse click locks at once (holding a mouse button while sliding is not a web idiom) | a long-press recognizer that tracks the finger; the lock and cancel lines with a haptic tick each |
| keyboard | `⌘⇧m` records locked, `return` sends, `esc` cancels; `r` replies to the focused row | the same with a hardware keyboard |
| reply | the hover reply control and `r`; swipe on touch | swipe right; the context menu |
| files | `<input type=file>`, drop, paste | the document picker, the photo picker, paste |
| transcript | none made here | on-device speech recognition |

the mic needs `MediaRecorder`; a browser without it never offers the key.

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

`perf.send` carries the voice note and file verbs too (`what: voice`,
`what: file`), with the bytes and the post's time. `perf.record`
(2026-10-15, `design.md`, buttery) is emitted per recording: the press to
the recorder painted, the press to the first sample, the bars' main
thread time, and how it ended (`sent`, `cancelled`, `cap`, `interrupted`,
`refused`), with its length in seconds; never a word of what was said.
