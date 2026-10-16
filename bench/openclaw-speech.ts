/* the speech stub: the openai `/v1/audio/speech` route the scripted model
   (the pinned tree's scripts/e2e/mock-openai-server.mjs) does not serve, so
   the gateway's openai-compatible tts provider has real bytes to deliver
   for voice replies (docs/openclaw.md, 11.5).

   at start it renders one short clip with ffmpeg (a 1.2 s tone) in each
   format it may be asked for, then answers every request with the clip in
   the requested `response_format` (opus is ogg/opus; mp3 when unset, as the
   openai api defaults). each request is logged on one line.

   run: bun bench/openclaw-speech.ts --port 4742 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}

const port = Number(arg("--port", "4742"));
const dir = arg("--dir", `/tmp/boxbox-openclaw-speech-${port}`);
mkdirSync(dir, { recursive: true });

const FORMATS: Record<string, { ext: string; type: string; codec: string[] }> = {
  opus: { ext: "ogg", type: "audio/ogg", codec: ["-c:a", "libopus", "-b:a", "32k"] },
  mp3: { ext: "mp3", type: "audio/mpeg", codec: ["-c:a", "libmp3lame", "-b:a", "64k"] },
  wav: { ext: "wav", type: "audio/wav", codec: ["-c:a", "pcm_s16le"] },
  aac: { ext: "m4a", type: "audio/mp4", codec: ["-c:a", "aac", "-b:a", "64k"] },
};

const clips = new Map<string, Blob>();
for (const [format, spec] of Object.entries(FORMATS)) {
  const file = join(dir, `clip.${spec.ext}`);
  const out = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-ar", "48000", "-ac", "1", ...spec.codec, file],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (out.status !== 0) {
    console.error(`speech stub: ffmpeg could not render the ${format} clip`);
    process.exit(1);
  }
  clips.set(format, new Blob([readFileSync(file)], { type: spec.type }));
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || !path.endsWith("/audio/speech")) {
      return new Response("the speech stub answers POST /v1/audio/speech\n", { status: 404 });
    }
    let body: { response_format?: unknown; input?: unknown; model?: unknown; voice?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: { message: "the body is not json" } }, { status: 400 });
    }
    const format = typeof body.response_format === "string" && clips.has(body.response_format) ? body.response_format : "mp3";
    const clip = clips.get(format) ?? new Blob([]);
    const chars = typeof body.input === "string" ? body.input.length : 0;
    console.log(`speech stub: ${path} model=${String(body.model)} voice=${String(body.voice)} ${chars} chars -> ${format} ${clip.size} bytes`);
    return new Response(clip, { headers: { "content-type": FORMATS[format]?.type ?? "application/octet-stream" } });
  },
});
console.log(`speech stub listening on http://127.0.0.1:${server.port}`);
