/* the screenshot test for home's stories (docs/home.md, verification):
   serves ladle, opens every home story at phone, ipad and mac widths, saves a
   screenshot of each for a person to look at, and fails a story that
   logged a console error, never became ready, scrolls the page sideways,
   has a control without a name or with a name another control on the
   page shares (AGENTS.md rule 5: a control the drive cannot name is a
   bug), whose bar line runs out of its box or comes within 6 px of a
   pill, or that the craft check faults (craft.js: text crowding a
   surface's edge, surfaces touching, surfaces at the screen's edge). a
   state story's three sizes are three figures, checked apart. at each
   width it then plays the moments story's birth and fails unless the born
   window runs an animation of transform and opacity whose clock and
   computed values change frame by frame.

   bun .ladle/home-shots.ts [--only <substring>] [--out <dir>] [--port <n>] [--theme light|dark] [--sizes all]   (from app/) */

import { $ } from "bun";

/* `--sizes all` adds the other three of the six the design is judged at: a landscape ipad, a large monitor and a vertical one */
const WIDTHS: Array<[string, number, number]> = [
  ["phone", 390, 844],
  ["ipad", 820, 1180],
  ["mac", 1512, 945],
  ...(process.argv.includes("--sizes") && process.argv[process.argv.indexOf("--sizes") + 1] === "all"
    ? ([["ipad-landscape", 1180, 820], ["monitor", 2560, 1440], ["vertical", 1440, 2560]] as Array<[string, number, number]>)
    : []),
];
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const OUT = args.includes("--out") ? (args[args.indexOf("--out") + 1] ?? "") : "/tmp/boxbox-shots";
/** a port of the run's own, so two worktrees can shoot at once */
const PORT = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 61071;
/* `--theme light` (or dark) shoots every story in that appearance. ladle's own theme decides a story's (its default is
   dark, set on the root as data-theme), so it is asked for in the url, and the browser's colour scheme follows for a
   story whose app clears the root's theme (the shell's, on "system"). without it every story is ladle's dark */
const theme = args.includes("--theme") ? args[args.indexOf("--theme") + 1] : undefined;
const themed = theme ? `&theme=${theme}` : "";
const suffix = theme ? `-${theme}` : "";
const CRAFT = await Bun.file(new URL("./craft.js", import.meta.url)).text();
/* a tab can stop producing frames, and a screenshot then waits forever (docs/gotchas.md): one frame is asked for first */
const FRAME = "new Promise((r) => { const t = setTimeout(() => r(false), 1500); requestAnimationFrame(() => { clearTimeout(t); r(true); }); })";
type Craft = { crowding: number; touching: number; atEdge: number; crowdBy: unknown[]; touchBy: unknown[]; edgeBy: unknown[] };

/* the birth, measured (the moments story; docs/design.md, starting a thread). a headless tab advances animations
   only while something asks for frames (docs/gotchas.md), so the check runs its own frame pump; home spends motion a
   second after the stream is live, so it waits that out; then the held-back thread arrives and every frame for
   900 ms records the born window's animation clock and its computed opacity and transform */
const BIRTH = `(async () => {
  let pumping = true;
  let frames = 0;
  (function pump() { if (pumping) { frames++; requestAnimationFrame(pump); } })();
  await new Promise((r) => setTimeout(r, 1200));
  const fps = Math.round(frames / 1.2);
  const debug = { hidden: document.visibilityState, wins: document.querySelectorAll(".wins .win").length, scrollLeft: document.querySelector(".wins")?.scrollLeft };
  const held = new Set([...document.querySelectorAll(".wins .win")].map((w) => w.dataset.key));
  window.boxboxMoments.birth();
  const samples = [];
  let born = null, properties = [];
  for (const until = performance.now() + 900; performance.now() < until; ) {
    await new Promise((r) => requestAnimationFrame(r));
    born ??= [...document.querySelectorAll(".wins .win")].find((w) => !held.has(w.dataset.key)) ?? null;
    if (!born) continue;
    const animation = born.getAnimations()[0];
    if (animation && properties.length === 0) properties = [...new Set(animation.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p))))];
    const style = getComputedStyle(born);
    samples.push({ state: animation?.playState ?? "none", time: animation ? animation.currentTime : null, opacity: style.opacity, transform: style.transform });
  }
  pumping = false;
  return { born: born !== null, properties, samples, fps, debug };
})()`;
type Birth = { born: boolean; properties: string[]; samples: Array<{ state: string; time: number | null; opacity: string; transform: string }>; fps: number; debug: unknown };

/** what the birth's frames prove, or the first thing they do not */
function judgeBirth(birth: Birth): { ok: boolean; line: string } {
  if (!birth.born) return { ok: false, line: "the held-back thread never arrived" };
  const running = birth.samples.filter((s) => s.state === "running");
  const times = running.map((s) => s.time ?? 0);
  const rising = times.every((t, i) => i === 0 || t > (times[i - 1] ?? 0));
  const opacities = new Set(running.map((s) => s.opacity)).size;
  const transforms = new Set(running.map((s) => s.transform)).size;
  const lawful = birth.properties.length > 0 && birth.properties.every((p) => p === "transform" || p === "opacity");
  const first = running[0];
  const last = birth.samples.at(-1);
  const landed = last?.opacity === "1";
  const line =
    `${running.length} running frames, currentTime ${Math.round(times[0] ?? 0)} to ${Math.round(times.at(-1) ?? 0)} ms ${rising ? "rising" : `NOT rising (${times.map(Math.round).join(" ")})`}, ` +
    `${opacities} opacities and ${transforms} transforms (${first?.opacity} ${first?.transform} to ${last?.opacity} ${last?.transform}), animates ${birth.properties.join(" and ") || "nothing"}`;
  const ok = running.length >= 5 && rising && opacities >= 5 && transforms >= 5 && lawful && landed;
  return { ok, line: ok ? line : `${line}; the tab ran ${birth.fps} fps before it, ${JSON.stringify(birth.debug)}` };
}

const session = `shots-${process.pid}`;
const env = { ...process.env, ...(theme ? { AGENT_BROWSER_COLOR_SCHEME: theme } : {}) };
const ab = (...a: string[]) => $`agent-browser --session ${session} ${a}`.env(env).quiet();
/** the page answers `{"v": value}` as json, so a string answer is never confused with the cli's own quoting; a promise
    is awaited first */
async function evaluate<T>(expression: string): Promise<T> {
  let raw = (await ab("eval", `Promise.resolve(${expression}).then((v) => JSON.stringify({ v }))`).text()).trim();
  if (raw.startsWith('"')) raw = JSON.parse(raw) as string;
  return (JSON.parse(raw) as { v: T }).v;
}

/** every control's accessible name as the page computes it, the empty and the repeated ones */
const AUDIT = `(() => {
  // what is aria-hidden is out of the accessibility tree a drive reads (the composer's file picker, opened by its photo control), as in shell-shots.ts
  const controls = [...document.querySelectorAll("button, [role=button], a[href], input, textarea")].filter((el) => el.getClientRects().length > 0 && !el.closest("[inert], [aria-hidden=true]"));
  const name = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim();
  // a state story shows one window at three sizes, each in its own figure; names are unique within a figure, and
  // across the page everywhere else
  const scoped = controls.map((el) => { const frame = el.closest("figure"); return (frame ? [...frame.parentElement.children].indexOf(frame) + ":" : "") + name(el); });
  const unnamed = controls.map(name).filter((n) => !n).length;
  const repeated = [...new Set(scoped.filter((n, i) => !n.endsWith(":") && scoped.indexOf(n) !== i))];
  return { controls: controls.length, unnamed, repeated, sideways: document.documentElement.scrollWidth > innerWidth + 1 && getComputedStyle(document.documentElement).overflowX !== "hidden" };
})()`;

/* the bar's line never runs under or up to its pills (docs/home.md, the bar's line): every line box of its text is
   measured against every pill it shares a row with, and the line may not overflow its own box */
const BAR = `(() => {
  const sum = document.querySelector(".home .bar .sum");
  if (!sum) return "";
  const pills = [...document.querySelectorAll(".home .bar .pill")].map((p) => p.getBoundingClientRect());
  // a group of pills is one row: a pill that wraps by chance, alone on a row of its own, is the bar failing
  for (const group of document.querySelectorAll(".home .bar .pills")) {
    const tops = [...group.querySelectorAll(".pill")].map((p) => Math.round(p.getBoundingClientRect().top));
    if (new Set(tops).size > 1) return "the pills of " + group.className.replace("pills ", "") + " wrap onto " + new Set(tops).size + " rows";
  }
  const offscreen = pills.find((p) => p.right > innerWidth || p.left < 0);
  if (offscreen) return "a pill runs off the screen (" + Math.round(offscreen.right) + " px right of a " + innerWidth + " px window)";
  const range = document.createRange();
  range.selectNodeContents(sum);
  const lines = [...range.getClientRects()].filter((r) => r.width > 0);
  const box = sum.getBoundingClientRect();
  if (sum.scrollWidth > sum.clientWidth + 1) return "its text is " + sum.scrollWidth + " px wide in a " + sum.clientWidth + " px box";
  for (const line of lines) {
    if (line.right > box.right + 1 || line.left < box.left - 1) return "a line runs " + Math.round(Math.max(line.right - box.right, box.left - line.left)) + " px out of its box";
    for (const pill of pills) {
      const sameRow = line.bottom > pill.top && line.top < pill.bottom;
      const gap = Math.max(pill.left - line.right, line.left - pill.right);
      if (sameRow && gap < 6) return "a line comes " + Math.round(gap) + " px from a pill";
    }
  }
  return "";
})()`;

/* home is never inert under nothing: on the deck the windows and the field are inert only while a thread's layer is on
   the stage, or a sheet is up over them (the answer sheet, the working fold's list or the away sheet). a thread opened from
   a url the fleet does not hold once left every tap dead */
const INERT = `(() => {
  const home = document.querySelector(".home[data-arrangement=deck]");
  if (!home) return "";
  const covered = document.querySelector(".stage .layer, .asks-sheet, .hsheet") !== null;
  const inert = [...home.querySelectorAll(".bar, .wins, .nx-deck")].some((el) => el.inert);
  return inert && !covered ? "the deck is inert and no thread is on the stage" : "";
})()`;

/* the thread on the stage leaves the fleet while it is first in the order: home must settle, on home's field at the strip
   and the rail (the stage is home when no thread is chosen), with few writes of the url, no long task and no layer left,
   not chase its own effects (home--home-first-leaves reports on
   window.__gone, after the strip's and the rail's stage has a thread to lose) */
const GONE = `JSON.stringify(window.__gone ?? null)`;
type Gone = { error?: string; left?: string; landedOn?: string | null; layers?: number; writes?: number; longest?: number; held?: boolean; under?: boolean; deck?: boolean };
function judgeGone(g: Gone | null, arrangement: string): string {
  if (!g) return "home never reported";
  if (g.error) return g.error;
  const problems: string[] = [];
  if (g.under) problems.push("the deck was inert with no layer on the stage while the stream caught up");
  // the deck lets go to its windows; strip and rail let go to home (no thread chosen, no layer)
  if (g.deck) return problems.join(", ");
  if (g.landedOn !== null) problems.push(`the stage opened ${g.landedOn} by itself instead of showing home`);
  if ((g.layers ?? 0) !== 0) problems.push(`${g.layers} layers on the stage`);
  if ((g.writes ?? 99) > 3) problems.push(`${g.writes} writes of the url`);
  if ((g.longest ?? 0) > 200) problems.push(`a ${Math.round(g.longest ?? 0)} ms task`);
  return problems.join(", ");
}

await $`mkdir -p ${OUT}`;
const server = Bun.spawn(["bunx", "ladle", "serve", "--config", ".ladle", "--port", String(PORT)], { stdout: "ignore", stderr: "ignore" });
async function ready(): Promise<{ stories: Record<string, unknown> }> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/meta.json`);
      if (res.ok) return (await res.json()) as { stories: Record<string, unknown> };
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  throw new Error("ladle did not come up in 60 s");
}

let failures = 0;
let shots = 0;
try {
  const meta = await ready();
  // the live stories (the replay, the moments) move on cue and never hold one frame; everything else is still
  const ids = Object.keys(meta.stories).filter((id) => id.startsWith("home--") && (!only || id.includes(only)) && !id.includes("--home-live-"));
  /* a tab that has loaded some tens of stories can stop producing frames (docs/gotchas.md): each size starts in a
     fresh browser, and a story whose tab gives no frame is shot once more in another fresh one */
  const fresh = async (width: number, height: number) => {
    await ab("close").nothrow();
    // with a colour scheme in the environment the cli's first command after a close fails once ("could not configure
    // browser") and launches the browser for the next, so a blank page is opened first and its failure is let go
    await ab("open", "about:blank").nothrow();
    await ab("set", "viewport", String(width), String(height));
  };
  // the first viewport of a freshly launched browser can be lost (bench/shell.ts): the page is asked, and set again if so
  const load = async (id: string, width: number, height: number) => {
    await ab("open", `http://127.0.0.1:${PORT}/?story=${id}&mode=preview${themed}`);
    if ((await evaluate<number>("innerWidth")) !== width) {
      await ab("set", "viewport", String(width), String(height));
      await ab("open", `http://127.0.0.1:${PORT}/?story=${id}&mode=preview${themed}`);
    }
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = await evaluate<boolean>("!!document.querySelector('[data-ready]')");
      if (!ready) await Bun.sleep(250);
    }
    await Bun.sleep(500);
    return { up: ready, framing: await evaluate<boolean>(FRAME) };
  };
  for (const [label, width, height] of WIDTHS) {
    await fresh(width, height);
    for (const id of ids) {
      let { up, framing } = await load(id, width, height);
      if (!framing) {
        console.log(`     ${label.padEnd(5)} ${id}: the tab gave no frame; shooting it again in a fresh browser`);
        await fresh(width, height);
        ({ up, framing } = await load(id, width, height));
      }
      const file = `${OUT}/${id}-${label}${suffix}.png`;
      if (framing) await ab("screenshot", file);
      shots++;
      const audit = await evaluate<{ controls: number; unnamed: number; repeated: string[]; sideways: boolean }>(AUDIT);
      const bar = await evaluate<string>(BAR);
      const inert = await evaluate<string>(INERT);
      let gone = "";
      if (id.includes("first-leaves")) {
        for (let i = 0; i < 40 && (await evaluate<string>(GONE)) === "null"; i++) await Bun.sleep(250);
        gone = judgeGone(JSON.parse(await evaluate<string>(GONE)) as Gone | null, label);
      }
      // craft.js answers a json string of its findings
      const craft = JSON.parse(await evaluate<string>(CRAFT)) as Craft;
      const faults = [...craft.crowdBy, ...craft.touchBy, ...craft.edgeBy];
      const errors = (await ab("console").text())
        .split("\n")
        .filter((line) => /error/i.test(line) && !/favicon|\[vite\]/i.test(line));
      const problems = [
        up ? "" : "never ready",
        framing ? "" : "the tab gave no frame",
        faults.length ? `craft: crowding ${craft.crowding} touching ${craft.touching} edge ${craft.atEdge} ${JSON.stringify(faults).slice(0, 400)}` : "",
        audit.unnamed ? `${audit.unnamed} unnamed controls` : "",
        audit.repeated.length ? `repeated names: ${audit.repeated.join(" | ")}` : "",
        audit.sideways ? "the page scrolls sideways" : "",
        bar ? `the bar's line: ${bar}` : "",
        inert,
        gone ? `first window leaves: ${gone}` : "",
        errors[0] ? `console: ${errors[0].slice(0, 140)}` : "",
      ].filter(Boolean);
      if (problems.length) failures++;
      console.log(`${problems.length ? "FAIL" : "ok  "} ${label.padEnd(5)} ${id.padEnd(28)} ${String(audit.controls).padStart(2)} controls  ${problems.join("; ")}`);
      await ab("console", "--clear").nothrow();
    }
    if (!only || "home--home-live-moments".includes(only)) {
      await ab("open", `http://127.0.0.1:${PORT}/?story=home--home-live-moments&mode=preview${themed}`);
      if ((await evaluate<number>("innerWidth")) !== width) {
        await ab("set", "viewport", String(width), String(height));
        await ab("open", `http://127.0.0.1:${PORT}/?story=home--home-live-moments&mode=preview${themed}`);
      }
      for (let i = 0; i < 40 && !(await evaluate<boolean>("!!window.boxboxMoments")); i++) await Bun.sleep(250);
      const { ok, line } = judgeBirth(await evaluate<Birth>(BIRTH));
      if (!ok) failures++;
      console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(5)} ${"the birth".padEnd(28)} ${line}`);
    }
  }
} finally {
  await ab("close").nothrow();
  server.kill();
}
console.log(`\n${shots} screenshots in ${OUT}; ${failures} failed`);
process.exit(failures ? 1 : 0);
