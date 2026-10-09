/* what plate a repo's favicon sits on, decided from the pixels. dark on dark was the bug v1 never fixed: a black svg
   on a dark window vanished, a white one on a light page did too. the image is sampled once (icons.ts, probe.ts) and
   this reads the sample, pure, so plate.test.ts pins every verdict.

   three plates:
   - light, a near white plate, for an icon whose ink is dark;
   - dark, the quiet dark glass of the provider mark (composer/mark.css), for one whose ink is light or bright;
   - bleed, no plate at all: an opaque, square, app-icon style image already is its own tile, so it fills the squircle. */

export type Plate = "light" | "dark" | "bleed";

/** the plates' colours, opaque so they read on the page's ground in both appearances (a translucent glass would vanish
    on the light page). the dark one is the provider mark's glass settled on the ground */
export const PLATE_LIGHT = "#f4f4f6";
export const PLATE_DARK = "#222328";

/** the side of the square the image is drawn into to be read */
export const SAMPLE = 48;

/** an ink closer to a plate than this (wcag contrast) is lost on it. 3:1 is the bar for a graphic that has to be read, but
    here two plates are being weighed against each other, and at 3 every mid-tone brand colour counts as lost on both;
    2:1 separates "gone" (a black icon on the dark plate, white on the light) from "quiet", which is the choice's point */
const LOST_BELOW = 2;

/** corners are opaque when every pixel in a patch this wide is: a transparent or rounded icon leaves them empty */
const CORNER = 0.06;

/** an image this near square can fill the tile without being cropped hard */
const SQUARE_WITHIN = 0.1;

/** less ink than this is no picture: a blank svg, an empty png */
const BLANK = 0.01;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** wcag relative luminance of an srgb pixel, 0 to 1 */
export function luminanceOf(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const luminanceOfHex = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return luminanceOf((n >> 16) & 255, (n >> 8) & 255, n & 255);
};

const LIGHT = luminanceOfHex(PLATE_LIGHT);
const DARK = luminanceOfHex(PLATE_DARK);

const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** the verdict for an image read as `size` by `size` rgba pixels, whose own shape is `aspect` wide over tall (1 when it
    has no size of its own, as an svg without a box). null when there is nothing to show */
export function plateOf(pixels: Uint8ClampedArray, size: number, aspect: number): Plate | null {
  const total = size * size;
  if (pixels.length < total * 4) return null;
  let ink = 0;
  let lostLight = 0;
  let lostDark = 0;
  let weighted = 0;
  for (let i = 0; i < total; i++) {
    const alpha = (pixels[i * 4 + 3] as number) / 255; // the length was checked above
    if (alpha === 0) continue;
    const lum = luminanceOf(pixels[i * 4] as number, pixels[i * 4 + 1] as number, pixels[i * 4 + 2] as number);
    ink += alpha;
    weighted += alpha * lum;
    if (ratio(lum, LIGHT) < LOST_BELOW) lostLight += alpha;
    if (ratio(lum, DARK) < LOST_BELOW) lostDark += alpha;
  }
  if (ink / total < BLANK) return null;
  if (aspect > 1 - SQUARE_WITHIN && aspect < 1 + SQUARE_WITHIN && ink / total > 0.98 && cornersOpaque(pixels, size)) return "bleed";
  if (lostLight !== lostDark) return lostLight < lostDark ? "light" : "dark";
  // a tie is a mid tone either plate holds: take the one it contrasts with more
  const mean = weighted / ink;
  return ratio(mean, LIGHT) >= ratio(mean, DARK) ? "light" : "dark";
}

function cornersOpaque(pixels: Uint8ClampedArray, size: number): boolean {
  const span = Math.max(1, Math.round(size * CORNER));
  for (const x0 of [0, size - span]) {
    for (const y0 of [0, size - span]) {
      for (let y = y0; y < y0 + span; y++) {
        for (let x = x0; x < x0 + span; x++) if ((pixels[(y * size + x) * 4 + 3] as number) < 250) return false;
      }
    }
  }
  return true;
}