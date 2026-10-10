/* writes the README's hero banner, assets/hero.svg (light) and assets/hero-dark.svg.

     bun scripts/hero.ts          (from the repo root)

   the banner is one story on an 11 s loop: agents on three machines stream into one
   inbox, a question on one of them rises to the top, and the phone pings. it is a
   plain svg with css keyframes, because github plays those inside an <img> and strips
   scripts. there are no web fonts: text is a system stack, and the wordmark is the
   outlined path from app/public/icon.svg, so there is one source for it.

   the unanimated style of every element is the end of the story (question on top,
   phone pinged), so `prefers-reduced-motion` just switches the animations off and
   leaves a finished picture. colours are the app's repo palette
   (app/src/ui/window/repo.ts). */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const W = 900;
const H = 392;
const LOOP = 11;

type Repo = { top: string; bottom: string; light: string };
const REPOS: Record<string, Repo> = {
  rose: { top: "#5a1f45", bottom: "#2a0d20", light: "#ff9fd0" },
  blue: { top: "#173a5e", bottom: "#0a1a2e", light: "#9cc8ff" },
  teal: { top: "#10484a", bottom: "#062123", light: "#7fe0d6" },
  green: { top: "#1b4a33", bottom: "#0c2419", light: "#8fe6a5" },
  plum: { top: "#46205c", bottom: "#1f0e2b", light: "#dfa8ff" },
  clay: { top: "#5a2c19", bottom: "#29130a", light: "#ffb48c" },
};
const VIOLET = { top: "#34298a", bottom: "#171240", light: "#b7abff" };

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;

function mix(a: string, b: string, t: number): string {
  const n = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = (i: number) => Math.round(n(a, i) * (1 - t) + n(b, i) * t).toString(16).padStart(2, "0");
  return `#${c(0)}${c(1)}${c(2)}`;
}

/** the outlined "boxbox" from the app icon: its first path, 74.9..307.3 by 117.3..165.6 */
const icon = readFileSync(`${ROOT}app/public/icon.svg`, "utf8");
const WORDMARK = /<path fill="#f4f4f6" d="([^"]+)"/.exec(icon)?.[1];
if (!WORDMARK) throw new Error("app/public/icon.svg no longer has the wordmark path first");

type Theme = {
  name: "light" | "dark";
  groundTop: string;
  groundBottom: string;
  ground: string;
  edge: string;
  ink: string;
  muted: string;
  card: string;
  cardEdge: string;
  stream: string;
  streamTrack: string;
  windowTop: string;
  windowBottom: string;
  windowEdge: string;
  windowInk: string;
  pill: string;
  pillInk: string;
  need: string;
  needInk: string;
  accent: string;
  wallTop: string;
  wallBottom: string;
};

const DARK: Theme = {
  name: "dark",
  groundTop: "#14112e",
  groundBottom: "#0b0a1a",
  ground: "#0b0a1a",
  edge: "#b7abff",
  ink: "#f4f4f6",
  muted: "#a9a6c4",
  card: "#ffffff",
  cardEdge: "#ffffff",
  stream: "#b7abff",
  streamTrack: "#b7abff",
  windowTop: VIOLET.top,
  windowBottom: VIOLET.bottom,
  windowEdge: "#ffffff",
  windowInk: "#f4f4f6",
  pill: "#b7abff",
  pillInk: "#171240",
  need: "#f3d474",
  needInk: "#211a07",
  accent: "#b7abff",
  wallTop: "#2e2480",
  wallBottom: "#110d30",
};

const LIGHT: Theme = {
  name: "light",
  groundTop: "#f8f6ff",
  groundBottom: "#ebe8fb",
  ground: "#f3f1fd",
  edge: "#34298a",
  ink: "#171240",
  muted: "#6c6794",
  card: "#ffffff",
  cardEdge: "#34298a",
  stream: "#34298a",
  streamTrack: "#34298a",
  windowTop: "#eceaff",
  windowBottom: "#fbfaff",
  windowEdge: "#34298a",
  windowInk: "#171240",
  pill: "#34298a",
  pillInk: "#ffffff",
  need: "#f0c94f",
  needInk: "#2a2008",
  accent: "#34298a",
  wallTop: "#7b6ee0",
  wallBottom: "#3b2f9e",
};

/* geometry. three machine cards, the inbox window, the phone, all 282 tall and bottom-aligned */
const TOP = 64;
const BOTTOM = 346;
const CARD = { x: 36, w: 230, h: 78, ys: [88, 178, 268] };
const WIN = { x: 392, y: TOP, w: 260, h: BOTTOM - TOP };
const PHONE = { x: 728, y: TOP, w: 136, h: BOTTOM - TOP };
const ROW = { dx: 14, dy: 52, w: 232, h: 48, pitch: 56 };

type Machine = { name: string; agents: Array<{ repo: string; label: string; bar: number }> };
const MACHINES: Machine[] = [
  { name: "desk", agents: [{ repo: "blue", label: "site", bar: 126 }, { repo: "teal", label: "api", bar: 92 }] },
  { name: "vm", agents: [{ repo: "rose", label: "ledger", bar: 118 }, { repo: "green", label: "docs", bar: 76 }] },
  { name: "laptop", agents: [{ repo: "clay", label: "web", bar: 104 }, { repo: "plum", label: "infra", bar: 130 }] },
];

/** the inbox, top to bottom once the question has risen. `ask` is the one that arrives */
type Item = { id: "ask" | "a" | "b" | "c"; repo: string; title: string; sub: string };
const ITEMS: Item[] = [
  { id: "ask", repo: "rose", title: "set the greeting", sub: "ledger · which one?" },
  { id: "a", repo: "blue", title: "pricing table", sub: "site · review ready" },
  { id: "b", repo: "teal", title: "retry webhook queue", sub: "api · done" },
  { id: "c", repo: "green", title: "summarise changelog", sub: "docs · done" },
];

/** the cubic from a card's edge to the inbox window, as one string and as sampled points */
function stream(i: number): { d: string; at: (u: number) => [number, number] } {
  const y0 = CARD.ys[i]! + CARD.h / 2;
  const y1 = WIN.y + 86 + i * 56;
  const x0 = CARD.x + CARD.w;
  const x1 = WIN.x + 4;
  const cx = (x0 + x1) / 2;
  const at = (u: number): [number, number] => {
    const v = 1 - u;
    const x = v ** 3 * x0 + 3 * v * v * u * cx + 3 * v * u * u * cx + u ** 3 * x1;
    const y = v ** 3 * y0 + 3 * v * v * u * y0 + 3 * v * u * u * y1 + u ** 3 * y1;
    return [x, y];
  };
  return { d: `M${x0} ${y0}C${cx} ${y0} ${cx} ${y1} ${x1} ${y1}`, at };
}

/** a point in the loop, in percent (the story is written in percent of the loop) */
const p = (v: number) => `${v}%`;
const f = (n: number) => Number(n.toFixed(1));

function css(t: Theme): string {
  const mid = stream(1);
  const packet = [0, 0.25, 0.5, 0.75, 1].map((u, i) => {
    const [x, y] = mid.at(u);
    const start = 16.5 + i * 2.9;
    return `${p(f(start))}{transform:translate(${f(x)}px,${f(y)}px)}`;
  });
  return `
.loop{animation-duration:${LOOP}s;animation-iteration-count:infinite;animation-timing-function:ease-in-out}
.flow{stroke-dasharray:0.1 15;stroke-linecap:round;fill:none;animation:flow 1.9s linear infinite}
.flow.s2{animation-duration:2.4s}.flow.s3{animation-duration:2.1s}
@keyframes flow{to{stroke-dashoffset:-30.2}}
.bar{transform-box:fill-box;transform-origin:0 50%;animation:write 4s ease-out infinite}
@keyframes write{0%{transform:scaleX(.08);opacity:.9}72%{transform:scaleX(1);opacity:.9}92%{transform:scaleX(1);opacity:.9}100%{transform:scaleX(1);opacity:0}}
.cursor{animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}

.askdot{animation-name:askdot}
@keyframes askdot{0%,15%{fill:${REPOS.rose!.light}}17%,83%{fill:${t.need}}89%,100%{fill:${REPOS.rose!.light}}}
.askring{opacity:0;transform-box:fill-box;transform-origin:center;animation-name:askring}
@keyframes askring{0%,15.5%{opacity:0;transform:scale(1)}16.5%{opacity:.9;transform:scale(1)}26%{opacity:0;transform:scale(3.2)}100%{opacity:0;transform:scale(3.2)}}
.packet{opacity:0;animation-name:packet,packetfade;animation-timing-function:linear}
@keyframes packet{0%,16%{transform:translate(${f(mid.at(0)[0])}px,${f(mid.at(0)[1])}px)}${packet.join("")}100%{transform:translate(${f(mid.at(1)[0])}px,${f(mid.at(1)[1])}px)}}
@keyframes packetfade{0%,16%{opacity:0}17%{opacity:1}27%{opacity:1}29%,100%{opacity:0}}

.shift{animation-name:shift;animation-timing-function:cubic-bezier(.3,.9,.3,1)}
@keyframes shift{0%,30%{transform:translateY(-${ROW.pitch}px)}40%{transform:translateY(0)}84%{transform:translateY(0)}92%{transform:translateY(-${ROW.pitch}px)}100%{transform:translateY(-${ROW.pitch}px)}}
.ask{transform-box:fill-box;transform-origin:center;animation-name:ask;animation-timing-function:cubic-bezier(.3,.9,.3,1)}
@keyframes ask{
0%,28%{opacity:0;transform:translateY(${ROW.pitch * 3}px)}
30%{opacity:1;transform:translateY(${ROW.pitch * 3}px)}
40%{opacity:1;transform:translateY(0)}
84%{opacity:1;transform:translateY(0)}
90%{opacity:0;transform:translateY(0) translateX(18px)}
90.1%,100%{opacity:0;transform:translateY(${ROW.pitch * 3}px)}}
.n3{opacity:0;animation-name:n3}
@keyframes n3{0%,39%{opacity:1}41%,84%{opacity:0}90%,100%{opacity:1}}
.n4{animation-name:n4}
@keyframes n4{0%,39%{opacity:0}41%,84%{opacity:1}90%,100%{opacity:0}}

.pushpkt{opacity:0;animation-name:pushpkt;animation-timing-function:linear}
@keyframes pushpkt{0%,42%{opacity:0;transform:translateX(${WIN.x + WIN.w}px)}43%{opacity:1;transform:translateX(${WIN.x + WIN.w + 4}px)}48%{opacity:1;transform:translateX(${PHONE.x - 4}px)}49%,100%{opacity:0;transform:translateX(${PHONE.x - 4}px)}}
.buzz{animation-name:buzz;animation-timing-function:linear}
@keyframes buzz{0%,50%{transform:translateX(0)}51%{transform:translateX(-2px)}52%{transform:translateX(2px)}53%{transform:translateX(-2px)}54%{transform:translateX(1.5px)}55%,100%{transform:translateX(0)}}
.ring{opacity:0;transform-box:fill-box;transform-origin:center;animation-name:ring;animation-timing-function:ease-out}
@keyframes ring{0%,50%{opacity:0;transform:scale(1)}51%{opacity:.75;transform:scale(1)}68%{opacity:0;transform:scale(1.22,1.1)}100%{opacity:0;transform:scale(1.22,1.1)}}
.ring.r2{animation-name:ring2}
@keyframes ring2{0%,54%{opacity:0;transform:scale(1)}55%{opacity:.6;transform:scale(1)}72%{opacity:0;transform:scale(1.22,1.1)}100%{opacity:0;transform:scale(1.22,1.1)}}
.banner{animation-name:banner;animation-timing-function:cubic-bezier(.2,.9,.3,1.15)}
@keyframes banner{0%,48%{opacity:0;transform:translateY(-84px)}53%{opacity:1;transform:translateY(0)}82%{opacity:1;transform:translateY(0);animation-timing-function:ease-in}86%,100%{opacity:0;transform:translateY(-34px)}}

@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;
}

function build(t: Theme): string {
  const dark = t.name === "dark";
  const out: string[] = [];
  const add = (s: string) => out.push(s);

  const repoFill = (r: Repo) => (dark ? [r.top, r.bottom] : [mix("#ffffff", r.light, 0.34), mix("#ffffff", r.light, 0.14)]);
  const repoInk = (r: Repo) => (dark ? t.ink : r.top);
  const repoSub = (r: Repo) => (dark ? r.light : mix(r.top, "#ffffff", 0.18));
  const repoDot = (r: Repo) => (dark ? r.light : mix(r.top, r.light, 0.45));
  const barFill = (r: Repo) => (dark ? r.light : mix(r.top, r.light, 0.5));

  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">`);
  add(`<title id="t">boxbox</title>`);
  add(
    `<desc id="d">agents on three machines stream into one inbox. a question from one of them rises to the top and a phone buzzes with a notification.</desc>`,
  );
  add(`<style>${css(t)}</style>`);

  add(`<defs>`);
  add(`<linearGradient id="g" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="${t.groundTop}"/><stop offset="1" stop-color="${t.groundBottom}"/></linearGradient>`);
  add(`<linearGradient id="w" x1=".4" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="${t.windowTop}"/><stop offset="1" stop-color="${t.windowBottom}"/></linearGradient>`);
  add(`<radialGradient id="hi" cx=".06" cy="-.04" r="1.05"><stop offset="0" stop-color="#fff" stop-opacity="${dark ? 0.14 : 0.9}"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>`);
  add(`<linearGradient id="lit" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${dark ? 0.3 : 0.9}"/><stop offset=".16" stop-color="#fff" stop-opacity="0"/></linearGradient>`);
  add(`<linearGradient id="wall" x1=".3" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="${t.wallTop}"/><stop offset="1" stop-color="${t.wallBottom}"/></linearGradient>`);
  for (const [name, r] of Object.entries(REPOS)) {
    const [a, b] = repoFill(r);
    add(`<linearGradient id="r-${name}" x1=".4" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`);
  }
  add(`<clipPath id="screen"><rect x="${PHONE.x + 5}" y="${PHONE.y + 5}" width="${PHONE.w - 10}" height="${PHONE.h - 10}" rx="25"/></clipPath>`);
  add(`</defs>`);

  /* ground */
  add(`<rect width="${W}" height="${H}" rx="22" fill="url(#g)"/>`);
  add(`<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="21.5" fill="none" stroke="${t.edge}" stroke-opacity="${dark ? 0.16 : 0.14}"/>`);

  /* wordmark and its cursor */
  const s = 0.8;
  add(`<g transform="translate(36 21) scale(${s}) translate(-74.9 -117.3)" fill="${t.ink}"><path d="${WORDMARK}"/></g>`);
  add(`<rect class="cursor" x="${f(36 + (307.3 - 74.9) * s + 8)}" y="${f(21 + 8 * s)}" width="12" height="${f(32 * s + 3)}" rx="2" fill="${t.accent}"/>`);

  /* streams under everything else: a faint track and the moving dots */
  for (let i = 0; i < 3; i++) {
    const { d } = stream(i);
    add(`<path d="${d}" fill="none" stroke="${t.streamTrack}" stroke-opacity="${dark ? 0.12 : 0.12}" stroke-width="1.2"/>`);
    add(`<path class="flow s${i + 1}" d="${d}" stroke="${t.stream}" stroke-opacity="${dark ? 0.7 : 0.6}" stroke-width="3.2"/>`);
  }

  /* machines */
  MACHINES.forEach((m, i) => {
    const y = CARD.ys[i]!;
    add(`<g>`);
    add(`<rect x="${CARD.x}" y="${y}" width="${CARD.w}" height="${CARD.h}" rx="14" fill="${t.card}" fill-opacity="${dark ? 0.045 : 0.92}" stroke="${t.cardEdge}" stroke-opacity="${dark ? 0.1 : 0.11}"/>`);
    add(`<text x="${CARD.x + 16}" y="${y + 23}" font-family="${MONO}" font-size="11.5" font-weight="600" fill="${t.ink}">${m.name}</text>`);
    add(`<text x="${CARD.x + CARD.w - 16}" y="${y + 23}" font-family="${MONO}" font-size="10" text-anchor="end" fill="${t.muted}">cmx2</text>`);
    m.agents.forEach((a, j) => {
      const r = REPOS[a.repo]!;
      const cy = y + 45 + j * 19;
      const isAsk = m.name === "vm" && j === 0;
      if (isAsk) {
        add(`<circle class="loop askring" cx="${CARD.x + 20}" cy="${cy}" r="3.6" fill="none" stroke="${t.need}" stroke-width="1.4"/>`);
        add(`<circle class="loop askdot" cx="${CARD.x + 20}" cy="${cy}" r="3.6" fill="${t.need}"/>`);
      } else {
        add(`<circle cx="${CARD.x + 20}" cy="${cy}" r="3.6" fill="${repoDot(r)}"/>`);
      }
      add(`<text x="${CARD.x + 32}" y="${cy + 3.4}" font-family="${MONO}" font-size="10" fill="${t.muted}">${a.label}</text>`);
      const delay = -((i * 2 + j) * 0.83).toFixed(2);
      const dur = (3.4 + ((i * 2 + j) % 4) * 0.55).toFixed(2);
      add(`<rect class="bar" x="${CARD.x + 84}" y="${cy - 2.5}" width="${a.bar}" height="5" rx="2.5" fill="${barFill(r)}" fill-opacity="${dark ? 0.55 : 0.6}" style="animation-duration:${dur}s;animation-delay:${delay}s"/>`);
    });
    add(`</g>`);
  });

  /* the inbox window */
  add(`<g>`);
  add(`<rect x="${WIN.x}" y="${WIN.y + 14}" width="${WIN.w}" height="${WIN.h - 8}" rx="22" fill="${dark ? "#000" : t.windowEdge}" fill-opacity="${dark ? 0.38 : 0.1}"/>`);
  add(`<rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="22" fill="url(#w)"/>`);
  add(`<rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="22" fill="url(#hi)"/>`);
  add(`<rect x="${WIN.x + 0.5}" y="${WIN.y + 0.5}" width="${WIN.w - 1}" height="${WIN.h - 1}" rx="21.5" fill="none" stroke="${dark ? "url(#lit)" : t.windowEdge}" stroke-opacity="${dark ? 1 : 0.16}" stroke-width="1"/>`);
  add(`<text x="${WIN.x + 20}" y="${WIN.y + 31}" font-family="${SANS}" font-size="14" font-weight="650" fill="${t.windowInk}">needs you</text>`);
  add(`<circle cx="${WIN.x + WIN.w - 30}" cy="${WIN.y + 26}" r="11" fill="${t.pill}"/>`);
  add(`<text class="loop n3" x="${WIN.x + WIN.w - 30}" y="${WIN.y + 30.2}" text-anchor="middle" font-family="${SANS}" font-size="12" font-weight="700" fill="${t.pillInk}">3</text>`);
  add(`<text class="loop n4" x="${WIN.x + WIN.w - 30}" y="${WIN.y + 30.2}" text-anchor="middle" font-family="${SANS}" font-size="12" font-weight="700" fill="${t.pillInk}">4</text>`);

  /* rows. the outer group places a row where it ends up, the inner one animates the offset from where it starts */
  const rows = [...ITEMS].reverse(); /* the asking row paints last, above the ones it passes */
  for (const item of rows) {
    const r = REPOS[item.repo]!;
    const slot = ITEMS.indexOf(item);
    const y = WIN.y + ROW.dy + slot * ROW.pitch;
    const x = WIN.x + ROW.dx;
    const cls = item.id === "ask" ? "loop ask" : "loop shift";
    add(`<g transform="translate(${x} ${y})"><g class="${cls}">`);
    add(`<rect width="${ROW.w}" height="${ROW.h}" rx="13" fill="url(#r-${item.repo})"/>`);
    if (dark) add(`<rect x=".5" y=".5" width="${ROW.w - 1}" height="${ROW.h - 1}" rx="12.5" fill="none" stroke="url(#lit)"/>`);
    else add(`<rect x=".5" y=".5" width="${ROW.w - 1}" height="${ROW.h - 1}" rx="12.5" fill="none" stroke="${r.top}" stroke-opacity=".14"/>`);
    if (item.id === "ask") add(`<rect x="-.75" y="-.75" width="${ROW.w + 1.5}" height="${ROW.h + 1.5}" rx="13.5" fill="none" stroke="${t.need}" stroke-width="1.5" stroke-opacity=".85"/>`);
    add(`<text x="14" y="20" font-family="${SANS}" font-size="13" font-weight="650" fill="${repoInk(r)}">${item.title}</text>`);
    add(`<text x="14" y="36.5" font-family="${MONO}" font-size="10" fill="${repoSub(r)}" fill-opacity=".9">${item.sub}</text>`);
    if (item.id === "ask") {
      add(`<rect x="${ROW.w - 80}" y="8" width="68" height="19" rx="9.5" fill="${t.need}"/>`);
      add(`<text x="${ROW.w - 46}" y="21.2" text-anchor="middle" font-family="${SANS}" font-size="10.5" font-weight="700" fill="${t.needInk}">wants you</text>`);
    }
    add(`</g></g>`);
  }
  add(`</g>`);

  /* push: window to phone */
  const py = WIN.y + 104;
  add(`<line x1="${WIN.x + WIN.w + 8}" y1="${py}" x2="${PHONE.x - 8}" y2="${py}" stroke="${t.streamTrack}" stroke-opacity=".28" stroke-width="1.2" stroke-dasharray="3 5"/>`);
  add(`<text x="${(WIN.x + WIN.w + PHONE.x) / 2}" y="${py - 10}" text-anchor="middle" font-family="${MONO}" font-size="10" fill="${t.muted}">web push</text>`);
  add(`<g transform="translate(0 ${py})"><circle class="loop pushpkt" cx="0" cy="0" r="4" fill="${t.need}"/></g>`);

  /* the asking packet, from the vm to the inbox */
  add(`<circle class="loop packet" cx="0" cy="0" r="4.2" fill="${t.need}"/>`);

  /* phone */
  add(`<g class="loop buzz">`);
  add(`<rect class="loop ring" x="${PHONE.x}" y="${PHONE.y}" width="${PHONE.w}" height="${PHONE.h}" rx="30" fill="none" stroke="${t.need}" stroke-width="2"/>`);
  add(`<rect class="loop ring r2" x="${PHONE.x}" y="${PHONE.y}" width="${PHONE.w}" height="${PHONE.h}" rx="30" fill="none" stroke="${t.need}" stroke-width="2"/>`);
  add(`<rect x="${PHONE.x}" y="${PHONE.y + 6}" width="${PHONE.w}" height="${PHONE.h - 2}" rx="30" fill="#000" fill-opacity="${dark ? 0.4 : 0.14}"/>`);
  add(`<rect x="${PHONE.x}" y="${PHONE.y}" width="${PHONE.w}" height="${PHONE.h}" rx="30" fill="${dark ? "#05050c" : "#14122b"}"/>`);
  add(`<rect x="${PHONE.x + 0.5}" y="${PHONE.y + 0.5}" width="${PHONE.w - 1}" height="${PHONE.h - 1}" rx="29.5" fill="none" stroke="#fff" stroke-opacity=".2"/>`);
  add(`<g clip-path="url(#screen)">`);
  add(`<rect x="${PHONE.x + 5}" y="${PHONE.y + 5}" width="${PHONE.w - 10}" height="${PHONE.h - 10}" fill="url(#wall)"/>`);
  add(`<rect x="${PHONE.x + 5}" y="${PHONE.y + 5}" width="${PHONE.w - 10}" height="${PHONE.h - 10}" fill="url(#hi)" opacity=".7"/>`);
  const cx = PHONE.x + PHONE.w / 2;
  add(`<rect x="${cx - 21}" y="${PHONE.y + 13}" width="42" height="12" rx="6" fill="#000"/>`);
  add(`<text x="${cx}" y="${PHONE.y + 80}" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="300" fill="#fff" fill-opacity=".95">07:42</text>`);
  add(`<text x="${cx}" y="${PHONE.y + 98}" text-anchor="middle" font-family="${SANS}" font-size="10.5" fill="#fff" fill-opacity=".62">tuesday</text>`);
  add(`<rect x="${cx - 30}" y="${PHONE.y + PHONE.h - 17}" width="60" height="4" rx="2" fill="#fff" fill-opacity=".55"/>`);
  /* the notification */
  const bx = PHONE.x + 12;
  const by = PHONE.y + 128;
  add(`<g class="loop banner">`);
  add(`<rect x="${bx}" y="${by}" width="${PHONE.w - 24}" height="54" rx="15" fill="#fff" fill-opacity=".92"/>`);
  add(`<rect x="${bx + 9}" y="${by + 9}" width="17" height="17" rx="5" fill="${VIOLET.top}"/>`);
  add(`<rect x="${bx + 14}" y="${by + 16}" width="3.2" height="7" rx=".8" fill="${VIOLET.light}"/>`);
  add(`<text x="${bx + 32}" y="${by + 20.5}" font-family="${SANS}" font-size="9" font-weight="600" fill="#2b2940" fill-opacity=".65">boxbox</text>`);
  add(`<text x="${bx + PHONE.w - 24 - 10}" y="${by + 20.5}" text-anchor="end" font-family="${SANS}" font-size="9" fill="#2b2940" fill-opacity=".55">now</text>`);
  add(`<text x="${bx + 10}" y="${by + 38}" font-family="${SANS}" font-size="11" font-weight="650" fill="#14122b">ledger wants you</text>`);
  add(`<text x="${bx + 10}" y="${by + 50}" font-family="${SANS}" font-size="9.5" fill="#14122b" fill-opacity=".7">which greeting?</text>`);
  add(`</g>`);
  add(`</g>`);
  add(`</g>`);

  /* captions say what each column is */
  const cap = (x: number, text: string) =>
    add(`<text x="${x}" y="${H - 18}" font-family="${MONO}" font-size="10.5" letter-spacing=".02em" fill="${t.muted}">${text}</text>`);
  cap(CARD.x, "cmx2 daemons, one per machine");
  cap(WIN.x, "boxbox server, one inbox");
  cap(PHONE.x - 12, "your phone");

  add(`</svg>`);
  return out.join("\n") + "\n";
}

mkdirSync(`${ROOT}assets`, { recursive: true });
for (const [file, theme] of [["hero.svg", LIGHT], ["hero-dark.svg", DARK]] as const) {
  const svg = build(theme);
  writeFileSync(`${ROOT}assets/${file}`, svg);
  console.log(`assets/${file} ${svg.length} bytes`);
}
