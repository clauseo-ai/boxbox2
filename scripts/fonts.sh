#!/bin/sh
# rebuilds app/src/fonts from the upstream releases (both sil ofl 1.1; see
# THIRD_PARTY.md). the variable fonts are subset to latin plus the arrows,
# keys and blocks the design uses. mona sans keeps the axes the design law
# uses (width 75 to 125, weight 300 to 800) and pins optical size at its
# default, which takes it from 232 kb to 140 kb.
#
# mona sans declares the reserved font name "Mona", and a subset is a
# modified version under the ofl, so the result is renamed "Boxbox Sans";
# its copyright and licence records are kept as they are.
#
#   scripts/fonts.sh <MonaSansVF[wdth,opsz,wght].woff2> <MartianMonoVF.woff2>
#
# needs fonttools with brotli (`pip install fonttools brotli`, in a venv).
set -eu
mona="$1"; martian="$2"; out="$(dirname "$0")/../app/src/fonts"
unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2190-21FF,U+2212,U+2303-23FF,U+25A0-25FF,U+2713,U+FEFF,U+FFFD"
tmp="$(mktemp -d)"
pyftsubset "$mona" --unicodes="$unicodes" --layout-features='*' --flavor=woff2 --output-file="$tmp/mona.woff2"
fonttools varLib.instancer --quiet --output "$tmp/instanced.woff2" "$tmp/mona.woff2" opsz=drop wght=300:800
python3 - "$tmp/instanced.woff2" "$out/boxbox-sans.woff2" <<'PY'
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
kept = {0, 7, 13, 14}  # copyright, trademark, licence, licence url
for record in font["name"].names:
    if record.nameID in kept:
        continue
    text = record.toUnicode()
    renamed = text.replace("Mona Sans", "Boxbox Sans").replace("MonaSans", "BoxboxSans").replace("Mona", "Boxbox")
    if renamed != text:
        record.string = renamed
font.save(sys.argv[2])
PY
rm -r "$tmp"
pyftsubset "$martian" --unicodes="$unicodes" --layout-features='*' --flavor=woff2 --output-file="$out/martian-mono.woff2"
ls -l "$out"
