/* the dev server sits behind the rust server on 3001 (`just dev`): the page
   and its modules are proxied through rust, and hot reload's websocket
   comes straight here, since the rust proxy speaks plain http only.

   the service worker is built after the app, alone, as one classic script
   at dist/sw.js: unhashed, because a worker's url is its identity (the
   server revalidates it on every load so a new build is found), and with
   nothing shared, because a classic worker cannot import the app's chunks.
   in dev, /sw.js is src/push/sw.ts served as a module (the app registers it
   with type "module" there).

   the worker precaches the build it ships with: once the app is written,
   every file in dist but the ones NOT_PRECACHED names becomes a path in
   `BOXBOX_PRECACHE` (index.html as "/", the shell a navigation is answered
   with), and `BOXBOX_BUILD` is a
   hash of those files' bytes. a new build is a new worker script, which is
   how the browser finds a deploy. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { build, defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { marksInHtml } from "./src/ui/composer/marks-sprite";

/** 3002 for `just dev`; a parallel lane running its own vite beside another gives it a port of its own (docs/gotchas.md,
    parallel lanes), and points its server's `[dev] vite` at it */
const VITE_PORT = Number(process.env.BOXBOX_VITE_PORT ?? 3002);
const WORKER_SOURCE = "/src/push/sw.ts";

function serviceWorkerInDev(): Plugin {
  return {
    name: "boxbox-service-worker",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/sw.js") return next();
        server
          .transformRequest(WORKER_SOURCE)
          .then((result) => {
            if (!result) return next();
            response.setHeader("content-type", "text/javascript; charset=utf-8");
            response.setHeader("cache-control", "no-cache");
            response.end(result.code);
          })
          .catch(next);
      });
    },
  };
}

const DIST = "dist";
/** the worker's own file is not its precache; the server's precompressed copies are written after this runs. nor is the
    board's chunk (app/src/board/board.tsx, named for its file): a device that never meets a board never fetches a byte of
    it, and the one that does fetches it on the first board frame (docs/board.md). nor are the icons (public/icons): the
    browser fetches them for the manifest and the home screen when boxbox is installed, never for the page, so a launch
    does not carry 167 kb of them */
const NOT_PRECACHED = /^sw\.js$|\.(br|gz)$|^assets\/board-[\w-]+\.(js|css)$|^icons\//;

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

/** every file the app build wrote, as the paths the server answers them at, and a hash of their bytes */
function precacheOf(dir: string): { paths: string[]; build: string } {
  const files = filesIn(dir)
    .map((path) => relative(dir, path).split("\\").join("/"))
    .filter((name) => !NOT_PRECACHED.test(name))
    .sort();
  const hash = createHash("sha256");
  for (const name of files) hash.update(name).update("\0").update(readFileSync(join(dir, name))).update("\0");
  const paths = files.map((name) => (name === "index.html" ? "/" : `/${name}`));
  // the shell first: a navigation's answer is the one file every launch needs
  paths.sort((a, b) => Number(b === "/") - Number(a === "/"));
  return { paths, build: hash.digest("hex").slice(0, 16) };
}

function serviceWorkerInBuild(): Plugin {
  return {
    name: "boxbox-service-worker-build",
    apply: (config, env) => env.command === "build" && !config.build?.lib,
    async closeBundle() {
      const precache = precacheOf(DIST);
      await build({
        configFile: false,
        logLevel: "warn",
        define: {
          BOXBOX_BUILD: JSON.stringify(precache.build),
          BOXBOX_PRECACHE: JSON.stringify(precache.paths),
        },
        build: {
          target: "es2022",
          outDir: DIST,
          emptyOutDir: false,
          copyPublicDir: false,
          lib: { entry: `.${WORKER_SOURCE}`, formats: ["iife"], name: "boxboxWorker", fileName: () => "sw.js" },
        },
      });
    },
  };
}

export default defineConfig({
  plugins: [solid(), marksInHtml(), serviceWorkerInDev(), serviceWorkerInBuild()],
  server: {
    host: "127.0.0.1",
    port: VITE_PORT,
    strictPort: true,
    hmr: { host: "127.0.0.1", port: VITE_PORT, clientPort: VITE_PORT },
  },
  build: {
    target: "es2022",
    outDir: DIST,
    assetsDir: "assets",
    emptyOutDir: true,
    sourcemap: false,
    /* everything the entry imports statically is one chunk: left alone, rolldown hoists a module the first load shares
       with a lazy chunk into a preloaded chunk of its own, and the first load compressed as several files is kilobytes
       larger than as one (gotchas.md, a lazy chunk that shares a module) */
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: "index", tags: ["$initial"] }] } } },
  },
});
