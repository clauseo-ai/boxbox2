/* the pour, frame by frame (docs/design.md, buttery, as numbers; docs/thread.md, budgets): a check that work moved out of a
   transition's frames left the transition itself as it was. it serves ladle, opens home with every window holding a long
   imported thread (home--home-heavy-threads) at the mac's width, and pours each window onto the stage in turn, each from a
   fresh page. for each pour it holds every animation still in the task that started them and steps them through their clock,
   16 ms at a time to 600 ms. at each step it records the keyframes and timing of every animation the pour started on a layer,
   the poured layer's computed clip-path, transform and opacity, and what its view shows: how far the view is from the end
   and, for each turn with a box in the view, whether its rows are there, where its box sits and its words (clocks read as
   0:00, since they run with the wall clock). the layer it pours over is left out: home lets it go on a timer, which runs on
   the wall clock while the check holds the animations. then it lets the pour land, waits for what was left for after it,
   and records the same of the landed view. `--out` writes what it saw; `--against` a file an earlier run wrote (say, from
   main) fails on any difference, so a change that should cost the pour less but draw it the same is shown to draw it the
   same. last it pours every window a few rounds, free, and says the frames each pour dropped (perf.frames, as the field
   measures it).

   bun .ladle/pour-frames.ts [--out <file>] [--against <file>] [--port <n>] [--rounds <n>]   (from app/) */

import { $ } from "bun";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const PORT = Number(opt("--port") ?? 61073);
const OUT = opt("--out");
const AGAINST = opt("--against");
const ROUNDS = Number(opt("--rounds") ?? 3);
const STORY = "home--home-heavy-threads";
const session = `pour-${process.pid}`;
const ab = (...a: string[]) => $`agent-browser --session ${session} ${a}`.quiet();
async function evaluate<T>(expression: string): Promise<T> {
  let raw = (await ab("eval", `Promise.resolve(${expression}).then((v) => JSON.stringify({ v }))`).text()).trim();
  if (raw.startsWith('"')) raw = JSON.parse(raw) as string;
  return (JSON.parse(raw) as { v: T }).v;
}
const FRAMES = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))";

/* what the poured layer's view shows: how far it is from the end, and each turn with a box in it */
const VIEW = `((layer) => {
  const s = layer.querySelector(".stage-scroll") ?? layer;
  const box = s.getBoundingClientRect();
  const turns = [...layer.querySelectorAll("section.turn[data-turn]")].flatMap((t) => {
    const r = t.getBoundingClientRect();
    if (r.bottom <= box.top || r.top >= box.bottom) return [];
    return [[t.dataset.turn, t.hasAttribute("data-waiting") ? "waiting" : t.childElementCount > 0 ? "rows" : "empty", Math.round(r.top - box.top), Math.round(r.height), t.innerText.replace(/\\d+:\\d\\d(:\\d\\d)?/g, "0:00")].join(" | ")];
  });
  return { fromEnd: Math.round(s.scrollHeight - s.clientHeight - s.scrollTop), turns };
})`;
/* pours the window at `index`, holds every animation at its first frame in the task that started them, and steps them */
const POUR = (index: number) => `(async () => {
  const key = document.querySelectorAll(".win")[${index}].dataset.key;
  document.querySelectorAll(".win .win-open")[${index}].click();
  const held = document.getAnimations();
  for (const a of held) a.pause();
  window.__held = held;
  const layer = [...document.querySelectorAll(".layer")].at(-1);
  const shape = (a) => { const e = a.effect; return { on: e.target === layer ? "poured" : e.target.className.split(" ")[0], keyframes: e.getKeyframes().map((k) => JSON.stringify(k)), timing: JSON.stringify(e.getTiming()) }; };
  const animations = held.filter((a) => a.effect?.target?.closest?.(".layer")).map(shape);
  const steps = [];
  for (let t = 0; t <= 600; t += 16) {
    for (const a of held) a.currentTime = t;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = getComputedStyle(layer);
    steps.push({ t, clip: c.clipPath, transform: c.transform, opacity: c.opacity, view: (${VIEW})(layer) });
  }
  return { key, poured: layer.dataset.key, animations, steps };
})()`;
const LAND = `(async () => {
  for (const a of window.__held) a.play();
  await new Promise((r) => setTimeout(r, 2500));
  await ${FRAMES};
  const layer = [...document.querySelectorAll(".layer")].at(-1);
  return { layers: document.querySelectorAll(".layer").length, view: (${VIEW})(layer), waiting: layer.querySelectorAll("[data-waiting]").length };
})()`;
/* the same pours, free, with the drops perf.frames counts */
const FREE = `(async () => {
  const before = window.boxboxPerf.perf().samples.length;
  for (let round = 0; round < ${ROUNDS}; round++) {
    for (const w of [...document.querySelectorAll(".win .win-open")]) { w.click(); await new Promise((r) => setTimeout(r, 1200)); }
  }
  return window.boxboxPerf.perf().samples.slice(before).filter((s) => s.kind === "perf.frames").map((s) => s.props.dropped);
})()`;

type Step = { t: number; clip: string; transform: string; opacity: string; view: { fromEnd: number; turns: string[] } };
type Pour = { key: string; time: "first" | "again"; poured: string; animations: unknown[]; steps: unknown[]; landed: unknown };

const server = Bun.spawn(["bunx", "ladle", "serve", "--config", ".ladle", "--port", String(PORT)], { stdout: "ignore", stderr: "ignore" });
let failed = false;
const phased = new Map<number, number>();
try {
  for (let i = 0; i < 120; i++) {
    const up = await fetch(`http://127.0.0.1:${PORT}/meta.json`).then((r) => r.ok).catch(() => false);
    if (up) break;
    await Bun.sleep(500);
  }
  await ab("open", "about:blank").nothrow();
  await ab("set", "viewport", "1512", "945");
  const load = async () => {
    await ab("open", `http://127.0.0.1:${PORT}/?story=${STORY}&mode=preview`);
    for (let i = 0; i < 60 && !(await evaluate<boolean>("!!document.querySelector('[data-ready] .win')")); i++) await Bun.sleep(250);
    await Bun.sleep(2000);
  };
  await load();
  const count = await evaluate<number>("document.querySelectorAll('.win .win-open').length");
  const pours: Pour[] = [];
  /* the first window is the one on the stage when home opens: each other window is poured from a fresh page, so every
     pour starts from the same place */
  for (let index = 1; index < count; index++) {
    await load();
    for (const time of ["first", "again"] as const) {
      /* again: the thread was read on this page before (its turns' heights are remembered), with another poured over it since */
      if (time === "again") await evaluate<boolean>(`(async () => { document.querySelectorAll(".win .win-open")[${index === 1 ? 2 : 1}].click(); await new Promise((r) => setTimeout(r, 2500)); return true; })()`);
      const seen = await evaluate<{ key: string; poured: string; animations: unknown[]; steps: Array<{ view: { turns: string[] } }> }>(POUR(index));
      const landed = await evaluate<{ view: { turns: string[] } }>(LAND);
      pours.push({ ...seen, time, landed });
      console.log(`pour ${index} (${time}): ${seen.poured === seen.key ? "poured" : "POURED ANOTHER"}, ${seen.animations.length} animations, ${seen.steps.length} steps, turns in view at the first ${seen.steps[0]?.view.turns.length}, landed with ${landed.view.turns.length}`);
    }
  }
  await load();
  const drops = await evaluate<number[]>(FREE);
  const mean = drops.reduce((a, b) => a + b, 0) / Math.max(1, drops.length);
  console.log(`free pours: ${drops.length}, dropped frames per pour ${mean.toFixed(2)} (${drops.join(" ")})`);
  const seen = { story: STORY, pours };
  if (OUT) await Bun.write(OUT, JSON.stringify(seen, null, 1));
  if (AGAINST) {
    const was = (await Bun.file(AGAINST).json()) as typeof seen;
    pours.forEach((p, i) => {
      const w = was.pours[i];
      const differs = (what: string, a: unknown, b: unknown) => {
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        failed = true;
        console.log(`pour ${Math.floor(i / 2) + 1} (${p.time}): the ${what} differ\n  was ${JSON.stringify(b).slice(0, 400)}\n  now ${JSON.stringify(a).slice(0, 400)}`);
      };
      differs("animations", p.animations, w?.animations);
      /* the motion must be the same to the last digit. the view is too, but for where its boxes sit to a whole px: work moved out of
         the pour that changes the height of what is above the view (a turn made when it lands) moves the view's sub-pixel phase at the
         end of the scroller, which rounds a box's top to the px either side. that is said, with the largest, and fails past 1 px */
      p.steps.forEach((step, k) => {
        const was = w?.steps[k] as Step | undefined;
        const now = step as Step;
        differs(`motion at step ${k}`, [now.t, now.clip, now.transform, now.opacity], [was?.t, was?.clip, was?.transform, was?.opacity]);
        const placed = (v: Step["view"] | undefined) => v?.turns.map((t) => t.split(" | ")) ?? [];
        const a = placed(now.view), b = placed(was?.view);
        differs(`view at step ${k}`, [now.view.fromEnd, a.map((t) => [t[0], t[1], t[3], t[4]])], [was?.view.fromEnd, b.map((t) => [t[0], t[1], t[3], t[4]])]);
        a.forEach((t, j) => { const off = Math.abs(Number(t[2]) - Number(b[j]?.[2])); if (off > 0) { phased.set(i, Math.max(phased.get(i) ?? 0, off)); if (off > 1) differs(`view's boxes at step ${k}`, t[2], b[j]?.[2]); } });
      });
      differs("landed views", p.landed, w?.landed);
    });
    for (const [i, off] of phased) console.log(`pour ${Math.floor(i / 2) + 1} (${pours[i]?.time}): the view's boxes sit up to ${off} px from where they were during the pour (the sub-pixel phase at the end); the landed view is ${JSON.stringify(pours[i]?.landed) === JSON.stringify(was.pours[i]?.landed) ? "the same" : "different"}`);
    console.log(failed ? "the pour is drawn differently" : `the pour moves the same: ${pours.length} pours, every animation and every step's clip, transform and opacity equal, every view's turns, rows, heights and words equal, ${phased.size} with boxes a px off during the pour, every landed view equal`);
  }
} finally {
  await ab("close").nothrow();
  server.kill();
}
process.exit(failed ? 1 : 0);
