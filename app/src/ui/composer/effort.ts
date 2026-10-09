/* the effort ladder, as the composer draws it (docs/composer.md, the effort meter): which of a model's efforts are levels
   on the ladder and which are its profile's named variants, and how many bars of the meter an effort fills. pure, so the
   chip, the dial and the model rows all read one rule. */

/** the levels cmx2 knows, lowest first. a model accepts some of them (its `efforts`), then its profile's named variants */
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** what the meter draws while the host's own list is not here: the levels every model that reasons takes */
export const DEFAULT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const rank = (name: string): number => (LEVELS as readonly string[]).indexOf(name);

/** a model's efforts split in two: the levels in ladder order, and the named variants in the order the profile lists them */
export type Scale = { levels: string[]; named: string[] };

export function scaleOf(accepted: readonly string[]): Scale {
  const levels = accepted.filter((name) => rank(name) >= 0).sort((a, b) => rank(a) - rank(b));
  const named = accepted.filter((name) => rank(name) < 0);
  return { levels: levels.filter((name, at) => levels.indexOf(name) === at), named };
}

/** the meter's shape for one effort: how many bars the scale has, how many are lit, and whether the effort is a named
    variant (which lights none, since it is not a step on the ladder) */
export type Meter = { bars: number; filled: number; variant: boolean };

/** one bar for every level above none; an effort lights the bars at or below its own rung, so an effort a model does not
    list (a thread started on another model) still reads as the nearest rung it has. none lights nothing, like no pick */
export function meterOf(levels: readonly string[], effort: string | null): Meter {
  const ladder = (levels.length > 0 ? levels : DEFAULT_LEVELS).filter((name) => name !== "none");
  const bars = Math.max(1, ladder.length);
  if (!effort) return { bars, filled: 0, variant: false };
  const at = rank(effort);
  if (at < 0) return { bars, filled: 0, variant: true };
  return { bars, filled: ladder.filter((name) => rank(name) <= at).length, variant: false };
}

/** a model's efforts in a few words, for a row: "low to max", "high", "low to max, 2 named", "no effort" */
export function effortRange(accepted: readonly string[]): string {
  const { levels, named } = scaleOf(accepted);
  const first = levels[0];
  const last = levels.at(-1);
  const span = first === undefined || last === undefined ? "" : first === last ? first : `${first} to ${last}`;
  const extra = named.length > 0 ? `${named.length} named` : "";
  return [span, extra].filter(Boolean).join(", ") || "no effort";
}
