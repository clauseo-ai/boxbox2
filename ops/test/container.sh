#!/bin/sh
# the ops test (docs/deploy.md, testing a release): a release from
# target/dist (ops/release/build.sh) installed and run on a clean linux
# machine in a container, against the cmx2 daemon from ops/test/daemon.ts.
#
#   bun ops/test/daemon.ts &           # the pinned daemon on 127.0.0.1:4900
#   ops/test/container.sh [aarch64|x86_64]
#
# the machine boots systemd with a lingering user; ops/test/inside.sh runs
# as that user and prints the evidence. the container is removed however
# the test ends.
set -eu

cd "$(dirname "$0")/../.."
fail() { echo "ops test: $*" >&2; exit 1; }

arch="${1:-aarch64}"
case "$arch" in
  aarch64) platform=linux/arm64 ;;
  x86_64) platform=linux/amd64 ;;
  *) fail "usage: ops/test/container.sh [aarch64|x86_64]" ;;
esac
[ -f target/dist/SHA256SUMS ] || fail "no release in target/dist: run ops/release/build.sh first"
[ -f /tmp/boxbox-ops-bench/password ] || fail "no daemon password: start bun ops/test/daemon.ts first"

image="boxbox-ops-systemd:$arch"
name="boxbox-ops-test-$arch"
echo "ops test: building the $platform machine"
docker build --quiet --platform "$platform" -t "$image" -f ops/test/systemd.Dockerfile ops/test >/dev/null

docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT TERM
# host.docker.internal is the machine running the daemon (built in on
# docker desktop and orbstack, host-gateway on a linux docker)
docker run -d --name "$name" --platform "$platform" --privileged \
  --tmpfs /run --tmpfs /run/lock \
  --add-host host.docker.internal:host-gateway \
  "$image" >/dev/null

docker exec "$name" mkdir -p /release
docker cp target/dist/. "$name:/release/"
docker cp /tmp/boxbox-ops-bench/password "$name:/release/bench-password"
docker cp ops/test/inside.sh "$name:/release/inside.sh"
docker exec "$name" sh -c 'chown -R ops:ops /release && chmod 600 /release/bench-password'

# `is-system-running --wait` answers at once if pid 1 is not up yet, so poll
state=""
for _ in $(seq 150); do
  state="$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 0.2
done
case "$state" in running|degraded) ;; *) fail "systemd did not finish booting (state \"$state\")" ;; esac
# degraded is expected: a container cannot load kernel modules
echo "ops test: systemd is $state on $(docker exec "$name" uname -m), $(docker exec "$name" systemctl --version | head -n 1)"
docker exec "$name" sh -c 'for i in $(seq 150); do [ -S /run/user/1000/bus ] && exit 0; sleep 0.2; done; exit 1' \
  || fail "the ops user's manager did not start"

docker exec -u ops -w /home/ops -e XDG_RUNTIME_DIR=/run/user/1000 \
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  "$name" sh /release/inside.sh
