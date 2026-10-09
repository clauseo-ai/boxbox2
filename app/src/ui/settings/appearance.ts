/* this device's theme and motion, applied to the root element as
   `data-theme` and `data-motion` (styles.css reads them over the system
   settings). the server holds the preference; a copy of this device's own
   rides in localStorage only so the first frame of a cold launch paints in
   the right appearance before the server has answered, the way the
   worker's cache paints the fleet. */

import { setMotionChoice } from "../../motion/animate";
import type { DevicePrefs } from "../../store";
import type { Chrome } from "./chrome";

const BOOT = "boxbox.appearance";
export const DEFAULT_APPEARANCE: DevicePrefs = { theme: "system", motion: "system" };
/** the grounds from design.md, for the browser chrome */
const GROUND = { dark: "#0b0c0f", light: "#f3f3f1" } as const;

/* the theme this device chose, and the chrome held over the ground: the newest hold wins (an agent's stage over its
   parent's), and the ground returns when the last lets go */
let theme: DevicePrefs["theme"] = DEFAULT_APPEARANCE.theme;
const holds: Chrome[] = [];

function paintChrome(): void {
  // index.html ships one theme-color per system appearance; a chosen theme paints both
  const over = holds[holds.length - 1] ?? GROUND;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const system = meta.media.includes("light") ? "light" : "dark";
    meta.content = over[theme === "system" ? system : theme];
  });
}

/** paint the browser chrome in a colour until the returned release is called (the deck's stage, in its flood: chrome.ts) */
export function holdChrome(chrome: Chrome): () => void {
  const hold = { ...chrome };
  holds.push(hold);
  paintChrome();
  return () => {
    const at = holds.indexOf(hold);
    if (at >= 0) holds.splice(at, 1);
    paintChrome();
  };
}

export function applyAppearance(prefs: DevicePrefs, remember = true): void {
  const root = document.documentElement;
  if (prefs.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  if (prefs.motion === "system") delete root.dataset.motion;
  else root.dataset.motion = prefs.motion;
  // the springs in js read the same choice the css reads from the root
  setMotionChoice(prefs.motion);
  theme = prefs.theme;
  paintChrome();
  if (!remember) return;
  try {
    localStorage.setItem(BOOT, JSON.stringify(prefs));
  } catch {
    /* storage is blocked: the next cold launch paints the system appearance until the server answers */
  }
}

/** before the first render: the appearance this device last chose */
export function bootAppearance(): void {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(BOOT) ?? "null");
    if (isAppearance(saved)) applyAppearance(saved, false);
  } catch {
    /* nothing saved, or storage is blocked */
  }
}

function isAppearance(value: unknown): value is DevicePrefs {
  if (typeof value !== "object" || value === null) return false;
  const { theme, motion } = value as Record<string, unknown>;
  return ["system", "dark", "light"].includes(theme as string) && ["system", "reduced", "full"].includes(motion as string);
}
