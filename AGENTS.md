# boxbox, notes for coding agents

boxbox is a client for cmx2, a coding-agent runtime that runs one daemon per
machine. a small rust server watches every daemon, and a web app installed
to the home screen shows the agents' work on a phone, a tablet or a laptop.
a 17-key hardware board is a second client. `README.md` explains the
project and `docs/README.md` maps the code. this file is the contract for
anyone changing it, human or agent.

the standard is the same everywhere. code, logs, error copy, empty states,
edge cases and tests get the care the screens get. nothing ships by
accident of a default, and nothing waits for a polish pass.

## read order

`docs/README.md`, then `docs/decisions.md`, `docs/design.md`,
`docs/architecture.md`, `docs/scars.md`, `docs/cmx2-asks.md`,
`docs/plan.md` and `docs/verification.md`, then the milestone you are on.
read `docs/gotchas.md` before touching an area it mentions. `docs/open.md`
is the one list of what is known wrong on main. a fix starts there and
moves what it closes to the bottom, in the same commit.

## golden rules

1. **everything on day one.** the milestones in `docs/plan.md` order the
   work and do not shrink it. there are no phases, no mvp and no "later".
2. **claims discipline.** never call anything verified, working or done
   unless you drove it end to end against a real running cmx2 daemon in
   this session and can point to the printed evidence. a passing build is
   not verification, and neither is a unit test.
3. **narrowest tier first** (`docs/verification.md`): types, unit, real
   loop, devices, budgets. climb only as far as the question needs. every
   milestone gate needs its full tier.
4. **no mocks in integration tests.** run against a real cmx2 daemon.
   fixtures are only for wire parsing, recorded from a real daemon.
5. **accessibility is the automation contract.** every interactive element
   has a real, unique accessible name, and verification drives the
   accessibility tree. a control it cannot name is a bug.
6. **the design law is binding.** `docs/design.md` decides layout, type,
   colour, depth, motion and every budget. do not invent ui it does not
   describe. if the law is silent, match the screens that exist and record
   what you decided in `docs/design.md` in the same change.
7. **memory and latency are features.** every buffer has a byte cap and an
   owner, every map has an eviction rule, and every budget in
   `docs/design.md` and `docs/architecture.md` has a `perf.*` telemetry
   row and a gate. measure in the loop, not at the end. a change that
   regresses a budget does not land.
8. **gaps in cmx2 are asks, never workarounds** (decision 9). append the
   gap to cmx2's `docs/engineering/ASKS.md` as an unassigned row (see
   "cmx2" below), argue it in `docs/cmx2-asks.md`, and never patch around
   it in boxbox. if the gap blocks the milestone, say so in your report
   and stop.
9. **the board is frozen** (decisions 1, 11, 14). only
   `board/daemon/src/client.ts` changes. a checksum test holds every other
   board file to the v1 bytes.
10. **telemetry kinds are never renamed.** new kinds go into
    `telemetry/schema.ts`. outcomes are honest (`ok` comes from the echo,
    not the local call), and labels never carry user content.
11. **copy follows the voice.** lowercase, plain verbs, no em or en
    dashes, no emojis, no corporate speak. errors say what happened and
    what to do, and never apologise.
12. **this is a public repo.** nothing in code, config, docs or fixtures
    identifies a real person's machines, hosts, repos, credentials or
    usage data. describe setups as patterns with placeholder names.
13. **leave running daemons and servers alone.** never restart, kill,
    reload or point a dev build at a cmx2 daemon or boxbox server you did
    not start for the dev loop. the cmx2 dev daemon runs on a port from
    4840 to 4849, the boxbox dev server on 3001.
14. **one dev server at a time, and kill what you start**, with `ps`
    printed before a task completes. stop a process by the pid you noted
    or the one `lsof` finds on your own port, never with `pkill` or
    `killall` by name or pattern. parallel worktrees run the same command
    lines (`docs/gotchas.md`, parallel lanes).
15. **dependencies earn their place.** good libraries that make the code
    faster and more reliable are fine. nothing for a trivial utility, no
    abandoned crates or packages, and every addition goes into
    `THIRD_PARTY.md` with its licence.
16. **commits** say what changed and why, in plain words. no attribution
    trailers and no "generated with" lines.
17. **feed `docs/gotchas.md`** the moment something bites, so nobody pays
    for it twice.
18. **no time estimates.** report outcomes with evidence, worse news
    first. if a test fails, say so and show the output.
19. **scratch projects and harness serves live under `/tmp`**, never inside
    this repo or next to its worktrees. a project inside a git checkout
    makes every sibling worktree part of it (`docs/gotchas.md`, the board
    trace harness).
20. **a worktree that finds the main checkout dirty with someone else's
    work stops.** it lands nothing, leaves that work alone, and reports
    the exact landing command for its own branch.

## cmx2

- **where.** boxbox needs a cmx2 checkout beside it (`../cmx2`, or the path
  in `CMX2_REPO`). read it. never edit its code and never run anything from
  its working tree.
- **the pin.** `cmx2.pin` holds the one cmx2 commit boxbox builds against.
  `vendor/cmx2/openapi.json` and `vendor/cmx2/manifest.ts` are copied from
  that commit, byte for byte (`git -C <cmx2 checkout> show
  <pin>:packages/client/openapi.json` and
  `<pin>:packages/contract/src/manifest.ts`). `just check` fails if they
  differ from the pinned commit. every generated type comes from the
  vendored files.
- **moving the pin** is a deliberate step, never a side effect. update
  `cmx2.pin`, run `just vendor`, regenerate, run `just check`, run the
  probes in `docs/verification.md`, and record the move in `CHANGELOG.md`
  with what changed in the contract.
- **the dev daemon.** it runs from the pinned commit, not the working tree.
  `just cmx2` exports the commit with `git archive` into `.cmx2/<pin>/`
  (gitignored), installs it, and starts it on a port from 4840 to 4849 with
  its own data dir and a bench password, never an inherited one. the boxbox
  dev server runs on 3001 against it.
- **gaps.** when boxbox needs something the pinned cmx2 does not serve,
  append a row to cmx2's `docs/engineering/ASKS.md` table
  (`| aN | ask | unassigned | shape |`, the next free number), write the
  evidence and argument as a section in `docs/cmx2-asks.md` under the same
  number, and stop at the gate if the milestone needs it. that row is the
  only edit boxbox ever makes in the cmx2 repo. never work around a gap in
  boxbox.

## engineering standard

### rust (`server/`)

- edition 2024, `#![forbid(unsafe_code)]`, `clippy::pedantic` with warnings
  denied, `cargo fmt`.
- no `unwrap`, `expect` or `panic!` outside tests and startup
  configuration. errors are typed (`thiserror`), mapped to http in one
  place, and logged once with structured fields (`tracing`).
- state has one owner, a task, and moves by message. every channel is
  bounded and says what happens when it is full. no locks on the hot path.
- nothing blocks the async runtime. sqlite lives on its writer thread, and
  file io goes through `spawn_blocking` or the writer.
- payloads are serialized once and shared (`Bytes`, `Arc<str>`), never
  re-serialized per listener.
- modules mirror the tasks in `docs/architecture.md`. names say what things
  are, with no abbreviations beyond the domain's own (`seq`, `id`, `pty`).

### typescript (`app/`, `board/daemon/src/client.ts`)

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. no
  `any`. a non-null assertion carries a comment proving it.
- decoders are generated, never hand-written. the reducer is exhaustive
  over the event union, with a `never` check the compiler enforces.
- state lives in the store. components read store paths and hold no
  shadow copies. the worker owns the stream, the cursor and indexeddb.
- motion obeys the law. only transform, opacity, clip-path and filter
  animate. layout is measured once per transition (flip), never read inside
  a frame loop, and the owner of every timer and listener clears it.
- no global mutable singletons outside the store.

### everywhere

- comments explain why, not what. no commented-out code. a `todo` needs an
  entry in `docs/open.md`.
- tests read like documentation of the behaviour. they are named for what
  they prove, pure logic is unit-tested, and integration runs against a real
  daemon.
- logs are for the person debugging at 2 am: one line per event, with host,
  route, status, latency and the id that ties it together.

## commands

| command | does |
|---|---|
| `just setup` | every dependency from the lockfiles (the board keeps its own) |
| `just cmx2` | the dev daemon from the pinned commit on a port from 4840 to 4849, with the bench model beside it |
| `just dev` | the boxbox dev server on 3001 (rust with hot rebuild plus vite), one process tree, against the dev daemon |
| `just probes <port> [aN ...]` | the contract probes for cmx2's asks against the pinned daemon they start on `<port>`, with a per-ask table (`docs/verification.md`) |
| `just vendor` | re-copies `openapi.json` and `manifest.ts` from the commit in `cmx2.pin` |
| `just api` | regenerates the app's api types (boxbox's utoipa document and the vendored cmx2 one) |
| `just dictionary` | regenerates `telemetry/schema.json` from `telemetry/schema.ts` |
| `bun bench/session.ts [--words N]` | the scripted session against the dev daemon |
| `just check` | fmt, clippy (warnings denied), `tsc --noEmit`, unit tests, schema drift, vendored cmx2 files against the pin, board checksums |
| `just build` | the release binary with the app embedded |
| `just release [--allow-dirty] [arch]` | the linux release (static, aarch64 and x86_64) with `install.sh` and `SHA256SUMS` in `target/dist` (`docs/deploy.md`) |
| `boxbox init` and `boxbox doctor` | write a first `boxbox.toml` (0600, never over an existing one), and report whether an install can run, redacted |
| `bun scripts/telemetry.ts schema \| examples \| query` | the telemetry dictionary and query tool |

## working in milestones

work in the milestones from `docs/plan.md`. each one ends with printed
evidence: test output, request logs, screenshots described, rss and timing
numbers, telemetry rows. if a milestone cannot finish, report what is done,
what is verified, what is not, and the exact next command.
