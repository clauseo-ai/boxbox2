/* the css colour evaluator the contrast tests share (stage-flood.test.ts, plane.test.ts). the app's colours are
   written once, in css, as color-mix recipes over `--L` (design.md, the two appearances); a test reads a rule's
   declarations out of the stylesheet and evaluates them exactly as the browser does (srgb, premultiplied alpha), so
   the css cannot drift from what the test proves. a value the evaluator does not know throws, so a recipe that grows
   past it fails loudly instead of passing unchecked. test code only: nothing in the app imports it. */

export type Colour = { r: number; g: number; b: number; a: number };

/** a stylesheet's text without its comments */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** the declarations of the first rule whose selector starts with `selector` */
export function declarations(css: string, selector: string): Map<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no rule starts with ${selector}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === "(") depth++;
    else if (css[end] === ")") depth--;
    else if (css[end] === "}" && depth === 0) break;
  }
  const body = css.slice(open + 1, end);
  const out = new Map<string, string>();
  let start = 0;
  depth = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === ";" && depth === 0) || i === body.length) {
      const text = body.slice(start, i).trim();
      start = i + 1;
      const colon = text.indexOf(":");
      if (colon > 0) out.set(text.slice(0, colon).trim(), text.slice(colon + 1).trim());
    }
  }
  return out;
}

/** top-level comma split of a function's arguments */
export function args(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** the text of the call `name(...)` that `value` is, without the name and the outer parentheses */
export function inside(value: string, name: string): string | undefined {
  const text = value.trim();
  if (!text.startsWith(`${name}(`) || !text.endsWith(")")) return undefined;
  return text.slice(name.length + 1, -1);
}

function hex(text: string): Colour {
  const h = text.length === 4 ? [...text.slice(1)].map((c) => c + c).join("") : text.slice(1);
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

/** an `N%`, a `calc(var(--L) * N%)` or a `calc(A% + var(--L) * N%)`, as a fraction */
export function percent(text: string, vars: Map<string, string>): number {
  const calc = inside(text, "calc");
  if (calc !== undefined) {
    const m = /^(?:([\d.]+)%\s*\+\s*)?var\((--[\w-]+)\)\s*\*\s*([\d.]+)%$/.exec(calc.trim());
    if (!m) throw new Error(`calc this evaluator does not know: ${text}`);
    return (Number(m[1] ?? 0) + Number(vars.get(m[2] as string)) * Number(m[3])) / 100;
  }
  const m = /^([\d.]+)%$/.exec(text.trim());
  if (!m) throw new Error(`percentage this evaluator does not know: ${text}`);
  return Number(m[1]) / 100;
}

/** `rgb(r g b / a)` or `rgb(r g b)` with space-separated channels, as the tokens write them */
function rgb(body: string): Colour {
  const m = /^(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?$/.exec(body.trim());
  if (!m) throw new Error(`rgb this evaluator does not know: ${body}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

/** a colour value: a hex, `transparent`, `rgb()`, `var(--x)` or `var(--x, fallback)`, or a `color-mix(in srgb, ...)` of those */
export function evaluate(value: string, vars: Map<string, string>): Colour {
  const text = value.trim();
  if (text.startsWith("#")) return hex(text);
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const ref = inside(text, "var");
  if (ref !== undefined) {
    const [name, fallback] = args(ref) as [string, string | undefined];
    const next = vars.get(name) ?? fallback;
    if (next === undefined) throw new Error(`${text} is not set`);
    return evaluate(next, vars);
  }
  const channels = inside(text, "rgb");
  if (channels !== undefined) return rgb(channels);
  const mixArgs = inside(text, "color-mix");
  if (mixArgs === undefined) throw new Error(`value this evaluator does not know: ${text}`);
  const [space, first, second] = args(mixArgs) as [string, string, string];
  if (space !== "in srgb") throw new Error(`colour space this evaluator does not know: ${space}`);
  const split = (part: string): [string, number | undefined] => {
    // a trailing percentage is a top-level word after the colour; `calc(...)` is balanced, so find the last top-level space
    let depth = 0;
    for (let i = part.length - 1; i >= 0; i--) {
      if (part[i] === ")") depth++;
      else if (part[i] === "(") depth--;
      else if (part[i] === " " && depth === 0) {
        const tail = part.slice(i + 1);
        if (/^[\d.]+%$/.test(tail) || tail.startsWith("calc(")) return [part.slice(0, i), percent(tail, vars)];
        break;
      }
    }
    return [part, undefined];
  };
  const [aText, aShare] = split(first);
  const [bText, bShare] = split(second);
  const p1 = aShare ?? (bShare === undefined ? 0.5 : 1 - bShare);
  const p2 = bShare ?? 1 - p1;
  const a = evaluate(aText, vars);
  const b = evaluate(bText, vars);
  const alpha = a.a * p1 + b.a * p2;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const pre = (x: number, y: number) => (x * a.a * p1 + y * b.a * p2) / alpha;
  return { r: pre(a.r, b.r), g: pre(a.g, b.g), b: pre(a.b, b.b), a: alpha };
}

export const toHex = (c: Colour): string => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/** `fore` laid over the opaque `back` */
export function over(fore: Colour, back: Colour): Colour {
  return { r: fore.r * fore.a + back.r * (1 - fore.a), g: fore.g * fore.a + back.g * (1 - fore.a), b: fore.b * fore.a + back.b * (1 - fore.a), a: 1 };
}

export function lerp(a: Colour, b: Colour, t: number): Colour {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 };
}
