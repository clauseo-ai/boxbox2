/* the browser half of the terminal drive (bench/terminal.ts): the pane
   in agent-browser against the real daemon, reached by accessible names
   only, at mac, ipad and phone widths. every step prints what it saw. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export type Drive = {
  browser: (...argv: string[]) => string;
  log: (line: string) => void;
  check: (ok: unknown, what: string) => asserts ok;
  until: <T>(what: string, test: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs?: number, everyMs?: number) => Promise<T>;
  cut: () => Promise<void>;
  restartServer: () => Promise<void>;
  serverLog: (since?: number) => string;
  rssKb: () => number;
  gatePassword: string;
  app: string;
  out: string;
  flood: string;
  root: string;
};

type PaneState = { size: string | null; cursor: string | null; link: string | null; screen: string; keys: boolean; ended: string | null };

export async function driveBrowser(d: Drive) {
  const session = spawnSync("agent-browser", ["session", "id", "--scope", "worktree", "--prefix", "term-drive"], { encoding: "utf8" }).stdout.trim();
  const ab = (...argv: string[]) => d.browser("--session", session, ...argv);
  const evaluate = <T>(expression: string): T => {
    let value: unknown = ab("eval", `(async () => JSON.stringify(await (${expression})))()`);
    for (let i = 0; i < 3 && typeof value === "string"; i++) {
      try {
        value = JSON.parse(value);
      } catch {
        break;
      }
    }
    return value as T;
  };
  const pane = () =>
    evaluate<PaneState>(`Promise.resolve((() => {
      const term = document.querySelector('.term');
      return {
        size: term?.dataset.size ?? null,
        cursor: term?.dataset.cursor ?? null,
        link: term?.dataset.link ?? null,
        screen: document.querySelector('.xterm-rows')?.innerText ?? '',
        keys: !!document.querySelector('[role=toolbar][aria-label="terminal keys"]'),
        ended: document.querySelector('.term-plate p')?.textContent ?? null,
      };
    })())`);
  const screenLines = (text: string, last = 12) =>
    text
      .split("\n")
      .filter((l) => l.trim())
      .slice(-last)
      .map((l) => `    | ${l.replace(/[^\x20-\x7e─│┌┐└┘]/g, "·")}`)
      .join("\n");
  const typeLine = (text: string) => {
    ab("focus", "textarea");
    ab("type", "textarea", text);
    ab("press", "Enter");
  };
  const shot = (name: string) => {
    const path = join(d.out, `${name}.png`);
    ab("screenshot", path);
    d.log(`screenshot: ${path}`);
  };
  /** a fresh browser at mac width, signed in through the gate; `path` keeps the url's place */
  const signIn = async (path = "/") => {
    ab("set", "viewport", "1512", "945");
    ab("open", `${d.app}/`);
    ab("find", "label", "password", "fill", d.gatePassword);
    ab("find", "role", "button", "click", "--name", "sign in");
    await d.until("the machines screen", () => ab("snapshot", "-i").includes('button "new terminal on bench"'));
    if (path !== "/") ab("open", `${d.app}${path}`);
  };
  let touch: ChildProcess | null = null;
  const touchOn = async () => {
    touch = spawn("bun", [join(d.root, "bench/touch.ts"), session], { stdio: ["pipe", "pipe", "inherit"] });
    await new Promise<void>((resolve) => touch?.stdout?.once("data", () => resolve()));
  };
  /** a finger on the control with this accessible name */
  const tap = async (name: string) => {
    const box = evaluate<{ x: number; y: number } | null>(`Promise.resolve((() => {
      const el = document.querySelector('[aria-label="${name}"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })())`);
    if (!box || !touch?.stdin || !touch.stdout) throw new Error(`nothing to tap called "${name}"`);
    const tapped = new Promise<void>((resolve) => touch?.stdout?.once("data", () => resolve()));
    touch.stdin.write(`tap ${box.x} ${box.y}\n`);
    await tapped;
  };
  const touchOff = async () => {
    if (!touch) return;
    const gone = new Promise<void>((resolve) => touch?.once("exit", () => resolve()));
    touch.kill("SIGTERM");
    await gone;
    touch = null;
  };

  try {
    d.log(`—— browser: agent-browser session ${session} ——`);
    await signIn();
    d.check(true, "signed in through the gate; the bench machine offers a terminal");

    // the shell picker
    ab("find", "role", "button", "click", "--name", "pick a shell on bench");
    const menu = ab("snapshot", "-i");
    const shells = menu.split("\n").filter((l) => l.includes("menuitem"));
    d.log(`the shell picker lists ${shells.length} shells:\n${shells.map((l) => `    ${l.trim()}`).join("\n")}`);
    d.check(shells.some((l) => l.includes('"open zsh on bench"')), "zsh is offered");
    const logAt = d.serverLog().length;
    ab("find", "role", "menuitem", "click", "--name", "open zsh on bench");
    const opened = await d.until("the pane goes live", () => {
      const state = pane();
      return state.link === "live" && state.screen.trim() ? state : undefined;
    });
    const attached = await d.until("the relay logs the attach", () => d.serverLog(logAt).split("\n").find((l) => l.includes("terminal attached")));
    d.log(`server: ${attached.trim()}`);
    d.check(opened.size !== null, `a zsh terminal is open at mac width, ${opened.size}`);

    // run a command, see its bytes
    typeLine("echo hello-$((6*7)) from $0");
    const hello = await d.until("the command's output is on screen", () => {
      const state = pane();
      return /hello-42 from .*zsh/.test(state.screen) ? state : undefined;
    });
    d.log(`the screen:\n${screenLines(hello.screen, 4)}`);
    d.check(true, "typed a command and its output came back on the screen: hello-42 from zsh");
    shot("mac-1512");

    // resize: every width, checked by the shell itself
    const widths: [string, string, string][] = [
      ["ipad-820", "820", "1180"],
      ["phone-390", "390", "844"],
    ];
    for (const [name, w, h] of widths) {
      const before = pane().size;
      if (name.startsWith("phone")) {
        ab("set", "device", "iPhone 14");
        await touchOn();
        ab("reload");
      } else {
        ab("set", "viewport", w, h);
      }
      const now = await d.until(`the grid refits at ${w}`, () => {
        const state = pane();
        return state.size && state.size !== before && state.link === "live" ? state : undefined;
      });
      await Bun.sleep(400);
      typeLine("clear; stty size");
      const [cols, rows] = (now.size ?? "0x0").split("x");
      const said = await d.until(`stty size says ${rows} ${cols}`, () => (pane().screen.includes(`${rows} ${cols}`) ? pane() : undefined), 10_000);
      d.check(said.screen.includes(`${rows} ${cols}`), `at ${w}×${h} the grid is ${now.size} and stty size in the shell says "${rows} ${cols}"`);
      if (name.startsWith("phone")) {
        d.check(said.keys, "the keys row is there on touch: " + ab("snapshot", "-i", "-s", "[aria-label='terminal keys']").replace(/\n/g, " "));
        typeLine("sleep 30");
        await Bun.sleep(500);
        await tap("interrupt");
        const back = await d.until("^C ends the sleep", () => (/\^C/.test(pane().screen) ? pane() : undefined), 10_000);
        d.log(`the screen after the interrupt key:\n${screenLines(back.screen, 3)}`);
        d.check(true, "the interrupt key sent ^C and the prompt came back");
      }
      shot(name);
    }
    const puts = d.serverLog(logAt).split("\n").filter((l) => l.includes("method=PUT"));
    d.log(`resizes the server passed to cmx2: ${puts.length}; last: ${puts.at(-1)?.trim()}`);
    await touchOff();
    // a new browser, so nothing of the phone emulation stays; the url brings the terminal back
    const place = new URL(ab("get", "url")).search;
    ab("close");
    await signIn(`/${place}`);
    await d.until("the pane is live again at mac width", () => (pane().link === "live" ? true : undefined));

    // cut the relay's upstream while output streams: the relay redials with its cursor and replays what it missed
    typeLine("clear; for i in $(seq 1 30); do echo tick-$i; sleep 0.1; done; echo ticks-$((1000+1))");
    await d.until("the ticks start", () => (pane().screen.includes("tick-8") ? true : undefined), 10_000);
    const cursorBefore = pane().cursor;
    const cutAt = d.serverLog().length;
    await d.cut();
    const done = await d.until("the ticks finish on screen", () => (pane().screen.includes("ticks-1001") ? pane() : undefined), 20_000);
    const lines = d.serverLog(cutAt).split("\n");
    d.log(`server: ${lines.find((l) => l.includes("terminal lost its host"))?.trim()}`);
    d.log(`server: ${lines.find((l) => l.includes("terminal redialled"))?.trim()}`);
    const ticks = [...done.screen.matchAll(/^tick-(\d+)$/gm)].map((m) => Number(m[1]));
    d.log(`pane cursor before the cut ${cursorBefore}, after ${done.cursor}; link ${done.link}`);
    d.check(ticks.length === 30 && ticks.every((n, i) => n === i + 1), `all 30 ticks are on screen once, in order, across the cut (${ticks.join(" ")})`);
    shot("mac-after-cut");

    // the browser's own socket drops (the server restarts): the pane redials with its cursor
    const paneCursor = pane().cursor;
    const restartAt = d.serverLog().length;
    await d.restartServer();
    const redial = await d.until("the pane redials the new server", () =>
      d.serverLog(restartAt).split("\n").find((l) => l.includes("terminal connect")),
      30_000,
    );
    await d.until("the pane is live again", () => (pane().link === "live" ? true : undefined), 20_000);
    d.log(`server: ${redial.trim()}`);
    d.check(redial.includes(`cursor=${paneCursor}`), `the pane redialled with its cursor ${paneCursor} after its socket dropped`);
    typeLine("echo still-$((20+1))");
    await d.until("the terminal answers after the restart", () => (pane().screen.includes("still-21") ? true : undefined), 10_000);
    d.check(true, "the same shell answers after the redial: still-21");

    // 10 mb through the pane, rss sampled
    const samples: number[] = [d.rssKb()];
    const floodAt = d.serverLog().length;
    typeLine(d.flood);
    const floodStarted = performance.now();
    const sampler = setInterval(() => samples.push(d.rssKb()), 1000);
    await d
      .until("flood-done reaches the screen", () => (/^flood-done\s*$/m.test(pane().screen) ? true : undefined), 180_000, 500)
      .catch((e: unknown) => {
        d.log(`the screen when the wait ran out:\n${screenLines(pane().screen, 6)}`);
        throw e;
      });
    clearInterval(sampler);
    samples.push(d.rssKb());
    const overflows = d.serverLog(floodAt).split("\n").filter((l) => l.includes('cause="overflow"')).length;
    d.log(`server rss (kb) every second while 10 mb went through the pane: ${samples.join(" ")}`);
    d.log(`10 mb reached the screen in ${((performance.now() - floodStarted) / 1000).toFixed(1)} s; overflows during the flood: ${overflows}`);
    const peak = Math.max(...samples);
    d.check(peak - (samples[0] ?? 0) < 8 * 1024, `the relay's rss stayed steady: start ${samples[0]} kb, peak ${peak} kb, end ${samples.at(-1)} kb`);
    shot("mac-after-flood");

    // rename, then kill, through the head
    ab("find", "role", "button", "click", "--name", "rename terminal zsh");
    ab("find", "label", "terminal name", "fill", "build log");
    ab("press", "Enter");
    await d.until("the rename shows", () => (ab("snapshot", "-i").includes('button "rename terminal build log"') ? true : undefined), 15_000);
    d.check(true, "renamed through the head: the pane and the machine's list say \"build log\"");
    ab("find", "role", "button", "click", "--name", "kill terminal build log");
    ab("find", "role", "button", "click", "--name", "yes, kill terminal build log");
    const ended = await d.until("the death plate", () => pane().ended ?? undefined, 15_000);
    d.check(ended.length > 0, `killed: the pane says "${ended}" and offers a new terminal`);
    shot("mac-ended");
    ab("find", "role", "button", "click", "--name", "close the ended terminal");
    await d.until("the pane closes", () => (!ab("snapshot", "-i").includes('region "terminal build log"') ? true : undefined));
    d.check(true, "closed the ended terminal; the machines are back");
  } finally {
    await touchOff();
    ab("close");
  }
}
