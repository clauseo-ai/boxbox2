# boxbox, notes for coding agents

boxbox is one place to control every agent. a small rust server watches
agents of any kind, each through a source behind one seam (`docs/agents.md`,
the agent source seam), and computes the fleet once (threads, needs, order,
read state, tails). the clients show the agents' work and send verbs back:
a web app installed to the home screen on a phone, a tablet or a laptop, a
17-key hardware board, and a native ios app in its own repository.

the kinds: cmx2, a coding-agent runtime with one daemon per machine, is
supported; openclaw assistants are being built (m9); hermes is next (m10);
claude code and codex are planned. a new kind of agent is a new source
behind the seam and a new `boxbox.toml` entry, never a change to the wire
or a client switch on the source (decisions 28 and 30). `README.md`
explains the project and `docs/README.md` maps the code.

this file holds facts and the constraints that protect something real. how
much process a change gets is yours to judge: a one-line fix and a new
subsystem deserve different amounts of ceremony.

## product

- **thin clients.** the server computes needs, order, read state and tails
  (decision 16); the web app, the board and the ios app render them and
  send verbs back.
- **design law.** `docs/design.md` decides layout, type, colour, depth,
  motion and every budget; `home.md`, `thread.md`, `composer.md` and
  `terminal.md` extend it and bind the same way. where the law is silent,
  match the screens that exist and record what you decided in
  `docs/design.md`.
- **copy:** lowercase, plain verbs, no em or en dashes, no emojis, no
  corporate speak. errors say what happened and what to do, and never
  apologise.
- **memory and latency** are features. every buffer has a byte cap and an
  owner, every map an eviction rule, and every budget in `docs/design.md`
  and `docs/architecture.md` has a `perf.*` telemetry row and a gate. a
  change that regresses a budget does not land.
- **accessibility** is the automation contract: every interactive element
  has a real, unique accessible name, and verification drives the
  accessibility tree.
- **the bar:** code, logs, error copy, empty states, edge cases and tests
  get the care the screens get. nothing ships by accident of a default.

## constraints

- **the live fleet.** never restart, kill, reload or point a dev build at a
  cmx2 daemon, boxbox server or production machine you did not start. those
  are someone's daily tools. the dev daemon runs on a port from 4840 to
  4849, the boxbox dev server on 3001.
- **dev processes.** stop what you start by the pid you noted or the one
  `lsof` finds on your own port, never `pkill` or `killall` by name or
  pattern: parallel worktrees run the same command lines (`docs/gotchas.md`,
  parallel lanes).
- **scratch in /tmp.** scratch projects and harness worlds live under
  `/tmp`, never inside this repo or next to its worktrees: a project inside
  a git checkout makes every sibling worktree part of it.
- **someone else's work.** a main checkout dirty with someone else's work is
  left alone; land nothing onto it and say how your branch would land.
- **public repo.** nothing in code, config, docs or fixtures identifies a
  real person's machines, hosts, repos, credentials or usage data. describe
  setups as patterns with placeholder names.
- **secrets** stay out of code, logs, fixtures and commits.
- **commits:** only your own files, saying what changed and why. no
  attribution trailers or "generated with" lines. never bypass git hooks.
- **cmx2** is read, never edited (see below). its gaps are asks, never
  workarounds in boxbox (decision 9).
- **the board is frozen** (decisions 1, 11, 14). only
  `board/daemon/src/client.ts` changes; a checksum test holds every other
  board file to the v1 bytes.
- **telemetry.** kinds are never renamed; new kinds go into
  `telemetry/schema.ts`. outcomes are honest (`ok` comes from the echo, not
  the local call), and labels never carry user content.
- **dependencies** earn their place: no crate or package for a trivial
  utility, nothing abandoned, and every addition in `THIRD_PARTY.md` with
  its licence.

## working

- debug by reading the code first. reproduce when it helps confirm a
  theory, not as a gate.
- claims: say what you checked and how. never call something verified that
  you did not check.
- when something bites, add it to `docs/gotchas.md`.
- **docs move with the code.** the change that makes a doc wrong fixes it
  in the same commit; docs are not a separate pass.

## cmx2

- **where.** a cmx2 checkout beside this one (`../cmx2`, or `CMX2_REPO`).
  read it; never edit its code and never run anything from its working
  tree.
- **the pin.** `cmx2.pin` holds the one cmx2 commit boxbox builds against.
  `vendor/cmx2/openapi.json` and `vendor/cmx2/manifest.ts` are copied from
  it byte for byte (`just vendor`), every generated type comes from them,
  and `just check` fails if they drift.
- **moving the pin** is deliberate, never a side effect: `just vendor`,
  regenerate, the probes in `docs/verification.md`, and a `CHANGELOG.md`
  entry saying what changed in the contract.
- **the dev daemon** runs from the pinned commit, not the working tree:
  `just cmx2` exports it into `.cmx2/<pin>/` (gitignored) and starts it on a
  port from 4840 to 4849 with its own data dir and a bench password.
- **gaps.** the only edit boxbox makes in the cmx2 repo is a row appended to
  its `docs/engineering/ASKS.md` table (`| aN | ask | unassigned | shape |`,
  the next free number), argued under the same number in
  `docs/cmx2-asks.md`.

## engineering

### rust (`server/`)

- edition 2024, `#![forbid(unsafe_code)]`, `clippy::pedantic` with warnings
  denied, `cargo fmt`.
- no `unwrap`, `expect` or `panic!` outside tests and startup
  configuration. errors are typed (`thiserror`), mapped to http in one
  place, and logged once with structured fields (`tracing`).
- state has one owner, a task, and moves by message. every channel is
  bounded. nothing blocks the async runtime: sqlite lives on its writer
  thread, file io goes through `spawn_blocking` or the writer.
- payloads are serialized once and shared (`Bytes`, `Arc<str>`).

### typescript (`app/`, `board/daemon/src/client.ts`)

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. no
  `any`; a non-null assertion carries a comment proving it.
- decoders are generated, never hand-written. the reducer is exhaustive
  over the event union, checked with `never`.
- state lives in the store; components hold no shadow copies, and there
  are no global mutable singletons outside it. the worker owns the stream,
  the cursor and indexeddb.
- only transform, opacity, clip-path and filter animate. layout is measured
  once per transition, never inside a frame loop. whoever starts a timer or
  listener clears it.

### everywhere

- **integration tests** run against a real cmx2 daemon, never a mock.
  fixtures are only for wire parsing, recorded from a real daemon.
- comments explain why, not what. no commented-out code. a `todo` needs an
  entry in `docs/open.md`.
- logs: one line per event, with host, route, status, latency and the id
  that ties it together.

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
| `just check` | fmt, clippy (warnings denied), `tsc --noEmit`, unit tests, schema drift, vendored cmx2 files against the pin, board checksums. what ci runs |
| `just build` | the release binary with the app embedded |
| `just release [--allow-dirty] [arch]` | the linux release (static, aarch64 and x86_64) with `install.sh` and `SHA256SUMS` in `target/dist` (`docs/deploy.md`) |
| `boxbox init` and `boxbox doctor` | write a first `boxbox.toml` (0600, never over an existing one), and report whether an install can run, redacted |
| `bun scripts/telemetry.ts schema \| examples \| query` | the telemetry dictionary and query tool |

## where knowledge lives

- `docs/README.md`: the pieces, the words, how a request travels.
- `docs/decisions.md`: every locked decision; a change is a new row.
- `docs/plan.md`: the milestones and their order.
- `docs/architecture.md`: how the server and app are built, with budgets.
- `docs/design.md`: the design law; `home.md`, `thread.md`, `composer.md`,
  `terminal.md`, `push.md` go deep on one surface each.
- `docs/agents.md`, `docs/openclaw.md`: agents beyond cmx2, and the openclaw
  source.
- `docs/verification.md`: the bench and the verification tiers;
  `docs/board-verification.md` for the board.
- `docs/cmx2-asks.md`: the argument for each cmx2 ask.
- `docs/gotchas.md`: what bit during the build; `docs/scars.md`: v1's,
  classified.
- `docs/open.md`: what is known wrong or unproven on main.
- `docs/deploy.md`: installing on a mac or a vm.
