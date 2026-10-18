#!/bin/sh
# the mac release (docs/deploy.md, the mac): boxbox for apple silicon,
# built natively on this mac and packed as
# target/dist/boxbox-<version>-aarch64-darwin.tar.gz with the example config
# and the licence, then SHA256SUMS rewritten over every tarball in
# target/dist. `boxbox upgrade --from target/dist` reads that layout.
#
# usage: just build && ops/release/mac.sh [--allow-dirty]
#   the app comes from app/dist as `just build` left it: that recipe builds
#   it and holds it to its budget, so this script never builds a second,
#   unchecked copy. a release comes from a committed tree; --allow-dirty
#   rehearses one from a working tree and marks it "-dirty". run it after
#   ops/release/build.sh (`just release`), which starts target/dist afresh,
#   to put the linux and mac tarballs in one release.
set -eu

cd "$(dirname "$0")/../.."
fail() { echo "release-mac: $*" >&2; exit 1; }

allow_dirty=no
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) allow_dirty=yes ;;
    *) fail "unknown argument \"$arg\" (usage: ops/release/mac.sh [--allow-dirty])" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || fail "this builds the mac release, on a mac; linux releases come from ops/release/build.sh"
[ "$(uname -m)" = arm64 ] || fail "the mac release is for apple silicon, built natively on it, not on $(uname -m)"

version=$(sed -n 's/^version = "\(.*\)"$/\1/p' server/Cargo.toml | head -n 1)
[ -n "$version" ] || fail "no version in server/Cargo.toml"
if [ -n "$(git status --porcelain)" ]; then
  [ "$allow_dirty" = yes ] || fail "the tree has uncommitted changes; commit them, or pass --allow-dirty to rehearse"
  version="$version-dirty"
fi
epoch=$(git log -1 --format=%ct)
dist=target/dist
name="boxbox-$version-aarch64-darwin"
# `boxbox upgrade` fetches releases from the repo stamped into the binary
BOXBOX_REPO="${BOXBOX_REPO:-${GITHUB_REPOSITORY:-}}"
export BOXBOX_REPO

echo "release-mac: boxbox $version at $(git rev-parse --short HEAD) for aarch64-darwin"
[ -f app/dist/index.html ] || fail "app/dist is not built: run just build first"
echo "release-mac: building the binary around app/dist"
started=$(date +%s)
cargo build --release --locked --quiet -p boxbox
target/release/boxbox --version >/dev/null || fail "the built binary does not run"
file target/release/boxbox | grep -q 'arm64' || fail "the built binary is not arm64: $(file target/release/boxbox)"
echo "release-mac: built in $(( $(date +%s) - started )) s"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name"
cp target/release/boxbox "$stage/$name/boxbox"
cp boxbox.example.toml LICENSE "$stage/$name/"
chmod 0755 "$stage/$name/boxbox"
chmod 0644 "$stage/$name/boxbox.example.toml" "$stage/$name/LICENSE"
# the commit's time on every file, so the same source packs the same bytes
stamp=$(date -r "$epoch" +%Y%m%d%H%M.%S)
find "$stage/$name" -exec touch -h -t "$stamp" {} +

mkdir -p "$dist"
rm -f "$dist"/boxbox-*-aarch64-darwin.tar.gz
# bsdtar: fixed owners, no apple metadata (._ files, xattrs, acls), names sorted
(cd "$stage" && find "$name" | LC_ALL=C sort) >"$stage/files"
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --no-acls --no-fflags \
  --uid 0 --gid 0 --uname root --gname wheel -n \
  -C "$stage" -T "$stage/files" -cf - | gzip -n -9 >"$dist/$name.tar.gz"
tar -tzf "$dist/$name.tar.gz" | grep -qx "$name/boxbox" || fail "the tarball does not hold $name/boxbox"

(cd "$dist" && for file in ./*.tar.gz ./install.sh; do [ -f "$file" ] && shasum -a 256 "$file"; done) \
  | sed 's|  \./|  |' >"$dist/SHA256SUMS.new"
mv "$dist/SHA256SUMS.new" "$dist/SHA256SUMS"
[ -n "$BOXBOX_REPO" ] || echo "release-mac: no BOXBOX_REPO or GITHUB_REPOSITORY, so this binary's upgrade needs --from or BOXBOX_REPO"
echo "release-mac: target/dist"
(cd "$dist" && ls -l && cat SHA256SUMS)
