#!/bin/sh
# the linux release cross-compiled on a mac with zig (docs/deploy.md,
# releases; decision 83): the same static musl tarballs, install.sh and
# SHA256SUMS as ops/release/build.sh, in target/dist, without docker or
# emulation. zig's clang and its bundled musl build the c inside aws-lc and
# sqlite for the target, which is what made a cross build fragile
# (docs/gotchas.md, ops), so an x86_64 release that took about 25 minutes
# under emulation takes minutes natively.
#
# usage: ops/release/zig.sh [--allow-dirty] [aarch64] [x86_64]
#   no architecture builds both. needs zig, cargo-zigbuild and the rust
#   target (`brew install zig cargo-zigbuild`, `rustup target add
#   x86_64-unknown-linux-musl`). zig is not pinned the way build.sh's image
#   is, so the bytes are this mac's, not reproducible elsewhere; the github
#   release workflow still builds natively with build.sh. a release comes
#   from a committed tree; --allow-dirty rehearses one and marks it "-dirty".
set -eu
cd "$(dirname "$0")/../.."
fail() { echo "release-zig: $*" >&2; exit 1; }
allow_dirty=no
arches=""
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) allow_dirty=yes ;;
    aarch64|x86_64) arches="$arches $arg" ;;
    *) fail "unknown argument \"$arg\" (usage: ops/release/zig.sh [--allow-dirty] [aarch64] [x86_64])" ;;
  esac
done
arches="${arches# }"
[ -n "$arches" ] || arches="aarch64 x86_64"
[ "$(uname -s)" = Darwin ] || fail "this cross-compiles on a mac; on linux, ops/release/build.sh builds natively"
command -v zig >/dev/null 2>&1 || fail "zig is not installed (brew install zig)"
command -v cargo-zigbuild >/dev/null 2>&1 || fail "cargo-zigbuild is not installed (brew install cargo-zigbuild)"
for arch in $arches; do
  rustup target list --installed | grep -qx "$arch-unknown-linux-musl" \
    || fail "the rust target $arch-unknown-linux-musl is missing (rustup target add $arch-unknown-linux-musl)"
done
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' server/Cargo.toml | head -n 1)
[ -n "$version" ] || fail "no version in server/Cargo.toml"
if [ -n "$(git status --porcelain)" ]; then
  [ "$allow_dirty" = yes ] || fail "the tree has uncommitted changes; commit them, or pass --allow-dirty to rehearse"
  version="$version-dirty"
fi
epoch=$(git log -1 --format=%ct)
dist=target/dist
# install.sh and `boxbox upgrade` learn which repo's releases they install from
repo="${BOXBOX_REPO:-${GITHUB_REPOSITORY:-}}"
export BOXBOX_REPO="$repo"

echo "release-zig: boxbox $version at $(git rev-parse --short HEAD) for $arches, zig $(zig version)"
echo "release-zig: building the app"
(cd app && bunx vite build --logLevel warn)
bun scripts/compress.ts >/dev/null

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
rm -rf "$dist"
mkdir -p "$dist"
stamp=$(date -r "$epoch" +%Y%m%d%H%M.%S)
for arch in $arches; do
  target="$arch-unknown-linux-musl"
  echo "release-zig: building $arch ($target)"
  started=$(date +%s)
  cargo zigbuild --release --locked -p boxbox --target "$target" >"$stage/$arch.log" 2>&1 \
    || { tail -n 40 "$stage/$arch.log" >&2; fail "the $arch build failed"; }
  bin="target/$target/release/boxbox"
  # "statically linked" on aarch64, "static-pie linked" on x86_64 (docs/gotchas.md, ops)
  file "$bin" | grep -Eq 'statically linked|static-pie linked' || fail "the $arch binary is not static: $(file "$bin")"
  name="boxbox-$version-$arch-linux"
  mkdir -p "$stage/$name"
  cp "$bin" "$stage/$name/boxbox"
  cp ops/boxbox.service boxbox.example.toml LICENSE "$stage/$name/"
  chmod 0755 "$stage/$name/boxbox"
  chmod 0644 "$stage/$name/boxbox.service" "$stage/$name/boxbox.example.toml" "$stage/$name/LICENSE"
  # the commit's time on every file, fixed owners, no apple metadata, names sorted, as mac.sh packs
  find "$stage/$name" -exec touch -h -t "$stamp" {} +
  (cd "$stage" && find "$name" | LC_ALL=C sort) >"$stage/$arch.files"
  COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --no-acls --no-fflags \
    --uid 0 --gid 0 --uname root --gname root -n \
    -C "$stage" -T "$stage/$arch.files" -cf - | gzip -n -9 >"$dist/$name.tar.gz"
  tar -tzf "$dist/$name.tar.gz" | grep -qx "$name/boxbox" || fail "the tarball does not hold $name/boxbox"
  echo "release-zig: $arch built in $(( $(date +%s) - started )) s"
done

# the ${...} is install.sh's own text, matched and written literally
# shellcheck disable=SC2016
line='repo="${BOXBOX_REPO:-'"$repo"'}"'
# shellcheck disable=SC2016
sed 's|^repo="${BOXBOX_REPO:-}"$|'"$line"'|' scripts/install.sh >"$dist/install.sh"
chmod 0755 "$dist/install.sh"
grep -qxF "$line" "$dist/install.sh" || fail "could not stamp the repo into install.sh"
[ -n "$repo" ] || echo "release-zig: no BOXBOX_REPO or GITHUB_REPOSITORY, so install.sh and boxbox upgrade need --from or BOXBOX_REPO"
(cd "$dist" && shasum -a 256 ./*.tar.gz install.sh | sed 's|  \./|  |' >SHA256SUMS)
echo "release-zig: target/dist"
(cd "$dist" && ls -l && cat SHA256SUMS)
