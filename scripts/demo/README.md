# demo capture

records the readme's animated demo of the web app from ladle stories only: the
recorded journal through the real reducer and home. no daemon, no model, no
network but a local vite server, so it costs nothing.

phone (390x844) and desktop (1280x800) are recorded with playwright's video
recorder, joined side by side at one height and written as an animated webp.

```sh
bun install --frozen-lockfile
bun scripts/demo/capture.ts --out assets/demo                # demo-dark.webp
bun scripts/demo/capture.ts --theme light --out assets/demo  # demo-light.webp
bun scripts/demo/capture.ts --split --out /tmp/demo          # plus phone-*, desktop-*
```

needs ffmpeg and img2webp (`brew install ffmpeg webp`) and a chromium (`--chrome`,
`$CHROME_PATH`, or one under `~/.agent-browser`). under an empty `HOME`, set
`PLAYWRIGHT_BROWSERS_PATH` to the real browser cache so the recorder finds ffmpeg.

change the story list in `SCENES` at the top of `capture.ts`: story ids from
ladle's `/meta.json`, each with a length and timed steps; phone and desktop must
add up to the same length. a motion pass is on another branch, so revisit it.

size: files together stay under 4 MB (`--budget-mb`), else exit 1. lower `--fps`
(15), `--height` (600) or `--quality` (60).
