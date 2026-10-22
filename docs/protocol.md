# the device protocol (protocol 3)

this is the spec of the one wire between the boxbox server and its
devices: the web app, the board, and later the ios app. it replaces
contract 1 and the contract 2 plan (decisions 25, 36 and 37 are
superseded by the owner's round three decisions D1 to D7). three
writers build from it in parallel: the server, the web app and the
board. section 18 splits the work into packages and says the order they
merge in.

what it is for: a device gets only what it shows (interest), only what
changed (patches), each finished text once, a short catch-up after time
away, and nothing at all for a server restart. anything this file does
not change keeps today's behaviour: same pixels, motion, text, state,
accessibility tree and cached data.

what it does not cover: the verbs (sends, answers, pty, review, models,
machines), which keep their routes (the owner's q2 answer); push and presence,
which are unchanged; how the screens look (`design.md`).

the shapes are contract 2's neutral types (`server/src/wire/`, described
in `agents.md`, the neutral wire), with the additions named here. no
source object crosses raw, except a tool call's `input` and `metadata`,
as contract 2 already says.

## 1. words

| word | meaning |
|---|---|
| journal | the server's ring of changes, each encoded once as the exact bytes every stream receives |
| entry | one journal change, with a `seq` and an sse `id` |
| control frame | a frame that is not a journal entry: `hello`, `reset`, `caught`, `interest`, `catchup`, `thread.stale`, colours, board frames |
| overview | every entry that is not a transcript entry: agents, threads, asks, order |
| transcript entry | `message`, `part`, `delta`, `message.removed`, `reactions` |
| interest | the threads a stream gets transcript entries for: the open thread (the stage), the layers under it, and the children it holds |
| `left` | per thread the client holds, the seq after which it lacks that thread's transcript entries: set when the thread leaves interest or the stream drops, kept in the thread's `#head` record |
| batch | the frames one actor step hands a stream, plus whatever else is already queued for it, up to 64 KiB of raw frame bytes |
| version | per thread, the seq of the newest transcript entry for it (`v`) |
| rewrite version | per thread, the seq of the newest transcript entry that touched a message older than its newest turn (`rv`) |

## 2. transport

**the stream.** `GET /api/stream` over https, behind the gate like
today, answering `text/event-stream` with `cache-control: no-cache` and
`x-accel-buffering: no`.

| query | meaning |
|---|---|
| `after=<epoch>:<seq>` | the cursor, for a client that cannot set `Last-Event-ID`; the header wins when both are sent (as today) |
| `thread=<key>` | the open thread; absent means none (the overview only) |
| `under=<key>,<key>` | the layers under the stage, at most 8 |
| `holds=<key>,<key>` | the children held for the stage and its layers, at most 16 |
| `since=<key>:<seq>,<key>:<seq>` | for each interest key the client already holds, its `left` (section 5) |
| `board=1` | a desktop window that would show the board's digits (as today) |
| `view=board&device=<id>&addrs=<list>` | the board daemon declares the board view (section 5, the board) |

`colours=1` goes: every stream except the board's gets the repo colour
frames.

**gzip (D2).** a request that sends `accept-encoding: gzip` gets
`content-encoding: gzip` and `vary: accept-encoding`. each connection
has its own deflate stream (level 6, window 15, memory level 8: 256 KiB
of state), and the server writes a `Z_SYNC_FLUSH` after every batch and
after every heartbeat, so a frame never waits in the compressor. the
browser inflates natively; the app's 32 MiB frame cap counts inflated
text, as today. without the header the stream is identity (tools,
tests). at most 64 gzip streams at once; past that a new stream is
identity and the server logs it once. the 512 KiB outbound cap still
counts raw frame bytes queued for the stream (before compression), and
a stream past it is closed as today.

**batches.** the stream drains every frame already queued (up to 64 KiB
raw) into one write, then flushes. this is also what makes one tls
record per batch instead of one per frame.

**heartbeat.** `: hb` every 15 s, as today; readers still abort after
45 s without a byte.

**json answers.** every `application/json` answer over 512 bytes, or of
unknown length, is gzipped when asked (`http/compress.rs`, as today);
the thread reads (section 11) are json the server writes as it streams,
so they are compressed too. no brotli.

**upstream.** the cmx2 watcher subscribes
`/global/event?coalesce=100&types=<the consumed kinds>&compact=1&gzip=1`
with `accept-encoding: gzip` (section 14). every cmx2 rest read sends
`accept-encoding: gzip`. the 8 MiB upstream frame cap counts inflated
bytes.

## 3. frames

each frame is an optional `id: <epoch>:<seq>` line, `data:` lines
holding one json object (one `data:` line per line of the json, as
`sse_frame` does today), and a blank line. the object's `type` names it.
journal entries put `seq` first. a client skips a type it does not know
and still advances its cursor past it.

### control frames

| type | id line | fields | when |
|---|---|---|---|
| `hello` | none | `protocol: 3`, `epoch`, `head`, `build`, `stream` (128-bit hex, for interest posts), `interest: {thread, under, holds}` | first frame of every stream |
| `reset` | `epoch:seq` | `seq`, `epoch`, `reason` (`none`, `epoch`, `expired`, `invalid`), `fleet: {agents, threads, asks, order}` | the cursor cannot be caught up (section 9) |
| `caught` | `epoch:head` | `seq` | the end of a catch-up; the stream is live after it |
| `catchup` | none | `entries` (transcript entries, each with its `seq`), at most 256 KiB raw a frame | ahead of the `interest` frame they belong to (section 5), or before `caught` in a reconnect catch-up (section 9); applied by the transcript rules, never moving the cursor |
| `interest` | `epoch:seq` | `ask`, `thread`, `under`, `holds`, `seq`, `stale?` (keys), `reset?` (keys) | the confirm of an interest post (section 5) |
| `thread.stale` | none | `key` | in a reconnect catch-up: a thread in interest whose missed transcript entries the ring no longer holds (section 9) |
| `colours`, `colour` | none | as today (`RepoColour`) | the whole map after `hello`, then each change ahead of the entry that first shows its repo |
| `board.here`, `board.gone`, `board.focus`, `board.compose` | none | as today | windows with `board=1` on the board's mac |
| `view`, `pin`, `replaced` | none | the board wire's frames, unchanged | board daemon streams only |

a client whose `hello.protocol` is not 3 stops: the web app asks to
reload as today (an installed contract 1 app reloads into this one), the
board says so on its keys, the ios app stops until it is updated
(accepted, D1).

### journal entries

| type | fields | kind |
|---|---|---|
| `agent` | `agent: Agent`, whole | overview |
| `agent.removed` | `agent` | overview |
| `thread` | `thread: Thread`, whole | overview |
| `thread.patch` | `key`, `set?`, `unset?`, `tail?` (section 6) | overview |
| `thread.removed` | `key` | overview |
| `thread.reset` | `key` | overview: every stream gets it |
| `ask` | `ask: Ask` | overview |
| `ask.settled` | `AskSettled` | overview |
| `order` | `keys`, whole, at most 300 | overview |
| `order.patch` | `ops` (section 7) | overview |
| `message` | `key`, `upstream`, `message: Message` | transcript |
| `part` | `key`, `upstream`, `part: Part` (a settled text part may omit `text`, section 8) | transcript |
| `delta` | `key`, `messageID`, `partID`, `field`, `delta`, `offset` | transcript |
| `message.removed` | `key`, `upstream`, `messageID` | transcript |
| `reactions` | `key`, `messageID`, `reactions` | transcript |
| `btw` | `key`, `upstream`, `btw: AgentBtw`, whole, replacing the last (section 8, btws) | transcript |
| `btw.delta` | `key`, `btwID`, `delta`, `offset?` (utf-16 units into the answer; absent when the server does not know it) | transcript |

`host`, `host.removed`, `host.reset`, `session`, `session.removed` and
`agent.reset` do not exist in protocol 3. a reconnect to a source is
never a reset on the wire (section 10, the quiet re-read).

### a frame that cannot apply

a `thread.patch` for a key the client does not hold, a `tail.put` index
past the tail's length or a tail longer than 12, an `order.patch` op out
of range, a `catchup` or `interest` frame that does not parse: each is a
protocol error. the client checks the whole frame before it changes
anything, never applies part of one, counts it (`sync.fault`, section
16), drops its cursor and reconnects, which gets a `reset` with reason
`none`. a well-behaved server never causes one; the replay tests
(section 16) fail on any.

### shapes beyond contract 2

contract 2's types as written in `server/src/wire/` and `agents.md`,
plus every field the web app reads today that they lack. found so far
(the app protocol package finishes the audit by grepping every cmx2 field
`app/src/ui` reads, and the server package adds each by name):

- `Thread.tokens?: {input, output, cacheRead, cacheWrite}`: the details
  panel's tokens tile and cached share read `info.tokens`
  (`details.tsx:223-229`), so the contract 2 table's "nothing reads
  tokens" is wrong.
- `Message.summary?: true`: an assistant compaction summary
  (`model.ts:577-581`).
- `Message.error.name?`: the turn status reads `MessageAbortedError`
  (`model.ts:587-592`).
- the assistant message's model and effort as the turn reads them
  (`modelID`, `variant`, `model.ts:584-586`) in `Message.model` and
  `Message.effort`.

### examples

```
data: {"type":"hello","protocol":3,"epoch":"3f9a0c21b7d4","head":48211,"build":"0.9.0","stream":"9c1f0e7a5b2d4c66a1e3f00b7d2c9a41","interest":{"thread":"vm-a:ses_2","under":[],"holds":[]}}

id: 3f9a0c21b7d4:48212
data: {"seq":48212,"type":"thread.patch","key":"vm-a:ses_2","set":{"activity":{"state":"busy","since":1792053343196},"updated":1792053343196},"tail":{"drop":1,"put":[[11,{"partID":"prt_2_9_0","messageID":"msg_9","kind":"text","role":"assistant","text":"reading the config"}]]}}

id: 3f9a0c21b7d4:48213
data: {"seq":48213,"type":"delta","key":"vm-a:ses_2","messageID":"msg_9","partID":"prt_2_9_0","field":"text","delta":" first, then the tests.","offset":18}

id: 3f9a0c21b7d4:48230
data: {"seq":48230,"type":"part","key":"vm-a:ses_2","upstream":5531,"part":{"type":"text","id":"prt_2_9_0","messageID":"msg_9","at":{"step":9,"index":0},"time":{"start":1792053343210,"end":1792053345002},"textOf":{"length":41,"hash":"1c0e9b7f"}}}

id: 3f9a0c21b7d4:48231
data: {"seq":48231,"type":"order.patch","ops":[["-",4,1],["+",0,["vm-a:ses_2"]]]}

data: {"type":"catchup","entries":[{"seq":48236,"type":"delta","key":"vm-a:ses_7","messageID":"msg_4","partID":"prt_7_4_0","field":"text","delta":" and the build passes.","offset":112}]}

id: 3f9a0c21b7d4:48240
data: {"type":"interest","ask":3,"thread":"vm-a:ses_7","under":["vm-a:ses_2"],"holds":["vm-a:ses_8"],"seq":48240,"stale":["vm-a:ses_8"]}

id: 3f9a0c21b7d4:48240
data: {"type":"caught","seq":48240}
```

## 4. ids, epoch and seq

- **keys** are contract 2's: an agent key, and a thread key
  `<agent>:<thread>`. a cmx2 thread's key is `<host>:<session id>`, as
  today.
- **the epoch** is 12 lowercase hex. it is minted once, when the
  server's data directory holds no usable stream state, and persisted
  (section 10). a clean restart and a crash keep it. it changes only when
  the persisted state is missing, unreadable, or fails its check at
  start, and then every device gets `reset` with reason `epoch`.
- **seq** is a u64, contiguous in the journal within an epoch, below
  2^53 so javascript holds it exactly. after a crash the head jumps
  forward to the reserved mark (section 10): the seqs in between were
  never issued.
- **a stream shows a subsequence of the journal.** a stream skips the
  transcript entries of threads outside its interest, and nothing else
  (overview entries reach every stream except the board's). so the
  client's rule is: an entry whose seq is at or below the cursor is a
  duplicate and is dropped; any higher seq applies and moves the cursor.
  **a skipped seq is never a gap.** today's "a seq past cursor plus one
  reconnects" rule (`reducer.ts:424-429`) goes.
- **why no gap check is lost.** within one connection frames arrive in
  order and whole (tcp). across connections the server resumes exactly
  from the cursor (section 9). what a skipped seq can hide is only a
  transcript entry of a thread outside interest, and the client never
  trusts such a thread as current: it holds it cold or stale, and makes
  it current only through a read or a catch-up from its `left`
  (section 5).
- **the cursor** is the id of the last frame with an id line: an entry,
  `reset`, `interest` or `caught`. the last two carry the head at that
  moment, which is safe because everything the stream needed up to it
  was delivered. this also keeps a home device's cursor near the head
  while the journal is mostly transcript entries it skips.

## 5. interest (D4)

### what is in it

a stream's interest is the open thread (the stage, `thread`), the
layers under it (`under`, at most 8: a covered layer stays in interest so
it is current the moment the stage above it closes), and the children
held for any of them (`holds`, at most 16). the overview reaches every
stream whatever its interest. the stream map (stream id to its interest
and queue) is owned by the fleet actor and loses the entry when the
stream ends.

### declaring

- **at connect**, in the query: `thread`, `under`, `holds`, and `since`
  with the client's `left` for every one of those keys it already holds.
  the server treats them exactly as a post with `H = hello.head`: a key
  with `since` gets the catch-up of section 9 from its `since`; a key
  without one is read by the client under the no-gap rule with
  `H = hello.head`. when the connect answers a `reset` instead, `since`
  is ignored (section 9).
- **after**, by `POST /api/stream/{stream}/interest`, where `stream` is
  the id from `hello`:

```
{"ask": 4, "thread": "vm-a:ses_7", "under": ["vm-a:ses_2"], "holds": ["vm-a:ses_8"],
 "since": {"vm-a:ses_7": 48190}}
```

  `ask` increases per stream. `since` gives, for a key the client already
  holds, its `left`. a key without `since` is one the client will read.
- **one post a turn.** the page tells the worker what it shows one
  message at a time (opening a thread with five agent children is an
  open, a show and five holds), and each message is its own worker task.
  the worker does not post per message: a change marks a post due, and a
  `setTimeout(0)` started by the first one posts the interest as it
  stands once the messages queued with it have run. it posts nothing when
  that interest is the one the server applies, or will apply once the
  newest post out is taken (sets compared, not lists: a child released
  and held again asks for nothing new). so every ask posted is sent, and
  a turn that ends where it began (a thread opened and closed again)
  posts nothing. a read of a key entering interest waits from the
  change, before the post goes, until its confirm.
- answers `202`; `404 no-such-stream` when the stream has ended (the
  client reconnects with the interest in its query); `400` for more than
  8 layers or 16 holds or a malformed key; only the signed-in session that
  opened the stream may post to it (else `404`).
- **order.** two posts can reach the actor out of order (two requests on
  one http/2 connection). the actor applies a post only when its `ask` is
  above the last one it applied for that stream, and answers an older one
  `202` with no confirm. the client processes every confirm it gets, in
  stream order, not only the one of its newest `ask`: for each it sets
  `left` for the keys that confirm took out and applies that confirm's
  catch-up, `stale` and `reset`. a key that left at one confirm and
  is back at the next, entering without `since` (the second post went
  before the first confirm came), is read under the no-gap rule with that
  confirm's `H`: the later confirm says nothing of the entries journaled
  between the two, so only the read covers them.

### `left`, exactly

the client keeps `left[key]` in the thread's `#head` record:

- when a confirm takes the key out of interest: `left = ` that confirm's
  `seq`;
- when the stream drops (error, pagehide, overflow) while the key is in
  interest: `left = ` the cursor at that moment;
- after a read accepted under the no-gap rule, or a catch-up applied:
  cleared while the key stays in interest.

a thread restored warm from indexeddb at launch keeps the `left` it was
saved with. a key the client holds with no `left` (an old record, a lost
value) is sent without `since`, so it is read. this closes every path by
which a thread could be trusted with a hole: a hidden spell, a switch, a
pagehide, a relaunch.

### the confirm

the fleet actor takes the post in its own order, at journal head `H`:

1. swaps the stream's interest. from here, transcript entries of the new
   set with seq above `H` reach the stream; those of keys that left stop.
2. for each key that enters with `since`:
   - a key whose persisted reset seq (section 10) is above `since` goes in
     `reset`: the client drops its messages and reads it;
   - else, when the ring still holds every entry of that thread after
     `since` and the running total stays under 1 MiB raw, the compacted
     entries (section 9's rule) go into `catchup` frames;
   - else the key goes in `stale`.
   a key the server does not know (a thread it never saw or has evicted)
   goes in `stale`; the client's read then answers `404` and the client
   drops the key.
3. hands the stream one block: the `catchup` frames (each at most
   256 KiB raw, id-less) and then the `interest` frame, `id: <epoch>:H`.
   the block travels on the stream's live channel behind every frame
   already queued, so it sits exactly where the filter changed. it is not
   counted against the 512 KiB outbound cap: it has its own cap of 1 MiB
   and one block in flight per stream. the stream task moves the block
   into its `pending` deque (the path replay pages and `reset` take today)
   and drains it before the next live frame. a post that arrives while a
   block is still unread is answered when that block is drained, and
   waits at most until the block is 30 s old, counted from when the
   actor handed it to the stream (a post that comes late gets no fresh
   30 s): a stream that has not read its block in 30 s is stalled, so
   the server closes it and answers the post `404 no-such-stream`, and
   the client reconnects with the interest in its query. a post waits
   for no block longer than that; one that meets a newer block after the
   one it waited for waits on the newer one's 30 s. a block drained as
   the wait runs out closes nothing.

the client applies `catchup` entries by the transcript rules alone
(upstream gate, offset rule, part replace). their seqs may be above or
below its cursor; the cursor rule does not apply to them and they do not
move the cursor. the `interest` frame's id then moves the cursor to `H`.
for every key that left, the client sets `left[key] = H`.

### no gap at a switch

a thread that enters without `since`, or comes back in `stale` or
`reset`, is read (section 11). every read answers
`x-boxbox-seq: <epoch>:<S>`, the journal head when the server started
that read. **the client accepts a read for a thread that entered interest
at `H` only if `S >= H`**; a read that started earlier is taken again
(counted, `sync.fault` `read-late`). why it holds: every entry the server
journaled up to `S` came from the source before the read was asked, so
the source's answer already reflects it, and the stream delivers every
entry of that thread after `H`. entries that overlap the read are dropped
by today's rules: `message`, `part` and `message.removed` by the upstream
gate against the read's `x-boxbox-upstream`, deltas by the offset rule.
while the read is out, the thread's entries wait in the hydration buffer
as today.

the app's order for opening thread B over thread A: post the interest
(`thread: B`, `under` gains A, on the turn's one post), open B in the store (it shows its cached
pages or the reading state, as today), start B's read when the confirm
arrives. A stays current underneath. when B closes, the app posts
`thread: A` with `under` less A: A was never out of interest, so it needs
no `since` and no read. a thread switched away from entirely (not kept as
a layer) leaves interest and keeps its `left`.

### hidden for 30 s

after 30 s with the document hidden, the worker posts
`{thread: null, under: [], holds: []}`: the overview only. on visible it
posts the stage, layers and holds with `since` from `left`. the catch-up
lands ahead of the confirm; a thread past the cap comes back `stale` and
reads its newest page (an etag revalidation when nothing moved). until
then the page shows the state it had, as it does after a resume today.
`pagehide` still closes the stream; `pageshow` reconnects with the
interest and `since` in the query. push and presence are unchanged.

### the board

the board daemon declares the board view:
`GET /api/stream?view=board&device=<id>&addrs=<list>` (its query today,
`board/wire/src/lib.rs:34-40`) with `accept-encoding: gzip`. it gets
`hello` (protocol 3), then the board frames `view`, `pin` and `replaced`
exactly as `/api/board/stream` sends them today: the server's projection,
a whole `view` only when it changed, at most every 250 ms. no journal
entries, no colours, no cursor, no catch-up: a reconnect seeds from the
next `view`, as today. a board stream takes no interest posts (`404`).
its verbs stay `POST /api/board/act` and `/api/board/pin`.
`/api/board/stream` goes. the daemon's change is the url, `PROTOCOL = 3`
in `board/wire`, and gzip (it already ignores `hello` beyond the protocol
check, `board/daemon/src/daemon.rs:351`).

## 6. thread patches (D1, D5)

the model keeps, per thread key, the last `Thread` it journaled. a
change to the key is journaled as:

- **`thread`, whole**, on first sight, after `thread.removed`, in a reset
  or catch-up, and as the first frame for every key after a crash start
  (section 10);
- **`thread.patch`** otherwise:
  - `set`: each top-level field whose value changed, with its new value
    whole (`activity`, `context`, `vcs`, `changes`, `place`, `origin`,
    `needs`, `read`, `sends`, `tokens` are small and go whole);
  - `unset`: optional fields that became absent (`cleared`, `cost`, ...);
  - `tail`: `{drop: n, put: [[i, item], ...]}`. drop `n` items from the
    front, then put each item at index `i` (replacing; `i` equal to the
    length appends). the result is at most 12 items and equals the
    server's tail exactly.
  - a change that changes nothing journals nothing. in the recording,
    758 of 1,990 whole session frames repeated the entry before them
    exactly [measured].

the patch is encoded once, in the actor, against the last state of that
key in the journal, and every stream gets the same bytes. a client that
applies the journal in order always holds that base; every other path
(reset, catch-up, crash start) sends the key whole first.

the patch bases are the in-memory copy of `stream_keys` (section 10):
one body per kept thread (at most 1,000), agent, open ask and the order,
evicted with the session as today. each carries a `whole` flag, set for
every key at a crash start (threads, agents, asks and the order alike)
and when the start check finds an encoder change (section 10). the flag
is persisted in `stream_keys` (written in the first batch after it is
set), so a key that does not change before the next restart, clean or
not, still goes whole first. it is cleared in memory when that key's
next frame, sent whole, is journaled, and in `stream_keys` by the batch
that carries that frame's state.

**the pace (D5).** a change whose only effect is streamed text growing a
tail item goes at most once per 500 ms per key (`TAIL_EVERY_MS` 200 to
500, `model.rs:80`): the latest state replaces the pending one, and the
actor's clock sends it when due. any other change to the key goes at
once and carries the pending text with it (today's `streamed`,
`flush_tails` and `journaled` rules, `model.rs:1362-1424`, with the new
number).

`agent` stays whole: a connection changes rarely and there are few.

## 7. order patches

`order` is the window order, at most 300 keys. it was 76% of the
recorded stream's bytes (845 whole lists, 8.42 MB of 11.08 MB
[measured]).

- **`order`, whole**, in a reset and a catch-up, and when the patch
  would be larger than the list.
- **`order.patch`** otherwise: `ops` applied in order to the previous
  list. `["-", i, n]` removes `n` keys at index `i`; `["+", i, [keys]]`
  inserts keys at index `i`. a move is a remove and an insert. the result
  equals the server's list exactly.

## 8. transcript entries

### text deltas in 100 ms batches (D3)

- the actor holds, per part, a pending delta: the offset of the first
  delta and the text of every delta after it whose offset chains
  (`offset == pending offset + pending length`, in utf-16 units). a delta
  that does not chain flushes the pending one and starts anew.
- a pending delta is journaled 100 ms after its first delta arrived, by
  the actor's clock.
- **before journaling any other entry** (a `part`, `message`, `ask`,
  `thread.patch`, anything that is not a text delta), the actor journals
  every pending delta, in the order their first deltas arrived. so a
  part's end, a tool step, an ask or the person's own action never
  overtakes the words before it, and goes at once. one thread's change
  flushes every thread's pending deltas: the journal has one order.
- cmx2 already merges at the source (`coalesce=100`), so for cmx2 this is
  mostly a no-op; it applies the same rule to every source.
- `field` is `text` for text and reasoning parts, as today. the offset
  rule on the client is unchanged (`reducer.ts:816-851`).

### finished text sent once (D7)

cmx2 sends a part's whole text again at part end and step end. the
server keeps, per streaming text or reasoning part, the utf-16 length
and an fnv-1a 32 hash of the text the deltas built: offset basis
2166136261, for each utf-16 code unit `h = (h ^ unit) * 16777619 mod
2^32`, written as 8 lowercase hex. it starts from offset 0, or from the
text of the last whole `part` it journaled for that part. when a part
update arrives:

- **same as the last state journaled for that part**, text included: not
  journaled at all (the step-end re-send). the same holds for a
  `message.updated` whose neutral `Message` equals the last one journaled
  for that message: cmx2 republishes the message and its parts at step
  end (`server/src/index.ts:1642-1665` in cmx2), and none of it is sent
  again.
- **its text has the built length and hash**: journaled with `text`
  omitted and `textOf: {length, hash}`. every other field is sent.
- **anything else** (no deltas seen, a different text): the whole part,
  as today.

the client, on a part with `textOf`: when it holds that part and its
held text has that length and that hash, it replaces every other field
and keeps its text. otherwise it re-reads that message
(`GET .../messages/{message}`, today's refetch, with later entries for
the message held meanwhile) and merges it as today. a client never
shows text it did not get: the fallback is always the server's copy.

every path that can hand a client a `textOf` part also hands it the
deltas before it: the live stream, the reconnect catch-up and the
interest catch-up keep the merged deltas a textless part needs
(section 9); a reset carries no transcript; a read carries whole text.

the tracking costs 16 bytes per streaming part, dropped at the part's
end (the first part update with `time.end`, journaled by the rule above
before it goes; the step-end re-send after it is caught by the part's
remembered digest, the unchanged rule), at most 4,096 parts (the oldest go first, and their next update is
sent whole). the last journaled `Message` per message, for the
unchanged rule, is kept for messages of the newest turn of each thread
(the same set as `rv`'s, section 11) and dropped with it.

### btws

a btw is a side question about a thread, answered by the agent's model
from the thread's context with no tools and never put into that context
(`agents.md`, the btw). the agent keeps it; boxbox holds no copy and only
journals what the source says, as transcript entries of the thread, so
they follow interest like messages.

- **`btw`** carries the whole `AgentBtw` `{id, question, answer, status:
  running|done|error, error?, afterMessageID?, created, completed?,
  dismissed?, promotedMessageID?, model?, tokens?, cost?}` and replaces
  the one held. cmx2 sends one when a btw is asked (answer empty), when it
  settles, is dismissed or promoted, when a promoted steer's provisional
  message id moves to the landed one, and again for every running btw
  where a resumed stream goes live.
- **`btw.delta`** is answer text, in order, batched with the part deltas
  (100 ms, the 1 MiB pending cap, flushed before any other entry; section
  8). cmx2's `btw.delta` has no offset, so the encoder counts one: per
  running btw the utf-16 length of the answer as journaled, set by each
  whole `btw` and grown by each delta, at most 1,024 btws (the oldest go
  first). a settled btw is no longer counted. a btw the encoder does not
  count (first seen by its deltas, past the cap, after a restart or a
  `thread.reset`) gets its deltas with `offset` absent.
- **catch-up** (section 9) keeps per btw its last `btw` and the deltas
  after it, merged while they chain; deltas without an offset merge into
  one.
- **versions:** a btw entry moves the thread's `v` and never `rv`: the
  whole read and the newest page carry the btws, older pages do not
  (section 11).
- **the client** (`app/src/sync/btw.ts`, `reducer.ts`) keeps
  `threads[key].btws`, a map by id, and merges every record by one
  monotonic rule, whoever sent it (the stream, a thread read, a reread, a
  verb's own answer): running moves to done or error and never back (a
  running record after a settled one changes only what sticks); while
  both run the longer answer stands; `dismissed` and `promotedMessageID`
  stick once any record carried them. a delta appends to a running btw's
  answer when its offset is the answer's length; a delta on a settled btw
  is ignored; a delta whose offset is absent, or does not meet the answer
  (a gap), rereads `GET T/btw` once per thread at a time, deltas met while
  it runs waiting for its answer. at most 64 btws a thread, evicting the
  oldest settled first, then the oldest running; their bytes count toward
  the thread's byte cap, and they persist as the thread's `<key>#btw`
  record (section 15a).

as D4 is written, a device with a thread open also gets every busy
thread's tail puts in the overview (about 400 B per 500 ms per busy
thread before gzip): home needs them, and every stream gets the same
overview bytes.

## 9. catch-up

### reconnect from a cursor

`hello` first, then:

1. **reset** when there is no cursor (`none`), it does not parse or is
   past the head (`invalid`), its epoch is not the server's (`epoch`), or
   it is older than the tombstone floor (`expired`, section 10). a reset
   ignores `since` for every key: the client reads its stage, layers and
   holds (after a reset, below), and a seq from another epoch never seeds
   a ring catch-up. the reset
   is one frame carrying `fleet: {agents, threads, asks, order}`, built
   from the journaled state (the encoder's patch bases and the journaled
   order, not the model's snapshot), so the patches after it apply to
   what the client holds; `GET /api/fleet` answers the same. it stays
   under about 256 KB raw for 300 threads. a reset carries no transcript.
2. **otherwise a compact catch-up**, every frame in seq order:
   - **overview, from the cursor.** for each agent, thread and open ask
     changed after the cursor, its current state as one whole frame
     (`agent`, `thread`, `ask`), with the id of the newest entry for that
     key. for each thread, agent or ask removed or settled after the
     cursor, its `thread.removed`, `agent.removed` or `ask.settled` from the
     tombstones. an ask raised and settled since the cursor is not sent;
     one raised and settled more than once keeps one tombstone with its
     first raise, so a cursor inside any of its raises is told it settled.
     `order` once, whole, if it changed. for each thread whose persisted
     reset seq is above the cursor, `thread.reset {key}` with that seq as
     its id (so a reset is never lost to a catch-up).
   - **transcript, per interest key, from its `since`.** the query's
     `since` (section 5) says where each key's catch-up starts; a key in
     interest without `since` gets nothing here and is read by the client
     (no-gap rule, `H = hello.head`). a `since` for a key outside
     interest is ignored; a `since` past the head, or for a key the
     journal does not know, gets `thread.stale`. a key whose persisted
     reset seq is above its `since` gets nothing else: `thread.reset {key}`
     when that seq is above the cursor (the overview above sends it), an
     id-less `thread.stale {key}` when it is at or below the cursor (a
     `thread.reset` with that id would be dropped by the cursor rule). a
     key whose entries after `since` the ring still holds gets them,
     compacted, in seq order, each keeping its own id and `upstream`
     (the client's upstream gate drops an entry at or below the last it
     applied, so an entry moved out of order could be lost). they ride in
     `catchup` frames, like an interest catch-up, because their seqs may
     sit below the cursor:
     - per message, its last `message`, and also its first after
       `since` when the last comes after one of its parts;
     - per part: its newest `part` that carries text, then the deltas
       after it merged into one (the first offset, the joined text), then
       its last `part` if that one has `textOf`; a part with no whole-text
       `part` since `since` keeps all its deltas merged into one, ahead of
       its last `part`. so a client that held the part's text at `since`,
       or gets it whole here, always holds the text a `textOf` needs;
     - `message.removed` drops every earlier entry of its message;
     - `reactions`, the last per message.
     a key whose entries the ring no longer holds, past the 1 MiB
     catch-up cap, or with one compacted entry over a `catchup` frame's
     256 KiB, gets `thread.stale {key}`. deltas merge only while they
     chain (each offset where the last ended).
   - `caught {seq: head}`, then live.

threads outside interest get nothing: the client already knows, from
`left`, that it lacks their entries since then, and reads them (an etag
revalidation) when they are shown again.

the client's state after a catch-up equals its state after replaying
every entry from the cursor to the head through its interest, except
that stale threads are marked to be read before they are trusted. a
catch-up is the size of what changed: at most the snapshot plus the
in-view transcript.

### thread.stale and thread.reset

- `thread.stale {key}` is per stream: this stream cannot give that
  thread's missed transcript entries. the client keeps the thread's
  cached pages, marks them stale, and reads the thread before it shows it
  as current (an etag revalidation when nothing it holds is behind).
- `thread.reset {key}` is for every stream: the server cannot prove its
  journal holds every row of the thread (contract 2's meaning, plus the
  quiet re-read in section 10). the client drops that thread's messages
  and reads it again if it is in interest; a cold copy is marked stale.

### after a reset

the client re-reads only the stage, its layers and its holds; every
other warm thread becomes cold and stale (no more re-reading every held
thread whole, `reducer.ts:378-380`). with versions (section 11) a re-read
of an unchanged thread is a 304.

## 10. restart: full resume (D6)

### what is persisted

in `boxbox.db`, written by the store's writer thread, new tables:

| table | holds |
|---|---|
| `stream_meta` | `epoch`, `head`, `reserved`, `clean` (0 or 1), `encoder` (the version of the neutral encoding, a constant in `wire/`), `gone_floor` |
| `stream_keys` | `kind` (`agent`, `thread`, `ask`, `order`), `key`, `seq` (the newest entry for the key), `whole` (0 or 1, section 6), for threads `v`, `rv`, `reset_seq` (the seq of its last `thread.reset`, 0 if none) and `srev` (the source's transcript revision the state reflects, section 14a; null when the source has none), `body` (the current state as the json a catch-up sends), `model` (the model's own state for the key: facts, status, ask, tail, held tick, floors, as its serde form) |
| `stream_gone` | `kind`, `key`, `seq`, `at`: removed threads and agents, settled asks; at most 10,000 rows or 7 days, and `gone_floor` is the highest seq ever dropped from it |
| `upstream_cursors` | `connection`, `epoch`, `seq`: each cmx2 cursor whose effects are all in the `stream_keys` rows of the same transaction |

the journal ring itself is not persisted: catch-up after a restart is
built from `stream_keys` and `stream_gone`, and a device that was
connected at shutdown needs nothing. in memory, `stream_keys` is the set
of patch bases (section 6) and `stream_gone` the tombstones, under the
same caps.

### when, and never a dropped batch

- the actor marks a key dirty as it journals. every 1 s, if anything is
  dirty and no batch is waiting for its acknowledgement, it takes one
  batch in one step of its own loop: the dirty keys' rows, the new
  tombstones, `head`, `reserved`, every upstream cursor. the batch goes to
  the writer on its own channel (capacity 1, awaited, never `try_send`;
  today's `Persist` channel for needs, read marks and clears is not this
  one and keeps its rule).
- **dirty marks stay until the writer acknowledges.** the writer commits
  the batch as one transaction and answers `ok` or the error. on `ok` the
  actor clears the marks of keys whose seq has not moved since the batch
  was taken (a key changed again stays dirty). on an error everything
  stays dirty and the next tick tries again; the error is logged once a
  minute. a cursor is therefore never written without every state it
  reflects.
- **the byte cap.** the batch's encoded rows are at most 16 MiB (the
  bodies are the patch bases already held; the batch holds their bytes
  until the commit). when a batch has waited 10 s for its acknowledgement,
  or the dirty set would pass 16 MiB, the actor stops taking source events
  until the acknowledgement comes: the bounded upstream channel (1,024
  events) fills and the watchers wait, which is backpressure on the cmx2
  sockets. devices keep getting what was already journaled.
- `reserved` is written as `head + 1,000,000` whenever the head passes
  `reserved - 500,000`, in the next batch; the actor does not journal past
  `reserved` before that batch is acknowledged.
- **clean shutdown:** stop taking source events, journal every pending
  delta, let every stream drain (a final heartbeat, as today), take the
  last batch with `clean = 1` once every earlier one is acknowledged, and
  exit after its acknowledgement. if it is not acknowledged inside the
  5 s shutdown budget, the process exits with `clean = 0` and the next
  start takes the crash path.
- **start:** read the tables and rebuild the model from the `model`
  columns. when the stored `encoder` equals the build's, re-encode every
  key and compare it with its `body`: any mismatch is a bug, mints a new
  epoch (every device resets) and is logged. when `encoder` differs (a
  build that changed the neutral encoding), there is nothing to compare:
  every key gets the `whole` flag (section 6) and no epoch moves. with
  `clean = 1` the head is the stored head; write `clean = 0` before the
  first stream is served.

### crash consistency

a crash leaves `clean = 0`, and the persisted state is up to a second
(or, under backpressure, up to one unacknowledged batch) older than what
devices saw. the start then:

- sets the head to `reserved`, so no seq is ever issued twice: a device
  holding a cursor between the persisted head and `reserved` catches up
  from it, and the gap below `reserved` holds nothing.
- sets the `whole` flag on every key (threads, agents, asks, order), so
  no patch lands on a base the device does not share.
- sets every thread's `v` and `rv` to `reserved`, so every thread
  revalidation misses once and no stale copy can win a 304 (the owner's
  q5 answer, which rests on the batch rule above).
- resumes each source from the persisted cursor, which matches the
  persisted states, so the source re-delivers everything after it.
  devices drop what they already had by the upstream gate and the offset
  rule, and converge.

sqlite runs in wal with `synchronous=normal`: a process crash loses no
acknowledged batch; a power loss may lose every batch since the last wal
checkpoint, always back to an older, consistent prefix (each batch is one
transaction), which the same rules cover: the cursor still matches its
states, and the reserved mark is stale only if more than 500,000 entries
were issued since that checkpoint.

### the cmx2 cursors

each watcher starts from its persisted cursor with `compact=1`, so cmx2
sends only the latest state per key since then. within cmx2's retention
(30 min or 10,000 events, whichever keeps more), the model applies it as
usual: no host read, no tail reads (tails are in the model state).

### the quiet re-read: a gap that cannot be replayed

when cmx2 answers `stream.reset`, its epoch moved, or a cursor is missing
or past its retention, the watcher reads the host as today
(`upstream/reconcile.rs:100-125`), and the model diffs the result against
what it holds instead of sending `host.reset`:

- a thread unchanged: nothing. changed: `thread.patch`. gone:
  `thread.removed`. new: `thread`.
- an ask still open: nothing. gone: `ask.settled` with `outcome:
  unknown`. new: `ask`.
- **transcripts, by revision** (section 14a). the session list now
  carries each session's `transcriptRev`. for each thread the model holds:
  - **revision unchanged**: no transcript-affecting write happened in the
    gap. nothing is sent, except for a part streaming across it (deltas do
    not move the revision): for every thread that was busy before the gap
    or is busy now, the server reads its newest messages
    (`GET /session/:id/message?limit=8`, which includes the one still
    streaming, doubling the limit up to 64 until the page holds the newest
    assistant message: a queued prompt can sit behind a streaming answer),
    checks the read's `x-cmx2-rev` still equals the list's, and journals
    the newest assistant message and every message without
    `time.completed` in the page, each whole with its parts and
    `upstream: null`
    (the resumed-part rule clients already apply, `reducer.ts:611`). the
    settled-text tracking of those parts restarts from that text. a
    revision that moved in between takes the next case.
  - **revision moved**: `thread.reset {key}`; its `v` and `reset_seq`
    move to that entry's seq and its `srev` to the new revision. devices
    re-read it only if it is in their interest.
  - **no revision known** (the thread was never seen with one, or the
    daemon predates the field): `thread.reset {key}`, as `host.reset`
    rehydrates every thread of the host today (`reducer.ts:502-517`).
- tail reads: asked as today (`model.rs:871`) for threads whose revision
  moved or is unknown, and for threads busy across the gap; other tails
  are kept.

the same quiet re-read replaces `host.reset` on every upstream reconnect
that needs a fresh read.

**what a device sees.** a clean restart: its stream drops, it reconnects
with its cursor, the epoch matches, the catch-up is empty, `caught`. no
reset, no read. a crash: the same, plus every key once whole, plus one
missed 304 per thread it opens. a cmx2 gap past retention: a reset only
for threads whose transcript really changed.

**as built** (`fleet/persist.rs`, `fleet/model/state.rs`, migration 11):
`stream_keys` also keeps `raised` (an ask's first entry, for the "raised
and settled since the cursor" rule) and `turn` (the newest-turn ids `rv`
counts by), and `seq = 0` marks a key the model holds that the journal
never told; `stream_gone` also keeps `raised` and `body` (the removal or
settlement a catch-up sends). the start check decodes each body into its
wire type and encodes it again; a byte that differs, or a row that does
not decode, mints the new epoch. a start that must rewrite (a crash,
another encoder, a failed check) marks every key dirty and leaves the
stored `encoder` until that first batch commits. a key's catch-up from a
`since` at or past its `v` is empty, so a restart's empty ring makes no
key stale that did not move. the order row's model also keeps the sends
waiting for their message, the asks being answered and each thread's last
stop, so needs judge a turn across a restart as without one; a window tail
read in flight is not kept (asked again on the thread's next change). a
tail read moves `srev` only when its `x-cmx2-seq` is at or below the seq
the stream has applied (section 14a: the journal then holds every write it
reflects).

a clean restart's catch-up is not quite empty: the watcher's reconnect
moves the agent's `connection.since`, one `agent` entry per host. a crash
start journals, before any stream is served, every agent, thread, ask and
the order whose model state differs from its stored body (read marks,
clears and needs reach their own tables at once, the stream's batch up to
a second later), so a reset and `GET /api/fleet` serve them. a model row
that does not decode (state structs default every field a later build
adds) drops its host's cursor, and its thread is journaled removed until
that host's read brings it back. the newest-message reads a quiet re-read
asked for are kept in the thread's row and asked again at start. cmx2
moves `transcriptRev` with no counted event for a revert armed or undone,
rows healed from the transcript file and a landing that failed part way,
and says so only with `session.updated`: a session info whose revision is
past the thread's `srev` resets the thread. while a stream from a cursor
applies its compact replay (which keeps only each key's last update, so a
session info can come ahead of the entry that carried its revision's
event), that judgement waits until the replay is caught up (past the head
a small read gave at the open, a frame only live streams get, or a quiet
heartbeat) and compares with the revision the replay's events reached.

## 11. thread reads

### routes

| route | answers |
|---|---|
| `GET /api/agents/{agent}/threads/{thread}/messages` | a page of the thread (below); the whole read and the newest page end with `btws: AgentBtw[]`, oldest first, read beside the thread, absent when the agent has no btw or the list could not be read |
| `GET /api/agents/{agent}/threads/{thread}/btw` | the thread's btws, `AgentBtw[]`, oldest first: the reread after a gap (section 8, btws) |
| `GET /api/agents/{agent}/threads/{thread}/messages/{message}` | one message, `{info: Message, parts: Part[]}` |
| `GET /api/agents/{agent}/threads/{thread}/summary` | the thread summary (section 12) |

they replace `/api/hosts/{host}/sessions/{session}/messages` and
`.../messages/{message}`. the cmx2 body is translated message by message
as it streams from the daemon, never parsed whole (one message in
memory, at most 32 MiB: boxbox's own composer sends up to 24 MiB of
`data:` urls in one message), as contract 2 planned. a body that sends
nothing for 45 s ends the read, the stream's stall rule.

every answer carries:

- `x-boxbox-seq: <epoch>:<S>`, the journal head when the read started
  (the no-gap rule, section 5);
- `x-boxbox-upstream: <source epoch>:<seq>`, the source event the read
  reflects, when the source numbers its events. for cmx2 it is the
  daemon's `x-cmx2-seq`, renamed; it feeds the upstream gate exactly as
  `x-cmx2-seq` does today;
- `etag` and `cache-control` (below).

### versions and 304

- `v`, per thread: the seq of the newest transcript entry for it. a
  thread first seen gets the head. `thread.reset` and a crash start move
  it; `thread.reset` moves `rv` too (older pages cannot be trusted
  either).
- `rv`, per thread: the seq of the newest transcript entry that touched
  a message outside the thread's newest turn (a removal, an edit, a late
  part on an old message). the newest turn, for this rule, starts at the
  newest user message that is not queued (`queued` absent): a queued
  prompt waiting behind a streaming answer joins the newest turn instead
  of starting one, so the answer's deltas do not move `rv` and older page
  urls stay put. the actor tracks the ids of the messages in each
  thread's newest turn (at most 1,000 a thread and 16,384 over every
  thread; past either, every entry of the thread whose set would grow
  counts as a rewrite), and drops the set when the next turn starts. a thread first
  seen mid-turn holds no set yet, so its turn's entries count as
  rewrites until its next prompt.
- the etag is `"<encoder>.<epoch>.<v or rv>.<q>"`, where `q` is a short
  hash of the normalised query (`turns`, `before`, `at`; `rv` stays out,
  it changes the headers, not the bytes); until the app pages, a read with
  no query answers the whole thread and its `q` is `whole`, since no query
  normalises to 8 turns, another body. a request whose `if-none-match`
  matches the etag on the current `v` answers `304` without asking the
  source. a match on the `rv` form alone does not: the same string can be
  the `v` etag of a page that held the newest turn, so it is read again
  (immutable pages are not asked for again anyway). a thread the server holds no
  version for (outside the 1,000 kept threads) gets no etag.

### pages, newest first

a turn is what the app calls one: a user message and every message
after it up to the next user message; messages before the first user
message form turn 0. pages never split a turn. messages inside a page
are oldest first; pages go from newest to oldest.

| query | meaning |
|---|---|
| none | the newest 8 turns, from a2's merge on; until then the whole thread (`older` null), so the app reads whole until it pages |
| `turns=K` | at most `K` whole turns, 1 to 64 |
| `before=<message id>` | only turns older than the turn that message starts (the `older` of the page after) |
| `at=<message or part id>` | the turn holding it and up to `K - 1` turns older: a jump from the ruler, the turns panel, a `?at=` or `?part=` link, or a push focus (the ask's `tool.messageID`) |
| `rv=<epoch>.<n>` | on an older page: the rewrite version the client expects, with the epoch it was read in (makes the page cacheable, below; a url kept for ever never meets the same `rv` from another epoch) |

a page also stops adding older turns past 1 MiB of json (it always holds
at least one turn). one turn a page holds is at most 64 MiB of json: the
server holds each message of it once, and a page that would hold a
bigger turn answers `413` `page-too-large`; that thread is read whole.
an anchor the thread does not hold answers `404` `no-such-message`.

```
{"messages": [{"info": {...}, "parts": [...]}],
 "older": "msg_8b1e0", "total": 1375, "turns": 37}
```

`older` is the id to pass as `before` for the next page, null at the
start; `total` counts messages and `turns` counts the turns the app
shows in the whole thread, the summary's `turns[]` length: one per user
message, less a newest one with no part yet. messages before the first
user message ride in the oldest page as turn 0 and count as none.

### cache headers

- the newest page (no `before`; or `at` landing in the newest turn):
  `cache-control: private, no-cache` with the etag on `v`.
- an older page with `rv` equal to the thread's current epoch and `rv`, none of
  whose messages is in the newest turn as `rv` counts it (a queued prompt
  and the answer streaming ahead of it are) and all of whose assistant
  messages have `time.completed`:
  `cache-control: private, max-age=31536000, immutable`, etag on `rv`.
  its bytes can only change if `rv` moves, and then the client asks with
  the new `rv` (or the new epoch), a new url. an older page holding any message of the
  newest turn, or an unfinished answer, is `private, no-cache` with the
  etag on `v`: a half answer is never cached immutable.
- an older page without `rv`, or with a stale one: `private, no-cache`
  with the etag on `rv`.
- `.../messages/{message}`: `no-store`, as today.

## 12. the thread summary

`GET .../summary`, etag on `v` with a short hash of each child's key and
the `v` its numbers came from, or that it failed or was not read (a
working child moves it), `cache-control: private, no-cache`. it
gives the app everything it reads from the whole history without the
history (round three, thread history), computed by the server from one
streamed read of the thread, cached per `(key, v)` (64 summaries or
8 MiB, single flight per thread; children's numbers in their own pool,
1,024 children or 1 MiB, so they never evict a thread's summary).

`v` moves on every transcript entry, so a streaming thread would cost a
whole streamed read per request. a thread's summary is computed at most
once per 10 s while its epoch and `rv` hold: a request inside that window
gets the cached summary with its own `v` in the body and the etag. a
revert, a removal or a reset moves `rv` or the epoch and is computed
again at once, so no stale turn list is served or confirmed by a `304`. that is enough because the client
derives every turn it holds (the newest turn always) from its messages;
the summary only speaks for turns it does not hold, which a stream entry
for a message it does not hold tells it to fetch again.

```
{"key": "vm-a:ses_2", "v": 48230, "rv": 47002, "total": 1375,
 "turns": [
   {"id": "msg_01", "by": "you", "at": 1792050000000, "end": 1792050090000,
    "line": "make the importer skip empty rows", "steps": 14,
    "ask": true, "error": false, "status": "done",
    "model": "provider/model-a", "effort": "high", "cost": 0.41,
    "answered": true, "messages": 9},
   {"id": "msg_40", "by": "mail", "from": "researcher", "fromID": "ses_9",
    "at": 1792050100000, "end": 1792050100000, "line": "", "steps": 0,
    "status": "done", "answered": false, "messages": 1}
 ],
 "spawns": [{"turn": "msg_01", "part": "prt_2_3_1", "name": "researcher",
             "type": "explore", "child": "ses_9", "at": 1792050010000}],
 "files": [{"path": "src/import.ts", "add": 40, "del": 12, "at": 1792050080000}],
 "children": [{"key": "vm-a:ses_9", "steps": 31,
               "first": 1792050011000, "end": 1792050098000}]}
```

| field | what reads it today |
|---|---|
| `turns[]` | one per turn, in order, every kind (notices too): the ruler (prompts are `by` in you, queued, brief, `stage.tsx:756`; the app derives no `steer` turn today, so the summary has none), the turns panel (all but notices, `stage.tsx:786`), the status count (all, `stage.tsx:252-254`), details steps, models and switches (`details-model.ts:109-203`) |
| `by`, `from`, `fromID`, `note` | the turn's origin as `model.ts:433-455` derives it |
| `line` | the first non-blank line of the prompt, cut at 300 characters, read from its first 20,000 (`stage.tsx:890`); empty for a prompt with only an image, `compacted` and mail labels are built by the client as today |
| `steps`, `ask`, `error` | tool parts in the turn; one of them of family `ask`; one an error that was not interrupted (`rows.ts:71`) |
| `at`, `end`, `status`, `answered` | `model.ts:565-632`; `answered` is the app's rule: the turn ended in said words after its last step (a turn of only a prompt, a mail turn among them, is not answered) |
| `model`, `effort`, `cost` | the last assistant message's model and effort; the sum of assistant costs, compaction summaries excluded (`model.ts:577-586`) |
| `spawns[]` | each spawn step: the agent row, the roster, the report link (`model.ts:364-371`, `details-model.ts:28-54`, `rows.ts:318-322,490`) |
| `files[]` | per path, add and del summed over completed edit steps, in the order the app lists them: newest turn first, and inside a turn the reverse of each path's first edit; a path seen in a newer turn keeps that place, and `at` is its newest edit (`model.ts:612-616`, `details-model.ts:86-103`) |
| `children[]` | each child thread's step count and first and last times, for the agent rows and lanes (`live.ts:155-185`); a child's own summary has the same numbers. the first 64 children are read, 4 at a time, each within 10 s and all within 15 s; one past the count or the time, gone, failing or late is `{key}` alone, as the app shows a child it has not read (no step count), and never fails the summary. a child that failed or ran late is not read again for 30 s; the etag counts it by its key and that it failed |

how the app uses it: turns it holds come from the messages, as today;
turns it does not hold come from `turns[]` and show their placeholder at
the estimated height until their page lands (a jump to one waits about
200 ms, accepted). an entry that touches a message the client does not
hold tells it to fetch the summary again (an etag check). today's counts
are partial while a thread's turns build; from the summary they are whole
at once, with the same final values. the exactness check is section 16.

held children (lanes): each held child's newest page plus its own
summary.

## 13. attachments and thumbnails

- **references.** the cmx2 source, translating any part that carries a
  `data:` url (a file or image part, or an entry in a tool's
  `state.attachments`), in stream events and thread reads alike: decodes
  it, hands the bytes to the media task (origin `agent`, the store and its
  caps in `agents.md`, media), and sends the part with `media: {id,
  state: "ready"}`, `size`, and for an image its `width` and `height` from
  its header. the source waits for the media task's acknowledgement
  before passing the event on, within the media caps (2 copies in flight
  and 64 queued per connection, each copy also waiting for one of the
  store's 8; a url past the queue keeps its `data:` url). a url the
  connection copied before (the last 1,024, by the sha256 of the url) is
  not copied again while the store still holds its id. when the store
  refuses (full), the part
  keeps its `data:` url, so it shows as it does today. until a3's merge
  the references are off (`MEDIA_REFERENCES`, an internal constant, no
  `boxbox.toml` key): parts keep their `data:` urls; a3's merge flips it.
  thumbnails are off the same way (`THUMBNAILS` in `media/thumbs.rs`):
  until it is switched on with a3's merge, `?w=` is ignored and the
  original answers exactly as without it.
  decision 32 (cmx2
  files travel inline) still holds between cmx2 and the server, not to
  devices.
- **the route** is today's `GET /api/media/{id}`:
  `cache-control: private, max-age=31536000, immutable`, etag the id. a
  re-read of a thread never carries image bytes again.
- **thumbnails.** `GET /api/media/{id}?w=<px>`, with `w` from the ladder
  96, 192, 384, 768, 1536 (device pixels; the client rounds its box width
  up). the server scales the image to that width, never up (at or past
  the original width it answers the original), keeps the format (png
  stays lossless), caches the variant under `media/thumbs/` against the
  media cap, and answers it immutable with etag `"<id>.w<px>.s<n>"`,
  `n` the scaler's version (`SCALER_VERSION`), moved by any change that
  would change a thumbnail's bytes, so an etag a client holds as
  immutable never names other bytes. a thumbnail past 1536 by 4096
  pixels (`MAX_THUMB_PIXELS`), or an original past 40 M pixels, answers
  the original.
  the scaling is written in `media/thumbs.rs`: chromium's own mip chain
  (skia's 2x2 levels, sampled trilinearly on premultiplied pixels), since
  every filter a resampling crate offers (lanczos3, catmull-rom, triangle,
  box) failed the bar by far; the one crate added is `image`, for the png
  and webp codecs (`THIRD_PARTY.md`). thumbnails ship only for
  a format that passes the pixel check: at least 99.9% of pixels within 2
  of 255 per channel of the browser's own downscale of the original in the
  same box, in webkit and chromium at device pixel ratios 2 and 3 (the
  owner's q4 answer; `verification.md` records that this is near, not
  identical). for a format that fails, `w` answers the original, so the
  app never branches.
  **as built:** in chromium, png and webp pass (both written lossless)
  and jpeg fails; gif (motion, a palette) was not offered. in webkit
  (a WKWebView at dpr 2 and 3) every format fails: webkit's own downscale
  differs from chromium's by more than the bar, so no one thumbnail can
  pass both (`verification.md`, thumbnails). so `THUMBNAILS` stays off and
  every `w` answers the original; jpeg and gif answer the original even
  when it is on (`agents.md`, the route).
- **on the device.** the worker fetches by id (and `w`), keeps the bytes
  as a blob in indexeddb, and hands the page a `blob:` url; it revokes
  urls no on-screen thread uses. copy image fetches the original. tail
  items still carry only the filename. blobs share the 50 MB cap with
  threads (section 15a, eviction).

## 14. what the server asks of cmx2

all opt-in query switches on `/global/event`, additive in cmx2's
manifest, so every other cmx2 client keeps today's stream byte for byte
(round three, cmx2):

| switch | the server relies on |
|---|---|
| `coalesce=100` | `message.part.delta` merged per part over 100 ms, offset of the first, flushed before any other event |
| `types=` | exactly the kinds the source consumes (`translate.rs:82-265`): `message.updated`, `message.part.updated`, `message.part.delta`, `message.removed`, `session.created`, `session.updated`, `session.deleted`, `session.idle`, `session.status`, `session.error`, `permission.asked`, `permission.replied`, `question.asked`, `question.replied`, `question.rejected`, `worktree.review.requested`, `worktree.merged`, `worktree.discarded`, `process.notify`; heartbeats and `stream.reset` always pass |
| `compact=1` | on resume, the latest state per key since the cursor, in seq order, with the final state equal to a full replay |
| `gzip=1` with `accept-encoding: gzip` | one deflate context per subscriber, flushed per batch |

| `rev=1` | each session's `transcriptRev` on session infos and transcript events (section 14a) |

rest answers over 1 kb are gzipped when asked. heartbeat stays 10 s; the
server's 45 s stall rule is unchanged.

all five switches are in cmx2 0.9.0, the pinned commit (`cmx2.pin`), with
`transcriptRev` and `x-cmx2-rev` as section 14a says.
**the server never depends on them.** a daemon that does not know a
switch ignores the query parameter, so the server keeps everything it
needs on its own side: its own 100 ms delta merge (section 8), its own
type filter (it decodes the kind first and drops what it does not
consume, whatever `types=` did), a full replay accepted where
`compact=1` was not honoured (the model is idempotent per key), an
identity stream when the answer has no `content-encoding`, and the
no-revision rule of section 10 when `transcriptRev` is absent.

## 14a. the cmx2 transcript revision (contract text)

the cmx2 rev package adds, in cmx2, exactly this:

> **`transcriptRev`**: a per-session integer, starting at 0 for a new
> session and persisted with the session. it increases by at least 1 on
> every write that changes what `GET /session/:id/message` would answer,
> other than streamed text: a message landed or updated
> (`message.updated`), a part created or replaced (`message.part.updated`,
> a tool state change included), a message removed (take-back, a failed
> queued prompt, a provisional message swapped for its committed one), a
> revert and its undo, a compaction summary written. it does not move on
> `message.part.delta`, `tool.progress`, status, idle, model or title
> changes, or archive. it never decreases, and it moves in the same
> transaction as the write it counts.
>
> - rest: `SessionInfo.transcriptRev` on `GET /session`, `GET
>   /session/:id` and every answer that returns a session, as an additive
>   field in the manifest and openapi.
> - reads: `GET /session/:id/message` and
>   `GET /session/:id/message/:messageID` answer
>   `x-cmx2-rev: <transcriptRev>`, the revision the body reflects,
>   consistent with its `x-cmx2-seq`.
> - events, only for a `/global/event` (and `/event`) subscriber that
>   passes `rev=1`: `transcriptRev` on the session info inside
>   `session.created` and `session.updated`, and `properties.rev`, the
>   session's revision after the write, on `message.updated`,
>   `message.part.updated` and `message.removed`. a subscriber without
>   `rev=1` gets today's bytes exactly.

the server keeps, per thread, `srev`: the highest revision seen in an
event the server journaled for that thread, a session info it applied,
or a read it folded into its own state (the quiet re-read's newest
messages, a tail read), persisted with the state it reflects (section
10). a page or message read the server only passes through to a device
never moves `srev`: that read can reflect writes whose events the server
has not journaled yet, and a gap that then lost them would look
unchanged. after a gap it cannot replay, `srev` against
the list's `transcriptRev` decides which threads get `thread.reset`
(section 10, the quiet re-read).

## 15. what goes

server:

- contract 1's types (`fleet/change.rs`: `Change`, `JournalEntry`,
  `SessionEntry`, its `TailItem` and `Ask`, `FleetSnapshot`, `PROTOCOL =
  1`); repo colour types move to `wire/`.
- the raw passthrough: `raw` on `Upstream::Source` (`fleet/mod.rs:111-113`)
  and the watcher's copy of each payload (`watcher.rs:331`), `Session.info`,
  `Status.raw`, `Pending.ask` (`model.rs:129-131,327-328,334-336`),
  `Cmx2Raw` (`source/mod.rs:761-786`), the byte-for-byte transcript proxy
  (`source/cmx2/verbs/transcript.rs`) and its routes
  `/api/hosts/{host}/sessions/{session}/messages[/{message}]`,
  `x-cmx2-seq` to devices.
- `host.reset` and `session.*` on the wire; the `colours=1` flag; the
  planned second journal, per-contract caps and double model copy
  (`agents.md` section 2; `architecture.md`'s caps rows and m9
  arithmetic: the 8 MiB ring and 4 MiB copy never get built).
- `/api/board/stream` (the board declares its view on `/api/stream`).
- `server/goldens/contract1/` (replaced by `protocol3/`).

web app: the contract 1 narrowing (`app/src/sync/protocol.ts`), every
cmx2 type in `app/src/sync` and `app/src/ui/thread` (cmx2 message, part
and session shapes become contract 2's), the gap-reconnect rule, the
`host.reset` handler, reads from `/api/hosts/.../messages`.

kept: `/api/fleet` (now `{agents, threads, asks, order}` with
`x-boxbox-seq`), `/api/needs`, `/api/presence`, push, and the verb routes
under `/api/hosts` (q2).

docs: decisions 25, 36 and 37 are superseded by a new row (the
coordinator writes it). each package rewrites the `agents.md` and
`architecture.md` sections its code makes wrong: `agents.md` 39-51,
342-402 (the stream), 449-549 (the transition), 624-680 and 749-766
(raw), 850-880, 917-1008, 1397-1452; `architecture.md` 75-81, 144-151,
184-219, 479-483, 690-730, 772-782.

## 15a. the app's indexeddb (v5 to v6)

- **upgrade:** clear `fleet` and `threads` and `meta.sync` (the cursor
  becomes null): their records are contract 1 and cmx2 shapes. keep
  `drafts`, `draftPhotos`, `outbox`, `prefs`. add `media` (key the media
  id or `<id>.w<px>`, value `{blob, mime, size, usedAt}`). the one-time
  cost: the first connect gets a reset, and each thread reads its newest
  page when it is next opened (q6).
- **the cursor** keeps its text form `<epoch>:<seq>`, written in the same
  transaction as the data it reflects (as today). its meaning changes:
  the epoch now outlives server restarts, and the seq may skip.
- **thread records:** `<key>#head` gains `etag`, `rv`, `left` (the seq at
  which it left interest) and the ordered list of its page keys;
  `upstreamEpoch`, `hydratedAt` and `lastUpstream` keep their meaning,
  now from `x-boxbox-upstream`. pages are keyed by the id of their first
  turn, `<key>#p:<turn id>`, so prepending an older page renames nothing
  (today's `floor(index / 50)` keys renumber). `<key>#summary` holds the
  summary and its etag. chunk records stay. `<key>#btw` holds the
  thread's btws whole, oldest first (at most 64), written whole when any
  changes and gone with the thread.
- **the cap** is 50 MB for threads and media together (was 150 MiB),
  counted by the bytes of each record (a thread's json estimate as today,
  a blob's `size`). **eviction:** first media blobs that no thread in
  the store shows, least recently used by `usedAt` (a blob comes back
  from the server's immutable route when it is shown again); then threads
  in today's order (`reducer.ts:1052-1107`). a blob shown by a thread on
  screen, the stage and the thread an open or read is for never go.
  evicting a thread lets its blobs go in the next pass.
- a v5 build cannot open a v6 database (today's rule, `cache.ts:44-46`),
  and could not speak protocol 3 anyway.

## 16. tests

- **server goldens, rewritten** under `server/goldens/protocol3/` from
  the same recorded tape: hello and reset, catch-up inside the ring and
  from persisted state, at the head, ahead, other epoch, expired; an
  interest switch with and without `since`; thread pages and the summary
  from recorded transcripts (the `live/` goldens recorded again).
- **one recording, two wires.** a replay drives the recorded cmx2 tape
  through main's server and main's app reducer (contract 1) and through
  the branch's server and reducer (protocol 3), with the same seeded
  schedule of reads, refetches and applies (the wire-replay harness). it
  compares the app's final state (the contract 1 state mapped through the
  cmx2-to-neutral table, deep equal) and a ui digest over what the
  screens derive: the home windows (order, titles, tails, needs), each
  held thread's turn models, ruler, turns panel and details. seeds with a
  lost connection and a hidden spell are included.
- **view-switch replays.** seeded switches home, A, B, home, A, with and
  without `since`, and hidden spells past 30 s with a return. whenever a
  thread is on stage and its read or catch-up has landed, its messages
  deep-equal a whole read at that journal position; nothing doubles or
  goes missing (the exactly-once suite).
- **catch-up.** from random cursors over the tape, compact catch-up then
  live gives the same final state as a full replay through the same
  interest, from the ring and from persisted state.
- **restart kills.** in the replay harness, the actor stops at random
  steps (a) cleanly and (b) without writing its last batch, restarts from
  its database and continues the tape. connected reducers see no reset;
  after (a) no read at all; after (b) the final state equals an
  uninterrupted run and every etag misses once. `bench/golden-live.ts`
  adds a SIGTERM and a SIGKILL of a dev server it started on its own port,
  mid-stream.
- **settled parts.** a replay where the device loses a random delta: the
  hash misses, the message is re-read, the final text equals the source's.
- **gzip.** each frame decodes on arrival (as `compress.rs:246` checks for
  json); manual checks through the reverse proxy (`curl --compressed -N`,
  timing each frame) and in safari on a device, listed in
  `verification.md`.
- **paging and summary.** for every fixture thread, what the app derives
  from the summary (ruler ticks, turns panel rows, counts, details)
  equals what it derives from the whole thread, byte for byte.
- **images.** the verification driver substitutes media urls back to the
  daemon's data urls and compares byte for byte; screenshots of image rows
  before and after; the thumbnail pixel check in webkit and chromium at
  device pixel ratios 2 and 3.
- **transcript revision.** a replay of a cmx2 gap past retention, with
  revisions: a thread whose revision did not move gets no reset; one whose
  revision moved, or a removal in the gap, gets `thread.reset`; a part
  streaming across the gap ends with the source's text. without
  revisions (an older daemon), every thread of the host is reset.
- **persistence.** a writer that fails or stalls: dirty marks stay, the
  cursor is never written ahead of its states, the actor stops taking
  source events at the cap and resumes on the acknowledgement.
- **frames for the app before the server runs.** s1's first commit ships
  `server/goldens/protocol3/` tapes produced by the simulated encoder
  from the recorded tape (the same one that gave section 17's numbers),
  so a1 builds and replays against real frames while s1 is built.
- **bytes.** the bench replay reports raw and gzip bytes per view.

**telemetry** (new kinds in `telemetry/schema.ts`, never renamed later):

| kind | one row | props |
|---|---|---|
| `sync.catchup` | per stream open | `how` (`reset`, `caught`), `reason` (the reset reason), `frames`, `bytes`, `stale` (keys), `resets` (`thread.reset` frames), `ms` (open to `caught` or the reset applied) |
| `sync.interest` | per confirm | `ms` (post to confirm), `entering`, `catchup` (bytes), `stale`, `reset` |
| `sync.fault` | per event | `what` (`patch-error`, `read-late`, `hash-miss`, `catchup-error`) |
| `perf.sync` | the minute row, as today | gains `view` (`home`, `thread`, `hidden`) and `skipped` (seqs the stream skipped, from the ids it saw) |

the reducer's `gaps` counter goes: a skipped seq is not a gap, and what
it caught is now `sync.fault` `patch-error` (a base that diverged) and
`read-late`. `app.stream`'s `resumed` and `replayed` keep their
meaning (`replayed` counts the catch-up's frames).

## 17. bytes per minute

**from the recording in the repo** (`server/goldens/contract1/`, 37.8 s
of a scripted bench run: 756 threads created, 46 busy, short canned
replies; one device). today's figures are the journal it produced, which
every device gets [measured]. the protocol 3 figures re-encode that
journal frame by frame with the clock of each frame from replaying the
tape [measured bytes of a simulated encoder; the rules are [est] until
the server runs them]. gzip is one deflate stream flushed after every
frame.

| view | today raw | today gzip | protocol 3 raw | protocol 3 gzip |
|---|---:|---:|---:|---:|
| home | 17.6 MB/min | 549 KB/min (not sent: today's stream is identity) | 1.61 MB/min | 158 KB/min |
| an open streaming thread | 17.6 MB/min | as above | 1.67 MB/min | 166 KB/min |
| hidden | 17.6 MB/min | as above | 1.61 MB/min | 158 KB/min |

today's device stream is not compressed, so a device receives the raw
column. 76% of today's bytes are whole order lists; patches without
order diffs would leave home at 387 KB/min gzip. this run is a burst of
thread creation, which inflates order and thread churn and understates
streamed text.

**steady use [est]**, one thread streaming at about 40 deltas a second
of about 4 characters, a 5 KB whole session entry (12 tail items),
nothing else moving:

| view | today | protocol 3 |
|---|---:|---:|
| home | about 2.1 MB/min raw (5 entries a second, about 1.5 MB; every delta, about 0.55 MB; finished text twice more) | about 50 KB/min raw (2 patches a second of about 400 B), about 15 KB/min gzip |
| an open streaming thread | the same 2.1 MB/min | home plus 10 merged deltas a second of about 200 B: about 170 KB/min raw, about 40 KB/min gzip |
| hidden | the same 2.1 MB/min | as home |
| idle | heartbeats, about 24 B/min | the same |

the measured gzip ratio on the recording was 32x for today's frames and
10x for protocol 3's; the steady gzip figures above assume 3x to 4x for
changing tail text and deltas.

## 17a. caps

| thing | cap | owner, on overflow |
|---|---|---|
| interest | 1 thread, 8 layers and 16 holds per stream | the post answers 400 |
| stream map (id to interest and queue) | one entry per open stream | removed when the stream ends |
| confirm block | 1 MiB per stream, one in flight, outside the 512 KiB cap, drained through the stream's `pending` deque | catch-up past it goes `stale`; a later post waits for the block to drain |
| persist batch | one in flight, 16 MiB of rows | dirty marks stay; past 16 MiB or 10 s unacknowledged, source intake stops until the acknowledgement |
| deflate state | 256 KiB per gzip stream, 64 gzip streams | past 64, identity |
| outbound queue | 512 KiB raw per stream (as today) | closed, the client resumes |
| pending deltas | 100 ms per part or btw; 1 MiB in all | past it, all flushed |
| btw answer counts (`fleet/encode.rs`, `TRACKED_BTWS`) | 8 B per running btw, 1,024 btws | oldest dropped, its next deltas go without an offset |
| btw question | 32 KiB (`MAX_BTW_TEXT`) | the ask answers 400 |
| btw list read (`source/cmx2/verbs/btw.rs`, `BTW_LIST_BYTES`) | 4 MiB per read | past it the read fails; a thread read goes without `btws` |
| btws (client) | 64 per thread, in the thread's byte cap, one `<key>#btw` record | oldest settled first, then oldest running |
| settled-text tracking | 16 B per streaming part, 4,096 parts | oldest dropped, its next update whole |
| last journaled state per key (patch bases) | one `Thread` per kept thread, 1,000 | evicted with the session |
| newest-turn message ids | 1,000 per thread, 16,384 over every thread | past either, every entry of the thread whose set would grow counts toward `rv` until its next turn |
| tombstones | 10,000 rows or 7 days | oldest dropped, `gone_floor` rises |
| summaries | 64 or 8 MiB, one computation per thread per 10 s | least recently used |
| `left` (client) | one value in each thread's `#head` | goes with the record |
| app indexeddb | 50 MB, threads and media blobs | unseen blobs first, then today's thread order (section 15a) |

## 17b. the owner's answers (final)

- **q1** the board moves onto `/api/stream` and declares the board view
  (section 5, the board).
- **q2** the verb routes under `/api/hosts` stay for now.
- **q3** a layer under the stage stays in interest while covered, so it
  is current when the stage closes; no catch-up on close (section 5).
- **q4** thumbnails pass at 99.9% of pixels within 2/255 of the browser's
  own downscale, with a resampling crate on the server (section 13).
- **q5** after a crash each thread misses its 304 once; no per-batch
  persistence; this rests on the acknowledged batches of section 10.
- **q6** cached threads are dropped once at the indexeddb upgrade.
- **b3** an exact per-thread revision in cmx2 (section 14a), used after
  a gap the server cannot replay (section 10).

## 18. implementation packages

| package | files | gives the others | needs |
|---|---|---|---|
| **s1 server protocol** | `server/src/wire/` (stream frames, thread patch, order patch, `catchup`, `textOf`, shape additions, the `encoder` constant), `fleet/mod.rs` (journal of neutral entries, the stream map, interest filter in `deliver`, interest posts and confirm blocks, catch-up from the ring, delta batching, settled text and unchanged-message rules, `v`, `rv` and `reset_seq`), `fleet/model.rs` (neutral encoding, patch bases with the `whole` flag, 500 ms pace), `journal.rs`, `http/stream.rs` (query, gzip per stream, batches, the board view), `http/mod.rs` (interest route; the whole-thread read under `/api/agents`, translated, with `x-boxbox-seq` and `x-boxbox-upstream`), `http/fleet.rs`, `board/` server side (projection on `/api/stream`), `upstream/watcher.rs` (cmx2 switches, sent but never relied on, section 14), `source/cmx2/` (neutral translation of reads), deletes in section 15, telemetry kinds, the openapi document | first commit: the wire as utoipa types, the generated `app/src/api/boxbox.d.ts`, and `server/goldens/protocol3/` tapes from the simulated encoder, so a1 and b build and replay against them | nothing: it works against today's pinned daemon, and gains the switches when the pin moves to a cmx2 commit with `cmx2/cmx2-stream` |
| **s2 server resume** | `store/schema.rs` (four tables), `fleet/persist.rs` (new: acknowledged batches, the byte cap and intake stop, reserved head, start check by `encoder`), `fleet/mod.rs` (restore, clean shutdown), `fleet/model.rs` (model state serde, `srev`), `upstream/watcher.rs` and `reconcile.rs` (persisted cursors, `compact=1`, the quiet re-read by revision, tail reads as section 10 says) | no wire change | s1; the exact revision path needs cmx2 rev and the pin moved to it, and without it takes the no-revision rule |
| **s3 server summary, paging, attachments** | `http/agents/` (pages, `at`, `rv`, etags, cache headers, summary route), `fleet/summary.rs` (new, the 10 s rule), `source/cmx2/verbs/` (streamed read and fold), `media/` and `http/media.rs` (copy of data urls, `?w=` variants, the resampling crate in `THIRD_PARTY.md`), `docs/verification.md` (the pixel check and its threshold) | pages, summary, media references | s1; media references switch on only after a3 reads them |
| **a1 app protocol client** | `app/src/sync/` (`protocol.ts`, `reducer.ts`: neutral shapes, patches, order patches, cursor rule, protocol errors, interest with layers, `left`, the no-gap rule, `textOf`, `catchup` frames; `worker.ts`: stream url and query, interest posts, hidden 30 s; `cache.ts`: v6 with the media store and the shared cap), `app/src/ui/thread` and every reader of cmx2 shapes, `app/src/sync/fixtures/wire-replay.ts`, telemetry kinds | interest posts and reads as specified | s1's first commit. the largest package: it ports the thread ui from cmx2 to contract 2 shapes, and may split into the sync layer and the ui port |
| **a2 app paging** | `app/src/sync/` (pages, prepend, summary records), `app/src/ui/thread/stage.tsx`, `details-model.ts`, `live.ts` (summary for turns not held, placeholders, prefetch a few screens ahead, lanes from a child's newest page and summary) | none | a1, s3 pages and summary |
| **a3 app images** | `app/src/sync/` (media blobs, blob urls, eviction), `app/src/ui/thread` image rows | reads `media` parts | a1 |
| **b board** | `board/daemon/src/net.rs` (url `/api/stream?view=board`, hello protocol 3, gzip), `board/wire/src/lib.rs` (`PROTOCOL = 3`) | none | s1's first commit |
| **cmx2 rev** (in the cmx2 repo) | the session store (a persisted `transcript_rev` per session, moved in the same transaction as each counted write), the write sites section 14a lists (message landed and updated, part replaced, take-back, failed queued prompt, provisional swap, revert and its undo, compaction summary), the event encoder (`rev=1`), the message read routes (`x-cmx2-rev`), the manifest (`bun run contract`, client and openapi regenerated), `docs/` | `transcriptRev`, `x-cmx2-rev`, `rev=1`, exactly as section 14a's contract text | nothing; it builds on `cmx2/cmx2-stream`'s switch plumbing |

**merge order.**

1. s1's first commit (wire types, openapi, generated types, golden
   tapes; no behaviour). a1 and b rebase on it.
2. s1, a1 and b together, in one merge: the wire switches for every
   device at once (D1).
3. cmx2 rev, in cmx2, at any time; then boxbox moves its pin to a cmx2
   commit with the stream switches and the revision (`just vendor`, the
   probes, a changelog line).
4. s2: server only; devices see restarts stop costing them. it can merge
   before step 3 and then uses the no-revision rule until the pin moves.
5. s3's pages and summary (additive routes), then a2.
6. a3 (reads both `url` and `media`), then s3's media references switch
   on.

s2, s3 and cmx2 rev can be built at the same time as s1 against this
spec; s2 and s3 merge after s1.
