/* the terminal's screen: xterm.js, loaded only when a terminal opens (it
   is 88 kb compressed, most of the app's whole first-load budget).

   the dom renderer, everywhere: the text is in the page, so it selects
   natively on touch, the accessibility tree and the drive can read it,
   and there is no webgl context for safari to take away. xterm measures
   glyph widths and pads each cell, so a character the mono face lacks
   (box drawing, powerline) still sits on the grid. */

import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/** the lines a screen keeps above what it shows; the emulator's own byte cap, about 6 mb at 100 columns */
const SCROLLBACK = 5000;
const FONT = '"Martian Mono", ui-monospace, "SF Mono", Menlo, monospace';

/* the dark bed in both appearances (docs/design.md, the terminal): programs pick their colours assuming a dark
   background. the sixteen colours are the design's own tones: the repo light tones for the hues, the text greys,
   and red, which a program uses for failure too. */
const THEME: ITheme = {
  background: "#08090b",
  foreground: "#e9e9ec",
  cursor: "#b7abff",
  cursorAccent: "#08090b",
  selectionBackground: "rgba(183, 171, 255, 0.32)",
  black: "#1c1d22",
  red: "#ff6b6b",
  green: "#8fe6a5",
  yellow: "#f3d474",
  blue: "#8fb4ff",
  magenta: "#ff9fd0",
  cyan: "#86dcd4",
  white: "#c9cad0",
  brightBlack: "#6b6d76",
  brightRed: "#ffa3a3",
  brightGreen: "#b8f2c6",
  brightYellow: "#f8e3a3",
  brightBlue: "#b9d0ff",
  brightMagenta: "#ffc4e2",
  brightCyan: "#b3ebe5",
  brightWhite: "#f4f4f6",
};

export type Screen = {
  /** paints output; `done` runs once the emulator has parsed it */
  write(text: string, done?: () => void): void;
  /** clears the screen and the scrollback */
  reset(): void;
  /** a dim line in the pane's voice, never sent to the shell */
  note(text: string): void;
  /** sizes the grid to its element; the new size, or null when unchanged or not measurable */
  fit(): { cols: number; rows: number } | null;
  size(): { cols: number; rows: number };
  focus(): void;
  /** stops input reaching `onInput` (the shell ended) */
  seal(): void;
  /** whether the program on screen asked for application cursor keys (vim, less) */
  applicationCursor(): boolean;
  /** everything typed or pasted into the screen */
  onInput(listener: (data: string) => void): void;
  dispose(): void;
};

/** the font size per layout width (docs/design.md, the terminal) */
export function fontSizeFor(width: number): number {
  return width < 700 ? 11 : width < 1000 ? 12.5 : 13;
}

export async function openScreen(host: HTMLElement, label: string): Promise<Screen> {
  const fontSize = fontSizeFor(window.innerWidth);
  // measured before the first paint, or the grid is sized to a fallback face and redrawn when the real one lands
  await document.fonts.load(`${fontSize}px "Martian Mono"`).catch(() => undefined);
  // this device's choice in settings wins over the system's (data-motion on the root)
  const chosen = document.documentElement.dataset.motion;
  const reduced = chosen === "reduced" || (chosen !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const term = new Terminal({
    fontFamily: FONT,
    fontSize,
    lineHeight: 1.2,
    theme: THEME,
    cursorBlink: !reduced,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    scrollback: SCROLLBACK,
    macOptionIsMeta: true,
    allowProposedApi: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 4.5,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // xterm names its input "Terminal input" for every terminal; the automation contract wants one name per control
  const input = host.querySelector("textarea");
  input?.setAttribute("aria-label", `type into ${label}`);
  input?.setAttribute("enterkeyhint", "enter");
  let sealed = false;
  let listener: ((data: string) => void) | null = null;
  term.onData((data) => {
    if (!sealed) listener?.(data);
  });
  let last = { cols: term.cols, rows: term.rows };
  return {
    write: (text, done) => term.write(text, done),
    reset: () => term.reset(),
    note: (text) => term.write(`\r\n\x1b[2m· ${text} ·\x1b[0m\r\n`),
    fit() {
      const proposed = fit.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
      const cols = Math.max(2, proposed.cols);
      const rows = Math.max(1, proposed.rows);
      if (cols === last.cols && rows === last.rows) return null;
      term.resize(cols, rows);
      last = { cols, rows };
      return last;
    },
    size: () => ({ cols: term.cols, rows: term.rows }),
    focus: () => term.focus(),
    seal() {
      sealed = true;
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
    },
    applicationCursor: () => term.modes.applicationCursorKeysMode,
    onInput(next) {
      listener = next;
    },
    dispose: () => term.dispose(),
  };
}
