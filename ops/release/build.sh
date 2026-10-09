#!/bin/sh
# the release (docs/deploy.md, releases): a static linux binary for each
# architecture, packed with the unit and the example config, then
# install.sh and SHA256SUMS, all in target/dist/. each architecture builds
# natively in ops/release/Dockerfile; a foreign one runs under the docker
# host's emulation.
#
# usage: ops/release/build.sh [--allow-dirty] [aarch64] [x86_64]
#   no architecture builds both. a release comes from a committed tree (a
#   binary must be traceable to one commit); --allow-dirty rehearses one
#   from a working tree and marks every artifact "-dirty".
set -eu

cd "$(dirname "$0")/../.."
fail() { echo "release: $*" >&2; exit 1; }

allow_dirty=no
arches=""
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) allow_dirty=yes ;;
    aarch64|x86_64) arches="$arches $arg" ;;
    *) fail "unknown argument \"$arg\" (usage: ops/release/build.sh [--allow-dirty] [aarch64] [x86_64])" ;;
  esac
done
arches="${arches# }"
[ -n "$arches" ] || arches="aarch64 x86_64"

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

if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$@"; }
else fail "neither sha256sum nor shasum is installed"
fi

echo "release: boxbox $version at $(git rev-parse --short HEAD) for $arches"
echo "release: building the app"
(cd app && bunx vite build --logLevel warn)
bun scripts/compress.ts >/dev/null

rm -rf "$dist"
mkdir -p "$dist"
for arch in $arches; do
  case "$arch" in
    aarch64) platform=linux/arm64 ;;
    x86_64) platform=linux/amd64 ;;
  esac
  echo "release: building $arch ($platform)"
  started=$(date +%s)
  docker buildx build \
    --platform "$platform" \
    --file ops/release/Dockerfile \
    --build-arg "VERSION=$version" \
    --build-arg "SOURCE_DATE_EPOCH=$epoch" \
    --build-arg "BOXBOX_REPO=$repo" \
    --output "type=local,dest=$dist/.$arch" \
    --progress plain \
    . >"$dist/.$arch.log" 2>&1 \
    || { tail -n 40 "$dist/.$arch.log" >&2; fail "the $arch build failed (full log: $dist/.$arch.log)"; }
  mv "$dist/.$arch/"*.tar.gz "$dist/"
  rm -rf "$dist/.$arch" "$dist/.$arch.log"
  echo "release: $arch built in $(( $(date +%s) - started )) s"
done

# the ${...} is install.sh's own text, matched and written literally
# shellcheck disable=SC2016
stamp='repo="${BOXBOX_REPO:-'"$repo"'}"'
# shellcheck disable=SC2016
sed 's|^repo="${BOXBOX_REPO:-}"$|'"$stamp"'|' scripts/install.sh >"$dist/install.sh"
chmod 0755 "$dist/install.sh"
grep -qxF "$stamp" "$dist/install.sh" || fail "could not stamp the repo into install.sh"
[ -n "$repo" ] || echo "release: no BOXBOX_REPO or GITHUB_REPOSITORY, so install.sh and boxbox upgrade need --from or BOXBOX_REPO"
(cd "$dist" && sha256 ./*.tar.gz install.sh | sed 's|  \./|  |' >SHA256SUMS)
echo "release: target/dist"
(cd "$dist" && ls -l && cat SHA256SUMS)
