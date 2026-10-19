/* repo colours (docs/design.md, colour): ten deep hues, each a pair for
   the window's gradient and a light tone for chips, asks and accents.
   colour always means which repo, never a state. only failure is red, and
   red is not one of these.

   the server gives each repo (a host plus its root) its colour when it
   first sees it and remembers it: the hue fewest of that host's repos wear,
   the repo's hash colour when that one is free. a person can choose
   another, and every device shows it. the stream carries both (`colour`
   entries, the snapshot's `colours`), so this file only resolves a name to
   a hue; the hash is the fallback for a repo the server has not spoken for
   yet, or for a name this build does not know.

   every pair holds 4.5:1 for white body text at both ends of the
   gradient, the light tone holds 4.5:1 as text on the top colour (the
   repo name), and the bottom colour holds 4.5:1 as text on the light
   tone (a filled chip, the primary option). repo.test.ts proves all
   three for every hue. */

export type RepoColour = {
  name: string;
  /** the gradient's top */
  top: string;
  /** the gradient's bottom */
  bottom: string;
  /** chips, asks, accents */
  light: string;
};

export const REPO_COLOURS: readonly RepoColour[] = [
  { name: "green", top: "#004a2c", bottom: "#002319", light: "#80e9a8" },
  { name: "violet", top: "#34298a", bottom: "#171240", light: "#b7abff" },
  { name: "rose", top: "#721743", bottom: "#2e0820", light: "#ffa9ca" },
  { name: "cobalt", top: "#19359c", bottom: "#101048", light: "#adc2ff" },
  { name: "blue", top: "#004077", bottom: "#071938", light: "#9fd0ff" },
  { name: "teal", top: "#00484b", bottom: "#002025", light: "#7ee2db" },
  { name: "sunset", top: "#761521", bottom: "#300936", light: "#ffbc91" },
  { name: "plum", top: "#512977", bottom: "#1e0e33", light: "#daaafd" },
  { name: "magenta", top: "#700159", bottom: "#2e0628", light: "#ffa4e9" },
  { name: "slate", top: "#334052", bottom: "#131822", light: "#b8c9de" },
];

/** the five assistant palettes (docs/design.md, agents: who a window belongs to): the same recipe as the ten, chosen for
    the gaps the ten leave on the wheel, so an assistant beside a repo of a near hue still reads as another thing. an
    agent's `palette` names one of them by its name; coral is the first assistant's */
export const ASSISTANT_COLOURS: readonly RepoColour[] = [
  { name: "coral", top: "#701e2e", bottom: "#2e0914", light: "#ffa9a7" },
  { name: "lime", top: "#1b4a03", bottom: "#022209", light: "#bbea7a" },
  { name: "jade", top: "#00493d", bottom: "#00211e", light: "#83e8c9" },
  { name: "lagoon", top: "#004757", bottom: "#001d2a", light: "#85ddf3" },
  { name: "orchid", top: "#621f6d", bottom: "#250a2d", light: "#eea7f4" },
];

/** every palette a surface can wear: the ten repo hues, then the five assistant slots (the plane and flood tests run over all fifteen) */
export const ALL_COLOURS: readonly RepoColour[] = [...REPO_COLOURS, ...ASSISTANT_COLOURS];

/** an agent's palette by its slot name; coral for a name this build does not know (a newer server's slot), so the window is never colourless */
export function assistantColour(slot: string | null | undefined): RepoColour {
  return ASSISTANT_COLOURS.find((c) => c.name === slot) ?? (ASSISTANT_COLOURS[0] as RepoColour); // the list is a non-empty literal
}

/** a repo is `host` plus the daemon's project root: repos never merge across hosts */
export type Repo = { host: string; root: string };

/** 32-bit fnv-1a: small, stable across builds and engines, and well spread for short strings */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** what a repo is known by in the colour map, and what the server hashes: `host:root` */
export function repoKey(repo: Repo): string {
  return `${repo.host}:${repo.root}`;
}

/** what the server says of one repo's colour: `auto` is the one boxbox gave it, `chosen` the person's, null for automatic.
    both are names, which may be ones a newer server knows and this build does not */
export type ColourAssignment = { auto: string; chosen: string | null };

/** every repo the server has spoken for, by `repoKey` */
export type ColourMap = Readonly<Record<string, ColourAssignment>>;

/** the colour a repo wears before the server has spoken for it: a stable hash of its key, the same one the server
    starts from when it gives a colour (server/src/fleet/colours.rs) */
export function hashColour(repo: Repo): RepoColour {
  return REPO_COLOURS[fnv1a(repoKey(repo)) % REPO_COLOURS.length] as RepoColour; // an index modulo the length
}

/** one of the ten by name; undefined for any other name, an assistant's palette included, since a repo never wears one */
export function repoColourNamed(name: string | null | undefined): RepoColour | undefined {
  return name == null ? undefined : REPO_COLOURS.find((c) => c.name === name);
}

/** a repo's colour and where it comes from, for the picker: `auto` is what automatic shows (the hash colour until the
    server gave one), `chosen` the person's choice, null for automatic. a name this build does not know reads as the hash
    colour, in either place, as the server reads its own rows (server/src/fleet/colours.rs) */
export function colourAssignment(repo: Repo, colours: ColourMap): { shown: RepoColour; auto: RepoColour; chosen: RepoColour | null } {
  const assigned = colours[repoKey(repo)];
  const auto = repoColourNamed(assigned?.auto) ?? hashColour(repo);
  const chosen = assigned?.chosen == null ? null : (repoColourNamed(assigned.chosen) ?? hashColour(repo));
  return { shown: chosen ?? auto, auto, chosen };
}

/** a repo's colour: the one its assignment shows (the chosen one, else the one boxbox gave), or its hash colour when the
    server has not spoken for it or names a colour this build does not know. the map is required, so a surface that
    forgets it does not quietly paint the hash where the server said otherwise */
export function colourOf(repo: Repo, colours: ColourMap): RepoColour {
  return colourAssignment(repo, colours).shown;
}

/** the last segment of the project root: "api" for /home/me/src/api */
export function repoName(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (at >= 0 ? trimmed.slice(at + 1) : trimmed) || root;
}

/** the custom properties a window, the stage and the capsule paint with */
export function colourStyle(colour: RepoColour): Record<string, string> {
  return { "--c1": colour.top, "--c2": colour.bottom, "--hi": colour.light };
}

/* —— contrast, for the test and for anyone choosing a new hue —— */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** the wcag contrast ratio of two `#rrggbb` colours */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
