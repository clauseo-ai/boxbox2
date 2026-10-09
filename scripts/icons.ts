/* the home-screen icons, rasterised from the one drawing (app/public/icon.svg)
   so they never drift from it. resvg renders the same pixels on every
   machine, so running this again over an unchanged svg writes the same
   bytes; the pngs are committed and the build never runs it.

   the drawing is a window, full bleed: one shape (#shape) clips the
   window's colour and draws its lit edge, and the work on it (the title,
   the tail, the cursor) is one group (#work).

   - icon-192.png, icon-512.png: the drawing as it is, rounded, for the
     manifest's "any" purpose (chromium shows them as they are).
   - maskable-512.png: the shape squared, so the platform's own mask (a
     circle, a squircle) cuts only window, and the work drawn at 84% about
     the centre so all of it sits inside the safe zone, the circle of 40%
     radius: its farthest outline point lands 199.7 px from the centre of
     512, the zone's edge 204.8 (237.7 at full size).
   - apple-touch-icon.png (180): the shape squared, the work at full size,
     since ios rounds the corners itself, only that far, and paints
     transparent ones black.

   bun scripts/icons.ts [--check]   (--check fails when a committed png differs) */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
// the rasteriser is the app workspace's dev dependency (app/package.json); bun installs each workspace's
// dependencies beside it, so a root script names the app's copy
import { Resvg } from "../app/node_modules/@resvg/resvg-js/index.js";

const PUBLIC = resolve(import.meta.dir, "../app/public");
const SOURCE = join(PUBLIC, "icon.svg");
/** the window's rounded shape in the drawing; the full-bleed variants square it */
const ROUNDED_SHAPE = '<rect id="shape" width="512" height="512" rx="112"/>';
const SQUARE_SHAPE = '<rect id="shape" width="512" height="512"/>';
/** the work on the window; the maskable variant draws it smaller about the centre */
const WORK = '<g id="work">';
const SAFE_WORK = '<g id="work" transform="translate(256 256) scale(.84) translate(-256 -256)">';

const svg = readFileSync(SOURCE, "utf8");
for (const marker of [ROUNDED_SHAPE, WORK]) {
  if (svg.split(marker).length !== 2) {
    console.error(`icons: ${SOURCE} no longer holds exactly one ${marker}; update this script with it`);
    process.exit(1);
  }
}
const fullBleed = svg.replace(ROUNDED_SHAPE, SQUARE_SHAPE);
const maskable = fullBleed.replace(WORK, SAFE_WORK);

const ICONS: Array<{ file: string; size: number; source: string }> = [
  { file: "icons/icon-192.png", size: 192, source: svg },
  { file: "icons/icon-512.png", size: 512, source: svg },
  { file: "icons/maskable-512.png", size: 512, source: maskable },
  { file: "icons/apple-touch-icon.png", size: 180, source: fullBleed },
];

const check = process.argv.includes("--check");
let stale = 0;
for (const { file, size, source } of ICONS) {
  const png = new Resvg(source, { fitTo: { mode: "width", value: size }, shapeRendering: 2, textRendering: 0 }).render().asPng();
  const path = join(PUBLIC, file);
  if (check) {
    let committed: Buffer | null = null;
    try {
      committed = readFileSync(path);
    } catch {
      /* missing counts as stale */
    }
    const same = committed !== null && Buffer.compare(committed, png) === 0;
    if (!same) stale++;
    console.log(`${same ? "ok   " : "stale"} ${file}`);
    continue;
  }
  writeFileSync(path, png);
  console.log(`${file.padEnd(28)} ${String(size).padStart(4)} px ${String(png.length).padStart(7)} bytes`);
}
if (stale) {
  console.error(`icons: ${stale} png differs from icon.svg; run bun scripts/icons.ts`);
  process.exit(1);
}
