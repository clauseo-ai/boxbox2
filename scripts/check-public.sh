#!/bin/sh
# maintainer check: fails when a tracked file matches a private pattern, such
# as a machine name, a hostname or a personal path. the patterns come from
# $BOXBOX_PRIVATE_PATTERN or from private/check-patterns.txt (gitignored), so
# the list never ships. with neither set it prints a notice and passes, which
# is what a fresh clone does.
set -eu
pattern="${BOXBOX_PRIVATE_PATTERN:-}"
[ -z "$pattern" ] && [ -f private/check-patterns.txt ] && pattern="$(cat private/check-patterns.txt)"
[ -z "$pattern" ] && { echo "public check: no private patterns configured, skipping"; exit 0; }
if git ls-files --cached --others --exclude-standard | grep -v '^private/' | xargs grep -nE "$pattern" 2>/dev/null; then
  echo "public check: private strings in tracked files (above); remove them or move them to private/"
  exit 1
fi
echo "public check: clean"
