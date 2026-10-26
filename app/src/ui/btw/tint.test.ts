import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Colour, declarations, evaluate, lerp, over, stripComments, toHex } from "../window/css-colour";
import { ALL_COLOURS, contrast, type RepoColour } from "../window/repo";
import { BTW_COLOUR } from "./tint";

/* the btw tint (design.md, colour: the btw exception) passes the proofs every colour on the stage and the plane passes:
   4.5:1 for the words, read from the css recipes and evaluated as the browser does (css-colour.ts), in both appearances.
   two places wear it: the card, a citron wash over the stage's flood of every repo, and the composer window in btw
   mode, the window recipe with the citron palette in place of the repo's (stage-flood.test.ts and plane.test.ts hold
   the rest of each). */

const UI = join(import.meta.dir, "..");
const STYLES = stripComments(readFileSync(join(UI, "..", "styles.css"), "utf8"));
const STAGE = stripComments(readFileSync(join(UI, "thread", "stage.css"), "utf8"));
const CARD = stripComments(readFileSync(join(import.meta.dir, "card.css"), "utf8"));
const COMPOSER = stripComments(readFileSync(join(UI, "composer", "composer.css"), "utf8"));

const PAGE = declarations(STYLES, ":root,\n.plane-window");
/* the citron's three values, wherever styles.css declares them (once, on the root) */
const ROOT_TOKENS = new Map([...STYLES.matchAll(/(--btw-(?:top|bottom|tone)):\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]));
const STAGE_TOKENS = declarations(STYLES, ":where(.thread-stage, .thread, .details");
const PLANE = declarations(STYLES, ".plane-window,\n.win,\n.host");
const FLOOD_ROOT = declarations(STAGE, ".stage-bg {");
const BTW = declarations(CARD, ".btw {");
const CZ = declarations(COMPOSER, ".cz-window, .cz-card, .cz-strip, .cz-edge, .cz-menu {");

const SAMPLES = Array.from({ length: 21 }, (_, i) => i / 20);
const ratioOn = (ink: Colour, back: Colour) => contrast(toHex(over(ink, back)), toHex(back));

function floodAt(stops: [Colour, number][], t: number): Colour {
  for (let i = 1; i < stops.length; i++) {
    const [to, toAt] = stops[i] as [Colour, number];
    const [from, fromAt] = stops[i - 1] as [Colour, number];
    if (t <= toAt) return lerp(from, to, (t - fromAt) / (toAt - fromAt));
  }
  return (stops.at(-1) as [Colour, number])[0];
}

function stage(colour: RepoColour, light: 0 | 1) {
  const vars = new Map<string, string>([...PAGE, ...STAGE_TOKENS, ...ROOT_TOKENS, ...BTW]);
  vars.set("--L", String(light));
  vars.set("--tone", colour.light);
  vars.set("--window-top", colour.top);
  vars.set("--window-bottom", colour.bottom);
  const get = (name: string) => evaluate(`var(${name})`, vars);
  const stops = [...(FLOOD_ROOT.get("background") ?? "").matchAll(/var\((--flood-\d)\)\s+([\d.]+)%/g)].map((s) => [get(s[1] as string), Number(s[2]) / 100] as [Colour, number]);
  if (stops.length !== 3) throw new Error("the stage's flood is not three var(--flood-n) stops");
  return { get, stops, vars };
}

describe("the btw tint's values", () => {
  test("styles.css declares the same citron as tint.ts", () => {
    expect(ROOT_TOKENS.get("--btw-top")).toBe(BTW_COLOUR.top);
    expect(ROOT_TOKENS.get("--btw-bottom")).toBe(BTW_COLOUR.bottom);
    expect(ROOT_TOKENS.get("--btw-tone")).toBe(BTW_COLOUR.light);
  });

  test("it is no repo's colour", () => {
    for (const c of ALL_COLOURS) expect([c.top, c.bottom, c.light]).not.toContain(BTW_COLOUR.light);
  });

  // the palette rules every repo pair keeps (repo.ts): white body text on both ends, the light tone as text on the top,
  // the bottom as text on the light tone
  test("the pair holds the repo palette's three contrasts", () => {
    expect(contrast("#ffffff", BTW_COLOUR.top)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", BTW_COLOUR.bottom)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BTW_COLOUR.light, BTW_COLOUR.top)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BTW_COLOUR.bottom, BTW_COLOUR.light)).toBeGreaterThanOrEqual(4.5);
  });
});

for (const [light, label] of [[0, "dark"], [1, "light"]] as const) {
  describe(`a btw card on the ${label} flood`, () => {
    for (const colour of ALL_COLOURS) {
      const { get, stops, vars } = stage(colour, light);
      const wash = get("--btw-wash");
      test(`${colour.name}: the label, the question, the caption and the answer hold 4.5:1 on the wash from the top to the foot`, () => {
        for (const t of SAMPLES) {
          const back = over(wash, floodAt(stops, t));
          for (const name of ["--btw-ink", "--text", "--btw-quiet", "--prose"]) expect(ratioOn(get(name), back), `${name} at ${t * 100}% of the flood`).toBeGreaterThanOrEqual(4.5);
        }
      });
      // red as plane.test.ts holds it: 4.5:1 on light, 3:1 on the dark tops until docs/open.md's red on a dark window is decided
      test(`${colour.name}: an error's red holds ${light ? "4.5" : "3"}:1 on the wash`, () => {
        for (const t of SAMPLES) expect(ratioOn(get("--red"), over(wash, floodAt(stops, t))), `--red at ${t * 100}%`).toBeGreaterThanOrEqual(light ? 4.5 : 3);
      });
      // the marker sits in your bubble's meta line, in the bubble's own ink at 74% (as its "show all" does)
      test(`${colour.name}: the "from a btw" marker holds 4.5:1 on both ends of your bubble`, () => {
        const ink = evaluate("color-mix(in srgb, var(--you-ink) 74%, transparent)", vars);
        for (const end of ["--you-1", "--you-2"]) {
          const bubble = over(get(end), floodAt(stops, 1));
          expect(ratioOn(ink, bubble), end).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  });

  describe(`the composer window in btw mode, ${label}`, () => {
    const vars = new Map<string, string>([...PAGE, ...PLANE, ...CZ]);
    vars.set("--L", String(light));
    vars.set("--c1", BTW_COLOUR.top);
    vars.set("--c2", BTW_COLOUR.bottom);
    vars.set("--hi", BTW_COLOUR.light);
    const get = (name: string) => evaluate(`var(${name})`, vars);
    const ground = get("--ground");
    const material = [over(get("--win-1"), ground), over(get("--win-2"), ground)];
    test("the words, the line, the placeholder's ink and the accent hold 4.5:1 on its material", () => {
      for (const back of material) {
        for (const name of ["--cz-text", "--cz-ink-2", "--cz-dim", "--accent", "--text-2"]) expect(ratioOn(get(name), back), `${name} on ${toHex(back)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    test("send's ink holds 4.5:1 on the accent", () => {
      expect(ratioOn(get("--on-accent"), over(get("--accent"), material[0] as Colour))).toBeGreaterThanOrEqual(4.5);
    });
  });
}