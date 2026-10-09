import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Colour, declarations, evaluate, lerp, over, stripComments, toHex } from "../window/css-colour";
import { REPO_COLOURS, contrast } from "../window/repo";

/* the code's colours (thread.css, .cblock) are tokens that read the appearance. a code block is a bed, and a bed is a tint over
   the stage's flood, so a colour holds 4.5:1 only if it holds on the bed over every stop of every repo's flood, in both appearances.
   this reads the recipes out of the stylesheets and evaluates them as the browser does (window/css-colour.ts), so the css cannot
   drift from what is proved here. CONTRAST_TABLE=1 prints the numbers. */

const UI = join(import.meta.dir, "..");
const STYLES = stripComments(readFileSync(join(UI, "..", "styles.css"), "utf8"));
const THREAD = stripComments(readFileSync(join(UI, "thread", "thread.css"), "utf8"));

const PAGE = declarations(STYLES, ":root,\n.plane-window");
const STAGE_TOKENS = declarations(STYLES, ":where(.thread-stage, .thread, .details");
const BLOCK = declarations(THREAD, ".cblock {");

/** what each token is on: the code's own colours on the bed; the control's words on the bed, on the stage's flood in the reply's line, and on a report's well */
const CODE = ["--text", "--text-2", "--accent", "--hl-key", "--hl-str", "--hl-num", "--hl-fn", "--hl-type"] as const;
const TOKENS = [...BLOCK.keys()].filter((k) => k.startsWith("--hl-"));

/** the tint a diff line carries, `calc(a% + var(--L) * b%)`, read from its rule */
function tint(selector: string, light: 0 | 1): number {
  const m = new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{[^}]*calc\\((\\d+)% \\+ var\\(--L\\) \\* (\\d+)%\\)`).exec(THREAD);
  if (!m) throw new Error(`${selector} has no tint of the form calc(a% + var(--L) * b%)`);
  return (Number(m[1]) + light * Number(m[2])) / 100;
}

const rows: string[] = [];

for (const [light, label] of [[0, "dark"], [1, "light"]] as const) {
  describe(`code, the ${label} appearance`, () => {
    test("every colour of the code is declared, and the css declares no one this test does not know", () => {
      expect(TOKENS.sort()).toEqual(["--hl-fn", "--hl-key", "--hl-num", "--hl-str", "--hl-type"]);
    });

    let worst = new Map<string, [number, string]>();
    for (const colour of REPO_COLOURS) {
      const vars = new Map<string, string>([...PAGE, ...STAGE_TOKENS, ...BLOCK]);
      vars.set("--L", String(light));
      vars.set("--tone", colour.light);
      vars.set("--window-top", colour.top);
      vars.set("--window-bottom", colour.bottom);
      const get = (name: string): Colour => evaluate(`var(${name})`, vars);
      const flood = ["--flood-1", "--flood-2", "--flood-3"].map(get);
      // the stops and the points halfway between them: the gradient is linear in srgb between its stops
      const stops: Colour[] = [flood[0] as Colour, lerp(flood[0] as Colour, flood[1] as Colour, 0.5), flood[1] as Colour, lerp(flood[1] as Colour, flood[2] as Colour, 0.5), flood[2] as Colour];
      const ratio = (ink: Colour, back: Colour) => contrast(toHex(over(ink, back)), toHex(back));

      test(`${colour.name}: the code's colours hold 4.5:1 on the bed over every stop of the flood`, () => {
        const bed = get("--bed");
        for (const stop of stops) {
          const paper = over(bed, stop);
          for (const name of [...CODE]) {
            const r = ratio(get(name), paper);
            const was = worst.get(name);
            if (!was || r < was[0]) worst.set(name, [r, colour.name]);
            expect(r, `${name} on the bed over ${toHex(stop)}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      test(`${colour.name}: a diff fence's tinted lines hold 4.5:1`, () => {
        const bed = get("--bed");
        for (const stop of stops) {
          for (const [name, rule] of [["--add", ".cblock .hljs-addition"], ["--del", ".cblock .hljs-deletion"]] as const) {
            const line = over({ ...get(name), a: tint(rule, light) }, over(bed, stop));
            const r = ratio(get(name), line);
            const was = worst.get(`${name} line`);
            if (!was || r < was[0]) worst.set(`${name} line`, [r, colour.name]);
            expect(r, `${name} on its own tinted line`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      test(`${colour.name}: the control's words (the second ink, the accent when copied, red when refused) hold 4.5:1 on the bed, its chip and the report's well`, () => {
        const bed = get("--bed");
        const well = get("--well");
        const pill = get("--pill");
        // red is read below the title block, as everywhere (stage-flood.test.ts): not at the very top of the flood
        for (const [at, stop] of stops.entries()) {
          for (const base of [over(bed, stop), over(well, stop), over(pill, over(bed, stop))]) {
            for (const name of at === 0 ? ["--text-2", "--text", "--accent"] : ["--text-2", "--text", "--accent", "--red"]) {
              const r = ratio(get(name), base);
              const was = worst.get(`${name} (control)`);
              if (!was || r < was[0]) worst.set(`${name} (control)`, [r, colour.name]);
              expect(r, `${name} on ${toHex(base)}`).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      });
    }

    test("the lowest ratio of each colour across the ten palettes", () => {
      if (process.env["CONTRAST_TABLE"]) {
        for (const [name, [r, where]] of worst) rows.push(`${label.padEnd(5)} ${name.padEnd(22)} ${r.toFixed(2)}  (${where})`);
        console.log(rows.join("\n"));
        rows.length = 0;
      }
      expect(worst.size).toBeGreaterThan(0);
    });
  });
}
