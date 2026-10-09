import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Colour, declarations, evaluate, over, stripComments, toHex } from "./css-colour";
import { contrast, REPO_COLOURS, type RepoColour } from "./repo";

/* the window plane (a window, the composer's window and what it raises, the capsule, a machine, a swatch) is made of
   its repo's colour in both appearances (design.md, the two appearances): the deep pair with the light tone's accents
   on dark, the light tone washed into white with the deep top colour's accents on light. this proves, for all ten
   palettes in both appearances, that the plane's own words hold on its own material, read from the css's recipes in
   styles.css (css-colour.ts evaluates them as the browser does), and that a light window holds its shape on the
   light ground. */

const STYLES = stripComments(readFileSync(join(import.meta.dir, "..", "..", "styles.css"), "utf8"));
const PAGE = declarations(STYLES, ":root,\n.plane-window");
const PLANE = declarations(STYLES, ".plane-window,\n.win,\n.host");
const WINDOW = stripComments(readFileSync(join(import.meta.dir, "window.css"), "utf8"));
const FAIL_CHIP = declarations(WINDOW, '.win .chip[data-tone="fail"] {').get("background");

function tokens(colour: RepoColour, light: 0 | 1) {
  const vars = new Map<string, string>([...PAGE, ...PLANE]);
  vars.set("--L", String(light));
  vars.set("--c1", colour.top);
  vars.set("--c2", colour.bottom);
  vars.set("--hi", colour.light);
  return { get: (name: string) => evaluate(`var(${name})`, vars), evalIn: (expression: string) => evaluate(expression, vars) };
}

const same = (a: Colour, b: Colour) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a) * 255) < 0.5;

const ratioOn = (ink: Colour, back: Colour) => contrast(toHex(over(ink, back)), toHex(back));

for (const [light, label] of [[0, "dark"], [1, "light"]] as const) {
  describe(`the ${label} window plane`, () => {
    for (const colour of REPO_COLOURS) {
      const { get, evalIn } = tokens(colour, light);
      const ground = get("--ground");
      const material = [over(get("--win-1"), ground), over(get("--win-2"), ground)];
      const lit = over(get("--win-glow"), material[0] as Colour);
      const deep = [over(get("--win-deep-1"), ground), over(get("--win-deep-2"), ground)];

      test(`${colour.name}: the text, the secondary text, the prose and the accent hold 4.5:1 on the material and on a floating card`, () => {
        for (const back of [...material, ...deep]) {
          for (const name of ["--text", "--text-2", "--prose", "--accent"]) {
            expect(ratioOn(get(name), back), `${name} on ${toHex(back)}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      // the words that can sit under the highlight's brightest point, at the top left: the repo's name (the accent) and a title.
      // the light highlight is the strong one (white at 70%), and it is proved at its peak; the dark one is white at 13% and
      // its peak sits on the window's top edge, above the name, which the material test above already holds
      if (light) {
        test(`${colour.name}: under the highlight's brightest point the name and the title still hold 4.5:1`, () => {
          for (const name of ["--text", "--accent"]) expect(ratioOn(get(name), lit), name).toBeGreaterThanOrEqual(4.5);
        });
      }

      // dark red (#ff6b6b) on the deep tops falls between 3.6 and 4.4:1, as it always has (docs/open.md, red on a dark
      // window): it is held at 3:1 there until that is decided, and at 4.5:1 on the light material, which this change made
      test(`${colour.name}: red holds ${light ? "4.5" : "3"}:1 on the material`, () => {
        for (const back of material) expect(ratioOn(get("--red"), back), `--red on ${toHex(back)}`).toBeGreaterThanOrEqual(light ? 4.5 : 3);
      });

      test(`${colour.name}: the failed chip's red holds ${light ? "4.5" : "3"}:1 on its own red breath over the material`, () => {
        if (FAIL_CHIP === undefined) throw new Error("the failed chip has no background");
        const breath = evalIn(FAIL_CHIP);
        for (const back of material) expect(ratioOn(get("--red"), over(breath, back)), `--red on the chip over ${toHex(back)}`).toBeGreaterThanOrEqual(light ? 4.5 : 3);
      });

      if (light) {
        test(`${colour.name}: the third ink holds 4.5:1 on the light material, a floating card and a pressed option, so a word set in it is never a contrast bug`, () => {
          for (const back of [...material, ...deep, ...material.map((m) => over(get("--win-press"), m))]) {
            expect(ratioOn(get("--text-3"), back), `--text-3 on ${toHex(back)}`).toBeGreaterThanOrEqual(4.5);
          }
        });
      } else {
        // the light card is new; the dark plane is what it always was. each token here is exactly the literal the plane
        // used before it had tokens, so a light recipe cannot move a dark window
        test(`${colour.name}: the dark plane's tokens are exactly its old colours`, () => {
          const was: [string, string][] = [
            ["--win-1", colour.top],
            ["--win-2", colour.bottom],
            ["--accent", colour.light],
            ["--on-accent", colour.bottom],
            ["--win-glow", "rgb(255 255 255 / 0.13)"],
            ["--win-fill", "rgb(255 255 255 / 0.1)"],
            ["--win-press", "rgb(0 0 0 / 0.28)"],
            ["--win-me", "rgb(255 255 255 / 0.14)"],
            ["--win-me-ink", "#fff"],
            ["--text", "#f4f4f6"],
            ["--text-2", "rgb(244 244 246 / 0.62)"],
            ["--red", "#ff6b6b"],
            ["--add", "#9ff0b3"],
            ["--del", "#ffa3a3"],
          ];
          for (const [name, old] of was) expect(same(get(name), evalIn(old)), `${name} is ${old} on dark`).toBe(true);
        });
      }

      test(`${colour.name}: the diff colours hold 4.5:1 on the material`, () => {
        for (const back of material) for (const name of ["--add", "--del"]) expect(ratioOn(get(name), back), `${name} on ${toHex(back)}`).toBeGreaterThanOrEqual(4.5);
      });

      test(`${colour.name}: an option pressed into the window keeps its words at 4.5:1`, () => {
        for (const back of material) {
          const well = over(get("--win-press"), back);
          expect(ratioOn(get("--text"), well), "--text on --win-press").toBeGreaterThanOrEqual(4.5);
          expect(ratioOn(get("--text-2"), well), "--text-2 on --win-press").toBeGreaterThanOrEqual(4.5);
        }
      });

      test(`${colour.name}: the ink on the accent and on your words holds 4.5:1`, () => {
        for (const back of material) {
          expect(ratioOn(get("--on-accent"), over(get("--accent"), back)), "--on-accent on --accent").toBeGreaterThanOrEqual(4.5);
          expect(ratioOn(get("--win-me-ink"), over(get("--win-me"), back)), "--win-me-ink on --win-me").toBeGreaterThanOrEqual(4.5);
        }
      });

      test(`${colour.name}: the current window's ring (the accent) holds 3:1 against the ground it is drawn on`, () => {
        expect(ratioOn(get("--accent"), ground)).toBeGreaterThanOrEqual(3);
      });

      if (light) {
        test(`${colour.name}: a light window stands apart from the ground and carries its hue, so it reads as a card of its colour (slate, the greyest light tone, is the nearest; its edge and its cast carry the rest)`, () => {
          const top = material[0] as Colour;
          const apart = Math.hypot(top.r - ground.r, top.g - ground.g, top.b - ground.b);
          expect(apart, "the window's top stands apart from the ground").toBeGreaterThanOrEqual(10);
          const chroma = Math.max(top.r, top.g, top.b) - Math.min(top.r, top.g, top.b);
          expect(chroma, "the window's top is tinted, not grey").toBeGreaterThanOrEqual(8);
        });
      }
    }
  });
}
