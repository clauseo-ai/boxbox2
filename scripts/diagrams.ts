/* writes the README and docs diagrams to assets/, one light and one dark file each.

     bun scripts/diagrams.ts          (from the repo root)

   these are drawn by hand in coordinates, not laid out by a tool, so each one reads the
   way it was meant to and renders the same on every viewer. the generator is the text
   source: change a box or an edge here and regenerate, never edit the svg. colours are
   the app's repo palette (app/src/ui/window/repo.ts), the same one the hero uses:
   blue is a device, violet is boxbox, teal is a cmx2 daemon, gold is something that
   wants a person. each file carries its own opaque ground, so it reads on a light page
   and a dark one whichever variant the browser picks.

   assets/architecture   the whole system in one picture (README, docs/architecture.md)
   assets/pieces         what is inside the browser and the server (docs/README.md)
   assets/needs-you      one question from an agent to a lock screen and back (README, docs/README.md)
   assets/cursor         a cursor at every hop (docs/architecture.md) */

import { mkdirSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;

type Pair = { top: string; bottom: string; light: string };
const TONES = {
  violet: { top: "#34298a", bottom: "#171240", light: "#b7abff" },
  blue: { top: "#173a5e", bottom: "#0a1a2e", light: "#9cc8ff" },
  teal: { top: "#10484a", bottom: "#062123", light: "#7fe0d6" },
  green: { top: "#1b4a33", bottom: "#0c2419", light: "#8fe6a5" },
  rose: { top: "#5a1f45", bottom: "#2a0d20", light: "#ff9fd0" },
  clay: { top: "#5a2c19", bottom: "#29130a", light: "#ffb48c" },
  slate: { top: "#2b3441", bottom: "#12161c", light: "#b9c6d8" },
} satisfies Record<string, Pair>;
type Tone = keyof typeof TONES;

const NEED = { dark: "#f3d474", light: "#d9a921" };

function mix(a: string, b: string, t: number): string {
  const n = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = (i: number) => Math.round(n(a, i) * (1 - t) + n(b, i) * t).toString(16).padStart(2, "0");
  return `#${c(0)}${c(1)}${c(2)}`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const num = (n: number) => Number(n.toFixed(1));

type Theme = { dark: boolean; ink: string; muted: string; ground: [string, string]; edge: string; line: string; lineSoft: string; need: string; needText: string };
const DARK: Theme = { dark: true, ink: "#f4f4f6", muted: "#a9a6c4", ground: ["#14112e", "#0b0a1a"], edge: "#b7abff", line: "#8f86c9", lineSoft: "#b7abff", need: NEED.dark, needText: NEED.dark };
const LIGHT: Theme = { dark: false, ink: "#171240", muted: "#6c6794", ground: ["#f8f6ff", "#ebe8fb"], edge: "#34298a", line: "#5b52a8", lineSoft: "#34298a", need: NEED.light, needText: "#8a6400" };

type Pt = [number, number];

class Canvas {
  private body: string[] = [];
  private defs = new Set<string>();
  private ids = 0;
  constructor(
    readonly t: Theme,
    readonly w: number,
    readonly h: number,
    private title: string,
    private desc: string,
  ) {}

  add(s: string) {
    this.body.push(s);
  }

  /** a repo-coloured surface, the way the app paints a window: the deep pair on dark, the light tone washed into white on light */
  private fill(tone: Tone, strength = 1): string {
    const id = `f-${tone}-${strength}`;
    const r = TONES[tone];
    const [a, b] = this.t.dark
      ? [mix(r.top, "#0d0b1f", 1 - strength), mix(r.bottom, "#0d0b1f", 1 - strength)]
      : [mix("#ffffff", r.light, 0.34 * strength), mix("#ffffff", r.light, 0.14 * strength)];
    this.defs.add(`<linearGradient id="${id}" x1=".4" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`);
    return `url(#${id})`;
  }
  private ink(tone: Tone) {
    return this.t.dark ? this.t.ink : TONES[tone].top;
  }
  private sub(tone: Tone) {
    return this.t.dark ? TONES[tone].light : mix(TONES[tone].top, "#ffffff", 0.18);
  }
  private marker(colour: string): string {
    const id = `m-${colour.slice(1)}`;
    this.defs.add(`<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1.5L8.5 5L1 8.5" fill="none" stroke="${colour}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker>`);
    return `url(#${id})`;
  }

  /** a labelled region that holds nodes */
  group(x: number, y: number, w: number, h: number, caption: string, tone: Tone, opts: { captionRight?: string } = {}) {
    const r = TONES[tone];
    const fill = this.t.dark ? mix("#0d0b1f", r.top, 0.28) : mix("#ffffff", r.light, 0.16);
    const stroke = this.t.dark ? r.light : r.top;
    this.add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${fill}" fill-opacity="${this.t.dark ? 0.55 : 0.7}" stroke="${stroke}" stroke-opacity="${this.t.dark ? 0.26 : 0.2}"/>`);
    this.add(`<text x="${x + 18}" y="${y + 25}" font-family="${MONO}" font-size="11" letter-spacing=".02em" fill="${this.t.dark ? r.light : r.top}" fill-opacity=".9">${esc(caption)}</text>`);
    if (opts.captionRight) this.add(`<text x="${x + w - 18}" y="${y + 25}" text-anchor="end" font-family="${MONO}" font-size="10.5" fill="${this.t.muted}">${esc(opts.captionRight)}</text>`);
  }

  /** a box with a title and an optional mono line under it */
  node(x: number, y: number, w: number, h: number, title: string, tone: Tone, opts: { sub?: string; dashed?: boolean; small?: boolean } = {}) {
    const r = TONES[tone];
    const dashed = opts.dashed ? ` stroke-dasharray="4 4"` : "";
    if (this.t.dark) {
      this.add(`<rect x="${x}" y="${y + 3}" width="${w}" height="${h}" rx="13" fill="#000" fill-opacity=".3"/>`);
      this.add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="13" fill="${this.fill(tone, opts.dashed ? 0.6 : 1)}"/>`);
      this.add(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12.5" fill="none" stroke="#fff" stroke-opacity="${opts.dashed ? 0.2 : 0.12}"${dashed}/>`);
    } else {
      this.add(`<rect x="${x}" y="${y + 2}" width="${w}" height="${h}" rx="13" fill="${r.top}" fill-opacity=".08"/>`);
      this.add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="13" fill="${this.fill(tone, opts.dashed ? 0.6 : 1)}"/>`);
      this.add(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12.5" fill="none" stroke="${r.top}" stroke-opacity="${opts.dashed ? 0.34 : 0.18}"${dashed}/>`);
    }
    const ts = opts.small ? 12 : 13;
    const cx = x + w / 2;
    const titles = title.split("\n");
    const subs = opts.sub ? opts.sub.split("\n") : [];
    const block = titles.length * 16 + (subs.length ? 4 + subs.length * 13 : 0);
    const top = y + (h - block) / 2;
    titles.forEach((line, i) => this.add(`<text x="${cx}" y="${num(top + 12 + i * 16)}" text-anchor="middle" font-family="${SANS}" font-size="${ts}" font-weight="650" fill="${this.ink(tone)}">${esc(line)}</text>`));
    subs.forEach((line, i) => this.add(`<text x="${cx}" y="${num(top + titles.length * 16 + 4 + 10 + i * 13)}" text-anchor="middle" font-family="${MONO}" font-size="10" fill="${this.sub(tone)}" fill-opacity=".92">${esc(line)}</text>`));
  }

  /** a line through the points with rounded corners, an arrowhead at the end (and at the start when `both`) */
  edge(points: Pt[], opts: { need?: boolean; dashed?: boolean; both?: boolean; soft?: boolean } = {}) {
    const colour = opts.need ? this.t.need : opts.soft ? this.t.lineSoft : this.t.line;
    const R = 9;
    let d = `M${points[0]![0]} ${points[0]![1]}`;
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i - 1]!;
      const [cx, cy] = points[i]!;
      const next = points[i + 1];
      if (!next) {
        d += `L${cx} ${cy}`;
        break;
      }
      const len1 = Math.hypot(cx - px, cy - py);
      const len2 = Math.hypot(next[0] - cx, next[1] - cy);
      const r = Math.min(R, len1 / 2, len2 / 2);
      const ax = cx - ((cx - px) / len1) * r;
      const ay = cy - ((cy - py) / len1) * r;
      const bx = cx + ((next[0] - cx) / len2) * r;
      const by = cy + ((next[1] - cy) / len2) * r;
      d += `L${num(ax)} ${num(ay)}Q${cx} ${cy} ${num(bx)} ${num(by)}`;
    }
    const m = this.marker(colour);
    const dash = opts.dashed ? ` stroke-dasharray="5 5"` : "";
    this.add(`<path d="${d}" fill="none" stroke="${colour}" stroke-width="${opts.need ? 1.8 : 1.5}" stroke-opacity="${opts.soft ? 0.55 : 0.9}" stroke-linecap="round"${dash} marker-end="${m}"${opts.both ? ` marker-start="${m}"` : ""}/>`);
  }

  /** a label that sits on a line, with the ground knocked out behind it */
  label(x: number, y: number, text: string, opts: { need?: boolean; anchor?: "middle" | "start" | "end"; knock?: boolean } = {}) {
    const anchor = opts.anchor ?? "middle";
    const w = text.length * 6.05 + 12;
    const x0 = anchor === "middle" ? x - w / 2 : anchor === "start" ? x - 6 : x - w + 6;
    if (opts.knock !== false) {
      const g = this.t.dark ? "#100e24" : "#f4f2fd";
      this.add(`<rect x="${num(x0)}" y="${num(y - 11.5)}" width="${num(w)}" height="17" rx="8.5" fill="${g}"/>`);
    }
    this.add(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${MONO}" font-size="10.5" fill="${opts.need ? this.t.needText : this.t.muted}">${esc(text)}</text>`);
  }

  text(x: number, y: number, text: string, opts: { size?: number; weight?: number; mono?: boolean; muted?: boolean; anchor?: "middle" | "start" | "end"; need?: boolean } = {}) {
    const fill = opts.need ? this.t.needText : opts.muted ? this.t.muted : this.t.ink;
    this.add(`<text x="${x}" y="${y}" text-anchor="${opts.anchor ?? "start"}" font-family="${opts.mono ? MONO : SANS}" font-size="${opts.size ?? 12}" font-weight="${opts.weight ?? 400}" fill="${fill}">${esc(text)}</text>`);
  }

  render(): string {
    const { t, w, h } = this;
    const head = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">`,
      `<title id="t">${esc(this.title)}</title>`,
      `<desc id="d">${esc(this.desc)}</desc>`,
      `<defs><linearGradient id="g" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="${t.ground[0]}"/><stop offset="1" stop-color="${t.ground[1]}"/></linearGradient>${[...this.defs].join("")}</defs>`,
      `<rect width="${w}" height="${h}" rx="22" fill="url(#g)"/>`,
      `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="21.5" fill="none" stroke="${t.edge}" stroke-opacity="${t.dark ? 0.16 : 0.14}"/>`,
    ];
    return [...head, ...this.body, `</svg>`].join("\n") + "\n";
  }
}

/* ------------------------------------------------------------------ architecture */

function architecture(t: Theme): Canvas {
  const c = new Canvas(
    t,
    900,
    414,
    "how boxbox fits together",
    "your app and board talk over https to the boxbox server, which holds a password gate, a fleet model, push and a terminal relay. the server keeps one event stream open to the cmx2 daemon on each of your machines and sends web push notifications back to the app.",
  );
  const top = 24;
  const rowH = 76;
  const gap = 18;
  const r = [top + 46, top + 46 + rowH + gap, top + 46 + 2 * (rowH + gap)];
  const bottom = r[2]! + rowH + 20;

  c.group(24, top, 200, bottom - top, "your devices", "blue");
  c.group(300, top, 330, bottom - top, "boxbox server: rust, serves the solid app", "violet");
  c.group(706, top, 170, bottom - top, "your machines", "teal");

  c.node(40, r[0]!, 168, rowH, "17-key board", "blue", { sub: "optional, a bun daemon\nover usb", dashed: true });
  c.node(40, r[1]!, 168, rowH, "web app", "blue", { sub: "phone, tablet, laptop,\ninstalled as an app" });

  // the gate is the front door, so it is tall and everything else sits behind it
  c.node(316, r[0]!, 96, 3 * rowH + 2 * gap, "gate", "violet", { sub: "password,\nsigned\ncookie" });
  c.node(444, r[0]!, 170, rowH, "terminal relay", "violet", { sub: "browser to daemon\nwebsocket pumps" });
  c.node(444, r[1]!, 170, rowH, "fleet model", "violet", { sub: "threads, who needs you,\nwhat you have read" });
  c.node(444, r[2]!, 170, rowH, "push", "violet", { sub: "decides who gets a\nnotification" });

  for (let i = 0; i < 3; i++) c.node(722, r[0]! + i * (rowH + gap) + 4, 138, rowH - 8, ["desk", "vm", "laptop"][i]!, "teal", { sub: "cmx2 daemon", small: true });

  // devices to the gate
  c.edge([[208, r[0]! + rowH / 2], [316, r[0]! + rowH / 2]]);
  c.label(262, r[0]! + rowH / 2 - 12, "http");
  c.edge([[208, r[1]! + rowH / 2 - 8], [316, r[1]! + rowH / 2 - 8]]);
  c.label(262, r[1]! + rowH / 2 - 22, "https");
  // gate to what is behind it
  c.edge([[412, r[0]! + rowH / 2], [444, r[0]! + rowH / 2]]);
  c.edge([[412, r[1]! + rowH / 2], [444, r[1]! + rowH / 2]]);
  c.edge([[529, r[1]! + rowH], [529, r[2]!]]);
  // the server to its daemons
  c.edge([[614, r[0]! + rowH / 2], [706, r[0]! + rowH / 2]], { both: true });
  c.label(660, r[0]! + rowH / 2 - 12, "websocket");
  c.edge([[614, r[1]! + rowH / 2], [706, r[1]! + rowH / 2]], { both: true });
  c.label(660, r[1]! + rowH / 2 - 12, "sse + rest");
  // web push comes back around the bottom to the app
  const lane = bottom + 22;
  c.edge([[529, r[2]! + rowH], [529, lane], [124, lane], [124, r[1]! + rowH]], { need: true, dashed: true });
  c.label(326, lane + 4, "web push", { need: true });
  return c;
}

/* ------------------------------------------------------------------ pieces */

function pieces(t: Theme): Canvas {
  const c = new Canvas(
    t,
    960,
    400,
    "what is inside the browser and the server",
    "the browser has a ui thread, a sync worker and a service worker. the boxbox server has an http layer, a fleet actor, a journal, upstream watchers, a push task, a pty relay, a store writer and telemetry. the watchers and the relay talk to cmx2 daemons, and the push task reaches the service worker with web push.",
  );
  const top = 24;
  const nh = 64;
  const nw = 124;
  const rows = [90, 178, 266];
  const mid = (i: number) => rows[i]! + nh / 2;
  const cols = [280, 440, 600];
  const cmid = (i: number) => cols[i]! + nw / 2;
  const bottom = rows[2]! + nh + 20;

  c.group(24, top, 184, bottom - top, "browser, installed app", "blue");
  c.group(264, top, 476, bottom - top, "boxbox server", "violet");
  c.group(824, top, 112, bottom - top, "machines", "teal");

  c.node(40, rows[0]!, 152, nh, "ui thread", "blue", { sub: "solid components" });
  c.node(40, rows[1]!, 152, nh, "sync worker", "blue", { sub: "stream, cursor, cache" });
  c.node(40, rows[2]!, 152, nh, "service worker", "blue", { sub: "push, app shell" });

  c.node(cols[0]!, rows[1]!, nw, nh, "http layer", "violet", { sub: "gate, api,\nembedded app" });
  c.node(cols[0]!, rows[2]!, nw, nh, "telemetry", "violet", { sub: ".jsonl files", dashed: true });
  c.node(cols[1]!, rows[0]!, nw, nh, "journal", "violet", { sub: "ring of events" });
  c.node(cols[1]!, rows[1]!, nw, nh, "fleet actor", "violet", { sub: "one model of\nevery host" });
  c.node(cols[1]!, rows[2]!, nw, nh, "push task", "violet", { sub: "who gets a notice" });
  c.node(cols[2]!, rows[0]!, nw, nh, "pty relay", "violet", { sub: "terminal pumps" });
  c.node(cols[2]!, rows[1]!, nw, nh, "upstream\nwatchers", "violet", { sub: "one per host" });
  c.node(cols[2]!, rows[2]!, nw, nh, "store writer", "violet", { sub: "boxbox.db" });

  ["desk", "vm", "laptop"].forEach((n, i) => c.node(840, rows[i]! + 4, 80, nh - 8, n, "teal", { sub: "cmx2", small: true }));

  // browser: the ui thread and the worker, and the worker and the server
  c.edge([[116, rows[0]! + nh], [116, rows[1]!]], { both: true });
  c.label(124, rows[0]! + nh + 16, "patches each frame", { anchor: "start" });
  c.edge([[cols[0]!, mid(1) - 10], [192, mid(1) - 10]]);
  c.label(236, mid(1) - 20, "stream");
  c.edge([[192, mid(1) + 12], [cols[0]!, mid(1) + 12]]);
  c.label(236, mid(1) + 32, "posts");

  // inside the server
  c.edge([[cols[0]! + nw, mid(1) + 12], [cols[1]!, mid(1) + 12]]);
  c.edge([[cols[1]!, mid(0)], [cols[0]! + nw + 18, mid(0)], [cols[0]! + nw + 18, mid(1) - 12], [cols[0]! + nw, mid(1) - 12]]);
  c.edge([[cmid(1), rows[1]!], [cmid(1), rows[0]! + nh]]);
  c.edge([[cols[2]!, mid(1)], [cols[1]! + nw, mid(1)]]);
  c.edge([[cmid(1), rows[1]! + nh], [cmid(1), rows[2]!]]);
  c.edge([[cols[1]! + nw, mid(2)], [cols[2]!, mid(2)]]);
  c.edge([[cmid(0), rows[1]! + nh], [cmid(0), rows[2]!]], { dashed: true, soft: true });
  c.label(cmid(0) + 12, rows[1]! + nh + 16, "usage", { anchor: "start", knock: false });
  const lane = top + 46;
  c.edge([[cmid(0), rows[1]!], [cmid(0), lane], [cmid(2), lane], [cmid(2), rows[0]!]]);
  c.label((cmid(0) + cmid(2)) / 2, lane + 4, "terminal");

  // out to the daemons
  c.edge([[cols[2]! + nw, mid(0)], [824, mid(0)]], { both: true });
  c.label(782, mid(0) - 12, "websocket");
  c.edge([[cols[2]! + nw, mid(1)], [824, mid(1)]], { both: true });
  c.label(782, mid(1) - 12, "sse + rest");

  // web push comes back around the bottom to the service worker
  const back = bottom + 22;
  c.edge([[cmid(1), rows[2]! + nh], [cmid(1), back], [116, back], [116, rows[2]! + nh]], { need: true, dashed: true });
  c.label((cmid(1) + 116) / 2, back + 4, "web push", { need: true });
  return c;
}

/* ------------------------------------------------------------------ needs you */

function needsYou(t: Theme): Canvas {
  const c = new Canvas(
    t,
    900,
    606,
    "one question, from an agent to a lock screen and back",
    "an agent asks a question. the cmx2 daemon emits an event, boxbox raises a need and, because no screen is watching, sends a web push through the platform push service. the phone shows a banner. tapping it opens the app, which resumes its stream from its cursor and shows the question. the answer goes back through boxbox to the daemon, and the agent carries on.",
  );
  const xs = { agent: 118, server: 352, push: 590, phone: 790 };
  const headTop = 22;
  const headH = 52;
  const end = 584;
  const head = (x: number, title: string, sub: string, tone: Tone) => c.node(x - 80, headTop, 160, headH, title, tone, { sub, small: true });
  head(xs.agent, "cmx2 daemon", "runs the agent", "teal");
  head(xs.server, "boxbox server", "fleet, journal, push", "violet");
  head(xs.push, "push service", "apple, google, mozilla", "slate");
  head(xs.phone, "your phone", "lock screen, app", "blue");

  const line = (x: number) => c.add(`<line x1="${x}" y1="${headTop + headH + 4}" x2="${x}" y2="${end}" stroke="${t.line}" stroke-opacity=".35" stroke-width="1.2" stroke-dasharray="3 6"/>`);
  Object.values(xs).forEach(line);

  const badge = (x: number, y: number, n: number, need = false) => {
    c.add(`<circle cx="${x}" cy="${y}" r="9" fill="${need ? t.need : t.dark ? "#b7abff" : "#34298a"}"/>`);
    c.add(`<text x="${x}" y="${y + 3.8}" text-anchor="middle" font-family="${SANS}" font-size="10.5" font-weight="700" fill="${need ? (t.dark ? "#211a07" : "#2a2008") : t.dark ? "#171240" : "#ffffff"}">${n}</text>`);
  };
  const msg = (n: number, y: number, from: number, to: number, text: string, o: { need?: boolean; dashed?: boolean } = {}) => {
    const dir = Math.sign(to - from);
    c.edge([[from + dir * 6, y], [to - dir * 6, y]], { need: o.need ?? false, dashed: o.dashed ?? false });
    const left = Math.min(from, to);
    badge(left + 22, y - 17, n, o.need);
    c.text(left + 38, y - 12.5, text, { size: 12.5, weight: 500, need: o.need ?? false });
  };
  const note = (x: number, y: number, w: number, lines: string[], need = false) => {
    const h = 14 + lines.length * 15;
    const fill = t.dark ? mix("#0d0b1f", need ? "#f3d474" : "#b7abff", 0.1) : mix("#ffffff", need ? "#f0c94f" : "#b7abff", 0.22);
    const stroke = need ? t.need : t.dark ? "#b7abff" : "#34298a";
    c.add(`<rect x="${x - w / 2}" y="${y}" width="${w}" height="${h}" rx="11" fill="${t.dark ? "#100e24" : "#f4f2fd"}"/>`);
    c.add(`<rect x="${x - w / 2}" y="${y}" width="${w}" height="${h}" rx="11" fill="${fill}" stroke="${stroke}" stroke-opacity=".5"/>`);
    lines.forEach((l, i) => c.text(x, y + 19 + i * 15, l, { size: 11.5, anchor: "middle", muted: false }));
  };

  msg(1, 120, xs.agent, xs.server, "an ask event, with its seq");
  note(xs.server, 142, 230, ["the fleet raises a need and", "the journal records it"]);
  note(xs.server, 196, 230, ["push decides: no screen", "is watching, so send"], true);
  msg(2, 284, xs.server, xs.push, "web push, encrypted", { need: true });
  msg(3, 324, xs.push, xs.phone, "banner on the lock screen", { need: true });
  note(xs.phone, 342, 156, ["you tap it"]);
  msg(4, 412, xs.phone, xs.server, "open the app, resume from the cursor");
  msg(5, 452, xs.server, xs.phone, "replay the gap, ask card in front", { dashed: true });
  msg(6, 492, xs.phone, xs.server, "answer, tagged with a clientID");
  msg(7, 532, xs.server, xs.agent, "answer, to its daemon");
  msg(8, 572, xs.agent, xs.server, "the turn goes on");
  return c;
}

/* ------------------------------------------------------------------ cursor */

function cursor(t: Theme): Canvas {
  const c = new Canvas(
    t,
    900,
    236,
    "a cursor at every hop",
    "events flow from the cmx2 daemon to the boxbox watcher, the journal, the sync worker and the ui. each hop keeps a cursor: the daemon's seq, a host and seq the watcher dedupes by, the journal's epoch and seq, and the worker's cursor in indexeddb. the watcher and the worker each resume from their cursor with Last-Event-ID.",
  );
  const w = 140;
  const gap = 30;
  const x0 = (900 - (5 * w + 4 * gap)) / 2;
  const y = 40;
  const h = 74;
  const nodes: Array<[string, string, Tone, string]> = [
    ["cmx2 daemon", "numbers events", "teal", "seq"],
    ["upstream watcher", "drops repeats", "violet", "(host, seq)"],
    ["journal", "one shared ring", "violet", "(epoch, seq)"],
    ["sync worker", "applies in order", "blue", "cursor"],
    ["ui thread", "patches per frame", "blue", "no cursor"],
  ];
  nodes.forEach(([title, sub, tone, cur], i) => {
    const x = x0 + i * (w + gap);
    c.node(x, y, w, h, title, tone, { sub });
    c.add(`<rect x="${x + 14}" y="${y + h + 16}" width="${w - 28}" height="24" rx="12" fill="none" stroke="${t.line}" stroke-opacity=".55" stroke-dasharray="${i === 4 ? "3 4" : "0"}"/>`);
    c.text(x + w / 2, y + h + 32, cur, { mono: true, size: 11, anchor: "middle", muted: i === 4 });
    if (i < 4) c.edge([[x + w, y + h / 2], [x + w + gap, y + h / 2]]);
  });
  // the two hops that can drop resume from their own cursor, which is why none of them guess
  const resume = (from: number, to: number, label: string) => {
    const xa = x0 + from * (w + gap) + w / 2;
    const xb = x0 + to * (w + gap) + w / 2;
    const yy = y + h + 78;
    c.edge([[xa, y + h + 44], [xa, yy], [xb, yy], [xb, y + h + 44]], { dashed: true });
    c.label((xa + xb) / 2, yy + 4, label);
  };
  resume(1, 0, "Last-Event-ID");
  resume(3, 2, "Last-Event-ID");
  c.text(450, 24, "events go right. a hop that falls behind asks the one before it to go back to its own cursor.", { size: 11.5, muted: true, anchor: "middle" });
  return c;
}

const DIAGRAMS: Record<string, (t: Theme) => Canvas> = { architecture, pieces, "needs-you": needsYou, cursor };

mkdirSync(`${ROOT}assets`, { recursive: true });
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  for (const [suffix, theme] of [["", LIGHT], ["-dark", DARK]] as const) {
    const svg = draw(theme).render();
    writeFileSync(`${ROOT}assets/${name}${suffix}.svg`, svg);
    console.log(`assets/${name}${suffix}.svg ${svg.length} bytes`);
  }
}
