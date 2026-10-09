/* home's budget run (docs/verification.md, the budget run; docs/home.md):
   the budgets of docs/design.md, "buttery, as numbers", measured in a real
   browser against a real cmx2 daemon with five threads streaming.

     just build && bun bench/home.ts [--launches 20] [--opens 50]

   it owns the windows world (bench/windows.ts: the pinned daemon on 4940,
   the bench model on 4941, the release binary on 3071, repos under /tmp)
   and agent-browser's chromium. at each width (390 deck, 820 strip, 1512
   rail) it:

     1. launches the app cold `--launches` times, each in a fresh tab with
        the previous one closed: perf.launch, the first frame that showed
        windows, and whether it came from the device cache;
     2. opens and closes windows `--opens` times: perf.paint (input to the
        first frame of the response) and perf.frames for every grow,
        shrink and pour;
     3. scrolls the windows while the five threads stream, for a quarter of
        the streaming time: perf.longtask;
     4. reads the cumulative layout shift of the whole session;
     5. takes a screenshot.

   then it flushes the page's telemetry, prints the raw perf.* rows the
   server wrote, the percentiles against each target, and stops
   everything, printing what still listens on its ports (nothing).

   what this cannot answer: the gate's numbers are judged on the real ipad
   and iphone as installed pwas over the tailnet (verification.md, device
   checks). this is chromium on the mac, over loopback. */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP, log, streaming, until, World, WORLD } from "./windows";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const LAUNCHES = flag("--launches", 20);
const OPENS = flag("--opens", 50);
const SHOTS = "/tmp/boxbox-m5-shots/budget";
const SESSION = `home-budget-${process.pid}`;
const WIDTHS: Array<[string, number, number]> = [
  ["deck", 390, 844],
  ["strip", 820, 1180],
  ["rail", 1512, 945],
];

function browser(...argv: string[]): string {
  const out = spawnSync("agent-browser", ["--session", SESSION, ...argv], { encoding: "utf8", timeout: 90_000 });
  if (out.status !== 0) throw new Error(`agent-browser ${argv[0]} failed: ${out.stderr.trim() || out.stdout.trim()}`);
  return out.stdout.trim();
}

/** the page answers `{"v": value}` as json; the cli may quote it once more (docs/gotchas.md, the sync worker) */
function evaluate<T>(expression: string): T {
  let raw = browser("eval", `(async () => JSON.stringify({ v: await (${expression}) }))()`);
  if (raw.startsWith('"')) raw = JSON.parse(raw) as string;
  return (JSON.parse(raw) as { v: T }).v;
}

type Sample = { kind: string; ms: number; props: Record<string, string | number> };
const samples = () => evaluate<Sample[]>("Promise.resolve(window.boxboxPerf ? window.boxboxPerf.perf().samples : [])");

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

type Row = { budget: string; arrangement: string; n: number; p50: number; p90: number; max: number; target: string; ok: boolean };
const rows: Row[] = [];
function summarise(budget: string, arrangement: string, values: number[], target: string, ok: (p50: number, p90: number, max: number) => boolean) {
  const p50 = percentile(values, 50);
  const p90 = percentile(values, 90);
  const max = values.length ? Math.max(...values) : Number.NaN;
  rows.push({ budget, arrangement, n: values.length, p50, p90, max, target, ok: values.length > 0 && ok(p50, p90, max) });
}

let launchSerial = 0;
/** a cold launch: a fresh tab with nothing before it, the previous one closed. navigating one tab again is
    not a launch: chromium keeps the old document, and its worker's stream, alive for seconds (docs/gotchas.md) */
async function launch(): Promise<Sample> {
  // tabs by label, so each command names the tab it means
  const previous = launchSerial > 0 ? [`launch-${launchSerial}`] : (browser("tab", "list").match(/\bt\d+\b/g) ?? []);
  const next = `launch-${++launchSerial}`;
  browser("tab", "new", "--label", next, `${APP}/`);
  // in front before anything else: a background tab runs no animation frames, so it never paints
  browser("tab", next);
  for (const tab of previous) browser("tab", "close", tab);
  let found: Sample | undefined;
  try {
    await until("perf.launch", () => {
      found = samples().find((s) => s.kind === "perf.launch");
      return found !== undefined;
    }, 30_000);
  } catch {
    // a launch that never painted windows is a miss at the timeout, with what the page was doing, not an abort
    const state = evaluate<string>(
      "Promise.resolve(document.readyState + ' response ' + Math.round(performance.getEntriesByType('navigation')[0]?.responseEnd ?? -1) + ' ms, wins ' + document.querySelectorAll('.wins .win').length + ', stream ' + (window.boxbox?.stream().state ?? 'none'))",
    );
    log(`a launch painted nothing in 30 s: ${state}`);
    return { kind: "perf.launch", ms: 30_000, props: { cached: 1, windows: 0 } };
  }
  const sample = found as Sample; // until() returned, so it was found
  if (sample.ms > 300) {
    // where a slow launch spent its time: the document, the script, the worker, the first api answer
    const breakdown = evaluate<string>(
      "Promise.resolve((() => { const n = performance.getEntriesByType('navigation')[0]; const r = performance.getEntriesByType('resource').filter((e) => /assets|api/.test(e.name)).map((e) => e.name.split('/').pop().split('?')[0].slice(0, 14) + ' ' + Math.round(e.startTime) + '-' + Math.round(e.responseEnd)); return 'document ' + Math.round(n.requestStart) + '-' + Math.round(n.responseEnd) + ', dom ready ' + Math.round(n.domContentLoadedEventEnd) + ', ' + r.join(', '); })())",
    );
    log(`slow launch ${sample.ms} ms: ${breakdown}`);
  }
  return sample;
}

async function measureWidth(label: string, width: number, height: number): Promise<{ shift: number }> {
  browser("set", "viewport", String(width), String(height));
  const launches: Sample[] = [];
  for (let i = 0; i < LAUNCHES; i++) launches.push(await launch());
  const cached = launches.filter((s) => s.props.cached === 1);
  log(`${label}: ${launches.length} launches, ${cached.length} painted from the device cache: ${launches.map((s) => `${s.ms}${s.props.cached ? "c" : ""}`).join(" ")}`);
  summarise("cold launch to cached paint", label, cached.map((s) => s.ms), "p50 300, p90 700", (p50, p90) => p50 <= 300 && p90 <= 700);

  // open and close windows the way a finger would: the window's title button, then back (deck) or the next window
  // in batches of ten, so no one eval outlives the cli's timeout
  let opened = 0;
  for (let batch = 0; batch < OPENS; batch += 10) {
    opened += evaluate<number>(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const buttons = () => [...document.querySelectorAll(".wins .win-open")];
      let n = 0;
      for (let i = ${batch}; i < ${Math.min(OPENS, batch + 10)}; i++) {
        const list = buttons();
        const target = list[i % list.length];
        if (!target) break;
        target.click();
        n++;
        await wait(650);
        const back = document.querySelector(".stage .back");
        if (back) { back.click(); await wait(650); }
      }
      return n;
    })()`);
  }
  // then ten opens with real input, through the browser's own pointer events, for input to paint
  const click = async (selector: string) => {
    await until(selector, () => evaluate<number>(`Promise.resolve(document.querySelectorAll(${JSON.stringify(selector)}).length)`) > 0, 5000).catch(() => {
      const state = evaluate<string>("Promise.resolve(location.href + ' wins=' + document.querySelectorAll('.wins .win').length + ' open=' + !!document.querySelector('.stage[data-open]'))");
      throw new Error(`${selector} is not on the page: ${state}`);
    });
    // the deck is a snap pager: a window off to the side is brought to the middle first, and the snap left to settle,
    // so the pointer lands where a finger would
    evaluate<number>(`Promise.resolve((document.querySelector(${JSON.stringify(selector)}).closest(".win") ?? document.body).scrollIntoView({ inline: "center", block: "nearest", behavior: "instant" }) ?? 1)`);
    await Bun.sleep(300);
    browser("click", selector);
    await Bun.sleep(650);
  };
  for (let i = 0; i < 10; i++) {
    await click(`.wins > .win:nth-child(${(i % 5) + 1}) .win-open`);
    if (label === "deck") await click(".stage .back");
  }
  const after = samples();
  const inputs = after.filter((s) => s.kind === "perf.input");
  log(`${label}: ${inputs.length} perf.input rows from the browser's event timing: ${inputs.map((s) => `${s.props.type} ${s.ms}`).join(", ")}`);
  summarise("input to paint (event timing)", label, inputs.map((s) => s.ms), "next paint (p90 <= 33 ms; 8 ms grain)", (_p50, p90) => p90 <= 33.4);
  const paints = after.filter((s) => s.kind === "perf.paint");
  const frames = after.filter((s) => s.kind === "perf.frames");
  log(`${label}: ${opened} opens; ${paints.length} perf.paint, ${frames.length} perf.frames`);
  summarise("tap to first frame rendered (ms)", label, paints.map((s) => s.ms), "1 frame (p90 <= 33 ms: the input lands mid-frame)", (_p50, p90) => p90 <= 33.4);
  summarise("tap to first frame (frames)", label, paints.map((s) => Number(s.props.frames)), "1", (_p50, _p90, max) => max <= 1);
  summarise("transition dropped frames", label, frames.map((s) => Number(s.props.dropped)), "0", (_p50, _p90, max) => max === 0);

  // scroll the windows while the fleet streams, for long tasks
  evaluate<number>(`(async () => {
    const wins = document.querySelector(".wins");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) { wins.scrollBy({ left: ${label === "rail" ? 0 : 280}, top: ${label === "rail" ? 180 : 0} }); await wait(250); if (i % 10 === 9) wins.scrollTo({ left: 0, top: 0 }); }
    return 1;
  })()`);
  const longtasks = samples().filter((s) => s.kind === "perf.longtask");
  summarise("long tasks over 50 ms", label, longtasks.map((s) => s.ms), "none", () => longtasks.length === 0);
  if (longtasks.length === 0) rows[rows.length - 1] = { ...(rows[rows.length - 1] as Row), n: 0, p50: 0, p90: 0, max: 0, ok: true };
  const shift = evaluate<number>("Promise.resolve(window.boxboxPerf.perf().shift)");
  summarise("layout shift (cumulative)", label, [shift], "0", (_p50, _p90, max) => max === 0);
  browser("screenshot", join(SHOTS, `${label}-${width}.png`));
  evaluate<number>("window.boxboxPerf.flush().then(() => 1)");
  return { shift };
}

const world = new World();
let code = 0;
try {
  spawnSync("mkdir", ["-p", SHOTS]);
  await world.start();
  await world.run(streaming(240, 60));
  log("five threads streaming, 60 ms a word, for 4 minutes");
  browser("open", `${APP}/`);
  const status = evaluate<number>(
    `fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(world.gate)} }) }).then((r) => r.status)`,
  );
  log(`signed in: ${status}`);
  for (const [label, width, height] of WIDTHS) await measureWidth(label, width, height);
  const build = browser("eval", "document.querySelector('script[type=module][src]')?.getAttribute('src') ?? 'unknown'");
  log(`build: ${build.replace(/"/g, "")}`);

  // the raw rows the server wrote
  await Bun.sleep(1500);
  const dir = join(WORLD, "boxbox", "boxbox-data", "telemetry");
  const perfRows = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter((line) => line.includes('"perf.'));
  console.log(`\nraw perf.* rows the server wrote (${perfRows.length}); first of each kind and arrangement:`);
  const firsts = new Map<string, string>();
  for (const line of perfRows) {
    const row = JSON.parse(line) as { kind: string; props?: { arrangement?: string; transition?: string } };
    const id = `${row.kind} ${row.props?.arrangement ?? row.props?.transition ?? ""}`;
    if (!firsts.has(id)) firsts.set(id, line);
  }
  for (const line of firsts.values()) console.log(line);

  console.log("\nbudget                          layout   n     p50     p90     max  target                          result");
  for (const r of rows) {
    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "-").padStart(7);
    console.log(`${r.budget.padEnd(31)} ${r.arrangement.padEnd(6)} ${String(r.n).padStart(3)} ${f(r.p50)} ${f(r.p90)} ${f(r.max)}  ${r.target.padEnd(31)} ${r.ok ? "met" : "MISSED"}`);
  }
  if (rows.some((r) => !r.ok)) code = 1;
} catch (error) {
  console.error(`home budget: ${error instanceof Error ? error.message : String(error)}`);
  code = 1;
} finally {
  spawnSync("agent-browser", ["--session", SESSION, "close"]);
  await world.stop();
}
process.exit(code);
