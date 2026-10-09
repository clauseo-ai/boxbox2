/* what the browser paints above the app (the status bar's strip on ios, decision 19), as colours: pure, so the
   contrast tests hold it to the css it copies (stage-flood.test.ts). appearance.ts holds and paints it. */

import type { RepoColour } from "../window/repo";

/** one colour per appearance */
export type Chrome = { dark: string; light: string };

/** the top of a stage's flood in each appearance, as styles.css writes `--flood-1`: dark, the repo's top colour;
    light, its light tone at 62% in white (the same srgb mix the css makes; stage-flood.test.ts holds the two equal for
    every palette, so the strip above the app can never part from the flood under it) */
export function floodTop(colour: RepoColour): Chrome {
  return { dark: colour.top, light: mixHex(colour.light, "#ffffff", 0.62) };
}

function mixHex(a: string, b: string, share: number): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) * share + ch(b, i) * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}
