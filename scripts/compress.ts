/* precompresses the built app so the server never compresses per request:
   every text file in app/dist gets a `.br` (quality 11) and a `.gz` (level 9)
   beside it, and the server picks one by accept-encoding. fonts and images
   are already compressed and are left alone. prints each file's sizes, so
   the build shows the script budget: "the whole app's first load budget is
   120 kb of script, compressed" (architecture.md). the first load is the
   scripts index.html loads (its module and modulepreloads); a chunk only a
   later action imports (the terminal's screen) is printed, not counted.
   index.html has a budget of its own, printed beside it: it carries the
   providers' marks as an inline svg sprite (composer/marks-data.ts), which
   is not script and would otherwise be where the next lane puts what the
   script budget turned away. */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST = resolve(import.meta.dir, "../app/dist");
const TEXT = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);
const SCRIPT_BUDGET = 120 * 1024;
/** the document, compressed: the shell the worker answers every navigation with, and every launch carries */
const DOCUMENT_BUDGET = 12 * 1024;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/* the scripts the first load fetches: index.html's module scripts and the modules it preloads */
const html = readFileSync(join(DIST, "index.html"), "utf8");
const firstLoad = new Set([...html.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)].map((m) => join(DIST, m[1] ?? "")));

let script = 0;
let later = 0;
let documentBr = 0;
for (const path of files(DIST).sort()) {
  if (!TEXT.has(extname(path))) continue;
  const raw = readFileSync(path);
  const br = brotliCompressSync(raw, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
  });
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(`${path}.br`, br);
  writeFileSync(`${path}.gz`, gz);
  if (extname(path) === ".js") {
    if (firstLoad.has(path)) script += br.length;
    else later += br.length;
  }
  if (path === join(DIST, "index.html")) documentBr = br.length;
  console.log(`${relative(DIST, path).padEnd(40)} ${String(raw.length).padStart(8)} raw ${String(br.length).padStart(7)} br ${String(gz.length).padStart(7)} gz`);
}
console.log(`script, brotli: ${(script / 1024).toFixed(1)} kb on first load, of the ${SCRIPT_BUDGET / 1024} kb budget; ${(later / 1024).toFixed(1)} kb more loads only when asked for`);
console.log(`document, brotli: ${(documentBr / 1024).toFixed(1)} kb for index.html, of the ${DOCUMENT_BUDGET / 1024} kb budget`);
if (script > SCRIPT_BUDGET) {
  console.error("compress: the app's script is over its budget");
  process.exit(1);
}
if (documentBr > DOCUMENT_BUDGET) {
  console.error("compress: index.html is over its budget");
  process.exit(1);
}
