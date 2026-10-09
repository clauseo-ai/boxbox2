#!/bin/sh
# install the board daemon under launchd.
#
#   cd board && ./install.sh
#
# THE TCC TRAP (first light, 2026-07-26): a launchd agent has no
# Files-and-Folders grant for ~/Documents, and bun calls getcwd() before
# it runs a single line of user code. pointed at the repo, the daemon
# hangs in __open_nocancel forever — running, zero cpu, no sockets, empty
# logs. so we do NOT run from the repo: we build a self-contained bundle
# into ~/.local/share and run from there. re-run this script after any
# daemon source change to redeploy the bundle.
#
# the plist carries NO secrets: origin and password live in the config
# file, read at runtime from ~/.config.

set -eu

LABEL="com.boxbox.board"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN="$(command -v bun)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME="$HOME/.local/share/boxbox-board"
APP="$RUNTIME/app"
CONFIG="$HOME/.config/boxbox-board.json"

mkdir -p "$APP" "$HOME/Library/LaunchAgents"

if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<EOF
{
  "origin": "https://<vm>.<tailnet>.ts.net",
  "password": "CHANGE-ME"
}
EOF
  chmod 600 "$CONFIG"
  echo "minted $CONFIG — put the real boxbox password in it, then re-run"
  exit 1
fi

# bundle: every ts import (including the lib/ contracts one directory up)
# resolves at build time. node-hid stays external — it is a native addon
# with prebuilt binaries that cannot be bundled.
echo "building the bundle…"
"$BUN" build "$SRC_DIR/src/main.ts" \
  --target=bun \
  --external node-hid \
  --outfile "$APP/main.js"

# the one external, copied whole (not symlinked: a symlink into
# ~/Documents walks straight back into the TCC trap). the whole tree,
# not a guessed dep list — node-hid pulls pkg-prebuilds at runtime.
rm -rf "$APP/node_modules"
cp -R "$SRC_DIR/node_modules" "$APP/node_modules"

# THE MIC TRAP (2026-07-27): tccd resolves microphone access against the
# launchd JOB ROOT, and "Policy disallows prompt" for any binary without
# an embedded NSMicrophoneUsageDescription — bare bun as job root meant
# the meter got silence, forever, with no prompt and no error. so the job
# root is a tiny C wrapper with the usage description embedded in
# __TEXT,__info_plist, which spawns bun as a child. compiled ONLY when
# missing or stale: every rebuild changes the cdhash and voids the TCC
# grant (macOS re-prompts on the next radio hold).
WRAPPER="$RUNTIME/boxbox-board"
if [ ! -x "$WRAPPER" ] || [ "$SRC_DIR/wrapper.c" -nt "$WRAPPER" ] || [ "$SRC_DIR/wrapper-info.plist" -nt "$WRAPPER" ]; then
  echo "building the tcc wrapper (mic grant resets — expect a prompt on the next radio hold)…"
  cc -O2 \
    -sectcreate __TEXT __info_plist "$SRC_DIR/wrapper-info.plist" \
    -o "$WRAPPER" "$SRC_DIR/wrapper.c"
  codesign -s - -f --identifier com.boxbox.board.wrapper "$WRAPPER"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$WRAPPER</string>
    <string>$BUN</string>
    <string>$APP/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd's default PATH has no /opt/homebrew/bin, so the radio's
         ffmpeg spawn failed forever (radio.meter_spawn_failed) while the
         same daemon worked from a terminal. -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$RUNTIME/daemon.log</string>
  <key>StandardErrorPath</key><string>$RUNTIME/daemon.err</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

# bootout is ASYNCHRONOUS: an immediate bootstrap races the teardown and
# dies with "Bootstrap failed: 5: Input/output error". wait for the label
# to actually leave the domain, then load.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
i=0
while launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 50 ] && { echo "the old job will not leave the domain"; exit 1; }
  sleep 0.2
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "loaded $LABEL — logs at $RUNTIME/daemon.log"
echo "watch: tail -f $RUNTIME/daemon.log"
