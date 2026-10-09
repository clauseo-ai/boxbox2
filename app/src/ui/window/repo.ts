/* repo colours (docs/design.md, colour): ten deep hues, each a pair for
   the window's gradient and a light tone for chips, asks and accents. a
   repo gets one by a stable hash of its identity and keeps it forever;
   colour always means which repo, never a state. only failure is red, and
   red is not one of these.

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
  { name: "green", top: "#1b4a33", bottom: "#0c2419", light: "#8fe6a5" },
  { name: "violet", top: "#34298a", bottom: "#171240", light: "#b7abff" },
  { name: "rose", top: "#5a1f45", bottom: "#2a0d20", light: "#ff9fd0" },
  { name: "gold", top: "#4a3b12", bottom: "#211a07", light: "#f3d474" },
  { name: "blue", top: "#173a5e", bottom: "#0a1a2e", light: "#9cc8ff" },
  { name: "teal", top: "#10484a", bottom: "#062123", light: "#7fe0d6" },
  { name: "clay", top: "#5a2c19", bottom: "#29130a", light: "#ffb48c" },
  { name: "plum", top: "#46205c", bottom: "#1f0e2b", light: "#dfa8ff" },
  { name: "olive", top: "#3b4216", bottom: "#1a1d08", light: "#d4df7c" },
  { name: "slate", top: "#2b3441", bottom: "#12161c", light: "#b9c6d8" },
];

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

export function colourOf(repo: Repo): RepoColour {
  return REPO_COLOURS[fnv1a(`${repo.host}:${repo.root}`) % REPO_COLOURS.length] as RepoColour; // an index modulo the length
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
