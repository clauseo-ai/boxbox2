import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { args, type Colour, declarations, evaluate, lerp, over, stripComments, toHex } from "./css-colour";
import { floodTop } from "../settings/chrome";
import { contrast, REPO_COLOURS, type RepoColour } from "./repo";

/* the stage floods with the repo's colour in both appearances (design.md, colour), and every stop of the flood must
   hold 4.5:1 for the stage's text and accent. the flood is written once, in css, as color-mix recipes; this test reads
   those recipes out of styles.css and stage.css and evaluates them exactly as the browser does (css-colour.ts: srgb, premultiplied
   alpha), so the css cannot drift from what is proved here. a value the evaluator does not know throws, so a recipe
   that grows past it fails loudly instead of passing unchecked. */

const UI = join(import.meta.dir, "..");
const STYLES = stripComments(readFileSync(join(UI, "..", "styles.css"), "utf8"));
const STAGE = stripComments(readFileSync(join(UI, "thread", "stage.css"), "utf8"));
const THREAD = stripComments(readFileSync(join(UI, "thread", "thread.css"), "utf8"));
const DETAILS = stripComments(readFileSync(join(UI, "thread", "details.css"), "utf8"));

const PAGE = declarations(STYLES, ":root,\n.plane-window");
const STAGE_TOKENS = declarations(STYLES, ":where(.thread-stage, .thread, .details");
const FLOOD_ROOT = declarations(STAGE, ".stage-bg {");
const HIGHLIGHT = declarations(STAGE, ".stage-bg::after {");
const BAR_SUBTITLE = declarations(STAGE, ".stage-bar-title span {");
const DETAILS_TOKENS = declarations(DETAILS, ".details {");

/** a box-shadow value's words at the vars given, as comparable layers: `var()` layers are followed, every colour is evaluated, and a
    layer whose colour is fully transparent is dropped (it paints nothing, which is how a light-only layer is absent in dark) */
function shadowLayers(value: string, vars: Map<string, string>): string[] {
  const words = (layer: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= layer.length; i++) {
      const ch = layer[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if ((ch === " " && depth === 0) || i === layer.length) {
        if (i > start) out.push(layer.slice(start, i));
        start = i + 1;
      }
    }
    return out;
  };
  const out: string[] = [];
  for (const layer of args(value)) {
    const ref = /^var\((--[\w-]+)\)$/.exec(layer.trim());
    if (ref) {
      const next = vars.get(ref[1] as string);
      if (next === undefined) throw new Error(`${layer} is not set`);
      out.push(...shadowLayers(next, vars));
      continue;
    }
    const parts = words(layer.trim());
    const inset = parts[0] === "inset";
    const rest = inset ? parts.slice(1) : parts;
    const isLength = (word: string) => /^-?[\d.]+(px)?$/.test(word);
    const colour = evaluate(rest.filter((word) => !isLength(word)).join(" "), vars);
    if (colour.a === 0) continue;
    out.push(`${inset ? "inset " : ""}${rest.filter(isLength).map((word) => word.replace(/px$/, "")).join(" ")} ${toHex(colour)}/${Math.round(colour.a * 1000) / 1000}`);
  }
  return out;
}

/** the gradient's stops as the stage paints them: [token, position] */
function floodStops(): [string, number][] {
  const stops = [...(FLOOD_ROOT.get("background") ?? "").matchAll(/var\((--flood-\d)\)\s+([\d.]+)%/g)].map((s) => [s[1] as string, Number(s[2]) / 100] as [string, number]);
  if (stops.length !== 3) throw new Error("the stage's flood is not three var(--flood-n) stops");
  return stops;
}

/** every token the stage reads, for a repo's colour in an appearance (`light`: 0 or 1) */
function tokens(colour: RepoColour, light: 0 | 1) {
  const vars = new Map<string, string>([...PAGE, ...STAGE_TOKENS]);
  vars.set("--L", String(light));
  vars.set("--tone", colour.light);
  vars.set("--window-top", colour.top);
  vars.set("--window-bottom", colour.bottom);
  const get = (name: string) => evaluate(`var(${name})`, vars);
  const subtitle = BAR_SUBTITLE.get("color");
  if (subtitle === undefined) throw new Error("the bar's subtitle has no colour");
  return { vars, get, evalIn: (expression: string) => evaluate(expression, vars), flood: floodStops().map(([name, at]) => [get(name), at] as [Colour, number]), barSubtitle: evaluate(subtitle, vars) };
}

/** what the stage's highlight lays over the flood at its brightest, as an alpha over white */
function highlightPeak(light: 0 | 1): number {
  const vars = new Map<string, string>([["--L", String(light)]]);
  const m = /color-mix\(in srgb,\s*(rgb\([^)]*\))\s*calc\(var\(--L\) \* 100%\),\s*(rgb\([^)]*\))\)/.exec(HIGHLIGHT.get("background") ?? "");
  if (!m) throw new Error("the highlight is not a light/dark color-mix of two whites");
  return evaluate(`color-mix(in srgb, ${m[1]} calc(var(--L) * 100%), ${m[2]})`, vars).a;
}

/** the colour of the flood at `t` (0 top, 1 foot), by linear interpolation between stops in srgb, as css does */
function floodAt(stops: [Colour, number][], t: number): Colour {
  for (let i = 1; i < stops.length; i++) {
    const [to, toAt] = stops[i] as [Colour, number];
    const [from, fromAt] = stops[i - 1] as [Colour, number];
    if (t <= toAt) return lerp(from, to, (t - fromAt) / (toAt - fromAt));
  }
  return (stops.at(-1) as [Colour, number])[0];
}

/** the share of its colour a diff line's tint holds, `calc(a% + var(--L) * b%)`, read from the rule so the test follows the css */
function tintShare(selector: string, light: 0 | 1): number {
  const m = new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{[^}]*calc\\((\\d+)% \\+ var\\(--L\\) \\* (\\d+)%\\)`).exec(THREAD);
  if (!m) throw new Error(`${selector} has no tint of the form calc(a% + var(--L) * b%)`);
  return (Number(m[1]) + light * Number(m[2])) / 100;
}

const INK = ["--text", "--text-2", "--prose", "--accent"] as const;
const DIFF = ["--add", "--del"] as const;
const SAMPLES = Array.from({ length: 21 }, (_, i) => i / 20);
/** the log never sits above the title block, 20% of the way down at the shortest stage: the red of a failed row is read below it */
const BELOW_TITLE = SAMPLES.filter((t) => t >= 0.2);

for (const [light, label] of [[0, "dark"], [1, "light"]] as const) {
  describe(`the ${label} flood`, () => {
    for (const colour of REPO_COLOURS) {
      const { vars, get, evalIn, flood, barSubtitle } = tokens(colour, light);
      const ratioOn = (ink: Colour, back: Colour) => contrast(toHex(over(ink, back)), toHex(back));

      test(`${colour.name}: the text, the secondary text, the prose and the accent hold 4.5:1 from the top to the foot`, () => {
        for (const t of SAMPLES) {
          for (const name of INK) expect(ratioOn(get(name), floodAt(flood, t)), `${name} at ${t * 100}% of the flood`).toBeGreaterThanOrEqual(4.5);
        }
      });

      test(`${colour.name}: under the highlight's brightest point the words that can sit there still hold 4.5:1`, () => {
        const lit = over({ r: 255, g: 255, b: 255, a: highlightPeak(light) }, floodAt(flood, 0));
        expect(ratioOn(get("--text"), lit), "--text").toBeGreaterThanOrEqual(4.5);
        expect(ratioOn(get("--prose"), lit), "--prose").toBeGreaterThanOrEqual(4.5);
        expect(ratioOn(get("--accent"), lit), "--accent").toBeGreaterThanOrEqual(4.5);
        expect(ratioOn(barSubtitle, lit), "the bar's subtitle").toBeGreaterThanOrEqual(4.5);
      });

      test(`${colour.name}: the diff colours hold 4.5:1 on every stop and on a bed laid over it`, () => {
        const bed = get("--bed");
        for (const [stop] of flood) {
          for (const back of [stop, over(bed, stop)]) {
            for (const name of DIFF) expect(ratioOn(get(name), back), `${name} on ${toHex(back)}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      test(`${colour.name}: a bed's text and its tinted diff lines hold 4.5:1 over every stop`, () => {
        const bed = get("--bed");
        const tints = [["--add", ".bed .la"], ["--del", ".bed .ld"]] as const;
        for (const [stop] of flood) {
          const paper = over(bed, stop);
          expect(ratioOn(get("--text"), paper), "--text on the bed").toBeGreaterThanOrEqual(4.5);
          expect(ratioOn(get("--text-2"), paper), "--text-2 on the bed").toBeGreaterThanOrEqual(4.5);
          for (const [name, rule] of tints) {
            const line = over({ ...get(name), a: tintShare(rule, light) }, paper);
            expect(ratioOn(get(name), line), `${name} on its own tinted line`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      test(`${colour.name}: the ink on the accent fill and on your message holds 4.5:1`, () => {
        expect(ratioOn(get("--on-accent"), over(get("--accent"), flood[0]?.[0] as Colour)), "--on-accent on --accent").toBeGreaterThanOrEqual(4.5);
        for (const bubble of ["--you-1", "--you-2"]) {
          for (const [stop] of flood) expect(ratioOn(get("--you-ink"), over(get(bubble), stop)), `--you-ink on ${bubble}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      // the ledger's clock is 10.5 px, so it is --text-2: --text-3 is the page's quiet ink and falls under 4.5:1 on the flood
      test(`${colour.name}: the margin clock (--text-2, 10.5 px) holds 4.5:1 on every stop`, () => {
        expect(THREAD).toMatch(/\.row-t \{[^}]*color: var\(--text-2\)/);
        for (const [stop] of flood) expect(ratioOn(get("--text-2"), stop), "--text-2").toBeGreaterThanOrEqual(4.5);
      });

      // the ledger's and the tape's small words that carry something (a directory, a pause, a time label, a lane's name) are --text-2
      // too: --text-3 decorates and falls under 4.5:1 on the flood. they sit on the flood, and the tape's words on its well
      test(`${colour.name}: the small information-bearing words of the ledger and the tape are --text-2 and hold 4.5:1 on every stop and on the well`, () => {
        for (const rule of [".dir", ".gap", ".tp-scale span", ".lane-hd", ".lane-name span"]) {
          expect(THREAD, rule).toMatch(new RegExp(`${rule.replace(/[.]/g, "\\.")} \\{[^}]*color: var\\(--text-2\\)`));
        }
        const well = get("--well");
        for (const [stop] of flood) {
          expect(ratioOn(get("--text-2"), stop), "--text-2").toBeGreaterThanOrEqual(4.5);
          expect(ratioOn(get("--text-2"), over(well, stop)), "--text-2 on the well").toBeGreaterThanOrEqual(4.5);
        }
      });

      // a running turn's tape floats as a card in the flood's own foot colour, lifted toward the light (thread.css, --card)
      test(`${colour.name}: the stuck tape's card is the flood's foot colour lifted toward the light, and its words hold 4.5:1 on it`, () => {
        const card = declarations(THREAD, ".tape {").get("--card");
        expect(card, "the tape's --card").toMatch(/var\(--flood-3\)/);
        const back = evalIn(card as string);
        expect(back.a, "the card is opaque").toBe(1);
        for (const name of ["--text", "--text-2", "--accent", "--red"]) expect(ratioOn(get(name), back), `${name} on the card`).toBeGreaterThanOrEqual(4.5);
      });

      // dark is what it always was: every base token the stage declares again is the page's own value at --L: 0
      // (a light-only recipe that drifted into the dark would change the dark stage, which must not move)
      if (!light) {
        test(`${colour.name}: the base tokens the stage declares again are the page's own in dark`, () => {
          const page = new Map(PAGE);
          page.set("--L", "0");
          for (const name of ["--text", "--text-2", "--text-3", "--hairline", "--hover", "--pill", "--knob", "--well", "--bed", "--scrim"]) {
            const want = evaluate(`var(${name})`, page);
            const got = get(name);
            expect([got.r, got.g, got.b, got.a].map((v) => Math.round(v * 1000) / 1000), name).toEqual([want.r, want.g, want.b, want.a].map((v) => Math.round(v * 1000) / 1000));
          }
        });

        // the shadow tokens too: where the page has the counterpart the stage's dark side is it; the rest are what the stage's own
        // shadows were before light had a say (--drop: a 70% black drop; --bed-edge: the hairline ring; the light-only ones: nothing)
        test(`${colour.name}: the shadow tokens the stage declares are the page's own, or what they were, in dark`, () => {
          const page = new Map(PAGE);
          page.set("--L", "0");
          for (const name of ["--well-edge", "--glass-edge", "--lift"]) expect(shadowLayers(vars.get(name) as string, vars), name).toEqual(shadowLayers(page.get(name) as string, page));
          expect(shadowLayers(vars.get("--drop") as string, vars), "--drop").toEqual(["0 14 30 -12 #000000/0.7"]);
          expect(shadowLayers(vars.get("--bed-edge") as string, vars), "--bed-edge").toEqual(["inset 0 0 0 1 #ffffff/0.08"]);
          for (const name of ["--bed-lit", "--knob-edge"]) expect(shadowLayers(vars.get(name) as string, vars), name).toEqual([]);
          const details = new Map(vars);
          for (const [name, value] of DETAILS_TOKENS) details.set(name, value);
          expect(shadowLayers(details.get("--tile-lit") as string, details), "--tile-lit").toEqual([]);
        });
      }

      // light's third ink carries words (a dismiss, a placeholder, a stopped line's time, a thought's clock): it holds 4.5:1 on the
      // flood, on a well and a bed laid over it, and on the details' paper. dark's third ink decorates and is not held to it. the
      // pill (the details' close button and current turn, a menu's buttons) is a tint over the flood or over the panel's paper
      if (light) {
        test(`${colour.name}: the third ink holds 4.5:1 on every stop, the well, the bed and the paper`, () => {
          for (const [stop] of flood) {
            for (const back of [stop, over(get("--well"), stop), over(get("--bed"), stop), over(get("--well"), over(get("--well"), stop))]) {
              expect(ratioOn(get("--text-3"), back), `--text-3 on ${toHex(back)}`).toBeGreaterThanOrEqual(4.5);
            }
          }
          for (const paper of [get("--paper-1"), get("--paper-2")]) {
            for (const name of [...INK, "--text-3", ...DIFF, "--red"]) expect(ratioOn(get(name), paper), `${name} on the paper ${toHex(paper)}`).toBeGreaterThanOrEqual(4.5);
          }
        });

        test(`${colour.name}: the text and the second ink hold 4.5:1 on the pill, over every stop and over the paper`, () => {
          const pill = get("--pill");
          for (const back of [...flood.map(([stop]) => stop), get("--paper-1"), get("--paper-2")]) {
            for (const name of ["--text", "--text-2"]) expect(ratioOn(get(name), over(pill, back)), `${name} on the pill over ${toHex(back)}`).toBeGreaterThanOrEqual(4.5);
          }
        });
      }

      test(`${colour.name}: red holds 4.5:1 below the title block`, () => {
        for (const t of BELOW_TITLE) expect(ratioOn(get("--red"), floodAt(flood, t)), `--red at ${t * 100}% of the flood`).toBeGreaterThanOrEqual(4.5);
      });

      test(`${colour.name}: the foot is never the bare ground, so the stage's corners hold against it`, () => {
        const ground = get("--ground");
        const foot = (flood.at(-1) as [Colour, number])[0];
        expect(Math.hypot(foot.r - ground.r, foot.g - ground.g, foot.b - ground.b)).toBeGreaterThanOrEqual(light ? 10 : 28);
      });
    }
  });
}
// the strip above the app (the status bar's, on ios) is painted in the flood's top while a thread is open on the deck
// (settings/chrome.ts, floodTop): js writes the same mix the css makes, and this holds the two equal, so a change to
// the flood's recipe cannot leave a band of the old colour above the stage
describe("the browser chrome over a deck's stage", () => {
  for (const colour of REPO_COLOURS) {
    test(`${colour.name}: is the flood's top, exactly, in both appearances`, () => {
      const chrome = floodTop(colour);
      expect(toHex(tokens(colour, 0).get("--flood-1")), "dark").toBe(chrome.dark);
      expect(toHex(tokens(colour, 1).get("--flood-1")), "light").toBe(chrome.light);
    });
  }
});
