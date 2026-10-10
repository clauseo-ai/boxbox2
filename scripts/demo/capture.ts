/* records the README's animated demo of the web app, from ladle stories only: the recorded journal
   played through the real reducer and the real home. no daemon, no model, no network beyond a local
   vite server, so nothing here costs anything.

     bun scripts/demo/capture.ts [--theme dark|light] [--out <dir>] [--split] [--fps 15] [--height 600]
                                 [--quality 60] [--budget-mb 4] [--port <n>] [--chrome <path>] [--keep]   (from the repo root)

   it serves ladle (app/.ladle) on a port of its own, opens each scene in a fresh browser context at a
   phone viewport (390x844) and a desktop viewport (1280x800) with playwright's video recording, trims
   each scene to its ready moment, joins the scenes, puts phone and desktop side by side at one height
   and writes an animated webp (`demo-<theme>.webp`; `--split` also writes `phone-<theme>.webp` and
   `desktop-<theme>.webp`). it prints every path and size and exits 1 when the files together pass
   the budget (4 MB by default): lower --fps, --height or --quality.

   needs ffmpeg and img2webp (brew install ffmpeg webp) and a chromium: --chrome, $CHROME_PATH, a
   chrome under ~/.agent-browser or ~/Library/Caches/ms-playwright, or /Applications/Google Chrome.app.
   playwright's video recorder needs its ffmpeg: under an empty HOME set PLAYWRIGHT_BROWSERS_PATH to the real
   browser cache (~/Library/Caches/ms-playwright on macOS).

   a motion pass on the product is happening on another branch, so the story list is the one constant
   below (SCENES). edit the ids and the steps there, nothing else needs to change. both viewports must
   add up to the same number of milliseconds, the script checks it. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

/* a step runs on the page once the story is ready, then the scene ends after `ms` from ready. the steps are
   timed by the scene's own clock (`at`, ms from ready), so a slow machine stretches nothing */
type Step = { at: number; run: (page: Page) => Promise<unknown> };
type Scene = { story: string; ms: number; steps?: Step[] };

/** eases the deck sideways over `ms`, to a window's offset and back; the deck snaps, so the snap is lifted for the run */
const deck = (to: number, ms: number) => (page: Page) =>
  page.evaluate(
    ([target, dur]) =>
      new Promise<void>((done) => {
        const el = document.querySelector<HTMLElement>(".wins");
        if (!el) return done();
        el.style.scrollSnapType = "none";
        const from = el.scrollLeft;
        const t0 = performance.now();
        const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        const tick = () => {
          const t = Math.min(1, (performance.now() - t0) / dur!);
          el.scrollLeft = from + (target! - from) * ease(t);
          if (t < 1) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      }),
    [to, ms] as const,
  );
const click = (selector: string, nth = 0) => (page: Page) => page.locator(selector).nth(nth).click({ timeout: 3000 });

/* home streaming across windows; a thread born into the fleet and a sweep of light; the window that wants you
   opened, with its question. phone: the deck, one window at a time. desktop: the rail beside the stage */
const SCENES: Record<"phone" | "desktop", Scene[]> = {
  phone: [
    {
      story: "home--home-as-recorded",
      ms: 4200,
      steps: [
        { at: 900, run: click(".wins .win") },
        { at: 3300, run: click("button.back") },
      ],
    },
    {
      story: "home--home-live-replay",
      ms: 7000,
      steps: [
        { at: 1300, run: deck(330, 1500) },
        { at: 3200, run: deck(660, 1500) },
        { at: 5000, run: deck(0, 1700) },
      ],
    },
  ],
  desktop: [
    {
      story: "home--home-as-recorded",
      ms: 4200,
      steps: [
        { at: 1600, run: click(".wins .win", 2) },
        { at: 2900, run: click(".wins .win", 0) },
      ],
    },
    {
      story: "home--home-live-moments",
      ms: 3200,
      steps: [
        { at: 500, run: (page) => page.evaluate(() => (window as unknown as { boxboxMoments: { birth: () => void } }).boxboxMoments.birth()) },
        { at: 1700, run: (page) => page.evaluate(() => (window as unknown as { boxboxMoments: { sweep: () => void } }).boxboxMoments.sweep()) },
      ],
    },
    { story: "home--home-live-replay", ms: 3800 },
  ],
};
const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
/** behind the gap between phone and desktop: the page's own ground in each theme */
const GROUND = { dark: "0x0b0b0f", light: "0xf4f4f6" } as const;

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const theme = (flag("theme", "dark") ?? "dark") as "dark" | "light";
if (theme !== "dark" && theme !== "light") throw new Error("--theme is dark or light");
const ROOT = resolve(new URL("../../", import.meta.url).pathname);
const OUT = resolve(flag("out", join(ROOT, "assets/demo"))!);
const PORT = Number(flag("port", "61091"));
const FPS = Number(flag("fps", "15"));
const HEIGHT = Number(flag("height", "600"));
const QUALITY = Number(flag("quality", "60"));
const BUDGET = Number(flag("budget-mb", "4")) * 1024 * 1024;
const split = args.includes("--split");
const keep = args.includes("--keep");

function sh(cmd: string, argv: string[]): void {
  const r = spawnSync(cmd, argv, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout).split("\n").slice(-6).join("\n")}`);
}
for (const tool of ["ffmpeg", "img2webp"]) if (spawnSync("which", [tool]).status !== 0) throw new Error(`${tool} is not installed (brew install ffmpeg webp)`);

const total = (list: Scene[]) => list.reduce((a, s) => a + s.ms, 0);
if (total(SCENES.phone) !== total(SCENES.desktop)) throw new Error(`phone scenes run ${total(SCENES.phone)} ms and desktop ${total(SCENES.desktop)} ms: make them equal`);

function findChrome(): string {
  const home = homedir();
  const fromTree = (dir: string, rel: string[]) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((d) => /chrom/i.test(d)).map((d) => join(dir, d, ...rel));
  };
  const candidates = [
    flag("chrome"),
    process.env.CHROME_PATH,
    ...fromTree(join(home, ".agent-browser/browsers"), ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]),
    ...fromTree(join(home, "Library/Caches/ms-playwright"), ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("no chromium found: pass --chrome <path> or set CHROME_PATH");
  return found;
}

/* ladle runs with a home of its own: swc refuses a cache root under a symlink (macOS /var), so the path is resolved */
const ladleHome = realpathSync(mkdtempSync(join(tmpdir(), "demo-ladle-")));
const work = realpathSync(mkdtempSync(join(tmpdir(), "demo-capture-")));
/* the installed binary, not bunx: bunx leaves ladle running as an orphan when its parent is killed */
const ladleBin = join(ROOT, "app/node_modules/.bin/ladle");
const server = spawn(existsSync(ladleBin) ? ladleBin : "bunx", [...(existsSync(ladleBin) ? [] : ["ladle"]), "serve", "--config", ".ladle", "--port", String(PORT)], {
  cwd: join(ROOT, "app"),
  env: { PATH: process.env.PATH ?? "", HOME: ladleHome },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stop = () => {
  server.kill();
  /* whatever still holds our own port is ours: it goes too (never by name) */
  const left = spawnSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const pid of left) spawnSync("kill", [pid]);
  if (!keep) rmSync(work, { recursive: true, force: true });
  rmSync(ladleHome, { recursive: true, force: true });
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

async function ready(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`ladle exited:\n${serverLog.split("\n").slice(-8).join("\n")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/meta.json`);
      if (r.ok) return ((await r.json()) as { stories: Record<string, unknown> }).stories;
    } catch {
      /* not yet */
    }
    await Bun.sleep(500);
  }
  throw new Error("ladle did not come up in 60 s");
}

const browser = await (async () => {
  const stories = await ready();
  for (const list of Object.values(SCENES)) for (const s of list) if (!(s.story in stories)) throw new Error(`no story ${s.story}: ids come from /meta.json, edit SCENES`);
  return chromium.launch({ executablePath: findChrome(), headless: true });
})();

/** records one scene: a fresh context, video on, the story opened, the steps run on the scene's clock; returns the video's trimmed clip */
async function record(side: "phone" | "desktop", index: number, scene: Scene): Promise<string> {
  const vp = VIEWPORTS[side];
  const dir = join(work, `${side}-${index}`);
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: theme, recordVideo: { dir, size: vp } });
  const page = await context.newPage();
  const born = Date.now();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?story=${scene.story}&mode=preview&theme=${theme}`);
  await page.waitForSelector("[data-ready]", { state: "attached" });
  /* fonts and first paint, then the scene's clock starts; the video before this point is cut away */
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const start = Date.now();
  const offset = (start - born) / 1000;
  for (const step of scene.steps ?? []) {
    const wait = start + step.at - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await step.run(page);
  }
  const rest = start + scene.ms - Date.now();
  if (rest > 0) await page.waitForTimeout(rest);
  if (errors.length) console.log(`  page error in ${scene.story}: ${errors[0]}`);
  const video = page.video();
  await context.close();
  const raw = await video!.path();
  const clip = join(work, `${side}-${index}.mkv`);
  /* a small margin on the start: the video's clock begins a little before the page's first navigation */
  sh("ffmpeg", ["-v", "error", "-y", "-ss", String(offset + 0.1), "-i", raw, "-t", String(scene.ms / 1000), "-an", "-vf", `fps=${FPS}`, "-c:v", "ffv1", clip]);
  return clip;
}

function join_(side: "phone" | "desktop", clips: string[]): string {
  const list = join(work, `${side}.txt`);
  writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n"));
  const out = join(work, `${side}.mkv`);
  sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  return out;
}

/** a clip scaled to the height, as png frames in a folder, then one animated webp from them */
function encode(inputs: string[], filter: string, name: string): string {
  const frames = join(work, `frames-${name}`);
  mkdirSync(frames, { recursive: true });
  sh("ffmpeg", ["-v", "error", "-y", ...inputs.flatMap((i) => ["-i", i]), "-filter_complex", filter, "-map", "[v]", join(frames, "%04d.png")]);
  const pngs = readdirSync(frames).sort().map((f) => join(frames, f));
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}-${theme}.webp`);
  sh("img2webp", ["-loop", "0", "-lossy", "-q", String(QUALITY), "-m", "4", "-d", String(Math.round(1000 / FPS)), ...pngs, "-o", file]);
  return file;
}

const written: string[] = [];
try {
  const joined: Record<string, string> = {};
  for (const side of ["phone", "desktop"] as const) {
    const clips: string[] = [];
    for (const [i, scene] of SCENES[side].entries()) {
      console.log(`${side} ${i + 1}/${SCENES[side].length}: ${scene.story}`);
      clips.push(await record(side, i, scene));
    }
    joined[side] = join_(side, clips);
  }
  const even = (n: number) => 2 * Math.round(n / 2);
  const dw = even((HEIGHT * VIEWPORTS.desktop.width) / VIEWPORTS.desktop.height);
  const pw = even((HEIGHT * VIEWPORTS.phone.width) / VIEWPORTS.phone.height);
  const gap = even(HEIGHT / 25);
  written.push(
    encode(
      [joined.phone!, joined.desktop!],
      `[0:v]scale=${pw}:${HEIGHT}:flags=lanczos[p];[1:v]scale=${dw}:${HEIGHT}:flags=lanczos[d];color=c=${GROUND[theme]}:s=${gap}x${HEIGHT}:r=${FPS}[g];[p][g][d]hstack=inputs=3:shortest=1[v]`,
      "demo",
    ),
  );
  if (split) {
    written.push(encode([joined.phone!], `[0:v]scale=${pw}:${HEIGHT}:flags=lanczos[v]`, "phone"));
    written.push(encode([joined.desktop!], `[0:v]scale=${dw}:${HEIGHT}:flags=lanczos[v]`, "desktop"));
  }
} finally {
  await browser.close();
}

let bytes = 0;
for (const f of written) {
  const size = statSync(f).size;
  bytes += size;
  console.log(`${f}  ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MB)`);
}
if (bytes > BUDGET) {
  console.error(`over budget: ${(bytes / 1024 / 1024).toFixed(2)} MB of ${(BUDGET / 1024 / 1024).toFixed(1)} MB. lower --fps (now ${FPS}), --height (now ${HEIGHT}) or --quality (now ${QUALITY}), or drop --split`);
  process.exit(1);
}/* explicit: the ladle child's pipes would keep the process alive, and `exit` runs the cleanup */
process.exit(0);
