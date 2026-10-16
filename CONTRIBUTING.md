# contributing

thanks for looking. boxbox is small and strict, so read this before a first
pull request.

boxbox is one place to control every agent: a server that watches agents of
any kind and clients that show their work. cmx2 is supported, openclaw and
hermes are being added, and claude code and codex are planned. support for a
new kind of agent is the most natural contribution: it is a source behind
the seam in `docs/agents.md` (the agent source seam), with its capabilities
declared, a `boxbox.toml` entry, and a dev gateway or daemon in the bench
with a scripted model so the checks never call a paid api. open an issue
before you start one, so the kind gets a milestone in `docs/plan.md`.

## setup

you need rust 1.92.0 (rustup installs it from `rust-toolchain.toml`), bun
1.3.14 and just 1.51.0. running the dev daemon also needs a checkout of
[cmx2](https://github.com/clauseo-ai/cmx2) at `../cmx2`, or at the path in
`CMX2_REPO`.

```sh
just setup    # dependencies from the lockfiles
just cmx2     # a cmx2 dev daemon from the commit in cmx2.pin (4840) and a scripted model (4841)
just dev      # the boxbox dev server on 3001 against it
just check    # fmt, clippy with warnings denied, tsc, unit tests, drift tests, the pin, the board
```

`just check` is what ci runs, on a fresh clone and with no private files.
make it pass before you open a pull request. none of these commands call a
paid model api, because the dev daemon runs against a scripted model.

## the rules that bite most often

`AGENTS.md` is the full contract. these are the ones people trip on.

- **verification climbs.** types, then unit tests, then a real daemon driven end to end,
  then devices, then budgets (`docs/verification.md`). a passing build is not
  verification. integration runs against a real cmx2 daemon, never a mock.
- **nothing is decoded by hand.** cmx2's types come from
  `vendor/cmx2/openapi.json`, boxbox's own api is described with utoipa,
  and the telemetry ingest is generated from `telemetry/schema.ts`.
  regenerate with `just api` and `just dictionary`.
- **a source never leaks its runtime.** a new kind maps into contract 2's
  shapes and publishes capabilities; a client never switches on the source.
- **docs move with the code.** the change that makes a doc wrong fixes it
  in the same commit.
- **the cmx2 pin moves on purpose.** edit `cmx2.pin`, run `just vendor` and
  `just check`, run the probes in `docs/verification.md`, and say in
  `CHANGELOG.md` what changed in the contract.
- **the board is frozen.** only `board/daemon/src/client.ts` changes.
  `board/checksums.test.ts` holds every other file to its recorded hash.
- **a gap in cmx2 is an ask, not a workaround.** describe it in
  `docs/cmx2-asks.md` and open an issue on cmx2 asking for it.
- **every buffer has a cap and every map an eviction rule.** budgets have
  numbers and a gate.
- **copy is lowercase, plain and specific.** errors say what happened and
  what to do.
- **dependencies earn their place.** add each one to `THIRD_PARTY.md` with
  its licence.
- **keep your own setup out of commits.** no machine names, hostnames,
  credentials or personal paths in code, docs or fixtures. use placeholders.
  `scripts/check-public.sh` fails on any pattern you give it through
  `BOXBOX_PRIVATE_PATTERN`, and passes with a notice when you give it none.

## pull requests

keep each one to a single change, with tests for the behaviour it adds. say in
the description what you ran and what you did not. commit messages are short
and plain.

by contributing you agree your work is licensed under the MIT licence in
`LICENSE`. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to every
project space.
