# boxbox v2. every recipe prints what it runs; see AGENTS.md, commands.

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# install every dependency from the lockfiles
setup:
    bun install --frozen-lockfile

# the cmx2 dev daemon from the commit in cmx2.pin on 4840, with the bench model on 4841
cmx2 *flags:
    bun scripts/cmx2.ts {{ flags }}

# the openclaw dev gateway from the commit in openclaw.pin on 4740, scripted model on 4741, speech stub on 4742
openclaw *flags:
    bun scripts/openclaw.ts {{ flags }}

# one pass over the verbs boxbox uses, against the running dev gateway, each step printed
openclaw-smoke:
    bun bench/openclaw-smoke.ts

# the contract probes for cmx2's asks: starts the pinned daemon on <port> (bench model on the next), prints the per-ask table
probes port *asks:
    bun probes/run.ts {{ port }} {{ asks }}

# the idle-cost run: cpu, heap and bytes of the built app while a fleet streams (home, a thread, hidden); needs `just build`
idle *flags:
    bun bench/idle.ts {{ flags }}

# the boxbox dev server on 3001 against the dev daemon: rust rebuilt on change, vite proxied
dev:
    bun scripts/dev.ts

# a push delivered to a real chrome with the app closed, its payload and telemetry printed (docs/push.md)
push-harness *flags:
    bun scripts/push-harness.ts {{ flags }}

# re-copy openapi.json and manifest.ts from the commit in cmx2.pin, and the openclaw protocol schema from its npm tarball
vendor *flags:
    bun scripts/vendor.ts {{ flags }}

# regenerate the app's api types from the server and the vendored contract
api:
    cargo build --quiet
    bun scripts/gen-api.ts

# regenerate telemetry/schema.json from telemetry/schema.ts
dictionary:
    bun scripts/telemetry.ts dictionary --json > telemetry/schema.json

# fmt, clippy (warnings denied), tsc, unit tests, drift tests, the pin, the board, the public check
check:
    cargo fmt --check
    cargo clippy --all-targets --locked -- -D warnings
    bunx tsc --noEmit -p .
    bunx tsc --noEmit -p app
    bunx tsc --noEmit -p app/src/push
    bunx tsc --noEmit -p app/.ladle
    cargo test --locked
    bun test telemetry board probes app
    bun test --conditions browser app/src/ui/thread/live.reactive.test.ts app/src/ui/thread/holds.reactive.test.ts app/src/ui/thread/stage-window.reactive.test.ts app/src/ui/thread/kin.reactive.test.ts app/src/ui/thread/released.reactive.test.ts app/src/ui/thread/strip.reactive.test.ts app/src/ui/clock.reactive.test.ts app/src/ui/home/fleet.reactive.test.ts app/src/ui/home/views.reactive.test.ts app/src/ui/home/streaming.reactive.test.ts app/src/ui/home/toast.reactive.test.ts app/src/ui/composer/new-thread.reactive.test.ts app/src/sync/two-wire.test.ts app/src/sync/frame-time.reactive.test.ts
    cargo build --locked --quiet
    bun scripts/gen-api.ts --check
    bun scripts/vendor.ts --check
    scripts/check-public.sh

# the linux release: a static binary per architecture, install.sh and SHA256SUMS in target/dist (docs/deploy.md)
release *flags:
    ops/release/build.sh {{ flags }}

# the mac release: boxbox for apple silicon, packed into target/dist beside the linux ones, SHA256SUMS rewritten (docs/deploy.md)
release-mac *flags:
    ops/release/mac.sh {{ flags }}

# the linux release cross-compiled on this mac with zig, minutes instead of emulation (docs/deploy.md, releases)
release-zig *flags:
    ops/release/zig.sh {{ flags }}

# the release binary with the app embedded
build:
    cd app && bunx vite build
    bun scripts/compress.ts
    cargo build --release --locked -p boxbox
    ls -l target/release/boxbox

# the board daemon's release binary, stripped by the profile (docs/board.md)
board-build:
    cargo build --release --locked -p boxbox-board
    ls -l target/release/boxbox-board

# the board daemon installed on this mac: signed, its config made, its launch agent loaded
board-install: board-build
    target/release/boxbox-board install
