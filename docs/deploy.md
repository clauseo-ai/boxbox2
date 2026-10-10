# deploy

**status: run on a mac on 2026-10-01; the vm steps are
rehearsed, not yet run on a real machine.** on the mac (apple silicon,
macos 27.0): `boxbox init --pair` against the installed cmx2 0.8.3 daemon,
`boxbox service install` into launchd's user domain, the gate (401, then
a signed-in `GET /api/hosts` with the daemon connected), a `kill` of the
server brought back by launchd, `boxbox upgrade --from` a local mac
release with a stream open (drained, restarted, still connected), its
refusals (same version, a tampered tarball, no release source), and
uninstall then install again. not proven there: surviving a gui logout
and a reboot, which were not tried (the mac, below). the linux release
install, init, doctor and the unit were run end to end on clean linux
machines in containers (`ops/test/container.sh`, both architectures)
against a real cmx2 daemon, before `boxbox service` and `boxbox upgrade`
existed. on 2026-10-03 v2 ran on a vm beside v1, and `boxbox upgrade
--from` ran there for the first time (to the 2026-10-03 build): it placed the binary
and kept `boxbox.previous`, then refused to restart the unit, because it
reads the unit's `%h` as text (`docs/open.md`); the restart was
`systemctl --user restart boxbox`. upgrade reads the unit's words back
since the commit after the pin move of 2026-10-03; an older binary still
needs that restart by hand. `boxbox service` has not run on linux.
the side-by-side, cutover and
rollback steps are written from v1's runbook and have not been run. the
m8 cutover runs them on the vm for real and replaces this line with what
happened.

boxbox runs as one binary on an always-on machine on your private network
(a small vm works well), fronted by https on the same network. a typical
setup, with placeholder names: a vm called `<vm>` on a tailnet
`<tailnet>`, serving `https://<vm>.<tailnet>.ts.net` through `tailscale
serve`, watching three cmx2 daemons (`desk`, `vm`, a third).

## what runs where

| piece | where | notes |
|---|---|---|
| `boxbox` | `~/.local/bin/boxbox` | one binary, the app embedded (static on linux); `boxbox.previous` beside it after an upgrade |
| config | `~/.config/boxbox/boxbox.toml`, mode 0600 | the gate password and the credential of each daemon in the config; `boxbox init` writes it |
| data | `~/.local/share/boxbox/`, mode 0700 | `secret` (the cookie key), `boxbox.db` (read state, needs, cleared and adopted threads, prefs, push subscriptions and the push key, and the credentials of daemons paired from the app), `telemetry/*.jsonl` |
| unit | `~/.config/systemd/user/boxbox.service` | `ops/boxbox.service`: `MemoryMax=256M`, a sigterm drain inside 5 s, restart on failure. on a mac, the launchd agent (below) |
| https | `tailscale serve` on `<vm>` | the same origin v1 used, so installed apps keep their icon |

## first install

on the machine that will run it, as the user it runs as:

```sh
curl -fsSL https://github.com/clauseo-ai/boxbox2/releases/latest/download/install.sh | sh
boxbox init            # asks for the gate password and each cmx2 daemon
boxbox doctor          # the config, every daemon reached, the data dir, the port
systemctl --user daemon-reload && systemctl --user enable --now boxbox
loginctl enable-linger "$USER"      # keep it running while you are logged out
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

`install.sh` fetches the release's `SHA256SUMS` and this machine's
tarball, refuses a tarball that does not match, runs the new binary once,
and only then renames it into `~/.local/bin`. it installs the unit when
there is none and never writes a config or starts anything. `--version
<tag>` picks a release; `--from <dir>` installs from files you copied over
yourself, for a machine that cannot reach github:

```sh
# on your machine
gh release download <tag> --repo clauseo-ai/boxbox2 --dir boxbox-release
scp -r boxbox-release <vm>:
# on the vm
sh boxbox-release/install.sh --from boxbox-release
```

`boxbox init` takes flags for a script (`boxbox --help`); passwords come
from files or stdin, never argv, where `ps` and shell history keep them:

```sh
boxbox init --listen 127.0.0.1:3000 --password-file ~/gate \
  --host desk=http://desk.<tailnet>.ts.net:4097 --host-password-file desk=~/desk-password
```

it refuses to write over a config that exists (and says so when others can
read it); edit that one, or move it away to start again.

the vm must be allowed to reach each daemon's port: a tailnet policy that
grants mesh access only to personal devices drops the vm's connections
silently while `tailscale ping` still answers (v1's scar, `docs/scars.md`). grant src `<vm>` to each daemon host on its cmx2 port. `boxbox
doctor` shows it as `cannot connect (... timed out)` for that host.

## beside v1 on the same vm

v2 soaks next to v1 before it replaces it (`docs/plan.md`, m8). they share
no file, port, unit or cookie:

| | v1 | v2 |
|---|---|---|
| unit | `boxbox-v1.service` | `boxbox.service` |
| runs | the repo checkout under bun | `~/.local/bin/boxbox` |
| listens | `127.0.0.1:3000` | `127.0.0.1:3040` (any free port) |
| config | `~/.config/boxbox-v1/env` | `~/.config/boxbox/boxbox.toml` |
| data | `~/.local/share/boxbox-v1/` | `~/.local/share/boxbox/` |
| session cookie | `bb_session` | `boxbox_session` |
| https during the soak | `:443` | `:8443` |

cookies ignore ports, so both apps see each other's cookies on the one
host name: the names must differ, and they do unless someone sets v2's
`[cookie] name` to v1's. never do.

```sh
ssh <vm>
curl -fsSL https://github.com/clauseo-ai/boxbox2/releases/latest/download/install.sh | sh
boxbox init --listen 127.0.0.1:3040   # the daemons v1 watches, with the passwords in v1's env
boxbox doctor                         # every daemon ok, 127.0.0.1:3040 free
systemctl --user daemon-reload && systemctl --user enable --now boxbox
tailscale serve --bg --https=8443 http://127.0.0.1:3040
tailscale serve status                # 443 -> 3000 (v1), 8443 -> 3040 (v2)
```

on each device, open `https://<vm>.<tailnet>.ts.net:8443`, add it to the
home screen as a second app for the soak, and turn notifications on in
it. a different port is a different origin, so the two apps keep separate
service workers, storage and push subscriptions.

pick v2's host names once: in v1 a name was a badge, in v2 it is part of
every thread's identity (`desk:ses_...`).

to keep v1's telemetry history in v2's queries, copy it across (the same
format; `bun scripts/telemetry.ts query` reads both):

```sh
cp ~/.local/share/boxbox-v1/telemetry/*.jsonl ~/.local/share/boxbox/telemetry/
```

## cutover

when the soak's gate holds (`docs/plan.md`, m8), move 443 to v2 and stop
v1, leaving it installed:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3040
tailscale serve --https=8443 off
systemctl --user disable --now boxbox-v1
```

the installed v1 icons now open v2 at the same origin; v2's service worker
replaces v1's (both are `/sw.js`) on the first launch. push subscriptions
belong to a server's push key, so turn notifications on once more in that
app, and remove the `:8443` soak app from each home screen.

## rolling back

**a bad v2 release, to the one before.** `install.sh` kept it:

```sh
mv ~/.local/bin/boxbox.previous ~/.local/bin/boxbox && systemctl --user restart boxbox
```

a release that migrates `boxbox.db` says so in `CHANGELOG.md`; before
installing one, stop the server and copy the data dir
(`systemctl --user stop boxbox && cp -a ~/.local/share/boxbox
~/.local/share/boxbox.before-<version>`), so a rollback can restore both.

**v2 back to v1, after the cutover.** v1's files were never touched, so
it resumes where it stopped:

```sh
systemctl --user enable --now boxbox-v1
tailscale serve --bg --https=443 http://127.0.0.1:3000
systemctl --user disable --now boxbox       # or leave it soaking behind :8443 again
```

a device that ran v2 at 443 still holds v2's service worker; the browser
fetches v1's `/sw.js` at the next launch and swaps it in, so expect one
launch from cache before v1 shows. turn notifications on again in v1.

**v2 off the vm entirely, before the cutover:**

```sh
tailscale serve --https=8443 off
systemctl --user disable --now boxbox
rm ~/.local/bin/boxbox ~/.local/bin/boxbox.previous ~/.config/systemd/user/boxbox.service
systemctl --user daemon-reload
# ~/.config/boxbox and ~/.local/share/boxbox hold the config and data; remove them for a clean slate
```

## upgrade

```sh
ssh <vm> 'boxbox upgrade && boxbox doctor && ps -o rss=,command= -C boxbox'
```

`boxbox upgrade` (the mac, above) fetches the release, checks it, places
it by rename and restarts the unit. `install.sh` does the same placing
for a machine without boxbox, or with one too old to upgrade itself:

```sh
ssh <vm> 'curl -fsSL https://github.com/clauseo-ai/boxbox2/releases/latest/download/install.sh | sh && systemctl --user restart boxbox'
```

- **install by rename, never copy over the running file** (`docs/scars.md`: a binary copied over while it runs is poisoned). `install.sh`
  stages the binary in `~/.local/bin` and renames it, which is atomic on
  one filesystem; the running process keeps its old inode until the
  restart.
- a restart drains inside 5 s: in-flight requests finish, streams end,
  telemetry is flushed. installed apps resume from their cursor, so a
  deploy costs nobody a reload.
- hosts in `boxbox.toml` reload without a restart. `listen`, `data_dir`,
  `password`, `[cookie]` and `[dev]` apply at the next start, and the log
  says which changed (`docs/scars.md`).

## checks after any deploy

- `boxbox doctor` ends `ready to serve.` or with warnings it names; a
  `fail` line says what to fix. it never prints a password, and it reads
  `boxbox.db` read-only while the server runs.
- `journalctl --user -u boxbox` shows `boxbox listening` and one `host
  health` line per daemon with its version.
- `ps -o rss= -C boxbox` stays near the 64 mb budget.
- `curl -s -o /dev/null -w '%{http_code}' https://<vm>.<tailnet>.ts.net/api/hosts`
  answers 401 (the gate is up).

## the mac

boxbox runs on a mac the same way, as a launchd agent instead of a
systemd unit, typically beside the cmx2 daemon on the same machine and
opened from its browser at `http://localhost:3040` (3040, so it never
meets v1 or the dev server on 3001). a typical setup, with
placeholder names: one daemon on the mac, installed with `cmx2 serve
--install` on its port `<port>`, named `<host>` in boxbox.

| piece | where | notes |
|---|---|---|
| `boxbox` | `~/.local/bin/boxbox` | the installed copy the agent runs, never a build under `~/Documents`: launchd stalls for minutes on a tcc consent prompt for a binary there |
| config | `~/.config/boxbox/boxbox.toml`, mode 0600 | the gate password and the daemon's bearer |
| data | `~/.local/share/boxbox/`, mode 0700 | as on linux |
| agent | `~/Library/LaunchAgents/dev.boxbox.serve.plist` | written by `boxbox service install`; no secret in it |
| log | `~/Library/Logs/boxbox/dev.boxbox.serve.log`, mode 0600 | stdout and stderr; launchd never rotates it (below) |

### install

there is no mac `install.sh` and no mac download. build from source, or run
`just release-mac` to make the tarball yourself:

```sh
just build                          # target/release/boxbox, the app inside
just release-mac                    # target/dist: the mac tarball and SHA256SUMS
cmx2 pair --name boxbox-<machine> | target/release/boxbox init \
  --listen 127.0.0.1:3040 --password-file ~/gate --plain-http \
  --pair <host>=http://127.0.0.1:<port> --pair-token-file <host>=-
target/release/boxbox service install   # places itself at ~/.local/bin/boxbox, then loads the agent
~/.local/bin/boxbox doctor
```

- **pairing.** `cmx2 pair` on the daemon's machine prints a url and a
  one-time token (10 minutes, one use). `--pair <host>=<url>` makes init
  trade the token at the daemon's `POST /pair` for a bearer credential of
  boxbox's own and write it into that `[[host]]` as `bearer`.
  `--pair-token-file` takes the token alone or everything `cmx2 pair`
  printed, from a file or stdin, so piping one into the other keeps the
  token off the screen, out of files and out of shell history. a refused
  or expired token stops init with the daemon's own words and writes
  nothing; so does any one pairing failing, and the error names the
  pairings that did go through, with the `cmx2 pair --revoke <id>` that
  removes each. `cmx2 pair --list` on the daemon shows the client;
  `cmx2 pair --revoke <id>` cuts it off, and doctor then fails that host
  with `refused the bearer (401)`. on a terminal, init asks: answer `pair`
  for a host, then paste the token line.
- **pairing makes a loopback daemon ask everyone.** a cmx2 daemon bound
  to loopback with no password takes requests without a credential until
  its first client pairs; from then on every request needs one, and
  anything else that called it bare gets 401 (cmx2's own cli and tui use
  its `local.token`). a daemon on `0.0.0.0` asks already.
- **the gate password** comes from `--password-file`; without one init
  makes one (four groups of five, about 100 bits) and prints it once, at
  the end. it is never logged.
- **`--plain-http`** writes `[cookie] secure = false`. browsers differ
  on keeping a cookie marked `Secure` on `http://localhost` (chrome counts
  localhost as secure; webkit has not on every version, and safari was not
  checked here), and an app opened over plain http that drops its cookie
  asks for the password forever. the cookie stays `HttpOnly` and
  `SameSite=Lax` and never leaves the machine. leave it off when an https
  front (`tailscale serve`) is the way in; doctor warns while it is set.

### the agent, and logging out

`boxbox service install [--config <path>]` writes the plist and loads it
into launchd's **user domain**, `user/<uid>`, not the gui domain
`gui/<uid>` that `launchctl load` and cmx2's own `serve --install` use. the
gui domain belongs to the gui login and is torn down when you log out,
taking its agents with it; the user domain may exist without a login
(`launchctl(1)`). the plist says `LimitLoadToSessionType` `Background`,
so a gui login, which loads `Aqua` agents from `~/Library/LaunchAgents`
into its own domain, never starts a second copy that would fight the first
for the port. the rest of the plist: `RunAtLoad`, `KeepAlive` (started
again however it stops), `ThrottleInterval` 5 s, `ExitTimeOut` 8 s
(launchd's sigterm, the 5 s drain, then sigkill), `ProcessType`
`Interactive` (unspecified, launchd throttles cpu and io), `Umask` 0077,
`HOME` and `RUST_LOG=boxbox=info` in its environment and nothing else.

what was seen on a mac (macos 27.0):

- `launchctl bootstrap user/<uid> <plist>` loads it; `launchctl print
  user/<uid>/dev.boxbox.serve` shows `domain = user/<uid>`, `state =
  running`, `spawn type = interactive`, and `launchctl print
  gui/<uid>/dev.boxbox.serve` answers that no such service is there. the
  user domain on that mac was created by loginwindow and lists `gui/<uid>`
  as its subdomain.
- `kill <pid>`: the server drains (`shutting down signal="terminate"`,
  `boxbox stopped`) and launchd starts a new one 40 ms later, a new pid.
- `launchctl kickstart -k` (a restart, what upgrade runs) and `launchctl
  bootout` (uninstall) both stop it with sigterm; with a client stream
  open, the drain took 9 ms and the stream ended cleanly.
- rss after start, one daemon with 300 sessions: 11 mb.

not proven: that it keeps running through a gui logout, and that it
starts at the next login after a reboot without one. both follow from
`launchctl(1)` and the user domain, and neither was tried (logging out was not tried). after a reboot the user domain exists
only once the user has a session, so boxbox starts at the first login,
not at boot.

`boxbox service status` prints the unit, the domain, the binary and its
version, the config, the log and its size, the state and pid, and
whether it answers; it exits 1 unless it is running and answering.
`boxbox service uninstall` boots it out and removes the plist; the
binary, config, data and log stay. `BOXBOX_SERVICE_LABEL=<label>` names
another agent, so a test can install one beside the real one.

**the log is not rotated.** launchd opens `StandardErrorPath` itself for
each start and never rotates it, and a wrapper that renamed the file at
start would leave the server writing into the renamed one. at `info` the
server writes one line per api request, about 150 bytes; `service
status` shows the size. until the server owns a capped log, truncate it
by hand when it matters: `: > ~/Library/Logs/boxbox/dev.boxbox.serve.log`
(the server keeps writing at its end).

### upgrade and roll back

```sh
boxbox upgrade                       # the latest release of the repo the binary was built from
boxbox upgrade --version 0.2.0       # a given one
boxbox upgrade --from target/dist    # a directory or url laid out like a release
```

upgrade prints each step: where it is reading from, the tarball
`SHA256SUMS` names for this machine and its checksum (a mismatch replaces
nothing), the new binary's own `--version` run from beside the target
(one that does not run replaces nothing), the versions compared (the same
or an older one needs `--force`), the rename onto `~/.local/bin/boxbox`
with the old binary kept as `boxbox.previous` (a hard link, so no copy),
and the service restarted with the pid before and after. `--no-restart`
replaces the binary and prints the restart command instead. a binary
built from source knows no repo, so it needs `--from`,
`$BOXBOX_RELEASE_BASE` or `BOXBOX_REPO=clauseo-ai/boxbox2`; a release build
carries the repo it came from. it works the same on linux, restarting
the systemd unit.

to roll back on a mac:

```sh
mv ~/.local/bin/boxbox.previous ~/.local/bin/boxbox
launchctl kickstart -k "user/$(id -u)/dev.boxbox.serve"
```

that moves the binary only. if the upgrade migrated `boxbox.db` (the
changelog says so; schema 3 to 5 for the release that brought clear and
history), the old binary refuses the newer file, so stop the service and put
the data dir back from before the upgrade first. copy it before upgrading,
with the service stopped: the store runs in wal mode, so a copy of a running
store can miss what is still in the log (or use `sqlite3 boxbox.db ".backup ..."`):

```sh
launchctl bootout "user/$(id -u)/dev.boxbox.serve"
cp -a ~/.local/share/boxbox ~/.local/share/boxbox.before-<version>
launchctl bootstrap "user/$(id -u)" ~/Library/LaunchAgents/dev.boxbox.serve.plist
```

then, to roll back:

```sh
launchctl bootout "user/$(id -u)/dev.boxbox.serve"
rm -r ~/.local/share/boxbox && cp -a ~/.local/share/boxbox.before-<version> ~/.local/share/boxbox
mv ~/.local/bin/boxbox.previous ~/.local/bin/boxbox
launchctl bootstrap "user/$(id -u)" ~/Library/LaunchAgents/dev.boxbox.serve.plist
```

a migration that failed changes nothing (they run in one transaction), so
only a rollback after one that succeeded needs the copy; everything boxbox
wrote after the upgrade is lost with it (clears and adopted threads, and also
prefs, read marks and needs written since), and the threads' own history,
which lives on the daemons, is not touched.

### off the mac entirely

```sh
boxbox service uninstall
rm ~/.local/bin/boxbox ~/.local/bin/boxbox.previous
# the config, the data and the log hold the rest; remove them for a clean slate
rm -r ~/.config/boxbox ~/.local/share/boxbox ~/Library/Logs/boxbox
cmx2 pair --revoke <id>              # on the daemon: the id init printed
```

## releases

a release is a static linux binary per architecture (`x86_64`, `aarch64`),
packed as `boxbox-<version>-<arch>-linux.tar.gz` with the unit, the example
config and the licence, plus `install.sh` and `SHA256SUMS`. `install.sh` installs the
linux ones; `boxbox upgrade` reads any of them.

- **built** by `ops/release/build.sh` (`just release`) in
  `ops/release/Dockerfile`: `rust:1.92.0-alpine`, musl, every library
  linked in. a static binary runs on any distribution whatever its glibc
  (a dynamic binary ferried to a machine with an older glibc fails to start). each
  architecture builds natively, never cross-compiled; a foreign one runs
  under the docker host's emulation. the build context is an allowlist, so
  local-only directories and `node_modules` never enter it, and the tarball is packed
  with fixed owners and the commit's time. a release comes from a
  committed tree; `--allow-dirty` rehearses one and marks it `-dirty`.
  the binary carries the repo it is released from (`BOXBOX_REPO`, else
  `GITHUB_REPOSITORY`), where `boxbox upgrade` looks for the next one.
- **the mac tarball** comes from `ops/release/mac.sh` (`just
  release-mac`), on an apple silicon mac, after `just build`: it builds
  the release binary around the `app/dist` that recipe built and held to
  its budget, packs it with fixed owners, the commit's time and no apple
  metadata, and rewrites `SHA256SUMS` over every tarball in
  `target/dist`. run it after `just release`, which starts `target/dist`
  afresh. the release workflow does not build it yet.
- **published** by `.github/workflows/release.yml` on a tag `v<version>`:
  `just check`, a native build on an x86_64 and an arm64 runner, each
  installed with `install.sh` on its own architecture and run, then one
  release with the tag's `CHANGELOG.md` section as its notes.
- **cutting one**: set `version` in `server/Cargo.toml`, write a `##
  <version>` section in `CHANGELOG.md`, commit, then `git tag v<version>
  && git push origin v<version>`. the workflow refuses a tag that
  disagrees with the version or has no changelog section.

## testing a release without a machine

```sh
ops/release/build.sh --allow-dirty          # target/dist
bun ops/test/daemon.ts &                    # the pinned cmx2 daemon on 127.0.0.1:4900
ops/test/container.sh aarch64               # and x86_64
```

`container.sh` boots debian with systemd as pid 1 and a lingering user,
then as that user: `install.sh` into a clean temp `HOME` (twice, proving the
rename and `boxbox.previous`) and refusing a tampered tarball;
`systemd-analyze --user verify` on the unit; `boxbox init` from flags, its
refusals, and `boxbox doctor`; the unit started under the user's manager,
`memory.max` read from the kernel's cgroup, a signed-in `GET /api/hosts`
showing the daemon connected; and `systemctl --user stop` with a stream
open, timed against the 5 s drain, with the journal's lines. on an arm64
host the x86_64 machine runs under emulation, where systemd's own
services need their seccomp filters lifted (`docs/gotchas.md`, ops); the
boxbox unit is not touched, and rss read there is not comparable.
