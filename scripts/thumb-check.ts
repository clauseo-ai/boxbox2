/* the thumbnail pixel check (docs/protocol.md section 13, thumbnails;
   docs/verification.md, thumbnails).

     bun scripts/thumb-check.ts [--dir <scratch>] [--set <dir>] [--out <file>] [--webkit]

   a format ships thumbnails only when, for every test image, ladder width
   and device pixel ratio, at least 99.9% of the thumbnail's pixels are
   within 2/255 per channel of the browser's own downscale of the original
   in the same box. three steps:

   (a) the server's own code makes the set: `cargo test` runs the ignored
       hook in server/src/media/thumbs/tests.rs, which generates the test
       images (photo-like gradients with noise, line art, alpha, at several
       sizes and odd aspect ratios, as png, webp and jpeg), scales each to
       every ladder width below its own through the server's own path, and
       writes a manifest. chromium then encodes lossy webp from four of the
       pngs (the hook's encoder writes only lossless) and the hook runs
       again to scale those too. `--set <dir>` skips this and reads a set
       made earlier.
   (b) agent-browser's chromium renders, at dpr 2 and 3, the original as an
       <img> drawn at w/dpr by h/dpr css px beside the thumbnail at the
       same size (so it lands 1:1 on device pixels), and screenshots both.
   (c) both captures are compared pixel by pixel: the share within 2/255 on
       every channel and the largest delta, per format, width and dpr.

   with --webkit, the same pages also go through scripts/thumb-webkit.swift
   (built with swiftc): a WKWebView in an offscreen window at a forced
   device scale factor, snapshotted at device pixels. agent-browser itself
   drives only chromium. */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const ROOT = new URL("../", import.meta.url).pathname;
const SESSION = "p3thumbs";
const DPRS = [2, 3] as const;
const LADDER = [96, 192, 384, 768, 1536] as const;
/** a pixel passes when no channel is further than this from the browser's. */
const TOLERANCE = 2;
/** the share of pixels that must pass, per image, width and dpr. */
const PASS = 0.999;
/** css px between the two images of a pair and between rows. */
const GAP = 8;

type Thumb = { w: number; h: number; file: string };
type Image = { name: string; format: string; width: number; height: number; thumbs: Thumb[] };
type Manifest = { images: Image[] };

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function browser(argv: string[]): string {
  const out = spawnSync("agent-browser", ["--session", SESSION, ...argv], { encoding: "utf8", timeout: 120_000 });
  if (out.status !== 0) throw new Error(`agent-browser ${argv[0]} failed: ${out.stderr.trim() || out.stdout.trim()}`);
  return out.stdout;
}

/** runs the hook: the test images (once) and the server's thumbnails of every image in `dir`. */
function hook(dir: string): void {
  const out = spawnSync(
    "cargo",
    ["test", "-p", "boxbox", "--bin", "boxbox", "media::thumbs::tests::pixel_check_set", "--", "--ignored", "--exact"],
    { cwd: join(ROOT, "server"), encoding: "utf8", env: { ...process.env, THUMB_CHECK_DIR: dir }, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (out.status !== 0) throw new Error("the thumbnail hook failed; see the cargo output above");
}

/** a webp without its ICCP chunk (and the extended header's profile flag), so it is one the server scales. */
function withoutProfile(webp: Uint8Array): Uint8Array {
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const kept: Uint8Array[] = [];
  for (let at = 12; at + 8 <= webp.length; ) {
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size % 2);
    const chunk = webp.slice(at, end);
    const kind = String.fromCharCode(...chunk.subarray(0, 4));
    if (kind === "VP8X") chunk[8] = (chunk[8] ?? 0) & ~0x20;
    if (kind !== "ICCP") kept.push(chunk);
    at = end;
  }
  const body = Buffer.concat([Buffer.from("WEBP"), ...kept]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** lossy webp originals from chromium's own encoder (the hook's encoder writes only lossless). */
function lossy(dir: string): void {
  for (const name of ["photo", "text", "alpha", "small"]) {
    browser(["open", `file://${join(dir, `${name}.png`)}`]);
    const out = browser([
      "eval",
      "--json",
      `(async () => { const i = document.images[0]; await i.decode(); const c = document.createElement("canvas"); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext("2d").drawImage(i, 0, 0); const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.85)); const a = new Uint8Array(await b.arrayBuffer()); let s = ""; for (const x of a) s += String.fromCharCode(x); return btoa(s); })()`,
    ]);
    const parsed = JSON.parse(out) as { data?: { result?: string } };
    const encoded = parsed.data?.result;
    if (!encoded) throw new Error(`chromium did not encode ${name}.png as webp: ${out.slice(0, 200)}`);
    writeFileSync(join(dir, `${name}-lossy.webp`), withoutProfile(new Uint8Array(Buffer.from(encoded, "base64"))));
  }
}

type Raster = { width: number; height: number; data: Uint8Array };

/** an 8-bit, non-interlaced rgb or rgba png, as rgba. enough for chromium's screenshots. */
function decodePng(bytes: Uint8Array): Raster {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = bodyView.getUint32(0);
      height = bodyView.getUint32(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`png not 8-bit rgb or rgba non-interlaced (depth ${depth}, colour ${colour})`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (rows[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0;
      const corner = x >= channels && y > 0 ? (rows[(y - 1) * stride + x - channels] ?? 0) : 0;
      const value = line[x] ?? 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      rows[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = rows[i * channels + c] ?? 0;
    data[i * 4 + 3] = channels === 4 ? (rows[i * channels + 3] ?? 255) : 255;
  }
  return { width, height, data };
}

type Score = { share: number; max: number };

/** a box of `w` by `h` device px at (ax, ay) against one at (bx, by). */
function compare(shot: Raster, ax: number, bx: number, ay: number, by: number, w: number, h: number): Score {
  let within = 0;
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((ay + y) * shot.width + ax + x) * 4;
      const b = ((by + y) * shot.width + bx + x) * 4;
      let worst = 0;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((shot.data[a + c] ?? 0) - (shot.data[b + c] ?? 0)));
      if (worst <= TOLERANCE) within++;
      max = Math.max(max, worst);
    }
  }
  return { share: within / (w * h), max };
}

type Engine = "chromium" | "webkit";
type Row = { engine: Engine; format: string; image: string; w: number; dpr: number; score: Score };

/** the webkit harness, built once into the scratch dir. */
function webkitHarness(dir: string): string {
  const binary = join(dir, "thumb-webkit");
  const out = spawnSync("swiftc", ["-O", "-o", binary, join(ROOT, "scripts/thumb-webkit.swift")], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`swiftc failed: ${out.stderr.trim()}`);
  return binary;
}

/** one page per dpr and width: every image that has a thumbnail at `w`, original left, thumbnail right. */
function measure(dir: string, manifest: Manifest, dpr: number, w: number, engine: Engine, harness: string): Row[] {
  const pairs = manifest.images.flatMap((image) => {
    const thumb = image.thumbs.find((t) => t.w === w);
    return thumb ? [{ image, thumb }] : [];
  });
  if (pairs.length === 0) return [];
  const css = w / dpr;
  let y = 0;
  const placed = pairs.map(({ image, thumb }) => {
    const top = y;
    y += Math.ceil(thumb.h / dpr) + GAP;
    return { image, thumb, top };
  });
  // the box is w by h css px scaled by 1/dpr rather than w/dpr by h/dpr: layout
  // snaps a fractional css height to whole css px under chromium's emulated
  // dpr, which would hand the browser a box a row off the thumbnail's. the
  // transform lands both images on exactly w by h device px, the same matrix
  // a laid-out box of that size draws with. webkit gets the same page.
  // webkit paints a large image decoded asynchronously after decode() resolves, so it decodes these in line
  const decoding = engine === "webkit" ? ' decoding="sync"' : "";
  const box = (src: string, left: number, top: number, h: number) =>
    `<img src="${src}"${decoding} style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;transform:scale(${1 / dpr});transform-origin:0 0">`;
  const body = placed
    .map(({ image, thumb, top }) => box(image.name, 0, top, thumb.h) + box(thumb.file, css + GAP, top, thumb.h))
    .join("\n");
  // webkit's view is the page's size, so its overflow (the unscaled boxes) must not scroll
  const overflow = engine === "webkit" ? ";overflow:hidden" : "";
  const page = join(dir, `check-${engine}-${dpr}-${w}.html`);
  writeFileSync(
    page,
    `<!doctype html><html><head><style>html,body{margin:0;background:#fff${overflow}}img{display:block}</style></head>` +
      `<body style="height:${y}px">${body}</body></html>`,
  );
  const width = Math.ceil(css * 2 + GAP * 2);
  const shotPath = join(dir, `check-${engine}-${dpr}-${w}.png`);
  if (engine === "chromium") {
    browser(["set", "viewport", String(width), "600", String(dpr)]);
    browser(["open", `file://${page}`]);
    browser(["eval", "Promise.all([...document.images].map((i) => i.decode())).then(() => document.images.length)"]);
    browser(["screenshot", "--full", shotPath]);
  } else {
    const out = spawnSync(harness, [page, String(width), String(y), String(dpr), shotPath], { encoding: "utf8", timeout: 90_000 });
    if (out.status !== 0) throw new Error(`the webkit harness failed on ${page}: ${out.stdout}${out.stderr}`);
    if (!out.stdout.includes(`devicePixelRatio ${dpr}`)) throw new Error(`webkit drew ${page} at another dpr: ${out.stdout}`);
  }
  const shot = decodePng(readFileSync(shotPath));
  return placed.map(({ image, thumb, top }) => ({
    engine,
    format: image.format,
    image: image.name,
    w,
    dpr,
    score: compare(shot, 0, Math.round((css + GAP) * dpr), top * dpr, top * dpr, thumb.w, thumb.h),
  }));
}

function main(): void {
  const given = arg("--set");
  const dir = given ?? arg("--dir") ?? "/tmp/thumb-check";
  const engines: Engine[] = process.argv.includes("--webkit") ? ["chromium", "webkit"] : ["chromium"];
  const rows: Row[] = [];
  let manifest: Manifest = { images: [] };
  try {
    browser(["--args", "--force-color-profile=srgb", "open", "about:blank"]);
    if (!given) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      hook(dir);
      lossy(dir);
      hook(dir);
    }
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const harness = engines.includes("webkit") ? webkitHarness(dir) : "";
    for (const engine of engines) {
      for (const dpr of DPRS) for (const w of LADDER) rows.push(...measure(dir, manifest, dpr, w, engine, harness));
    }
  } finally {
    spawnSync("agent-browser", ["--session", SESSION, "close"]);
  }
  const lines = [
    "| engine | format | w | dpr | worst image | worst % within 2/255 | max delta | pass |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const verdict = new Map<string, boolean>();
  const formats = [...new Set(rows.map((r) => r.format))].sort();
  for (const engine of engines) {
    for (const format of formats) {
      for (const w of LADDER) {
        for (const dpr of DPRS) {
          const group = rows.filter((r) => r.engine === engine && r.format === format && r.w === w && r.dpr === dpr);
          if (group.length === 0) continue;
          const worst = group.reduce((a, b) => (b.score.share < a.score.share ? b : a));
          const max = Math.max(...group.map((r) => r.score.max));
          const pass = group.every((r) => r.score.share >= PASS);
          verdict.set(format, (verdict.get(format) ?? true) && pass);
          lines.push(
            `| ${engine} | ${format} | ${w} | ${dpr} | ${worst.image} | ${(worst.score.share * 100).toFixed(2)} | ${max} | ${pass ? "yes" : "no"} |`,
          );
        }
      }
    }
  }
  lines.push(
    "",
    ...formats.map((f) => `${f}: ${verdict.get(f) ? `passes in ${engines.join(" and ")}` : "fails, w answers the original"}`),
  );
  const report = lines.join("\n");
  console.log(report);
  const out = arg("--out");
  if (out) {
    const each = rows.map((r) => `${r.engine} ${r.image} w${r.w} dpr${r.dpr}: ${(r.score.share * 100).toFixed(3)}% max ${r.score.max}`);
    writeFileSync(out, `${report}\n\nper image:\n${each.join("\n")}\n`);
  }
}

main();
