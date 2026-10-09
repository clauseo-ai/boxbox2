# scars

v1's `GOTCHAS.md` (2,039 lines, in the v1 repo) classified for v2. every
entry lands in exactly one class:

- **design out**: caused by v1's architecture or stack. v2's structure
  makes it impossible; the answer names the structure.
- **cmx2**: caused by the old daemon. cmx2 already fixes it, or it is an
  ask in `cmx2-asks.md` (named `a1` to `a12`), or it is a daemon-side
  request outside boxbox's gates ("daemon").
- **law**: a platform or product truth v2 must still obey. the rule is
  stated in one line and is binding on the build.
- **ignore**: incidental, tooling, one-off, or part of what v2 drops.

line numbers point into v1's `GOTCHAS.md` as of 2026-09-30.

## the ten that shape the architecture

| scar | lines | v2 answer |
|---|---|---|
| no cursor, so every reconnect was a guess | 202, 1168, 1413 | a cursor at every hop (decision 16, a1, a2) |
| the reconnect balloon (about 10 gb, the vm hung) | 1438 | caps on every buffer, one reset event per resync, events serialized once (architecture, memory) |
| client-side transcript assembly (vanishing replies, doubled bubbles, stuck turns) | 887, 1079, 1110, 1148, 1159 | parts keyed by daemon ids, deltas at offsets, one reducer (architecture, transcripts) |
| the dual lap: two processes running one session | 775, 782 | cmx2 holds a process-wide run lock and answers 409 `BusyError` (fixed in cmx2 m2) |
| instance-scoped registries and reads that spawn instances | 19, 148, 365, 1095 | cmx2 is one process with one registry; unknown asks 404 (a6) |
| settled frames sent twice, unread coming back | 156 | exactly-once by seq (a1); reducers idempotent |
| the perf layer: an o(fleet) rebuild per frame | 1725 to 1767 | solid's fine-grained store, patches from a worker, cold threads in indexeddb (decision 15) |
| read state and faults computed in several places | 1180, 1185, 1696, 1712 | the server computes needs, read and order once (decision 16) |
| the ios keyboard and viewport lies | 441 | the ios viewport law (decision 19) |
| dead sockets that look alive, and "sent" guessed from an echo | 1633, 1134 | 15 s heartbeat and 45 s byte watchdog on every reader; `clientID` echo (a4) |

## by section

| line | section | class | why | v2 answer |
|---|---|---|---|---|
| 7 | cmx wire contract | cmx2 | untyped union, instance-scoped state, spawning reads, repeated settled frames | typed manifest and generated `openapi.json`; the remaining gaps are asks |
| 200 | resync / fleet architecture | design out | no cursor: every reconnect a full reconcile plus heuristics | decision 16 |
| 212 | web scar tissue | mostly law | ios pwa truths, css traps, wire shapes | see the entries below |
| 628 | dev-on-the-box | design out | prod served `.next` from the tree agents edit | one binary with the ui embedded |
| 703 | ops scar tissue | mixed | dual laps, per-instance registries, sigterm hangs | cmx2 run lock; rust drains on shutdown |
| 1464 | board / firmware | ignore | hardware truths that live with the board | the board is frozen (decision 1) |
| 1597 | board (numpad wedge) | ignore, except 1633 | firmware coupling | 1633 is law for every sse reader |
| 1696 | the undismissable fault | design out | faults derived twice | computed once in the server |
| 1725 | the perf layer | design out | full rebuilds, nothing evicted | decision 15 |
| 1774 | the radio is a wispr key | ignore, except 1779 | board behaviour | name every verb specifically |
| 1839 | dev loop (harness) | law (dev) | harness inherits the password env; `lsof` kills clients | unset the password env for harness daemons; kill listeners only |
| 1864 | dev loop (terminal concepts) | law | emulation fakes no touch; auto grid tracks grow | detect touch three ways; explicit grid tracks |
| 1893 | terminal | cmx2 | websocket upgrade missing; pty exit not an event | cmx2 m4 ships the pty websocket; exit status in `pty.exited` |
| 1946 | worktree | design out | next's generated types | no next |
| 1956 | fleet model rollout | ignore, except 1958 | provider operations | trailing-edge reload is a daemon request |
| 2004 | routing matrix rollout | ignore, except 2006, 2024 | agent files not reloaded; per-instance registry | daemon requests |

## every entry

| line | scar | class | v2 answer |
|---|---|---|---|
| 9 | `GlobalEvent.directory` optional | cmx2 | the envelope is typed in the manifest; trust `openapi.json` |
| 13 | permission metadata is a bare object | cmx2 | a8: typed per-kind metadata |
| 16 | 130-way `anyOf` with no discriminator | cmx2 | fixed: `Event` is a discriminated `oneOf` |
| 19 | a directory header spawns an instance | cmx2 | fixed: one process, no instances |
| 23 | bare `/session` means one project | cmx2 | `/api/session` lists host-wide |
| 29 | roots list is project-wide | cmx2 | same as 23 |
| 32 | scratch sessions as `projectID global` | ignore | identity is `host:session` |
| 36 | context percent includes cache writes | cmx2 | a10: context fill on the wire |
| 49 | compaction arrives as ordinary parts | cmx2 | a8: a typed compaction part; the seam always renders |
| 58 | `session.compacted` enriched | cmx2 | typed payload; the server logs every fold, not only witnessed ones |
| 77 | the session db is host-global | law | tests use nonce titles and clean up |
| 81 | verify on real storage | law | test against real data, not demo daemons |
| 83 | tool names vs permission classes | cmx2 | typed enums in the manifest |
| 86 | tool input keys drift | daemon | one normalized tool-input schema |
| 88 | empty strings instead of absent | daemon | optional means absent; keep a non-empty guard |
| 90 | shell 401 without an agent | cmx2 | typed 400s |
| 95 | status has no timestamp | cmx2 | a7: `since` on status |
| 102 | config cached at instance start | cmx2 | fixed: hot reload |
| 104 | two backends | cmx2 | fixed: one backend |
| 109 | `/global/*` had no auth | cmx2 | one auth layer; tested anyway |
| 115 | `/file` jailed to the project | cmx2 | `/global/fs` |
| 121 | missing files are empty, not 404 | daemon | 404 on missing files |
| 129 | binaries mangled by extension | daemon | sniff magic bytes; typed encoding |
| 138 | a cold instance answers `[]` | law | never negative-cache an empty result |
| 148 | status map per instance | cmx2 | fixed: one process |
| 156 | settled frames sent again | cmx2 | a1; reducers idempotent by seq |
| 164 | verbatim captures as the spec | cmx2 | `openapi.json` replaces captures |
| 169 | the 30 mb byte cap stall | daemon | detect the byte cap and compact |
| 184 | pty wire truths | cmx2 | `pty.exited` carries the exit code |
| 202 | sse live, rest reconcile | design out | decision 16, a1, a2 |
| 206 | undecodable frames skipped | law | log, skip, never kill the stream |
| 208 | optimistic replies clear on `*.replied` | law | the event, from any surface, clears the card |
| 214 | sticky inside a same-height wrapper | law | the sticky parent is the tall container |
| 224 | temporal dead zone in module tables | ignore | |
| 232 | a sheet taller than the window | law | every sheet has a max height of the viewport and scrolls |
| 241 | pickers sized against the keyboard | law | size overlays against the visible viewport minus the keyboard inset |
| 248 | harness daemons inherit the password | law (dev) | unset the password env when starting a harness daemon |
| 256 | agent-browser rect not visible | ignore | |
| 263 | agent-browser shared session | ignore | one namespace per agent |
| 269 | screenshot stall after a viewport change | ignore | |
| 281 | a dialog's grid track grows with content | law | `minmax(0, 1fr)` tracks (hit again in v2's first cut) |
| 290 | controls outside the pane, ghosted on touch | law | in-flow controls, 40 px hit areas, nothing hover-only |
| 300 | device memory never self-primes | design out | defaults come from the fleet model; device prefs only override |
| 314 | tailwind skips `node_modules` | ignore | |
| 319 | ai-elements types broken | ignore | |
| 322 | `suppressHydrationWarning` | design out | no ssr |
| 324 | next dev indicator | design out | no next |
| 326 | shadcn flags | ignore | |
| 328 | the brain lived on `globalThis` through hmr | design out | the server is its own process |
| 333 | idle is not null | cmx2 | typed status union (a8) |
| 337 | `part.delta` shape and the overlay race | cmx2 | typed delta, applied at its offset in one reducer (a1) |
| 341 | permission wire shape | cmx2 | typed |
| 344 | `POST message` blocks for the whole turn | cmx2 | `/prompt` answers 202; the server never buffers or times out a long request |
| 347 | middleware renamed to proxy | design out | no next |
| 349 | repo identity is `machine:tail` | law | repos never merge across hosts |
| 360 | `projectID` flips when a dir becomes a repo | daemon | a `project.updated` event |
| 365 | coverage is a union of instances | cmx2 | host-wide list |
| 371 | envelope `directory` is not always a path | cmx2 | separate typed fields |
| 375 | sessions get heavy (7.8 mb) | law | page transcripts; never hydrate a whole session |
| 379 | prompt body fields | cmx2 | typed prompt body |
| 388 | variants are keys only | law | never hardcode an effort ladder |
| 394 | no variant means no thinking | cmx2 | server-side effort fallback |
| 406 | `/agent` lists hidden agents | daemon | a hidden filter; the ui filters meanwhile |
| 409 | `.glass` is a containing block | law | no fixed-position scrims inside a backdrop-filtered element |
| 416 | detached processes die on sighup | law (dev) | detach for real |
| 419 | a daemon born half-dead | daemon | health reports warmup; the server health-checks each host |
| 433 | satori `boxShadow` | design out | no next/og |
| 437 | deploy docs in `ops/` | ignore | |
| 441 | the iphone keyboard and zoom lies (six) | law | decision 19: no `viewport-fit=cover`, `html` never scrolls, inputs 16 px or larger on touch, keyboard inset only while an editable holds focus, insets floored, no after-the-fact snapping, and the real phone is the only test |
| 559 | placeholder wraps on phone widths | law | budget placeholder length per composer state |
| 574 | hard result caps | law | lists scroll; no silent caps |
| 585 | @ mention wire shape | cmx2 | typed `find` |
| 596 | synthetic text parts | daemon | distinct part kinds (a8) |
| 602 | the simulator shows no soft keyboard | law | keyboard behaviour is verified on the real phone |
| 609 | a consume-and-clear effect cancels itself | law | clear a latch inside the deferred callback |
| 619 | nothing focuses the composer | law | an explicit focus rule for dictation |
| 630 | scroll-snap re-snaps as data streams in | design out | the cache paints the final layout on the first frame; snaps never fight arrivals |
| 646 | agent-browser flags on the box | ignore | |
| 656 | `next dev` in the prod checkout | design out | embedded-asset binary |
| 662 | next dev lock | design out | |
| 668 | `allowedDevOrigins` | design out | vite's `server.allowedHosts` is the same trap: set it |
| 674 | a secure prod cookie shadows the dev cookie | law | dev servers use their own cookie name |
| 682 | agent-browser on the box | ignore | |
| 690 | harness on a password box | law (dev) | credentials in the harness host entry |
| 696 | `source env` strips json quotes | design out | typed toml config |
| 705 | cmx built from a parked branch | ignore | |
| 717 | zsh eats a marker | ignore | |
| 724 | the tailnet name | law | read `tailscale status --json`, never type it |
| 728 | acl drops vm traffic silently | law | box-sourced traffic needs an explicit grant |
| 736 | wrappers need bash | ignore | |
| 740 | env changes need a unit restart | law | restart the service after config changes |
| 744 | gh auth on a bare pty | ignore | |
| 748 | first https hit waits for a certificate | law | retry once |
| 751 | serve and tui open different dbs | cmx2 | one db path, shown in health |
| 764 | launchd caches the plist | law | bootout then bootstrap |
| 768 | api key baked into config | ignore | |
| 775 | two processes run one session loop | cmx2 | fixed: cross-process run lock, 409 |
| 782 | the dual lap (wrong-instance writes) | cmx2 | fixed: one process, run lock, `BusyError`; v2 drops `resolveSessionHome` |
| 814 | harness inherits the password (again) | law (dev) | as 248 |
| 821 | config hot reload | cmx2 | fixed |
| 829 | launchd and tcc stalls | law | binaries outside `~/Documents`, full disk access where needed |
| 842 | copying over a running binary poisons it | law | install by rename, never copy over |
| 854 | `next start` hangs on sigterm | design out | the server drains and exits inside 5 s |
| 871 | a confirm window eats its own tap | law | 5 s windows; failures surface |
| 877 | `touch` proves nothing to inotify | law (dev) | test watchers with real writes |
| 880 | the ask surface had two owners | design out | an ask is one entity in the store |
| 887 | `part.updated` must supersede deltas | design out | one reducer, ordered per part |
| 891 | `lsof` lists clients too | law (dev) | `-sTCP:LISTEN` |
| 894 | `config.updated` not always sent | daemon | reliable emission |
| 901 | "send failed" while units are green | law | the server logs every upstream error with host, route, status, latency |
| 916 | 200 for a nonexistent session | daemon | 404 |
| 922 | the queue is the db | cmx2 | explicit queued messages (`queued: true`), ids from every send (a11) |
| 931 | queued retires on answered | cmx2 | as 922 |
| 938 | phone photos stripped silently | law | clamp images on the client; the daemon should reject loudly |
| 951 | the flush fired twice | cmx2 | a4 makes a repeated flush a no-op |
| 966 | delete a queued message | cmx2 | fixed |
| 971 | unshare route names | cmx2 | generated client |
| 976 | a hand-written proxy allowlist | design out | routes generated from `openapi.json` |
| 981 | `message.removed` unhandled | design out | the reducer is exhaustive; the compiler enforces it |
| 984 | file-tool display bodies | cmx2 | typed tool metadata (a8) |
| 991 | unique accessible names | law | every control has a unique, real name (the automation contract) |
| 1004 | fast models make short busy windows | ignore | |
| 1008 | mail marker eaten by the synthetic filter | daemon | a `mail` part type |
| 1024 | busy for a session the client never saw | design out | the server holds the full sessions index |
| 1035 | shell turns die with the connection | daemon | detach shell from the request; 409 when busy |
| 1044 | mailbox drains had no marker | ignore | |
| 1049 | exec telemetry parsed from prose | daemon | structured exec metadata |
| 1065 | children never in the roots list | cmx2 | `/session/:id/children` and the agents roster |
| 1079 | the settle-vanish race | design out | one event-sourced store |
| 1087 | `shrink-0` on unbounded text | law | one member yields; test with long text |
| 1095 | ask replies instance-scoped, 200 on a miss | cmx2 | a6 |
| 1110 | ask cards seated by the client | design out | the daemon orders the transcript |
| 1118 | an interrupt leaks the ask | cmx2 | a6: reject on abort |
| 1125 | ask buttons without `aria-pressed` | law | toggles and choices expose their state |
| 1134 | send truth guessed from the echo | cmx2 | a4: `clientID` echoed on the events |
| 1148 | ask cards seated by anchor | design out | daemon ordering plus call ids |
| 1159 | pending from the snapshot missed assembly | design out | snapshot and events feed one reducer |
| 1168 | hydration mid-stream | design out | hydrate at a seq, apply later events (a2, a5) |
| 1180 | read marks mixed clocks | design out | the server stamps read state |
| 1185 | read state per device | design out | one read state in the server, max-merged, sent to every surface |
| 1197 | the telemetry dictionary | law | `schema.ts` stays the dictionary; the rust ingest is generated from it (decision 17) |
| 1208 | a prop named like an envelope column | design out | the schema build rejects the collision |
| 1214 | two clocks, one interval | law | pair server and client rows by window; bound client times |
| 1223 | friction detectors false-positive | law | gate detectors; check against a real digest first |
| 1235 | bun utc vs sqlite localtime | design out | explicit utc everywhere |
| 1242 | a fresh worktree has no `.next` | design out | |
| 1246 | push gated by evidence | law, partly superseded | "done" pushes only for armed turns; ios cannot remove banners, so no tidy pushes and one banner per thread tag. the visibility rule is replaced by per-device presence (decision 7) |
| 1267 | a read-only verification door | law | the ui exposes a read-only store handle for test drives |
| 1272 | screenshot pipe stall | ignore | |
| 1282 | two-tap controls via ref | ignore | |
| 1290 | `find label fill` skips input events | ignore | |
| 1295 | the service worker serves stale bundles | law | build id and protocol version in the stream hello; updates apply at the next cold launch |
| 1304 | checkout homes are identity | daemon | explicit parent and worktree fields (cmx2 m6) |
| 1315 | review verbs scoped to the checkout | daemon | worktree verbs by id (cmx2 m6) |
| 1324 | lane vocabulary drifted | design out | one generated, exhaustive enum |
| 1335 | thread urls are composite | law | reject ids that do not parse as `host:session` |
| 1342 | zero-size duplicate controls | law | folded or hidden containers are `inert` |
| 1350 | the theme boot script ran once | design out | a static `index.html` inline script always runs |
| 1361 | subagent spawns dead | ignore | |
| 1377 | permissions have no call id | cmx2 | `tool.callID` on `permission.asked` |
| 1388 | `costUsd` starves | cmx2 | a10 |
| 1400 | `pkill -f` matches itself | law (dev) | kill by port |
| 1413 | worktree preparing forever | cmx2 | a1 replay, cmx2 m6 worktree state |
| 1438 | the reconnect balloon (the sep-2 stall) | design out | every buffer capped, one reset event per resync, events serialized once and shared, streams closed when slow (architecture, memory) |
| 1469 to 1489 | firmware (rgb matrix, via, key orders, ws2812) | ignore | the board is frozen |
| 1497 | board verb vs serving verbs | design out | typed verb enum in the schema |
| 1505 | no user agent means desktop | design out | explicit, validated `device_class` |
| 1513 | a permission reject cascades | cmx2 | a6; until then reject is armed as destructive |
| 1518 | two backends (board spec) | cmx2 | fixed |
| 1525 | the brain needed a dev restart | design out | the server is its own process |
| 1535 to 1590 | led palette, levels, flashing, node-hid, wispr keys | ignore | the board is frozen |
| 1604 to 1626 | hold detectors, key release, mode echo | ignore | the board is frozen |
| 1633 | an established sse socket that is dead | law | 15 s heartbeat; every reader aborts after 45 s without a byte |
| 1641 | 60 fps loops earn every write | ignore | board daemon |
| 1651 | launchd path | law | explicit `PATH` in plists |
| 1658 to 1685 | board clock, own kill, tcc mic, ffmpeg | ignore | the board is frozen |
| 1712 | fault comparison in both derivations | design out | computed once in the server |
| 1715 | a failed checkout cannot be read away | law | product rule, kept |
| 1717 | the needs clock split across routes | design out | the server owns needs and their telemetry |
| 1720 | dismiss fault vs mark read | design out | one server route per verb |
| 1735 | identity is the contract | design out | structural sharing in the store |
| 1744 | batch notifications | design out | patches coalesced once per frame |
| 1749 | rebuild debounced on wire paths | design out | incremental reducers; heavy derivation in the server |
| 1754 | threads evicted on route-away | design out | indexeddb pages and lru eviction |
| 1763 | a global subscription hook | design out | components read store paths only |
| 1768 | briefs repeating the build rule | design out | no shared tree |
| 1779 | a generic label hid the radio | law | name every verb specifically in telemetry |
| 1787 to 1823 | wispr hands-free, radio, grid bank, calc | ignore | the board is frozen |
| 1841 | harness boots gated (again) | law (dev) | as 248 |
| 1850 | `lsof` kills clients (again) | law (dev) | as 891 |
| 1855 | synthetic wheel ignored | ignore | |
| 1866 | an emulated phone is not touch | law | detect touch by pointer, touch points and user agent |
| 1876 | a bare grid track is `auto` | law | explicit tracks |
| 1885 | a backgrounded serve dies on sighup | law (dev) | as 416 |
| 1895 | websocket upgrade missing | cmx2 | fixed in m4 |
| 1905 | xterm has no dom scroll | law | read `buffer.viewportY` |
| 1912 | a pane keyed on a pty id that vanishes | law | remember the last live id |
| 1918 | the resume cursor only for dropped sockets | law | first dial replays everything; redials pass the cursor |
| 1924 | right-prompt scrape | ignore | |
| 1929 | agent-browser target drift | ignore | |
| 1934 | login shell eats the first command | ignore | |
| 1948 | phantom `RouteContext` errors | design out | no next |
| 1958 | hot reload misses the last edit | daemon | trailing-edge reload |
| 1966 to 1984 | provider operations | ignore | |
| 1995 | password from the shell env is flaky | law (dev) | read the service's env file |
| 2006 | agent markdown not hot-reloaded | daemon | reload agent and command dirs |
| 2024 | `GET /agent` per instance | cmx2 | fixed: one registry per process |
| 2030 | rsync clobbers per-machine files | ignore | |

two things have no entry of their own in v1: the
build-version handshake (closest: 1295; v2 puts the build id and protocol
version in the stream hello) and the f1 identity (never a scar; dropped by
decision 3).
