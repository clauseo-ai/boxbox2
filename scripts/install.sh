#!/bin/sh
# installs boxbox from a release into ~/.local (docs/deploy.md).
#
#   curl -fsSL https://github.com/clauseo-ai/boxbox2/releases/latest/download/install.sh | sh
#   sh install.sh [--version <tag>] [--from <url or directory>]
#
# --version picks a release tag (the latest by default); --from reads the
# release files (SHA256SUMS and the tarballs) from another url or a local
# directory instead of the repo's releases.
#
# what it does, and nothing more:
#   - fetches SHA256SUMS and this machine's tarball, and refuses a tarball
#     whose checksum does not match
#   - runs the new binary once before installing it, so a binary this
#     machine cannot run never replaces one it can
#   - installs it to ~/.local/bin/boxbox by atomic rename, never by copying
#     over a running file, and keeps the one it replaces as
#     ~/.local/bin/boxbox.previous for a rollback
#   - installs the systemd user unit when there is none; a unit that differs
#     is left alone and the new one lands beside it as boxbox.service.new
#   - never writes a config and never starts, stops or restarts anything:
#     it prints the next commands instead
set -eu

# the release build stamps the repo in; BOXBOX_REPO overrides it
repo="${BOXBOX_REPO:-}"

say() { printf 'boxbox install: %s\n' "$*"; }
fail() { printf 'boxbox install: %s\n' "$*" >&2; exit 1; }

version=""
from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a tag, like v0.1.0"; version="$2"; shift 2 ;;
    --version=*) version="${1#*=}"; shift ;;
    --from) [ $# -ge 2 ] || fail "--from needs a url or a directory"; from="$2"; shift 2 ;;
    --from=*) from="${1#*=}"; shift ;;
    -h|--help) echo "usage: install.sh [--version <tag>] [--from <url or directory>]"; exit 0 ;;
    *) fail "unknown argument \"$1\" (usage: install.sh [--version <tag>] [--from <url or directory>])" ;;
  esac
done

[ -n "${HOME:-}" ] || fail "HOME is not set, so there is no ~/.local to install into"

case "$(uname -s)" in
  Linux) ;;
  Darwin) fail "releases are built for linux. on a mac, build from source: just build (README.md)" ;;
  *) fail "releases are built for linux, not $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) fail "there is no release for $(uname -m); build from source: just build (README.md)" ;;
esac

if [ -z "$from" ]; then
  [ -n "$repo" ] || fail "no release to install from: use the install.sh attached to a release, set BOXBOX_REPO=clauseo-ai/boxbox2, or pass --from"
  if [ -n "$version" ]; then
    from="https://github.com/$repo/releases/download/$version"
  else
    from="https://github.com/$repo/releases/latest/download"
  fi
elif [ -n "$version" ]; then
  fail "--version picks among the repo's releases; with --from, point at the release you want"
fi
from="${from%/}"

if [ -d "$from" ]; then
  fetch() { cp "$from/$1" "$2"; }
elif command -v curl >/dev/null 2>&1; then
  fetch() { curl --fail --silent --show-error --location --proto '=https,file,http' --output "$2" "$from/$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget --quiet --output-document="$2" "$from/$1"; }
else
  fail "curl or wget is needed to download the release"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is needed to check the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

fetch SHA256SUMS "$tmp/SHA256SUMS" || fail "cannot fetch SHA256SUMS from $from"
# the checksum file is the release's index: it names this machine's tarball
tarball="$(sed -n "s/^[0-9a-f]\{64\}  \(boxbox-[^ ]*-$arch-linux\.tar\.gz\)$/\1/p" "$tmp/SHA256SUMS")"
case "$tarball" in
  "") fail "the release at $from has no $arch linux tarball" ;;
  *"
"*) fail "the release at $from lists more than one $arch linux tarball" ;;
esac
expected="$(awk -v name="$tarball" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"

say "downloading $tarball"
fetch "$tarball" "$tmp/$tarball" || fail "cannot fetch $tarball from $from"
actual="$(sha256_of "$tmp/$tarball")"
[ "$actual" = "$expected" ] || fail "$tarball does not match its checksum (expected $expected, got $actual); nothing was installed"
say "checksum ok ($actual)"

tar -xzf "$tmp/$tarball" -C "$tmp"
unpacked="$tmp/${tarball%.tar.gz}"
[ -f "$unpacked/boxbox" ] || fail "$tarball holds no boxbox binary"
new_version="$("$unpacked/boxbox" --version 2>&1)" || fail "the new binary does not run on this machine ($new_version); nothing was installed"

bin="$HOME/.local/bin"
mkdir -p "$bin"
target="$bin/boxbox"
old_version=""
if [ -x "$target" ]; then
  old_version="$("$target" --version 2>/dev/null || echo "an unreadable version")"
  # the old inode under a second name: the rollback, with no copy made
  ln -f "$target" "$bin/boxbox.previous"
fi
staged="$bin/.boxbox.new.$$"
cp "$unpacked/boxbox" "$staged"
chmod 0755 "$staged"
mv -f "$staged" "$target"
if [ -n "$old_version" ]; then
  say "replaced $old_version with $new_version at $target (the old one is boxbox.previous)"
else
  say "installed $new_version at $target"
fi

units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$units/boxbox.service"
mkdir -p "$units"
if [ ! -f "$unit" ]; then
  cp "$unpacked/boxbox.service" "$unit"
  chmod 0644 "$unit"
  say "installed the systemd user unit at $unit"
elif cmp -s "$unpacked/boxbox.service" "$unit"; then
  say "the systemd user unit at $unit is current"
else
  cp "$unpacked/boxbox.service" "$unit.new"
  chmod 0644 "$unit.new"
  say "your unit at $unit differs from this release's, so it was kept; the new one is $unit.new (compare with diff)"
fi

config="${BOXBOX_CONFIG:-$HOME/.config/boxbox/boxbox.toml}"
echo
echo "next"
case ":$PATH:" in
  *":$bin:"*) run=boxbox ;;
  *) run="$target"; echo "  ($bin is not on your PATH, so the commands below name the binary in full)" ;;
esac
[ -f "$config" ] || echo "  $run init                  write boxbox.toml: the gate password and your cmx2 daemons"
echo "  $run doctor                check the config, reach every daemon, look at the data dir"
if command -v systemctl >/dev/null 2>&1; then
  if [ -n "$old_version" ] && systemctl --user is-active --quiet boxbox 2>/dev/null; then
    echo "  systemctl --user restart boxbox    run the new binary (the running one keeps the old until then)"
  else
    echo "  systemctl --user daemon-reload && systemctl --user enable --now boxbox"
    echo "  loginctl enable-linger \"\$USER\"    keep it running while you are logged out"
  fi
else
  echo "  $run serve                 run the server (no systemd here to keep it running)"
fi
