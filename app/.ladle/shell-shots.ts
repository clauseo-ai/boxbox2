/* the screenshot test for the shell's stories (docs/architecture.md, the
   route table): serves ladle, opens the whole app at every route (home, a
   thread open, the machines, settings, the terminal) at phone, ipad and mac
   sizes, saves a screenshot of each for a person to look at, and fails a
   story that never became ready, logged an uncaught error, scrolls the page
   sideways, has a control without a name or with a name another control on
   the page shares (AGENTS.md rule 5), or has a craft finding (craft.js:
   text crowding a surface's edge, surfaces touching, a surface at the
   screen's edge).

   bun .ladle/shell-shots.ts [--only <substring>] [--out <dir>] [--port <n>] [--keep] [--theme light|dark]   (from app/) */

import { $ } from "bun";

const WIDTHS: Array<[string, number, number]> = [
  ["phone", 390, 844],
  ["ipad", 820, 1180],
  ["mac", 1512, 945],
];
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const keep = args.includes("--keep");
/* `--theme light` (or dark) shoots every story in that appearance. ladle's own theme decides a story's (its default is
   dark, set on the root as data-theme), so it is asked for in the url, and the browser's colour scheme follows for a
   story whose app clears the root's theme (the shell's, on "system"). without it every story is ladle's dark */
const theme = args.includes("--theme") ? args[args.indexOf("--theme") + 1] : undefined;
const themed = theme ? `&theme=${theme}` : "";
const suffix = theme ? `-${theme}` : "";
const OUT = args.includes("--out") ? (args[args.indexOf("--out") + 1] ?? "") : "/tmp/boxbox-shell-shots";
/** a port of the run's own, so two worktrees can shoot at once */
const PORT = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 61104;
const CRAFT = await Bun.file(new URL("./craft.js", import.meta.url)).text();

const session = `shell-shots-${process.pid}`;
const env = { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "15000", ...(theme ? { AGENT_BROWSER_COLOR_SCHEME: theme } : {}) };
const ab = (...a: string[]) => $`agent-browser --session ${session} ${a}`.env(env).quiet();
/** the page answers `{"v": value}` as json, and the cli's own quoting is unwrapped exactly once (docs/gotchas.md) */
async function evaluate<T>(expression: string): Promise<T> {
  let raw = (await ab("eval", `JSON.stringify({ v: (${expression}) })`).text()).trim();
  if (raw.startsWith('"')) raw = JSON.parse(raw) as string;
  return (JSON.parse(raw) as { v: T }).v;
}

/** every visible control's accessible name as the page computes it, the empty and the repeated ones */
const AUDIT = `(() => {
  const controls = [...document.querySelectorAll("button, [role=button], [role=slider], a[href], input, textarea, select")].filter((el) => el.getClientRects().length > 0 && !el.closest("[inert], [aria-hidden=true]"));
  const name = (el) => (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].textContent) || el.textContent || "").trim().replace(/\\s+/g, " ");
  const names = controls.map(name);
  const repeated = [...new Set(names.filter((n, i) => n && names.indexOf(n) !== i))];
  return { controls: controls.length, unnamed: names.filter((n) => !n).length, repeated, sideways: document.documentElement.scrollWidth > innerWidth + 1 && getComputedStyle(document.documentElement).overflowX !== "hidden" };
})()`;

type Group = { k: string; n: number; eg: unknown };
type Craft = { crowding: number; touching: number; atEdge: number; crowdBy: Group[]; touchBy: Group[]; edgeBy: Group[] };

/** surfaces the design law puts nearer the screen's edge than the craft check's 12 px: the terminal's bed runs to
    8 px from the phone's edges, because columns are what a terminal is made of (design.md, the terminal) */
const AT_THE_EDGE_BY_LAW = ["term-bed"];
/* what is inert sits behind something on purpose (the deck's windows under an open thread, the machines under the
   terminal), so it is out of view and the craft check does not read it; the screenshot is already taken */
const HIDE_INERT = `(document.querySelectorAll("[inert]").forEach((el) => { el.style.visibility = "hidden"; }), true)`;
type Audit = { controls: number; unnamed: number; repeated: string[]; sideways: boolean };

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
  const ids = Object.keys(meta.stories).filter((id) => id.startsWith("shell--") && (!only || id.includes(only)));
  for (const [label, width, height] of WIDTHS) {
    // a fresh browser per size, the viewport set before the first page (docs/gotchas.md: a page keeps the width it was born with)
    await ab("close").nothrow();
    // with a colour scheme in the environment the cli's first command after a close fails once ("could not configure browser")
    // and launches the browser for the next, so a blank page is opened first and its failure is let go
    await ab("open", "about:blank").nothrow();
    await ab("set", "viewport", String(width), String(height));
    for (const id of ids) {
      await ab("open", `http://127.0.0.1:${PORT}/?story=${id}&mode=preview${themed}`);
      // the first viewport of a freshly launched browser can be lost (bench/shell.ts): the page is asked, and set again if so
      if ((await evaluate<number>("innerWidth")) !== width) {
        await ab("set", "viewport", String(width), String(height));
        await ab("open", `http://127.0.0.1:${PORT}/?story=${id}&mode=preview${themed}`);
      }
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        up = await evaluate<boolean>("!!document.querySelector('[data-ready]')");
        if (!up) await Bun.sleep(250);
      }
      // the content fade and any first-frame motion settle before the picture
      await Bun.sleep(600);
      const file = `${OUT}/${id}-${label}${suffix}.png`;
      await ab("screenshot", file);
      shots++;
      const audit = await evaluate<Audit>(AUDIT);
      await evaluate<boolean>(HIDE_INERT);
      const craft = JSON.parse(await evaluate<string>(CRAFT)) as Craft;
      const byLaw = craft.edgeBy.filter((g) => AT_THE_EDGE_BY_LAW.some((name) => g.k.split(" ").includes(name)));
      craft.atEdge -= byLaw.reduce((sum, g) => sum + g.n, 0);
      craft.edgeBy = craft.edgeBy.filter((g) => !byLaw.includes(g));
      const errors = await evaluate<string[]>("window.__boxboxErrors ?? []");
      // a story that did not show what it is for says why on its element (mount.tsx, settled)
      const why = up ? "" : await evaluate<string>("document.querySelector('.shell-story')?.dataset.why ?? ''");
      const problems = [
        up ? "" : `never ready${why ? `: ${why}` : ""}`,
        audit.unnamed ? `${audit.unnamed} unnamed controls` : "",
        audit.repeated.length ? `repeated names: ${audit.repeated.join(" | ")}` : "",
        audit.sideways ? "the page scrolls sideways" : "",
        craft.crowding ? `crowding ${craft.crowding} ${JSON.stringify(craft.crowdBy[0]).slice(0, 160)}` : "",
        craft.touching ? `touching ${craft.touching} ${JSON.stringify(craft.touchBy[0]).slice(0, 160)}` : "",
        craft.atEdge ? `at the edge ${craft.atEdge} ${JSON.stringify(craft.edgeBy[0]).slice(0, 160)}` : "",
        errors[0] ? `page error: ${errors[0].slice(0, 140)}` : "",
      ].filter(Boolean);
      if (problems.length) failures++;
      console.log(`${problems.length ? "FAIL" : "ok  "} ${label.padEnd(5)} ${id.padEnd(22)} ${String(audit.controls).padStart(3)} controls  ${problems.join("; ")}`);
    }
  }
} finally {
  if (!keep) await ab("close").nothrow();
  server.kill();
}
console.log(`\n${shots} screenshots in ${OUT}; ${failures} failed`);
process.exit(failures ? 1 : 0);
