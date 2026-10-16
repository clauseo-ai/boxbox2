/* the screenshot test for the thread's and the composer's stories (docs/thread.md,
   verification): serves ladle, opens every story at phone, ipad and mac
   widths, saves a screenshot of each, runs the craft check (text crowding a
   surface's edge, surfaces touching, surfaces at the screen's edge) and
   fails on any finding or uncaught page error. the screenshots are looked
   at, not diffed.

   bun .ladle/shots.ts [--prefix <story prefix>] [--only <substring>] [--port <n>] [--keep] [--theme light|dark]   (from app/)
   the prefix picks whose stories: `thread--` (the default) or `composer--`. */

import { $ } from "bun";

const args = process.argv.slice(2);
/* each worktree's lane may run its own shots; a port of its own keeps one from reading another's stories (docs/gotchas.md) */
const PORT = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 61010;
const prefix = args.includes("--prefix") ? (args[args.indexOf("--prefix") + 1] ?? "thread--") : "thread--";
const WIDTHS: Array<[string, number, number]> = [["phone", 390, 844], ["ipad", 820, 1180], ["mac", 1512, 945]];
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const keep = args.includes("--keep");
/* `--theme light` (or dark) shoots every story in that appearance. ladle's own theme decides a story's (its default is
   dark, set on the root as data-theme), so it is asked for in the url, and the browser's colour scheme follows for a
   story whose app clears the root's theme (the shell's, on "system"). without it every story is ladle's dark */
const theme = args.includes("--theme") ? args[args.indexOf("--theme") + 1] : undefined;
const themed = theme ? `&theme=${theme}` : "";
const suffix = theme ? `-${theme}` : "";
const OUT = new URL("./shots/", import.meta.url).pathname;
const CRAFT = await Bun.file(new URL("./craft.js", import.meta.url)).text();

const session = (await $`agent-browser session id --scope worktree --prefix shots`.text()).trim();
/* a few tries with a growing pause: under load the daemon answers "resource temporarily unavailable" now and then, and a
   200-story run should not end on it. a page error or a craft finding still fails the story, since those are answers */
const env = { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "10000", ...(theme ? { AGENT_BROWSER_COLOR_SCHEME: theme } : {}) };
const ab = async (...a: string[]) => {
  for (const pause of [500, 1000, 2000]) {
    const result = await $`agent-browser --session ${session} ${a}`.env(env).quiet().nothrow();
    if (result.exitCode === 0) return result;
    await Bun.sleep(pause);
  }
  return $`agent-browser --session ${session} ${a}`.env(env).quiet();
};
/** stories that carry a check of their own, beyond the craft check: the page is asked once it is ready (and, for a story that plays, once it has finished), and anything the check finds fails the story.
    `wait` is true when the story is done; `find` lists what is wrong, as strings, or nothing */
const CHECKS: Array<{ id: RegExp; wait: string; find: string }> = [
  /* a read that keeps failing is said once the stage has waited its ten seconds (reading.ts), never "reading the thread." for ever */
  /* the jump to the latest shows once the reader has scrolled up, with the count of what came below (stage.tsx) */
  { id: /^stage--jump-far$/, wait: "!!document.querySelector('.jump.on')", find: "(() => document.querySelector('.jump.on .jump-n') ? ['a count with nothing new'] : [])()" },
  { id: /^stage--jump-(new-below|many)$/, wait: "!!document.querySelector('.jump.on .jump-n')", find: "(() => { const n = document.querySelector('.jump-n')?.textContent; return n === '3' || n === '99+' ? [] : [`the count says ${n}`]; })()" },
  /* a run folding whole as the agent writes again keeps its room at the end: the turn never moves down under a pinned reader (foot.ts) */
  { id: /^stage--foot-room$/, wait: "document.querySelector('.shell-story')?.dataset.done === '1'", find: "(() => { const d = document.querySelector('.shell-story')?.dataset; return d?.drops === '0' && Number(d.roomMost) > 0 ? [] : [`the turn moved down ${d?.drops ?? '?'} times (at most ${d?.dropMost ?? '?'} px) under a pinned reader; the most room kept was ${d?.roomMost ?? '?'} px`]; })()" },
  { id: /^stage--reading-failed$/, wait: "!!document.querySelector('.stage-trouble')", find: "(() => document.querySelector('.stage-retry[aria-label=\"read the thread again\"]') ? [] : ['no retry after the patience'])()" },
  /* a reply streamed through fences must replace no settled block (markdown.ts): `data-replaced` counts the ones it replaced */
  { id: /--said-streaming-through-fences$/, wait: "document.querySelector('.stage-sample')?.dataset.replay === 'done'", find: "(() => { const d = document.querySelector('.stage-sample')?.dataset; return d?.replaced === '0' ? [] : [`${d?.replaced ?? 'no count'} settled blocks were replaced while the reply streamed (it must be 0)`]; })()" },
  /* html written to look like our controls keeps none of its classes and no button (markdown.ts, the sanitiser) */
  { id: /--said-hostile-markup$/, wait: "true", find: "(() => { const md = document.querySelector('.say-md'); if (!md) return ['no said row']; const bad = md.querySelectorAll('span.copy-btn, .thread, .turn, p.cblock-h, p.cblock-lang'); const ours = md.querySelectorAll('button[data-copy][aria-label]').length; const blocks = md.querySelectorAll('.cblock').length; return [...(bad.length ? [`${bad.length} elements kept an agent's class`] : []), ...(ours !== blocks ? [`${ours} controls for ${blocks} blocks: a control that is not ours is on the page`] : [])]; })()" },
];

/** a fresh browser this often: a tab that has loaded some tens of stories can stop producing frames (docs/gotchas.md) */
const FRESH_EVERY = 25;

type Craft = { crowding: number; touching: number; atEdge: number; crowdBy: unknown[]; touchBy: unknown[]; edgeBy: unknown[] };
type Shot = { up: boolean; craft: Craft; errors: string[] };

/* the tab stops producing frames now and then after some tens of stories: evals still answer, navigations do not bring
   frames back, and a screenshot then waits forever (docs/gotchas.md). a frame is asked for before each screenshot, and a
   tab without one is replaced by a fresh browser */
const FRAME = "new Promise((r) => { const t = setTimeout(() => r('no frame'), 1500); requestAnimationFrame(() => { clearTimeout(t); r('frame'); }); })";
async function restart(w: number, h: number) {
  await $`agent-browser --session ${session} close`.quiet().nothrow();
  await ab("set", "viewport", String(w), String(h));
}

/** opens one story at the current viewport, waits for it, shoots it, runs the craft check and reads the page's errors */
async function shoot(id: string, label: string): Promise<Shot> {
  await ab("open", `http://127.0.0.1:${PORT}/?story=${id}&mode=preview${themed}`);
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { const r = (await ab("eval", "!!document.querySelector('[data-ready]')")).text().trim(); up = r.includes("true"); if (!up) await Bun.sleep(250); }
  await Bun.sleep(400);
  const check = CHECKS.find((c) => c.id.test(id));
  if (check) for (let i = 0; i < 240 && !(await ab("eval", check.wait)).text().includes("true"); i++) await Bun.sleep(250);
  if (!(await ab("eval", FRAME)).text().includes("frame\"")) throw new Error("the tab stopped producing frames");
  await ab("screenshot", `${OUT}${id}-${label}${suffix}.png`);
  const craftRaw = (await ab("eval", CRAFT)).text().trim();
  const craft = JSON.parse(JSON.parse(craftRaw) as string) as Craft;
  // the provider keeps the page's uncaught errors and rejections on the window (components.tsx)
  const errors = JSON.parse(JSON.parse((await ab("eval", "JSON.stringify(window.__boxboxErrors ?? [])")).text().trim()) as string) as string[];
  if (check) {
    const found = JSON.parse(JSON.parse((await ab("eval", `JSON.stringify(${check.find})`)).text().trim()) as string) as string[];
    errors.push(...found.map((f) => `check: ${f}`));
  }
  return { up, craft, errors };
}

const server = Bun.spawn(["bunx", "ladle", "serve", "--config", ".ladle", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe" });
const ready = async () => { for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/meta.json`); if (r.ok) return (await r.json()) as { stories: Record<string, { name: string }> }; } catch { /* not yet */ } await Bun.sleep(500); } throw new Error("ladle did not come up in 60 s"); };

let failures = 0;
const rows: string[] = [];
try {
  const meta = await ready();
  /* the thread's stories only: home's have their own test, home-shots.ts. the replays run for minutes and never settle into one frame; the live tape and window have their own still stories */
  const ids = Object.keys(meta.stories).filter((id) => id.startsWith(prefix)).filter((id) => !only || id.includes(only)).filter((id) => !/--live-/.test(id));
  await Bun.write(`${OUT}.keep`, "");
  let shots = 0;
  for (const [label, w, h] of WIDTHS) {
    await ab("set", "viewport", String(w), String(h));
    for (const id of ids) {
      if (shots > 0 && shots % FRESH_EVERY === 0) await restart(w, h);
      shots++;
      let shot: Shot | undefined;
      let problem = "";
      /* the browser can go away under a story (another session's `close --all`, a daemon that stopped answering) or
         stop producing frames: a fresh one is started, the viewport set again, and the story shot once more */
      for (let attempt = 0; attempt < 2 && !shot; attempt++) {
        try {
          if (attempt) await restart(w, h);
          shot = await shoot(id, label);
        } catch (e) {
          problem = e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e);
          console.log(`     ${id} at ${label}: ${problem.slice(0, 100)}; ${attempt ? "giving up" : "starting the browser again"}`);
        }
      }
      const { up, craft, errors } = shot ?? { up: false, craft: { crowding: 0, touching: 0, atEdge: 0, crowdBy: [], touchBy: [], edgeBy: [] }, errors: [] };
      const bad = !shot || !up || craft.crowding || craft.touching || craft.atEdge || errors.length;
      if (bad) failures++;
      rows.push(`${bad ? "FAIL" : "ok  "} ${label.padEnd(5)} ${id.padEnd(44)} ${shot ? "" : "no browser "}${up ? "" : "never ready "}crowding ${craft.crowding} touching ${craft.touching} edge ${craft.atEdge}${errors.length ? ` console: ${errors[0]?.slice(0, 120)}` : ""}${bad && (craft.crowdBy.length || craft.touchBy.length || craft.edgeBy.length) ? ` ${JSON.stringify([craft.crowdBy[0], craft.touchBy[0], craft.edgeBy[0]].filter(Boolean)).slice(0, 200)}` : ""}`);
      console.log(rows[rows.length - 1]);
    }
  }
} finally {
  if (!keep) await $`agent-browser --session ${session} close`.quiet().nothrow();
  server.kill();
}
console.log(`\n${rows.length} screenshots in ${OUT}; ${failures} failed`);
process.exit(failures ? 1 : 0);
