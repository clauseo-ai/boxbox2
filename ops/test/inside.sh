#!/bin/sh
# runs inside the ops test machine as the lingering user (ops/test/container.sh):
# install.sh, init, doctor, the unit under the user's systemd, a signed-in
# read of the daemon, the memory limit as the kernel holds it, and a drain
# on stop with a stream open. every step prints its evidence; any surprise
# stops the test.
set -eu

step() { printf '\n== %s\n' "$*"; }
fail() { echo "ops test: $*" >&2; exit 1; }
gate="the ops gate password"
base="http://127.0.0.1:3041"
arch="$(uname -m)"

step "install.sh into a clean temp HOME"
clean="$(mktemp -d)"
HOME="$clean" sh /release/install.sh --from /release
HOME="$clean" "$clean/.local/bin/boxbox" --version
ls -l "$clean/.local/bin" "$clean/.config/systemd/user"

step "install.sh again over it: a replace by rename, the old one kept"
old_inode="$(stat -c %i "$clean/.local/bin/boxbox")"
HOME="$clean" sh /release/install.sh --from /release
new_inode="$(stat -c %i "$clean/.local/bin/boxbox")"
previous_inode="$(stat -c %i "$clean/.local/bin/boxbox.previous")"
echo "inodes: old $old_inode, new $new_inode, previous $previous_inode"
[ "$old_inode" != "$new_inode" ] && [ "$old_inode" = "$previous_inode" ] \
  || fail "the binary was not replaced by rename"
leftovers="$(find "$clean" -name '.boxbox.new.*')"
[ -z "$leftovers" ] || fail "staged files were left behind: $leftovers"

step "install.sh refuses a tampered tarball"
bad="$(mktemp -d)"
cp /release/* "$bad/"
# sh does not expand a glob in a redirection, so name the file first
for tarball in "$bad"/boxbox-*-"$arch"-linux.tar.gz; do printf 'x' >>"$tarball"; done
tampered="$(mktemp -d)"
if HOME="$tampered" sh /release/install.sh --from "$bad"; then fail "a tampered tarball was installed"; fi
[ ! -e "$tampered/.local/bin/boxbox" ] || fail "a tampered tarball left a binary"
echo "refused, and $tampered/.local/bin/boxbox does not exist"

step "install.sh for this user"
sh /release/install.sh --from /release
export PATH="$HOME/.local/bin:$PATH"

step "systemd-analyze verify"
systemd-analyze --user verify "$HOME/.config/systemd/user/boxbox.service"
echo "systemd-analyze --user verify: exit $?, no findings above"

step "boxbox init from flags"
printf '%s\n' "$gate" | boxbox init --password-file - --listen 127.0.0.1:3041 \
  --host bench=http://host.docker.internal:4900 --host-password-file bench=/release/bench-password
stat -c '%a %U %n' "$HOME/.config/boxbox" "$HOME/.config/boxbox/boxbox.toml"
grep -v password "$HOME/.config/boxbox/boxbox.toml" | grep -v '^#' | grep -v '^$'

step "init refuses to write over it, and names an exposed one"
if printf '%s\n' "$gate" | boxbox init --password-file -; then fail "init wrote over a config"; fi
chmod 644 "$HOME/.config/boxbox/boxbox.toml"
if printf '%s\n' "$gate" | boxbox init --password-file -; then fail "init wrote over a config"; fi
step "serve and doctor refuse the exposed config"
if boxbox serve 2>&1; then fail "serve ran with a config others can read"; fi
if boxbox doctor; then fail "doctor passed a config others can read"; fi
chmod 600 "$HOME/.config/boxbox/boxbox.toml"

step "doctor before the first start"
boxbox doctor

step "the unit starts under the user's systemd"
systemctl --user daemon-reload
systemctl --user enable --now boxbox
for _ in $(seq 50); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/api/hosts" || true)"
  [ "$code" = 401 ] && break
  sleep 0.2
done
echo "GET /api/hosts without a session -> $code"
[ "$code" = 401 ] || fail "the gate did not answer"
systemctl --user status boxbox --no-pager --lines 0 | sed -n '1,4p'

step "the limits, as systemd and the kernel hold them"
systemctl --user show boxbox -p MemoryMax -p MemoryHigh -p TimeoutStopUSec -p KillSignal -p Restart -p UMask
pid="$(systemctl --user show boxbox -p MainPID --value)"
cgroup="$(cut -d: -f3 "/proc/$pid/cgroup")"
echo "cgroup $cgroup: memory.max $(cat "/sys/fs/cgroup$cgroup/memory.max"), memory.high $(cat "/sys/fs/cgroup$cgroup/memory.high")"

step "signed in, the daemon as boxbox sees it"
cookie="$(curl -s -D - -o /dev/null -H 'content-type: application/json' \
  -d "{\"password\":\"$gate\"}" "$base/api/login" | sed -n 's/^set-cookie: \([^;]*\).*/\1/Ip' | tr -d '\r')"
[ -n "$cookie" ] || fail "no session cookie from /api/login"
echo "POST /api/login -> ${cookie%%=*}=(redacted)"
for _ in $(seq 50); do
  hosts="$(curl -s -H "cookie: $cookie" "$base/api/hosts")"
  case "$hosts" in *'"connection":"connected"'*) break ;; esac
  sleep 0.2
done
echo "GET /api/hosts -> $hosts"
case "$hosts" in *'"connection":"connected"'*) ;; *) fail "the bench host never connected" ;; esac
echo "rss $(ps -o rss= -p "$pid") kb for pid $pid"

step "boxbox doctor while it serves"
boxbox doctor

step "stop drains inside the limit, with a stream open"
curl -s -N -H "cookie: $cookie" "$base/api/stream" >/tmp/stream.out 2>&1 &
stream=$!
sleep 1
started="$(date +%s%3N)"
systemctl --user stop boxbox
stopped="$(date +%s%3N)"
wait "$stream" && stream_exit=0 || stream_exit=$?
echo "systemctl --user stop took $((stopped - started)) ms; the open stream ended with curl exit $stream_exit after $(wc -c </tmp/stream.out) bytes"
[ $((stopped - started)) -lt 5000 ] || fail "the drain ran past 5 s"
journalctl --user -u boxbox --no-pager -o cat | grep -E 'boxbox listening|host health|shutting down|boxbox stopped|Stopp|Deactivated|Consumed' | sed 's/password[^ ]*/(redacted)/g'
systemctl --user show boxbox -p ActiveState -p Result -p ExecMainStatus

step "the data dir it left"
ls -la "$HOME/.local/share/boxbox"
boxbox doctor | sed -n '/^data/,/^$/p'
